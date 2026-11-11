/**
 * 桥内换血(桥自更新 spec §5.4、修复 spec #320):/update 编排的 installing
 * 段调这里,把磁盘代码升到 npm latest(git 安装场景则 pull + install + build)。
 *
 * 与 CLI `pi-courier update` 共用 buildUpgradePlan 的步骤构造;两边的差异只在
 * 执行方式:
 *  - 桥内必须异步 spawn —— CLI 的 spawnSync 是同步语境,搬过来会冻结事件
 *    循环、杀掉桥的全部服务能力(升级窗口几分钟,任务要照常服务)。
 *  - 失败永不 process.exit:返回 UpgradeOutcome,旧版继续运行,桥绝不自杀。
 *  - 不 import cli.ts(它在模块加载即跑 main(),npm-runtime.ts 明文
 *    "Kept free of cli.ts imports")。
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
 *  5. 无进展看门狗(#326):npm 的 fetch-timeout 管不住「代理 CONNECT 成功后
 *     响应体挂起」(真机实测挂 28 分钟不中止),stdout/stderr 静默超阈值即
 *     杀树重试(npm 缓存让重试从断点附近继续);npm install 步骤同时固定带
 *     --loglevel=http(每请求一行输出 = 进度心跳)与显式 --fetch-timeout/
 *     --fetch-retries,让普通卡顿在 npm 层先自愈。
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";
import { logger } from "../logger.js";
import { nativeBindingExists, resolveNpmCli } from "../npm-runtime.js";

/** 安装/构建步骤的挂死兜底上限(与忙闲等待上限同量级;可经 deps.timeoutMs 注入)。 */
export const UPGRADE_TIMEOUT_MS = 30 * 60_000;
/** ensure 原生库步骤的上限:缓存命中是秒级,miss 时的下载也不该拖过 10 分钟。 */
export const ENSURE_TIMEOUT_MS = 10 * 60_000;
/** 无进展阈值(#326):子进程静默超过它即视为卡死(代理挂起响应体时 npm 自身
 *  不会中止),杀树重试。真机证据:28 分钟零输出 = 彻底挂死;正常安装即使
 *  慢代理单个请求也在 --loglevel=http 下持续有完成行输出。 */
export const STALL_TIMEOUT_MS = 10 * 60_000;
/** 可重试步骤的最大尝试次数(#326):npm 缓存让每次重试都有净进展,3 次
 *  覆盖「偶发代理抖动」;仍失败则如实上报,交给人决策(如换镜像)。 */
export const UPGRADE_MAX_ATTEMPTS = 3;
/** npm install 步骤的显式网络参数(#326):fetch-timeout 单请求上限(真机同一
 *  代理下 84 秒完成 15MB 下载,3 分钟足够宽裕),retries 让瞬时抖动自愈。 */
export const NPM_FETCH_TIMEOUT_MS = 180_000;
export const NPM_FETCH_RETRIES = 3;
/** 由上面两个常量拼出的固定参数;只加在 install 步骤上(run build 传参会
 *  透给脚本本身,语义完全不同)。 */
const NPM_NET_FLAGS = [
  "--loglevel=http",
  `--fetch-timeout=${NPM_FETCH_TIMEOUT_MS}`,
  `--fetch-retries=${NPM_FETCH_RETRIES}`,
];

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
  /** 无进展阈值(默认 STALL_TIMEOUT_MS;测试注入短值)。
   *  子进程 stdout/stderr 静默超过它即杀树。 */
  stallTimeoutMs?: number;
  /** 可重试步骤的最大尝试次数(默认 UPGRADE_MAX_ATTEMPTS)。 */
  maxAttempts?: number;
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
  /** 失败因无进展被杀(#326)—— 只有它允许重试,普通报错不重试。 */
  stalled?: boolean;
}

/** 保留滚动尾部,避免长时间高输出把内存吃满。 */
function appendTail(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

/** 单步执行的上下文:spawn 缝 + 合并好的 env + 超时杀进程缝。 */
interface StepRunner {
  spawn: NonNullable<UpgradeDeps["spawn"]>;
  env: NodeJS.ProcessEnv;
  killTree: (child: UpgradeChild) => void;
}

/** 单步执行:exit 0 → undefined;非零/超时/无进展/spawn 失败 → 失败描述。 */
function runStep(
  step: UpgradeStep,
  runner: StepRunner,
  defaultTimeoutMs: number,
  stallTimeoutMs: number,
): Promise<StepFailure | undefined> {
  const timeoutMs = step.timeoutMs ?? defaultTimeoutMs;
  return new Promise((resolve) => {
    let child: UpgradeChild;
    try {
      child = runner.spawn(step.cmd, step.args, { cwd: step.cwd, env: runner.env });
    } catch (err) {
      resolve({
        cmd: step.cmd,
        args: step.args,
        detail: `failed to spawn: ${errorMessage(err)}`,
        stderrTail: "",
        stdoutTail: "",
      });
      return;
    }
    let stderr = "";
    let stdout = "";
    // 两路都必须消费:Windows 管道约 64KB,无人读的一侧会把子进程写阻塞。
    // 任意一路有输出同时刷新无进展看门狗(#326)—— 进度信号只认输出活动
    // 本身,不解析 npm 日志文件格式。
    let stalled = false;
    let stallTimer: NodeJS.Timeout;
    const armStallTimer = (): void => {
      stallTimer = setTimeout(() => {
        stalled = true;
        try {
          runner.killTree(child);
        } catch {
          // 已退出则无效
        }
      }, stallTimeoutMs);
    };
    armStallTimer();
    child.stdout?.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk.toString(), STDOUT_TAIL_LIMIT);
      clearTimeout(stallTimer);
      armStallTimer();
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk.toString(), STDERR_TAIL_LIMIT);
      clearTimeout(stallTimer);
      armStallTimer();
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
        runner.killTree(child);
      } catch {
        // 已退出则无效
      }
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(stallTimer);
      if (code === 0 && !timedOut && !stalled && spawnError === undefined) {
        resolve(undefined);
        return;
      }
      const why =
        spawnError ??
        (timedOut
          ? `timed out after ${Math.round(timeoutMs / 60_000)} min and was killed`
          : stalled
            ? `no progress for ${Math.round(stallTimeoutMs / 60_000)} min and was killed`
            : `exited with code ${code ?? "unknown"}`);
      resolve({
        cmd: step.cmd,
        args: step.args,
        detail: why,
        stderrTail: stderr,
        stdoutTail: stdout,
        stalled,
      });
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

/** 纯函数:win32 且有 pid 时返回 taskkill 参数;其余平台/无 pid → undefined
 *  (回落 SIGKILL)。抽成纯函数是为了让 win32 分支在任意 CI runner 可测
 *  (docs/DEVELOPMENT.md §13.6 的平台分支约定)。 */
export function taskkillArgs(
  platform: NodeJS.Platform,
  pid: number | undefined,
): string[] | undefined {
  if (platform !== "win32" || pid === undefined) return undefined;
  return ["/T", "/F", "/PID", String(pid)];
}

/** 超时兜底:Windows 上只 kill 直接子进程杀不掉 npm 的 postinstall 孙进程,
 *  用 taskkill /T 杀整棵树;POSIX 保持 SIGKILL。taskkill 自身失败(不存在/
 *  权限不足)时回落到 child.kill,并挂 error listener 防止未处理 error 事件
 *  击穿桥进程。 */
function defaultKillTree(child: UpgradeChild): void {
  const args = taskkillArgs(process.platform, child.pid);
  if (args) {
    try {
      const killer = nodeSpawn("taskkill", args, { stdio: "ignore" });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      });
      killer.on("close", (code) => {
        if (code !== 0) {
          try {
            child.kill("SIGKILL");
          } catch {
            // 已退出
          }
        }
      });
      killer.unref();
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

/** npm 全局布局解析:node <npm-cli.js> 优先,解析失败回落裸 npm ——
 *  exotic 布局保持历史行为。 */
function npmStep(
  npmCli: string | undefined,
  nodeExecPath: string,
  args: readonly string[],
): { cmd: string; args: string[] } {
  if (npmCli) return { cmd: nodeExecPath, args: [npmCli, ...args] };
  return { cmd: "npm", args: [...args] };
}

/** 一条升级命令;cwd 缺省 = 继承调用方,timeoutMs 缺省 = 安装/构建上限;
 *  retriable = 卡死被杀后允许自动重试(仅 npm install 步骤标记:幂等且
 *  npm 缓存保证每次重试有净进展;真实报错永远不重试)。 */
export interface UpgradeStep {
  cmd: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  retriable?: boolean;
}

export interface UpgradePlanOptions {
  projectDir: string;
  nodeExecPath: string;
  npmCli: string | undefined;
  installedViaNpm: boolean;
  ensureTimeoutMs?: number;
}

/** 原生库恢复脚本的绝对路径:桥与 CLI 共用同一构造。 */
export function ensureScriptPath(projectDir: string): string {
  return path.join(projectDir, "scripts", "ensure-crypto-native.mjs");
}

/** 安装方式检测:项目根有无 .git(npm 全局安装 = 无 .git)。桥与 CLI 共用。 */
export function detectInstalledViaNpm(
  projectDir: string,
  exists: (p: fs.PathLike) => boolean = (p) => fs.existsSync(p),
): boolean {
  return !exists(path.join(projectDir, ".git"));
}

/**
 * 升级步骤的唯一构造点(spec #320):桥内 runUpgrade 与 CLI cmdUpdate 共用,
 * 两边不会再各写一份顺序。固定不变量:
 *  - npm: install --ignore-scripts → ensure(包根) → 由调用方校验 .node
 *  - git: pull → install --ignore-scripts → build → ensure(包根)
 */
export function buildUpgradePlan(opts: UpgradePlanOptions): UpgradeStep[] {
  const ensureScript = ensureScriptPath(opts.projectDir);
  const ensureStep: UpgradeStep = {
    cmd: opts.nodeExecPath,
    args: [ensureScript],
    cwd: opts.projectDir,
    timeoutMs: opts.ensureTimeoutMs ?? ENSURE_TIMEOUT_MS,
  };
  if (opts.installedViaNpm) {
    return [
      {
        ...npmStep(opts.npmCli, opts.nodeExecPath, [
          "install",
          "-g",
          "pi-courier@latest",
          "--ignore-scripts",
          ...NPM_NET_FLAGS,
        ]),
        retriable: true,
      },
      ensureStep,
    ];
  }
  return [
    { cmd: "git", args: ["pull"], cwd: opts.projectDir },
    {
      ...npmStep(opts.npmCli, opts.nodeExecPath, [
        "install",
        "--ignore-scripts",
        ...NPM_NET_FLAGS,
      ]),
      cwd: opts.projectDir,
      retriable: true,
    },
    { ...npmStep(opts.npmCli, opts.nodeExecPath, ["run", "build"]), cwd: opts.projectDir },
    ensureStep,
  ];
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
  const stallTimeoutMs = deps.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  const maxAttempts = deps.maxAttempts ?? UPGRADE_MAX_ATTEMPTS;
  const killTree = deps.killTree ?? defaultKillTree;
  const verifyNativeBinding = deps.verifyNativeBinding ?? nativeBindingExists;
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...deps.envOverrides };

  // 安装方式检测:项目根有无 .git。
  const installedViaNpm = detectInstalledViaNpm(projDir, exists);

  const steps = buildUpgradePlan({
    projectDir: projDir,
    nodeExecPath,
    npmCli,
    installedViaNpm,
    ensureTimeoutMs,
  });

  const runner: StepRunner = { spawn: spawnFn, env: childEnv, killTree };
  for (const step of steps) {
    // 重试只服务「卡死被杀」(#326):npm 缓存让重试从断点附近继续;真实
    // 报错(非零退出)重试也不会好,立即失败如实上报。绝对上限 30 分钟仍在。
    const attempts = step.retriable === true ? maxAttempts : 1;
    let failure: StepFailure | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        logger.warn(
          `[update] 第 ${attempt}/${attempts} 次重试(上次无进展被杀,继续):${step.cmd} ${step.args.join(" ")}`,
        );
      }
      failure = await runStep(step, runner, timeoutMs, stallTimeoutMs);
      if (!failure || !failure.stalled) break;
    }
    if (failure) return { ok: false, message: formatFailure(failure) };
  }

  // 最后一道闸:ensure 脚本即使静默失败(它按 postinstall 语义不抛),也不能
  // 把缺 .node 的新树报成成功 —— 否则下一次重启必崩在 crypto 加载。
  if (!verifyNativeBinding(projDir)) {
    return { ok: false, message: t("update.nativeBindingMissing", { path: projDir }) };
  }
  return { ok: true };
}
