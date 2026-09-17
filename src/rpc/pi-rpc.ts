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
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ModelInfo,
  RpcClient,
  type RpcEventListener,
  type RpcSessionState,
} from "@earendil-works/pi-coding-agent";

export interface PiRpcOptions {
  /** Absolute path to pi's dist/cli.js (default: config.cliPath ← PI_CLI_PATH env, then local node_modules, then `which pi`) */
  cliPath?: string;
  /** Working directory for the agent (affects bash tool, project context) */
  cwd?: string;
  /** Extra CLI args, e.g. ["--session-dir", "/path"] */
  args?: string[];
  /** Project label for tagged log lines (multi-project mode; spec #34). */
  label?: string;
}

/** Minimal shape of a slash command returned by get_commands (duck-typed, not exported by the package) */
export interface RpcSlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: string;
  path?: string;
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

export class PiRpc {
  private client?: RpcClient;
  private commandsCache?: { at: number; list: RpcSlashCommandInfo[] };
  private options: PiRpcOptions;
  /** Listeners registered before start() — attached once the client connects */
  private listeners: Array<RpcEventListener | undefined> = [];

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

  /** Locate the pi CLI entry point. Env override (PI_CLI_PATH) is folded
   *  into config.cliPath by loadConfig (spec #72 票4/C4) — this chain only
   *  resolves between the configured path and the two install locations. */
  static async resolveCliPath(): Promise<string> {
    // 1. System-installed pi (`which pi`, resolve symlink to dist/cli.js).
    //    Preferred: pi is installed independently and upgraded on its own.
    try {
      const bin = execFileSync("which", ["pi"], { encoding: "utf-8" }).trim();
      if (bin) {
        return fs.realpathSync(bin);
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

    // The workdir becomes the pi child process's cwd; spawn requires it to
    // exist, so create it on demand.
    if (this.options.cwd) {
      fs.mkdirSync(this.options.cwd, { recursive: true });
    }

    const cliPath = this.options.cliPath ?? (await PiRpc.resolveCliPath());
    const client = new RpcClient({
      cliPath,
      cwd: this.options.cwd,
      args: this.options.args,
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

  async stop(): Promise<void> {
    if (!this.client) return;
    await this.client.stop();
    this.client = undefined;
    this.commandsCache = undefined;
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

  /** Get available commands (extension commands, prompt templates, skills) with a short cache. */
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

  async getCommands(): Promise<RpcSlashCommandInfo[]> {
    if (this.commandsCache && Date.now() - this.commandsCache.at < 60_000) {
      return this.commandsCache.list;
    }
    const list = (await this.requireClient().getCommands()) as unknown as {
      commands: RpcSlashCommandInfo[];
    };
    const commands = list.commands ?? [];
    this.commandsCache = { at: Date.now(), list: commands };
    return commands;
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
    return this.client;
  }
}

// ── 上游兼容层(spec #72 票7/C7)──────────────────────────────────────
// 对 pi 上游私有行为的两处依赖集中在这两个命名函数里;上游重构时只查这里。

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
