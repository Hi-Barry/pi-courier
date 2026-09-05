import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { handleAdminCommand } from "../src/auth/admin-commands";
import { logger } from "../src/logger";
import { buildTurnReply } from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createMessageRouter } from "../src/rpc/message-router";
import { captureConsole } from "./helpers";
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
    promptQueued: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({ model: { id: "m" }, isStreaming: false, pendingMessageCount: 0 }),
    newSession: vi.fn().mockResolvedValue({ cancelled: false }),
    onEvent: vi.fn(),
    // Small-command batch (issue #56 票5) — defaults overridden per test.
    getLastAssistantText: vi.fn().mockResolvedValue(null),
    cycleModel: vi.fn().mockResolvedValue(null),
    cycleThinkingLevel: vi.fn().mockResolvedValue(null),
    setAutoCompaction: vi.fn().mockResolvedValue(undefined),
    setAutoRetry: vi.fn().mockResolvedValue(undefined),
    switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    sessionDir: undefined as string | undefined,
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
    getPowerLevels: vi.fn().mockResolvedValue(undefined),
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

  it("trusted-user elevation failure warns but the project is still registered (issue #42)", async () => {
    // The fixtures store has no trustedUsers; seed one so the unified
    // elevation path runs — its failure must not fail the project.
    store.update({ managementRooms: ["!dm:server"], auth: { trustedUsers: ["matrix:@barry:server"] } });
    roomOps.setUserPowerLevel.mockRejectedValue(new Error("power level too low"));
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/pmctl new myapp" }));
    expect(projectManager.registerProject).toHaveBeenCalledWith("!newproj:server", expect.any(String), "myapp");
    expect(replies.some((r) => r.text.includes("创建完成"))).toBe(true);
    expect(replies.some((r) => r.text.includes("补权失败"))).toBe(true);
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
    lines = captureConsole();
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

/**
 * Management-room reachability on trust transition (issue #43 票2): a passed
 * challenge must invite the new trusted user into the management room (the
 * /pmctl home) as well as the space. The ConfigStore here is isolated to a
 * temp home (same vi.doMock("node:os") pattern as tests/space.test.ts) —
 * persistAuth goes through store.update(), which must never touch the real
 * ~/.pi/pi-courier.json.
 */
describe("management room invite on trust transition (issue #43 票2)", () => {
  let tmpDir: string;
  let IsoConfigStore: typeof ConfigStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-router-mgmt-"));
    vi.resetModules();
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpDir };
    });
    const config = await import("../src/config");
    IsoConfigStore = config.ConfigStore;
  });

  afterEach(() => {
    vi.doUnmock("os");
    vi.doUnmock("node:os");
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const eveMsg = (content: string): ExternalMessage =>
    makeMsg({ userId: "@eve:server", username: "eve", content });

  /** Fixtures mirroring makeFixtures, but on the tmp-dir-isolated store class. */
  function makeIsoFixtures(opts: { space?: { enabled?: boolean; roomId?: string; invitedUsers?: string[] } } = {}) {
    const codeBox: { current: string | null } = { current: null };
    const replies: Array<{ chatId: string; transport: string; text: string }> = [];
    const sendReply = async (chatId: string, transport: string, text: string) => {
      replies.push({ chatId, transport, text });
    };
    const rpc = {
      prompt: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
    } as unknown as PiRpc;
    const projectManager = {
      getRpcForRoom: vi.fn().mockReturnValue(rpc),
      isProjectRoom: vi.fn().mockReturnValue(false),
      labelForRoom: vi.fn().mockReturnValue(undefined),
      isMultiProject: true,
      registerProject: vi.fn(),
      listProjects: vi.fn().mockReturnValue([] as Array<[string, { name?: string; workdir: string }]>),
      renameProject: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as ProjectManager;
    const store = new IsoConfigStore({
      managementRooms: [],
      projects: {},
      multiProject: true,
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
      channels: {},
    });
    const sendTyping = vi.fn(async (_chatId: string, _transport: string): Promise<void> => {});
    const roomOps = {
      createRoom: vi.fn().mockResolvedValue("!newroom:server"),
      createProjectRoom: vi.fn().mockResolvedValue("!newproj:server"),
      createSpace: vi.fn().mockResolvedValue("!space:server"),
      addRoomToSpace: vi.fn().mockResolvedValue(undefined),
      removeRoomFromSpace: vi.fn().mockResolvedValue(undefined),
      inviteUser: vi.fn().mockResolvedValue(undefined),
      setRoomName: vi.fn().mockResolvedValue(undefined),
      setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
      getPowerLevels: vi.fn().mockResolvedValue({ users: {} }),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      getBotUserId: vi.fn().mockReturnValue("@bot:server"),
      encryptionAvailable: true,
    };
    const pmctl = new PmctlController({ projectManager, roomOps, store });
    const makeRouter = () =>
      createMessageRouter({ projectManager, auth, sendReply, sendTyping, roomOps, store, pmctl });
    return { codeBox, replies, projectManager, auth, roomOps, store, makeRouter };
  }

  async function passChallenge(fx: ReturnType<typeof makeIsoFixtures>): Promise<void> {
    const router = fx.makeRouter();
    await router.handleIncoming(eveMsg("hello"));
    if (!fx.codeBox.current) throw new Error("no challenge was issued");
    await router.handleIncoming(eveMsg(fx.codeBox.current));
  }

  it("a passed challenge emits persistAuth, spaceInvite AND managementRoomInvite (space mode)", async () => {
    const fx = makeIsoFixtures({ space: { enabled: true, roomId: "!space:server" } });
    const router = fx.makeRouter();
    await router.handleIncoming(eveMsg("hello")); // issues the challenge
    // The effects are produced by the admin command layer; nothing consumed yet.
    const result = handleAdminCommand(fx.auth, {
      text: fx.codeBox.current!,
      userId: "@eve:server",
      transport: "matrix",
    });
    expect(result.handled).toBe(true);
    expect(result.effects).toEqual([
      { kind: "persistAuth" },
      { kind: "spaceInvite", userId: "@eve:server", transport: "matrix" },
      { kind: "managementRoomInvite", userId: "@eve:server", transport: "matrix" },
    ]);
  });

  it("effect consumption invites the user into BOTH the space and the management room", async () => {
    const fx = makeIsoFixtures({ space: { enabled: true, roomId: "!space:server" } });
    fx.store.update({ managementRooms: ["!mgmt:server"] });
    await passChallenge(fx);
    expect(fx.roomOps.inviteUser).toHaveBeenCalledWith("!space:server", "@eve:server");
    expect(fx.roomOps.inviteUser).toHaveBeenCalledWith("!mgmt:server", "@eve:server");
    expect(fx.roomOps.inviteUser).toHaveBeenCalledTimes(2);
    // Fire-once bookkeeping for both rooms, in the namespaced form.
    expect(fx.store.get().space?.invitedUsers).toEqual(["matrix:@eve:server"]);
    expect(fx.store.get().space?.managementInvitedUsers).toEqual(["matrix:@eve:server"]);
    // The authentication itself is untouched by the invite side effects.
    expect(fx.replies.some((r) => r.text.includes("Authenticated"))).toBe(true);
  });

  it("no roomOps (degraded): consuming the effects neither throws nor invites anyone", async () => {
    const fx = makeIsoFixtures({ space: { enabled: true, roomId: "!space:server" } });
    const pmctlNoOps = new PmctlController({ projectManager: fx.projectManager, store: fx.store });
    const router = createMessageRouter({
      projectManager: fx.projectManager,
      auth: fx.auth,
      sendReply: async (chatId, transport, text) => {
        fx.replies.push({ chatId, transport, text });
      },
      sendTyping: vi.fn(async () => {}),
      store: fx.store,
      pmctl: pmctlNoOps,
    });
    await router.handleIncoming(eveMsg("hello"));
    await router.handleIncoming(eveMsg(fx.codeBox.current!));
    expect(fx.replies.some((r) => r.text.includes("Authenticated"))).toBe(true);
    expect(fx.roomOps.inviteUser).not.toHaveBeenCalled();
    // persistAuth still applied — trust survives without Matrix room ops.
    expect(fx.store.get().auth?.trustedUsers).toContain("matrix:@eve:server");
  });
});

/**
 * Send-semantics command family (issue #53, spec #51 ticket 2): plain text is
 * always a steer-carrying prompt (asserted at the PiRpc level in
 * pi-rpc-send.test.ts — the router only sees PiRpc.prompt), /queue routes to
 * the followUp queue or renders the mirror, /interrupt composes
 * abort → waitForIdle → prompt while streaming, and /stop //interrupt replies
 * surface the surviving-queue limitation (abort preserves upstream queues).
 */
describe("send semantics command family (issue #53 ticket 2)", () => {
  let rpc: PiRpc;
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let makeRouter: () => ReturnType<typeof createMessageRouter>;

  beforeEach(() => {
    // Single-project mode keeps the reply stream free of branding noise.
    const fx = makeFixtures({ multiProject: false });
    rpc = fx.rpc;
    replies = fx.replies;
    makeRouter = fx.makeRouter;
  });

  const getState = (overrides: { isStreaming?: boolean; pendingMessageCount?: number }) => {
    (rpc.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      model: { id: "m" },
      isStreaming: false,
      pendingMessageCount: 0,
      ...overrides,
    });
  };

  it("/queue <text> goes to promptQueued (followUp) and never to prompt", async () => {
    await makeRouter().handleIncoming(makeMsg({ content: "/queue run the tests" }));
    expect(rpc.promptQueued).toHaveBeenCalledWith("run the tests");
    expect(rpc.prompt).not.toHaveBeenCalled();
    expect(replies.at(-1)!.text).toContain("已排队");
  });

  it("/queue without args reports an empty queue when nothing was seen", async () => {
    await makeRouter().handleIncoming(makeMsg({ content: "/queue" }));
    expect(rpc.promptQueued).not.toHaveBeenCalled();
    expect(replies.at(-1)!.text).toContain("队列为空");
  });

  it("/queue empty mirror still cross-checks upstream pendingMessageCount (missed events)", async () => {
    // No queue_update ever seen — a bare "队列为空" would hide missed events.
    getState({ isStreaming: false, pendingMessageCount: 2 });
    await makeRouter().handleIncoming(makeMsg({ content: "/queue" }));
    expect(replies.at(-1)!.text).toContain("上游报告仍有 2 条待处理消息");
  });

  it("/queue without args renders the queue_update mirror and cross-checks pendingMessageCount", async () => {
    const router = makeRouter();
    router.handleEvent(
      { type: "queue_update", steering: ["inject this"], followUp: ["then that"] },
      rpc
    );
    getState({ isStreaming: true, pendingMessageCount: 3 }); // upstream disagrees with the mirror (2)
    await router.handleIncoming(makeMsg({ content: "/queue" }));
    const text = replies.at(-1)!.text;
    expect(text).toContain("steering(1 条");
    expect(text).toContain("followUp(1 条");
    expect(text).toContain("- inject this");
    expect(text).toContain("- then that");
    expect(text).toContain("上游报告待处理 3 条");
  });

  it("/interrupt on an idle session degrades to a plain prompt (no abort)", async () => {
    getState({ isStreaming: false, pendingMessageCount: 0 });
    await makeRouter().handleIncoming(makeMsg({ content: "/interrupt fix the lint" }));
    expect(rpc.abort).not.toHaveBeenCalled();
    expect(rpc.waitForIdle).not.toHaveBeenCalled();
    expect(rpc.prompt).toHaveBeenCalledWith("fix the lint");
    expect(replies.at(-1)!.text).toContain("没有运行中的任务");
    expect(replies.at(-1)!.text).not.toContain("⚠️");
  });

  it("/interrupt while streaming aborts, waits for idle, then prompts — and warns about the surviving queue", async () => {
    getState({ isStreaming: true, pendingMessageCount: 1 });
    const router = makeRouter();
    router.handleEvent({ type: "queue_update", steering: ["old task"], followUp: [] }, rpc);
    await router.handleIncoming(makeMsg({ content: "/interrupt new order" }));
    expect(rpc.abort).toHaveBeenCalledTimes(1);
    expect(rpc.waitForIdle).toHaveBeenCalledTimes(1);
    expect(rpc.prompt).toHaveBeenCalledWith("new order");
    // The sequence is strict: abort → waitForIdle → prompt.
    const order = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(order(rpc.abort)).toBeLessThan(order(rpc.waitForIdle));
    expect(order(rpc.waitForIdle)).toBeLessThan(order(rpc.prompt));
    const text = replies.at(-1)!.text;
    expect(text).toContain("已打断,新指令已发出");
    expect(text).toContain("⚠️ 队列中仍有 1 条消息将在下一轮生效");
    expect(text).toContain("- old task");
  });

  it("/stop appends the queue warning when the upstream queues survive the abort", async () => {
    const router = makeRouter();
    router.handleEvent({ type: "queue_update", steering: ["queued A"], followUp: ["queued B"] }, rpc);
    await router.handleIncoming(makeMsg({ content: "/stop" }));
    expect(rpc.abort).toHaveBeenCalledTimes(1);
    const text = replies.at(-1)!.text;
    expect(text).toContain("已停止所有任务");
    expect(text).toContain("⚠️ 队列中仍有 2 条消息将在下一轮生效");
    expect(text).toContain("- queued A");
    expect(text).toContain("- queued B");
  });

  it("/stop with an empty queue carries no warning", async () => {
    await makeRouter().handleIncoming(makeMsg({ content: "/stop" }));
    const text = replies.at(-1)!.text;
    expect(text).toContain("已停止所有任务");
    expect(text).not.toContain("⚠️");
  });

  it("/help lists the new send-semantics commands", async () => {
    await makeRouter().handleIncoming(makeMsg({ content: "/help" }));
    const help = replies.at(-1)!.text;
    expect(help).toContain("/queue");
    expect(help).toContain("/interrupt");
    expect(help).toContain("/stop");
  });
});

/**
 * Small-command batch + reply quotes (issue #56, spec #51 ticket 5): the
 * pure-mapping commands (/last, /cyclemodel, /cyclethinking, /autocompact,
 * /autoretry, /sessions, /switch) and the quote prefix assembled onto plain
 * prompts when the transport resolved a Matrix reply reference.
 */
describe("small command batch + reply quotes (issue #56 ticket 5)", () => {
  let rpc: PiRpc;
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let makeRouter: () => ReturnType<typeof createMessageRouter>;

  beforeEach(() => {
    const fx = makeFixtures({ multiProject: false });
    rpc = fx.rpc;
    replies = fx.replies;
    makeRouter = fx.makeRouter;
  });

  const getState = (overrides: { isStreaming?: boolean; autoCompactionEnabled?: boolean }) => {
    (rpc.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      model: { id: "m" },
      isStreaming: false,
      pendingMessageCount: 0,
      autoCompactionEnabled: true,
      ...overrides,
    });
  };

  // --- /last -----------------------------------------------------------------
  it("/last replays the agent's most recent reply", async () => {
    (rpc.getLastAssistantText as ReturnType<typeof vi.fn>).mockResolvedValue("the previous answer");
    await makeRouter().handleIncoming(makeMsg({ content: "/last" }));
    expect(rpc.getLastAssistantText).toHaveBeenCalledTimes(1);
    expect(replies.at(-1)!.text).toContain("the previous answer");
    expect(rpc.prompt).not.toHaveBeenCalled();
  });

  it("/last reports when there is no reply yet", async () => {
    (rpc.getLastAssistantText as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await makeRouter().handleIncoming(makeMsg({ content: "/last" }));
    expect(replies.at(-1)!.text).toContain("没有可复述");
  });

  // --- /cyclemodel / /cyclethinking -------------------------------------------
  it("/cyclemodel reports the cycled provider/model", async () => {
    (rpc.cycleModel as ReturnType<typeof vi.fn>).mockResolvedValue({
      model: { provider: "anthropic", id: "claude-next" },
      thinkingLevel: "high",
      isScoped: false,
    });
    await makeRouter().handleIncoming(makeMsg({ content: "/cyclemodel" }));
    expect(rpc.cycleModel).toHaveBeenCalledTimes(1);
    expect(replies.at(-1)!.text).toContain("anthropic/claude-next");
  });

  it("/cyclemodel reports when there is nothing to cycle", async () => {
    (rpc.cycleModel as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await makeRouter().handleIncoming(makeMsg({ content: "/cyclemodel" }));
    expect(replies.at(-1)!.text).toContain("没有可轮换");
  });

  it("/cyclethinking reports the new level", async () => {
    (rpc.cycleThinkingLevel as ReturnType<typeof vi.fn>).mockResolvedValue({ level: "medium" });
    await makeRouter().handleIncoming(makeMsg({ content: "/cyclethinking" }));
    expect(rpc.cycleThinkingLevel).toHaveBeenCalledTimes(1);
    expect(replies.at(-1)!.text).toContain("medium");
  });

  // --- /autocompact / /autoretry -----------------------------------------------
  it("/autocompact on|off maps to setAutoCompaction, no-args shows state and usage", async () => {
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/autocompact on" }));
    expect(rpc.setAutoCompaction).toHaveBeenCalledWith(true);
    await router.handleIncoming(makeMsg({ content: "/autocompact off" }));
    expect(rpc.setAutoCompaction).toHaveBeenCalledWith(false);
    expect(replies.at(-1)!.text).toContain("已关闭");

    getState({ autoCompactionEnabled: false });
    await router.handleIncoming(makeMsg({ content: "/autocompact" }));
    expect(rpc.setAutoCompaction).toHaveBeenCalledTimes(2); // unchanged by the query
    expect(replies.at(-1)!.text).toContain("当前自动压缩: 关");
    expect(replies.at(-1)!.text).toContain("实例级生效");
  });

  it("/autoretry on|off maps to setAutoRetry, no-args gives usage (upstream exposes no query)", async () => {
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/autoretry off" }));
    expect(rpc.setAutoRetry).toHaveBeenCalledWith(false);
    expect(replies.at(-1)!.text).toContain("已关闭");

    await router.handleIncoming(makeMsg({ content: "/autoretry" }));
    expect(rpc.setAutoRetry).toHaveBeenCalledTimes(1); // no-args never toggles
    expect(replies.at(-1)!.text).toContain("/autoretry on|off");
    expect(replies.at(-1)!.text).toContain("实例级生效");
  });

  // --- /sessions / /switch -------------------------------------------------------
  let sessionDir: string;
  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "pi-courier-sessions-"));
    // Three pi session files, deliberately non-chronological mtimes; the
    // newest carries a session_info display name (real jsonl header shape).
    writeFileSync(join(sessionDir, "old_1111.jsonl"), '{"type":"session","id":"1111"}\n');
    writeFileSync(
      join(sessionDir, "new_2222.jsonl"),
      '{"type":"session","id":"2222"}\n{"type":"session_info","id":"e1","parentId":null,"name":"named session"}\n'
    );
    writeFileSync(join(sessionDir, "mid_3333.jsonl"), '{"type":"session","id":"3333"}\n');
    const t = (file: string, sec: number) => utimesSync(join(sessionDir, file), sec * 1000, sec * 1000);
    t("old_1111.jsonl", 1_000_000);
    t("new_2222.jsonl", 3_000_000);
    t("mid_3333.jsonl", 2_000_000);
    (rpc as unknown as { sessionDir?: string }).sessionDir = sessionDir;
  });
  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("/sessions lists jsonl files newest-first with the parsed session name", async () => {
    await makeRouter().handleIncoming(makeMsg({ content: "/sessions" }));
    const text = replies.at(-1)!.text;
    const order = [text.indexOf("new_2222.jsonl"), text.indexOf("mid_3333.jsonl"), text.indexOf("old_1111.jsonl")];
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(text).toContain("named session");
    expect(text).toContain("/switch");
  });

  it("/sessions reports a missing session directory", async () => {
    (rpc as unknown as { sessionDir?: string }).sessionDir = join(sessionDir, "does-not-exist");
    await makeRouter().handleIncoming(makeMsg({ content: "/sessions" }));
    expect(replies.at(-1)!.text).toContain("找不到会话目录");
  });

  it("/switch rejects while streaming (asked to /stop first)", async () => {
    getState({ isStreaming: true });
    await makeRouter().handleIncoming(makeMsg({ content: "/switch 1" }));
    expect(replies.at(-1)!.text).toContain("/stop");
    expect(rpc.switchSession).not.toHaveBeenCalled();
  });

  it("/switch <n> switches to the nth newest session file", async () => {
    await makeRouter().handleIncoming(makeMsg({ content: "/switch 1" }));
    expect(rpc.switchSession).toHaveBeenCalledWith(join(sessionDir, "new_2222.jsonl"));
    expect(replies.at(-1)!.text).toContain("已切换会话");

    (rpc.switchSession as ReturnType<typeof vi.fn>).mockClear();
    await makeRouter().handleIncoming(makeMsg({ content: "/switch 3" }));
    expect(rpc.switchSession).toHaveBeenCalledWith(join(sessionDir, "old_1111.jsonl"));
  });

  it("/switch without args shows usage; an out-of-range index is rejected", async () => {
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/switch" }));
    expect(replies.at(-1)!.text).toContain("用法");
    expect(rpc.switchSession).not.toHaveBeenCalled();

    await router.handleIncoming(makeMsg({ content: "/switch 9" }));
    expect(replies.at(-1)!.text).toContain("超出范围");
  });

  // --- /help -------------------------------------------------------------------
  it("/help lists the new commands with the instance-level scope note", async () => {
    await makeRouter().handleIncoming(makeMsg({ content: "/help" }));
    const help = replies.at(-1)!.text;
    for (const cmd of ["/last", "/cyclemodel", "/cyclethinking", "/autocompact", "/autoretry", "/sessions", "/switch"]) {
      expect(help).toContain(cmd);
    }
    expect(help).toContain("实例级生效");
  });

  // --- Reply-quote prefix -----------------------------------------------------
  it("a resolved quote prefixes the prompt sent to pi (raw text stays for commands)", async () => {
    await makeRouter().handleIncoming(
      makeMsg({ content: "这个是什么意思", quoted: { username: "carol", excerpt: "被引用的旧消息" } })
    );
    expect(rpc.prompt).toHaveBeenCalledWith("「@carol: 被引用的旧消息」\n这个是什么意思");
  });

  it("without a quote the prompt is the raw text, unchanged", async () => {
    await makeRouter().handleIncoming(makeMsg({ content: "plain prompt" }));
    expect(rpc.prompt).toHaveBeenCalledWith("plain prompt");
  });
});

/**
 * Revoke demotion closed loop (issue #44 票3): revoking trust must strip the
 * admin power this instance once granted — every managed room, PL 0 — while
 * the powerElevatedUsers bookkeeping stays the sole authority and is cleared
 * only on full success. Same tmp-dir isolation as the 票2 block above:
 * persistAuth and the bookkeeping update go through store.update(), which
 * must never touch the real ~/.pi/pi-courier.json.
 */
describe("power demotion on revoke (issue #44 票3)", () => {
  let tmpDir: string;
  let IsoConfigStore: typeof ConfigStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-router-demote-"));
    vi.resetModules();
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpDir };
    });
    const config = await import("../src/config");
    IsoConfigStore = config.ConfigStore;
  });

  afterEach(() => {
    vi.doUnmock("os");
    vi.doUnmock("node:os");
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fixtures for an admin (barry) revoking eve: eve is trusted so the revoke
   *  succeeds, and the store is pre-booked via powerElevatedUsers. */
  function makeRevokeFixtures(
    opts: {
      space?: { enabled?: boolean; roomId?: string };
      managementRooms?: string[];
      projects?: Record<string, { name?: string; workdir: string }>;
      powerElevatedUsers?: string[];
    } = {}
  ) {
    const replies: Array<{ chatId: string; transport: string; text: string }> = [];
    const sendReply = async (chatId: string, transport: string, text: string) => {
      replies.push({ chatId, transport, text });
    };
    const rpc = {
      prompt: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
    } as unknown as PiRpc;
    const projectManager = {
      getRpcForRoom: vi.fn().mockReturnValue(rpc),
      isProjectRoom: vi.fn().mockReturnValue(false),
      labelForRoom: vi.fn().mockReturnValue(undefined),
      isMultiProject: true,
      registerProject: vi.fn(),
      listProjects: vi.fn().mockReturnValue([] as Array<[string, { name?: string; workdir: string }]>),
      renameProject: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as ProjectManager;
    const store = new IsoConfigStore({
      managementRooms: opts.managementRooms ?? [],
      projects: opts.projects ?? {},
      multiProject: true,
      ...(opts.space ? { space: opts.space } : {}),
      ...(opts.powerElevatedUsers ? { powerElevatedUsers: opts.powerElevatedUsers } : {}),
    });
    const auth = new ChallengeAuth(
      () => {},
      () => {}
    );
    auth.loadFromConfig({
      trustedUsers: ["matrix:@barry:server", "matrix:@carol:server", "matrix:@eve:server"],
      adminUserId: "matrix:@barry:server",
      channels: {},
    });
    const sendTyping = vi.fn(async (_chatId: string, _transport: string): Promise<void> => {});
    const roomOps = {
      createRoom: vi.fn().mockResolvedValue("!newroom:server"),
      createProjectRoom: vi.fn().mockResolvedValue("!newproj:server"),
      createSpace: vi.fn().mockResolvedValue("!space:server"),
      addRoomToSpace: vi.fn().mockResolvedValue(undefined),
      removeRoomFromSpace: vi.fn().mockResolvedValue(undefined),
      inviteUser: vi.fn().mockResolvedValue(undefined),
      setRoomName: vi.fn().mockResolvedValue(undefined),
      setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
      getPowerLevels: vi.fn().mockResolvedValue({ users: {} }),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      getBotUserId: vi.fn().mockReturnValue("@bot:server"),
      encryptionAvailable: true,
    };
    const pmctl = new PmctlController({ projectManager, roomOps, store });
    const makeRouter = () =>
      createMessageRouter({ projectManager, auth, sendReply, sendTyping, roomOps, store, pmctl });
    return { replies, auth, roomOps, store, makeRouter };
  }

  it("/revoke appends a powerDemote effect carrying the removed entry in stored (namespaced) form", () => {
    const fx = makeRevokeFixtures();
    const result = handleAdminCommand(fx.auth, {
      text: "/revoke @eve:server",
      userId: "@barry:server",
      transport: "matrix",
    });
    expect(result.handled).toBe(true);
    expect(result.effects).toEqual([
      { kind: "persistAuth" },
      { kind: "powerDemote", userId: "matrix:@eve:server" },
    ]);
    // A failed revoke (unknown user) stays effect-free.
    const miss = handleAdminCommand(fx.auth, {
      text: "/revoke nobody",
      userId: "@barry:server",
      transport: "matrix",
    });
    expect(miss.effects).toEqual([]);
  });

  it("consuming the effect strips the revoked user in every managed room and clears the book (persisted)", async () => {
    const fx = makeRevokeFixtures({
      space: { enabled: true, roomId: "!space:server" },
      managementRooms: ["!mgmt:server"],
      projects: { "!proj:server": { workdir: "/w/p" } },
      powerElevatedUsers: ["matrix:@barry:server", "matrix:@eve:server"],
    });
    await fx.makeRouter().handleIncoming(makeMsg({ content: "/revoke @eve:server" }));
    for (const roomId of ["!space:server", "!mgmt:server", "!proj:server"]) {
      expect(fx.roomOps.setUserPowerLevel).toHaveBeenCalledWith(roomId, "@eve:server", 0);
    }
    expect(fx.roomOps.setUserPowerLevel).toHaveBeenCalledTimes(3);
    // The revoke confirmation is unchanged by the demotion side effect.
    expect(fx.replies.some((r) => r.text === "🔓 Revoked trust for @eve:server")).toBe(true);
    // Trust revocation persisted; exactly the revoked user left the books.
    expect(fx.store.get().auth?.trustedUsers).not.toContain("matrix:@eve:server");
    expect(fx.store.get().powerElevatedUsers).toEqual(["matrix:@barry:server"]);
    const persisted = JSON.parse(
      readFileSync(join(tmpDir, ".pi", "pi-courier.json"), "utf-8")
    ) as { powerElevatedUsers?: string[] };
    expect(persisted.powerElevatedUsers).toEqual(["matrix:@barry:server"]);
  });

  it("a demotion failure never un-revokes: the confirmation stands and the book keeps the entry for retry", async () => {
    const fx = makeRevokeFixtures({
      space: { enabled: true, roomId: "!space:server" },
      managementRooms: ["!mgmt:server"],
      powerElevatedUsers: ["matrix:@eve:server"],
    });
    (fx.roomOps.setUserPowerLevel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("M_FORBIDDEN"));
    await fx.makeRouter().handleIncoming(makeMsg({ content: "/revoke @eve:server" }));
    expect(fx.replies.some((r) => r.text === "🔓 Revoked trust for @eve:server")).toBe(true);
    // Trust revocation persisted even though the demotion failed...
    expect(fx.store.get().auth?.trustedUsers).not.toContain("matrix:@eve:server");
    // ...while the bookkeeping survives whole for the startup heal to retry.
    expect(fx.store.get().powerElevatedUsers).toEqual(["matrix:@eve:server"]);
  });
});
