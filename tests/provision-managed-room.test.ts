import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectEntry, ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";

/**
 * 置备托管房间的深函数 provisionManagedRoom(票2,spec #99 / issue #103)。
 *
 * 核心不变量:中途建的房间 ≡ 启动自愈后的房间。两条置备路径(/pmctl new 的
 * 项目房、启动 ensure 的管理房)对同一房间意图(邀请对象 = 唯一信任用户)
 * 产出相同的四步操作序列 —— 建房 → 信任用户提权 → 挂入空间 → 按套品牌,
 * 用同一组带全局调用轨迹的 RoomOps 桩逐一对齐断言。
 *
 * 同时钉死:失败语义(挂链/品牌失败仅警告附注且文案单点、提权走既有幂等
 * 路径且失败不阻塞)、按套选图规则收回模块内部(项目房=小屋套按项目名、
 * 管理房=小屋套管理专用图)。
 *
 * RoomOps 桩沿用 tests/space.test.ts / tests/pmctl-controller.test.ts 的模式;
 * store 用 doMock(os) 隔离进临时目录 —— store.update() 不得触碰真实 ~/.pi。
 */
describe("provisionManagedRoom(票2:中途房 ≡ 自愈房)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-provision-"));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importModules() {
    vi.resetModules();
    const homedirMock = async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    };
    vi.doMock("os", homedirMock);
    vi.doMock("node:os", homedirMock);
    const config = await import("../src/config");
    const space = await import("../src/space");
    const pmctl = await import("../src/rpc/pmctl-controller");
    const spaceIdentity = await import("../src/space-identity");
    const loggerModule = await import("../src/logger");
    // resetModules 重建了 i18n 模块图 —— 全局 setup 的 zh 锚要重新落上。
    const i18n = await import("../src/i18n/index");
    i18n.setLocale("zh");
    return { config, space, pmctl, spaceIdentity, loggerModule };
  }

  type TraceEntry = { op: string; args: unknown[] };

  /** RoomOps 桩:默认全成功,外加一层全局调用轨迹 —— 断言操作序列用。 */
  function makeTracingRoomOps(overrides: Record<string, unknown> = {}) {
    const trace: TraceEntry[] = [];
    const base: Record<string, unknown> = {
      createRoom: vi.fn().mockResolvedValue("!mgmt:server"),
      createProjectRoom: vi.fn().mockResolvedValue("!newroom:server"),
      createSpace: vi.fn().mockResolvedValue("!space:server"),
      addRoomToSpace: vi.fn().mockResolvedValue(undefined),
      removeRoomFromSpace: vi.fn().mockResolvedValue(undefined),
      inviteUser: vi.fn().mockResolvedValue(undefined),
      setRoomName: vi.fn().mockResolvedValue(undefined),
      getRoomName: vi.fn().mockResolvedValue(null),
      getRoomAvatar: vi.fn().mockResolvedValue(null),
      setRoomAvatar: vi.fn().mockResolvedValue(undefined),
      getProfileAvatarUrl: vi.fn().mockResolvedValue(null),
      setProfileAvatar: vi.fn().mockResolvedValue(undefined),
      uploadMedia: vi.fn().mockResolvedValue("mxc://server/avatar"),
      setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
      getPowerLevels: vi.fn().mockResolvedValue(null),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      getBotUserId: vi.fn().mockReturnValue("@bot:server"),
      encryptionAvailable: true,
      ...overrides,
    };
    const ops: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(base)) {
      if (typeof value !== "function") {
        ops[name] = value;
        continue;
      }
      const fn = value as (...a: unknown[]) => unknown;
      ops[name] = vi.fn((...args: unknown[]) => {
        trace.push({ op: name, args });
        return fn(...args);
      });
    }
    return { ops: ops as unknown as RoomOps, trace };
  }

  /** 从轨迹抽取四步操作(建房/提权/挂链/品牌),新房间 ID 归一化为占位符;
   *  变体自有差异(显示名、加密位)不参与等价断言。 */
  function provisionOps(trace: TraceEntry[], newRoomId: string) {
    const room = (id: unknown) => (id === newRoomId ? "<新房间>" : id);
    const out: Array<Record<string, unknown>> = [];
    for (const { op, args } of trace) {
      if (op === "createRoom") {
        out.push({ op: "create", invite: (args[0] as { inviteUserIds: string[] }).inviteUserIds });
      } else if (op === "createProjectRoom") {
        out.push({ op: "create", invite: [args[1]] });
      } else if (op === "getPowerLevels") {
        out.push({ op: "power-read", room: room(args[0]) });
      } else if (op === "setUserPowerLevel") {
        out.push({ op: "elevate", room: room(args[0]), user: args[1], level: args[2] });
      } else if (op === "addRoomToSpace") {
        out.push({ op: "link", space: args[0], room: room(args[1]) });
      } else if (op === "getRoomAvatar") {
        out.push({ op: "avatar-read", room: room(args[0]) });
      } else if (op === "uploadMedia") {
        out.push({ op: "brand-upload", contentType: args[1] });
      } else if (op === "setRoomAvatar") {
        out.push({ op: "brand-set", room: room(args[0]), url: args[1] });
      }
    }
    return out;
  }

  const TRUSTED = ["matrix:@barry:server"];

  function baseConfig(spaceCfg: Record<string, unknown>) {
    return {
      multiProject: true,
      instanceName: "box1",
      workdir: "/home/you/Projects",
      space: spaceCfg,
      managementRooms: [] as string[],
      auth: { trustedUsers: TRUSTED },
    };
  }

  function makePmMock() {
    const projects = new Map<string, ProjectEntry>();
    const registerProject = vi.fn((roomId: string, workdir: string, name?: string) => {
      projects.set(roomId, { name, workdir });
    });
    const pm = {
      isMultiProject: true,
      isProjectRoom: vi.fn().mockReturnValue(false),
      registerProject,
      listProjects: vi.fn(() => Array.from(projects.entries())),
      isRunning: vi.fn().mockReturnValue(false),
    };
    return { pm: pm as unknown as ProjectManager, registerProject };
  }

  const pmctlCall = { chatId: "!mgmt:server", senderMxid: "@barry:server", isManagementRoom: true };

  // ---- 等价性:两条路径,同一房间意图,同一操作序列 -------------------------

  it("/pmctl new 与启动 ensure 对同一房间意图产出相同的四步操作序列", async () => {
    // 路径 A:/pmctl new —— 项目房变体(空间已物化)。
    const a = await importModules();
    const storeA = new a.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops: opsA, trace: traceA } = makeTracingRoomOps();
    const pmA = makePmMock();
    const ctl = new a.pmctl.PmctlController({ projectManager: pmA.pm, roomOps: opsA, store: storeA });
    const replies: string[] = [];
    await ctl.handle("/pmctl new myapp", pmctlCall, async (text: string) => {
      replies.push(text);
    });
    expect(replies.at(-1)).toContain("创建完成");

    // 路径 B:启动 ensure —— 管理房变体(空间已物化,管理房待建)。
    const b = await importModules();
    const storeB = new b.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops: opsB, trace: traceB } = makeTracingRoomOps();
    const result = await b.space.ensureSpaceAndManagementRoom({
      roomOps: opsB,
      store: storeB,
      sendReply: vi.fn().mockResolvedValue(undefined),
    });
    expect(result).toBe("ready");

    // 同一意图(邀请对象 = 唯一信任用户)→ 相同的四步序列,逐步对齐;
    // 建房路径只挂链一次(置备深函数完成后不再重申)。
    const expected = [
      { op: "create", invite: ["@barry:server"] },
      { op: "power-read", room: "<新房间>" },
      { op: "elevate", room: "<新房间>", user: "@barry:server", level: 100 },
      { op: "link", space: "!space:server", room: "<新房间>" },
      { op: "avatar-read", room: "<新房间>" },
      { op: "brand-upload", contentType: "image/png" },
      { op: "brand-set", room: "<新房间>", url: "mxc://server/avatar" },
    ];
    expect(provisionOps(traceA, "!newroom:server")).toEqual(expected);
    expect(provisionOps(traceB, "!mgmt:server")).toEqual(expected);
    // 两条路径的落簿都已完成(崩溃安全:建房事实先落盘)。
    expect(pmA.registerProject).toHaveBeenCalledWith("!newroom:server", "/home/you/Projects/myapp", "myapp");
    expect(storeB.get().managementRooms).toEqual(["!mgmt:server"]);
  });

  // ---- 按套选图规则收回模块内部 ---------------------------------------------

  it("项目房头像由深函数按项目名选小屋套(调用方不再触 pickPoolAvatarFile)", { timeout: 30_000 }, async () => {
    // 高负载下全量并行跑时,资产读取+Buffer 比对会顶到 vitest 默认 5s 超时
    // (既有 bot-avatar.test.ts 同款抖动),这里放宽到 30s。
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops, trace } = makeTracingRoomOps();
    const ctl = new m.pmctl.PmctlController({ projectManager: makePmMock().pm, roomOps: ops, store });
    await ctl.handle("/pmctl new myapp", pmctlCall, async () => {});
    const upload = trace.find((e) => e.op === "uploadMedia");
    expect(upload).toBeDefined();
    const expected = m.spaceIdentity.readAvatarBundled(m.spaceIdentity.pickPoolAvatarFile("myapp", "room"));
    expect(upload?.args[0]).toEqual(expected);
  });

  it("管理房头像用小屋套的管理专用图(与项目房按名选图分流)", { timeout: 30_000 }, async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops, trace } = makeTracingRoomOps();
    await m.space.ensureSpaceAndManagementRoom({
      roomOps: ops,
      store,
      sendReply: vi.fn().mockResolvedValue(undefined),
    });
    const upload = trace.find((e) => e.op === "uploadMedia");
    expect(upload).toBeDefined();
    const expected = m.spaceIdentity.readAvatarBundled(m.spaceIdentity.managementAvatarFile());
    expect(upload?.args[0]).toEqual(expected);
  });

  // ---- 失败语义:挂链/品牌仅警告附注(单点文案),提权幂等 -------------------

  it("挂链失败:项目房附注不阻塞、品牌照做,文案为单点渲染", async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops } = makeTracingRoomOps({ addRoomToSpace: vi.fn().mockRejectedValue(new Error("boom")) });
    const r = await m.space.provisionManagedRoom(ops, store, {
      kind: "project",
      name: "myapp(box1)",
      inviteUserId: "@barry:server",
      projectName: "myapp",
    });
    expect(r.roomId).toBe("!newroom:server");
    expect(r.notes).toEqual(["挂入空间失败(不影响项目): boom"]);
    expect(r.elevationError).toBeUndefined();
    // 品牌不因挂链失败而跳过。
    expect(ops.setRoomAvatar).toHaveBeenCalledWith("!newroom:server", "mxc://server/avatar", expect.anything());
  });

  it("挂链失败:管理房附注承诺下次启动自动重试(ensure 重申语义)", async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops } = makeTracingRoomOps({ addRoomToSpace: vi.fn().mockRejectedValue(new Error("boom")) });
    const r = await m.space.provisionManagedRoom(ops, store, {
      kind: "management",
      name: "项目管理（box1）",
      inviteUserIds: ["@barry:server"],
    });
    expect(r.notes).toEqual(["管理房间挂入空间失败(下次启动自动重试,房间仍可用): boom"]);
  });

  it("品牌失败:附注承诺下次启动自动补(身份自愈兜底),不阻塞挂链", async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops } = makeTracingRoomOps({ setRoomAvatar: vi.fn().mockRejectedValue(new Error("boom")) });
    const r = await m.space.provisionManagedRoom(ops, store, {
      kind: "project",
      name: "myapp(box1)",
      inviteUserId: "@barry:server",
      projectName: "myapp",
    });
    expect(r.notes).toEqual(["头像设置失败(下次启动自动补): boom"]);
    expect(ops.addRoomToSpace).toHaveBeenCalledWith("!space:server", "!newroom:server");
  });

  it("挂链与品牌都失败:两条附注按步骤顺序排列", async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops } = makeTracingRoomOps({
      addRoomToSpace: vi.fn().mockRejectedValue(new Error("link-boom")),
      setRoomAvatar: vi.fn().mockRejectedValue(new Error("avatar-boom")),
    });
    const r = await m.space.provisionManagedRoom(ops, store, {
      kind: "project",
      name: "myapp(box1)",
      inviteUserId: "@barry:server",
      projectName: "myapp",
    });
    expect(r.notes).toEqual([
      "挂入空间失败(不影响项目): link-boom",
      "头像设置失败(下次启动自动补): avatar-boom",
    ]);
  });

  it("提权失败:记入 elevationError、不阻塞挂链与品牌", async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops } = makeTracingRoomOps({
      setUserPowerLevel: vi.fn().mockRejectedValue(new Error("没有权限")),
    });
    const r = await m.space.provisionManagedRoom(ops, store, {
      kind: "project",
      name: "myapp(box1)",
      inviteUserId: "@barry:server",
      projectName: "myapp",
    });
    expect(r.elevationError?.message).toBe("没有权限");
    expect(r.notes).toEqual([]);
    expect(ops.addRoomToSpace).toHaveBeenCalledWith("!space:server", "!newroom:server");
    expect(ops.setRoomAvatar).toHaveBeenCalledWith("!newroom:server", "mxc://server/avatar", expect.anything());
  });

  it("提权幂等:已在本房 100 级的信任用户不再写、不再记账", async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops } = makeTracingRoomOps({
      getPowerLevels: vi.fn().mockResolvedValue({ users: { "@barry:server": 100 } }),
    });
    const r = await m.space.provisionManagedRoom(ops, store, {
      kind: "project",
      name: "myapp(box1)",
      inviteUserId: "@barry:server",
      projectName: "myapp",
    });
    expect(ops.setUserPowerLevel).not.toHaveBeenCalled();
    expect(r.elevationError).toBeUndefined();
    expect(store.get().powerElevatedUsers).toBeUndefined();
  });

  it("空间未物化(功能关停或降级)时跳过挂链,其余步骤照做", async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: false }));
    const { ops } = makeTracingRoomOps();
    const r = await m.space.provisionManagedRoom(ops, store, {
      kind: "project",
      name: "myapp(box1)",
      inviteUserId: "@barry:server",
      projectName: "myapp",
    });
    expect(r.notes).toEqual([]);
    expect(ops.addRoomToSpace).not.toHaveBeenCalled();
    expect(ops.setRoomAvatar).toHaveBeenCalledWith("!newroom:server", "mxc://server/avatar", expect.anything());
  });

  // ---- 启动 ensure 的新增内联行为的失败钉点 ----------------------------------

  it("启动 ensure:品牌失败仅警告,tri-state 仍 ready、管理房已落簿", async () => {
    const m = await importModules();
    const warnSpy = vi.spyOn(m.loggerModule.logger, "warn");
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops } = makeTracingRoomOps({ setRoomAvatar: vi.fn().mockRejectedValue(new Error("boom")) });
    const result = await m.space.ensureSpaceAndManagementRoom({
      roomOps: ops,
      store,
      sendReply: vi.fn().mockResolvedValue(undefined),
    });
    expect(result).toBe("ready");
    expect(store.get().managementRooms).toEqual(["!mgmt:server"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("头像设置失败"));
  });

  it("启动 ensure:提权失败不翻转 tri-state(管理房已落簿,启动扫描稍后自愈)", async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore(baseConfig({ enabled: true, roomId: "!space:server" }));
    const { ops } = makeTracingRoomOps({
      setUserPowerLevel: vi.fn().mockRejectedValue(new Error("没有权限")),
    });
    const sendReply = vi.fn().mockResolvedValue(undefined);
    const result = await m.space.ensureSpaceAndManagementRoom({ roomOps: ops, store, sendReply });
    expect(result).toBe("ready");
    expect(store.get().managementRooms).toEqual(["!mgmt:server"]);
    // 管理房使用说明照发(置备失败不阻塞指南投递)。
    expect(sendReply).toHaveBeenCalledWith("!mgmt:server", "matrix", expect.stringContaining("项目管理房间"));
  });

  it("管理房 E2EE 判定随深函数:配置关加密时建房不带加密态", async () => {
    const m = await importModules();
    const store = new m.config.ConfigStore({
      ...baseConfig({ enabled: true, roomId: "!space:server" }),
      matrix: { homeserverUrl: "https://matrix.example", accessToken: "tok", encryption: false },
    });
    const { ops } = makeTracingRoomOps();
    await m.space.ensureSpaceAndManagementRoom({
      roomOps: ops,
      store,
      sendReply: vi.fn().mockResolvedValue(undefined),
    });
    expect(ops.createRoom).toHaveBeenCalledWith(expect.objectContaining({ encrypted: false }));
  });
});
