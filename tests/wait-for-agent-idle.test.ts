import { describe, expect, it, vi } from "vitest";
import { waitForAgentIdle } from "../src/rpc/command-map.js";

describe("waitForAgentIdle(轮询,不吃 agent_settled 竞态)", () => {
  it("已空闲时立即返回,不需要任何后续事件", async () => {
    const client = { getState: vi.fn().mockResolvedValue({ isStreaming: false }) };
    await expect(waitForAgentIdle(client, 1_000)).resolves.toBeUndefined();
    expect(client.getState).toHaveBeenCalledTimes(1);
  });

  it("先流式后空闲:轮询到不流式即返回(abort 在订阅前 settle 的竞态场景)", async () => {
    let streaming = true;
    const client = {
      getState: vi.fn().mockImplementation(async () => {
        // 首次 getState 前就翻转 —— 模拟 abort 先于事件订阅 settle
        streaming = false;
        return { isStreaming: streaming };
      }),
    };
    await expect(waitForAgentIdle(client, 5_000)).resolves.toBeUndefined();
  });

  it("永不空闲时按超时拒绝", async () => {
    const client = { getState: vi.fn().mockResolvedValue({ isStreaming: true }) };
    await expect(waitForAgentIdle(client, 300)).rejects.toThrow("did not become idle");
  });
});
