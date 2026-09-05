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
  /** Absolute path to pi's dist/cli.js (default: PI_CLI_PATH env, local node_modules, or `which pi` resolved) */
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

  /** Locate the pi CLI entry point. */
  static async resolveCliPath(): Promise<string> {
    // 1. Explicit env override
    if (process.env.PI_CLI_PATH) return process.env.PI_CLI_PATH;

    // 2. System-installed pi (`which pi`, resolve symlink to dist/cli.js).
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
   */
  async restart(): Promise<void> {
    const keptListeners = this.listeners;
    await this.stop();
    this.listeners = keptListeners;
    await this.start();
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
    await this.sendPrompt(text, "steer");
  }

  /**
   * Queue a message without disturbing the running task (pi TUI Alt+Enter
   * semantics): lands in the followUp queue while streaming; an idle session
   * degenerates to a plain prompt (upstream handles that automatically, so no
   * state check is needed here).
   */
  async promptQueued(text: string): Promise<void> {
    await this.sendPrompt(text, "followUp");
  }

  /** Resolve once the agent settles ("agent_settled"). Rejects on timeout (ms). */
  async waitForIdle(timeout?: number): Promise<void> {
    await this.requireClient().waitForIdle(timeout);
  }

  /** Raw `prompt` command with an explicit streaming behavior, via private send. */
  private async sendPrompt(text: string, streamingBehavior: "steer" | "followUp"): Promise<void> {
    const client = this.requireClient() as unknown as {
      send: (command: {
        type: "prompt";
        message: string;
        streamingBehavior: "steer" | "followUp";
      }) => Promise<{ success: boolean; error?: string }>;
    };
    const response = await client.send({ type: "prompt", message: text, streamingBehavior });
    if (!response.success) {
      throw new Error(response.error ?? "prompt failed");
    }
  }

  /** Subscribe to agent events. Safe to call before start(). Returns an unsubscribe function. */
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

  // =========================================================================
  // RPC command conveniences (used by the slash command map)
  // =========================================================================

  async newSession(): Promise<{ cancelled: boolean }> {
    return this.requireClient().newSession();
  }

  async compact(customInstructions?: string): Promise<{ summary: string; tokensBefore: number }> {
    return this.requireClient().compact(customInstructions);
  }

  async abort(): Promise<void> {
    await this.requireClient().abort();
  }

  async getState(): Promise<RpcSessionState> {
    return this.requireClient().getState();
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return this.requireClient().getAvailableModels();
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    return this.requireClient().setModel(provider, modelId);
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.requireClient().setThinkingLevel(level as never);
  }

  async setSessionName(name: string): Promise<void> {
    await this.requireClient().setSessionName(name);
  }

  async getSessionStats(): Promise<{
    sessionId: string;
    totalMessages: number;
    cost: number;
    tokens: { total: number };
  }> {
    return this.requireClient().getSessionStats();
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    return this.requireClient().exportHtml(outputPath);
  }

  async bash(command: string): Promise<{ output: string; exitCode: number | undefined }> {
    return this.requireClient().bash(command);
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return this.requireClient().switchSession(sessionPath);
  }

  /** Get available commands (extension commands, prompt templates, skills) with a short cache. */
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
    const client = this.requireClient() as unknown as {
      process?: {
        stdin?: { write: (chunk: string) => unknown; destroyed: boolean; writable: boolean };
      } | null;
    };
    const stdin = client.process?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("pi RPC stdin is not writable");
    }
    stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...payload })}\n`);
  }

  private requireClient(): RpcClient {
    if (!this.client) throw new Error("pi RPC not connected");
    return this.client;
  }
}
