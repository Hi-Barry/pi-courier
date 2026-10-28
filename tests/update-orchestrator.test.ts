import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_EVENTS } from "../src/audit/audit-log.js";
import { AllAgentsIdleTimeoutError } from "../src/rpc/command-map.js";
import { PendingUpdateStore } from "../src/update/pending-update.js";
import {
  classifyUpdateArgs,
  isNewerVersion,
  parseLatestVersion,
  UpdateOrchestrator,
  type UpdateCommandIO,
  type UpdateOrchestratorDeps,
} from "../src/update/updater.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  orch: UpdateOrchestrator;
  deps: UpdateOrchestratorDeps;
  replies: string[];
  audits: Array<{ event: string; detail?: string }>;
  io: (adminRoom?: boolean) => UpdateCommandIO;
  cleanup: () => void;
}

function makeHarness(overrides: Partial<UpdateOrchestratorDeps> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-orchestrator-"));
  const replies: string[] = [];
  const audits: Array<{ event: string; detail?: string }> = [];
  const deps: UpdateOrchestratorDeps = {
    fetchRegistry: vi.fn().mockResolvedValue({ version: "1.2.0" }),
    readVersion: () => "1.2.0",
    getuid: () => 1000,
    platform: "linux",
    probe: vi.fn().mockResolvedValue({ streaming: 0, unreachable: 0 }),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    upgrade: vi.fn().mockResolvedValue({ ok: true }),
    systemctlActive: vi.fn().mockResolvedValue(true),
    triggerRestart: vi.fn(),
    pendingUpdate: new PendingUpdateStore(path.join(dir, "pending-update.json")),
    ...overrides,
  };
  const orch = new UpdateOrchestrator(deps);
  return {
    orch,
    deps,
    replies,
    audits,
    io: (adminRoom = true): UpdateCommandIO => ({
      reply: async (text) => {
        replies.push(text);
      },
      adminRoom,
      allRpcs: () => [],
      audit: (event, detail) => {
        audits.push({ event, detail });
      },
    }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** 等待后台循环走到期望状态(全部假件,microtask 级推进)。 */
async function until(fn: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(fn()).toBe(true);
  });
}

/** 触发重启的调用次数(deps.triggerRestart 在 makeHarness 里必是 vi.fn)。 */
function restartCalls(h: Harness): number {
  return (h.deps.triggerRestart as ReturnType<typeof vi.fn>).mock.calls.length;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("纯函数(§5.2 版本检查)", () => {
  it("classifyUpdateArgs:四合法子命令 + 大小写归一 + 其余一律 invalid", () => {
    expect(classifyUpdateArgs("")).toBe("none");
    expect(classifyUpdateArgs("check")).toBe("check");
    expect(classifyUpdateArgs("CHECK")).toBe("check");
    expect(classifyUpdateArgs("force")).toBe("force");
    expect(classifyUpdateArgs("cancel")).toBe("cancel");
    expect(classifyUpdateArgs("  ")).toBe("none");
    expect(classifyUpdateArgs("1.2.3")).toBe("invalid");
    expect(classifyUpdateArgs("https://evil.example/x.tgz")).toBe("invalid");
    expect(classifyUpdateArgs("main")).toBe("invalid");
    expect(classifyUpdateArgs("check extra")).toBe("invalid");
  });

  it("parseLatestVersion:必须匹配 x.y.z 才返回(防注入)", () => {
    expect(parseLatestVersion({ version: "1.2.3" })).toBe("1.2.3");
    expect(parseLatestVersion({ version: "1.2.3\nEVIL" })).toBeUndefined();
    expect(parseLatestVersion({ version: "v1.2.3" })).toBeUndefined();
    expect(parseLatestVersion({})).toBeUndefined();
    expect(parseLatestVersion({ version: 5 })).toBeUndefined();
    expect(parseLatestVersion(null)).toBeUndefined();
    expect(parseLatestVersion("not an object")).toBeUndefined();
  });

  it("isNewerVersion:数字三段比较;candidate ≤ current → 无新版;格式坏 → false", () => {
    expect(isNewerVersion("1.3.0", "1.2.0")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.2.1", "1.2.0")).toBe(true);
    expect(isNewerVersion("1.2.0", "1.2.0")).toBe(false);
    expect(isNewerVersion("1.1.9", "1.2.0")).toBe(false);
    expect(isNewerVersion("1.2.0", "1.10.0")).toBe(false); // 字典序会误判,数字比较不误判
    expect(isNewerVersion("1.2.3\nEVIL", "1.2.0")).toBe(false); // 前置守卫:格式不过直接 false
    expect(isNewerVersion("1.2.3", "")).toBe(false);
  });
});

describe("§10 用例 1 · /update check(只读,不占位不 CAS)", () => {
  it("无新版 → check.upToDate;探测/升级不被触达", async () => {
    const h = makeHarness();
    try {
      expect(await h.orch.handleCommand("check", h.io())).toBe(true);
      expect(h.replies[0]).toBe("✅ 已是最新版本(v1.2.0)。");
      expect(h.orch.currentState).toBe("idle");
      expect(h.deps.probe).not.toHaveBeenCalled();
      expect(h.deps.upgrade).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  it("有新版 → check.hasNew(from/to 均过格式校验后才拼入文案)", async () => {
    const h = makeHarness({ fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }) });
    try {
      await h.orch.handleCommand("check", h.io());
      expect(h.replies[0]).toBe("🆕 发现新版本:v1.2.0 → v1.3.0。发送 /update 开始更新(任务不中断)。");
    } finally {
      h.cleanup();
    }
  });

  it("registry version 字段校验失败 → check.failed(不编排)", async () => {
    const h = makeHarness({ fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0\nEVIL" }) });
    try {
      await h.orch.handleCommand("check", h.io());
      expect(h.replies[0]).toContain("版本检查失败");
      expect(h.orch.currentState).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("网络失败 → check.failed(不编排)", async () => {
    const h = makeHarness({ fetchRegistry: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    try {
      await h.orch.handleCommand("check", h.io());
      expect(h.replies[0]).toBe("❌ 版本检查失败:socket hang up");
    } finally {
      h.cleanup();
    }
  });

  it("当前版本不可得 → check.failed(fetch 不发起)", async () => {
    const h = makeHarness({ readVersion: () => undefined });
    try {
      await h.orch.handleCommand("check", h.io());
      expect(h.replies[0]).toContain("版本检查失败");
      expect(h.deps.fetchRegistry).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  it("check 豁免 root(只读查询无害,§5.1)", async () => {
    const h = makeHarness({ getuid: () => 0 });
    try {
      await h.orch.handleCommand("check", h.io());
      expect(h.replies[0]).toContain("已是最新版本");
    } finally {
      h.cleanup();
    }
  });
});

describe("§10 用例 2 · 有新版且全空闲 → 直接编排(全链后台走完)", () => {
  it("started → installed → restarting → detached restart;pending-update.json 落盘;状态回 idle", async () => {
    const h = makeHarness({ fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }) });
    try {
      const handled = await h.orch.handleCommand("", h.io());
      expect(handled).toBe(true);
      expect(h.replies[0]).toBe("🚀 开始更新:v1.2.0 → v1.3.0(升级期间任务照常服务,完成后自动重启)。");
      await until(() => h.deps.triggerRestart !== undefined && h.replies.some((r) => r.includes("正在重启服务")));
      expect(h.deps.upgrade).toHaveBeenCalledWith("1.2.0", "1.3.0");
      expect(h.deps.systemctlActive).toHaveBeenCalledTimes(1);
      expect(h.deps.triggerRestart).toHaveBeenCalledTimes(1);
      expect(h.replies.some((r) => r.includes("📦 新代码已写入磁盘:v1.2.0 → v1.3.0"))).toBe(true);
      expect(h.deps.pendingUpdate.read()).toMatchObject({ from: "1.2.0", to: "1.3.0" });
      await until(() => h.orch.currentState === "idle");
    } finally {
      h.cleanup();
    }
  });

  it("adminRoom=false → notManagementRoom,不触网不探测(§5.5 布尔守卫)", async () => {
    const h = makeHarness({ fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }) });
    try {
      expect(await h.orch.handleCommand("", h.io(false))).toBe(true);
      expect(h.replies[0]).toBe("❌ /update 仅可在管理房使用。");
      expect(h.deps.fetchRegistry).not.toHaveBeenCalled();
      expect(h.deps.probe).not.toHaveBeenCalled();
      expect(h.orch.currentState).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("check 也受管理房约束(守卫链未给 check 豁免)", async () => {
    const h = makeHarness();
    try {
      await h.orch.handleCommand("check", h.io(false));
      expect(h.replies[0]).toBe("❌ /update 仅可在管理房使用。");
      expect(h.deps.fetchRegistry).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });
});

describe("§10 用例 3 · 忙 → 预告 + 等待、任务结束后自动继续", () => {
  it("N>0 → busyWaiting 预告;waitForIdle resolve 后自动进 installing", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 2, unreachable: 0 }),
    });
    try {
      const handled = await h.orch.handleCommand("", h.io());
      expect(handled).toBe(true);
      expect(h.replies[0]).toBe("⏳ 2 个任务在跑,全部完成后自动开始更新(超 30 分钟未空闲则取消;期间新消息照常排队)。");
      expect(h.orch.currentState).toBe("waiting");
      expect(h.deps.waitForIdle).toHaveBeenCalledTimes(1);
      // 任务结束(假 waitForIdle resolve)→ 自动继续:started → … → restart。
      await until(() => h.replies.some((r) => r.includes("开始更新")));
      await until(() => h.orch.currentState === "idle" && restartCalls(h) === 1);
    } finally {
      h.cleanup();
    }
  });

  it("N>0 且 U>0 → busyWaiting 追加 unreachableNote", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 2, unreachable: 1 }),
    });
    try {
      await h.orch.handleCommand("", h.io());
      expect(h.replies[0]).toContain("2 个任务在跑");
      expect(h.replies[0]).toContain("另有 1 个实例暂不可查询");
      await until(() => h.orch.currentState === "idle");
    } finally {
      h.cleanup();
    }
  });

  it("N=0 且 U>0 → waitingUnreachableOnly 专用键(不用 busyWaiting 渲染 0 任务的自相矛盾)", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 0, unreachable: 1 }),
    });
    try {
      await h.orch.handleCommand("", h.io());
      expect(h.replies[0]).toContain("暂无法确认全部实例空闲");
      expect(h.replies[0]).toContain("1 个实例查询失败或正处重启窗口");
      expect(h.replies[0]).not.toContain("个任务在跑");
      expect(h.orch.currentState).toBe("waiting");
      await until(() => h.orch.currentState === "idle");
    } finally {
      h.cleanup();
    }
  });

  it("force:忙也直接 installing,不等待(不调 waitForIdle)", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 5, unreachable: 0 }),
    });
    try {
      await h.orch.handleCommand("force", h.io());
      expect(h.replies[0]).toContain("开始更新");
      expect(h.deps.waitForIdle).not.toHaveBeenCalled();
      expect(h.orch.currentState).toBe("installing");
      await until(() => h.orch.currentState === "idle");
    } finally {
      h.cleanup();
    }
  });

  it("进度回报:每满进度间隔发 waitProgress(当前在跑数 + 已等分钟数)", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 2, unreachable: 0 }),
      waitProgressMs: 5 * 60_000,
    });
    h.deps.waitForIdle = vi.fn(async (_rpcs, options) => {
      options.onTick?.({ streaming: 2, unreachable: 0 }); // t=0:不满间隔,无进度
      vi.setSystemTime(start + 5 * 60_000 + 1);
      await options.onTick?.({ streaming: 2, unreachable: 0 }); // 满 5 分钟:发进度
      vi.setSystemTime(start + 5 * 60_000 + 2);
      await options.onTick?.({ streaming: 2, unreachable: 0 }); // 间隔未满:不重发
    });
    try {
      await h.orch.handleCommand("", h.io());
      // 后台全链走完(waiting → installing → restart)再断言回执集合。
      await until(() => h.orch.currentState === "idle" && restartCalls(h) === 1);
      const progress = h.replies.filter((r) => r.includes("更新等待中"));
      expect(progress).toEqual(["⏳ 更新等待中:2 个任务仍在跑(已等 5 分钟)。"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("§10 用例 4 · 等待超时(handler 先 resolve,超时回执由后台循环发出)", () => {
  it("超时 → waitTimeout + audit update.cancel + 状态回 idle;之后可再次发起", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 1, unreachable: 0 }),
      waitForIdle: vi.fn(async () => {
        throw new AllAgentsIdleTimeoutError({ streaming: 1, unreachable: 0 });
      }),
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("等待空闲超时")));
      expect(h.replies.find((r) => r.includes("等待空闲超时"))).toContain("/update force");
      expect(h.orch.currentState).toBe("idle");
      expect(h.audits).toContainEqual({ event: AUDIT_EVENTS.updateCancel, detail: "wait timeout" });
      // 之后可再次发起(状态机已复位)
      await h.orch.handleCommand("check", h.io());
      expect(h.replies.at(-1)).toContain("发现新版本");
    } finally {
      h.cleanup();
    }
  });

  it("cancel 与超时竞态:cancel 先到则超时出口静默退出(不重发回执、不重复审计)", async () => {
    const gate = deferred<void>();
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 1, unreachable: 0 }),
      waitForIdle: vi.fn(async () => {
        await gate.promise;
        throw new AllAgentsIdleTimeoutError({ streaming: 1, unreachable: 0 });
      }),
    });
    try {
      await h.orch.handleCommand("", h.io()); // waiting
      await h.orch.handleCommand("cancel", h.io()); // cancelled + audit
      gate.resolve();
      // 后台超时出口在 cancel 之后被代次仲裁静默(多轮 flush 等它跑完)。
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(h.replies.some((r) => r.includes("等待空闲超时"))).toBe(false);
      expect(h.audits.filter((a) => a.event === AUDIT_EVENTS.updateCancel)).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});

describe("§10 用例 5 · /update cancel 分态语义", () => {
  it("idle → noPending", async () => {
    const h = makeHarness();
    try {
      await h.orch.handleCommand("cancel", h.io());
      expect(h.replies[0]).toBe("ℹ️ 当前没有进行中的更新。");
    } finally {
      h.cleanup();
    }
  });

  it("checking → noPending(不被 inProgress 误杀;check 结束后编排照常继续)", async () => {
    const gate = deferred<{ version: string }>();
    const h = makeHarness({
      fetchRegistry: vi.fn().mockReturnValue(gate.promise),
      probe: vi.fn().mockResolvedValue({ streaming: 0, unreachable: 0 }),
    });
    try {
      const first = h.orch.handleCommand("", h.io()); // 卡在 fetch,占位 checking
      expect(h.orch.currentState).toBe("checking");
      await h.orch.handleCommand("cancel", h.io());
      expect(h.replies.at(-1)).toBe("ℹ️ 当前没有进行中的更新。");
      gate.resolve({ version: "1.3.0" });
      await first; // 原编排继续走完
      await until(() => h.orch.currentState === "idle" && restartCalls(h) === 1);
    } finally {
      h.cleanup();
    }
  });

  it("waiting → cancelled + audit update.cancel + idle;随后 /update 走正常发起(原子性)", async () => {
    const gate = deferred<void>();
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 1, unreachable: 0 }),
      waitForIdle: vi.fn(() => gate.promise),
    });
    try {
      await h.orch.handleCommand("", h.io());
      expect(h.orch.currentState).toBe("waiting");
      await h.orch.handleCommand("cancel", h.io());
      expect(h.orch.currentState).toBe("idle");
      expect(h.replies.at(-1)).toBe("🛑 已取消更新等待。");
      expect(h.audits).toContainEqual({ event: AUDIT_EVENTS.updateCancel, detail: "waiting cancelled by /update cancel" });
      gate.resolve();
      // cancel 原子性:此时再发 /update 走正常发起而非 inProgress。
      h.deps.probe = vi.fn().mockResolvedValue({ streaming: 0, unreachable: 0 });
      h.deps.waitForIdle = vi.fn().mockResolvedValue(undefined);
      await h.orch.handleCommand("", h.io());
      expect(h.replies.some((r) => r.includes("开始更新"))).toBe(true);
      await until(() => h.orch.currentState === "idle" && restartCalls(h) === 1);
    } finally {
      h.cleanup();
    }
  });

  it("cancel 原子性:同步置位先于回执 await —— 回执挂起时第二条 /update 已可正常发起", async () => {
    const gate = deferred<void>();
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 1, unreachable: 0 }),
      waitForIdle: vi.fn(() => gate.promise),
    });
    try {
      await h.orch.handleCommand("", h.io()); // waiting
      const replyGate = deferred<void>();
      const cancelReplies: string[] = [];
      const cancelPromise = h.orch.handleCommand("cancel", {
        reply: async (text) => {
          cancelReplies.push(text);
          await replyGate.promise;
        },
        adminRoom: true,
        allRpcs: () => [],
      });
      // 回执 await 尚未落定,但状态已同步置位 idle(§5.7)。
      expect(h.orch.currentState).toBe("idle");
      h.deps.probe = vi.fn().mockResolvedValue({ streaming: 0, unreachable: 0 });
      h.deps.waitForIdle = vi.fn().mockResolvedValue(undefined);
      await h.orch.handleCommand("", h.io());
      expect(h.replies.some((r) => r.includes("开始更新"))).toBe(true);
      replyGate.resolve();
      await cancelPromise;
      expect(cancelReplies).toEqual(["🛑 已取消更新等待。"]);
      await until(() => h.orch.currentState === "idle" && restartCalls(h) === 1);
    } finally {
      h.cleanup();
    }
  });

  it("installing → inProgress 拒绝(换血不可中断);upgrade 失败后照常回到 idle", async () => {
    const gate = deferred<{ ok: true } | { ok: false; message: string }>();
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      upgrade: vi.fn().mockReturnValue(gate.promise),
    });
    try {
      await h.orch.handleCommand("", h.io()); // 全空闲 → installing
      expect(h.orch.currentState).toBe("installing");
      await h.orch.handleCommand("cancel", h.io());
      expect(h.replies.at(-1)).toBe("⏳ 更新已在进行中,请等待完成(等待期可 /update cancel)。");
      gate.resolve({ ok: false, message: "npm exited with code 1" });
      await until(() => h.replies.some((r) => r.includes("升级失败")));
      expect(h.orch.currentState).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("restart-pending → 文件照写 + manualRestartHint + audit + idle(不回滚,§5.7)", async () => {
    const gate = deferred<void>();
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi
        .fn()
        .mockResolvedValueOnce({ streaming: 0, unreachable: 0 }) // 发起时全空闲 → installing
        .mockResolvedValueOnce({ streaming: 1, unreachable: 0 }), // 换血后忙 → restartWait
      waitForIdle: vi.fn(() => gate.promise),
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("等待全部任务空闲后自动重启")));
      expect(h.orch.currentState).toBe("restart-pending");
      await h.orch.handleCommand("cancel", h.io());
      expect(h.orch.currentState).toBe("idle");
      expect(h.deps.pendingUpdate.read()).toMatchObject({ from: "1.2.0", to: "1.3.0" });
      expect(h.replies.at(-1)).toContain("请手动执行 pi-courier restart");
      expect(h.audits).toContainEqual({
        event: AUDIT_EVENTS.updateCancel,
        detail: "restart wait cancelled by /update cancel",
      });
      gate.resolve();
    } finally {
      h.cleanup();
    }
  });
});

describe("§10 用例 5b · 并发守卫(同步段竞态)", () => {
  it("占位后停在 fetch 窗口:第二条 /update 与 force 均 inProgress,不启动第二套编排", async () => {
    const gate = deferred<{ version: string }>();
    const h = makeHarness({ fetchRegistry: vi.fn().mockReturnValue(gate.promise) });
    try {
      const first = h.orch.handleCommand("", h.io());
      expect(h.orch.currentState).toBe("checking"); // CAS 占位先于 await(同步段零 await)
      await h.orch.handleCommand("", h.io());
      expect(h.replies.at(-1)).toBe("⏳ 更新已在进行中,请等待完成(等待期可 /update cancel)。");
      await h.orch.handleCommand("force", h.io());
      expect(h.replies.at(-1)).toBe("⏳ 更新已在进行中,请等待完成(等待期可 /update cancel)。");
      expect(h.deps.fetchRegistry).toHaveBeenCalledTimes(1); // 仅一次 fetch 发起
      gate.resolve({ version: "1.3.0" });
      await first;
      await until(() => h.orch.currentState === "idle" && restartCalls(h) === 1);
    } finally {
      h.cleanup();
    }
  });

  it("check 并发放行(只读不占位)", async () => {
    const gate = deferred<{ version: string }>();
    const fetchRegistry = vi
      .fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue({ version: "1.2.0" });
    const h = makeHarness({ fetchRegistry });
    try {
      const first = h.orch.handleCommand("", h.io()); // 占位 checking,卡在第一次 fetch
      await h.orch.handleCommand("check", h.io()); // 独立 fetch(第二次),正常回执
      expect(h.replies.at(-1)).toContain("已是最新版本");
      expect(fetchRegistry).toHaveBeenCalledTimes(2);
      gate.resolve({ version: "1.3.0" });
      await first;
      await until(() => h.orch.currentState === "idle" && restartCalls(h) === 1);
    } finally {
      h.cleanup();
    }
  });

  it("root 拒绝后无占位残留,后续 /update 可正常发起(守卫先于占位)", async () => {
    const h = makeHarness({ getuid: () => 0 });
    try {
      await h.orch.handleCommand("", h.io());
      expect(h.replies[0]).toContain("桥正以 root 运行");
      expect(h.orch.currentState).toBe("idle");
      h.deps.getuid = () => 1000;
      await h.orch.handleCommand("check", h.io());
      expect(h.replies.at(-1)).toContain("已是最新版本");
    } finally {
      h.cleanup();
    }
  });

  it("参数拒绝后无占位残留(防线上锁死)", async () => {
    const h = makeHarness();
    try {
      await h.orch.handleCommand("1.2.3", h.io());
      expect(h.replies[0]).toBe("❌ /update 不接受版本号、URL 或路径等参数(唯一来源:npm 的 latest 标签)。可用:/update、/update check、/update force、/update cancel。");
      expect(h.orch.currentState).toBe("idle");
      await h.orch.handleCommand("check", h.io());
      expect(h.replies.at(-1)).toContain("已是最新版本");
    } finally {
      h.cleanup();
    }
  });

  it("占位释放:探测抛错 → 同步复位 idle 并上抛(generic catch 接手回执);后续可正常发起", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockRejectedValue(new Error("probe exploded")),
    });
    try {
      await expect(h.orch.handleCommand("", h.io())).rejects.toThrow("probe exploded");
      expect(h.orch.currentState).toBe("idle"); // 先复位再上抛
      h.deps.probe = vi.fn().mockResolvedValue({ streaming: 0, unreachable: 0 });
      await h.orch.handleCommand("check", h.io());
      expect(h.replies.at(-1)).toContain("发现新版本");
    } finally {
      h.cleanup();
    }
  });

  it("占位释放:预告回执发送抛错 → 复位 idle 且后台循环未启动", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 1, unreachable: 0 }),
    });
    try {
      await expect(
        h.orch.handleCommand("", {
          reply: async () => {
            throw new Error("transport gone");
          },
          adminRoom: true,
          allRpcs: () => [],
        })
      ).rejects.toThrow("transport gone");
      expect(h.orch.currentState).toBe("idle");
      expect(h.deps.waitForIdle).not.toHaveBeenCalled(); // 预告失败,等待循环未启动
    } finally {
      h.cleanup();
    }
  });
});

describe("§10 用例 6 · npm 升级失败(安全失败,桥绝不自杀)", () => {
  it("spawn 非零退出 → npmFailed(含原因)+ 回 idle;桥照常应答后续 check", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      upgrade: vi.fn().mockResolvedValue({ ok: false, message: "npm install -g pi-courier@latest exited with code 1" }),
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("升级失败")));
      expect(h.replies.find((r) => r.includes("升级失败"))).toContain("exited with code 1");
      expect(h.replies.find((r) => r.includes("升级失败"))).toContain("旧版继续运行,桥未受影响");
      expect(h.orch.currentState).toBe("idle");
      expect(h.deps.triggerRestart).not.toHaveBeenCalled();
      expect(h.deps.pendingUpdate.read()).toBeUndefined(); // 未写 pending 文件
      await h.orch.handleCommand("check", h.io());
      expect(h.replies.at(-1)).toContain("发现新版本"); // registry 仍报 1.3.0:check 不受失败影响
    } finally {
      h.cleanup();
    }
  });

  it("upgrade 缝自身抛错 → 同失败出口(不外抛进命令调用栈)", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      upgrade: vi.fn().mockRejectedValue(new Error("spawn exploded")),
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("升级失败")));
      expect(h.replies.find((r) => r.includes("升级失败"))).toContain("spawn exploded");
      expect(h.orch.currentState).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("升级成功但 pending-update.json 写入失败 → 放弃自动重启、manualRestart、idle(可感知写契约)", async () => {
    const h = makeHarness({ fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }) });
    // 结构假件:write 恒抛(可感知写契约的反向验证)。
    const failingStore = {
      read: () => undefined,
      write: () => {
        throw new Error("disk full");
      },
      clear: () => {},
    } as unknown as PendingUpdateStore;
    h.deps.pendingUpdate = failingStore;
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("未由活动的 systemd 单元管理")));
      expect(h.deps.triggerRestart).not.toHaveBeenCalled(); // 放弃自动重启
      expect(h.orch.currentState).toBe("idle");
    } finally {
      h.cleanup();
    }
  });
});

describe("§10 用例 7 · root 拒执行", () => {
  it("getuid=0 → rootDenied,不触网不探测不升级", async () => {
    const h = makeHarness({
      getuid: () => 0,
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
    });
    try {
      expect(await h.orch.handleCommand("", h.io())).toBe(true);
      expect(h.replies[0]).toContain("桥正以 root 运行");
      expect(h.deps.fetchRegistry).not.toHaveBeenCalled();
      expect(h.deps.probe).not.toHaveBeenCalled();
      expect(h.deps.upgrade).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  it("对照组:getuid=1000 与 getuid=undefined(Windows)均放行", async () => {
    for (const getuid of [() => 1000, undefined]) {
      const h = makeHarness({ getuid });
      try {
        await h.orch.handleCommand("check", h.io());
        expect(h.replies[0]).toContain("已是最新版本");
      } finally {
        h.cleanup();
      }
    }
  });

  it("root 下 cancel 也被拒(守卫链只豁免 check)", async () => {
    const h = makeHarness({ getuid: () => 0 });
    try {
      await h.orch.handleCommand("cancel", h.io());
      expect(h.replies[0]).toContain("桥正以 root 运行");
    } finally {
      h.cleanup();
    }
  });
});

describe("§10 用例 8 · 非法参数(参数铁律)", () => {
  it.each(["1.2.3", "https://evil.example/pi-courier.tgz", "/local/path", "main", "check extra"])(
    "/update %s → rejectedArgs,不触网;拒绝后可再次发起",
    async (args) => {
      const h = makeHarness();
      try {
        expect(await h.orch.handleCommand(args, h.io())).toBe(true);
        expect(h.replies[0]).toBe("❌ /update 不接受版本号、URL 或路径等参数(唯一来源:npm 的 latest 标签)。可用:/update、/update check、/update force、/update cancel。");
        expect(h.deps.fetchRegistry).not.toHaveBeenCalled();
        expect(h.orch.currentState).toBe("idle");
        await h.orch.handleCommand("check", h.io());
        expect(h.replies.at(-1)).toContain("已是最新版本");
      } finally {
        h.cleanup();
      }
    }
  );
});

describe("§5.5 · 空闲重启编排(顺序即契约)", () => {
  function makeSequenceHarness() {
    const h = makeHarness({ fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }) });
    const order: string[] = [];
    // 结构假件:write/triggerRestart 按发生顺序记账,断言「先写文件再重启」。
    const recordingStore = {
      read: () => undefined,
      write: () => {
        order.push("write");
      },
      clear: () => {},
    } as unknown as PendingUpdateStore;
    h.deps.pendingUpdate = recordingStore;
    h.deps.triggerRestart = () => {
      order.push("restart");
    };
    return { h, order };
  }

  it("写文件 → restarting 回执 → 才触发 restart(顺序即契约)", async () => {
    const { h, order } = makeSequenceHarness();
    try {
      const trackedIo: UpdateCommandIO = {
        reply: async (text) => {
          order.push(text.includes("正在重启服务") ? "restarting-reply" : "other-reply");
          h.replies.push(text);
        },
        adminRoom: true,
        allRpcs: () => [],
        audit: (event, detail) => {
          h.audits.push({ event, detail });
        },
      };
      await h.orch.handleCommand("", trackedIo);
      await until(() => order.includes("restart"));
      // 顺序即契约:pending 写入 → restarting 回执落定 → 才触发 restart
      // (started/installed 两条前置回执也经同一缝,记录为 other-reply)。
      expect(order.indexOf("write")).toBeLessThan(order.indexOf("restarting-reply"));
      expect(order.indexOf("restarting-reply")).toBeLessThan(order.indexOf("restart"));
      expect(h.replies.find((r) => r.includes("正在重启服务"))).toBe(
        "🔄 全部任务已空闲,正在重启服务以加载新版本…"
      );
    } finally {
      h.cleanup();
    }
  });

  it("非 Linux → manualRestart 降级(不探测 systemctl、不触发重启)", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      platform: "win32",
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("未由活动的 systemd 单元管理")));
      expect(h.deps.systemctlActive).not.toHaveBeenCalled();
      expect(h.deps.triggerRestart).not.toHaveBeenCalled();
      expect(h.orch.currentState).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("单元非 active → manualRestart 降级(误伤非单元部署的防线)", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      systemctlActive: vi.fn().mockResolvedValue(false),
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("未由活动的 systemd 单元管理")));
      expect(h.deps.triggerRestart).not.toHaveBeenCalled();
      expect(h.orch.currentState).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("is-active 探测失败 → 安全默认 false → manualRestart", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      systemctlActive: vi.fn().mockRejectedValue(new Error("systemctl missing")),
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("未由活动的 systemd 单元管理")));
      expect(h.deps.triggerRestart).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  it("triggerRestart 抛错 → 文件已写 + restartFailed + idle(手动 restart 闭环)", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      triggerRestart: () => {
        throw new Error("bus unavailable");
      },
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("自动重启失败")));
      expect(h.replies.find((r) => r.includes("自动重启失败"))).toContain("bus unavailable");
      expect(h.deps.pendingUpdate.read()).toMatchObject({ from: "1.2.0", to: "1.3.0" });
      expect(h.orch.currentState).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("restart-pending 忙 → restartWait 专用预告;等待后走重启(§5.5 专用键)", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi
        .fn()
        .mockResolvedValueOnce({ streaming: 0, unreachable: 0 }) // 发起时全空闲
        .mockResolvedValueOnce({ streaming: 3, unreachable: 0 }), // 换血后忙
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("新代码已上磁盘,等待全部任务空闲后自动重启")));
      await until(() => restartCalls(h) === 1);
      expect(h.orch.currentState).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("restart-pending 超时 → 文件照写 + manualRestartHint + audit update.cancel + idle", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi
        .fn()
        .mockResolvedValueOnce({ streaming: 0, unreachable: 0 })
        .mockResolvedValueOnce({ streaming: 2, unreachable: 0 }),
      waitForIdle: vi.fn(async () => {
        throw new AllAgentsIdleTimeoutError({ streaming: 2, unreachable: 0 });
      }),
    });
    try {
      await h.orch.handleCommand("", h.io());
      await until(() => h.replies.some((r) => r.includes("任务未空闲/等待已取消")));
      expect(h.deps.pendingUpdate.read()).toMatchObject({ from: "1.2.0", to: "1.3.0" });
      expect(h.audits).toContainEqual({ event: AUDIT_EVENTS.updateCancel, detail: "restart wait timeout" });
      expect(h.orch.currentState).toBe("idle");
      expect(h.deps.triggerRestart).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });
});

describe("§10 用例 11 · 审计事件(命令层取消缝)", () => {
  it("等待超时与 cancel 各落一条 update.cancel,detail 区分来源", async () => {
    const h = makeHarness({
      fetchRegistry: vi.fn().mockResolvedValue({ version: "1.3.0" }),
      probe: vi.fn().mockResolvedValue({ streaming: 1, unreachable: 0 }),
      waitForIdle: vi.fn(async () => {
        throw new AllAgentsIdleTimeoutError({ streaming: 1, unreachable: 0 });
      }),
    });
    try {
      await h.orch.handleCommand("", h.io()); // waiting → 超时
      await until(() => h.audits.length === 1);
      expect(h.audits[0]).toEqual({ event: AUDIT_EVENTS.updateCancel, detail: "wait timeout" });
      h.deps.waitForIdle = vi.fn().mockResolvedValue(undefined);
      h.deps.probe = vi.fn().mockResolvedValue({ streaming: 1, unreachable: 0 });
      await h.orch.handleCommand("", h.io()); // 再次 waiting → cancel
      await h.orch.handleCommand("cancel", h.io());
      expect(h.audits).toHaveLength(2);
      expect(h.audits[1]).toEqual({ event: AUDIT_EVENTS.updateCancel, detail: "waiting cancelled by /update cancel" });
    } finally {
      h.cleanup();
    }
  });
});
