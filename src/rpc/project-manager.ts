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

import * as path from "node:path";
import type { RpcEventListener } from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "../config.js";
import { logger } from "../logger.js";
import { projectLabelOf } from "../project-labels.js";
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
  /** Subscribe a per-room agent event listener: (roomId, event, rpc). */
  onRoomEvent: (roomId: string, event: unknown, rpc: PiRpc) => void;
  /** Multi-project mode. false = single-project: every room uses defaultRpc. */
  multiProject?: boolean;
  /** Injected config store (single read/write path for the projects map). */
  store: ConfigStore;
  /** PiRpc constructor seam (tests inject fakes; production uses `new PiRpc`). */
  rpcFactory?: (options: PiRpcOptions) => PiRpc;
}

export class ProjectManager {
  private defaultRpc: PiRpc;
  private baseOptions: PiRpcOptions;
  private onRoomEvent: (roomId: string, event: unknown, rpc: PiRpc) => void;
  private multiProject: boolean;
  private store: ConfigStore;
  private newRpc: (options: PiRpcOptions) => PiRpc;
  /** roomId -> PiRpc for project rooms (lazily started). */
  private projectRpcs = new Map<string, PiRpc>();

  constructor(opts: ProjectManagerOptions) {
    this.defaultRpc = opts.defaultRpc;
    this.baseOptions = opts.baseOptions;
    this.onRoomEvent = opts.onRoomEvent;
    this.multiProject = opts.multiProject === true;
    this.store = opts.store;
    this.newRpc = opts.rpcFactory ?? ((options) => new PiRpc(options));
  }

  /** Current projects mapping (roomId -> entry) — in-memory, no disk read. */
  projectMap(): Record<string, ProjectEntry> {
    return this.store.get().projects ?? {};
  }

  /** All configured projects as [roomId, entry] pairs. */
  listProjects(): Array<[string, ProjectEntry]> {
    return Object.entries(this.projectMap());
  }

  /**
   * Resolve the PiRpc for a room (starting it on first use).
   * - Single-project mode: every room uses the shared default Rpc.
   * - Multi-project: mapped project room -> project process; else default.
   */
  async getRpcForRoom(roomId: string): Promise<PiRpc> {
    if (!this.multiProject) return this.defaultRpc;
    const entry = this.projectMap()[roomId];
    if (entry) {
      return this.getProjectRpc(roomId, entry);
    }
    return this.defaultRpc;
  }

  /** The log label for a room's project (name ?? workdir basename), or
   *  undefined when the room is not a mapped project / single-project mode.
   *  The same projectLabelOf rule the CLI filter matches against (spec #34). */
  labelForRoom(roomId: string): string | undefined {
    if (!this.multiProject) return undefined;
    const entry = this.projectMap()[roomId];
    return entry ? projectLabelOf(entry) : undefined;
  }

  /** Whether this room is a mapped project room (only meaningful in multi-project). */
  isProjectRoom(roomId: string): boolean {
    if (!this.multiProject) return false;
    return Boolean(this.projectMap()[roomId]);
  }

  /** Whether multi-project mode is enabled. */
  get isMultiProject(): boolean {
    return this.multiProject;
  }

  /** Whether a project process is currently running for this room. */
  isRunning(roomId: string): boolean {
    return this.projectRpcs.has(roomId);
  }

  /** Every rpc of this instance: the shared default first, then all started
   *  project rpcs (issue #55: login success + /reload all restart the idle
   *  ones so pi subprocesses re-read the credential file). Not-yet-started
   *  projects are absent by design — their first start reads the fresh file. */
  allRpcs(): PiRpc[] {
    return [this.defaultRpc, ...this.projectRpcs.values()];
  }

  private async getProjectRpc(roomId: string, entry: ProjectEntry): Promise<PiRpc> {
    const existing = this.projectRpcs.get(roomId);
    if (existing) {
      // Wait for (or reuse) the in-flight connection so a fast second message
      // never grabs a process that isn't ready yet.
      await existing.start().catch(() => {});
      return existing;
    }

    // Per-project session dir: each project's conversation state lives in
    // its own workdir/.pi-session — isolated and resumable (--continue).
    const args = [...(this.baseOptions.args ?? [])];
    const projectSessionDir = path.join(entry.workdir, ".pi-session");
    args.push("--session-dir", projectSessionDir);

    const label = projectLabelOf(entry);
    const rpc = this.newRpc({
      ...this.baseOptions,
      cwd: entry.workdir,
      args,
      label,
    });

    const listener: RpcEventListener = (event) => {
      this.onRoomEvent(roomId, event, rpc);
    };
    rpc.onEvent(listener);

    this.projectRpcs.set(roomId, rpc);
    // Lazy start: spawn the pi process and wait for the handshake. PiRpc.start
    // is idempotent, so subsequent calls reuse the running process.
    logger.withLabel(label).info(`🚀 项目 pi 进程启动: ${entry.workdir}`);
    await rpc.start();
    return rpc;
  }

  /** Single write path for the projects map: copy, mutate, persist. */
  private updateProjects(mutate: (projects: Record<string, ProjectEntry>) => void): void {
    const projects = { ...(this.store.get().projects ?? {}) };
    mutate(projects);
    this.store.update({ projects });
  }

  /** Register a new project room at runtime (used by /pmctl new). */
  registerProject(roomId: string, workdir: string, name?: string): void {
    this.updateProjects((projects) => {
      projects[roomId] = { name: name ?? roomId, workdir };
    });
  }

  /** Update a project's workdir (used by /pmctl mv). */
  async updateProjectWorkdir(roomId: string, workdir: string): Promise<void> {
    const entry = this.projectMap()[roomId];
    if (!entry) return;
    this.updateProjects((projects) => {
      projects[roomId] = { ...entry, workdir };
    });
    // Stop and drop the running process so the next message starts fresh in
    // the new dir (prevents an orphaned pi process from a stale cwd). The
    // stop is logged under the project's CURRENT label (the new one is only
    // taken up by the next spawn).
    const old = this.projectRpcs.get(roomId);
    if (old) {
      logger.withLabel(old.label).info(`🛑 项目 pi 进程停止(/pmctl mv 换目录,下次消息在新目录启动)`);
      await old.stop().catch(() => {});
      this.projectRpcs.delete(roomId);
    }
  }

  /** Rename a project (used by /pmctl rename). */
  renameProject(roomId: string, name: string): void {
    const entry = this.projectMap()[roomId];
    if (!entry) return;
    this.updateProjects((projects) => {
      projects[roomId] = { ...entry, name };
    });
    // Re-label the running process so its log lines carry the new name from
    // here on (spec #34: 改名只影响之后的新日志) — via the SAME resolution
    // rule every other consumer uses, never the raw string.
    const rpc = this.projectRpcs.get(roomId);
    if (rpc) rpc.label = projectLabelOf({ name, workdir: entry.workdir });
  }

  /** Remove a project (used by /pmctl rm): stop its process, drop the mapping. */
  async removeProject(roomId: string): Promise<void> {
    const rpc = this.projectRpcs.get(roomId);
    if (rpc) {
      logger.withLabel(rpc.label).info(`🛑 项目 pi 进程停止(/pmctl rm)`);
      await rpc.stop().catch(() => {});
      this.projectRpcs.delete(roomId);
    }
    this.updateProjects((projects) => {
      delete projects[roomId];
    });
  }

  async stopAll(): Promise<void> {
    for (const rpc of this.projectRpcs.values()) {
      await rpc.stop().catch(() => {});
    }
    this.projectRpcs.clear();
  }
}
