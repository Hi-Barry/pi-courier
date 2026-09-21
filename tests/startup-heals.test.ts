import { MatrixError } from "matrix-bot-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MatrixClientPort } from "../src/transports/matrix-client.js";
import { MatrixRoomOps } from "../src/transports/matrix-rooms.js";
import { logger } from "../src/logger.js";
import { fakeMatrixClient, type FakeMatrixClient, type FakeCall } from "./matrix-fakes.js";
import { captureConsole } from "./helpers.js";

/**
 * 启动自愈编排测试(spec #99 #105):组合根的整段 heal 序列收进
 * space.ts 的 runStartupHeals(票 7 将把它搬进启动状态模块),经假端口
 * 客户端 + 真 MatrixRoomOps 钉住:
 * - 三段 heal 的固定顺序(信任补权 → 房间身份 → bot 头像);
 * - 预期 404 在适配器边界自动安静——编排层不再需要任何抑制窗口;
 * - 真错误(M_FORBIDDEN 等)照常可见、单套失败不影响另一套记账。
 */
describe("runStartupHeals 编排", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-startup-heals-"));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importModules() {
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("os")>("node:os");
      return { ...actual, homedir: () => tmpDir };
    });
    const config = await import("../src/config");
    const space = await import("../src/space");
    const loggerModule = await import("../src/logger");
    return { config, space, loggerModule };
  }

  function makeOps(client: FakeMatrixClient) {
    return new MatrixRoomOps({
      getClient: () => client as unknown as MatrixClientPort,
      getBotUserId: () => "@bot:server",
      onLeftRoom: () => {},
    });
  }

  function baseConfig() {
    return {
      multiProject: true,
      space: { enabled: true, roomId: "!space:server" },
      matrix: { homeserverUrl: "https://matrix.example", accessToken: "tok" },
      auth: {
        trustedUsers: ["matrix:@barry:server"],
        adminUserId: "matrix:@barry:server",
      },
      instanceName: "box1",
      workdir: "/home/you/Projects",
      managementRooms: ["!mgmt:server"],
      projects: { "!proj:server": { workdir: "/w/p" } },
    };
  }

  const notFound = () => new MatrixError({ errcode: "M_NOT_FOUND", error: "Event not found." }, 404);
  const forbidden = () => new MatrixError({ errcode: "M_FORBIDDEN", error: "You don't have permission." }, 403);
  const sdkErrorLine = (body: string) => logger.error("[matrix-sdk:MatrixHttpClient]", `(REQ-1) ${body}`);

  /** calls 里某方法首次出现的下标;带谓词时取首个满足谓词的调用。 */
  function indexOfCall(calls: FakeCall[], method: string, predicate?: (args: unknown[]) => boolean): number {
    return calls.findIndex((c) => c.method === method && (!predicate || predicate(c.args)));
  }

  it("三段 heal 固定顺序:信任补权 → 房间身份 → bot 头像", async () => {
    const { config, space } = await importModules();
    const store = new config.ConfigStore(baseConfig());
    const client = fakeMatrixClient();
    await space.runStartupHeals(makeOps(client), store);

    const calls = client.calls;
    const powerRead = indexOfCall(calls, "getRoomStateEvent", (a) => a[1] === "m.room.power_levels");
    const nameRead = indexOfCall(calls, "getRoomStateEvent", (a) => a[1] === "m.room.name");
    const lastAvatarRead = calls.reduce(
      (acc, c, i) => (c.method === "getRoomStateEvent" && c.args[1] === "m.room.avatar" ? i : acc),
      -1,
    );
    const profileRead = indexOfCall(calls, "getUserProfile");

    // 信任补权读 power_levels 在前;身份 heal 的 m.room.name 读居中;
    // bot 头像的 profile 读在全部房间头像写之后(最后一段)。
    expect(powerRead).toBeGreaterThanOrEqual(0);
    expect(nameRead).toBeGreaterThan(powerRead);
    expect(lastAvatarRead).toBeGreaterThan(nameRead);
    expect(profileRead).toBeGreaterThan(lastAvatarRead);
    // 三段都真的跑过
    expect(calls.some((c) => c.method === "setUserPowerLevel")).toBe(true);
    expect(calls.some((c) => c.method === "setAvatarUrl")).toBe(true);
  });

  it("预期 404 全程安静:profile 404 → null 照常换装记账,无 M_NOT_FOUND 落线", async () => {
    const lines = captureConsole();
    const { config, space } = await importModules();
    const store = new config.ConfigStore(baseConfig());
    const client = fakeMatrixClient({
      getUserProfile: vi.fn(async () => {
        sdkErrorLine('{"errcode":"M_NOT_FOUND","error":"Profile not found."}');
        throw notFound();
      }),
    });

    await space.runStartupHeals(makeOps(client), store);

    // 404 是查询答案:getProfileAvatarUrl → null → bot 无脸 → 照常设置并记账
    expect(client.setAvatarUrl).toHaveBeenCalledWith("mxc://server/uploaded");
    expect(store.get().agentAvatarVersion).toBe(1);
    // 空间/房间两套不受影响,正常记账
    expect(store.get().spaceAvatarVersion).toBe(1);
    expect(store.get().roomAvatarVersion).toBe(1);
    // SDK 形状的 404 ERROR 行一次都没有落线——编排层没开任何窗口
    expect(lines.join("\n")).not.toContain("M_NOT_FOUND");
  });

  it("真错误照常可见:M_FORBIDDEN 不被静音,agent 套照常记账", async () => {
    const lines = captureConsole();
    const { config, space, loggerModule } = await importModules();
    const warnSpy = vi.spyOn(loggerModule.logger, "warn");
    const store = new config.ConfigStore(baseConfig());
    const client = fakeMatrixClient({
      getRoomStateEvent: vi.fn(async () => {
        sdkErrorLine('{"errcode":"M_FORBIDDEN","error":"You don' + "'t have permission." + '"}');
        throw forbidden();
      }),
    });

    await space.runStartupHeals(makeOps(client), store);

    // SDK 的 ERROR 行没有被任何窗口吞掉
    expect(lines.join("\n")).toContain("M_FORBIDDEN");
    // 补权与身份两段按逐房间/逐目标降级:warn 带 roomId,不抛出
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("!mgmt:server"));
    // agent 套的读与写走别的端口方法——不受影响,照常记账
    expect(store.get().agentAvatarVersion).toBe(1);
  });
});
