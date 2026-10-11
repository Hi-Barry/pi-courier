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
import type { RpcClient, RpcEventListener } from "@earendil-works/pi-coding-agent";
import { type ConfigStore, projectFallbackChain } from "../config.js";
import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";
import { logger } from "../logger.js";
import { projectLabelOf } from "../project-labels.js";
import type { ProjectConfig } from "../types.js";
import { setModelByRef } from "./model-switch.js";
import { PiRpc, type PiRpcOptions } from "./pi-rpc.js";

/** 项目条目(issue #119):形状与校验单一来源于 types.ProjectConfig ——
 *  配置层与本模块永不漂移。 */
export type ProjectEntry = ProjectConfig;

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
  /** 项目房单行提示(issue #119:预设应用/失败回执)。组合根接线到
   *  sendReply;缺省 = 静默(测试与无传输部署)。 */
  notifyRoom?: (roomId: string, text: string) => void;
}

export class ProjectManager {
  private defaultRpc: PiRpc;
  private baseOptions: PiRpcOptions;
  private onRoomEvent: (roomId: string, event: unknown, rpc: PiRpc) => void;
  private multiProject: boolean;
  private store: ConfigStore;
  private newRpc: (options: PiRpcOptions) => PiRpc;
  private notifyRoom: (roomId: string, text: string) => void;
  /** roomId -> PiRpc for project rooms (lazily started). */
  private projectRpcs = new Map<string, PiRpc>();

  constructor(opts: ProjectManagerOptions) {
    this.defaultRpc = opts.defaultRpc;
    this.baseOptions = opts.baseOptions;
    this.onRoomEvent = opts.onRoomEvent;
    this.multiProject = opts.multiProject === true;
    this.store = opts.store;
    this.newRpc = opts.rpcFactory ?? ((options) => new PiRpc(options));
    this.notifyRoom = opts.notifyRoom ?? (() => {});
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

  /** Reverse lookup: the project room that owns this rpc (undefined = shared
   *  default process or not started here). Drives the queue-snapshot sink
   *  (issue #115 stage 2): persistence follows the stable room↔process map,
   *  which single-project mode never populates — the conservative route
   *  falls out of this lookup instead of a separate flag check. */
  roomForRpc(rpc: PiRpc): string | undefined {
    for (const [roomId, projectRpc] of this.projectRpcs) {
      if (projectRpc === rpc) return roomId;
    }
    return undefined;
  }

  /** 停止并给失败留痕:停不下来 = 可能残留孤儿进程(审计稳定性批 票12)。 */
  private async stopWithWarn(rpc: PiRpc): Promise<void> {
    await rpc.stop().catch((err: unknown) => {
      logger.withLabel(rpc.label).warn(`⚠️ 项目 pi 进程停止失败(可能残留子进程): ${errorMessage(err)}`);
    });
  }

  private async getProjectRpc(roomId: string, entry: ProjectEntry): Promise<PiRpc> {
    const existing = this.projectRpcs.get(roomId);
    if (existing) {
      // Wait for (or reuse) the in-flight connection so a fast second message
      // never grabs a process that isn't ready yet. 复用失败照旧往下走(后续
      // 发送会再报错),但连接失败本身必须留痕(审计稳定性批 票13)。
      await existing.start().catch((err: unknown) => {
        logger.withLabel(existing.label).warn(`⚠️ 项目 pi 进程连接失败(沿用现有实例继续): ${errorMessage(err)}`);
      });
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

    // 项目预设(issue #119):/reload、登录重启等 restart() 路径握手完成后
    // 重新应用 —— 预设是"开机默认",重启即回到预设(手动切换只活到重启)。
    rpc.onRestarted?.((restarted) => {
      void this.applyPresets(roomId, restarted);
    });

    this.projectRpcs.set(roomId, rpc);
    // Lazy start: spawn the pi process and wait for the handshake. PiRpc.start
    // is idempotent, so subsequent calls reuse the running process.
    logger.withLabel(label).info(`🚀 项目 pi 进程启动: ${entry.workdir}`);
    await rpc.start();
    await this.applyPresets(roomId, rpc);
    return rpc;
  }

  /** 项目房覆盖的降级链(issue #121,已归一):undefined = 未配置,用全局链。 */
  projectFallbacks(roomId: string): string[] | undefined {
    return projectFallbackChain(this.projectMap()[roomId]);
  }

  /** 应用项目预设(issue #119):进程(懒)启动/重启握手完成后各一次。
   *  失败绝不阻塞进程就绪 —— warn 加房间一行提示,用户 /model 手动兜底;
   *  成功也回执一行,让"重启后预设还在"看得见。条目在应用时现读现用:
   *  重启回调里的 entry 引用可能是旧的,配置以 store 当前值为准。 */
  private async applyPresets(roomId: string, rpc: PiRpc): Promise<void> {
    const entry = this.projectMap()[roomId];
    if (!entry) return;
    const label = projectLabelOf(entry);
    const model = entry.model?.trim();
    const level = entry.thinkingLevel?.trim();
    if (!model && !level) return;
    const applied: string[] = [];
    try {
      if (model) {
        const resolved = await setModelByRef(rpc, model);
        applied.push(`model ${resolved.provider}/${resolved.id}`);
      }
      if (level) {
        await rpc.requireClient().setThinkingLevel(level as Parameters<RpcClient["setThinkingLevel"]>[0]);
        applied.push(`thinking ${level}`);
      }
    } catch (err) {
      logger.withLabel(label).warn(`⚠️ 项目预设应用失败: ${(err as Error).message}`);
      this.notifyRoom(roomId, t("router.preset.failed", { message: (err as Error).message }));
      return;
    }
    logger.withLabel(label).info(`📋 项目预设已应用: ${applied.join(", ")}`);
    this.notifyRoom(roomId, t("router.preset.applied", { items: applied.join(", ") }));
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
      await this.stopWithWarn(old);
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
      await this.stopWithWarn(rpc);
      this.projectRpcs.delete(roomId);
    }
    this.updateProjects((projects) => {
      delete projects[roomId];
    });
  }

  async stopAll(): Promise<void> {
    for (const rpc of this.projectRpcs.values()) {
      await this.stopWithWarn(rpc);
    }
    this.projectRpcs.clear();
  }
}
