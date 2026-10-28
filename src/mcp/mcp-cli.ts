/**
 * McpCli — pi `mcp` 子命令的执行缝(spec #246;spawn 缝形状与热更新分支
 * feat/hot-update-command 的 upgrade.ts 同构 —— 该先例未并入本分支基线,
 * 本文件不依赖它,仅设计出处)。桥把聊天命令翻译成对
 * `node <pi dist/cli.js> mcp …` 的外调:
 *  - pi 二进制定位复用 PiRpc.resolveCliPath(单一来源,不另造解析链;
 *    生产接线由组合根传入 config.cliPath 作解析头段,与桥子进程同源);
 *  - 以 node + JS 入口方式 spawn,绕开 pi.dev 托管安装的 shell 包装器
 *    (bin/pi 是 POSIX shell 脚本,node 直接跑必死,issue #111 同源);
 *  - 短命令(add/remove/logout/list)统一 120s 超时上限;login 是长命令,
 *    stdout 逐行上抛(授权 URL 要即时转发聊天),`--timeout` 桥侧硬上限
 *    600s,到点外加宽限期再 SIGKILL(让 pi 自己的优雅超时先收尾)。
 *
 * 执行缝接口(spawn / resolveCliPath)全部可注入:登录编排器与命令层的
 * 行为测试一律喂假件,真实 pi 与外部 MCP 服务器不进测试(spec Testing
 * Decisions)。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";
import { logger } from "../logger.js";
import { PiRpc } from "../rpc/pi-rpc.js";
import {
  type McpListPayload,
  parseMcpListJson,
} from "./mcp-formatters.js";

/** 短命令(add/remove/logout/list)的统一超时上限:都是本地配置读写,
 *  list 里的连接探测是唯一慢源,120s 足够且远短于聊天侧的耐心。 */
export const MCP_SHORT_TIMEOUT_MS = 120_000;

/** login `--timeout` 的桥侧硬上限(秒):用户传更大的值也钳到这里。 */
export const MCP_LOGIN_TIMEOUT_MAX_S = 600;

/** pi 自身到点会放弃并输出收尾文案,桥的 SIGKILL 只在宽限期后兜底 ——
 *  别把 pi 的优雅超时误杀成「无 stderr 尾部」的黑箱失败。 */
export const MCP_LOGIN_KILL_GRACE_MS = 10_000;

/** login 未指定时长时的缺省(与 pi CLI 的默认一致)。 */
export const MCP_LOGIN_DEFAULT_TIMEOUT_S = 300;

/** spawn 失败/非零退出时回执里带的 stderr 尾部上限(热更新分支 upgrade.ts
 *  缝的同量级取值)。 */
const STDERR_TAIL_LIMIT = 600;

/** spawn 缝的最小子进程形状(真实 ChildProcess 天然满足;测试用假件)。 */
export interface McpChild {
  stdout: { on(event: "data", listener: (chunk: string | Buffer) => void): void } | null;
  stderr: { on(event: "data", listener: (chunk: string | Buffer) => void): void } | null;
  on(event: "error", listener: (err: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type McpSpawn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string },
) => McpChild;

export interface McpCliDeps {
  /** spawn 缝(默认 node child_process.spawn;测试注入假件)。 */
  spawn?: McpSpawn;
  /** pi JS 入口解析缝(默认 PiRpc.resolveCliPath;测试注入固定路径)。 */
  resolveCliPath?: () => Promise<string>;
  /** node 可执行文件(默认 process.execPath;与 cliPath 拼成 spawn 命令)。 */
  nodeExecPath?: string;
  /** 短命令超时上限(ms;默认 MCP_SHORT_TIMEOUT_MS)。 */
  shortTimeoutMs?: number;
  /** login `--timeout` 硬上限(秒;默认 MCP_LOGIN_TIMEOUT_MAX_S)。 */
  loginTimeoutMaxS?: number;
  /** 日志缝(默认桥全局 logger;测试注入静音件)。 */
  logger?: Pick<typeof logger, "info" | "warn" | "error">;
}

/** 统一判别结果:unavailable 单独成支(pi 缺失 / 未知子命令 → 提示需 pi ≥ 1.0,
 *  命令层给版本门回执,与普通失败文案不同)。ok 的 confirmed 仅突变子命令
 *  (add/remove/logout)携带:exit 0 且输出含 pi ≥1.0 的成功确认形状 → true;
 *  否则 false(旧版 pi 把命令当 prompt 喂模型的历史形态,版本门拦不住,
 *  命令层据此给回执与审计降级提示,不判失败 —— 容忍 pi 文案漂移)。 */
export type McpOutcome<T> =
  | { kind: "ok"; data: T; confirmed?: boolean }
  | { kind: "failed"; message: string }
  | { kind: "unavailable"; message: string };

/** startLogin 的收尾数据(成败归编排器按 code/timedOut 与行事件判定)。 */
export interface McpLoginResult {
  /** 进程退出码;被信号杀/spawn 失败时 undefined。 */
  code: number | undefined;
  /** 桥侧兜底 SIGKILL 是否触发(pi 自己到点放弃不算)。 */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** spawn 本身失败(ENOENT 等)的描述;正常退出为 undefined。 */
  spawnError?: string;
  /** pi 入口解析失败(pi 缺失等)的版本门描述;编排器据此结算
   *  unavailable(而非 failed)—— 与短命令的版本门回执同口径。 */
  unavailable?: string;
}

interface RawRun {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut: boolean;
}

/** 版本门特征:pi 缺失(ENOENT)或 pi 不认识这条子命令。旧版 pi(<1.0)
 *  会把未知命令当 prompt 喂模型(stdout 是模型回复、exit 0),那种历史
 *  形态没有稳定特征,拦不住 —— 版本门只对「有明确 unknown 特征」与
 *  「pi 二进制不在」两种可判形态负责;喂模型的形态由突变命令的
 *  确认形状检查(MUTATION_CONFIRMED)在回执/审计层面降级提示。 */
function unavailableReason(run: RawRun): string | undefined {
  if (run.spawnError !== undefined) {
    return t("cmd.mcp.detail.spawnFailed", { message: run.spawnError });
  }
  const combined = `${run.stderr}\n${run.stdout}`;
  if (/unknown (mcp )?command/i.test(combined)) {
    return t("cmd.mcp.detail.unknownSubcommand", {
      detail: oneTail(run.stderr) || oneTail(run.stdout),
    });
  }
  return undefined;
}

/** pi 入口解析链(配置段 → which pi → node_modules)自身失败(pi 缺失):
 *  四条短命令与 login 都在此收口成版本门 unavailable,不冒泡 —— 冒泡到
 *  router 外层 catch 只会换来「通用错误」回执,违背契约的版本门回执。 */
async function resolveCliOrUnavailable(
  resolve: () => Promise<string>,
): Promise<{ kind: "ok"; cliPath: string } | { kind: "unavailable"; message: string }> {
  try {
    return { kind: "ok", cliPath: await resolve() };
  } catch (err) {
    return {
      kind: "unavailable",
      message: t("cmd.mcp.detail.cliLocate", { message: errorMessage(err) }),
    };
  }
}

/** pi 1.0.0 突变子命令的成功确认形状(实测自 pi 1.0.0
 *  dist/extensions/mcp/cli.js:308/340/175 —— add `Added|Replaced … MCP server
 *  "x" in …`、remove `Removed … MCP server "x" from …`、logout
 *  `Signed out of MCP server "x".`,以及「无已存凭证」的正常路径
 *  `No stored credentials for MCP server "x".`(同为 exit 0,重复登出/从未
 *  登录过的 OAuth 服务器即走此支 —— 必须算确认,否则正常路径会被误报成
 *  旧版 pi 当提示词的降级形态)。旧版 pi(<1.0)把命令当 prompt 喂模型时
 *  exit 0 且无 unknown 特征,版本门拦不住;这里按「输出是否以确认文案开头」
 *  给 confirmed 信号,命令层据此在回执与审计降级提示 —— 不判失败,容忍
 *  pi 文案漂移。 */
const MUTATION_CONFIRMED = {
  add: /^(added|replaced)\s/i,
  remove: /^removed\s/i,
  logout: /^(signed out of|no stored credentials for)\b/i,
} as const;

/** exit 0 的突变命令输出是否含对应子命令的成功确认形状(trim 后首行判定)。 */
function mutationConfirmed(sub: keyof typeof MUTATION_CONFIRMED, stdout: string): boolean {
  return MUTATION_CONFIRMED[sub].test(stdout.trim());
}

function oneTail(text: string): string {
  const tail = text.trim();
  if (tail.length === 0) return "";
  return tail.length > STDERR_TAIL_LIMIT ? `…${tail.slice(-STDERR_TAIL_LIMIT)}` : tail;
}

function defaultSpawn(cmd: string, args: readonly string[], opts: { cwd?: string }): McpChild {
  return nodeSpawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** 子命令运行的已解析环境(resolveDeps 的产出 + 本条的 cliPath)。 */
interface SubcommandEnv {
  spawn: McpSpawn;
  nodeExecPath: string;
  cliPath: string;
  log: Pick<typeof logger, "info" | "warn" | "error">;
}

/** 组装 argv 并跑一条短命令:node <cli.js> mcp <子命令...>。 */
function runMcpSubcommand(
  subArgs: readonly string[],
  timeoutMs: number,
  env: SubcommandEnv,
): Promise<RawRun> {
  const { spawn, nodeExecPath, cliPath, log } = env;
  const args = [cliPath, "mcp", ...subArgs];
  // 日志只落子命令形状,不落完整 args —— args 里可能有 --env/--header 的
  // 值(密钥),桥日志是持久面,值不能进(spec 回执安全同款纪律)。
  log.info(`[mcp] spawn: ${nodeExecPath} <pi-cli> mcp ${subArgs[0] ?? ""}(${subArgs.length - 1} 个参数)`);
  return new Promise((resolve) => {
    let child: McpChild;
    try {
      child = spawn(nodeExecPath, args, {});
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", spawnError: errorMessage(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
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
      resolve({
        code,
        stdout,
        stderr,
        ...(spawnError !== undefined ? { spawnError } : {}),
        timedOut,
      });
    });
  });
}

function resolveDeps(deps: McpCliDeps): {
  spawn: McpSpawn;
  nodeExecPath: string;
  shortTimeoutMs: number;
  loginTimeoutMaxS: number;
  log: Pick<typeof logger, "info" | "warn" | "error">;
  resolveCliPath: () => Promise<string>;
} {
  return {
    spawn: deps.spawn ?? defaultSpawn,
    nodeExecPath: deps.nodeExecPath ?? process.execPath,
    shortTimeoutMs: deps.shortTimeoutMs ?? MCP_SHORT_TIMEOUT_MS,
    loginTimeoutMaxS: deps.loginTimeoutMaxS ?? MCP_LOGIN_TIMEOUT_MAX_S,
    log: deps.logger ?? logger,
    resolveCliPath: deps.resolveCliPath ?? (() => PiRpc.resolveCliPath()),
  };
}

function timeoutMessage(label: string, timeoutMs: number): string {
  return t("cmd.mcp.detail.timeout", { label, seconds: Math.round(timeoutMs / 1000) });
}

/** 无 stderr 尾部时的退出码兜底(串进双表;code 为 null 走「未知」分支)。 */
function exitCodeMessage(sub: "add" | "remove" | "logout", code: number | null): string {
  return code === null
    ? t("cmd.mcp.detail.exitCodeUnknown", { sub })
    : t("cmd.mcp.detail.exitCode", { sub, code });
}

// ---------------------------------------------------------------------------
// 类型化助手:短命令四件 + login 长命令
// ---------------------------------------------------------------------------

/**
 * `pi mcp list --json`:成败按 JSON 内容判定,不看退出码 —— pi 对任一
 * 启用服务器未连接即退出非零,直接用会把部分失败误报成全失败。JSON 能
 * 解析即 ok(payload 里照常带 errors/逐服务器 error,由格式化卡展示)。
 */
export async function listServers(
  deps: McpCliDeps = {},
): Promise<McpOutcome<McpListPayload>> {
  const d = resolveDeps(deps);
  const located = await resolveCliOrUnavailable(d.resolveCliPath);
  if (located.kind === "unavailable") return located;
  const run = await runMcpSubcommand(["list", "--json"], d.shortTimeoutMs, {
    spawn: d.spawn,
    nodeExecPath: d.nodeExecPath,
    cliPath: located.cliPath,
    log: d.log,
  });
  const gate = unavailableReason(run);
  if (gate) return { kind: "unavailable", message: gate };
  if (run.timedOut) return { kind: "failed", message: timeoutMessage("pi mcp list", d.shortTimeoutMs) };
  const payload = parseMcpListJson(run.stdout);
  if (payload) return { kind: "ok", data: payload };
  const detail = oneTail(run.stderr) || oneTail(run.stdout);
  return {
    kind: "failed",
    message: detail
      ? t("cmd.mcp.detail.listUnparsableDetail", { detail })
      : t("cmd.mcp.detail.listUnparsable"),
  };
}

/**
 * `pi mcp add ...`:addArgs 是命令层分词后的 add 参数(服务器名、--url /
 * `--` 命令段、--env/--header/--cwd/--description/--exposure),原样透传,
 * 校验归 pi。退出码判定:add/remove/logout 是本地配置写,快速失败,可靠。
 */
export async function addServer(
  addArgs: readonly string[],
  deps: McpCliDeps = {},
): Promise<McpOutcome<string>> {
  const d = resolveDeps(deps);
  const located = await resolveCliOrUnavailable(d.resolveCliPath);
  if (located.kind === "unavailable") return located;
  const run = await runMcpSubcommand(["add", ...addArgs], d.shortTimeoutMs, {
    spawn: d.spawn,
    nodeExecPath: d.nodeExecPath,
    cliPath: located.cliPath,
    log: d.log,
  });
  const gate = unavailableReason(run);
  if (gate) return { kind: "unavailable", message: gate };
  if (run.timedOut) return { kind: "failed", message: timeoutMessage("pi mcp add", d.shortTimeoutMs) };
  if (run.code === 0 && run.spawnError === undefined) {
    const stdout = run.stdout.trim();
    return { kind: "ok", data: stdout, confirmed: mutationConfirmed("add", stdout) };
  }
  const detail = oneTail(run.stderr) || oneTail(run.stdout);
  return { kind: "failed", message: detail || exitCodeMessage("add", run.code) };
}

/** `pi mcp remove <名>`。 */
export async function removeServer(
  name: string,
  deps: McpCliDeps = {},
): Promise<McpOutcome<string>> {
  const d = resolveDeps(deps);
  const located = await resolveCliOrUnavailable(d.resolveCliPath);
  if (located.kind === "unavailable") return located;
  const run = await runMcpSubcommand(["remove", name], d.shortTimeoutMs, {
    spawn: d.spawn,
    nodeExecPath: d.nodeExecPath,
    cliPath: located.cliPath,
    log: d.log,
  });
  const gate = unavailableReason(run);
  if (gate) return { kind: "unavailable", message: gate };
  if (run.timedOut) return { kind: "failed", message: timeoutMessage("pi mcp remove", d.shortTimeoutMs) };
  if (run.code === 0 && run.spawnError === undefined) {
    const stdout = run.stdout.trim();
    return { kind: "ok", data: stdout, confirmed: mutationConfirmed("remove", stdout) };
  }
  const detail = oneTail(run.stderr) || oneTail(run.stdout);
  return { kind: "failed", message: detail || exitCodeMessage("remove", run.code) };
}

/** `pi mcp logout <名>`。 */
export async function logoutServer(
  name: string,
  deps: McpCliDeps = {},
): Promise<McpOutcome<string>> {
  const d = resolveDeps(deps);
  const located = await resolveCliOrUnavailable(d.resolveCliPath);
  if (located.kind === "unavailable") return located;
  const run = await runMcpSubcommand(["logout", name], d.shortTimeoutMs, {
    spawn: d.spawn,
    nodeExecPath: d.nodeExecPath,
    cliPath: located.cliPath,
    log: d.log,
  });
  const gate = unavailableReason(run);
  if (gate) return { kind: "unavailable", message: gate };
  if (run.timedOut) return { kind: "failed", message: timeoutMessage("pi mcp logout", d.shortTimeoutMs) };
  if (run.code === 0 && run.spawnError === undefined) {
    const stdout = run.stdout.trim();
    return { kind: "ok", data: stdout, confirmed: mutationConfirmed("logout", stdout) };
  }
  const detail = oneTail(run.stderr) || oneTail(run.stdout);
  return { kind: "failed", message: detail || exitCodeMessage("logout", run.code) };
}

/**
 * `pi mcp login <名> --timeout <秒>`:长命令。stdout 逐行上抛(onLine,
 * 换行切分;close 时残行不丢);timeoutSec 先钳到桥侧硬上限(≤0/NaN 取
 * 缺省 300),SIGKILL 在 `--timeout` 秒 + 宽限期后才兜底触发。成败由调用
 * 方结合退出码与行事件判定(编排器要区分「本已登录」与「新登录成功」)。
 */
export async function startLogin(
  server: string,
  timeoutSec: number,
  onLine: (line: string) => void,
  deps: McpCliDeps = {},
): Promise<McpLoginResult> {
  const d = resolveDeps(deps);
  const clamped = Number.isFinite(timeoutSec) && timeoutSec > 0
    ? Math.min(Math.floor(timeoutSec), d.loginTimeoutMaxS)
    : MCP_LOGIN_DEFAULT_TIMEOUT_S;
  // 入口解析失败(pi 缺失)不外抛:以 unavailable 字段收口,编排器据此
  // 结算版本门回执(外抛只会在编排层结成普通 failed,丢失版本门语义)。
  let cliPath: string;
  try {
    cliPath = await d.resolveCliPath();
  } catch (err) {
    return {
      code: undefined,
      timedOut: false,
      stdout: "",
      stderr: "",
      unavailable: t("cmd.mcp.detail.cliLocate", { message: errorMessage(err) }),
    };
  }
  const { spawn, nodeExecPath, log } = d;
  const args = [cliPath, "mcp", "login", server, "--timeout", String(clamped)];
  // 服务器名不是密钥,落日志无妨;--env/--header 之类不存在于 login。
  log.info(`[mcp] spawn: ${nodeExecPath} <pi-cli> mcp login "${server}" --timeout ${clamped}`);

  return new Promise((resolve) => {
    let child: McpChild;
    try {
      child = spawn(nodeExecPath, args, {});
    } catch (err) {
      resolve({
        code: undefined,
        timedOut: false,
        stdout: "",
        stderr: "",
        spawnError: errorMessage(err),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let carry = ""; // 跨 chunk 的残行
    const emitLines = (chunk: string | Buffer) => {
      const text = carry + chunk.toString();
      const parts = text.split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      emitLines(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    let spawnError: string | undefined;
    child.on("error", (err) => {
      spawnError = errorMessage(err);
    });
    let timedOut = false;
    const hardLimitMs = clamped * 1000 + MCP_LOGIN_KILL_GRACE_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出则无效
      }
    }, hardLimitMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (carry.length > 0) onLine(carry); // 尾行无换行也上抛,不吞
      resolve({
        code: code ?? undefined,
        timedOut,
        stdout,
        stderr,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    });
  });
}
