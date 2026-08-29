import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { createMessageRouter } from "../src/rpc/message-router";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { ExternalMessage } from "../src/types";

// maybeInitManagementRoom persists into the real ~/.pi config — back it up
// around each test so the test run never pollutes real state.
const CONFIG_PATH = path.join(os.homedir(), ".pi", "pi-courier.json");
let configBackup: string | null = null;

beforeEach(() => {
  configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf-8") : null;
  // Isolate: start each test from no management room / no projects.
  const cfg = loadConfig();
  saveConfig({ ...cfg, managementRooms: [], projects: {} });
});

afterEach(() => {
  if (configBackup === null) {
    fs.rmSync(CONFIG_PATH, { force: true });
  } else {
    fs.writeFileSync(CONFIG_PATH, configBackup, { mode: 0o600 });
  }
});

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
function makeFixtures(opts: { multiProject?: boolean; channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }> } = {}) {
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
    isMultiProject: opts.multiProject ?? true,
    registerProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([] as Array<[string, { name?: string; workdir: string }]>),
    renameProject: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ProjectManager;
  const auth = new ChallengeAuth(
    (code) => {
      codeBox.current = code;
    },
    () => {},
    undefined,
    () => {}
  );
  auth.loadFromConfig({
    trustedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
    adminUserId: "matrix:@barry:server",
    channels: opts.channels ?? {},
  });
  // Router sees message I/O as two functions; room ops as one stubbed capability.
  const sendTyping = vi.fn().mockResolvedValue(undefined);
  const roomOps = {
    createProjectRoom: vi.fn().mockResolvedValue("!newproj:server"),
    setRoomName: vi.fn().mockResolvedValue(undefined),
    setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    getBotUserId: vi.fn().mockReturnValue("@bot:server"),
  };
  const makeRouter = () =>
    createMessageRouter({ projectManager, auth, sendReply, sendTyping, roomOps });
  return { codeBox, replies, sendReply, sendTyping, rpc, projectManager, auth, roomOps, makeRouter };
}

describe("message-router multi-project routing", () => {
  let rpc: PiRpc;
  let projectManager: ProjectManager;
  let auth: ChallengeAuth;
  let roomOps: Record<string, ReturnType<typeof vi.fn>>;
  let sendTyping: ReturnType<typeof vi.fn>;
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let makeRouter: () => ReturnType<typeof createMessageRouter>;

  beforeEach(() => {
    const fx = makeFixtures();
    rpc = fx.rpc;
    projectManager = fx.projectManager;
    auth = fx.auth;
    roomOps = fx.roomOps as unknown as Record<string, ReturnType<typeof vi.fn>>;
    sendTyping = fx.sendTyping as ReturnType<typeof vi.fn>;
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
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"] });
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
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"], workdir: "/home/you/Projects" });
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
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"], workdir: "/home/you/Projects" });
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
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"], workdir: "/home/you/Projects" });
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
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"] });
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
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(saved.multiProject).toBe(false);
    expect(replies.at(-1)!.text).toContain("重启生效");
  });

  it("agent turn_start triggers a typing indicator via the message-I/O seam", async () => {
    const router = makeRouter();
    router.handleEvent({ type: "turn_start" }, "!room:server");
    await new Promise((r) => setTimeout(r, 0));
    expect(sendTyping).toHaveBeenCalledWith("!room:server", "matrix");
  });

  it("room-creation failure surfaces the thrown message (no null-branch)", async () => {
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"] });
    roomOps.createProjectRoom.mockRejectedValue(new Error("Matrix 未连接"));
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/pmctl new myapp" }));
    expect(replies.at(-1)!.text).toContain("创建项目失败");
    expect(replies.at(-1)!.text).toContain("Matrix 未连接");
    expect(projectManager.registerProject).not.toHaveBeenCalled();
  });

  it("owner-promotion failure warns but the project is still registered", async () => {
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"] });
    roomOps.setUserPowerLevel.mockRejectedValue(new Error("power level too low"));
    const router = makeRouter();
    await router.handleIncoming(makeMsg({ content: "/pmctl new myapp" }));
    expect(projectManager.registerProject).toHaveBeenCalledWith("!newproj:server", expect.any(String), "myapp");
    expect(replies.some((r) => r.text.includes("创建完成"))).toBe(true);
    expect(replies.some((r) => r.text.includes("设为管理员失败"))).toBe(true);
  });

  it("room-rename failure is surfaced while the project rename stands", async () => {
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"] });
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
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"] });
    const sendReply = async (chatId: string, transport: string, text: string) => {
      replies.push({ chatId, transport, text });
    };
    const router = createMessageRouter({ projectManager, auth, sendReply, sendTyping });
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
