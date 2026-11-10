import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUpgradePlan,
  defaultProjectDir,
  ENSURE_TIMEOUT_MS,
  runUpgrade,
  taskkillArgs,
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
      args: ["/npm-cli.js", "install", "-g", "pi-courier@latest", "--ignore-scripts"],
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
      args: ["install", "-g", "pi-courier@latest", "--ignore-scripts"],
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
      "/node/bin/node /npm-cli.js install --ignore-scripts",
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

describe("buildUpgradePlan · 桥与 CLI 共用的顺序", () => {
  it("npm: install --ignore-scripts → ensure(包根)", () => {
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
        args: ["/npm-cli.js", "install", "-g", "pi-courier@latest", "--ignore-scripts"],
      },
      {
        cmd: "/node/bin/node",
        args: [ENSURE_SCRIPT],
        cwd: "/proj",
        timeoutMs: ENSURE_TIMEOUT_MS,
      },
    ]);
  });

  it("git: pull → install --ignore-scripts → build → ensure(包根)", () => {
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
        args: ["/npm-cli.js", "install", "--ignore-scripts"],
        cwd: "/proj",
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
      args: ["install", "-g", "pi-courier@latest", "--ignore-scripts"],
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
