/**
 * PmctlController — multi-project management (the /pmctl command family).
 *
 * Gate decisions (multi-project switch, management-room check, Matrix-only
 * capability) and execution actions live in THIS module, injected with the
 * project manager, room ops and config store. The slash-command map stays a
 * pure pi-command mapping.
 *
 * The invite target arrives already resolved (transport-native MXID — the
 * bridge's runtime path never carries a transport prefix; the only prefix
 * strip in the codebase lives in the setup wizard, at the config-storage
 * boundary).
 */

import * as os from "node:os";
import * as path from "node:path";
import { activeSpaceRoomId, type ConfigStore } from "../config.js";
import { projectLabelOf, validateProjectLabel } from "../project-labels.js";
import { elevateTrustedUsersInRoom } from "../space.js";
import type { RoomOps } from "../transports/interface.js";
import type { ProjectEntry, ProjectManager } from "./project-manager.js";

export interface PmctlCall {
  /** Room the command came from (also the pending-rm confirmation key). */
  chatId: string;
  /** Resolved invite target for /pmctl new (transport-native MXID). */
  senderMxid: string;
  /** Whether this room is the management room. */
  isManagementRoom: boolean;
}

export interface PmctlControllerOptions {
  projectManager: ProjectManager;
  /** Matrix room capability — absent outside Matrix deployments. */
  roomOps?: RoomOps;
  store: ConfigStore;
}

/** Pending /pmctl rm confirmation, keyed by the chat that issued it. A first
 *  `/pmctl rm <target>` only arms the delete; the same command re-sent within
 *  the 60-second window confirms it. */
type Reply = (text: string) => Promise<void>;

interface PendingRm {
  roomId: string;
  ts: number;
}

/** Split the leading word off an argument string ("op rest"). */
function splitFirst(s: string): [string, string] {
  const sp = s.indexOf(" ");
  return sp === -1 ? [s.trim(), ""] : [s.slice(0, sp).trim(), s.slice(sp + 1).trim()];
}

const RM_CONFIRM_WINDOW_MS = 60_000;

export class PmctlController {
  private pendingRm = new Map<string, PendingRm>();

  constructor(private opts: PmctlControllerOptions) {}

  /** Handle a /pmctl-family command. Returns false when `text` is not one —
   *  the caller then falls through to the regular command map. Rejected
   *  commands ARE handled (replied) and return true. */
  async handle(
    text: string,
    call: PmctlCall,
    reply: (text: string) => Promise<void>
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!/^\/(pmctl|newproject|projects)(\s|$)/.test(trimmed)) return false;

    const projectManager = this.opts.projectManager;

    // In single-project mode /pmctl is not available.
    if (projectManager.isMultiProject === false) {
      await reply("❌ 当前为单工程模式,未启用项目管理。\n如需多工程:发 `/multiproject on` 并重启(pi-courier restart)。");
      return true;
    }
    // Management commands are only available in the management room
    // (the first paired DM). Project rooms are for conversation only.
    if (!call.isManagementRoom) {
      await reply("❌ /pmctl 仅可在管理房间(与 bot 的私聊)使用");
      return true;
    }
    const { roomOps } = this.opts;
    if (!roomOps) {
      await reply("❌ /pmctl 不可用(仅 Matrix 部署支持)");
      return true;
    }

    const spaceIndex = trimmed.indexOf(" ");
    const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

    let op: string;
    let rest: string;
    if (trimmed.startsWith("/newproject")) {
      op = "new";
      rest = args;
    } else if (trimmed.startsWith("/projects")) {
      op = "list";
      rest = args;
    } else {
      [op, rest] = splitFirst(args);
      if (!op) op = "list";
    }

    switch (op) {
      case "new":
        await this.newProject(rest, call, reply, roomOps);
        return true;
      case "list":
        await reply(this.listText());
        return true;
      case "show":
        await this.show(rest, reply);
        return true;
      case "rm":
        await this.rm(rest, call, reply, roomOps);
        return true;
      case "mv":
        await this.mv(rest, reply);
        return true;
      case "rename":
        await this.rename(rest, reply, roomOps);
        return true;
      default:
        await reply(`❌ 未知操作: ${op}\n可用操作: new / list / show / rm / mv / rename`);
        return true;
    }
  }

  /** Resolve a project path: absolute as-is; relative against the project
   *  root (config.workdir) — `/pmctl new myapp myapp` lands in ~/Projects/myapp. */
  private resolveProjectPath(p: string): string {
    if (p.startsWith("/")) return p;
    const root = this.opts.store.get().workdir ?? path.join(os.homedir(), "Projects");
    return path.join(root, p);
  }

  private instanceName(): string {
    return this.opts.store.get().instanceName ?? os.hostname();
  }

  /** The organizational space this deployment files rooms under (shared
   *  predicate — undefined when the feature is off or the space not created). */
  private activeSpaceRoomId(): string | undefined {
    return activeSpaceRoomId(this.opts.store.get());
  }

  private async newProject(
    rest: string,
    call: PmctlCall,
    reply: Reply,
    roomOps: RoomOps
  ): Promise<void> {
    const pm = this.opts.projectManager;
    const [pname, workdirArg] = splitFirst(rest);
    if (!pname) {
      await reply(
        "用法: /pmctl new <项目名> [路径]\n" +
          "路径可选:缺省为工程根下同名目录(如 newapp → ~/Projects/newapp);" +
          "也可用相对路径或绝对路径。"
      );
      return;
    }
    // Path is optional: default to <project root>/<name>.
    const resolvedWorkdir = workdirArg ? this.resolveProjectPath(workdirArg) : this.resolveProjectPath(pname);
    // The project name becomes the log label (spec #34): validate before any
    // side effects — a rejected name must not create a room or register.
    const labelError = validateProjectLabel(pname, this.currentLabels());
    if (labelError) {
      await reply(`❌ ${labelError}`);
      return;
    }
    if (!call.senderMxid) {
      await reply("❌ 缺少邀请对象(未配置信任用户)");
      return;
    }
    try {
      const roomId = await roomOps.createProjectRoom(`${pname}(${this.instanceName()})`, call.senderMxid);
      pm.registerProject(roomId, resolvedWorkdir, pname);
      // #42: every trusted user gets admin in the new room via the unified
      // elevation — not just the sender. Failure must not fail the (already
      // created) project.
      try {
        await elevateTrustedUsersInRoom(roomOps, this.opts.store, roomId);
      } catch (err) {
        await reply(`⚠️ 房间已创建,但信任用户补权失败(可手动设置): ${(err as Error).message}`);
      }
      // File the new room under the organizational space (display layer
      // only — a link failure never fails the project).
      let spaceNote = "";
      const spaceRoomId = this.activeSpaceRoomId();
      if (spaceRoomId) {
        try {
          await roomOps.addRoomToSpace(spaceRoomId, roomId);
        } catch (err) {
          spaceNote = `\n⚠️ 挂入空间失败(不影响项目): ${(err as Error).message}`;
        }
      }
      await reply(
        `✅ 项目「${pname}」创建完成!\n\n` +
          `• 房间: ${roomId}\n` +
          `• 工作目录: ${resolvedWorkdir}\n` +
          `• 已邀请你进入新房间\n\n` +
          `项目对话请到新房间进行(独立上下文与工作目录)。${spaceNote}`
      );
    } catch (err) {
      await reply(`❌ 创建项目失败: ${(err as Error).message}`);
    }
  }

  /** All current project labels (name ?? workdir basename) — the collision
   *  set for label validation. */
  private currentLabels(): string[] {
    return this.opts.projectManager.listProjects().map(([, p]) => projectLabelOf(p));
  }

  private listText(): string {
    const pm = this.opts.projectManager;
    const projects = pm.listProjects();
    if (projects.length === 0) {
      return "暂无项目(用 /pmctl new <名称> <路径> 创建)";
    }
    const lines = projects.map(([roomId, p]) => {
      const status = pm.isRunning(roomId) ? "✅ 运行中" : "⏸️ 未启动";
      return `• ${projectLabelOf(p)} — ${status}\n  ${p.workdir} (${roomId})`;
    });
    return `**项目列表** (${projects.length}):\n${lines.join("\n")}`;
  }

  /** Resolve a user-supplied target ("name" or room ID) to a project,
   *  matching against the same labels the log filter uses (projectLabelOf). */
  private findProject(target: string): [string, ProjectEntry] | undefined {
    return this.opts.projectManager.listProjects().find(([roomId, p]) => projectLabelOf(p) === target || roomId === target);
  }

  private async show(rest: string, reply: Reply): Promise<void> {
    const target = rest.trim();
    if (!target) {
      await reply("用法: /pmctl show <项目名|房间ID>");
      return;
    }
    const found = this.findProject(target);
    if (!found) {
      await reply(`❌ 未找到项目: ${target}(用 /pmctl list 查看)`);
      return;
    }
    const [roomId, entry] = found;
    const pm = this.opts.projectManager;
    await reply(
      `📁 项目: ${projectLabelOf(entry)}\n` +
        `• 房间: ${roomId}\n` +
        `• 工作目录: ${entry.workdir}\n` +
        `• 状态: ${pm.isRunning(roomId) ? "✅ 运行中" : "⏸️ 未启动(lazy)"}\n` +
        `• 会话: ${entry.workdir}/.pi-session`
    );
  }

  private async rm(rest: string, call: PmctlCall, reply: Reply, roomOps: RoomOps): Promise<void> {
    const pm = this.opts.projectManager;
    const target = rest.trim();
    if (!target) {
      await reply("用法: /pmctl rm <项目名|房间ID>");
      return;
    }
    // cancel: clear the armed confirmation
    if (target === "cancel" || target === "no" || target === "取消") {
      const had = this.pendingRm.delete(call.chatId);
      await reply(had ? "✅ 已取消删除" : "当前没有待确认的删除操作");
      return;
    }
    const found = this.findProject(target);
    if (!found) {
      this.pendingRm.delete(call.chatId);
      await reply(`❌ 未找到项目: ${target}(用 /pmctl list 查看)`);
      return;
    }
    const [roomId, entry] = found;
    const pending = this.pendingRm.get(call.chatId);
    if (pending && Date.now() - pending.ts > RM_CONFIRM_WINDOW_MS) {
      this.pendingRm.delete(call.chatId); // expired — treat as a fresh rm
      await reply(`⏳ 上次确认已超时(60 秒),需重新确认。`);
    }
    // Only the exact room armed for THIS chat confirms — a stale or
    // different-room pending entry can never delete the wrong project.
    if (this.pendingRm.get(call.chatId)?.roomId === roomId) {
      this.pendingRm.delete(call.chatId);
      await pm.removeProject(roomId);
      await reply(
        `🗑️ 项目「${projectLabelOf(entry)}」已删除\n` +
          `• 已解除映射并停止进程\n` +
          `• 工作目录保留: ${entry.workdir}(如需删除请自行处理)\n` +
          `• 正在主动退出房间…`
      );
      // Unfile from the space first — once the bot leaves, it can no longer
      // clear the space-side child state (ghost entry). Best-effort: the
      // removal proceeds even if the unlink fails.
      const spaceRoomId = this.activeSpaceRoomId();
      if (spaceRoomId) {
        try {
          await roomOps.removeRoomFromSpace(spaceRoomId, roomId);
        } catch (err) {
          await reply(`⚠️ 从空间移除失败(空间里可能残留条目,可手动移除): ${(err as Error).message}`);
        }
      }
      try {
        await roomOps.leaveRoom(roomId, "项目已删除");
      } catch (err) {
        await reply(`⚠️ 房间退出失败(可手动退出): ${(err as Error).message}`);
      }
      return;
    }
    // First send: arm the confirmation only, never delete.
    this.pendingRm.set(call.chatId, { roomId, ts: Date.now() });
    await reply(
      `⚠️ 确认删除项目「${projectLabelOf(entry)}」?\n\n` +
        `再次发送 \`/pmctl rm ${projectLabelOf(entry)}\` 确认删除。\n` +
        `确认后我会停止进程并主动退出该房间。\n` +
        `(发送 \`/pmctl rm cancel\` 取消)`
    );
  }

  private async mv(rest: string, reply: Reply): Promise<void> {
    const [target, newWorkdir] = splitFirst(rest);
    if (!target || !newWorkdir) {
      await reply("用法: /pmctl mv <项目名|房间ID> <新路径>(相对路径基于工程根)");
      return;
    }
    const resolvedWorkdir = this.resolveProjectPath(newWorkdir);
    const found = this.findProject(target);
    if (!found) {
      await reply(`❌ 未找到项目: ${target}(用 /pmctl list 查看)`);
      return;
    }
    const [roomId, entry] = found;
    this.opts.projectManager.updateProjectWorkdir(roomId, resolvedWorkdir);
    await reply(
      `🚚 项目「${projectLabelOf(entry)}」已迁移\n` +
        `• 新工作目录: ${resolvedWorkdir}\n` +
        `• 会话将重新开始(旧会话保留在旧目录 .pi-session)`
    );
  }

  private async rename(rest: string, reply: Reply, roomOps: RoomOps): Promise<void> {
    const [target, newName] = splitFirst(rest);
    if (!target || !newName) {
      await reply("用法: /pmctl rename <项目名|房间ID> <新名称>");
      return;
    }
    const found = this.findProject(target);
    if (!found) {
      await reply(`❌ 未找到项目: ${target}(用 /pmctl list 查看)`);
      return;
    }
    const [roomId] = found;
    // The new name becomes the log label — same rules as `new`, but colliding
    // with the renamed project's own current label is a rename to the same
    // name (or a case variant), not a collision.
    const existing = this.opts.projectManager
      .listProjects()
      .filter(([id]) => id !== roomId)
      .map(([, p]) => projectLabelOf(p));
    const labelError = validateProjectLabel(newName, existing);
    if (labelError) {
      await reply(`❌ ${labelError}`);
      return;
    }
    this.opts.projectManager.renameProject(roomId, newName);
    const renamed = `✏️ 项目已重命名为「${newName}」`;
    // The project mapping is already renamed; surface room-rename failures
    // instead of swallowing them.
    try {
      await roomOps.setRoomName(roomId, newName);
      await reply(renamed);
    } catch (err) {
      await reply(`${renamed}(房间改名失败: ${(err as Error).message})`);
    }
  }
}
