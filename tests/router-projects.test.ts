import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import type { ChallengeAuth } from "../src/auth/challenge-auth";
import { createMessageRouter } from "../src/rpc/message-router";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { TransportManager } from "../src/transports/manager";
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

describe("message-router multi-project routing", () => {
  let rpc: PiRpc;
  let projectManager: ProjectManager;
  let auth: ChallengeAuth;
  let transportManager: TransportManager;
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  const sendReply = async (chatId: string, transport: string, text: string) => {
    replies.push({ chatId, transport, text });
  };

  beforeEach(() => {
    replies = [];
    rpc = {
      prompt: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({ model: { id: "m" } }),
      newSession: vi.fn().mockResolvedValue({ cancelled: false }),
      onEvent: vi.fn(),
    } as unknown as PiRpc;

    projectManager = {
      getRpcForRoom: vi.fn().mockReturnValue(rpc),
      isProjectRoom: vi.fn().mockReturnValue(false),
      isMultiProject: true,
      registerProject: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as ProjectManager;

    auth = {
      checkAuthorization: vi.fn().mockResolvedValue(true),
      handleAdminCommand: vi.fn().mockResolvedValue(false),
      isTrustedUser: vi.fn().mockReturnValue(true),
      exportConfig: vi.fn().mockReturnValue({
        trustedUsers: [],
        adminUserId: "matrix:@barry:server",
        channels: {},
      }),
    } as unknown as ChallengeAuth;

    transportManager = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      createProjectRoom: vi.fn().mockResolvedValue("!newproj:server"),
      setRoomName: vi.fn().mockResolvedValue(undefined),
      getRoomName: vi.fn().mockResolvedValue(null),
    } as unknown as TransportManager;
  });

  it("routes plain DM messages to the room's rpc via projectManager", async () => {
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    const msg = makeMsg({ content: "hello pi" });
    await router.handleIncoming(msg);
    expect(projectManager.getRpcForRoom).toHaveBeenCalledWith("!dm:server");
    expect(rpc.prompt).toHaveBeenCalledWith("hello pi");
  });

  it("routes project-room messages to the project rpc (different instance)", async () => {
    const projectRpc = { prompt: vi.fn().mockResolvedValue(undefined) } as unknown as PiRpc;
    (projectManager.getRpcForRoom as ReturnType<typeof vi.fn>).mockReturnValue(projectRpc);
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    await router.handleIncoming(makeMsg({ chatId: "!proj:server", content: "do work" }));
    expect(rpc.prompt).not.toHaveBeenCalled();
    expect(projectRpc.prompt).toHaveBeenCalledWith("do work");
  });

  it("/newproject creates a room, registers the project and replies", async () => {
    // Management commands require the management-room flag in config.
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"] });
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    await router.handleIncoming(
      makeMsg({ content: "/newproject myapp /tmp/myapp" })
    );
    await new Promise((r) => setTimeout(r, 20)); // let fire-and-forget branding settle
    expect(transportManager.createProjectRoom).toHaveBeenCalledWith(expect.stringContaining("myapp("), "@barry:server");
    expect(projectManager.registerProject).toHaveBeenCalledWith("!newproj:server", "/tmp/myapp", "myapp");
    const reply = replies.at(-1)!;
    expect(reply.text).toContain("myapp");
    expect(reply.text).toContain("!newproj:server");
  });

  it("resolves a relative path in /pmctl new against the project root", async () => {
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"], workdir: "/home/you/Projects" });
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
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
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
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
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
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
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    await router.handleIncoming(makeMsg({ content: "/pmctl new myapp /tmp/myapp" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(projectManager.registerProject).toHaveBeenCalledWith("!newproj:server", "/tmp/myapp", "myapp");
    expect(replies.at(-1)!.text).toContain("创建完成");
  });

  it("rejects /pmctl from a project room", async () => {
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    await router.handleIncoming(
      makeMsg({ chatId: "!projroom:server", isGroupChat: true, content: "/pmctl list" })
    );
    expect(replies.at(-1)!.text).toContain("仅可在管理房间");
  });

  it("rejects /pmctl from a second room once a management room already exists", async () => {
    saveConfig({ ...loadConfig(), managementRooms: ["!dm:server"] });
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    // A different private room is not the management room.
    await router.handleIncoming(
      makeMsg({ chatId: "!alice:server", content: "/pmctl list" })
    );
    expect(replies.at(-1)!.text).toContain("仅可在管理房间");
  });

  it("brands an unnamed DM room on first message (idempotent)", async () => {
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    await router.handleIncoming(makeMsg({ content: "hi" }));
    // maybeInitManagementRoom runs — let it complete
    await new Promise((r) => setTimeout(r, 20));
    expect(transportManager.setRoomName).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("项目管理")
    );
    expect(replies.some((r) => r.text.includes("项目管理房间"))).toBe(true);
  });

  it("does not brand a project room (2-person room with a mapping)", async () => {
    (projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    await router.handleIncoming(makeMsg({ chatId: "!projroom:server", content: "hello" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(transportManager.setRoomName).not.toHaveBeenCalled();
  });

  it("in single-project mode /pmctl reports it is unavailable", async () => {
    (projectManager as { isMultiProject: boolean }).isMultiProject = false;
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    await router.handleIncoming(makeMsg({ content: "/pmctl list" }));
    expect(replies.at(-1)!.text).toContain("单工程模式");
  });

  it("in single-project mode every room uses the default rpc (no branding)", async () => {
    (projectManager as { isMultiProject: boolean }).isMultiProject = false;
    (projectManager.isProjectRoom as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    await router.handleIncoming(makeMsg({ content: "hello" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(transportManager.setRoomName).not.toHaveBeenCalled();
    expect(rpc.prompt).toHaveBeenCalledWith("hello");
  });

  it("a trusted user can toggle multi-project mode via /multiproject (restart effect)", async () => {
    (projectManager as { isMultiProject: boolean }).isMultiProject = true;
    const router = createMessageRouter({
      rpc,
      projectManager,
      auth,
      transportManager,
      sendReply,
      log: () => {},
      debug: false,
    });
    await router.handleIncoming(makeMsg({ content: "/multiproject off" }));
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(saved.multiProject).toBe(false);
    expect(replies.at(-1)!.text).toContain("重启生效");
  });
});
