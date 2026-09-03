import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config";
import { logger } from "../src/logger";
import { PiRpc } from "../src/rpc/pi-rpc";
import { ProjectManager } from "../src/rpc/project-manager";

/** Capture every console line (log + error) into one ordered buffer. */
function captureConsole(): string[] {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return lines;
}

function fakeRpc() {
  return {
    label: undefined as string | undefined,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
  };
}

function makePM(projects: Record<string, { name?: string; workdir: string }>, multiProject = true) {
  const rpcs: ReturnType<typeof fakeRpc>[] = [];
  const defaultRpc = fakeRpc() as unknown as PiRpc;
  const pm = new ProjectManager({
    defaultRpc,
    baseOptions: { args: ["--continue"] },
    onRoomEvent: () => {},
    multiProject,
    store: new ConfigStore({ projects, managementRooms: [], workdir: "/home/u/Projects", ...(multiProject ? { multiProject: true } : {}) }),
    rpcFactory: ((opts: { label?: string }) => {
      const r = fakeRpc();
      r.label = opts.label;
      rpcs.push(r);
      return r as unknown as PiRpc;
    }) as unknown as NonNullable<ConstructorParameters<typeof ProjectManager>[0]["rpcFactory"]>,
  });
  return { pm, rpcs, defaultRpc };
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
