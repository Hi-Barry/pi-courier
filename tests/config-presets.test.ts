import { describe, expect, it } from "vitest";
import {
  modelFallbackChain,
  normalizeModelRefList,
  parseModelRef,
  presetProblems,
  projectFallbackChain,
  THINKING_LEVELS,
} from "../src/config";
import type { MsgBridgeConfig } from "../src/types";

describe("parseModelRef (issue #119/#121)", () => {
  it("accepts provider/id and keeps the full id (ids may contain slashes)", () => {
    expect(parseModelRef("zai/glm-5.3")).toEqual({ provider: "zai", id: "glm-5.3" });
    expect(parseModelRef("openai/o3/gpt")).toEqual({ provider: "openai", id: "o3/gpt" });
  });

  it("rejects bare ids, empty halves and whitespace-only input", () => {
    expect(parseModelRef("glm-5.3")).toBeUndefined();
    expect(parseModelRef("/glm-5.3")).toBeUndefined();
    expect(parseModelRef("zai/")).toBeUndefined();
    expect(parseModelRef("")).toBeUndefined();
  });
});

describe("normalizeModelRefList", () => {
  it("trims, drops empties/non-strings and dedupes in order", () => {
    expect(normalizeModelRefList([" zai/glm-5.3 ", "", "deepseek/d1", "zai/glm-5.3", 42 as unknown as string])).toEqual([
      "zai/glm-5.3",
      "deepseek/d1",
    ]);
  });

  it("tolerates absent / non-array input as an empty list", () => {
    expect(normalizeModelRefList(undefined)).toEqual([]);
    expect(normalizeModelRefList("zai/glm-5.3" as unknown as string[])).toEqual([]);
  });
});

describe("modelFallbackChain / projectFallbackChain (issue #121)", () => {
  it("derives the global chain from config", () => {
    const cfg = { modelFallbacks: ["zai/glm-5.3", " zai/glm-5.3", "deepseek/d1"] } as MsgBridgeConfig;
    expect(modelFallbackChain(cfg)).toEqual(["zai/glm-5.3", "deepseek/d1"]);
    expect(modelFallbackChain({} as MsgBridgeConfig)).toEqual([]); // 缺省 = 功能关
  });

  it("project chain override: configured → normalized; absent → undefined (use global)", () => {
    expect(projectFallbackChain({ fallbacks: [" a/b"] })).toEqual(["a/b"]);
    expect(projectFallbackChain({ fallbacks: [] })).toEqual([]);
    expect(projectFallbackChain({})).toBeUndefined();
    expect(projectFallbackChain(undefined)).toBeUndefined();
  });
});

describe("presetProblems (issue #119/#121)", () => {
  it("accepts fully valid presets and chains", () => {
    const cfg: MsgBridgeConfig = {
      projects: {
        "!a:s": { workdir: "/w", model: "deepseek/deepseek-v4-flash", thinkingLevel: "high", fallbacks: ["zai/glm-5.3"] },
      },
      modelFallbacks: ["zai/glm-5.3"],
    };
    expect(presetProblems(cfg)).toEqual([]);
  });

  it("flags malformed model refs with their config path", () => {
    const cfg: MsgBridgeConfig = {
      projects: { "!a:s": { workdir: "/w", model: "deepseek-v4-flash" } },
      modelFallbacks: ["zai/glm-5.3", "kimi"],
    };
    expect(presetProblems(cfg)).toEqual([
      { path: "projects.!a:s:model", code: "modelRef", value: "deepseek-v4-flash" },
      { path: "modelFallbacks", code: "modelRef", value: "kimi" },
    ]);
  });

  it("flags unknown thinking levels and names the valid set", () => {
    const cfg: MsgBridgeConfig = { projects: { "!a:s": { workdir: "/w", thinkingLevel: "ultra" } } };
    expect(presetProblems(cfg)).toEqual([
      { path: "projects.!a:s:thinkingLevel", code: "thinkingLevel", value: "ultra" },
    ]);
    expect(THINKING_LEVELS).toContain("high");
  });

  it("flags non-array fallbacks for both projects and the global chain", () => {
    const cfg = {
      projects: { "!a:s": { workdir: "/w", fallbacks: "zai/glm-5.3" } },
      modelFallbacks: "zai/glm-5.3",
    } as unknown as MsgBridgeConfig;
    expect(presetProblems(cfg)).toEqual([
      { path: "projects.!a:s:fallbacks", code: "fallbacksList" },
      { path: "modelFallbacks", code: "fallbacksList" },
    ]);
  });

  it("tolerates unknown project fields (forward compatibility) and empty configs", () => {
    const cfg = {
      projects: { "!a:s": { workdir: "/w", persona: "snarky" } },
    } as unknown as MsgBridgeConfig;
    expect(presetProblems(cfg)).toEqual([]);
    expect(presetProblems({} as MsgBridgeConfig)).toEqual([]);
  });
});
