import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../src/config";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { ProjectEntry, ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";

/** Direct table tests for the /pmctl controller — the rm confirmation window
 *  and the gate order were historical bug territory and are pinned here
 *  without going through the router. */
describe("PmctlController", () => {
  let tmpDir: string;
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
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-pmctl-"));
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
      createRoom: vi.fn().mockResolvedValue("!newroom:server"),
      createProjectRoom: vi.fn().mockResolvedValue("!newroom:server"),
      createSpace: vi.fn().mockResolvedValue("!space:server"),
      addRoomToSpace: vi.fn().mockResolvedValue(undefined),
      removeRoomFromSpace: vi.fn().mockResolvedValue(undefined),
      setRoomName: vi.fn().mockResolvedValue(undefined),
      setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
      getPowerLevels: vi.fn().mockResolvedValue(undefined),
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
    rmSync(tmpDir, { recursive: true, force: true });
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
    expect(replies.at(-1)).toContain("创建完成");
  });

  it("surfaces room-creation failures and registers nothing", async () => {
    roomOps.createProjectRoom.mockRejectedValue(new Error("Matrix 未连接"));
    await handle("/pmctl new myapp");
    expect(replies.at(-1)).toContain("创建项目失败");
    expect(replies.at(-1)).toContain("Matrix 未连接");
    expect(pm.registerProject).not.toHaveBeenCalled();
  });

  // ---- label validation (spec #34 票2) ----------------------------------------

  it("rejects new-project names that would break the log label format", async () => {
    await handle("/pmctl new a]b");
    expect(replies.at(-1)).toContain("方括号");
    await handle(`/pmctl new ${"x".repeat(31)}`);
    expect(replies.at(-1)).toContain("30");
    expect(roomOps.createProjectRoom).not.toHaveBeenCalled();
    expect(pm.registerProject).not.toHaveBeenCalled();
  });

  it("rejects a new name colliding case-insensitively with an existing label", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "MyApp", workdir: "/w/myapp" }],
    ]);
    await handle("/pmctl new myapp");
    expect(replies.at(-1)).toContain("MyApp");
    expect(roomOps.createProjectRoom).not.toHaveBeenCalled();
  });

  it("rejects rename to a name colliding with another project (case-insensitive)", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!a:server", { name: "alpha", workdir: "/w/a" }],
      ["!b:server", { name: "beta", workdir: "/w/b" }],
    ]);
    await handle("/pmctl rename alpha BETA");
    expect(replies.at(-1)).toContain("大小写");
    expect(pm.renameProject).not.toHaveBeenCalled();
  });

  it("renaming a project to its own name is not a self-collision", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!a:server", { name: "alpha", workdir: "/w/a" }],
      ["!b:server", { name: "beta", workdir: "/w/b" }],
    ]);
    await handle("/pmctl rename alpha alpha");
    expect(pm.renameProject).toHaveBeenCalledWith("!a:server", "alpha");
  });

  it("rejects rename with brackets", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!a:server", { name: "alpha", workdir: "/w/a" }],
    ]);
    await handle("/pmctl rename alpha [oops]");
    expect(replies.at(-1)).toContain("方括号");
    expect(pm.renameProject).not.toHaveBeenCalled();
  });

  // ---- labels resolve via projectLabelOf (name ?? workdir basename) -----------

  it("lists unnamed projects by workdir basename, findable by it", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!legacy:server", { workdir: "/w/legacy-app" }],
    ]);
    await handle("/pmctl list");
    expect(replies.at(-1)).toContain("legacy-app");
    expect(replies.at(-1)).not.toContain("!legacy:server —");
    await handle("/pmctl show legacy-app");
    expect(replies.at(-1)).toContain("📁 项目: legacy-app");
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

  // ---- space hooks (spec #16 ticket 3) ----------------------------------------
  // Space-active controllers get a fresh store via the constructor (no
  // store.update — the ConfigStore would persist to the real home dir).

  function spaceController(spaceActive = true) {
    const spaceStore = new ConfigStore({
      managementRooms: [],
      projects: {},
      workdir: "/home/you/Projects",
      multiProject: true,
      ...(spaceActive ? { space: { enabled: true, roomId: "!space:server" } } : {}),
    });
    return new PmctlController({
      projectManager: pm as unknown as ProjectManager,
      roomOps: roomOps as unknown as RoomOps,
      store: spaceStore,
    });
  }

  it("new files the project room under the active space", async () => {
    await spaceController().handle("/pmctl new myapp", call, reply);
    expect(roomOps.addRoomToSpace).toHaveBeenCalledWith("!space:server", "!newroom:server");
    expect(replies.at(-1)).toContain("创建完成");
  });

  it("new link failure never fails the project (warn note appended)", async () => {
    roomOps.addRoomToSpace.mockRejectedValue(new Error("M_FORBIDDEN"));
    await spaceController().handle("/pmctl new myapp", call, reply);
    expect(pm.registerProject).toHaveBeenCalledWith("!newroom:server", "/home/you/Projects/myapp", "myapp");
    expect(replies.at(-1)).toContain("创建完成");
    expect(replies.at(-1)).toContain("挂入空间失败");
  });

  it("new without the space (off or not yet created) links nothing", async () => {
    await spaceController(false).handle("/pmctl new myapp", call, reply);
    expect(roomOps.addRoomToSpace).not.toHaveBeenCalled();
    // The default beforeEach store (no space fields at all) behaves the same.
    await handle("/pmctl new other");
    expect(roomOps.addRoomToSpace).not.toHaveBeenCalled();
  });

  it("rm unlinks from the space BEFORE leaving (no ghost entry)", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);
    const c = spaceController(); // one instance — the rm window is instance state
    await c.handle("/pmctl rm myapp", call, reply); // arm
    await c.handle("/pmctl rm myapp", call, reply); // confirm
    expect(roomOps.removeRoomFromSpace).toHaveBeenCalledWith("!space:server", "!proj:server");
    expect(roomOps.leaveRoom).toHaveBeenCalledWith("!proj:server", "项目已删除");
    const unlink = (roomOps.removeRoomFromSpace as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const leave = (roomOps.leaveRoom as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(unlink).toBeLessThan(leave);
  });

  it("rm unlink failure warns but still leaves the room", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);
    roomOps.removeRoomFromSpace.mockRejectedValue(new Error("M_FORBIDDEN"));
    const c = spaceController();
    await c.handle("/pmctl rm myapp", call, reply); // arm
    await c.handle("/pmctl rm myapp", call, reply); // confirm
    expect(roomOps.leaveRoom).toHaveBeenCalledWith("!proj:server", "项目已删除");
    expect(replies.some((r) => r.includes("从空间移除失败"))).toBe(true);
  });

  it("rm without the space unlinks nothing", async () => {
    (pm.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([
      ["!proj:server", { name: "myapp", workdir: "/w/myapp" }],
    ]);
    const c = spaceController(false);
    await c.handle("/pmctl rm myapp", call, reply); // arm
    await c.handle("/pmctl rm myapp", call, reply); // confirm
    expect(roomOps.removeRoomFromSpace).not.toHaveBeenCalled();
    expect(roomOps.leaveRoom).toHaveBeenCalledWith("!proj:server", "项目已删除");
  });

  // ---- new: unified trusted-user elevation (issue #42) -------------------------
  // /pmctl new elevates EVERY trusted user in the new room via the shared
  // space.ts path. Elevation writes config (powerElevatedUsers bookkeeping)
  // through store.update(), so these tests isolate os.homedir() into a tmpDir
  // (same doMock pattern as tests/space.test.ts) — the real ~/.pi config must
  // never be touched.

  function makeIsolatedPmMock() {
    const projects = new Map<string, ProjectEntry>();
    return {
      isMultiProject: true,
      isProjectRoom: vi.fn().mockReturnValue(false),
      registerProject: vi.fn((roomId: string, workdir: string, name?: string) => {
        projects.set(roomId, { name, workdir });
      }),
      listProjects: vi.fn(() => Array.from(projects.entries())),
      isRunning: vi.fn().mockReturnValue(false),
    };
  }

  function makeIsolatedRoomOps(overrides: Record<string, unknown> = {}) {
    return {
      createProjectRoom: vi.fn().mockResolvedValue("!newroom:server"),
      setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
      getPowerLevels: vi.fn().mockResolvedValue(undefined),
      addRoomToSpace: vi.fn().mockResolvedValue(undefined),
      removeRoomFromSpace: vi.fn().mockResolvedValue(undefined),
      setRoomName: vi.fn().mockResolvedValue(undefined),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  async function isolatedController(configOverrides: Record<string, unknown> = {}, roomOpsOverrides: Record<string, unknown> = {}) {
    vi.resetModules();
    const homedirMock = async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    };
    vi.doMock("os", homedirMock);
    vi.doMock("node:os", homedirMock);
    const { ConfigStore: IsolatedStore } = await import("../src/config");
    const { PmctlController: IsolatedPmctlController } = await import("../src/rpc/pmctl-controller");
    const store = new IsolatedStore({
      managementRooms: [],
      projects: {},
      workdir: "/home/you/Projects",
      ...configOverrides,
    });
    const pmMock = makeIsolatedPmMock();
    const ops = makeIsolatedRoomOps(roomOpsOverrides);
    const isolatedReplies: string[] = [];
    const isolatedReply = async (text: string) => {
      isolatedReplies.push(text);
    };
    const ctl = new IsolatedPmctlController({
      projectManager: pmMock as unknown as ProjectManager,
      roomOps: ops as unknown as RoomOps,
      store,
    });
    const handleIsolated = (text: string) =>
      ctl.handle(text, { chatId: "!mgmt:server", senderMxid: "@barry:server", isManagementRoom: true }, isolatedReply);
    return { store, ops, pmMock, replies: isolatedReplies, handle: handleIsolated };
  }

  it("/pmctl new elevates every trusted user in the new room and books the elevation", async () => {
    const { handle, ops, store, replies } = await isolatedController({
      auth: { trustedUsers: ["matrix:@barry:server", "matrix:@carol:server"] },
    });
    await handle("/pmctl new myapp");
    // All trusted users (sender or not), in native MXID form, at PL 100.
    expect(ops.setUserPowerLevel).toHaveBeenCalledWith("!newroom:server", "@barry:server", 100);
    expect(ops.setUserPowerLevel).toHaveBeenCalledWith("!newroom:server", "@carol:server", 100);
    // Both were actually elevated from below 100 — both are booked (namespaced).
    expect(store.get().powerElevatedUsers).toEqual(["matrix:@barry:server", "matrix:@carol:server"]);
    expect(replies.at(-1)).toContain("创建完成");
  });

  it("/pmctl new elevation failure warns but the project is still created", async () => {
    const { handle, ops, pmMock, replies } = await isolatedController(
      { auth: { trustedUsers: ["matrix:@barry:server"] } },
      { setUserPowerLevel: vi.fn().mockRejectedValue(new Error("没有权限")) }
    );
    await handle("/pmctl new myapp");
    expect(ops.setUserPowerLevel).toHaveBeenCalledWith("!newroom:server", "@barry:server", 100);
    expect(pmMock.registerProject).toHaveBeenCalledWith("!newroom:server", "/home/you/Projects/myapp", "myapp");
    expect(replies.some((r) => r.includes("信任用户补权失败"))).toBe(true);
    expect(replies.at(-1)).toContain("创建完成");
  });
});
