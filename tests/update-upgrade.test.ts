import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUpgradePlan,
  defaultProjectDir,
  defaultWatchdogControl,
  ENSURE_TIMEOUT_MS,
  NPM_FETCH_RETRIES,
  NPM_FETCH_TIMEOUT_MS,
  runUpgrade,
  schtasksArgs,
  STALL_TIMEOUT_MS,
  taskkillArgs,
  UPGRADE_MAX_ATTEMPTS,
  UPGRADE_TIMEOUT_MS,
  type UpgradeDeps,
} from "../src/update/upgrade.js";

interface FakeChild {
  pid?: number;
  stdout: { on(event: string, cb: (chunk: Buffer) => void): void };
  stderr: { on(event: string, cb: (chunk: Buffer) => void): void };
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  on(event: string, cb: (...args: any[]) => void): void;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  once(event: string, cb: (...args: any[]) => void): void;
  kill: (signal?: number | NodeJS.Signals) => boolean;
  emit(event: string, ...args: unknown[]): void;
}

function makeFakeChild(): FakeChild {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const add = (event: string, cb: (...args: any[]) => void) => {
    const list = listeners.get(event) ?? [];
    list.push(cb);
    listeners.set(event, list);
  };
  return {
    stdout: { on: (event, cb) => add(`stdout:${event}`, cb) },
    stderr: { on: (event, cb) => add(`stderr:${event}`, cb) },
    on: (event, cb) => add(event, cb),
    once: (event, cb) => add(event, cb),
    kill: vi.fn(() => true),
    emit: (event, ...args) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
}

/** spawn 缝:记录每步命令;返回的 children 按序对应,测试手动 emit close。 */
function harness(deps: Partial<UpgradeDeps> = {}) {
  const calls: Array<{
    cmd: string;
    args: readonly string[];
    opts: { cwd?: string; env?: NodeJS.ProcessEnv };
  }> = [];
  const children: FakeChild[] = [];
  const spawn = (
    cmd: string,
    args: readonly string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ cmd, args, opts });
    const child = makeFakeChild();
    children.push(child);
    return child;
  };
  /**
   * 放行当前步骤:emit close 后让出两个微任务,下一步的 spawn 才会发生
   * (runStep 的 close 回调 → for 循环继续 → 下一步 spawn)。
   */
  const closeCurrent = async (code: number | null = 0) => {
    const child = children[children.length - 1];
    child?.emit("close", code);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { calls, children, spawn, closeCurrent, deps };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** npm 路径的共用输入:无 .git(→ npm),校验通过。 */
const ENSURE_SCRIPT = path.join("/proj", "scripts", "ensure-crypto-native.mjs");
/** install 步骤的固定网络参数(#326):显式钉值,防止单独丢参数。 */
const NPM_NET_ARGS = [
  "--ignore-scripts",
  "--loglevel=http",
  "--fetch-timeout=180000",
  "--fetch-retries=3",
];
const npmDeps: Partial<UpgradeDeps> = {
  existsSync: () => false,
  projectDir: "/proj",
  nodeExecPath: "/node/bin/node",
  npmCliResolver: () => "/npm-cli.js",
  verifyNativeBinding: () => true,
};

describe("runUpgrade · npm 安装路径", () => {
  it("固定 install --ignore-scripts → ensure;cwd 与 env 正确", async () => {
    const h = harness({ ...npmDeps, envOverrides: { HTTPS_PROXY: "http://proxy:1" } });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    expect(h.calls[0]).toMatchObject({
      cmd: "/node/bin/node",
      args: ["/npm-cli.js", "install", "-g", "pi-courier@latest", ...NPM_NET_ARGS],
    });
    expect(h.calls[0]!.opts.cwd).toBeUndefined();
    expect(h.calls[0]!.opts.env?.HTTPS_PROXY).toBe("http://proxy:1");

    await h.closeCurrent(0);
    expect(h.calls[1]).toMatchObject({
      cmd: "/node/bin/node",
      args: [ENSURE_SCRIPT],
      opts: { cwd: "/proj" },
    });
    expect(h.calls[1]!.opts.env?.HTTPS_PROXY).toBe("http://proxy:1");

    await h.closeCurrent(0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("npm-cli.js 解析失败回落裸 npm(exotic 布局保持历史行为)", async () => {
    const h = harness({ ...npmDeps, npmCliResolver: () => undefined });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    expect(h.calls[0]).toMatchObject({
      cmd: "npm",
      args: ["install", "-g", "pi-courier@latest", ...NPM_NET_ARGS],
    });

    await h.closeCurrent(0);
    await h.closeCurrent(0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("不再按 .node 是否存在决定参数:没有原生库信息也固定 --ignore-scripts 并跑 ensure", async () => {
    // 旧实现只有“全局根下已有 .node”才加 --ignore-scripts;新实现固定加,
    // 且无论有没有都跑 ensure —— 这两条断言就是回归钉。
    const h = harness(npmDeps);
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    expect(h.calls[0]!.args).toContain("--ignore-scripts");
    expect(h.calls[0]!.args).not.toContain("--foreground-scripts");

    await h.closeCurrent(0);
    expect(h.calls[1]!.args[0]).toMatch(/ensure-crypto-native\.mjs$/);

    await h.closeCurrent(0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("env 合并保留 process.env 继承键", async () => {
    process.env.PI_COURIER_UPDATE_TEST = "inherited";
    try {
      const h = harness({ ...npmDeps, envOverrides: { HTTPS_PROXY: "http://proxy:1" } });
      const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
      await Promise.resolve();

      expect(h.calls[0]!.opts.env?.PI_COURIER_UPDATE_TEST).toBe("inherited");
      expect(h.calls[0]!.opts.env?.HTTPS_PROXY).toBe("http://proxy:1");

      await h.closeCurrent(0);
      await h.closeCurrent(0);
      await expect(promise).resolves.toEqual({ ok: true });
    } finally {
      delete process.env.PI_COURIER_UPDATE_TEST;
    }
  });
});

describe("runUpgrade · git 安装路径", () => {
  it("项目根有 .git → pull / install --ignore-scripts / build / ensure", async () => {
    const h = harness({
      existsSync: (p) => String(p).endsWith(".git"),
      projectDir: "/proj",
      nodeExecPath: "/node/bin/node",
      npmCliResolver: () => "/npm-cli.js",
      verifyNativeBinding: () => true,
    });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });

    await h.closeCurrent(0);
    await h.closeCurrent(0);
    await h.closeCurrent(0);
    await h.closeCurrent(0);
    const outcome = await promise;

    expect(outcome).toEqual({ ok: true });
    expect(h.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([
      "git pull",
      `/node/bin/node /npm-cli.js install ${NPM_NET_ARGS.join(" ")}`,
      "/node/bin/node /npm-cli.js run build",
      `/node/bin/node ${ENSURE_SCRIPT}`,
    ]);
    expect(h.calls.every((c) => c.opts.cwd === "/proj")).toBe(true);
  });
});

describe("runUpgrade · 失败分支(旧版继续,桥不自杀)", () => {
  it("安装非零退出 → ok:false,message 含命令、退出码与 stderr;不跑 ensure", async () => {
    const h = harness(npmDeps);
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    h.children[0]?.emit("stderr:data", Buffer.from("fatal: something bad"));
    await h.closeCurrent(1);
    const outcome = await promise;

    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) {
      expect(outcome.message).toContain("install");
      expect(outcome.message).toContain("exited with code 1");
      expect(outcome.message).toContain("fatal: something bad");
    }
    expect(h.calls).toHaveLength(1);
  });

  it("stdout 洪水被消费,失败信息保留尾部且长度有界", async () => {
    const h = harness(npmDeps);
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    h.children[0]?.emit("stdout:data", Buffer.from(`${"x".repeat(100_000)}STDOUT-END`));
    h.children[0]?.emit("stderr:data", Buffer.from("boom"));
    await h.closeCurrent(1);
    const outcome = await promise;

    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) {
      expect(outcome.message).toContain("STDOUT-END");
      expect(outcome.message).toContain("boom");
      expect(outcome.message.length).toBeLessThan(5000);
    }
  });

  it("ensure 非零退出 → ok:false,校验不被调用", async () => {
    const verify = vi.fn(() => true);
    const h = harness({ ...npmDeps, verifyNativeBinding: verify });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });

    await h.closeCurrent(0);
    h.children[1]?.emit("stderr:data", Buffer.from("download failed"));
    await h.closeCurrent(1);
    const outcome = await promise;

    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.message).toContain("download failed");
    expect(verify).not.toHaveBeenCalled();
  });

  it("ensure 成功但 .node 仍缺失 → ok:false,不进入成功/重启", async () => {
    const h = harness({ ...npmDeps, verifyNativeBinding: () => false });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });

    await h.closeCurrent(0);
    await h.closeCurrent(0);
    const outcome = await promise;

    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.message).toContain("E2EE 原生库");
  });

  it("spawn 同步抛错(ENOENT 等)→ ok:false", async () => {
    const h = harness(npmDeps);
    const outcome = await runUpgrade({
      ...h.deps,
      spawn: () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining("failed to spawn: spawn ENOENT"),
    });
  });

  it("child error 事件(spawn 后失败)→ ok:false,不崩进程", async () => {
    const h = harness(npmDeps);
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    h.children[0]?.emit("error", new Error("spawn EACCES"));
    await h.closeCurrent(null);
    const outcome = await promise;
    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining("spawn EACCES"),
    });
  });

  it("挂死兜底:超时走注入的 killTree,按失败分支处理", async () => {
    vi.useFakeTimers();
    const killTree = vi.fn();
    const h = harness({ ...npmDeps, timeoutMs: 120_000, killTree });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(killTree).toHaveBeenCalledWith(h.children[0]);
    await h.closeCurrent(null);
    const outcome = await promise;
    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining("timed out after 2 min"),
    });
  });

  it("默认超时路径仍调用 child.kill(POSIX 默认)", async () => {
    vi.useFakeTimers();
    const h = harness({ ...npmDeps, timeoutMs: 120_000 });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    await h.closeCurrent(null);
    await expect(promise).resolves.toMatchObject({ ok: false });
  });

  it("ensure 步骤使用独立的更短超时", async () => {
    vi.useFakeTimers();
    const killTree = vi.fn();
    const h = harness({
      ...npmDeps,
      timeoutMs: 60_000,
      ensureTimeoutMs: 5 * 60_000,
      killTree,
    });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    await h.closeCurrent(0); // 安装步骤成功
    expect(h.calls).toHaveLength(2); // ensure 已 spawn
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(killTree).toHaveBeenCalledWith(h.children[1]);
    await h.closeCurrent(null);
    const outcome = await promise;
    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining("timed out after 5 min"),
    });
  });

  it("默认超时上限 30 分钟(与忙闲等待同量级)", () => {
    expect(UPGRADE_TIMEOUT_MS).toBe(30 * 60_000);
  });
});

describe("runUpgrade · 无进展看门狗(#326 代理卡死防护)", () => {
  it("默认阈值/尝试次数/fetch 参数钉值", () => {
    expect(STALL_TIMEOUT_MS).toBe(10 * 60_000);
    expect(UPGRADE_MAX_ATTEMPTS).toBe(3);
    expect(NPM_FETCH_TIMEOUT_MS).toBe(180_000);
    expect(NPM_FETCH_RETRIES).toBe(3);
  });

  it("静默挂死 → 按 stallTimeoutMs 杀树并自动重试,第二次成功", async () => {
    vi.useFakeTimers();
    const killTree = vi.fn();
    const h = harness({ ...npmDeps, stallTimeoutMs: 600_000, killTree });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();
    expect(h.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledWith(h.children[0]);
    await h.closeCurrent(null); // 被杀的第一次尝试

    // 重试同一 install 步骤(npm 缓存续传),这次正常完成 → ensure → ok
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({
      args: ["/npm-cli.js", "install", "-g", "pi-courier@latest", ...NPM_NET_ARGS],
    });
    await h.closeCurrent(0);
    await h.closeCurrent(0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("持续有输出 → 看门狗不断重置,不会被误杀(9 分钟间隔×3 < 30 分钟绝对上限)", async () => {
    vi.useFakeTimers();
    const killTree = vi.fn();
    const h = harness({ ...npmDeps, stallTimeoutMs: 600_000, killTree });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(540_000); // 9 分钟
      h.children[0]?.emit("stdout:data", Buffer.from("npm http fetch GET 200 ok\n"));
    }
    expect(killTree).not.toHaveBeenCalled();
    await h.closeCurrent(0);
    await h.closeCurrent(0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("重试耗尽 → ok:false,信息含无进展语义与命令名,尝试次数恰好封顶", async () => {
    vi.useFakeTimers();
    const killTree = vi.fn();
    const h = harness({ ...npmDeps, stallTimeoutMs: 60_000, maxAttempts: 2, killTree });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60_000);
    await h.closeCurrent(null);
    await vi.advanceTimersByTimeAsync(60_000);
    await h.closeCurrent(null);
    const outcome = await promise;

    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) {
      expect(outcome.message).toContain("no progress for 1 min");
      expect(outcome.message).toContain("install");
    }
    expect(h.calls).toHaveLength(2); // maxAttempts=2,不再多打
    expect(killTree).toHaveBeenCalledTimes(2);
  });

  it("非零退出不重试:真实报错第一次就失败返回", async () => {
    const h = harness(npmDeps);
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    h.children[0]?.emit("stderr:data", Buffer.from("npm error real failure"));
    await h.closeCurrent(1);
    const outcome = await promise;

    expect(outcome).toMatchObject({ ok: false });
    expect(h.calls).toHaveLength(1); // 不重试
  });

  it("stall 杀树后即使 close 0 也不算成功(卡死状态优先于退出码)", async () => {
    vi.useFakeTimers();
    const h = harness({ ...npmDeps, stallTimeoutMs: 60_000, maxAttempts: 1 });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60_000);
    await h.closeCurrent(0); // 诡异的 0 退出:杀树已发生,不可信
    const outcome = await promise;

    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.message).toContain("no progress");
  });
});

describe("runUpgrade · 进度事件(#326 票 #328)", () => {
  it("成功路径:每步 start/done 各一条,序号与总数正确", async () => {
    const h = harness(npmDeps);
    const events: string[] = [];
    const promise = runUpgrade({
      ...h.deps,
      spawn: h.spawn,
      onProgress: (ev) => events.push(`${ev.kind}#${ev.stepIndex}/${ev.totalSteps}`),
    });

    await h.closeCurrent(0);
    await h.closeCurrent(0);
    await expect(promise).resolves.toEqual({ ok: true });

    expect(events).toEqual([
      "step-start#1/2",
      "step-done#1/2",
      "step-start#2/2",
      "step-done#2/2",
    ]);
  });

  it("重试路径:stall-retry 的 attempt 从 2 起,先于重试的 step-start", async () => {
    vi.useFakeTimers();
    const h = harness({ ...npmDeps, stallTimeoutMs: 60_000 });
    type Ev = Parameters<NonNullable<UpgradeDeps["onProgress"]>>[0];
    const events: Ev[] = [];
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn, onProgress: (ev) => events.push(ev) });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60_000);
    await h.closeCurrent(null); // 第一次尝试被杀
    await h.closeCurrent(0); // 第二次尝试成功
    await h.closeCurrent(0); // ensure 成功
    await expect(promise).resolves.toEqual({ ok: true });

    expect(events.map((e) => e.kind)).toEqual([
      "step-start",
      "stall-retry",
      "step-start",
      "step-done",
      "step-start",
      "step-done",
    ]);
    const retry = events.find((e) => e.kind === "stall-retry");
    expect(retry).toMatchObject({ attempt: 2, maxAttempts: 3, stepIndex: 1, totalSteps: 2 });
  });
});

describe("buildUpgradePlan · 桥与 CLI 共用的顺序", () => {
  it("npm: install --ignore-scripts(带网络参数,可重试) → ensure(包根,不可重试)", () => {
    expect(
      buildUpgradePlan({
        projectDir: "/proj",
        nodeExecPath: "/node/bin/node",
        npmCli: "/npm-cli.js",
        installedViaNpm: true,
      }),
    ).toEqual([
      {
        cmd: "/node/bin/node",
        args: ["/npm-cli.js", "install", "-g", "pi-courier@latest", ...NPM_NET_ARGS],
        retriable: true,
      },
      {
        cmd: "/node/bin/node",
        args: [ENSURE_SCRIPT],
        cwd: "/proj",
        timeoutMs: ENSURE_TIMEOUT_MS,
      },
    ]);
  });

  it("git: pull → install --ignore-scripts(可重试) → build → ensure(包根)", () => {
    expect(
      buildUpgradePlan({
        projectDir: "/proj",
        nodeExecPath: "/node/bin/node",
        npmCli: "/npm-cli.js",
        installedViaNpm: false,
        ensureTimeoutMs: 1_234,
      }),
    ).toEqual([
      { cmd: "git", args: ["pull"], cwd: "/proj" },
      {
        cmd: "/node/bin/node",
        args: ["/npm-cli.js", "install", ...NPM_NET_ARGS],
        cwd: "/proj",
        retriable: true,
      },
      { cmd: "/node/bin/node", args: ["/npm-cli.js", "run", "build"], cwd: "/proj" },
      {
        cmd: "/node/bin/node",
        args: [ENSURE_SCRIPT],
        cwd: "/proj",
        timeoutMs: 1_234,
      },
    ]);
  });

  it("npm-cli 解析失败回落裸 npm", () => {
    expect(
      buildUpgradePlan({
        projectDir: "/proj",
        nodeExecPath: "/node/bin/node",
        npmCli: undefined,
        installedViaNpm: true,
      })[0],
    ).toEqual({
      cmd: "npm",
      args: ["install", "-g", "pi-courier@latest", ...NPM_NET_ARGS],
      retriable: true,
    });
  });
});

describe("taskkillArgs · Windows 杀进程树判定(纯函数)", () => {
  it("only returns taskkill args on win32 with a pid", () => {
    expect(taskkillArgs("win32", 123)).toEqual(["/T", "/F", "/PID", "123"]);
    expect(taskkillArgs("win32", undefined)).toBeUndefined();
    expect(taskkillArgs("linux", 123)).toBeUndefined();
    expect(taskkillArgs("darwin", 123)).toBeUndefined();
  });
});

describe("schtasksArgs · 看门狗任务启停参数(纯函数,#326 票 #329)", () => {
  it("win32 → /Change /TN pi-courier-watchdog /DISABLE|/ENABLE;其他平台 undefined", () => {
    expect(schtasksArgs("win32", "disable")).toEqual([
      "/Change",
      "/TN",
      "pi-courier-watchdog",
      "/DISABLE",
    ]);
    expect(schtasksArgs("win32", "enable")).toEqual([
      "/Change",
      "/TN",
      "pi-courier-watchdog",
      "/ENABLE",
    ]);
    expect(schtasksArgs("linux", "disable")).toBeUndefined();
    expect(schtasksArgs("darwin", "enable")).toBeUndefined();
  });

  it("默认控制实现:非 win32 平台为无操作(undefined,CI 在 linux 上跑)", () => {
    expect(defaultWatchdogControl()).toBeUndefined();
  });
});

describe("runUpgrade · 看门狗暂停/恢复(#326 票 #329)", () => {
  it("pause 先于第一步 spawn;成功路径 finally 恢复", async () => {
    const order: string[] = [];
    const h = harness({
      ...npmDeps,
      watchdogControl: {
        pause: async () => {
          order.push("pause");
        },
        resume: async () => {
          order.push("resume");
        },
      },
    });
    const promise = runUpgrade({
      ...h.deps,
      spawn: (cmd, args, opts) => {
        order.push(`spawn:${cmd}`);
        return h.spawn(cmd, args, opts);
      },
    });
    // pause 被注入 → runUpgrade 首个 await 等它;让两个微任务过去,spawn 才发生。
    await Promise.resolve();
    await Promise.resolve();

    await h.closeCurrent(0);
    await h.closeCurrent(0);
    await expect(promise).resolves.toEqual({ ok: true });

    expect(order[0]).toBe("pause");
    expect(order[order.length - 1]).toBe("resume");
    expect(order.filter((e) => e.startsWith("spawn:"))).toHaveLength(2);
  });

  it("安装失败也恢复看门狗(finally 语义,不留瘫痪的守护)", async () => {
    const resume = vi.fn(async () => {});
    const h = harness({
      ...npmDeps,
      watchdogControl: { pause: async () => {}, resume },
    });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();

    h.children[0]?.emit("stderr:data", Buffer.from("fatal: something bad"));
    await h.closeCurrent(1);
    expect(await promise).toMatchObject({ ok: false });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("pause 抛错视为未暂停:升级照常进行且不调用 resume", async () => {
    const resume = vi.fn(async () => {});
    const h = harness({
      ...npmDeps,
      watchdogControl: {
        pause: async () => {
          throw new Error("schtasks access denied");
        },
        resume,
      },
    });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    // pause 抛错同样经过 await;冲刷微任务后再关子进程。
    await Promise.resolve();
    await Promise.resolve();

    await h.closeCurrent(0);
    await h.closeCurrent(0);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("defaultProjectDir · 默认项目根推导(两层,E2E 回归钉)", () => {
  it("dist 布局:dist/update/upgrade.js 上溯两层到项目根", () => {
    // 回归背景(2026-10-28 真机):一层解析把 projDir 落到 dist/,dist/.git
    // 恒不存在 → git 部署被误判成 npm 安装、换血装进 npm 全局而运行中的
    // 部署原地不动;两层解析对源码与 dist 两种布局同样成立。
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const distModuleUrl = new URL("../dist/update/upgrade.js", import.meta.url).href;
    expect(defaultProjectDir(distModuleUrl)).toBe(repoRoot);
  });

  it("源码布局:src/update/*.ts 上溯两层同为项目根(两种布局同一推导)", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const srcModuleUrl = new URL("../src/update/upgrade.ts", import.meta.url).href;
    expect(defaultProjectDir(srcModuleUrl)).toBe(repoRoot);
  });
});
