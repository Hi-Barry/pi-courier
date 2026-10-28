import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiRpc } from "../src/rpc/pi-rpc.js";
import {
  AllAgentsIdleTimeoutError,
  probeAllAgents,
  waitForAllAgentsIdle,
} from "../src/rpc/command-map.js";

/** 假 rpc:requireClient().getState() 按 behavior 行事;"throw" = 未连接
 *  (requireClient 同步抛的等价形态 —— getState 即抛)。 */
function fakeRpc(
  behavior: (() => { isStreaming: boolean }) | { isStreaming: boolean } | "throw"
): PiRpc {
  const getState =
    behavior === "throw"
      ? vi.fn(async () => {
          throw new Error("pi RPC not connected");
        })
      : vi.fn(async () => (typeof behavior === "function" ? behavior() : behavior));
  return { requireClient: () => ({ getState }) } as unknown as PiRpc;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("probeAllAgents(发起时的一次性全实例探测)", () => {
  it("全空闲:{streaming:0, unreachable:0}", async () => {
    const probe = await probeAllAgents([fakeRpc({ isStreaming: false }), fakeRpc({ isStreaming: false })]);
    expect(probe).toEqual({ streaming: 0, unreachable: 0 });
  });

  it("单实例在跑计 streaming;单实例抛错计 unreachable —— 查不动 ≠ 空闲", async () => {
    const probe = await probeAllAgents([
      fakeRpc({ isStreaming: true }),
      fakeRpc({ isStreaming: false }),
      fakeRpc("throw"),
    ]);
    expect(probe).toEqual({ streaming: 1, unreachable: 1 });
  });

  it("全部查不动:unreachable 全额计入", async () => {
    const probe = await probeAllAgents([fakeRpc("throw"), fakeRpc("throw")]);
    expect(probe).toEqual({ streaming: 0, unreachable: 2 });
  });

  it("空实例集:真全空闲", async () => {
    expect(await probeAllAgents([])).toEqual({ streaming: 0, unreachable: 0 });
  });
});

describe("waitForAllAgentsIdle(全实例轮询原语,不订阅 agent_settled)", () => {
  it("已全空闲时立即返回,不需要任何后续事件", async () => {
    const rpc = fakeRpc({ isStreaming: false });
    await expect(waitForAllAgentsIdle([rpc], { timeoutMs: 1_000 })).resolves.toBeUndefined();
  });

  it("先流式后空闲:轮询到全空闲即返回(fake timers 推进轮询间隔)", async () => {
    vi.useFakeTimers();
    let streaming = true;
    const rpc = fakeRpc(() => ({ isStreaming: streaming }));
    const promise = waitForAllAgentsIdle([rpc], { intervalMs: 150, timeoutMs: 5_000 });
    const assertion = expect(promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(150); // 第一轮:仍在跑
    streaming = false;
    await vi.advanceTimersByTimeAsync(150); // 第二轮:空闲
    await assertion;
  });

  it("永不空闲时按超时抛类型化错误,detail 带最终计数", async () => {
    vi.useFakeTimers();
    const promise = waitForAllAgentsIdle([fakeRpc({ isStreaming: true }), fakeRpc("throw")], {
      intervalMs: 150,
      timeoutMs: 1_000,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(AllAgentsIdleTimeoutError);
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;
    // 计数可读:区分「任务真没跑完」与「实例挂了导致的假等待」。
    await promise.catch((err: AllAgentsIdleTimeoutError) => {
      expect(err.probe).toEqual({ streaming: 1, unreachable: 1 });
    });
  });

  it("全部实例查不动:不视为空闲,一路等到超时(宁多等不误杀)", async () => {
    vi.useFakeTimers();
    const promise = waitForAllAgentsIdle([fakeRpc("throw")], { intervalMs: 150, timeoutMs: 300 });
    const assertion = expect(promise).rejects.toBeInstanceOf(AllAgentsIdleTimeoutError);
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
  });

  it("shouldAbort 返回 true 时立即返回,不再探测", async () => {
    const rpc = fakeRpc({ isStreaming: true });
    await expect(waitForAllAgentsIdle([rpc], { shouldAbort: () => true })).resolves.toBeUndefined();
  });

  it("onTick 每轮探测后被调,携带当轮计数", async () => {
    vi.useFakeTimers();
    const ticks: Array<{ streaming: number; unreachable: number }> = [];
    let streaming = true;
    const rpc = fakeRpc(() => ({ isStreaming: streaming }));
    const promise = waitForAllAgentsIdle([rpc], {
      intervalMs: 150,
      timeoutMs: 5_000,
      onTick: (probe) => {
        ticks.push({ ...probe });
      },
    });
    const assertion = expect(promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(150); // 前 150ms 内至少一轮:仍在跑
    streaming = false;
    await vi.advanceTimersByTimeAsync(150); // 翻转后:轮询到空闲即返回
    await assertion;
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.at(-1)).toEqual({ streaming: 0, unreachable: 0 });
    expect(ticks.at(-2)).toEqual({ streaming: 1, unreachable: 0 });
  });
});
