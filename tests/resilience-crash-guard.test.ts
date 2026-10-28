/**
 * L1 崩溃守卫(spec #247 票03):「异常 → 记录 → 通知 → 退出」顺序、
 * 非零退出码、通知限时、重入单飞、兜底不成为二次崩溃源、两类事件同链。
 * 全部注入 fake,不碰真实 process 事件监听。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createCrashGuard,
  CRASH_EXIT_CODE,
  crashReason,
  type CrashGuardDeps,
} from "../src/resilience/crash-guard";

function makeDeps(overrides: Partial<CrashGuardDeps> = {}) {
  const calls: string[] = [];
  const deps: CrashGuardDeps = {
    log: vi.fn((message: string) => {
      calls.push("log");
    }),
    notify: vi.fn(async (_reason: string) => {
      calls.push("notify");
    }),
    shutdown: vi.fn(async (reason: string, exitCode?: number) => {
      calls.push(`shutdown:${reason}:${exitCode}`);
    }),
    hardExit: vi.fn((code: number) => {
      calls.push(`hardExit:${code}`);
    }),
    ...overrides,
  };
  return { deps, calls };
}

const boom = new Error("disk full");

describe("crash guard(spec #247 票03)", () => {
  it("异常 → 记录 → 通知 → 退出,退出回调收到非零码", async () => {
    const { deps, calls } = makeDeps();
    const guard = createCrashGuard(deps);

    await guard.handleCrash("uncaughtException", boom);

    expect(calls).toEqual([
      "log",
      "notify",
      `shutdown:uncaughtException:${CRASH_EXIT_CODE}`,
      `hardExit:${CRASH_EXIT_CODE}`,
    ]);
    expect(CRASH_EXIT_CODE).not.toBe(0);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("Error: disk full"));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("uncaughtException"));
  });

  it("unhandledRejection 与 uncaughtException 走同一处理链(kind 仅辨识)", async () => {
    for (const kind of ["uncaughtException", "unhandledRejection"]) {
      const { deps, calls } = makeDeps();
      const guard = createCrashGuard(deps);
      await guard.handleCrash(kind, boom);
      expect(calls.some((c) => c.startsWith(`shutdown:${kind}:${CRASH_EXIT_CODE}`))).toBe(true);
    }
  });

  it("非 Error 抛出值(String 化)同样处理", async () => {
    const { deps, calls } = makeDeps();
    const guard = createCrashGuard(deps);

    await guard.handleCrash("uncaughtException", "string throw");

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("string throw"));
    expect(calls.some((c) => c.startsWith(`shutdown:uncaughtException:${CRASH_EXIT_CODE}`))).toBe(true);
  });

  it("未接线 notify(undefined)= 未配管理房:只记日志、不抛、照常退出", async () => {
    const { deps, calls } = makeDeps({ notify: undefined });
    const guard = createCrashGuard(deps);

    await guard.handleCrash("uncaughtException", boom);

    expect(calls).toEqual([
      "log",
      `shutdown:uncaughtException:${CRASH_EXIT_CODE}`,
      `hardExit:${CRASH_EXIT_CODE}`,
    ]);
  });

  it("notify 抛错不追:照常走退出", async () => {
    const { deps, calls } = makeDeps({
      notify: vi.fn(async () => {
        throw new Error("transport dead");
      }),
    });
    const guard = createCrashGuard(deps);

    await guard.handleCrash("uncaughtException", boom);

    expect(calls.some((c) => c.startsWith("shutdown:"))).toBe(true);
  });

  it("notify 挂起超限时放弃(限时后仍走退出)", async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls } = makeDeps({
        notify: vi.fn(
          (_reason: string) =>
            new Promise<void>(() => {
              /* never settles */
            })
        ),
        notifyTimeoutMs: 50,
      });
      const guard = createCrashGuard(deps);
      const done = guard.handleCrash("uncaughtException", boom);

      await vi.advanceTimersByTimeAsync(51);
      await done;

      expect(calls.some((c) => c.startsWith(`shutdown:uncaughtException:${CRASH_EXIT_CODE}`))).toBe(true);
      // notify 被调用过(尝试过),但没有等它 settle 才退出
      expect(deps.notify).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("并发二次进入被单飞标志挡住:只处理首个", async () => {
    const { deps, calls } = makeDeps();
    const guard = createCrashGuard(deps);

    const first = guard.handleCrash("uncaughtException", boom);
    await guard.handleCrash("unhandledRejection", new Error("second"));
    await first;

    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.startsWith("shutdown:"))).toHaveLength(1);
  });

  it("处理器内部 log 抛错仍能保证退出(硬退兜底,不成为二次崩溃源)", async () => {
    const { deps, calls } = makeDeps({
      log: vi.fn(() => {
        throw new Error("logger dead");
      }),
    });
    const guard = createCrashGuard(deps);

    await guard.handleCrash("uncaughtException", boom);

    expect(calls).toEqual([`hardExit:${CRASH_EXIT_CODE}`]);
  });

  it("退出链自身抛错 → 硬退兜底", async () => {
    const { deps, calls } = makeDeps({
      shutdown: vi.fn(async () => {
        throw new Error("shutdown chain blew up");
      }),
    });
    const guard = createCrashGuard(deps);

    await guard.handleCrash("uncaughtException", boom);

    expect(calls).toEqual(["log", "notify", `hardExit:${CRASH_EXIT_CODE}`]);
  });

  it("crashReason:Error 取 name+message,非 Error String 化", () => {
    expect(crashReason(new TypeError("x is not a function"))).toBe("TypeError: x is not a function");
    expect(crashReason("bare string")).toBe("bare string");
    expect(crashReason(42)).toBe("42");
  });
});
