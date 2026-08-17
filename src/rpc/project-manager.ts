/**
 * ProjectManager — multi-project isolation.
 *
 * Each mapped Matrix room gets its own pi child process (own cwd, own
 * session, own bash environment). Rooms are lazily started on first
 * message; the default PiRpc (management room / default workdir) is shared.
 *
 * Agent events are bound to the room that owns the process, so replies
 * always go back to the right chat even with concurrent turns.
 */
import type { RpcEventListener } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { loadConfig, saveConfig } from "../config.js";
import { PiRpc, type PiRpcOptions } from "./pi-rpc.js";

export interface ProjectEntry {
  name?: string;
  workdir: string;
}

export interface ProjectManagerOptions {
  /** Shared default PiRpc (management room / default workdir). */
  defaultRpc: PiRpc;
  /** Base options for project processes (cliPath, common args, ...). */
  baseOptions: PiRpcOptions;
  /** Subscribe a per-room agent event listener: (roomId, event). */
  onRoomEvent: (roomId: string, event: unknown) => void;
}

export class ProjectManager {
  private defaultRpc: PiRpc;
  private baseOptions: PiRpcOptions;
  private onRoomEvent: (roomId: string, event: unknown) => void;
  /** roomId -> PiRpc for project rooms (lazily started). */
  private projectRpcs = new Map<string, PiRpc>();

  constructor(opts: ProjectManagerOptions) {
    this.defaultRpc = opts.defaultRpc;
    this.baseOptions = opts.baseOptions;
    this.onRoomEvent = opts.onRoomEvent;
  }

  /** Current projects mapping from config (roomId -> entry). */
  projectMap(): Record<string, ProjectEntry> {
    return loadConfig().projects ?? {};
  }

  /** All configured projects as [roomId, entry] pairs. */
  listProjects(): Array<[string, ProjectEntry]> {
    return Object.entries(this.projectMap());
  }

  /**
   * Resolve the PiRpc for a room (starting it on first use).
   * - Mapped project room -> project process (lazy start).
   * - Anything else -> default Rpc (management room).
   */
  async getRpcForRoom(roomId: string): Promise<PiRpc> {
    const entry = this.projectMap()[roomId];
    if (entry) {
      return this.getProjectRpc(roomId, entry.workdir);
    }
    return this.defaultRpc;
  }

  /** Whether this room is a mapped project room. */
  isProjectRoom(roomId: string): boolean {
    return Boolean(this.projectMap()[roomId]);
  }

  /** Whether a project process is currently running for this room. */
  isRunning(roomId: string): boolean {
    return this.projectRpcs.has(roomId);
  }

  private async getProjectRpc(roomId: string, workdir: string): Promise<PiRpc> {
    const existing = this.projectRpcs.get(roomId);
    if (existing) return existing;

    // Per-project session dir: each project's conversation state lives in
    // its own workdir/.pi-session — isolated and resumable (--continue).
    const args = [...(this.baseOptions.args ?? [])];
    const projectSessionDir = path.join(workdir, ".pi-session");
    args.push("--session-dir", projectSessionDir);

    const rpc = new PiRpc({
      ...this.baseOptions,
      cwd: workdir,
      args,
    });

    const listener: RpcEventListener = (event) => {
      this.onRoomEvent(roomId, event);
    };
    rpc.onEvent(listener);

    this.projectRpcs.set(roomId, rpc);
    // Lazy start: spawn the pi process and wait for the handshake. PiRpc.start
    // is idempotent, so subsequent calls reuse the running process.
    await rpc.start();
    return rpc;
  }

  /** Register a new project room at runtime (used by /pmctl new). */
  registerProject(roomId: string, workdir: string, name?: string): void {
    const cfg = loadConfig();
    const projects = {
      ...(cfg.projects ?? {}),
      [roomId]: { name: name ?? roomId, workdir },
    };
    saveConfig({ ...cfg, projects });
  }

  /** Update a project's workdir (used by /pmctl mv). */
  updateProjectWorkdir(roomId: string, workdir: string): void {
    const cfg = loadConfig();
    const projects = { ...(cfg.projects ?? {}) };
    const entry = projects[roomId];
    if (!entry) return;
    projects[roomId] = { ...entry, workdir };
    saveConfig({ ...cfg, projects });
    // Drop the running process so the next message starts fresh in the new dir.
    this.projectRpcs.delete(roomId);
  }

  /** Rename a project (used by /pmctl rename). */
  renameProject(roomId: string, name: string): void {
    const cfg = loadConfig();
    const projects = { ...(cfg.projects ?? {}) };
    const entry = projects[roomId];
    if (!entry) return;
    projects[roomId] = { ...entry, name };
    saveConfig({ ...cfg, projects });
  }

  /** Remove a project (used by /pmctl rm): stop its process, drop the mapping. */
  async removeProject(roomId: string): Promise<void> {
    const rpc = this.projectRpcs.get(roomId);
    if (rpc) {
      await rpc.stop().catch(() => {});
      this.projectRpcs.delete(roomId);
    }
    const cfg = loadConfig();
    const projects = { ...(cfg.projects ?? {}) };
    delete projects[roomId];
    saveConfig({ ...cfg, projects });
  }

  async stopAll(): Promise<void> {
    for (const rpc of this.projectRpcs.values()) {
      await rpc.stop().catch(() => {});
    }
    this.projectRpcs.clear();
  }
}
