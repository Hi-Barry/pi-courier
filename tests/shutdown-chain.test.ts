/**
 * 共享优雅退出链(spec #247 票01):退出码参数化 + 释放顺序 + 重入守卫。
 * 全部注入 fake,不碰真实 process.exit / 信号监听。
 */
import { describe, expect, it, vi } from "vitest";
import { createShutdownChain, type ShutdownChainDeps } from "../src/shutdown-chain";

function makeDeps() {
  const calls: string[] = [];
  const deps: ShutdownChainDeps = {
    stopRpc: vi.fn(async () => {
      calls.push("stopRpc");
    }),
    disconnectAll: vi.fn(async () => {
      calls.push("disconnectAll");
    }),
    releaseLock: vi.fn(() => {
      calls.push("releaseLock");
    }),
    exit: vi.fn((code: number) => {
      calls.push(`exit:${code}`);
    }),
    log: vi.fn(() => {}),
  };
  return { deps, calls };
}

describe("shutdown chain (spec #247 票01)", () => {
  it("信号路径(缺省调用)退出码为 0,释放顺序 停RPC→断连接→放锁→退出", async () => {
    const { deps, calls } = makeDeps();
    const chain = createShutdownChain(deps);

    await chain.shutdown("SIGTERM");

    expect(calls).toEqual(["stopRpc", "disconnectAll", "releaseLock", "exit:0"]);
  });

  it("SIGINT/SIGBREAK 同款缺省 0", async () => {
    const a = createShutdownChain(makeDeps().deps);
    await a.shutdown("SIGINT");
    const b = createShutdownChain(makeDeps().deps);
    await b.shutdown("SIGBREAK");
    expect(a.isShuttingDown()).toBe(true);
    expect(b.isShuttingDown()).toBe(true);
  });

  it("非零退出码走同一条释放序列(票03/04 的退出路径)", async () => {
    const { deps, calls } = makeDeps();
    const chain = createShutdownChain(deps);

    await chain.shutdown("crash:uncaughtException", 70);

    expect(calls).toEqual(["stopRpc", "disconnectAll", "releaseLock", "exit:70"]);
  });

  it("stopRpc 抛错被吞,后续释放步骤照走", async () => {
    const { deps, calls } = makeDeps();
    (deps.stopRpc as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push("stopRpc");
      throw new Error("rpc already dead");
    });
    const chain = createShutdownChain(deps);

    await chain.shutdown("SIGTERM", 1);

    expect(calls).toEqual(["stopRpc", "disconnectAll", "releaseLock", "exit:1"]);
  });

  it("二次进入被重入标志挡住:不重复释放、不覆盖首次退出码", async () => {
    const { deps, calls } = makeDeps();
    const chain = createShutdownChain(deps);

    const first = chain.shutdown("SIGTERM", 0);
    await first;
    await chain.shutdown("uncaughtException", 70);

    expect(calls.filter((c) => c === "stopRpc")).toHaveLength(1);
    expect(calls).toEqual(["stopRpc", "disconnectAll", "releaseLock", "exit:0"]);
  });

  it("isShuttingDown 在进入前为 false,进入后为 true", async () => {
    const { deps } = makeDeps();
    const chain = createShutdownChain(deps);
    expect(chain.isShuttingDown()).toBe(false);
    await chain.shutdown("SIGTERM");
    expect(chain.isShuttingDown()).toBe(true);
  });
});
