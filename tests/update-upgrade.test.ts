import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultProjectDir,
  runUpgrade,
  UPGRADE_TIMEOUT_MS,
  type UpgradeDeps,
} from "../src/update/upgrade.js";

interface FakeChild {
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
  const calls: Array<{ cmd: string; args: readonly string[]; opts: { cwd?: string } }> = [];
  const children: FakeChild[] = [];
  const spawn = (cmd: string, args: readonly string[], opts: { cwd?: string }) => {
    calls.push({ cmd, args, opts });
    const child = makeFakeChild();
    children.push(child);
    return child;
  };
  const closeAll = (code: number | null) => {
    for (const child of children) child.emit("close", code);
  };
  return { calls, children, spawn, closeAll, deps };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runUpgrade · npm 安装路径", () => {
  it("命令构造:node <npm-cli.js> install -g pi-courier@latest --foreground-scripts", async () => {
    const h = harness({
      existsSync: () => false, // 无 .git → npm 路径;crypto 目录不存在 → 无 --ignore-scripts
      npmCliResolver: () => "/node/lib/node_modules/npm/bin/npm-cli.js",
      nodeExecPath: "/node/bin/node",
    });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();
    h.closeAll(0);
    const outcome = await promise;
    expect(outcome).toEqual({ ok: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({
      cmd: "/node/bin/node",
      args: ["/node/lib/node_modules/npm/bin/npm-cli.js", "install", "-g", "pi-courier@latest", "--foreground-scripts"],
      opts: { cwd: undefined },
    });
  });

  it("npm-cli.js 解析失败回落裸 npm(exotic 布局保持历史行为)", async () => {
    const h = harness({ existsSync: () => false, npmCliResolver: () => undefined });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();
    h.closeAll(0);
    await promise;
    expect(h.calls[0]).toMatchObject({ cmd: "npm", args: ["install", "-g", "pi-courier@latest", "--foreground-scripts"] });
  });

  it("E2EE 原生库已存在 → 追加 --ignore-scripts(cli.ts 同款捷径)", async () => {
    const h = harness({
      existsSync: (p) => String(p).includes("matrix-sdk-crypto-nodejs"),
      readdirSync: () => ["matrix_sdk_crypto.linux-x64-gnu.node", "package.json"],
      npmCliResolver: () => "/npm-cli.js",
    });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();
    h.closeAll(0);
    await promise;
    expect(h.calls[0]!.args.slice(-2)).toEqual(["--foreground-scripts", "--ignore-scripts"]);
  });

  it("E2EE 目录在但无 .node 文件 → 不追加 --ignore-scripts", async () => {
    const h = harness({
      existsSync: (p) => String(p).includes("matrix-sdk-crypto-nodejs"),
      readdirSync: () => ["package.json"],
      npmCliResolver: () => "/npm-cli.js",
    });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();
    h.closeAll(0);
    await promise;
    expect(h.calls[0]!.args).not.toContain("--ignore-scripts");
  });
});

describe("runUpgrade · git 安装路径", () => {
  it("项目根有 .git → git pull / npm install / npm run build,cwd 均为项目根", async () => {
    const h = harness({
      existsSync: (p) => String(p).endsWith(".git"),
      projectDir: "/proj",
      npmCliResolver: () => "/npm-cli.js",
      nodeExecPath: "/node/bin/node",
    });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    // 逐步放行:每步 close(0) 才 spawn 下一步。
    await Promise.resolve();
    h.children[0]?.emit("close", 0);
    await Promise.resolve();
    h.children[1]?.emit("close", 0);
    await Promise.resolve();
    h.children[2]?.emit("close", 0);
    const outcome = await promise;
    expect(outcome).toEqual({ ok: true });
    expect(h.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([
      "git pull",
      "/node/bin/node /npm-cli.js install",
      "/node/bin/node /npm-cli.js run build",
    ]);
    expect(h.calls.every((c) => c.opts.cwd === "/proj")).toBe(true);
  });
});

describe("runUpgrade · 失败分支(旧版继续,桥不自杀)", () => {
  it("非零退出 → ok:false,message 含命令与退出码与 stderr 摘要;后续步骤不跑", async () => {
    const h = harness({ existsSync: (p) => String(p).endsWith(".git"), npmCliResolver: () => undefined });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();
    h.children[0]?.emit("stderr:data", Buffer.from("fatal: something bad"));
    h.children[0]?.emit("close", 1);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) {
      expect(outcome.message).toContain("git pull");
      expect(outcome.message).toContain("exited with code 1");
      expect(outcome.message).toContain("fatal: something bad");
    }
    expect(h.calls).toHaveLength(1); // 失败即停,不跑后续步骤
  });

  it("spawn 同步抛错(ENOENT 等)→ ok:false", async () => {
    const h = harness({ existsSync: () => false });
    const promise = runUpgrade({
      ...h.deps,
      spawn: () => {
        throw new Error("spawn ENOENT");
      },
    });
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("failed to spawn: spawn ENOENT") });
  });

  it("child error 事件(spawn 后失败)→ ok:false,不崩进程", async () => {
    const h = harness({ existsSync: () => false, npmCliResolver: () => undefined });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();
    h.children[0]?.emit("error", new Error("spawn EACCES"));
    h.children[0]?.emit("close", null);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("spawn EACCES") });
  });

  it("挂死兜底:无 close → 到点 SIGKILL → 按失败分支处理", async () => {
    vi.useFakeTimers();
    const h = harness({ existsSync: () => false, timeoutMs: 120_000, npmCliResolver: () => undefined });
    const promise = runUpgrade({ ...h.deps, spawn: h.spawn });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    h.children[0]?.emit("close", null); // kill 后进程退出
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("timed out after 2 min") });
  });

  it("默认超时上限 30 分钟(与忙闲等待同量级)", () => {
    expect(UPGRADE_TIMEOUT_MS).toBe(30 * 60_000);
  });
});

describe("defaultProjectDir · 默认项目根推导(两层,E2E 回归钉)", () => {
  it("dist 布局:dist/update/upgrade.js 上溯两层到项目根", () => {
    // 回归背景(2026-10-28 真机):一层解析把 projDir 落到 dist/,dist/.git
    // 恒不存在 → git 部署被误判成 npm 安装,换血装进 npm 全局。
    // URL 从真实 import.meta.url 派生(带平台盘符)——硬编码 POSIX 路径在
    // Windows 上 fileURLToPath 会抛 ERR_INVALID_FILE_URL_PATH。
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
