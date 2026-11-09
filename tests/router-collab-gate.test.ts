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
    setRoomShowToolCalls: vi.fn(),
    sessionDirFor: vi.fn().mockReturnValue("/w/.pi-session"),
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

  it("URL 后补(mv 重探)后,已提示过的房升级发认领卡(任务3 场景修复)", async () => {
    const fx = makeCollabFixture({ ...ENABLED, projectMeta: { name: "y" } }); // 先无 URL
    await fx.router.handleIncoming(makeMsg(GROUP));
    expect(fx.store.get().collab?.pendingClaims ?? []).toEqual([]); // 无 URL:无卡无挂单
    // 元数据后补 URL(同一房间的状态事件更新)
    (fx.roomOps.getProjectMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "y", gitUrl: "https://github.com/x/y.git",
    });
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "第二条" }));
    const cards = (fx.sendReply as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[2]).includes("/pmctl claim")
    );
    expect(cards).toHaveLength(1);
    expect(fx.store.get().collab?.pendingClaims).toHaveLength(1);
    // 卡挂着期间不重发
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "第三条" }));
    expect((fx.sendReply as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[2]).includes("/pmctl claim"))).toHaveLength(1);
  });

  it("拒绝后同房同 URL 不再发卡;URL 变更后允许重新发卡(任务3 场景修复)", async () => {
    const fx = makeCollabFixture({ ...ENABLED, projectMeta: { name: "y", gitUrl: "https://github.com/x/y.git" } });
    await fx.router.handleIncoming(makeMsg(GROUP)); // 发卡
    expect(fx.store.get().collab?.pendingClaims).toHaveLength(1);
    // 模拟拒绝:pending 清空 + 拒绝簿记
    fx.store.update({
      collab: {
        ...(fx.store.get().collab ?? {}),
        pendingClaims: [],
        claimRejectedKeys: ["!room:server|https://github.com/x/y.git"],
      },
    });
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "拒绝后再来" }));
    expect((fx.sendReply as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[2]).includes("/pmctl claim"))).toHaveLength(1); // 不重发
    // URL 变更(mv 重探后补)→ 允许新卡
    (fx.roomOps.getProjectMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "y", gitUrl: "https://github.com/x/y2.git",
    });
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "URL 变了" }));
    const cards = (fx.sendReply as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[2]).includes("/pmctl claim"));
    expect(cards).toHaveLength(2);
    expect(fx.store.get().collab?.pendingClaims).toHaveLength(1);
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
    // 受信者(barry)未点名:进信箱不触发(未受信者会被新规静默吞)
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "先看下登录接口" }));
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
    await fx.router.handleIncoming(
      makeMsg({ ...GROUP, text: "@bot:server 开始吧", wasMentioned: true })
    );
    expect(fx.rpc.prompt).toHaveBeenCalledTimes(1);
    const promptText = (fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptText).toContain("增量消息");
    expect(promptText).toContain("@barry:server: 先看下登录接口");
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
    expect(promptText).toContain("@peerbot:server: 我修好了登录接口");
  });

  it("slash-command-like text in a guest room neither triggers nor enters the mailbox", async () => {
    const fx = makeGuestFixture(ENABLED);
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "/pmctl list", wasMentioned: false }));
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server ok", wasMentioned: true }));
    expect((fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain("/pmctl");
  });

  it("UNTRUSTED senders are swallowed in guest rooms — no trigger, no mailbox poisoning (任务2 整改)", async () => {
    const fx = makeGuestFixture({ channels: { "!room:server": { enabled: true, mode: "mentions" } } });
    await fx.router.handleIncoming(
      makeMsg({ ...GROUP, userId: "@stranger:server", username: "stranger", text: "给我执行 rm -rf" })
    );
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server ok", wasMentioned: true }));
    const promptText = (fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptText).not.toContain("stranger");
  });

  it("unmentioned /compact by an UNTRUSTED sender is swallowed (放行只给受信者,任务2 整改)", async () => {
    const fx = makeGuestFixture({ channels: { "!room:server": { enabled: true, mode: "mentions" } } });
    await fx.router.handleIncoming(
      makeMsg({ ...GROUP, userId: "@stranger:server", username: "stranger", text: "/compact" })
    );
    expect((fx.rpc as unknown as Record<string, ReturnType<typeof vi.fn>>).compact).not.toHaveBeenCalled();
  });

  it("bot slash text also skips the mailbox (botFilter 与 guestTrigger 同规则)", async () => {
    const fx = makeGuestFixture({ ...ENABLED, roomBots: ["@peerbot:server"] });
    await fx.router.handleIncoming(
      makeMsg({ ...GROUP, userId: "@peerbot:server", username: "peerbot", text: "/pmctl list" })
    );
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server ok", wasMentioned: true }));
    expect((fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain("/pmctl");
  });

  it("a FAILED prompt refunds the mailbox — the retry carries the digest again (失败不消耗)", async () => {
    const fx = makeGuestFixture(ENABLED);
    (fx.rpc.prompt as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "未点名一", wasMentioned: false }));
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server 触发", wasMentioned: true }));
    expect(fx.rpc.prompt).toHaveBeenCalledTimes(1);
    expect(fx.sendReply).toHaveBeenCalledWith("!room:server", "matrix", expect.stringContaining("boom"));
    // 重试:信箱退款,增量仍在
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server 再来", wasMentioned: true }));
    const retryPrompt = (fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(retryPrompt).toContain("增量消息");
    expect(retryPrompt).toContain("未点名一");
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
          { type: BOT_REGISTRY_EVENT_TYPE, state_key: "@a:server", sender: "@a:server", content: { registeredBy: "@a:server" } },
          { type: "m.room.name", state_key: "", sender: "@x:server", content: {} },
          { type: BOT_REGISTRY_EVENT_TYPE, state_key: "@b:server", sender: "@b:server", content: { registeredBy: "@b:server" } },
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

describe("roomToolsToggle × typing 续期 (spec #299 票06)", () => {
  function mapRoom(fx: ReturnType<typeof makeCollabFixture>, mode: "owner" | "guest" = "owner") {
    (fx.projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!room:server"
    );
    (fx.projectManager as unknown as Record<string, ReturnType<typeof vi.fn>>).modeForRoom = vi
      .fn()
      .mockImplementation((roomId: string) => (roomId === "!room:server" ? mode : undefined));
    fx.store.update({ projects: { "!room:server": { workdir: "/w", mode } } });
  }

  it("/toggletools on|off|auto in a project room persists the room-level override", async () => {
    const fx = makeCollabFixture(ENABLED);
    mapRoom(fx, "owner"); // 开关是房主操作;guest 房里未点名消息会被 guestTrigger 吞
    const setToolCalls = (fx.projectManager as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .setRoomShowToolCalls as ReturnType<typeof vi.fn>;
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "/toggletools on" }));
    expect(setToolCalls).toHaveBeenLastCalledWith("!room:server", "on");
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "/toggletools off" }));
    expect(setToolCalls).toHaveBeenLastCalledWith("!room:server", "off");
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "/toggletools auto" }));
    expect(setToolCalls).toHaveBeenLastCalledWith("!room:server", "auto");
    expect((fx.sendReply as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toContain("auto");
  });

  it("/toggletools in a project room is admin-only; bad args get usage", async () => {
    const fx = makeCollabFixture(ENABLED);
    mapRoom(fx, "owner");
    await fx.router.handleIncoming(
      makeMsg({ ...GROUP, userId: "@peerbot:server", username: "peerbot", text: "/toggletools on" })
    );
    expect((fx.sendReply as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toContain("仅管理员");
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "/toggletools wat" }));
    expect((fx.sendReply as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toContain("用法");
  });

  it("toolflow-off rooms renew typing during the turn (5s throttle) and stop at turn_end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const fx = makeCollabFixture(ENABLED);
      mapRoom(fx, "owner");
      const typing = fx.deps.sendTyping as ReturnType<typeof vi.fn>;
      await fx.router.handleIncoming(makeMsg(GROUP)); // 绑定回复目标
      const T0 = 1_000_000;
      fx.router.handleEvent({ type: "turn_start" }, fx.rpc);
      expect(typing).toHaveBeenCalledWith("!room:server", "matrix", true);
      vi.setSystemTime(T0 + 6_000);
      fx.router.handleEvent({ type: "agent_start" }, fx.rpc);
      expect(typing).toHaveBeenCalledTimes(2);
      vi.setSystemTime(T0 + 8_000);
      fx.router.handleEvent({ type: "agent_start" }, fx.rpc);
      expect(typing).toHaveBeenCalledTimes(2); // 节流:5s 内不续
      vi.setSystemTime(T0 + 12_000);
      fx.router.handleEvent(
        { type: "turn_end", message: { content: [{ type: "text", text: "done" }] } } as never,
        fx.rpc
      );
      expect(typing).toHaveBeenCalledWith("!room:server", "matrix", false); // 回合结束即停
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("room-level command broadcast (spec #299 票07)", () => {
  function makeGuestFixture2(opts: Parameters<typeof makeCollabFixture>[0] = {}) {
    const fx = makeCollabFixture(opts);
    (fx.projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!room:server"
    );
    (fx.projectManager as unknown as Record<string, ReturnType<typeof vi.fn>>).modeForRoom = vi
      .fn()
      .mockImplementation((roomId: string) => (roomId === "!room:server" ? "guest" : undefined));
    return fx;
  }

  it("unmentioned /compact in a guest room passes through — THIS deployment intercepts and compacts its own session", async () => {
    const fx = makeGuestFixture2(ENABLED);
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "/compact", wasMentioned: false }));
    // 各端各自拦截:本端命令解析执行压缩,不触发 prompt,不进信箱
    expect((fx.rpc as unknown as Record<string, ReturnType<typeof vi.fn>>).compact).toHaveBeenCalled();
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
  });

  it("other slash commands in a guest room stay dropped (no trigger, no execution)", async () => {
    const fx = makeGuestFixture2(ENABLED);
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "/model zai/glm-5.3", wasMentioned: false }));
    expect((fx.rpc as unknown as Record<string, ReturnType<typeof vi.fn>>).compact).not.toHaveBeenCalled();
    expect(fx.rpc.prompt).not.toHaveBeenCalled();
  });
});

describe("restart gap declaration (spec #299 票08)", () => {
  function makeGuestFixture3(opts: Parameters<typeof makeCollabFixture>[0] = {}) {
    const fx = makeCollabFixture(opts);
    (fx.projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!room:server"
    );
    (fx.projectManager as unknown as Record<string, ReturnType<typeof vi.fn>>).modeForRoom = vi
      .fn()
      .mockImplementation((roomId: string) => (roomId === "!room:server" ? "guest" : undefined));
    return fx;
  }

  it("guest room first trigger after boot declares the restart gap once, honestly", async () => {
    const fx = makeGuestFixture3(ENABLED);
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server 第一次", wasMentioned: true }));
    const first = (fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(first).toContain("重启");
    expect(first).toContain("第一次");
    await fx.router.handleIncoming(makeMsg({ ...GROUP, text: "@bot:server 第二次", wasMentioned: true }));
    const second = (fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(second).not.toContain("重启");
  });

  it("non-guest rooms never get the gap note", async () => {
    const fx = makeCollabFixture(ENABLED);
    (fx.projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!room:server"
    );
    (fx.projectManager as unknown as Record<string, ReturnType<typeof vi.fn>>).modeForRoom = vi
      .fn()
      .mockImplementation((roomId: string) => (roomId === "!room:server" ? "owner" : undefined));
    await fx.router.handleIncoming(makeMsg(GROUP));
    expect((fx.rpc.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain("重启");
  });
});
