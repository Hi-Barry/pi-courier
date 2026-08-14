/**
 * ProjectManager — multi-project isolation.
 *
 * Each mapped Matrix room gets its own pi child process (own cwd, own
 * session, own bash environment). Rooms are lazily started on first
 * message; the default PiRpc (DM / default workdir) is shared.
 *
 * Agent events are bound to the room that owns the process, so replies
 * always go back to the right chat even with concurrent turns.
 */
import type { RpcEventListener } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { loadConfig, saveConfig } from "../config.js";
import { PiRpc, type PiRpcOptions } from "./pi-rpc.js";

export interface ProjectManagerOptions {
  /** Shared default PiRpc (DM / unmapped rooms). */
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

  /** Current projects mapping from config (roomId -> workdir). */
  private projectMap(): Record<string, { workdir: string }> {
    return loadConfig().projects ?? {};
  }

  /**
   * Resolve the PiRpc for a room.
   * - Mapped project room -> project process (lazy start).
   * - Anything else -> default Rpc (DM / management room).
   */
  getRpcForRoom(roomId: string): PiRpc {
    const projects = this.projectMap();
    const entry = projects[roomId];
    if (entry) {
      return this.getProjectRpc(roomId, entry.workdir);
    }
    return this.defaultRpc;
  }

  /** Whether this room is a mapped project room. */
  isProjectRoom(roomId: string): boolean {
    return Boolean(this.projectMap()[roomId]);
  }

  private getProjectRpc(roomId: string, workdir: string): PiRpc {
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
    return rpc;
  }

  /** Register a new project room at runtime (used by /newproject). */
  registerProject(roomId: string, workdir: string): void {
    const cfg = loadConfig();
    const projects = { ...(cfg.projects ?? {}), [roomId]: { workdir } };
    saveConfig({ ...cfg, projects });
  }

  async stopAll(): Promise<void> {
    for (const rpc of this.projectRpcs.values()) {
      await rpc.stop().catch(() => {});
    }
    this.projectRpcs.clear();
  }
}
