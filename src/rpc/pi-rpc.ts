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
import type { RpcClient, RpcEventListener } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
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
    const client = this.requireClient();
    if (opts?.excludeFromContext) {
      return upstreamBashSend(client, command, true);
    }
    return (await client.bash(command)) as BashResultView;
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
  const process = (client as unknown as {
    process?: { stdin?: { write: (chunk: string) => unknown; destroyed: boolean; writable: boolean } | null };
  }).process;
  const stdin = process?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    throw new Error("pi RPC stdin is not writable");
  }
  stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...payload })}\n`);
}

/**
 * COMPAT(上游 bash 语义):公开 bash() 不带 excludeFromContext(TUI `!!` 的
 * "执行但不写入上下文"),而 RPC 服务端的 bash 分支原生读取该线路字段 ——
 * 走私有 send() 附带即可。应答剥离按上游 getData 的行为内联:success=false
 * 抛 error,否则返回 data。与 upstreamPromptSend 同一上游依赖面,重构同查。
 */
export async function upstreamBashSend(
  client: RpcClient,
  command: string,
  excludeFromContext: boolean
): Promise<BashResultView> {
  const send = client as unknown as {
    send: (cmd: {
      type: "bash";
      command: string;
      excludeFromContext: boolean;
    }) => Promise<{ success: boolean; error?: string; data?: BashResultView }>;
  };
  const response = await send.send({ type: "bash", command, excludeFromContext });
  if (!response.success) {
    throw new Error(response.error ?? "bash failed");
  }
  return response.data as BashResultView;
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
