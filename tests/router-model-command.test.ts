/**
 * /model 切换回执(issue #344):成功回执必须带上厂商,不能只回裸模型 id。
 * 只测命令层外部行为 —— 回执文案;setModel 调用参数原样。
 */
import { describe, expect, it, vi } from "vitest";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { makeMsg, makeRouterFixture } from "./helpers";

function makeModelRpc(
  setModelResult: unknown,
  models: Array<{ provider: string; id: string }> = []
) {
  const setModel = vi.fn().mockResolvedValue(setModelResult);
  const getAvailableModels = vi.fn().mockResolvedValue(models);
  const rpc = {
    requireClient: () => ({ setModel, getAvailableModels }),
  } as unknown as PiRpc;
  return { rpc, setModel, getAvailableModels };
}

describe("/model 切换回执带厂商 (issue #344)", () => {
  it("provider-qualified switch replies provider/id", async () => {
    const { rpc, setModel } = makeModelRpc({ provider: "zai", id: "glm-5.3" });
    const fx = makeRouterFixture({ rpc });
    await fx.router.handleIncoming(makeMsg({ text: "/model zai/glm-5.3" }));
    expect(setModel).toHaveBeenCalledWith("zai", "glm-5.3");
    expect(fx.sendReply).toHaveBeenCalledTimes(1);
    expect(fx.sendReply.mock.calls[0]?.[2]).toBe("✅ 已切换模型: zai/glm-5.3");
  });

  it("bare-id switch still shows the resolved provider", async () => {
    const { rpc, setModel } = makeModelRpc({ provider: "opencode", id: "deepseek-v4-flash-turbo" }, [
      { provider: "opencode", id: "deepseek-v4-flash-turbo" },
    ]);
    const fx = makeRouterFixture({ rpc });
    await fx.router.handleIncoming(makeMsg({ text: "/model deepseek-v4-flash-turbo" }));
    expect(setModel).toHaveBeenCalledWith("opencode", "deepseek-v4-flash-turbo");
    expect(fx.sendReply.mock.calls[0]?.[2]).toBe("✅ 已切换模型: opencode/deepseek-v4-flash-turbo");
  });

  it("upstream reply missing fields falls back to the requested provider/id", async () => {
    const { rpc } = makeModelRpc({});
    const fx = makeRouterFixture({ rpc });
    await fx.router.handleIncoming(makeMsg({ text: "/model zai/glm-5.3" }));
    expect(fx.sendReply.mock.calls[0]?.[2]).toBe("✅ 已切换模型: zai/glm-5.3");
  });
});
