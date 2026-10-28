/**
 * pi RPC 自动拉起(spec #247 票05):意外死亡 → 监听器保留路径重拉、主动
 * 路径不拉起、标志复位生命周期、指数退避、上限熔断、人工 restart 清零。
 * 白盒:fake 客户端直塞私有槽(先例:pi-rpc-send/drain 测试),不真拉起
 * pi —— start 以 spy 顶替,监听器保留路径由 restartInternal 既有机制验证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiRpc, respawnBackoffMs } from "../src/rpc/pi-rpc";

interface FakeClient {
  stop: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  process: { once: ReturnType<typeof vi.fn> };
}

function makeFakeClient(): FakeClient {
  return {
    stop: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    process: { once: vi.fn() },
  };
}

/** 连上模拟:doStart 握手成功的统一入口(复位标志 + 挂 exit 感知)。 */
function connect(rpc: PiRpc, client: FakeClient): void {
  (rpc as unknown as { onClientConnected: (c: unknown) => void }).onClientConnected(client);
}

function exitHandlerOf(client: FakeClient): () => void {
  expect(client.process.once).toHaveBeenCalledWith("exit", expect.any(Function));
  return client.process.once.mock.calls.find((c) => c[0] === "exit")![1] as () => void;
}

function internals(rpc: PiRpc) {
  const box = rpc as unknown as Record<string, unknown>;
  return {
    get expectedExit() {
      return box.expectedExit as boolean;
    },
    get crashes() {
      return box.consecutiveCrashes as number;
    },
    get gaveUp() {
      return box.respawnGaveUp as boolean;
    },
    get listeners() {
      return box.listeners as unknown[];
    },
    get client() {
      return box.client as unknown;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** start spy:真实 start() 成功 = doStart → onClientConnected(复位标志 +
 *  挂新实例感知)。spy 顶替 start 时模拟同一收尾,并把「当前客户端」记到
 *  shared 槽 —— 崩溃循环必须始终用当前客户端的 handler 发 exit(实现带
 *  实例绑定防御:旧客户端的迟到 exit 不生效,与真实 child_process 的
 *  exit-once 语义一致)。 */
function spyStart(rpc: PiRpc, current: { client?: FakeClient }): ReturnType<typeof vi.fn> {
  return vi.spyOn(rpc, "start").mockImplementation(async () => {
    current.client = makeFakeClient();
    connect(rpc, current.client);
  });
}

function freshRpc(limit = 5, onGiveUp?: (rpc: PiRpc) => void): PiRpc {
  return new PiRpc({ respawn: { limit, ...(onGiveUp ? { onGiveUp } : {}) } });
}

describe("respawnBackoffMs(指数退避:1s 起步封顶 1min,spec #247 票05)", () => {
  it("1s → 2s → 4s … 封顶 60s", () => {
    expect(respawnBackoffMs(1)).toBe(1000);
    expect(respawnBackoffMs(2)).toBe(2000);
    expect(respawnBackoffMs(3)).toBe(4000);
    expect(respawnBackoffMs(6)).toBe(32000);
    expect(respawnBackoffMs(7)).toBe(60000);
    expect(respawnBackoffMs(100)).toBe(60000);
  });
});

describe("意外死亡 → 自动重拉(监听器保留路径)", () => {
  it("fake 子进程 emit exit 且标志未置位 → 排程重拉,start 走监听器保留路径且 onRestarted 照常触发", async () => {
    const current: { client?: FakeClient } = {};
    const rpc = freshRpc();
    const client = makeFakeClient();
    const seen: string[] = [];
    rpc.onEvent(() => seen.push("event"));
    connect(rpc, client);
    expect(rpc.isConnected).toBe(true);

    const startSpy = spyStart(rpc, current);
    const restarted: PiRpc[] = [];
    rpc.onRestarted((r) => restarted.push(r));

    exitHandlerOf(client)(); // 意外死亡
    expect(internals(rpc).crashes).toBe(1);

    await vi.advanceTimersByTimeAsync(1000); // 首次退避 1s

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(restarted).toEqual([rpc]); // 拉起成功后 onRestarted 生命周期照常
    expect(internals(rpc).listeners).toHaveLength(1); // 监听器保留(事件路由不灭)
    expect(internals(rpc).expectedExit).toBe(false); // 新实例连上即复位
    // respawn 后原事件订阅仍收到 fake 事件(经保留的订阅派发)
    (internals(rpc).listeners[0] as (e: unknown) => void)({ type: "agent_event" });
    expect(seen).toEqual(["event"]);
  });

  it("主动 stop() 置位预期标志 → exit 不触发自动拉起", async () => {
    const rpc = freshRpc();
    const client = makeFakeClient();
    connect(rpc, client);
    const startSpy = spyStart(rpc, {});

    await rpc.stop();
    expect(internals(rpc).expectedExit).toBe(true);
    exitHandlerOf(client)();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startSpy).not.toHaveBeenCalled();
    expect(internals(rpc).crashes).toBe(0);
  });

  it("主动 restart() 同样不拉起(stop 已置位;stop 后旧客户端的迟到 exit 也不生效)", async () => {
    const current: { client?: FakeClient } = {};
    const rpc = freshRpc();
    const client = makeFakeClient();
    connect(rpc, client);
    const startSpy = spyStart(rpc, current);

    await rpc.restart(); // 内部 stop 置位 → start(spy:连上新实例复位)
    expect(internals(rpc).expectedExit).toBe(false);
    // restart 完成后旧客户端 handler 的迟到 exit:实例绑定防御,不算意外
    exitHandlerOf(client)();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startSpy).toHaveBeenCalledTimes(1); // 只有 restart 自己的 start
    expect(internals(rpc).crashes).toBe(0);
  });

  it("「stop → 重新 start 成功 → 新实例再遇意外死亡」仍判意外(标志复位生命周期)", async () => {
    const current: { client?: FakeClient } = {};
    const rpc = freshRpc();
    connect(rpc, makeFakeClient());
    const startSpy = spyStart(rpc, current);

    await rpc.stop();
    await rpc.start(); // 重新 start 成功 = onClientConnected:spyStart 接上新实例并复位
    expect(current.client).toBeDefined();
    expect(internals(rpc).expectedExit).toBe(false);

    exitHandlerOf(current.client!)(); // 新实例的意外死亡
    await vi.advanceTimersByTimeAsync(1000);
    expect(startSpy).toHaveBeenCalledTimes(2); // restart 自己 + 自动拉起
    expect(internals(rpc).crashes).toBe(1);
  });
});

describe("上限熔断与人工恢复(spec #247 票05)", () => {
  it("连续意外死亡达上限 → 告警回调恰好一次且不再重拉(退避区间递增)", async () => {
    const current: { client?: FakeClient } = {};
    const onGiveUp = vi.fn();
    const rpc = freshRpc(3, onGiveUp);
    const first = makeFakeClient();
    connect(rpc, first);
    const startSpy = spyStart(rpc, current);

    // 第 1 次:1s 后拉起
    exitHandlerOf(first)();
    await vi.advanceTimersByTimeAsync(999);
    expect(startSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(startSpy).toHaveBeenCalledTimes(1);

    // 第 2 次:2s 后拉起
    exitHandlerOf(current.client!)();
    await vi.advanceTimersByTimeAsync(2000);
    expect(startSpy).toHaveBeenCalledTimes(2);

    // 第 3 次(= limit):熔断 —— 不拉起、告警恰好一次、连接已清
    exitHandlerOf(current.client!)();
    expect(internals(rpc).gaveUp).toBe(true);
    expect(internals(rpc).client).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startSpy).toHaveBeenCalledTimes(2); // 不再重拉
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith(rpc);
  });

  it("人工 restart 成功 → 崩溃计数清零、熔断复位,自动拉起重新武装", async () => {
    const current: { client?: FakeClient } = {};
    const onGiveUp = vi.fn();
    const rpc = freshRpc(2, onGiveUp);
    const first = makeFakeClient();
    connect(rpc, first);
    const startSpy = spyStart(rpc, current);

    exitHandlerOf(first)(); // 第 1 次 → 拉起
    await vi.advanceTimersByTimeAsync(1000);
    exitHandlerOf(current.client!)(); // 第 2 次 = limit → 熔断
    expect(internals(rpc).gaveUp).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);

    await rpc.restart(); // 人工 /reload 成功
    expect(internals(rpc).crashes).toBe(0);
    expect(internals(rpc).gaveUp).toBe(false);
    expect(startSpy).toHaveBeenCalledTimes(2);

    exitHandlerOf(current.client!)(); // 再次意外死亡:重新武装生效
    await vi.advanceTimersByTimeAsync(1000);
    expect(startSpy).toHaveBeenCalledTimes(3); // 首次拉起 + restart + 重新拉起
    expect(onGiveUp).toHaveBeenCalledTimes(1); // 只有熔断那一次
  });

  it("未配置 respawn(如其他入口)→ 不挂 exit 感知,行为与旧版一致", () => {
    const rpc = new PiRpc();
    const client = makeFakeClient();
    connect(rpc, client);
    expect(client.process.once).not.toHaveBeenCalled();
  });

  it("自动拉起定时器 unref —— 不阻碍优雅退出", () => {
    const rpc = freshRpc();
    const client = makeFakeClient();
    connect(rpc, client);
    const unref = vi.fn();
    const timerSpy = vi.spyOn(global, "setTimeout").mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    exitHandlerOf(client)();
    expect(unref).toHaveBeenCalled();
    timerSpy.mockRestore();
  });
});

describe("rpcRespawnLimit 配置派生(spec #247 票05)", () => {
  it("缺省/非法值回落默认 5", async () => {
    const { rpcRespawnLimit, RPC_RESPAWN_LIMIT_DEFAULT } = await import("../src/config");
    expect(RPC_RESPAWN_LIMIT_DEFAULT).toBe(5);
    expect(rpcRespawnLimit({})).toBe(5);
    expect(rpcRespawnLimit({ resilience: { rpcRespawnLimit: 0 } })).toBe(5);
    expect(rpcRespawnLimit({ resilience: { rpcRespawnLimit: Number.NaN } })).toBe(5);
    expect(rpcRespawnLimit({ resilience: { rpcRespawnLimit: 3.9 } })).toBe(3);
  });
});
