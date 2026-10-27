/**
 * 桥内换血(桥自更新 spec §5.4):/update 编排的 installing 段调这里,把
 * 磁盘代码升到 npm latest(git 安装场景则 pull + install + build)。
 *
 * 与 src/cli.ts cmdUpdate 语义同款(注释交叉引用,两处须同步演进),差异:
 *  - 桥内必须异步 spawn —— cli.ts 的 spawnSync 是 CLI 语境,搬过来会冻结
 *    事件循环、杀掉桥的全部服务能力(升级窗口几分钟,任务要照常服务)。
 *  - 失败永不 process.exit:返回 UpgradeOutcome,旧版继续运行,桥绝不自杀。
 *  - 不 import cli.ts(它在模块加载即跑 main(),npm-runtime.ts:11 明文
 *    "Kept free of cli.ts imports");安装方式检测与 E2EE 原生库判定在新模块
 *    自持,注释指向 cli.ts 对应实现。
 *  - 挂死兜底:升级命令无内置超时(git pull 无超时、npm 锁等待可无限挂),
 *    挂起即 installing 永久占用、/update 族永久 inProgress —— 到点 SIGKILL,
 *    按失败分支处理(§5.4)。
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";
import { globalNodeModulesDir, resolveNpmCli } from "../npm-runtime.js";

/** 升级挂死兜底上限(与忙闲等待上限同量级;可经 deps.timeoutMs 注入)。 */
export const UPGRADE_TIMEOUT_MS = 30 * 60_000;

const STDERR_TAIL_LIMIT = 600;

export type UpgradeOutcome = { ok: true } | { ok: false; message: string };

/** spawn 缝的最小子进程形状(真实 ChildProcess 天然满足;测试用假件)。 */
export interface UpgradeChild {
  stdout: { on(event: "data", listener: (chunk: string | Buffer) => void): void } | null;
  stderr: { on(event: "data", listener: (chunk: string | Buffer) => void): void } | null;
  on(event: "error", listener: (err: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface UpgradeDeps {
  spawn?: (cmd: string, args: readonly string[], opts: { cwd?: string }) => UpgradeChild;
  /** 项目根(默认:dist/ 的父目录,cli.ts projectDir 同款)。 */
  projectDir?: string;
  existsSync?: (p: fs.PathLike) => boolean;
  readdirSync?: (p: fs.PathLike) => string[];
  nodeExecPath?: string;
  platform?: NodeJS.Platform;
  appData?: string | undefined;
  homeDir?: string;
  /** npm-cli.js 解析缝(默认 npm-runtime 的 resolveNpmCli)。 */
  npmCliResolver?: (nodeExecPath: string) => string | undefined;
  timeoutMs?: number;
}

interface StepFailure {
  cmd: string;
  args: readonly string[];
  detail: string;
  stderrTail: string;
}

/** 单步执行:exit 0 → undefined;非零/超时/spawn 失败 → 失败描述。 */
function runStep(
  spawnFn: NonNullable<UpgradeDeps["spawn"]>,
  cmd: string,
  args: readonly string[],
  cwd: string | undefined,
  timeoutMs: number
): Promise<StepFailure | undefined> {
  return new Promise((resolve) => {
    let child: UpgradeChild;
    try {
      child = spawnFn(cmd, args, { cwd });
    } catch (err) {
      resolve({ cmd, args, detail: `failed to spawn: ${errorMessage(err)}`, stderrTail: "" });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
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
        child.kill("SIGKILL");
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
      const tail = stderr.length > STDERR_TAIL_LIMIT ? stderr.slice(-STDERR_TAIL_LIMIT) : stderr;
      const why = spawnError ?? (timedOut ? `timed out after ${Math.round(timeoutMs / 60_000)} min and was killed` : `exited with code ${code ?? "unknown"}`);
      resolve({ cmd, args, detail: why, stderrTail: tail });
    });
  });
}

function defaultSpawn(cmd: string, args: readonly string[], opts: { cwd?: string }): UpgradeChild {
  return nodeSpawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * E2EE 原生库在位判定 —— cli.ts e2eNativeBinaryExists 同款(自持,注释交叉
 * 引用,两处语义须同步演进):全局 node_modules 的
 * @matrix-org/matrix-sdk-crypto-nodejs 下已有 .node 文件 = postinstall 的
 * 21MB 重下载可跳过,升级追加 --ignore-scripts 数秒完成。
 */
function e2eNativeBinaryExists(env: {
  platform: NodeJS.Platform;
  nodeExecPath: string;
  appData?: string | undefined;
  homeDir: string;
  exists: (p: fs.PathLike) => boolean;
  readDir: (p: fs.PathLike) => string[];
}): boolean {
  const globalNodeModules = globalNodeModulesDir({
    platform: env.platform,
    execPath: env.nodeExecPath,
    appData: env.appData,
    homeDir: env.homeDir,
  });
  const cryptoPkgDir = path.join(globalNodeModules, "@matrix-org", "matrix-sdk-crypto-nodejs");
  if (!env.exists(cryptoPkgDir)) return false;
  try {
    return env.readDir(cryptoPkgDir).some((f) => f.endsWith(".node"));
  } catch {
    return false;
  }
}

/** npm 全局布局解析(cli.ts npmCommand 同款):node <npm-cli.js> 优先,
 *  解析失败回落裸 npm —— exotic 布局保持历史行为。 */
function npmStep(npmCli: string | undefined, nodeExecPath: string, args: readonly string[]): { cmd: string; args: string[] } {
  if (npmCli) return { cmd: nodeExecPath, args: [npmCli, ...args] };
  return { cmd: "npm", args: [...args] };
}

/**
 * 执行升级。任一步失败/超时即整体失败(返回 ok:false,不抛),调用方据此
 * 回执 npmFailed 并把状态机放回 idle —— 旧版继续运行,桥绝不自杀。
 */
export async function runUpgrade(deps: UpgradeDeps = {}): Promise<UpgradeOutcome> {
  const projDir =
    deps.projectDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const exists = deps.existsSync ?? ((p: fs.PathLike) => fs.existsSync(p));
  const readDir = deps.readdirSync ?? ((p: fs.PathLike) => fs.readdirSync(p));
  const nodeExecPath = deps.nodeExecPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const homeDir = deps.homeDir ?? os.homedir();
  const appData = deps.appData ?? process.env.APPDATA;
  const npmCli = (deps.npmCliResolver ?? resolveNpmCli)(nodeExecPath);
  const spawnFn = deps.spawn ?? defaultSpawn;
  const timeoutMs = deps.timeoutMs ?? UPGRADE_TIMEOUT_MS;

  // 安装方式检测(cli.ts:327 同款):项目根有无 .git。
  const installedViaNpm = !exists(path.join(projDir, ".git"));

  const steps: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  if (installedViaNpm) {
    // npm 路径(cli.ts:353-361 同款命令构造):--foreground-scripts 让
    // postinstall 输出实时可见;E2EE 原生库已存在时追加 --ignore-scripts。
    const npmArgs = ["install", "-g", "pi-courier@latest", "--foreground-scripts"];
    if (
      e2eNativeBinaryExists({ platform, nodeExecPath, appData, homeDir, exists, readDir })
    ) {
      npmArgs.push("--ignore-scripts");
    }
    const step = npmStep(npmCli, nodeExecPath, npmArgs);
    steps.push(step);
  } else {
    // git 路径(cli.ts:373-377 同款):git pull → npm install → npm run build,
    // 逐步执行,cwd 为项目根。
    steps.push({ cmd: "git", args: ["pull"], cwd: projDir });
    steps.push({ ...npmStep(npmCli, nodeExecPath, ["install"]), cwd: projDir });
    steps.push({ ...npmStep(npmCli, nodeExecPath, ["run", "build"]), cwd: projDir });
  }

  for (const step of steps) {
    logger.info(`[update] $ ${step.cmd} ${step.args.join(" ")}`);
    const failure = await runStep(spawnFn, step.cmd, step.args, step.cwd, timeoutMs);
    if (failure) {
      const suffix = failure.stderrTail.trim().length > 0 ? `: ${failure.stderrTail.trim()}` : "";
      return {
        ok: false,
        message: `${failure.cmd} ${failure.args.join(" ")} ${failure.detail}${suffix}`,
      };
    }
  }
  return { ok: true };
}
