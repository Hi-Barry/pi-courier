import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { createStartupState, runStartupHeals } from "../src/startup-state.js";
import type { RoomOps } from "../src/transports/interface.js";
import type { MsgBridgeConfig } from "../src/types.js";

/**
 * 启动状态模块直测(spec #99 票7 / issue #106):组合根的三块启动期状态
 * (配对码去向、收养许可、自愈编排)收进可注入模块后钉住:
 * - pairing sink 槽:构造即可收、接线前不丢(晚绑定修复的核心断言);
 * - 收养许可:空间模式初始不放行,降级翻转(allowAdoption)后放行;
 * - heal 编排委派:三段固定顺序 补权 → 房间身份 → bot 头像(经假 RoomOps)。
 * 深层行为(404 静默、逐套记账等)由 tests/startup-heals.test.ts 钉住。
 */

const sinkCalls = (sink: ReturnType<typeof vi.fn>) => sink.mock.calls as unknown as Array<[string, string, string]>;

describe("createStartupState — 配对码去向(pairing sink)", () => {
  const mgmtConfig = { managementRooms: ["!mgmt:server"] } as MsgBridgeConfig;

  it("构造即可收:接线前到达的配对码被缓冲,接线后按序补发(晚绑定修复核心断言)", async () => {
    const startup = createStartupState({ store: new ConfigStore(mgmtConfig) });
    const sink = vi.fn(async () => {});

    await startup.sendPairingNotice("code-1"); // 槽未接线 —— 不丢
    await startup.sendPairingNotice("code-2");
    await startup.wirePairingSink(sink); // 接线即补发

    expect(sinkCalls(sink)).toEqual([
      ["!mgmt:server", "matrix", "code-1"],
      ["!mgmt:server", "matrix", "code-2"],
    ]);
  });

  it("接线后直发:落地目标 = config 派生的管理房间,transport 标 matrix", async () => {
    const startup = createStartupState({ store: new ConfigStore(mgmtConfig) });
    const sink = vi.fn(async () => {});
    await startup.wirePairingSink(sink);

    await startup.sendPairingNotice("code-3");

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sinkCalls(sink)[0]).toEqual(["!mgmt:server", "matrix", "code-3"]);
  });

  it("发出失败不丢件:失败项置顶保留,下次配对码到达时按序随队重试(评审修复钉点)", async () => {
    const startup = createStartupState({ store: new ConfigStore(mgmtConfig) });
    let broken = true;
    const sink = vi.fn(async () => {
      if (broken) throw new Error("transport not connected");
    });
    await startup.wirePairingSink(sink);

    await startup.sendPairingNotice("code-A"); // 发出失败 —— 置顶保留,不丢
    expect(sink).toHaveBeenCalledTimes(1);

    broken = false; // transport 恢复
    await startup.sendPairingNotice("code-B"); // 搭便车重试:code-A 仍在队首

    // 共 3 次调用 = 失败的首次 + 按序重试的 A、B;失败项没有丢、没有乱序。
    expect(sink).toHaveBeenCalledTimes(3);
    expect(sinkCalls(sink).slice(1)).toEqual([
      ["!mgmt:server", "matrix", "code-A"],
      ["!mgmt:server", "matrix", "code-B"],
    ]);
  });

  it("无管理房间时不投递(与降级为仅日志的现状一致)", async () => {
    const startup = createStartupState({ store: new ConfigStore({} as MsgBridgeConfig) });
    const sink = vi.fn(async () => {});
    await startup.wirePairingSink(sink);

    await startup.sendPairingNotice("code-4");

    expect(sink).not.toHaveBeenCalled();
  });

  it("重复接线幂等:首次接线生效,后到的接线不覆盖", async () => {
    const startup = createStartupState({ store: new ConfigStore(mgmtConfig) });
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    await startup.wirePairingSink(first);
    await startup.wirePairingSink(second);

    await startup.sendPairingNotice("code-5");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

describe("createStartupState — 收养许可(降级翻转)", () => {
  it("空间模式初始不放行(管理房留给自建);降级翻转后放行", () => {
    const store = new ConfigStore({ multiProject: true, space: { enabled: true } } as MsgBridgeConfig);
    const startup = createStartupState({ store });

    expect(startup.managementRoomAdoptionAllowed()).toBe(false);
    startup.allowAdoption(); // 空间 ensure 降级时的唯一翻转口
    expect(startup.managementRoomAdoptionAllowed()).toBe(true);
  });

  it("空间就绪(未降级)则不放行:不翻转,查询保持 false", () => {
    const store = new ConfigStore({ multiProject: true, space: { enabled: true } } as MsgBridgeConfig);
    const startup = createStartupState({ store });

    // 空间 ensure 返回 "ready" 的运行不会调用 allowAdoption
    expect(startup.managementRoomAdoptionAllowed()).toBe(false);
  });

  it("非空间模式(单工程或空间功能关停)初始即放行", () => {
    for (const cfg of [{}, { multiProject: true }, { multiProject: true, space: { enabled: false } }]) {
      const startup = createStartupState({ store: new ConfigStore(cfg as MsgBridgeConfig) });
      expect(startup.managementRoomAdoptionAllowed()).toBe(true);
    }
  });
});

describe("runStartupHeals 编排委派(票7 自 space.ts 迁入)", () => {
  it("三段固定顺序:信任补权 → 房间身份 → bot 头像(经假 RoomOps 断言)", async () => {
    const order: string[] = [];
    const roomOps = {
      getPowerLevels: vi.fn(async () => {
        order.push("power");
        return { users: {} };
      }),
      setUserPowerLevel: vi.fn(async () => {}),
      getRoomName: vi.fn(async () => {
        order.push("identity");
        return null;
      }),
      getRoomAvatar: vi.fn(async () => "mxc://room/already-set"), // 只补缺:不触上传/读盘
      getProfileAvatarUrl: vi.fn(async () => {
        order.push("bot-avatar");
        return "mxc://bot/already-set";
      }),
      setProfileAvatar: vi.fn(async () => {}),
    } as unknown as RoomOps;

    const store = new ConfigStore({
      multiProject: true,
      space: { enabled: true, roomId: "!space:server" },
      managementRooms: ["!mgmt:server"],
      auth: { trustedUsers: ["matrix:@barry:server"], adminUserId: "matrix:@barry:server" },
      instanceName: "box1",
    } as MsgBridgeConfig);

    await runStartupHeals(roomOps, store);

    const at = (stage: string) => order.indexOf(stage);
    expect(at("power")).toBeGreaterThanOrEqual(0);
    expect(at("identity")).toBeGreaterThan(at("power"));
    expect(at("bot-avatar")).toBeGreaterThan(at("identity"));
    // 三段都真的委派到了 RoomOps
    expect(roomOps.getPowerLevels).toHaveBeenCalled();
    expect(roomOps.getRoomName).toHaveBeenCalled();
    expect(roomOps.getProfileAvatarUrl).toHaveBeenCalled();
  });
});
