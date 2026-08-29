import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { ProjectEntry, ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";

/** Direct table tests for the /pmctl controller — the rm confirmation window
 *  and the gate order were historical bug territory and are pinned here
 *  without going through the router. */
describe("PmctlController", () => {
  let pm: Record<string, ReturnType<typeof vi.fn>> & { isMultiProject: boolean };
  let roomOps: Record<string, ReturnType<typeof vi.fn>>;
  let store: ConfigStore;
  let controller: PmctlController;
  let replies: string[];
  const reply = async (text: string) => {
    replies.push(text);
  };
  const call = { chatId: "!mgmt:server", senderMxid: "@barry:server", isManagementRoom: true };
  const handle = (text: string, overrides: Record<string, unknown> = {}) =>
    controller.handle(text, { ...call, ...overrides }, reply);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    replies = [];
    const projects = new Map<string, ProjectEntry>();
    pm = {
      isMultiProject: true,
      getRpcForRoom: vi.fn(),
      isProjectRoom: vi.fn().mockReturnValue(false),
      registerProject: vi.fn(),
      listProjects: vi.fn().mockImplementation(() => Array.from(projects.entries())),
      isRunning: vi.fn().mockReturnValue(false),
      removeProject: vi.fn(),
      updateProjectWorkdir: vi.fn(),
      renameProject: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as typeof pm;
    // Seed one project (registerProject is stubbed, so write the map directly).
    (pm.registerProject as ReturnType<typeof vi.fn>).mockImplementation(
      (roomId: string, workdir: string, name?: string) => {
        projects.set(roomId, { name, workdir });
      }
    );
    (pm.removeProject as ReturnType<typeof vi.fn>).mockImplementation((roomId: string) => {
      projects.delete(roomId);
    });
    roomOps = {
      createProjectRoom: vi.fn().mockResolvedValue("!newroom:server"),
      setRoomName: vi.fn().mockResolvedValue(undefined),
      setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      getBotUserId: vi.fn().mockReturnValue("@bot:server"),
    };
    store = new ConfigStore({ managementRooms: [], projects: {}, workdir: "/home/you/Projects" });
    controller = new PmctlController({
      projectManager: pm as unknown as ProjectManager,
      roomOps: roomOps as unknown as RoomOps,
      store,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- gates ---------------------------------------------------------------

  it("rejects in single-project mode before any other gate", async () => {
    pm.isMultiProject = false;
    await handle("/pmctl list");
    expect(replies.at(-1)).toContain("单工程模式");
  });

  it("rejects outside the management room", async () => {
    await handle("/pmctl list", { isManagementRoom: false });
    expect(replies.at(-1)).toContain("仅可在管理房间");
  });

  it("reports Matrix-only availability without roomOps", async () => {
    controller = new PmctlController({
      projectManager: pm as unknown as ProjectManager,
      store,
    });
    await handle("/pmctl list");
    expect(replies.at(-1)).toContain("仅 Matrix 部署支持");
  });

  it("/projects is an alias for list, and bare /pmctl defaults to list", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);
    await handle("/projects");
    expect(replies.at(-1)).toContain("项目列表");
    await handle("/pmctl");
    expect(replies.at(-1)).toContain("项目列表");
  });

  it("unknown /pmctl operations list the available ones", async () => {
    await handle("/pmctl frobnicate");
    expect(replies.at(-1)).toContain("未知操作: frobnicate");
    expect(replies.at(-1)).toContain("new / list / show / rm / mv / rename");
  });

  it("returns false for non-pmctl commands (caller falls through)", async () => {
    expect(await handle("/new")).toBe(false);
    expect(await handle("/skill:rust review")).toBe(false);
    expect(replies.length).toBe(0);
  });

  // ---- new -------------------------------------------------------------------

  it("creates a project with the pre-resolved invite target and registers it", async () => {
    await handle("/pmctl new myapp");
    expect(roomOps.createProjectRoom).toHaveBeenCalledWith("myapp(debian)", "@barry:server");
    // The invite target is passed as-is — no prefix stripping in the controller.
    expect(String((roomOps.createProjectRoom as ReturnType<typeof vi.fn>).mock.calls[0][1])).not.toContain("matrix:");
    expect(pm.registerProject).toHaveBeenCalledWith("!newroom:server", "/home/you/Projects/myapp", "myapp");
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!newroom:server", "@barry:server", 100);
    expect(replies.at(-1)).toContain("创建完成");
  });

  it("surfaces room-creation failures and registers nothing", async () => {
    roomOps.createProjectRoom.mockRejectedValue(new Error("Matrix 未连接"));
    await handle("/pmctl new myapp");
    expect(replies.at(-1)).toContain("创建项目失败");
    expect(replies.at(-1)).toContain("Matrix 未连接");
    expect(pm.registerProject).not.toHaveBeenCalled();
  });

  // ---- rm: the 60-second confirmation window ---------------------------------

  it("arms on first rm, confirms on the second within the window", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);

    await handle("/pmctl rm myapp");
    expect(pm.removeProject).not.toHaveBeenCalled();
    expect(replies.at(-1)).toContain("确认删除");

    await handle("/pmctl rm myapp");
    expect(pm.removeProject).toHaveBeenCalledWith("!proj:server");
    expect(roomOps.leaveRoom).toHaveBeenCalledWith("!proj:server", "项目已删除");
    expect(replies.at(-1)).toContain("已删除");
  });

  it("cancel clears the armed confirmation both ways", async () => {
    await handle("/pmctl rm cancel");
    expect(replies.at(-1)).toContain("当前没有待确认的删除操作");

    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);
    await handle("/pmctl rm myapp"); // arm
    await handle("/pmctl rm cancel"); // clear
    expect(replies.at(-1)).toContain("已取消删除");

    // After cancel the confirmation is re-armed, not immediately executed.
    await handle("/pmctl rm myapp");
    expect(pm.removeProject).not.toHaveBeenCalled();
  });

  it("an expired confirmation times out and re-arms — nothing is deleted", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);

    await handle("/pmctl rm myapp"); // arm at t=1_000_000
    vi.setSystemTime(1_000_000 + 61_000); // window expired
    await handle("/pmctl rm myapp");
    expect(replies.at(-2)).toContain("上次确认已超时");
    expect(replies.at(-1)).toContain("确认删除");
    expect(pm.removeProject).not.toHaveBeenCalled();
  });

  it("a stale confirmation for room A never deletes room B", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!projA:server", { name: "alpha", workdir: "/w/a" }],
      ["!projB:server", { name: "beta", workdir: "/w/b" }],
    ]);

    await handle("/pmctl rm alpha"); // arm A
    vi.setSystemTime(1_000_000 + 61_000); // expire A's confirmation
    await handle("/pmctl rm beta"); // different target: timeout notice + arm B
    expect(replies.at(-2)).toContain("上次确认已超时");
    expect(pm.removeProject).not.toHaveBeenCalled(); // neither project touched

    await handle("/pmctl rm beta"); // confirm B within its fresh window
    expect(pm.removeProject).toHaveBeenCalledTimes(1);
    expect(pm.removeProject).toHaveBeenCalledWith("!projB:server");
    expect(pm.removeProject).not.toHaveBeenCalledWith("!projA:server");
  });

  // ---- mv / rename ------------------------------------------------------------

  it("mv resolves the new workdir against the project root", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);
    await handle("/pmctl mv myapp myapp-v2");
    expect(pm.updateProjectWorkdir).toHaveBeenCalledWith("!proj:server", "/home/you/Projects/myapp-v2");
    expect(replies.at(-1)).toContain("已迁移");
  });

  it("rename syncs the room name and surfaces roomOps failures", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);
    await handle("/pmctl rename myapp newname");
    expect(pm.renameProject).toHaveBeenCalledWith("!proj:server", "newname");
    expect(roomOps.setRoomName).toHaveBeenCalledWith("!proj:server", "newname");
    expect(replies.at(-1)).toContain("✏️");

    roomOps.setRoomName.mockRejectedValue(new Error("没有权限"));
    await handle("/pmctl rename myapp newer");
    expect(replies.at(-1)).toContain("房间改名失败");
    expect(replies.at(-1)).toContain("没有权限");
  });
});
