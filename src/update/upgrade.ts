/**
 * 桥内换血(桥自更新 spec §5.4、修复 spec #320):/update 编排的 installing
 * 段调这里,把磁盘代码升到 npm latest(git 安装场景则 pull + install + build)。
 *
 * 与 src/cli.ts cmdUpdate 语义同款(注释交叉引用,两处须同步演进),差异:
 *  - 桥内必须异步 spawn —— cli.ts 的 spawnSync 是 CLI 语境,搬过来会冻结
 *    事件循环、杀掉桥的全部服务能力(升级窗口几分钟,任务要照常服务)。
 *  - 失败永不 process.exit:返回 UpgradeOutcome,旧版继续运行,桥绝不自杀。
 *  - 不 import cli.ts(它在模块加载即跑 main(),npm-runtime.ts:11 明文
 *    "Kept free of cli.ts imports");安装方式检测与原生库校验在新模块自持,
 *    注释指向 cli.ts 对应实现。
 *
 * #320 的关键顺序(不变量):
 *  1. npm 路径**始终**带 --ignore-scripts。npm 11 全局安装是 shallow 布局,
 *     重装会替换整个包目录,旧 .node 一定会被删;依赖 crypto 包的 postinstall
 *     (download-lib.js)又是无条件 15MB GitHub 下载、无超时。跳过所有脚本,
 *     再由下面的 ensure 步骤显式补原生库。
 *  2. 安装完成后单独跑包内的 ensure-crypto-native 脚本(cwd=包根):
 *     缓存优先,miss 时才下载;下载器有超时;继承调用方 env(含代理)。
 *  3. 最后从包根解析 crypto 包并校验 *.node 存在。校验失败 = 升级失败,
 *     不报成功、不触发重启 —— 避免把"重启即崩"的半成品交给用户。
 *  4. 子进程 stdout/stderr 都消费并保留尾部。Windows 管道约 64KB,旧实现
 *     只读 stderr,下载进度把 stdout 写满后子进程会永久阻塞。
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";
import { nativeBindingExists, resolveNpmCli } from "../npm-runtime.js";

/** 安装/构建步骤的挂死兜底上限(与忙闲等待上限同量级;可经 deps.timeoutMs 注入)。 */
export const UPGRADE_TIMEOUT_MS = 30 * 60_000;
/** ensure 原生库步骤的上限:缓存命中是秒级,miss 时的下载也不该拖过 10 分钟。 */
export const ENSURE_TIMEOUT_MS = 10 * 60_000;

const STDERR_TAIL_LIMIT = 600;
const STDOUT_TAIL_LIMIT = 2_048;

export type UpgradeOutcome = { ok: true } | { ok: false; message: string };

/** spawn 缝的最小子进程形状(真实 ChildProcess 天然满足;测试用假件)。 */
export interface UpgradeChild {
  /** Windows 超时杀整棵树需要 PID;假件可省略,回落到 child.kill。 */
  pid?: number;
  stdout: { on(event: "data", listener: (chunk: string | Buffer) => void): void } | null;
  stderr: { on(event: "data", listener: (chunk: string | Buffer) => void): void } | null;
  on(event: "error", listener: (err: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** 单步子进程的 spawn 选项;env 已由 runUpgrade 合并好(process.env + 代理增量)。 */
export interface UpgradeSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface UpgradeDeps {
  spawn?: (cmd: string, args: readonly string[], opts: UpgradeSpawnOptions) => UpgradeChild;
  /** 项目根(默认:dist/ 的父目录,cli.ts projectDir 同款)。 */
  projectDir?: string;
  existsSync?: (p: fs.PathLike) => boolean;
  nodeExecPath?: string;
  /** npm-cli.js 解析缝(默认 npm-runtime 的 resolveNpmCli)。 */
  npmCliResolver?: (nodeExecPath: string) => string | undefined;
  /** 安装/构建步骤超时。 */
  timeoutMs?: number;
  /** ensure 原生库步骤超时(独立于安装步骤)。 */
  ensureTimeoutMs?: number;
  /** 代理等环境增量:每次 spawn 以 {...process.env, ...envOverrides} 合并。 */
  envOverrides?: NodeJS.ProcessEnv;
  /** 超时杀进程缝(默认:win32 有 pid 时 taskkill /T /F,否则 SIGKILL)。 */
  killTree?: (child: UpgradeChild) => void;
  /** 原生库校验缝(默认 npm-runtime 的 nativeBindingExists)。 */
  verifyNativeBinding?: (packageRoot: string) => boolean;
}

interface StepFailure {
  cmd: string;
  args: readonly string[];
  detail: string;
  stderrTail: string;
  stdoutTail: string;
}

/** 保留滚动尾部,避免长时间高输出把内存吃满。 */
function appendTail(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

/** 单步执行:exit 0 → undefined;非零/超时/spawn 失败 → 失败描述。 */
function runStep(
  spawnFn: NonNullable<UpgradeDeps["spawn"]>,
  cmd: string,
  args: readonly string[],
  cwd: string | undefined,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  killTree: (child: UpgradeChild) => void,
): Promise<StepFailure | undefined> {
  return new Promise((resolve) => {
    let child: UpgradeChild;
    try {
      child = spawnFn(cmd, args, { cwd, env });
    } catch (err) {
      resolve({
        cmd,
        args,
        detail: `failed to spawn: ${errorMessage(err)}`,
        stderrTail: "",
        stdoutTail: "",
      });
      return;
    }
    let stderr = "";
    let stdout = "";
    // 两路都必须消费:Windows 管道约 64KB,无人读的一侧会把子进程写阻塞。
    child.stdout?.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk.toString(), STDOUT_TAIL_LIMIT);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk.toString(), STDERR_TAIL_LIMIT);
    });
    let spawnError: string | undefined;
    child.on("error", (err) => {
      // 无 listener 的 error 事件会击穿进程 —— 必须挂;记录后由 close 收口。
      spawnError = errorMessage(err);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        killTree(child);
      } catch {
        // 已退出则无效
      }
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut && spawnError === undefined) {
        resolve(undefined);
        return;
      }
      const why =
        spawnError ??
        (timedOut
          ? `timed out after ${Math.round(timeoutMs / 60_000)} min and was killed`
          : `exited with code ${code ?? "unknown"}`);
      resolve({ cmd, args, detail: why, stderrTail: stderr, stdoutTail: stdout });
    });
  });
}

function defaultSpawn(
  cmd: string,
  args: readonly string[],
  opts: UpgradeSpawnOptions,
): UpgradeChild {
  return nodeSpawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 超时兜底:Windows 上只 kill 直接子进程杀不掉 npm 的 postinstall 孙进程,
 *  用 taskkill /T 杀整棵树;POSIX 保持 SIGKILL。 */
function defaultKillTree(child: UpgradeChild): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      nodeSpawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
      return;
    } catch {
      // 回落 SIGKILL
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 已退出
  }
}

/** npm 全局布局解析(cli.ts npmCommand 同款):node <npm-cli.js> 优先,
 *  解析失败回落裸 npm —— exotic 布局保持历史行为。 */
function npmStep(
  npmCli: string | undefined,
  nodeExecPath: string,
  args: readonly string[],
): { cmd: string; args: string[] } {
  if (npmCli) return { cmd: nodeExecPath, args: [npmCli, ...args] };
  return { cmd: "npm", args: [...args] };
}

/**
 * 默认项目根推导:本模块编译产物在 <root>/dist/update/upgrade.js(源码在
 * <root>/src/update/),距项目根恒为两层。E2E 真机(2026-10-28)曾因只解析
 * 一层把 projDir 落到 dist/,dist/.git 恒不存在 → git 部署被误判成 npm
 * 安装、换血装进 npm 全局而运行中的部署原地不动;两层解析对源码与 dist
 * 两种布局同样成立。
 */
export function defaultProjectDir(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
}

/** 失败信息:命令 + 退出码/超时原因 + stderr/stdout 滚动尾部。 */
function formatFailure(failure: StepFailure): string {
  const tails: string[] = [];
  const stderr = failure.stderrTail.trim();
  const stdout = failure.stdoutTail.trim();
  if (stderr.length > 0) tails.push(`stderr: ${stderr}`);
  if (stdout.length > 0) tails.push(`stdout: ${stdout}`);
  const suffix = tails.length > 0 ? `\n${tails.join("\n")}` : "";
  return `${failure.cmd} ${failure.args.join(" ")} ${failure.detail}${suffix}`;
}

/**
 * 执行升级。任一步失败/超时/校验失败即整体失败(返回 ok:false,不抛),
 * 调用方据此回执 npmFailed 并把状态机放回 idle —— 旧版继续运行,桥绝不自杀。
 */
export async function runUpgrade(deps: UpgradeDeps = {}): Promise<UpgradeOutcome> {
  const projDir = deps.projectDir ?? defaultProjectDir(import.meta.url);
  const exists = deps.existsSync ?? ((p: fs.PathLike) => fs.existsSync(p));
  const nodeExecPath = deps.nodeExecPath ?? process.execPath;
  const npmCli = (deps.npmCliResolver ?? resolveNpmCli)(nodeExecPath);
  const spawnFn = deps.spawn ?? defaultSpawn;
  const timeoutMs = deps.timeoutMs ?? UPGRADE_TIMEOUT_MS;
  const ensureTimeoutMs = deps.ensureTimeoutMs ?? ENSURE_TIMEOUT_MS;
  const killTree = deps.killTree ?? defaultKillTree;
  const verifyNativeBinding = deps.verifyNativeBinding ?? nativeBindingExists;
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...deps.envOverrides };

  const ensureScript = path.join(projDir, "scripts", "ensure-crypto-native.mjs");
  if (!exists(ensureScript)) {
    return {
      ok: false,
      message: `upgrade aborted: native binding ensure script not found: ${ensureScript}`,
    };
  }

  // 安装方式检测(cli.ts 同款):项目根有无 .git。
  const installedViaNpm = !exists(path.join(projDir, ".git"));

  const steps: Array<{ cmd: string; args: string[]; cwd?: string; timeoutMs?: number }> = [];
  if (installedViaNpm) {
    // npm 路径:#320 固定 --ignore-scripts,装完再显式补原生库。
    steps.push(npmStep(npmCli, nodeExecPath, ["install", "-g", "pi-courier@latest", "--ignore-scripts"]));
    steps.push({
      cmd: nodeExecPath,
      args: [ensureScript],
      cwd: projDir,
      timeoutMs: ensureTimeoutMs,
    });
  } else {
    // git 路径:git pull → npm install(--ignore-scripts)→ npm run build → ensure。
    steps.push({ cmd: "git", args: ["pull"], cwd: projDir });
    steps.push({ ...npmStep(npmCli, nodeExecPath, ["install", "--ignore-scripts"]), cwd: projDir });
    steps.push({ ...npmStep(npmCli, nodeExecPath, ["run", "build"]), cwd: projDir });
    steps.push({
      cmd: nodeExecPath,
      args: [ensureScript],
      cwd: projDir,
      timeoutMs: ensureTimeoutMs,
    });
  }

  for (const step of steps) {
    logger.info(`[update] $ ${step.cmd} ${step.args.join(" ")}`);
    const failure = await runStep(
      spawnFn,
      step.cmd,
      step.args,
      step.cwd,
      step.timeoutMs ?? timeoutMs,
      childEnv,
      killTree,
    );
    if (failure) return { ok: false, message: formatFailure(failure) };
  }

  // 最后一道闸:ensure 脚本即使静默失败(它按 postinstall 语义不抛),也不能
  // 把缺 .node 的新树报成成功 —— 否则下一次重启必崩在 crypto 加载。
  if (!verifyNativeBinding(projDir)) {
    return {
      ok: false,
      message:
        `native crypto binding is missing after ensure in ${projDir}; refusing to report success. ` +
        `The previous process keeps running — do not restart until the binding is restored.`,
    };
  }
  return { ok: true };
}