/**
 * PiRpc — thin wrapper around the official RpcClient from @earendil-works/pi-coding-agent.
 *
 * Responsibilities:
 *  - Locate the pi CLI (config/env/PATH) and spawn it in --mode rpc
 *  - Retry startup handshake (cold start can take a moment)
 *  - Provide typed convenience methods used by the command map
 *  - Cache get_commands results briefly
 *  - Carry the pi TUI send semantics: prompts go out with an explicit
 *    streamingBehavior (steer = Enter, followUp = Alt+Enter queueing)
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Type-only import: the runtime value (RpcClient) is loaded lazily in
// doStart() — see assertPiEngineSupported for why (pi 1.0+ crashes the
// importing process itself on Node <22.19, before any gate could run).
import type { CompactionResult, RpcClient, RpcEventListener } from "@earendil-works/pi-coding-agent";
import { BASH_TIMEOUT_MINUTES_DEFAULT, loadConfig } from "../config.js";
import {
  joinNoProxyList,
  NO_PROXY_ENV_NAMES,
  PROXY_ENV_NAMES,
  type ProxyConfigInput,
  resolveProxySettings,
} from "../proxy.js";

/** 重启前排空在途请求的兜底上限:进程终究要重启(加载新凭据/扩展),不能
 *  被一条僵死请求无限拖延;正常的桥→pi 请求远快于此。 */
export const RESTART_DRAIN_TIMEOUT_MS = 10_000;

/** bash 自管通道(票 #220)等待上限缺省值:上游 send() 的 30s 写死超时对
 *  长命令(构建/安装/长测试)必误杀,自管通道的超时由此默认,配置可调
 *  (config bashTimeoutMinutes → 组合根注入)。 */
export const BASH_TIMEOUT_MS_DEFAULT = BASH_TIMEOUT_MINUTES_DEFAULT * 60_000;

export interface PiRpcOptions {
  /** Absolute path to pi's dist/cli.js (default: config.cliPath ← PI_CLI_PATH env, then local node_modules, then `which pi`) */
  cliPath?: string;
  /** Working directory for the agent (affects bash tool, project context) */
  cwd?: string;
  /** Extra CLI args, e.g. ["--session-dir", "/path"] */
  args?: string[];
  /** Project label for tagged log lines (multi-project mode; spec #34). */
  label?: string;
  /** 出网代理配置(spec #201 票 #204):派生 pi 子进程时在 spawn 点现算
   *  生效三元组,把覆写增量并入子进程 env。生产主路径由组合根(standalone)
   *  把启动时已加载的 config 经此传入 —— 与桥侧接线(#203 applyProxySettings)
   *  同一对象,RPC 层不再自读配置盘;缺省 loadConfig 兜底,其他入口直接拉起
   *  PiRpc 仍自洽;测试经此注入,免碰真实配置与全局状态。 */
  proxyConfig?: ProxyConfigInput;
  /** bash 自管通道(票 #220)的执行等待上限(ms);缺省 BASH_TIMEOUT_MS_DEFAULT
   *  (10 分钟)。生产主路径由组合根从 config bashTimeoutMinutes 派生注入,
   *  与 proxyConfig 同一注入形态;测试经此注入免碰真实配置。 */
  bashTimeoutMs?: number;
}

/**
 * Wire payload of an extension_ui_response (issue #54). Upstream's parse
 * step reads `value` for select/input/editor, `confirmed` for confirm and
 * treats `cancelled: true` as "user backed out" (default value).
 */
export type ExtensionUIResponsePayload =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

/** bash 执行结果的本地结构视图。上游的 BashResult 未从包入口导出,按字段
 *  结构声明(core/bash-executor.d.ts);上游加字段时这里是收窄的超集,安全。 */
export interface BashResultView {
  /** 合并的 stdout+stderr(已清理、可能截断) */
  output: string;
  /** 进程退出码(被杀/中止时为 undefined) */
  exitCode: number | undefined;
  /** 是否经由信号被中止 */
  cancelled: boolean;
  /** 输出是否被上游截断 */
  truncated: boolean;
  /** 超限输出的完整临时文件路径 */
  fullOutputPath?: string;
}

/** /compact 双源等待的总兜底:compaction_end 事件几乎必达(服务端 emit),
 *  此上限只为进程死亡且重启钩子未触发时的最后保险。 */
export const COMPACT_WAIT_TIMEOUT_MS = 10 * 60_000;

/** 上游 RpcClient.send() 应答超时的报错特征(30s 写死,rpc-client.js):
 *  `Timeout waiting for response to ${command.type}. Stderr: ...`。compact()
 *  借它区分「慢压缩的必然超时」(吞掉,事件收尾)与「即时校验错误」(立即
 *  failed)。上游改文案时此处同步。 */
export const UPSTREAM_TIMEOUT_SENTINEL = "Timeout waiting for response";

/** /compact 的收尾形态(spec #218 票 #219)。上游 send() 把应答超时写死
 *  30 秒且迟到的应答被静默丢弃,慢压缩必然「假失败」——但压缩在服务端
 *  继续并成功,结果随 compaction_end 事件独立送达。三种收尾:成功(应答
 *  或事件,先到先赢;result 缺失=旧版对端降级)、失败(应答即时错误或事件
 *  errorMessage)、中断(重启/被新压缩打断/兜底超时)。 */
export type CompactOutcome =
  | { kind: "ok"; result: CompactionResult | undefined }
  | { kind: "failed"; message: string }
  | { kind: "interrupted"; reason: "restarted" | "aborted" | "timeout" };

/**
 * pi.dev managed install (layout "releases-v1") ships `bin/pi` as a POSIX
 * shell wrapper — not a symlink — so realpath leaves it untouched and node
 * would die parsing shell syntax as JS (issue #111). When `realBin` sits in
 * `<agent>/bin/`, resolve the JS entry the wrapper execs:
 * `<agent>/install/releases/<current-version>/node_modules/@earendil-works/
 * pi-coding-agent/dist/bundle/cli.js`. Undefined whenever the layout doesn't
 * match, leaving the caller's passthrough behavior intact.
 *
 * The layout check itself is platform-neutral: pi.dev's Windows installer
 * (install.ps1) produces the same `install/current-version` +
 * `install/releases` tree, so the Windows discovery path feeds this the
 * default `<agent>/bin/pi` location directly (no `which` hop — see
 * resolveCliPath).
 */
function managedInstallEntry(realBin: string): string | undefined {
  const agentDir = path.dirname(path.dirname(realBin)); // <agent>/bin/pi → <agent>
  let version: string;
  try {
    version = fs
      .readFileSync(path.join(agentDir, "install", "current-version"), "utf-8")
      .trim();
  } catch {
    return undefined;
  }
  if (!version) return undefined;
  const pkgDir = path.join(
    agentDir,
    "install",
    "releases",
    version,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  // dist/bundle/cli.js is the managed layout's entry; dist/cli.js covers a
  // plain npm package shape inside a release dir, should the layout shift.
  for (const rel of ["dist/bundle/cli.js", "dist/cli.js"]) {
    const entry = path.join(pkgDir, ...rel.split("/"));
    if (fs.existsSync(entry)) return entry;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// pi 1.0+ Node engine gate (upstream hard requirement, not a warning)
// ---------------------------------------------------------------------------

/** Parsed "<major>.<minor>.<patch>" triple. */
type SemverTriple = [number, number, number];

function parseSemver(version: string): SemverTriple | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: SemverTriple, b: SemverTriple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * Extract the minimum Node version from an engines range we understand —
 * only the plain ">=x[.y[.z]]" form upstream actually ships. Anything else
 * (caret ranges, OR ranges, no range) returns undefined: skip the gate
 * rather than guess.
 */
export function minNodeVersionOf(engineRange: string): SemverTriple | undefined {
  const match = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(engineRange.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * Read the installed pi package's version and engines.node by walking up
 * from the CLI entry to its package.json. Only the real pi package counts —
 * a custom cliPath pointing at unrelated scripts yields undefined (no gate).
 */
export function piPackageEngines(
  cliPath: string,
): { version: string; enginesNode?: string } | undefined {
  let dir = path.dirname(cliPath);
  for (let depth = 0; depth < 6; depth++) {
    const pkgJsonPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
        name?: string;
        version?: string;
        engines?: { node?: string };
      };
      if (
        pkg.name === "@earendil-works/pi-coding-agent" &&
        typeof pkg.version === "string"
      ) {
        return { version: pkg.version, enginesNode: pkg.engines?.node };
      }
    } catch {
      // no package.json here (or unreadable) — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Refuse to spawn a pi we know will crash on this Node runtime. Since pi
 * 1.0 upstream treats its engines field as a hard contract (pi 1.0 imports
 * `fs.globSync`, a Node 22.19+ API, and dies with a SyntaxError on older
 * Node). The 0.x line is exempt: its engines said ">=22.19.0" too, but the
 * code actually runs fine on Node 20 (verified against 0.83.0) — gating on
 * it would reject combinations that work.
 */
export function assertPiEngineSupported(
  cliPath: string,
  nodeVersion: string = process.version,
): void {
  const pkg = piPackageEngines(cliPath);
  if (!pkg) return;
  const major = parseSemver(pkg.version)?.[0] ?? 0;
  if (major < 1) return; // 0.x: engines claim is unreliable, real-world runs are fine
  const required = pkg.enginesNode ? minNodeVersionOf(pkg.enginesNode) : undefined;
  if (!required) return;
  const running = parseSemver(nodeVersion);
  if (!running) return;
  if (compareSemver(running, required) >= 0) return;
  throw new Error(
    `pi@${pkg.version} requires Node >=${required.join(".")} (hard requirement since pi 1.0), ` +
      `but pi-courier is running on Node ${nodeVersion}. ` +
      `Fix: upgrade Node (e.g. "nvm install 22"), or pin a pre-1.0 pi ` +
      `(e.g. "npm i -g @earendil-works/pi-coding-agent@0.83.0"), ` +
      `or point PI_CLI_PATH at a compatible pi install.`,
  );
}

export class PiRpc {
  private client?: RpcClient;
  private options: PiRpcOptions;
  /** Listeners registered before start() — attached once the client connects */
  private listeners: Array<RpcEventListener | undefined> = [];

  /** In-flight bridge→pi request count (F5 治本):requireClient() 返回的包装
   *  客户端对每个 Promise 型调用计数,重启前排水等待,避免在途请求随进程
   *  死亡被拒收成用户可见的 ❌(Agent process exited code=143)。 */
  private inFlight = 0;
  private wrappedClient?: RpcClient;

  /** Project label for tagged logging (undefined for the shared default rpc).
   *  Mutable: /pmctl rename & mv re-label a running project rpc. */
  label: string | undefined;

  constructor(options: PiRpcOptions = {}) {
    this.options = options;
    this.label = options.label;
  }

  get isConnected(): boolean {
    return this.client !== undefined;
  }

  /** The --session-dir this process was spawned with, if any (issue #56 票5:
   *  /sessions scans it; undefined = pi's default ~/.pi/agent/sessions). */
  get sessionDir(): string | undefined {
    const args = this.options.args ?? [];
    const index = args.indexOf("--session-dir");
    return index >= 0 ? args[index + 1] : undefined;
  }

  /** The working directory this pi process runs in (reply status footer;
   *  default rpc = the resolved workdir, project rpc = the entry's workdir). */
  get cwd(): string | undefined {
    return this.options.cwd;
  }

  /** Locate the pi CLI entry point. Env override (PI_CLI_PATH) is folded
   *  into config.cliPath by loadConfig (spec #72 票4/C4) — this chain only
   *  resolves between the configured path and the two install locations. */
  static async resolveCliPath(): Promise<string> {
    // Windows: there is no `which` (spawning it fails with ENOENT every
    // time — libuv's PATH search only tries .com/.exe), so skip the PATH
    // lookup entirely. pi.dev's install.ps1 produces the same releases-v1
    // tree managedInstallEntry understands at its default agent dir
    // (~/.pi/agent — verified against install.ps1's Get-PiAgentDir), so try
    // that directly; an npm-global pi cannot be auto-detected here and
    // falls through to the local node_modules copy.
    if (process.platform === "win32") {
      const managed = managedInstallEntry(path.join(os.homedir(), ".pi", "agent", "bin", "pi"));
      if (managed) return managed;

      // Local node_modules copy (dev setup / peer auto-install) — same
      // fallback as POSIX.
      try {
        const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
        const entry = fileURLToPath(entryUrl);
        return path.join(path.dirname(entry), "cli.js");
      } catch {
        // fall through
      }

      throw new Error(
        "Cannot locate the pi CLI on Windows. The npm-global install cannot be auto-detected (there is no `which`): " +
          "set PI_CLI_PATH to the dist/cli.js inside your pi package directory — do NOT point it at the pi.cmd / pi.ps1 shim — " +
          "or install pi via pi.dev's install.ps1 (~/.pi/agent), which is detected automatically."
      );
    }

    // 1. System-installed pi (`which pi`, resolve symlink to dist/cli.js).
    //    Preferred: pi is installed independently and upgraded on its own.
    try {
      const bin = execFileSync("which", ["pi"], { encoding: "utf-8" }).trim();
      if (bin) {
        const real = fs.realpathSync(bin);
        // npm-installed pi is a symlink to a JS entry — node runs it as-is.
        if (/\.[cm]?js$/i.test(real)) return real;
        // pi.dev managed install (layout releases-v1): bin/pi is a POSIX
        // shell wrapper, not a symlink, and node cannot execute it (issue
        // #111). Follow the layout to the real JS entry; anything else
        // keeps the old passthrough so the spawn error stays visible.
        return managedInstallEntry(real) ?? real;
      }
    } catch {
      // fall through
    }

    // 3. Local node_modules copy (dev setup / peer auto-install). The package
    //    exports block subpath resolution, so resolve the entry and derive
    //    dist/cli.js from its directory.
    try {
      const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
      const entry = fileURLToPath(entryUrl);
      return path.join(path.dirname(entry), "cli.js");
    } catch {
      // fall through
    }

    throw new Error(
      "Cannot locate the pi CLI. Install @earendil-works/pi-coding-agent globally (npm i -g @earendil-works/pi-coding-agent) or set PI_CLI_PATH."
    );
  }

  private startPromise: Promise<void> | null = null;
  /** 重启生命周期订阅(spec #72 票6/C5):瞬态状态经此自清,不再外借扳机。 */
  private restartListeners = new Set<(rpc: PiRpc) => void>();

  /** Subscribe to subprocess restarts (fired after the new process is up).
   *  Returns an unsubscribe function. */
  onRestarted(listener: (rpc: PiRpc) => void): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.client) return;
    // Reuse the in-flight start so concurrent callers wait on the same
    // spawn instead of creating a second pi process.
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {

    // 出网代理注入(spec #201 票 #204):spawn 点现算生效三元组 —— 配置
    // 优先(env 优先读 PiRpcOptions.proxyConfig,缺省 loadConfig 兜底),
    // 不依赖入口接线(#203 applyProxySettings)是否先跑过,cli.ts、pmctl
    // 等任何入口直接拉起 PiRpc 都自洽。配置非法(socks5 等)在此抛双语
    // 提示,start() 失败停下,不留给子进程连接超时去猜。
    const proxyEnv = this.proxySpawnEnv();

    // The workdir becomes the pi child process's cwd; spawn requires it to
    // exist, so create it on demand.
    if (this.options.cwd) {
      fs.mkdirSync(this.options.cwd, { recursive: true });
    }

    const cliPath = this.options.cliPath ?? (await PiRpc.resolveCliPath());
    // Fail with a human-readable message instead of pi's SyntaxError from a
    // missing Node 22 builtin (pi 1.0+ hard-requires Node >=22.19). This must
    // run BEFORE the dynamic import below — on Node <22.19 importing the pi
    // 1.0+ package itself kills this process at module-evaluation time, so a
    // static import at the top of this file would crash before any gate.
    assertPiEngineSupported(cliPath);
    const { RpcClient } = await import("@earendil-works/pi-coding-agent");
    const client = new RpcClient({
      cliPath,
      cwd: this.options.cwd,
      args: this.options.args,
      // 无代理时键都不出现:上游 spawn 以 {...process.env, ...options.env}
      // 合成子进程环境,少传 env 即与旧版逐键一致(现状直连)。
      ...(proxyEnv ? { env: proxyEnv } : {}),
    });

    await client.start();

    // Attach any listeners that were registered before the client connected
    for (const listener of this.listeners) {
      if (listener) client.onEvent(listener);
    }

    // Cold start handshake: the process may need a moment before answering.
    // 15 attempts x 2s backoff (up to ~30s): cold starts load models and
    // extensions, which can exceed a short timeout on slow VPSs/debians.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 15; attempt++) {
      try {
        await client.getState();
        this.client = client;
        return;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await client.stop().catch(() => {});
    throw new Error(`pi RPC did not become ready: ${(lastError as Error)?.message}`);
  }

  /**
   * 派生 pi 子进程的代理 env 覆写增量(spec #201 票 #204)。上游 spawn 以
   * `{ ...process.env, ...this.options.env }` 合成子进程环境,本方法只产出
   * 覆写键;决策规则(resolveProxySettings)全项目唯一解释,与桥自身接线
   * (#203 applyProxySettings)同源。因 merge 语义无法删键,「无豁免」用
   * 空串压制:
   *  - 无代理 → undefined:不传 env,子进程环境与旧版逐键一致(现状直连)。
   *  - 配置出场且未填 noProxy → NO_PROXY/no_proxy 置空串:压掉 shell 遗留,
   *    「以配置为准,未填即无豁免」在子进程里同样成立。
   *  - env 兜底且解析不出豁免 → 两键不写:父进程本就无值,不引入意外键。
   */
  private proxySpawnEnv(): Record<string, string> | undefined {
    const settings = resolveProxySettings(this.options.proxyConfig ?? loadConfig(), process.env);
    if (settings.proxy === undefined) return undefined;
    const env: Record<string, string> = {};
    // 键集与拼串与桥侧覆写(applyProxySettings)共享自 proxy.ts;第三态
    // 语义有意不同 —— 见方法注释,不与桥侧的删键分支合并。
    for (const name of PROXY_ENV_NAMES) {
      env[name] = settings.proxy;
    }
    if (settings.noProxy.length > 0) {
      const joined = joinNoProxyList(settings.noProxy);
      for (const name of NO_PROXY_ENV_NAMES) env[name] = joined;
    } else if (settings.source === "config") {
      for (const name of NO_PROXY_ENV_NAMES) env[name] = "";
    }
    return env;
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    await this.client.stop();
    this.client = undefined;
    this.wrappedClient = undefined;
    this.inFlight = 0;
    this.listeners = [];
  }

  /**
   * Restart the pi process. Keeps registered event listeners attached to the
   * new process. The session persists on disk, so the same session is resumed.
   * Useful after installing new extensions/skills or changing provider config.
   * Fires the restart lifecycle AFTER the new process is up.
   */
  async restart(): Promise<void> {
    const keptListeners = this.listeners;
    await this.drainInFlight();
    await this.stop();
    this.listeners = keptListeners;
    await this.start();
    for (const listener of this.restartListeners) {
      try {
        listener(this);
      } catch {
        // 生命周期监听器的失败不影响重启本身
      }
    }
  }

  /**
   * F5 治本:等在途桥→pi 请求收尾再杀进程。登录成功触发的自动重启
   * (/reload 同路)会 SIGTERM pi 子进程,彼时仍在途的请求随进程死亡被
   * 拒收成用户可见的 ❌「Agent process exited (code=143)」(2026-10-12
   * 真机:/login 成功回执前 0.94s 先蹦一条假报错)。排空后再杀;超时兜底
   * 照杀 —— 进程终究要重启,不能让一条僵死请求无限拖延。
   */
  async drainInFlight(timeoutMs = RESTART_DRAIN_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Send a user prompt with Enter semantics (pi TUI parity): a fresh task when
   * idle, injected into the running task when streaming. The upstream `prompt`
   * command natively carries `streamingBehavior` ("steer" | "followUp") and
   * idle sessions ignore it — so one plain send covers both cases, with no
   * error-message sniffing. Sent via the private `send` (any-cast) because
   * RpcClient.prompt() does not expose the parameter.
   */
  async prompt(text: string): Promise<void> {
    await upstreamPromptSend(this.requireClient(), text, "steer");
  }

  /**
   * Queue a message without disturbing the running task (pi TUI Alt+Enter
   * semantics): lands in the followUp queue while streaming; an idle session
   * degenerates to a plain prompt (upstream handles that automatically, so no
   * state check is needed here).
   */
  async promptQueued(text: string): Promise<void> {
    await upstreamPromptSend(this.requireClient(), text, "followUp");
  }

  /** Subscribe to agent events. Safe to call before start(). Returns an
   *  unsubscribe function. */
  onEvent(listener: RpcEventListener): () => void {
    const index = this.listeners.push(listener) - 1;
    let clientUnsub: (() => void) | undefined;
    if (this.client) {
      clientUnsub = this.client.onEvent(listener);
    }
    return () => {
      this.listeners[index] = undefined;
      clientUnsub?.();
    };
  }

  /**
   * Write an extension_ui_response to pi's stdin (issue #54). RpcClient has
   * no public method for it — and its generic send() cannot be used here: it
   * overwrites the command's `id` with its own `req_N` id (the extension
   * request id would be lost, pi would drop the response and the dialog
   * would hang) and then waits 30s for a reply that never comes. So the
   * response goes straight to the child process's stdin as one strict JSONL
   * line (LF framing, same as serializeJsonLine upstream).
   */
  async respondExtensionUI(payload: ExtensionUIResponsePayload): Promise<void> {
    upstreamExtensionUIStdinWrite(this.requireClient(), payload);
  }

  /**
   * 在 pi 的工作目录执行 shell 命令(TUI 的 !/!! 语义)。excludeFromContext
   * (`!!`:结果不写入上下文)是公开 bash() 不带的参数,走 COMPAT 私有 send;
   * 普通执行(! 语义)直用公开方法。
   */
  async bash(command: string, opts?: { excludeFromContext?: boolean }): Promise<BashResultView> {
    return this.bashViaOwnChannel(command, opts?.excludeFromContext ?? false);
  }

  /**
   * bash 自管应答通道(spec #218 票 #220,`!`/`!!`//`/bash` 共用):绕开上游
   * send() 的 30s 写死超时 —— 服务端 bash 分支要 await 命令跑完才回应答,
   * 长命令必被误杀。机制与 upstreamExtensionUIStdinWrite 同款:往子进程
   * stdin 写一条带自定义 id 的 JSONL 命令,在事件流里等按 id 回来的应答
   * (上游 handleLine 对未知 id 的 response 会派发给 eventListeners,上游
   * 自身的 pendingRequests 不含此 id,零冲突)。应答剥离沿上游 getData 语义
   * (success=false 抛 error)。在途计数手动入账(不经 wrapped 客户端),
   * 重启排水不漏账;超时弃权,报 BashTimeoutError(含已等待分钟数)。
   */
  private async bashViaOwnChannel(command: string, excludeFromContext: boolean): Promise<BashResultView> {
    const client = this.requireClient();
    const stdin = upstreamClientStdin(client);
    const id = `bridge_bash_${++bridgeBashSeq}`;
    const timeoutMs = this.options.bashTimeoutMs ?? BASH_TIMEOUT_MS_DEFAULT;
    this.inFlight++;
    let cleanup: () => void = () => {};
    try {
      return await new Promise<BashResultView>((resolve, reject) => {
        const offEvent = this.onEvent((event: unknown) => {
          const data = event as { type?: string; id?: string; success?: boolean; error?: string; data?: unknown };
          if (data.type !== "response" || data.id !== id) return;
          if (data.success) resolve(data.data as BashResultView);
          else reject(new Error(data.error ?? "bash failed"));
        });
        // 重启联动:命令随旧进程死亡,新进程不认识 bridge_bash_N —— 立即
        // 报错让用户重跑,不等满超时(旧 send() 路径进程死即 reject 的语义)。
        const offRestart = this.onRestarted(() => reject(new Error("pi process restarted; the bash command was aborted")));
        const guard = setTimeout(() => reject(new BashTimeoutError(command, timeoutMs)), timeoutMs);
        guard.unref?.();
        cleanup = () => {
          offEvent();
          offRestart();
          clearTimeout(guard);
        };
        try {
          // 先挂 listener 再写:应答是异步的,写入失败(管道坏)时立即 reject。
          stdin.write(`${JSON.stringify({ type: "bash", command, excludeFromContext, id })}\n`);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } finally {
      cleanup();
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  /**
   * 手动压缩(/compact,spec #218 票 #219):两段式的第二段 —— 「压缩中」
   * 回执在 command-map。收尾判据(权威见 COMPAT 兼容层段落的上游行为记录):
   *  - 应答 resolve → ok;应答 reject 且非 Timeout → failed(即时校验错误,
   *    如 Already compacted,不该拖到事件/兜底);应答 30s Timeout reject →
   *    吞掉,慢压缩在服务端继续,由事件收尾。
   *  - compaction_end(reason=manual)→ ok/failed 按事件载荷;aborted(被
   *    后继压缩打断、无后继事件如 extension 取消)→ interrupted,不悬挂。
   *  - onRestarted / 兜底超时 → interrupted。
   * 在途计数:应答腿由 wrapped 客户端自动入账,等待腿(30s Timeout 之后到
   * 收尾之间)手动补账 —— drainInFlight 排到双源全部收尾为止。
   */
  async compact(customInstructions?: string): Promise<CompactOutcome> {
    const client = this.requireClient();
    this.inFlight = Math.max(0, this.inFlight) + 1; // 等待腿
    let settled = false;
    let finish!: (outcome: CompactOutcome) => void;
    const pending = new Promise<CompactOutcome>((resolve) => {
      finish = resolve;
    });
    const offEvent = this.onEvent((event) => {
      if (event.type !== "compaction_end" || event.reason !== "manual") return;
      if (event.aborted) settle({ kind: "interrupted", reason: "aborted" });
      else if (event.errorMessage) settle({ kind: "failed", message: event.errorMessage });
      else settle({ kind: "ok", result: event.result });
    });
    const offRestart = this.onRestarted(() => settle({ kind: "interrupted", reason: "restarted" }));
    const guard = setTimeout(() => settle({ kind: "interrupted", reason: "timeout" }), COMPACT_WAIT_TIMEOUT_MS);
    // timer 只是兜底:事件是主通道,不该拖住桥进程的优雅退出。
    guard.unref?.();
    const settle = (outcome: CompactOutcome): void => {
      if (settled) return;
      settled = true;
      offEvent();
      offRestart();
      clearTimeout(guard);
      this.inFlight = Math.max(0, this.inFlight - 1); // 等待腿出账(应答腿由 wrapped 客户端自出)
      finish(outcome);
    };
    try {
      // 不 await:永不 settle 的应答(慢压缩)不能堵住本方法返回 —— 调用方
      // 必须立即拿到 pending,由事件/重启/兜底源在后台收尾。
      void client.compact(customInstructions).then(
        (result) => settle({ kind: "ok", result }),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // 30s Timeout:不是压缩失败,慢压缩由事件收尾。其余(即时校验错
          // 误如 Already compacted、进程死亡拒收)立即 failed,不等兜底。
          if (!message.includes(UPSTREAM_TIMEOUT_SENTINEL)) settle({ kind: "failed", message });
        }
      );
    } catch {
      // 同步抛出(requireClient 前置失败):同上,不算压缩失败,交兜底源。
    }
    return pending;
  }

  /** The live upstream RpcClient (spec #72 票7/C7):命令族直用上游类型,
   *  包装不再转发。未连接时抛出 —— 调用方无需判空。 */
  requireClient(): RpcClient {
    if (!this.client) throw new Error("pi RPC not connected");
    // 包装客户端对每个 Promise 型调用做在途计数(F5 治本的排水依据);
    // 按底层实例缓存,stop/start 换进程后自动重建。
    if (!this.wrappedClient) {
      this.wrappedClient = this.wrapClient(this.client);
    }
    return this.wrappedClient;
  }

  /** 计数包装:所有经 requireClient() 的 Promise 型调用入账,settled 出账。
   *  同步方法(onEvent 等)原样透传;拒绝照常传播,不吞不改。 */
  private wrapClient(client: RpcClient): RpcClient {
    return new Proxy(client, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (result instanceof Promise) {
            this.inFlight++;
            return result.finally(() => {
              this.inFlight = Math.max(0, this.inFlight - 1);
            });
          }
          return result;
        };
      },
    });
  }
}

// ── 上游兼容层(spec #72 票7/C7)──────────────────────────────────────
// 对 pi 上游私有行为的依赖(私有 send 应答通道、扩展应答 stdin 直写)集中在
// 这几个命名函数里;上游重构时只查这里。
// 另有三处上游行为依赖不在本段函数而在类方法体内,同样属本层管辖:
//  - compact()(票 #219):依赖 send() 的 30s 写死超时与迟到应答静默丢弃
//    (故须双源收尾)、compaction_end 事件载荷形状(UPSTREAM_TIMEOUT_SENTINEL
//    借此区分超时与即时错误)。
//  - bashViaOwnChannel()(票 #220):bash 的 stdin 直写 + 自定义 id 自管
//    应答通道,上游兼容行为集中在方法体与 upstreamClientStdin。
//  - respondExtensionUI():依赖子进程 stdin 直写通道(见其 JSDoc)。

/**
 * COMPAT(上游 prompt 语义):公开 RpcClient.prompt() 不暴露 streamingBehavior,
 * 走私有 send() 发送。上游契约:私有 send 会用自己的 req_N 覆盖命令 id 并等待
 * 应答 —— 换成公开方法前必须核对上游 rpc-client 的行为。
 */
export async function upstreamPromptSend(
  client: RpcClient,
  message: string,
  streamingBehavior: "steer" | "followUp"
): Promise<void> {
  const send = client as unknown as {
    send: (command: {
      type: "prompt";
      message: string;
      streamingBehavior: "steer" | "followUp";
    }) => Promise<{ success: boolean; error?: string }>;
  };
  const response = await send.send({ type: "prompt", message, streamingBehavior });
  if (!response.success) {
    throw new Error(response.error ?? "prompt failed");
  }
}

/**
 * COMPAT(上游扩展应答通道):RpcClient 没有公开的 extension_ui_response 方法,
 * 且其通用 send() 会覆盖命令 id(上游用 req_N)——必须把应答作为一条严格
 * JSONL 行(LF 帧,与上游 serializeJsonLine 一致)直写子进程 stdin。
 */
export function upstreamExtensionUIStdinWrite(
  client: RpcClient,
  payload: ExtensionUIResponsePayload
): void {
  upstreamClientStdin(client).write(`${JSON.stringify({ type: "extension_ui_response", ...payload })}\n`);
}

/**
 * COMPAT(上游 bash 语义,票 #220 重构):bash 已迁入 PiRpc 自管应答通道
 * (bashViaOwnChannel)—— 公开 bash() 不带 excludeFromContext(TUI `!!` 的
 * 「执行但不写入上下文」),且 send() 的 30s 写死超时会误杀长命令,故
 * `!`/`!!` 两路径合一为 stdin 直写 + 自定义 id。上游兼容行为(stdin 通道、
 * 线路字段、应答剥离)集中在 bashViaOwnChannel 方法体与 upstreamClientStdin,
 * 上游重构同查这里。bridgeBashSeq 是该通道的请求序号(进程内单调)。
 */
let bridgeBashSeq = 0;

/** bash 执行等待超时(票 #220):到点弃权,报已等待时长供展示层出人话。 */
export class BashTimeoutError extends Error {
  constructor(
    /** 被放弃的命令 */
    readonly command: string,
    /** 已等待的时长(ms) */
    readonly waitedMs: number
  ) {
    super(`bash timed out after ${Math.round(waitedMs / 60_000)} min: ${command}`);
    this.name = "BashTimeoutError";
  }
}

/**
 * COMPAT(上游子进程通道):extension 应答(issue #54)与 bash 自管通道
 * (票 #220)共用的 stdin 直写入口。上游契约:严格 JSONL 单行(LF 帧,
 * 与上游 serializeJsonLine 一致);子进程引用挂在 client.process。
 */
export function upstreamClientStdin(client: RpcClient): { write: (chunk: string) => unknown } {
  const proc = (client as unknown as {
    process?: { stdin?: { write: (chunk: string) => unknown; destroyed: boolean; writable: boolean } | null };
  }).process;
  const stdin = proc?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    throw new Error("pi RPC stdin is not writable");
  }
  return stdin;
}

/**
 * COMPAT(上游清队,issue #112):clear_queue 自 v0.84.4(2026-08-28)才有,
 * 运行时对端的 pi 子进程可能更旧 —— 不走公开 clearQueue()(它按当前打包的
 * 上游库生成,语义等价,但依赖面应与 prompt/bash 一致集中在此),沿用私有
 * send() 发送。应答 data 为被移除的 steering + followUp 文本;对端过旧时
 * success=false(error = "Unknown command: clear_queue"),由调用方降级。
 */
export interface UpstreamQueues {
  steering: string[];
  followUp: string[];
}

export async function upstreamClearQueueSend(client: RpcClient): Promise<UpstreamQueues> {
  const send = client as unknown as {
    send: (cmd: { type: "clear_queue" }) => Promise<{
      success: boolean;
      error?: string;
      data?: UpstreamQueues;
    }>;
  };
  const response = await send.send({ type: "clear_queue" });
  if (!response.success) {
    throw new Error(response.error ?? "clear_queue failed");
  }
  return response.data ?? { steering: [], followUp: [] };
}
