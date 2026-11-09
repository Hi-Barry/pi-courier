import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { createMessageRouter } from "../src/rpc/message-router";
import { MatrixRoomOps } from "../src/transports/matrix-rooms";
import { BOT_REGISTRY_EVENT_TYPE, type RoomOps } from "../src/transports/interface";
import type { MatrixClientPort } from "../src/transports/matrix-client";
import { makeMsg, makeRouterFixture, makeFakeRpc } from "./helpers";
import type { ProjectManager } from "../src/rpc/project-manager";

/**
 * 票02(spec #299)两道新闸门的专项测试:
 *  - botFilter:登记簿内的对端 bot 消息不触发、不进命令解析;
 *  - unknownRoomGate:多项目模式下未映射群聊不接活,管理房发一次认领提示
 *    (落盘簿记),collab.allowUnknownRoomFallback=true 恢复旧行为。
 */

function makeCollabFixture(opts: {
  multiProject?: boolean;
  channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  collab?: { allowUnknownRoomFallback?: boolean; unknownNotifiedRooms?: string[] };
  roomBots?: string[];
  withRegistryCapability?: boolean;
  projectMeta?: { name: string; gitUrl?: string; defaultBranch?: string } | null;
} = {}) {
  const rpc = makeFakeRpc();
  const projectManager = {
    getRpcForRoom: vi.fn().mockReturnValue(rpc),
    isProjectRoom: vi.fn().mockReturnValue(false),
    labelForRoom: vi.fn().mockReturnValue(undefined),
    isMultiProject: opts.multiProject ?? true,
    registerProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    renameProject: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ProjectManager;
  const store = new ConfigStore(
    {
      managementRooms: ["!mg:server"],
      projects: {},
      ...(opts.multiProject === false ? {} : { multiProject: true }),
      ...(opts.collab ? { collab: opts.collab } : {}),
    },
    () => {}
  );
  const auth = new ChallengeAuth(() => {}, () => {});
  auth.loadFromConfig({
    trustedUsers: ["matrix:@barry:server", "matrix:@peerbot:server"],
    adminUserId: "matrix:@barry:server",
    channels: opts.channels ?? {},
  });
  const roomOps = {
    getBotUserId: vi.fn().mockReturnValue("@bot:server"),
    ...(opts.withRegistryCapability === false
      ? {}
      : {
          getRoomBots: vi.fn().mockResolvedValue(opts.roomBots ?? []),
          registerRoomBot: vi.fn().mockResolvedValue(undefined),
        }),
    ...(opts.projectMeta !== undefined
      ? { getProjectMeta: vi.fn().mockResolvedValue(opts.projectMeta) }
      : {}),
  };
  const fx = makeRouterFixture({ rpc, projectManager, store, auth, roomOps: roomOps as unknown as RoomOps });
  return { ...fx, roomOps };
}

const GROUP = { chatId: "!room:server", isGroupChat: true };
const ENABLED = { channels: { "!room:server": { enabled: true, mode: "all" as const } } };

describe("unknownRoomGate (spec #299 票02)", () => {
  it("unmapped group room in multi-project mode: no routing, management room gets the claim notice once, persisted", async () => {
    const fx = makeCollabFixture(ENABLED);
    await fx.router.handleIncoming(makeMsg(GROUP));
    // 不路由:pi 不说话,房间无回执
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
    expect(fx.sendReply).not.toHaveBeenCalledWith("!room:server", "matrix", expect.anything());
    // 管理房收到一次认领提示,携带房间 ID
    expect(fx.sendReply).toHaveBeenCalledTimes(1);
    expect(fx.sendReply.mock.calls[0][0]).toBe("!mg:server");
    expect(fx.sendReply.mock.calls[0][2]).toContain("!room:server");
    // 落盘簿记:同房不重复刷
    expect(fx.store.get().collab?.unknownNotifiedRooms).toEqual(["!room:server"]);
  });

  it("second message from the same unknown room does not repeat the notice", async () => {
    const fx = makeCollabFixture(ENABLED);
    await fx.router.handleIncoming(makeMsg(GROUP));
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "again" }));
    expect(fx.sendReply).toHaveBeenCalledTimes(1);
  });

  it("allowUnknownRoomFallback=true restores the 1.6.x behaviour (falls back to the default project)", async () => {
    const fx = makeCollabFixture({ ...ENABLED, collab: { allowUnknownRoomFallback: true } });
    await fx.router.handleIncoming(makeMsg(GROUP));
    expect(fx.rpc.prompt).toHaveBeenCalled();
    expect(fx.sendReply).not.toHaveBeenCalled();
    expect(fx.store.get().collab?.unknownNotifiedRooms).toBeUndefined();
  });

  it("unmapped DM passes through untouched (no notice, prompt flows)", async () => {
    const fx = makeCollabFixture();
    await fx.router.handleIncoming(makeMsg({ text: "hello" }));
    expect(fx.rpc.prompt).toHaveBeenCalled();
    expect(fx.sendReply).not.toHaveBeenCalled();
  });

  it("mapped project room passes through untouched", async () => {
    const fx = makeCollabFixture(ENABLED);
    (fx.projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!room:server"
    );
    await fx.router.handleIncoming(makeMsg(GROUP));
    expect(fx.rpc.prompt).toHaveBeenCalled();
    expect(fx.sendReply).not.toHaveBeenCalled();
  });

  it("single-project mode keeps the legacy behaviour for group rooms (no gate)", async () => {
    const fx = makeCollabFixture({ ...ENABLED, multiProject: false });
    await fx.router.handleIncoming(makeMsg(GROUP));
    expect(fx.rpc.prompt).toHaveBeenCalled();
    expect(fx.sendReply).not.toHaveBeenCalled();
  });

  it("management room itself is exempt from the gate", async () => {
    const fx = makeCollabFixture({ channels: { "!mg:server": { enabled: true, mode: "all" } } });
    await fx.router.handleIncoming(makeMsg({ chatId: "!mg:server", isGroupChat: true, text: "hello" }));
    expect(fx.rpc.prompt).toHaveBeenCalled();
    expect(fx.sendReply).not.toHaveBeenCalled();
  });
});

describe("unknownRoomGate × claim card (spec #299 票04)", () => {
  it("unmapped group WITH project meta: claim card to the management room, pending claim booked, noticed marked", async () => {
    const fx = makeCollabFixture({
      ...ENABLED,
      projectMeta: { name: "y", gitUrl: "https://github.com/x/y.git", defaultBranch: "main" },
    });
    await fx.router.handleIncoming(makeMsg(GROUP));
    // 卡面强制展示完整仓库地址与目标目录 + 认领指令(spec Story 31)
    const card = fx.sendReply.mock.calls[0][2] as string;
    expect(card).toContain("https://github.com/x/y.git");
    expect(card).toContain("/pmctl claim 1");
    // 待认领落盘(重启不丢)+ 已提示标记
    expect(fx.store.get().collab?.pendingClaims).toEqual([
      expect.objectContaining({ roomId: "!room:server", url: "https://github.com/x/y.git", projectName: "y" }),
    ]);
    expect(fx.store.get().collab?.unknownNotifiedRooms).toEqual(["!room:server"]);
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
  });

  it("meta without a gitUrl → plain notice, no pending claim booked", async () => {
    const fx = makeCollabFixture({ ...ENABLED, projectMeta: { name: "y" } });
    await fx.router.handleIncoming(makeMsg(GROUP));
    expect(fx.sendReply.mock.calls[0][2]).toContain("保持静默");
    expect(fx.store.get().collab?.pendingClaims ?? []).toEqual([]);
    expect(fx.store.get().collab?.unknownNotifiedRooms).toEqual(["!room:server"]);
  });
});

describe("guestTrigger × 增量信箱 (spec #299 票05)", () => {
  /** guest 项目房夹具:已映射(过陌生房闸)+ modeForRoom=guest。 */
  function makeGuestFixture(opts: Parameters<typeof makeCollabFixture>[0] = {}) {
    const fx = makeCollabFixture(opts);
    (fx.projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!room:server"
    );
    (fx.projectManager as unknown as Record<string, ReturnType<typeof vi.fn>>).modeForRoom = vi
      .fn()
      .mockImplementation((roomId: string) => (roomId === "!room:server" ? "guest" : undefined));
    return fx;
  }

  it("guest room: unmentioned text does not trigger but lands in the mailbox; the next mention drains it into the prompt", async () => {
    const fx = makeGuestFixture({ ...ENABLED, roomBots: ["@peerbot:server"] });
    await fx.router.handleIncoming(makeMsg({ ...GROUP, userId: "@carol:server", username: "carol", text: "先看下登录接口" }));
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
    await fx.router.handleIncoming(
      makeMsg({ ...GROUP, text: "@bot:server 开始吧", wasMentioned: true })
    );
    expect(fx.rpc.prompt).toHaveBeenCalledTimes(1);
    const promptText = (fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptText).toContain("增量消息");
    expect(promptText).toContain("carol: 先看下登录接口");
    expect(promptText).toContain("开始吧");
  });

  it("after a drain the mailbox is empty — the next mention carries no digest", async () => {
    const fx = makeGuestFixture(ENABLED);
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "未点名", wasMentioned: false }));
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server 一", wasMentioned: true }));
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server 二", wasMentioned: true }));
    const calls = (fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain("增量消息");
    expect(calls[1][0]).not.toContain("增量消息");
    expect(calls[1][0]).toContain("二");
  });

  it("registered bot messages go to the mailbox instead of being dropped (botFilter 票05 升级)", async () => {
    const fx = makeGuestFixture({ ...ENABLED, roomBots: ["@peerbot:server"] });
    await fx.router.handleIncoming(
      makeMsg({ ...GROUP, userId: "@peerbot:server", username: "peerbot", text: "我修好了登录接口" })
    );
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server 收到", wasMentioned: true }));
    const promptText = (fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptText).toContain("peerbot: 我修好了登录接口");
  });

  it("slash-command-like text in a guest room neither triggers nor enters the mailbox", async () => {
    const fx = makeGuestFixture(ENABLED);
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "/pmctl list", wasMentioned: false }));
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server ok", wasMentioned: true }));
    expect((fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain("/pmctl");
  });

  it("owner rooms keep the 1.6.x behaviour: unmentioned text triggers with no digest", async () => {
    const fx = makeCollabFixture({ ...ENABLED, roomBots: ["@peerbot:server"] });
    (fx.projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!room:server"
    );
    (fx.projectManager as unknown as Record<string, ReturnType<typeof vi.fn>>).modeForRoom = vi
      .fn()
      .mockImplementation((roomId: string) => (roomId === "!room:server" ? "owner" : undefined));
    await fx.router.handleIncoming(makeMsg(GROUP));
    expect(fx.rpc.prompt).toHaveBeenCalledTimes(1);
    expect((fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain("增量消息");
  });
});

describe("botFilter (spec #299 票02)", () => {
  /** 房间标记为已映射项目房:排除 unknownRoomGate 干扰,让 botFilter 成为
   *  唯一变量 —— 项目房里 trusted 人类照常到 pi,登记 bot 被拦。 */
  function makeMappedFixture(opts: Parameters<typeof makeCollabFixture>[0] = {}) {
    const fx = makeCollabFixture(opts);
    (fx.projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!room:server"
    );
    return fx;
  }

  it("a registered peer bot's message never triggers pi nor command parsing — even when trusted", async () => {
    const fx = makeMappedFixture({ ...ENABLED, roomBots: ["@peerbot:server"] });
    await fx.router.handleIncoming(makeMsg({ ...GROUP, userId: "@peerbot:server", username: "peerbot", text: "/pmctl list" }));
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
    expect(fx.sendReply).not.toHaveBeenCalled();
    // 登记簿确实被咨询过(缓存未命中时读一次)
    expect(fx.roomOps.getRoomBots as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("!room:server");
  });

  it("a human message in the same room passes; the registry read is TTL-cached across messages", async () => {
    const fx = makeMappedFixture({ ...ENABLED, roomBots: ["@peerbot:server"] });
    await fx.router.handleIncoming(makeMsg(GROUP));
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "second" }));
    expect(fx.rpc.prompt).toHaveBeenCalledTimes(2);
    expect(fx.roomOps.getRoomBots as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("without the registry capability (legacy fake / non-Matrix), nothing is filtered", async () => {
    const fx = makeMappedFixture({ ...ENABLED, withRegistryCapability: false });
    await fx.router.handleIncoming(makeMsg({ ...GROUP, userId: "@peerbot:server", username: "peerbot", text: "hi" }));
    // 无登记簿能力 = 不过滤:trusted 的对端消息照常到 pi(与 1.6.x 一致)
    expect(fx.rpc.prompt).toHaveBeenCalled();
  });
});

describe("bot registry state-event primitives (spec #299 票02)", () => {
  it("registerRoomBot writes one signed state event per bot (state_key = its MXID); getRoomBots filters by type", async () => {
    const port = {
      sendStateEvent: vi.fn().mockResolvedValue("$ev"),
      getRoomState: vi
        .fn()
        .mockResolvedValue([
          { type: BOT_REGISTRY_EVENT_TYPE, state_key: "@a:server", content: {} },
          { type: "m.room.name", state_key: "", content: {} },
          { type: BOT_REGISTRY_EVENT_TYPE, state_key: "@b:server", content: {} },
        ]),
    };
    const ops = new MatrixRoomOps({
      getClient: () => port as unknown as MatrixClientPort,
      getBotUserId: () => "@bot:server",
      onLeftRoom: () => {},
    });
    await ops.registerRoomBot("!r:server", "@peer:server");
    expect(port.sendStateEvent).toHaveBeenCalledWith("!r:server", BOT_REGISTRY_EVENT_TYPE, "@peer:server", {
      registeredBy: "@bot:server",
      registeredAt: expect.any(Number),
    });
    // 幂等:同 MXID 再登记就是同 (type, state_key) 覆盖,不产生第二条
    await ops.registerRoomBot("!r:server", "@peer:server");
    expect(port.sendStateEvent).toHaveBeenCalledTimes(2);
    expect(port.sendStateEvent.mock.calls[1].slice(0, 3)).toEqual(port.sendStateEvent.mock.calls[0].slice(0, 3));
    expect(await ops.getRoomBots("!r:server")).toEqual(["@a:server", "@b:server"]);
  });
});
