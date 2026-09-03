import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { ConfigStore } from "../src/config";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { logger } from "../src/logger";
import { buildTurnReply } from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createMessageRouter } from "../src/rpc/message-router";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { ExternalMessage } from "../src/types";

/** Minimal assistant-shaped message for turn_end events. */
function textMessage(text: string): AssistantMessage {
  return { content: [{ type: "text", text }] } as unknown as AssistantMessage;
}

function makeMsg(overrides: Partial<ExternalMessage> = {}): ExternalMessage {
  return {
    chatId: "!dm:server",
    transport: "matrix",
    userId: "@barry:server",
    username: "barry",
    content: "hi",
    isGroupChat: false,
    wasMentioned: false,
    messageId: "m1",
    timestamp: new Date(),
    ...overrides,
  };
}

/**
 * Shared fixtures for router tests. Real ChallengeAuth in both suites —
 * the router pipeline's authorization semantics (trusted users, challenges,
 * channel modes) are under test. barry = admin + trusted; carol = trusted
 * non-admin; rooms pre-listed in `channels` are enabled.
 */
function makeFixtures(opts: { multiProject?: boolean; managementRoomAdoptionAllowed?: () => boolean; space?: { enabled?: boolean; roomId?: string; invitedUsers?: string[] }; channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }> } = {}) {
  const codeBox: { current: string | null } = { current: null };
  const replies: Array<{ chatId: string; transport: string; text: string }> = [];
  const sendReply = async (chatId: string, transport: string, text: string) => {
    replies.push({ chatId, transport, text });
  };
  const rpc = {
    prompt: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({ model: { id: "m" } }),
    newSession: vi.fn().mockResolvedValue({ cancelled: false }),
    onEvent: vi.fn(),
  } as unknown as PiRpc;
  const projectManager = {
    getRpcForRoom: vi.fn().mockReturnValue(rpc),
    isProjectRoom: vi.fn().mockReturnValue(false),
    labelForRoom: vi.fn().mockReturnValue(undefined),
    isMultiProject: opts.multiProject ?? true,
    registerProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([] as Array<[string, { name?: string; workdir: string }]>),
    renameProject: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ProjectManager;
  const store = new ConfigStore({
    managementRooms: [],
    projects: {},
    ...(opts.multiProject === false ? {} : { multiProject: true }),
    ...(opts.space ? { space: opts.space } : {}),
  });
  const auth = new ChallengeAuth(
    (code) => {
      codeBox.current = code;
    },
    () => {}
  );
  auth.loadFromConfig({
    trustedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
    adminUserId: "matrix:@barry:server",
    channels: opts.channels ?? {},
  });
  // Router sees message I/O as two functions; room ops as one stubbed capability.
  const sendTyping = vi.fn(
    async (_chatId: string, _transport: string): Promise<void> => {}
  );
  const roomOps = {
    createRoom: vi.fn().mockResolvedValue("!newroom:server"),
    createProjectRoom: vi.fn().mockResolvedValue("!newproj:server"),
    createSpace: vi.fn().mockResolvedValue("!space:server"),
    addRoomToSpace: vi.fn().mockResolvedValue(undefined),
    removeRoomFromSpace: vi.fn().mockResolvedValue(undefined),
    inviteUser: vi.fn().mockResolvedValue(undefined),
    setRoomName: vi.fn().mockResolvedValue(undefined),
    setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    getBotUserId: vi.fn().mockReturnValue("@bot:server"),
    encryptionAvailable: true,
  };
  const pmctl = new PmctlController({ projectManager, roomOps, store });
  const makeRouter = () =>
    createMessageRouter({ projectManager, auth, sendReply, sendTyping, roomOps, store, pmctl, managementRoomAdoptionAllowed: opts.managementRoomAdoptionAllowed });
  return {
    codeBox,
    replies,
    sendReply,
    sendTyping,
    rpc,
    projectManager,
    auth,
    roomOps,
    store,
    pmctl,
    makeRouter,
  };
}

describe("buildTurnReply", () => {
  const textPart = (text: string) => ({ type: "text", text });

  it("joins text parts into replyable text", () => {
    const msg = { content: [textPart("hello"), textPart("world")] } as unknown as AssistantMessage;
    expect(buildTurnReply(msg)).toEqual({ text: "hello\nworld", pendingTools: false });
  });

  it("reports pendingTools for tool-call turns", () => {
    const msg = { content: [{ type: "toolCall", name: "bash", arguments: {} }] } as unknown as AssistantMessage;
    expect(buildTurnReply(msg, true)).toEqual({ text: null, pendingTools: true });
  });

  it("appends tool-call summaries unless hidden", () => {
    const msg = { content: [textPart("ran it"), { type: "toolCall", name: "bash", arguments: {} }] } as unknown as AssistantMessage;
    expect(buildTurnReply(msg, true)).toEqual({ text: "ran it", pendingTools: true });
    const shown = buildTurnReply(msg, false);
    expect(shown.text).toContain("ran it");
    expect(shown.text).toContain("`bash`");
  });

  it("returns null text for a content-free turn (binding must be kept)", () => {
    const msg = { content: [] } as unknown as AssistantMessage;
    expect(buildTurnReply(msg)).toEqual({ text: null, pendingTools: false });
  });
});

describe("message-router multi-project routing", () => {
  let rpc: PiRpc;
  let projectManager: ProjectManager;
  let auth: ChallengeAuth;
  let roomOps: Record<string, ReturnType<typeof vi.fn>>;
  let sendTyping: ReturnType<typeof makeFixtures>["sendTyping"];
  let store: ConfigStore;
  let pmctl: PmctlController;
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let makeRouter: () => ReturnType<typeof createMessageRouter>;

  beforeEach(() => {
    const fx = makeFixtures();
    rpc = fx.rpc;
    projectManager = fx.projectManager;
    auth = fx.auth;
    roomOps = fx.roomOps as unknown as Record<string, ReturnType<typeof vi.fn>>;
    sendTyping = fx.sendTyping;
    store = fx.store;
    pmctl = fx.pmctl;
    replies = fx.replies;
    makeRouter = fx.makeRouter;
  });

  const enableRoom = (chatId: string, mode: "all" | "mentions" | "trusted-only" = "all") => {
    auth.enableChannel(chatId, mode);
  };

  it("routes plain DM messages to the room's rpc via projectManager", async () => {
    const router = makeRouter();
    const msg = makeMsg({ content: "hello pi" });
    await router.handleIncoming(msg);
    expect(projectManager.getRpcForRoom).toHaveBeenCalledWith("!dm:server");
    expect(rpc.prompt).toHaveBeenCalledWith("hello pi");
  });

  it("routes project-room messages to the project rpc (different instance)", async () => {
    const projectRpc = { prompt: vi.fn().mockResolvedValue(undefined) } as unknown as PiRpc;
    (projectManager.getRpcForRoom as ReturnType<typeof vi.fn>).mockReturnValue(projectRpc);
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ chatId: "!proj:server", content: "do work" }));
    expect(rpc.prompt).not.toHaveBeenCalled();
    expect(projectRpc.prompt).toHaveBeenCalledWith("do work");
  });

  it("/newproject creates a room, registers the project and replies", async () => {
    // Management commands require the management-room flag in config.
    store.update({ managementRooms: ["!dm:server"] });
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/newproject myapp /tmp/myapp" }));
    await new Promise((r) => setTimeout(r, 20)); // let fire-and-forget branding settle
    expect(roomOps.createProjectRoom).toHaveBeenCalledWith(expect.stringContaining("myapp("), "@barry:server");
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!newproj:server", "@barry:server", 100);
    expect(projectManager.registerProject).toHaveBeenCalledWith("!newproj:server", "/tmp/myapp", "myapp");
    const reply = replies.at(-1)!;
    expect(reply.text).toContain("myapp");
    expect(reply.text).toContain("!newproj:server");
  });

  it("resolves a relative path in /pmctl new against the project root", async () => {
    store.update({ managementRooms: ["!dm:server"], workdir: "/home/you/Projects" });
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/newproject myapp myapp" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(projectManager.registerProject).toHaveBeenCalledWith(
      "!newproj:server",
      "/home/you/Projects/myapp",
      "myapp"
    );
  });

  it("uses an absolute path as-is in /pmctl new", async () => {
    store.update({ managementRooms: ["!dm:server"], workdir: "/home/you/Projects" });
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/newproject myapp /srv/custom/myapp" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(projectManager.registerProject).toHaveBeenCalledWith(
      "!newproj:server",
      "/srv/custom/myapp",
      "myapp"
    );
  });

  it("defaults the path to <project root>/<name> when omitted", async () => {
    store.update({ managementRooms: ["!dm:server"], workdir: "/home/you/Projects" });
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/pmctl new newapp" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(projectManager.registerProject).toHaveBeenCalledWith(
      "!newproj:server",
      "/home/you/Projects/newapp",
      "newapp"
    );
  });

  it("allows /pmctl from a trusted DM even before the branding flag is persisted", async () => {
    // No managementRooms flag in config (first-ever message) — the trusted
    // user's DM must still count as the management room.
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/pmctl new myapp /tmp/myapp" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(projectManager.registerProject).toHaveBeenCalledWith("!newproj:server", "/tmp/myapp", "myapp");
    expect(replies.at(-1)!.text).toContain("创建完成");
  });

  it("rejects /pmctl from a project room", async () => {
    enableRoom("!projroom:server");
    const router = makeRouter();
    await router.handleIncoming(
      makeMsg({ chatId: "!projroom:server", isGroupChat: true, content: "/pmctl list" })
    );
    expect(replies.at(-1)!.text).toContain("仅可在管理房间");
  });

  it("rejects /pmctl from a second room once a management room already exists", async () => {
    store.update({ managementRooms: ["!dm:server"] });
    const router = makeRouter();
    // A different private room is not the management room.
    await router.handleIncoming(
      makeMsg({ chatId: "!alice:server", content: "/pmctl list" })
    );
    expect(replies.at(-1)!.text).toContain("仅可在管理房间");
  });

  it("brands an unnamed DM room on first message (idempotent)", async () => {
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "hi" }));
    // maybeInitManagementRoom runs — let it complete
    await new Promise((r) => setTimeout(r, 20));
    expect(roomOps.setRoomName).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("项目管理")
    );
    expect(replies.some((r) => r.text.includes("项目管理房间"))).toBe(true);
    // The pairing is persisted through the injected store (single write path).
    expect(store.get().managementRooms).toEqual(["!dm:server"]);
  });

  it("space mode: adoption is gated off while the space ensure owns the management room", async () => {
    const fx = makeFixtures({ managementRoomAdoptionAllowed: () => false });
    await fx.makeRouter().handleIncoming(makeMsg({ content: "hi" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fx.roomOps.setRoomName).not.toHaveBeenCalled();
    expect(fx.store.get().managementRooms).toEqual([]);
    // Gating adoption must not block the message itself.
    expect(fx.rpc.prompt).toHaveBeenCalledWith("hi");
  });

  it("space mode: degraded fallback (gate back on) restores adoption", async () => {
    let allowed = false;
    const fx = makeFixtures({ managementRoomAdoptionAllowed: () => allowed });
    const router = fx.makeRouter();
    await router.handleIncoming(makeMsg({ content: "hi" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fx.roomOps.setRoomName).not.toHaveBeenCalled();
    // Space ensure failed this run → the legacy DM adoption takes over.
    allowed = true;
    await router.handleIncoming(makeMsg({ content: "hello" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fx.roomOps.setRoomName).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("项目管理")
    );
    expect(fx.store.get().managementRooms).toEqual(["!dm:server"]);
  });

  it("does not brand a project room (2-person room with a mapping)", async () => {
    (projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ chatId: "!projroom:server", content: "hello" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(roomOps.setRoomName).not.toHaveBeenCalled();
  });

  it("in single-project mode /pmctl reports it is unavailable", async () => {
    (projectManager as { isMultiProject: boolean }).isMultiProject = false;
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/pmctl list" }));
    expect(replies.at(-1)!.text).toContain("单工程模式");
  });

  it("in single-project mode every room uses the default rpc (no branding)", async () => {
    (projectManager as { isMultiProject: boolean }).isMultiProject = false;
    (projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "hello" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(roomOps.setRoomName).not.toHaveBeenCalled();
    expect(rpc.prompt).toHaveBeenCalledWith("hello");
  });

  it("a trusted user can toggle multi-project mode via /multiproject (restart effect)", async () => {
    (projectManager as { isMultiProject: boolean }).isMultiProject = true;
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/multiproject off" }));
    expect(store.get().multiProject).toBe(false);
    expect(replies.at(-1)!.text).toContain("重启生效");
  });

  it("agent turn_start triggers a typing indicator for the prompting room", async () => {
    const router = makeRouter();
    // A prompt binds the room to the default rpc; the typing follows that binding.
    await router.handleIncoming(makeMsg({ content: "hi" }));
    router.handleEvent({ type: "turn_start" }, rpc);
    await new Promise((r) => setTimeout(r, 0));
    expect(sendTyping).toHaveBeenCalledWith("!dm:server", "matrix");
  });

  it("a project-room prompt cannot misroute a DM reply (per-process bindings)", async () => {
    const projectRpc = { prompt: vi.fn().mockResolvedValue(undefined) } as unknown as PiRpc;
    (projectManager.getRpcForRoom as ReturnType<typeof vi.fn>).mockImplementation(
      async (roomId: string) => (roomId === "!proj:server" ? projectRpc : rpc)
    );
    (projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!proj:server"
    );
    const router = makeRouter();

    // A prompts in the DM, then B prompts in a project room.
    await router.handleIncoming(makeMsg({ content: "hi from A" }));
    await router.handleIncoming(makeMsg({ chatId: "!proj:server", content: "hi from B" }));

    // A's turn completes — its reply MUST go to A despite B's prompt in between.
    router.handleEvent({ type: "turn_end", message: textMessage("reply to A") }, rpc);
    await new Promise((r) => setTimeout(r, 0));
    expect(replies.at(-1)).toMatchObject({ chatId: "!dm:server", transport: "matrix", text: "reply to A" });

    // B's own turn completes — pinned to the project room.
    router.handleEvent({ type: "turn_end", message: textMessage("reply to B") }, projectRpc);
    await new Promise((r) => setTimeout(r, 0));
    expect(replies.at(-1)).toMatchObject({ chatId: "!proj:server", text: "reply to B" });
  });

  it("a second DM prompt retargets the shared default process (protocol limit, documented)", async () => {
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "hi from A" }));
    await router.handleIncoming(
      makeMsg({ chatId: "!carol:server", userId: "@carol:server", username: "carol", content: "hi from carol" })
    );
    // pi's RPC carries no chat concept: one shared process serves both DMs,
    // so the binding follows the most recent prompter. (Per-DM processes
    // would fix this at ~300MB each — deliberately out of scope, spec #3.)
    router.handleEvent({ type: "turn_end", message: textMessage("late reply") }, rpc);
    await new Promise((r) => setTimeout(r, 0));
    expect(replies.at(-1)).toMatchObject({ chatId: "!carol:server", text: "late reply" });
  });

  it("a completed conversational turn releases the default binding; project bindings stay pinned", async () => {
    const projectRpc = { prompt: vi.fn().mockResolvedValue(undefined) } as unknown as PiRpc;
    (projectManager.getRpcForRoom as ReturnType<typeof vi.fn>).mockImplementation(
      async (roomId: string) => (roomId === "!proj:server" ? projectRpc : rpc)
    );
    (projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!proj:server"
    );
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "hi" }));
    await router.handleIncoming(makeMsg({ chatId: "!proj:server", content: "hello" }));

    router.handleEvent({ type: "turn_end", message: textMessage("done") }, rpc);
    await new Promise((r) => setTimeout(r, 0));
    const repliesAfterDm = replies.length;
    // Late default-rpc event: binding released — nothing replies anywhere.
    router.handleEvent({ type: "extension_error", error: "boom" }, rpc);
    await new Promise((r) => setTimeout(r, 0));
    expect(replies.length).toBe(repliesAfterDm);

    // Project binding survives its own completed turn (pinned parity).
    router.handleEvent({ type: "turn_end", message: textMessage("proj done") }, projectRpc);
    router.handleEvent({ type: "extension_error", error: "late boom" }, projectRpc);
    await new Promise((r) => setTimeout(r, 0));
    expect(replies.at(-1)).toMatchObject({ chatId: "!proj:server", text: "⚠️ 扩展错误 (unknown): late boom" });
  });

  it("muting agent logging (log level) does not affect reply routing", async () => {
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "hi" }));
    logger.setLogLevel("error"); // all [agent] replay logs go silent
    try {
      router.handleEvent({ type: "turn_end", message: textMessage("still routed") }, rpc);
      await new Promise((r) => setTimeout(r, 0));
      expect(replies.at(-1)).toMatchObject({ chatId: "!dm:server", text: "still routed" });
    } finally {
      logger.setLogLevel("info");
    }
  });

  it("room-creation failure surfaces the thrown message (no null-branch)", async () => {
    store.update({ managementRooms: ["!dm:server"] });
    roomOps.createProjectRoom.mockRejectedValue(new Error("Matrix 未连接"));
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/pmctl new myapp" }));
    expect(replies.at(-1)!.text).toContain("创建项目失败");
    expect(replies.at(-1)!.text).toContain("Matrix 未连接");
    expect(projectManager.registerProject).not.toHaveBeenCalled();
  });

  it("owner-promotion failure warns but the project is still registered", async () => {
    store.update({ managementRooms: ["!dm:server"] });
    roomOps.setUserPowerLevel.mockRejectedValue(new Error("power level too low"));
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/pmctl new myapp" }));
    expect(projectManager.registerProject).toHaveBeenCalledWith("!newproj:server", expect.any(String), "myapp");
    expect(replies.some((r) => r.text.includes("创建完成"))).toBe(true);
    expect(replies.some((r) => r.text.includes("设为管理员失败"))).toBe(true);
  });

  it("room-rename failure is surfaced while the project rename stands", async () => {
    store.update({ managementRooms: ["!dm:server"] });
    (projectManager.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);
    roomOps.setRoomName.mockRejectedValue(new Error("没有权限"));
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/pmctl rename myapp newname" }));
    expect(projectManager.renameProject).toHaveBeenCalledWith("!proj:server", "newname");
    expect(replies.at(-1)!.text).toContain("房间改名失败");
    expect(replies.at(-1)!.text).toContain("没有权限");
  });

  it("without roomOps /pmctl reports Matrix-only availability", async () => {
    store.update({ managementRooms: ["!dm:server"] });
    const sendReply = async (chatId: string, transport: string, text: string) => {
      replies.push({ chatId, transport, text });
    };
    const pmctlNoOps = new PmctlController({ projectManager, store });
    const router = createMessageRouter({ projectManager, auth, sendReply, sendTyping, store, pmctl: pmctlNoOps });
    await router.handleIncoming(makeMsg({ content: "/pmctl list" }));
    expect(replies.at(-1)!.text).toContain("仅 Matrix 部署支持");
  });
});

describe("message-router authorization pipeline (real ChallengeAuth)", () => {
  let rpc: PiRpc;
  let auth: ChallengeAuth;
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let codeBox: { current: string | null };
  let makeRouter: () => ReturnType<typeof createMessageRouter>;

  beforeEach(() => {
    const fx = makeFixtures({ multiProject: false });
    rpc = fx.rpc;
    auth = fx.auth;
    replies = fx.replies;
    codeBox = fx.codeBox;
    makeRouter = fx.makeRouter;
  });

  const eveMsg = (content: string, overrides: Partial<ExternalMessage> = {}): ExternalMessage =>
    makeMsg({ userId: "@eve:server", username: "eve", content, ...overrides });

  it("group /enable in an unenabled room works end-to-end (trusted user, mentions mode)", async () => {
    const router = makeRouter();
    const room = "!group:server";
    // Before enabling: members' messages are dropped silently (existing behavior).
    await router.handleIncoming(
      makeMsg({ chatId: room, isGroupChat: true, wasMentioned: true, userId: "@eve:server", username: "eve", content: "@bot hi" })
    );
    expect(rpc.prompt).not.toHaveBeenCalled();

    // Trusted user enables the room from inside it — this ran BEFORE the
    // authorization gate, so the room was never authorized until now.
    await router.handleIncoming(makeMsg({ chatId: room, isGroupChat: true, content: "/enable mentions" }));
    expect(replies.at(-1)!.text).toContain("本房间已启用");
    expect(replies.at(-1)!.text).toContain("mentions");

    // After enabling (mentions mode): a mentioned member is served...
    await router.handleIncoming(
      makeMsg({ chatId: room, isGroupChat: true, wasMentioned: true, userId: "@eve:server", username: "eve", content: "@bot what is up" })
    );
    expect(rpc.prompt).toHaveBeenCalledWith("@bot what is up");
    // ...a non-mention still is not.
    (rpc.prompt as ReturnType<typeof vi.fn>).mockClear();
    await router.handleIncoming(
      makeMsg({ chatId: room, isGroupChat: true, wasMentioned: false, userId: "@eve:server", username: "eve", content: "no mention" })
    );
    expect(rpc.prompt).not.toHaveBeenCalled();
  });

  it("group /enable all is admin-only: a trusted non-admin is rejected, the admin succeeds", async () => {
    const router = makeRouter();
    const room = "!group:server";
    await router.handleIncoming(
      makeMsg({ chatId: room, isGroupChat: true, userId: "@carol:server", username: "carol", content: "/enable all" })
    );
    expect(replies.at(-1)!.text).toContain("仅管理员");
    expect(auth.isChannelEnabled(room)).toBe(false);

    await router.handleIncoming(makeMsg({ chatId: room, isGroupChat: true, content: "/enable all" }));
    expect(replies.at(-1)!.text).toContain("本房间已启用");
    expect(auth.isChannelEnabled(room)).toBe(true);
    // mode "all": even an untrusted member is now served.
    await router.handleIncoming(
      makeMsg({ chatId: room, isGroupChat: true, userId: "@eve:server", username: "eve", content: "hello room" })
    );
    expect(rpc.prompt).toHaveBeenCalledWith("hello room");
  });

  it("an untrusted member cannot enable a group room (silent drop)", async () => {
    const router = makeRouter();
    const room = "!group:server";
    await router.handleIncoming(
      makeMsg({ chatId: room, isGroupChat: true, userId: "@eve:server", username: "eve", content: "/enable all" })
    );
    expect(auth.isChannelEnabled(room)).toBe(false);
    expect(rpc.prompt).not.toHaveBeenCalled();
    expect(replies.length).toBe(0);
  });

  it("unknown DM user gets a challenge; a repeat message does not re-issue the code", async () => {
    const router = makeRouter();
    // First message: challenge issued, nothing reaches pi.
    await router.handleIncoming(eveMsg("hello"));
    expect(rpc.prompt).not.toHaveBeenCalled();
    expect(codeBox.current).not.toBeNull();
    expect(replies.length).toBe(1); // the challenge prompt

    // While the challenge is active, a repeat message neither re-issues a
    // code nor sends a second challenge reply.
    codeBox.current = null;
    await router.handleIncoming(eveMsg("hello again"));
    expect(codeBox.current).toBeNull();
    expect(replies.length).toBe(1);
  });

  it("the correct challenge code authenticates and unlocks prompting", async () => {
    const router = makeRouter();
    await router.handleIncoming(eveMsg("hello"));
    expect(codeBox.current).not.toBeNull();

    await router.handleIncoming(eveMsg(codeBox.current!));
    expect(replies.at(-1)!.text).toContain("Authenticated");

    // Now trusted: the next plain message reaches pi.
    await router.handleIncoming(eveMsg("hi pi"));
    expect(rpc.prompt).toHaveBeenCalledWith("hi pi");
  });

  it("three wrong challenge codes block the user (silent afterwards)", async () => {
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ userId: "@mallory:server", username: "mallory", content: "hello" }));
    const code = codeBox.current!;
    const wrongCode = code === "000000" ? "111111" : "000000";
    const mallory = (content: string) => makeMsg({ userId: "@mallory:server", username: "mallory", content });

    for (let i = 0; i < 3; i++) {
      await router.handleIncoming(mallory(wrongCode));
    }
    expect(replies.at(-1)!.text).toContain("Blocked");

    // Blocked: no challenge re-issue, no reply, nothing reaches pi.
    const repliesBefore = replies.length;
    await router.handleIncoming(mallory("let me in"));
    expect(replies.length).toBe(repliesBefore);
    expect(rpc.prompt).not.toHaveBeenCalled();
  });

  it("DM /help shows the bridge/pi help (not hijacked by the auth engine)", async () => {
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/help" }));
    const help = replies.find((r) => r.text.includes("/new"));
    expect(help).toBeDefined();
    expect(help!.text).toContain("Bridge 管理命令");
    expect(rpc.prompt).not.toHaveBeenCalled();
  });

  it("an unknown user's DM /help initiates a challenge instead (auth runs first)", async () => {
    const router = makeRouter();
    await router.handleIncoming(eveMsg("/help"));
    expect(rpc.prompt).not.toHaveBeenCalled();
    expect(codeBox.current).not.toBeNull();
    expect(replies.at(-1)!.text).toContain("6-digit");
  });
});

describe("space invite on trust transition (spec #16 ticket 4)", () => {
  const eveMsg = (content: string): ExternalMessage =>
    makeMsg({ userId: "@eve:server", username: "eve", content });

  async function passChallenge(fx: ReturnType<typeof makeFixtures>): Promise<void> {
    const router = fx.makeRouter();
    await router.handleIncoming(eveMsg("hello"));
    expect(fx.codeBox.current).not.toBeNull();
    await router.handleIncoming(eveMsg(fx.codeBox.current!));
  }

  it("a passed challenge invites the new trusted user into the space once", async () => {
    const fx = makeFixtures({ space: { enabled: true, roomId: "!space:server" } });
    await passChallenge(fx);
    expect(fx.roomOps.inviteUser).toHaveBeenCalledWith("!space:server", "@eve:server");
    expect(fx.roomOps.inviteUser).toHaveBeenCalledTimes(1);
    expect(fx.store.get().space?.invitedUsers).toEqual(["matrix:@eve:server"]);
  });

  it("no invite without the space (off entirely, or degraded before creation)", async () => {
    for (const space of [undefined, { enabled: true }, { enabled: false, roomId: "!space:server" }]) {
      const fx = makeFixtures({ space });
      await passChallenge(fx);
      expect(fx.roomOps.inviteUser).not.toHaveBeenCalled();
    }
  });

  it("an already-invited user (decliner) is never re-invited, but still authenticates", async () => {
    const fx = makeFixtures({ space: { enabled: true, roomId: "!space:server", invitedUsers: ["matrix:@eve:server"] } });
    await passChallenge(fx);
    expect(fx.roomOps.inviteUser).not.toHaveBeenCalled();
    expect(fx.replies.some((r) => r.text.includes("Authenticated"))).toBe(true);
  });

  it("an invite failure is non-fatal: authentication still succeeds", async () => {
    const fx = makeFixtures({ space: { enabled: true, roomId: "!space:server" } });
    (fx.roomOps.inviteUser as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("M_LIMIT_EXCEEDED"));
    await passChallenge(fx);
    expect(fx.roomOps.inviteUser).toHaveBeenCalledTimes(1);
    expect(fx.replies.some((r) => r.text.includes("Authenticated"))).toBe(true);
    // Not recorded — the startup ensure self-heals it on the next run.
    expect(fx.store.get().space?.invitedUsers ?? []).not.toContain("matrix:@eve:server");
  });
});

describe("multi-project log tagging (spec #34 票3)", () => {
  let lines: string[];
  let fx: ReturnType<typeof makeFixtures>;

  const capture = () => {
    lines = [];
    const push = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(push);
    vi.spyOn(console, "error").mockImplementation(push);
  };

  beforeEach(() => {
    capture();
    fx = makeFixtures();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const projectRpc = () => ({ label: "ai-api", prompt: vi.fn().mockResolvedValue(undefined) }) as unknown as PiRpc;

  it("📥 line for a mapped room carries the project label", async () => {
    (fx.projectManager.labelForRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => (roomId === "!proj:server" ? "ai-api" : undefined)
    );
    const router = fx.makeRouter();
    await router.handleIncoming(makeMsg({ chatId: "!proj:server", content: "do work" }));
    const inbound = lines.find((l) => l.includes("📥"));
    expect(inbound).toContain("[INFO] [ai-api]");
  });

  it("📥 line for an unmapped room (DM) carries no label", async () => {
    const router = fx.makeRouter();
    await router.handleIncoming(makeMsg({ content: "hello" }));
    const inbound = lines.find((l) => l.includes("📥"));
    expect(inbound).toMatch(/\[INFO\] 📥/);
  });

  it("[agent] event lines carry the emitting rpc's label", async () => {
    const prj = projectRpc();
    (fx.projectManager.getRpcForRoom as ReturnType<typeof vi.fn>).mockImplementation(
      async (roomId: string) => (roomId === "!proj:server" ? prj : fx.rpc)
    );
    (fx.projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => roomId === "!proj:server"
    );
    const router = fx.makeRouter();
    await router.handleIncoming(makeMsg({ chatId: "!proj:server", content: "go" }));
    router.handleEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } }, prj);
    const toolLine = lines.find((l) => l.includes("🔧 工具调用"));
    expect(toolLine).toContain("[INFO] [ai-api]");
    // The reply line rides the same label:
    router.handleEvent({ type: "turn_end", message: textMessage("done") }, prj);
    const replyLine = lines.find((l) => l.includes("[agent] 回复"));
    expect(replyLine).toContain("[ai-api]");
  });

  it("default-rpc events log untagged", async () => {
    const router = fx.makeRouter();
    await router.handleIncoming(makeMsg({ content: "hi" }));
    router.handleEvent({ type: "tool_execution_start", toolName: "bash", args: {} }, fx.rpc);
    const toolLine = lines.find((l) => l.includes("🔧 工具调用"));
    expect(toolLine).toMatch(/\[INFO\] \[agent\]/);
    expect(toolLine).not.toMatch(/ai-api/);
  });

  it("auth lines stay untagged even inside a project room", async () => {
    (fx.projectManager.labelForRoom as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string) => (roomId === "!proj:server" ? "ai-api" : undefined)
    );
    fx.auth.loadFromConfig({ trustedUsers: ["matrix:@barry:server"], adminUserId: "matrix:@barry:server", channels: {} });
    const router = fx.makeRouter();
    await router.handleIncoming(makeMsg({ chatId: "!proj:server", isGroupChat: true, content: "/enable all" }));
    const authLine = lines.find((l) => l.includes("[auth]"));
    expect(authLine).toBeDefined();
    expect(authLine).not.toContain("ai-api");
  });
});
