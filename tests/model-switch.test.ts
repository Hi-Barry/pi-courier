import { describe, expect, it, vi } from "vitest";
import { nextFallbackTarget, setModelByRef } from "../src/rpc/model-switch";
import type { PiRpc } from "../src/rpc/pi-rpc";

function fakeRpc(models: Array<{ provider: string; id: string }>) {
  const client = {
    setModel: vi.fn().mockResolvedValue({ id: "set" }),
    getAvailableModels: vi.fn().mockResolvedValue(models),
  };
  const rpc = { requireClient: () => client } as unknown as PiRpc;
  return { rpc, client };
}

describe("setModelByRef (issues #119 / #121)", () => {
  it("applies provider/id refs verbatim", async () => {
    const { rpc, client } = fakeRpc([]);
    const result = await setModelByRef(rpc, "zai/glm-5.3");
    expect(result).toEqual({ provider: "zai", id: "glm-5.3" });
    expect(client.setModel).toHaveBeenCalledWith("zai", "glm-5.3");
  });

  it("resolves bare ids against the available-models list (exact match first)", async () => {
    const models = [
      { provider: "zai", id: "glm-5.3" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "opencode", id: "deepseek-v4-flash-turbo" },
    ];
    const { rpc, client } = fakeRpc(models);
    expect(await setModelByRef(rpc, "deepseek-v4-flash")).toEqual({ provider: "deepseek", id: "deepseek-v4-flash" });
    // 无精确命中时回落子串匹配(与 /model 的裸 id 语义一致)
    expect(await setModelByRef(rpc, "v4-flash-turbo")).toEqual({ provider: "opencode", id: "deepseek-v4-flash-turbo" });
    expect(client.setModel).toHaveBeenCalledTimes(2);
  });

  it("throws a replyable message when a bare id matches nothing", async () => {
    const { rpc } = fakeRpc([{ provider: "zai", id: "glm-5.3" }]);
    await expect(setModelByRef(rpc, "nope")).rejects.toThrow("model not found: nope");
  });
});

describe("nextFallbackTarget (issue #121)", () => {
  const chain = ["zai/glm-5.3", "deepseek/d1", "opencode/o1"];

  it("starts at the head when the current model is not on the chain", () => {
    expect(nextFallbackTarget(chain, { provider: "other", id: "x" })).toEqual({ provider: "zai", id: "glm-5.3" });
    expect(nextFallbackTarget(chain, undefined)).toEqual({ provider: "zai", id: "glm-5.3" });
  });

  it("advances past the current model's position and skips entries equal to it", () => {
    expect(nextFallbackTarget(chain, { provider: "zai", id: "glm-5.3" })).toEqual({ provider: "deepseek", id: "d1" });
    expect(nextFallbackTarget(chain, { provider: "deepseek", id: "d1" })).toEqual({ provider: "opencode", id: "o1" });
  });

  it("returns undefined at the chain tail (exhausted) and skips malformed entries", () => {
    expect(nextFallbackTarget(chain, { provider: "opencode", id: "o1" })).toBeUndefined();
    expect(nextFallbackTarget(["not-a-ref", "deepseek/d1"], undefined)).toEqual({ provider: "deepseek", id: "d1" });
    expect(nextFallbackTarget([], undefined)).toBeUndefined();
  });
});
