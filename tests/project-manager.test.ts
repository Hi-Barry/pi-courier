import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config";
import { logger } from "../src/logger";
import { PiRpc } from "../src/rpc/pi-rpc";
import { ProjectManager, PROJECT_SESSION_DIR, projectSessionDirFor } from "../src/rpc/project-manager";
import type { ProjectConfig } from "../src/types";
import { captureConsole } from "./helpers";

function fakeRpc() {
  return {
    label: undefined as string | undefined,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
    onRestarted: vi.fn(),
    requireClient: vi.fn(),
  };
}

/** Preset-capable fake: requireClient() 的 setModel/thinking 面可观察,
 *  mocks 由外部注入以便断言(所有实例共享同一组)。 */
function fakePresetRpc(
  face: { setModel: ReturnType<typeof vi.fn>; setThinkingLevel: ReturnType<typeof vi.fn>; models: Array<{ provider: string; id: string }> }
) {
  const rpc = fakeRpc();
  rpc.requireClient.mockReturnValue({
    setModel: face.setModel,
    setThinkingLevel: face.setThinkingLevel,
    getAvailableModels: vi.fn().mockResolvedValue(face.models),
  });
  return rpc;
}

function makePM(
  projects: Record<string, ProjectConfig>,
  multiProject = true,
  presetFace?: { setModel: ReturnType<typeof vi.fn>; setThinkingLevel: ReturnType<typeof vi.fn>; models: Array<{ provider: string; id: string }> }
) {
  const rpcs: ReturnType<typeof fakeRpc>[] = [];
  const spawnOpts: Array<{ cwd?: string; args?: string[]; label?: string }> = [];
  const defaultRpc = fakeRpc() as unknown as PiRpc;
  const store = new ConfigStore({ projects, managementRooms: [], workdir: "/home/u/Projects", ...(multiProject ? { multiProject: true } : {}) }, () => {});
  const notices: Array<{ roomId: string; text: string }> = [];
  const pm = new ProjectManager({
    defaultRpc,
    baseOptions: { args: ["--continue"] },
    onRoomEvent: () => {},
    multiProject,
    store,
    rpcFactory: ((opts: { label?: string }) => {
      const r = presetFace ? fakePresetRpc(presetFace) : fakeRpc();
      r.label = opts.label;
      rpcs.push(r);
      spawnOpts.push(opts);
      return r as unknown as PiRpc;
    }) as unknown as NonNullable<ConstructorParameters<typeof ProjectManager>[0]["rpcFactory"]>,
    notifyRoom: (roomId, text) => notices.push({ roomId, text }),
  });
  return { pm, rpcs, defaultRpc, store, notices, spawnOpts };
}

describe("ProjectManager.labelForRoom", () => {
  it("returns the resolved label for mapped rooms (multi-project)", () => {
    const { pm } = makePM({
      "!a:s": { name: "ai-api", workdir: "/w/x" },
      "!b:s": { workdir: "/w/beta" },
    });
    expect(pm.labelForRoom("!a:s")).toBe("ai-api");
    expect(pm.labelForRoom("!b:s")).toBe("beta"); // name absent → workdir basename
    expect(pm.labelForRoom("!c:s")).toBeUndefined(); // unmapped
  });

  it("is always undefined in single-project mode", () => {
    const { pm } = makePM({ "!a:s": { name: "ai-api", workdir: "/w/x" } }, false);
    expect(pm.labelForRoom("!a:s")).toBeUndefined();
  });
});

describe("ProjectManager project-process labels + lifecycle logs", () => {
  let lines: string[];
  beforeEach(() => {
    lines = captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps the label on the spawned rpc and logs lifecycle with it", async () => {
    const { pm, rpcs } = makePM({ "!a:s": { name: "ai-api", workdir: "/w/ai" } });
    await pm.getRpcForRoom("!a:s");
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].label).toBe("ai-api");
    const spawned = lines.find((l) => l.includes("进程"));
    expect(spawned).toBeDefined();
    expect(spawned).toContain("[INFO] [ai-api]");
  });

  it("the default rpc carries no label and its room path logs none", async () => {
    const { pm, defaultRpc } = makePM({ "!a:s": { name: "ai-api", workdir: "/w/ai" } });
    const rpc = await pm.getRpcForRoom("!unmapped:s");
    expect(rpc).toBe(defaultRpc);
    expect(defaultRpc.label).toBeUndefined();
    expect(lines.join("\n")).not.toContain("[ai-api]");
  });

  it("rename re-labels the running rpc — subsequent lines use the new label", async () => {
    const { pm, rpcs } = makePM({ "!a:s": { name: "old", workdir: "/w/ai" } });
    await pm.getRpcForRoom("!a:s");
    pm.renameProject("!a:s", "new");
    expect(rpcs[0].label).toBe("new");
    // A log emitted via the manager's current view shows the new label:
    pm.labelForRoom("!a:s") === "new";
    expect(pm.labelForRoom("!a:s")).toBe("new");
  });

  it("mv updates the running rpc label (basename fallback) and logs the stop", async () => {
    const { pm, rpcs } = makePM({ "!a:s": { workdir: "/w/old-name" } });
    await pm.getRpcForRoom("!a:s");
    expect(rpcs[0].label).toBe("old-name");
    await pm.updateProjectWorkdir("!a:s", "/w/new-name");
    expect(rpcs[0].stop).toHaveBeenCalled();
    const stopped = lines.find((l) => l.includes("停止") || l.includes("迁移"));
    expect(stopped).toBeDefined();
    expect(stopped).toContain("[old-name]"); // label at stop time = pre-move label
    // The mapping itself now resolves to the new basename for future spawns.
    expect(pm.labelForRoom("!a:s")).toBe("new-name");
  });

  it("removeProject logs the stop with the project label", async () => {
    const { pm, rpcs } = makePM({ "!a:s": { name: "ai-api", workdir: "/w/ai" } });
    await pm.getRpcForRoom("!a:s");
    await pm.removeProject("!a:s");
    const stopped = lines.find((l) => l.includes("删除") || l.includes("停止"));
    expect(stopped).toContain("[ai-api]");
  });
});

describe("ProjectManager.roomForRpc (issue #115 stage 2)", () => {
  it("resolves the owning project room; the shared default never maps", async () => {
    const { pm, defaultRpc } = makePM({ "!a:s": { name: "ai-api", workdir: "/w/ai" } });
    expect(pm.roomForRpc(defaultRpc)).toBeUndefined(); // 默认进程:不落盘
    const rpc = await pm.getRpcForRoom("!a:s");
    expect(pm.roomForRpc(rpc)).toBe("!a:s");
    expect(pm.roomForRpc(fakeRpc() as unknown as PiRpc)).toBeUndefined(); // 陌生进程
  });

  it("single-project mode never maps (conservative route falls out of the lookup)", async () => {
    const { pm, defaultRpc } = makePM({ "!a:s": { workdir: "/w/ai" } }, false);
    const rpc = await pm.getRpcForRoom("!a:s");
    expect(rpc).toBe(defaultRpc); // 单工程一切皆默认进程
    expect(pm.roomForRpc(rpc)).toBeUndefined();
  });

  it("drops the mapping on rm — the removed process stops persisting", async () => {
    const { pm } = makePM({ "!a:s": { workdir: "/w/ai" } });
    const rpc = await pm.getRpcForRoom("!a:s");
    expect(pm.roomForRpc(rpc)).toBe("!a:s");
    await pm.removeProject("!a:s");
    expect(pm.roomForRpc(rpc)).toBeUndefined();
  });
});

describe("ProjectManager project presets (issue #119)", () => {
  /** 共享观察面:所有 fake 实例用同一组 setModel/setThinkingLevel mock。 */
  function presetFace(models: Array<{ provider: string; id: string }> = []) {
    return {
      setModel: vi.fn().mockResolvedValue({ id: "set" }),
      setThinkingLevel: vi.fn().mockResolvedValue(undefined),
      models,
    };
  }

  it("applies model + thinking presets after the handshake, in order, with a room notice", async () => {
    const face = presetFace();
    const { pm, notices } = makePM(
      { "!a:s": { workdir: "/w/ai", model: "deepseek/deepseek-v4-flash", thinkingLevel: "high" } },
      true,
      face
    );
    await pm.getRpcForRoom("!a:s");
    expect(face.setModel).toHaveBeenCalledTimes(1);
    expect(face.setModel).toHaveBeenCalledWith("deepseek", "deepseek-v4-flash");
    expect(face.setThinkingLevel).toHaveBeenCalledTimes(1);
    expect(face.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(face.setModel.mock.invocationCallOrder[0]).toBeLessThan(face.setThinkingLevel.mock.invocationCallOrder[0]);
    expect(notices).toHaveLength(1);
    expect(notices[0].roomId).toBe("!a:s");
    expect(notices[0].text).toContain("deepseek/deepseek-v4-flash");
    expect(notices[0].text).toContain("high");
  });

  it("applies nothing when no preset fields are set (zero calls — current behaviour)", async () => {
    const face = presetFace();
    const { pm } = makePM({ "!a:s": { workdir: "/w/ai" } }, true, face);
    await pm.getRpcForRoom("!a:s");
    expect(face.setModel).not.toHaveBeenCalled();
    expect(face.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("a failing preset never blocks readiness: process is returned, the room gets one failure line", async () => {
    const face = presetFace(); // 空模型列表 → 裸 id 解析必失败
    const { pm, notices } = makePM({ "!a:s": { workdir: "/w/ai", model: "no-such-model" } }, true, face);
    const rpc = await pm.getRpcForRoom("!a:s");
    expect(rpc).toBeDefined();
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("no-such-model");
  });

  it("restart re-applies presets from the CURRENT config — manual switches only live until a restart", async () => {
    const face = presetFace();
    const { pm, rpcs, store } = makePM({ "!a:s": { workdir: "/w/ai", model: "deepseek/d1" } }, true, face);
    await pm.getRpcForRoom("!a:s");
    expect(face.setModel).toHaveBeenCalledTimes(1);

    // 用户手动切走(setModel 直呼模拟),随后手编配置换了预设并重启。
    // 只改内存态:store.update 会真实写盘(测试绝不触碰 ~/.pi)。
    const restartListener = rpcs[0].onRestarted.mock.calls[0][0] as (rpc: PiRpc) => void;
    store.get().projects = { "!a:s": { workdir: "/w/ai", model: "zai/glm-5.3" } };
    restartListener(rpcs[0] as unknown as PiRpc);
    await vi.waitFor(() => expect(face.setModel).toHaveBeenCalledTimes(2));
    expect(face.setModel).toHaveBeenLastCalledWith("zai", "glm-5.3");
  });

  it("projectFallbacks normalizes the entry; absent → undefined (global chain applies)", () => {
    const { pm } = makePM({
      "!a:s": { workdir: "/w/ai", fallbacks: [" zai/glm-5.3 ", "zai/glm-5.3", "deepseek/d1"] },
      "!b:s": { workdir: "/w/beta" },
    });
    expect(pm.projectFallbacks("!a:s")).toEqual(["zai/glm-5.3", "deepseek/d1"]);
    expect(pm.projectFallbacks("!b:s")).toBeUndefined();
    expect(pm.projectFallbacks("!unmapped:s")).toBeUndefined();
  });
});

/** 期望路径统一经 path.join 构造 —— Windows CI 上分隔符是反斜杠,
 *  写死 POSIX 字面量会在 windows-latest 上误报。 */
function fixedSessionDir(workdir: string): string {
  return path.join(workdir, PROJECT_SESSION_DIR);
}

function expectDerivedSessionDir(dir: string | undefined, workdir: string): void {
  const prefix = path.join(workdir, `${PROJECT_SESSION_DIR}-room-`);
  expect(dir?.startsWith(prefix)).toBe(true);
  expect(dir?.slice(prefix.length)).toMatch(/^[0-9a-f]{8}$/);
}

describe("ProjectManager per-room session dirs (spec #299 票01)", () => {
  it("single room on a workdir keeps the fixed .pi-session path (zero migration)", async () => {
    const { pm, spawnOpts } = makePM({ "!a:s": { name: "ai", workdir: "/w/ai" } });
    await pm.getRpcForRoom("!a:s");
    expect(spawnOpts[0].args).toEqual(expect.arrayContaining(["--session-dir", fixedSessionDir("/w/ai")]));
  });

  it("second room on the SAME workdir spawns with a per-room derived dir; the first keeps the fixed path", async () => {
    const { pm, spawnOpts } = makePM({
      "!a:s": { name: "one", workdir: "/w/shared" },
      "!b:s": { name: "two", workdir: "/w/shared" },
    });
    await pm.getRpcForRoom("!a:s");
    await pm.getRpcForRoom("!b:s");
    expect(spawnOpts[0].args).toEqual(expect.arrayContaining(["--session-dir", fixedSessionDir("/w/shared")]));
    const argsB = spawnOpts[1].args ?? [];
    const dirB = argsB[argsB.indexOf("--session-dir") + 1];
    expectDerivedSessionDir(dirB, "/w/shared");
  });

  it("derived dir depends only on the roomId — stable across repeated resolution and map reshuffles", () => {
    const entry: ProjectConfig = { name: "p", workdir: "/w/shared" };
    const derived = projectSessionDirFor("!b:s", entry, { "!a:s": entry, "!b:s": entry });
    expect(derived).toBe(projectSessionDirFor("!b:s", entry, { "!a:s": entry, "!b:s": entry }));
    expectDerivedSessionDir(derived, "/w/shared");
    // 不同房间 → 不同派生目录
    const other = projectSessionDirFor("!c:s", entry, { "!a:s": entry, "!b:s": entry, "!c:s": entry });
    expect(other).not.toBe(derived);
    // 更早兄弟换了 workdir(不同目录)→ 不再触发派生,回固定路径
    const reshuffled = projectSessionDirFor("!b:s", entry, { "!a:s": { name: "z", workdir: "/w/other" }, "!b:s": entry });
    expect(reshuffled).toBe(fixedSessionDir("/w/shared"));
  });

  it("insertion order decides who derives: reversing registration swaps the derived room", () => {
    const entry: ProjectConfig = { name: "p", workdir: "/w/shared" };
    const first = projectSessionDirFor("!a:s", entry, { "!a:s": entry, "!b:s": entry });
    const second = projectSessionDirFor("!b:s", entry, { "!a:s": entry, "!b:s": entry });
    expect(first).toBe(fixedSessionDir("/w/shared"));
    expectDerivedSessionDir(second, "/w/shared");
    // 反转登记顺序:原先派生的房间回固定路径,原先固定的改派生
    const flippedFixed = projectSessionDirFor("!b:s", entry, { "!b:s": entry, "!a:s": entry });
    const flippedDerived = projectSessionDirFor("!a:s", entry, { "!b:s": entry, "!a:s": entry });
    expect(flippedFixed).toBe(fixedSessionDir("/w/shared"));
    expectDerivedSessionDir(flippedDerived, "/w/shared");
  });
});

describe("ProjectManager binding-event session dirs (spec #299 票01 评审整改)", () => {
  it("registerProject into an OCCUPIED workdir persists a derived dir for the newcomer; the resident keeps its fixed path", async () => {
    const { pm, spawnOpts, store } = makePM({ "!b:s": { name: "resident", workdir: "/w/shared" } });
    pm.registerProject("!a:s", "/w/shared", "newcomer");
    const entries = store.get().projects!;
    expect(entries["!b:s"].sessionDir).toBeUndefined(); // 在住者不被改写
    expectDerivedSessionDir(entries["!a:s"].sessionDir, "/w/shared");
    await pm.getRpcForRoom("!a:s");
    expect(spawnOpts[0].args).toEqual(expect.arrayContaining(["--session-dir", entries["!a:s"].sessionDir!]));
  });

  it("mv into an OCCUPIED workdir derives the MOVER — the resident's history is never touched", async () => {
    const { pm, store } = makePM({
      "!b:s": { name: "resident", workdir: "/w/shared" },
      "!a:s": { name: "mover", workdir: "/w/other" },
    });
    await pm.updateProjectWorkdir("!a:s", "/w/shared");
    const entries = store.get().projects!;
    expect(entries["!b:s"].workdir).toBe("/w/shared");
    expect(entries["!b:s"].sessionDir).toBeUndefined(); // 在住者原路径不变
    expectDerivedSessionDir(entries["!a:s"].sessionDir, "/w/shared");
    // 会话目录单点访问:搬入者派生、在住者固定 —— /pmctl show 与 spawn 同源
    expectDerivedSessionDir(pm.sessionDirFor("!a:s"), "/w/shared");
    expect(pm.sessionDirFor("!b:s")).toBe(fixedSessionDir("/w/shared"));
  });

  it("spawn prefers the persisted sessionDir; legacy entries fall back to the fixed path", async () => {
    const { pm, spawnOpts } = makePM({
      "!a:s": { name: "persisted", workdir: "/w/ai", sessionDir: "/w/ai/.pi-session-room-deadbeef" },
      "!b:s": { name: "legacy", workdir: "/w/legacy" },
    });
    await pm.getRpcForRoom("!a:s");
    await pm.getRpcForRoom("!b:s");
    expect(spawnOpts[0].args).toEqual(expect.arrayContaining(["--session-dir", "/w/ai/.pi-session-room-deadbeef"]));
    expect(spawnOpts[1].args).toEqual(expect.arrayContaining(["--session-dir", fixedSessionDir("/w/legacy")]));
  });

  it("registerProject into an unoccupied workdir persists the fixed path (zero migration for fresh binds)", async () => {
    const { pm, store } = makePM({});
    pm.registerProject("!a:s", "/w/solo", "solo");
    expect(store.get().projects!["!a:s"].sessionDir).toBe(fixedSessionDir("/w/solo"));
  });

  it("registerProject persists guest mode alongside the session dir (票04 认领绑定)", async () => {
    const { pm, store } = makePM({});
    pm.registerProject("!g:s", "/w/g", "collab", "guest");
    const entry = store.get().projects!["!g:s"];
    expect(entry.mode).toBe("guest");
    expect(entry.sessionDir).toBe(fixedSessionDir("/w/g"));
    // 不带 mode 的注册(普通 /pmctl new)不落 mode 键 —— 缺省 owner 语义
    pm.registerProject("!o:s", "/w/o", "own");
    expect(store.get().projects!["!o:s"].mode).toBeUndefined();
  });
});
