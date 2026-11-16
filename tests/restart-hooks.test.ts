/**
 * RpcRestartHooks 键控注册表测试(#354,评审卡4):once 幂等、不同键各自
 * 入列、触发时按登记序广播、跨 rpc 互不串。
 */
import { describe, expect, it, vi } from "vitest";
import type { PiRpc } from "../src/rpc/pi-rpc.js";
import { RpcRestartHooks } from "../src/rpc/restart-hooks.js";

/** 假 rpc(只当 WeakMap 键用)。 */
function fakeRpc(): PiRpc {
  return { onRestarted: vi.fn() } as unknown as PiRpc;
}

/** 订阅缝:记录 handler,测试手动触发(模拟子进程重启)。 */
function harness() {
  const handlers: Array<() => void> = [];
  const subscribe = vi.fn((_rpc: PiRpc, handler: () => void) => {
    handlers.push(handler);
  });
  return { hooks: new RpcRestartHooks(subscribe), handlers, subscribe };
}

describe("RpcRestartHooks · 键控 once(#354)", () => {
  it("同键重复登记幂等:钩子只入列一次,订阅只挂一次", () => {
    const { hooks, handlers, subscribe } = harness();
    const rpc = fakeRpc();
    const hook = vi.fn();
    hooks.once(rpc, "tool-turn-card", hook);
    hooks.once(rpc, "tool-turn-card", hook); // 每次开卡都会重复登记
    hooks.once(rpc, "tool-turn-card", vi.fn()); // 不同实例同键也不入列
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(handlers).toHaveLength(1);
    handlers[0]!();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("不同键各自入列,触发按登记序广播", () => {
    const { hooks, handlers } = harness();
    const rpc = fakeRpc();
    const order: string[] = [];
    hooks.once(rpc, "fallback-streak", () => order.push("fallback"));
    hooks.once(rpc, "tool-turn-card", () => order.push("tool-card"));
    hooks.once(rpc, "workflow-card", () => order.push("workflow"));
    handlers[0]!();
    expect(order).toEqual(["fallback", "tool-card", "workflow"]);
  });

  it("同 rpc 的订阅只挂一次;后续键直接追加进已就绪的广播列表", () => {
    const { hooks, handlers, subscribe } = harness();
    const rpc = fakeRpc();
    hooks.once(rpc, "tool-turn-card", () => {});
    expect(subscribe).toHaveBeenCalledTimes(1);
    hooks.once(rpc, "workflow-card", () => {});
    expect(subscribe).toHaveBeenCalledTimes(1); // 不重复订阅
    expect(handlers).toHaveLength(1);
  });

  it("跨 rpc 互不串:各自广播各自的钩子", () => {
    const { hooks, handlers } = harness();
    const a = fakeRpc();
    const b = fakeRpc();
    const hitA = vi.fn();
    const hitB = vi.fn();
    hooks.once(a, "tool-turn-card", hitA);
    hooks.once(b, "tool-turn-card", hitB);
    handlers[0]!(); // a 的重启
    expect(hitA).toHaveBeenCalledTimes(1);
    expect(hitB).not.toHaveBeenCalled();
    handlers[1]!(); // b 的重启
    expect(hitB).toHaveBeenCalledTimes(1);
    expect(hitA).toHaveBeenCalledTimes(1); // a 不被 b 的重启再触发
  });
});
