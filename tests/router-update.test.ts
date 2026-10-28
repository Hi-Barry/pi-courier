/**
 * /update 的 router 侧接线验收(桥自更新 spec §8/§10 用例 2 路由半边):
 * slashCommands 阶段把 login 口径的 adminRoom 映射(多工程看管理房收养、
 * 单工程 DM 即管理房)与编排器插槽一起预绑定;访客在 authorizationGate 硬拦
 * (registry 的 guest 位);发起审计经登记表 auditEvent 位落账。
 * 状态机分支归 tests/update-orchestrator.test.ts,命令层委托归
 * tests/command-map-update.test.ts。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { ConfigStore } from "../src/config";
import type { PiRpc } from "../src/rpc/pi-rpc.js";
import type { ProjectManager } from "../src/rpc/project-manager.js";
import type { PendingUpdateStore } from "../src/update/pending-update.js";
import { UpdateOrchestrator } from "../src/update/updater.js";
import { makeFakeRpc, makeMsg, makeRouterFixture } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

/** barry 信任 + stranger 显式注册为访客 + 默认 DM 房间已 enable —— 访客走
 *  authorizationGate(配对挑战只针对完全未注册的陌生人,guest-tier 先例);
 *  群聊用例也需要 enabled channels,否则消息在房间门阶段就被丢弃。 */
function authWithGuest(): ChallengeAuth {
  const auth = new ChallengeAuth(() => {}, () => {});
  auth.loadFromConfig({
    trustedUsers: ["matrix:@barry:server"],
    guestUsers: ["matrix:@stranger:server"],
    adminUserId: "matrix:@barry:server",
    channels: { "!dm:server": { enabled: true, mode: "all" } },
  });
  return auth;
}

/** 假编排器:只记录 handleCommand 的调用参数(路由半边不进真状态机)。 */
function fakeUpdater() {
  return { handleCommand: vi.fn().mockResolvedValue(true) };
}

/** helpers 默认 fake ProjectManager 的多工程变体:只翻转 isMultiProject。 */
function multiProjectManager(rpc: PiRpc): ProjectManager {
  return {
    getRpcForRoom: vi.fn().mockReturnValue(rpc),
    isProjectRoom: vi.fn().mockReturnValue(false),
    labelForRoom: vi.fn().mockReturnValue(undefined),
    isMultiProject: true,
    allRpcs: vi.fn().mockReturnValue([rpc]),
    roomForRpc: vi.fn().mockReturnValue(undefined),
    projectFallbacks: vi.fn().mockReturnValue(undefined),
  } as unknown as ProjectManager;
}

/** 真编排器(全部外缝打假):端到端验收守卫与回执。本组用例(check/守卫/
 *  访客/审计)不触达 pending-update 写入,存储用结构假件即可。 */
function realUpdater() {
  return new UpdateOrchestrator({
    pendingUpdate: {
      read: () => undefined,
      write: () => {},
      clear: () => {},
    } as unknown as PendingUpdateStore,
    fetchRegistry: vi.fn().mockResolvedValue({ version: "1.2.0" }),
    readVersion: () => "1.2.0",
    getuid: () => 1000,
  });
}

describe("adminRoom 映射(login 口径:多工程看管理房,单工程 DM 即管理房)", () => {
  it("单工程 + DM(主场景)→ adminRoom=true", async () => {
    const updater = fakeUpdater();
    const { router } = makeRouterFixture({ extra: { updater } });
    await router.handleIncoming(makeMsg({ text: "/update" }));
    expect(updater.handleCommand).toHaveBeenCalledTimes(1);
    expect(updater.handleCommand.mock.calls[0]![1].adminRoom).toBe(true);
  });

  it("单工程 + 群聊 → adminRoom=false(守卫拒绝,编排器侧语义)", async () => {
    const updater = fakeUpdater();
    const { router } = makeRouterFixture({ auth: authWithGuest(), extra: { updater } });
    await router.handleIncoming(makeMsg({ text: "/update", isGroupChat: true }));
    expect(updater.handleCommand).toHaveBeenCalledTimes(1);
    expect(updater.handleCommand.mock.calls[0]![1].adminRoom).toBe(false);
  });

  it("多工程 + 非管理房 DM → adminRoom=false(照传 isManagementRoom 会死路)", async () => {
    const updater = fakeUpdater();
    const { router } = makeRouterFixture({
      extra: { updater },
      projectManager: multiProjectManager(makeFakeRpc()),
      store: new ConfigStore({ managementRooms: ["!mgmt:server"] }),
    });
    await router.handleIncoming(makeMsg({ text: "/update" })); // chatId !dm:server ≠ 管理房
    expect(updater.handleCommand).toHaveBeenCalledTimes(1);
    expect(updater.handleCommand.mock.calls[0]![1].adminRoom).toBe(false);
  });

  it("多工程 + 管理房 DM → adminRoom=true", async () => {
    const updater = fakeUpdater();
    const { router } = makeRouterFixture({
      extra: { updater },
      projectManager: multiProjectManager(makeFakeRpc()),
      store: new ConfigStore({ managementRooms: ["!dm:server"] }),
    });
    await router.handleIncoming(makeMsg({ text: "/update" }));
    expect(updater.handleCommand).toHaveBeenCalledTimes(1);
    expect(updater.handleCommand.mock.calls[0]![1].adminRoom).toBe(true);
  });
});

describe("端到端(真编排器注入):守卫、访客拦截、发起审计", () => {
  it("单工程群聊 /update → notManagementRoom 回执,不触网", async () => {
    const { router, sendReply } = makeRouterFixture({
      auth: authWithGuest(),
      extra: { updater: realUpdater() },
    });
    await router.handleIncoming(makeMsg({ text: "/update", isGroupChat: true }));
    expect(sendReply).toHaveBeenCalledWith("!dm:server", "matrix", "❌ /update 仅可在管理房使用。");
  });

  it("单工程 DM /update check → check.upToDate 回执(编排器真跑)", async () => {
    const { router, sendReply } = makeRouterFixture({ extra: { updater: realUpdater() } });
    await router.handleIncoming(makeMsg({ text: "/update check" }));
    expect(sendReply).toHaveBeenCalledWith("!dm:server", "matrix", "✅ 已是最新版本(v1.2.0)。");
  });

  it("访客发 /update → authorizationGate 硬拦(guest.denied 回执 + 审计),编排器不被触达", async () => {
    const updater = fakeUpdater();
    const { router, sendReply, auditLines } = makeRouterFixture({
      auth: authWithGuest(),
      audit: true,
      extra: { updater },
    });
    await router.handleIncoming(
      makeMsg({ userId: "@stranger:server", username: "stranger", text: "/update" })
    );
    expect(sendReply).toHaveBeenCalledWith("!dm:server", "matrix", "🚫 此命令需要信任用户权限:/update");
    expect(auditLines.some((l) => l.event === "guest.denied" && l.detail?.includes("/update"))).toBe(true);
    expect(updater.handleCommand).not.toHaveBeenCalled();
  });

  it("发起审计:handled 的 /update 经登记表 auditEvent 位落账(actor=发起人)", async () => {
    const { router, auditLines } = makeRouterFixture({ audit: true, extra: { updater: realUpdater() } });
    await router.handleIncoming(makeMsg({ text: "/update check" }));
    const line = auditLines.find((l) => l.event === "update");
    expect(line).toMatchObject({ actor: "matrix:@barry:server", chatId: "!dm:server" });
    expect(line?.detail).toBe("/update check");
  });

  it("未识别的 /update 变体不落发起审计(handled=false 不记)", async () => {
    const { router, auditLines } = makeRouterFixture({ audit: true, extra: { updater: fakeUpdater() } });
    // /updater 不是 /update(误拼)→ 落 default 转发 pi,登记表无此命令。
    await router.handleIncoming(makeMsg({ text: "/updater" }));
    expect(auditLines.some((l) => l.event === "update")).toBe(false);
  });
});
