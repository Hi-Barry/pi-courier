import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config";
import { logger } from "../src/logger";
import { PiRpc } from "../src/rpc/pi-rpc";
import { ProjectManager } from "../src/rpc/project-manager";
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
  const defaultRpc = fakeRpc() as unknown as PiRpc;
  const store = new ConfigStore({ projects, managementRooms: [], workdir: "/home/u/Projects", ...(multiProject ? { multiProject: true } : {}) });
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
      return r as unknown as PiRpc;
    }) as unknown as NonNullable<ConstructorParameters<typeof ProjectManager>[0]["rpcFactory"]>,
    notifyRoom: (roomId, text) => notices.push({ roomId, text }),
  });
  return { pm, rpcs, defaultRpc, store, notices };
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
