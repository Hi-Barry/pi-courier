/**
 * PiRpc — thin wrapper around the official RpcClient from @earendil-works/pi-coding-agent.
 *
 * Responsibilities:
 *  - Locate the pi CLI (config/env/PATH) and spawn it in --mode rpc
 *  - Retry startup handshake (cold start can take a moment)
 *  - Provide typed convenience methods used by the command map
 *  - Cache get_commands results briefly
 *  - Fall back to steer() when a prompt arrives while the agent is streaming
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
}

/** Minimal shape of a slash command returned by get_commands (duck-typed, not exported by the package) */
export interface RpcSlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: string;
  path?: string;
}

export class PiRpc {
  private client?: RpcClient;
  private commandsCache?: { at: number; list: RpcSlashCommandInfo[] };
  private options: PiRpcOptions;
  /** Listeners registered before start() — attached once the client connects */
  private listeners: Array<RpcEventListener | undefined> = [];

  constructor(options: PiRpcOptions = {}) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.client !== undefined;
  }

  /** Locate the pi CLI entry point. */
  static async resolveCliPath(): Promise<string> {
    // 1. Explicit env override
    if (process.env.PI_CLI_PATH) return process.env.PI_CLI_PATH;

    // 2. Bundled pi from local node_modules (same version as the RpcClient).
    //    The package exports block subpath resolution, so resolve the entry
    //    and derive dist/cli.js from its directory.
    try {
      const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
      const entry = fileURLToPath(entryUrl);
      return path.join(path.dirname(entry), "cli.js");
    } catch {
      // fall through
    }

    // 3. `which pi` — resolve symlink to the real dist/cli.js
    try {
      const bin = execFileSync("which", ["pi"], { encoding: "utf-8" }).trim();
      if (bin) {
        return fs.realpathSync(bin);
      }
    } catch {
      // fall through
    }

    throw new Error(
      "Cannot locate the pi CLI. Install @earendil-works/pi-coding-agent or set PI_CLI_PATH."
    );
  }

  async start(): Promise<void> {
    if (this.client) return;

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
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await client.getState();
        this.client = client;
        return;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 1000));
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
   * Send a user prompt. If the agent is streaming, the RPC server rejects a
   * plain prompt — retry as a steering message (queued, delivered after the
   * current tool calls finish).
   */
  async prompt(text: string): Promise<void> {
    if (!this.client) throw new Error("pi RPC not connected");
    try {
      await this.client.prompt(text);
    } catch (err) {
      if (/streaming/i.test((err as Error).message)) {
        await this.client.steer(text);
      } else {
        throw err;
      }
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

  private requireClient(): RpcClient {
    if (!this.client) throw new Error("pi RPC not connected");
    return this.client;
  }
}
