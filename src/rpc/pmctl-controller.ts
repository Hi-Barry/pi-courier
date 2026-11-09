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

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cloneRepository,
  type ProjectGitInfo,
  probeProjectGit,
  repoNameFromUrl,
  sameRemoteUrl,
} from "../collab/git-info.js";
import {
  activeSpaceRoomId,
  type ConfigStore,
  effectiveInstanceName,
  projectAvatarPath,
  projectFallbackChain,
} from "../config.js";
import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";
import { isCancelInput } from "../i18n/parse.js";
import { logger } from "../logger.js";
import { normalizeLabelKey, projectLabelOf, validateProjectLabel } from "../project-labels.js";
import { buildProjectWelcome, welcomeVersions } from "../project-welcome.js";
import { applyRoomCustomAvatar, ensureRoomAvatar, poolFilesForProjects } from "../room-branding.js";
import { pickPoolAvatarFile } from "../space-identity.js";
import { provisionManagedRoom } from "../space-topology.js";
import type { RoomOps } from "../transports/interface.js";
import type { PendingClaim } from "../types.js";
import { win32PathProblem, win32SamePath } from "../win32-path.js";
import type { PiRpc } from "./pi-rpc.js";
import type { ProjectEntry, ProjectManager } from "./project-manager.js";

export interface PmctlCall {
  /** Room the command came from (also the pending-rm confirmation key). */
  chatId: string;
  /** Resolved invite target for /pmctl new (transport-native MXID). */
  senderMxid: string;
  /** Whether this room is the management room. */
  isManagementRoom: boolean;
  /** 工单 sec-pmctl-admin-gate:发送者是否 admin(auth.isAdminUser 的判定
   *  结果,由调用方按消息算好传入 —— 控制器不持有 auth 依赖)。必填:
   *  漏传是类型错误而不是静默放行,与 /login /mcp 同一授权面。 */
  isAdmin: boolean;
}

export interface PmctlControllerOptions {
  projectManager: ProjectManager;
  /** Matrix room capability — absent outside Matrix deployments. */
  roomOps?: RoomOps;
  store: ConfigStore;
  /** 上线欢迎卡的发送缝(票 #210):向指定房间主动发一条。失败必须抛出
   *  (进管理房回执附注),不能吞 —— 与 sendReply 的静默约定不同。缺省 =
   *  静默跳过欢迎卡(测试与无传输部署),与 ProjectManager.notifyRoom
   *  的缺省约定同款。 */
  notifyRoom?: (roomId: string, text: string) => Promise<void> | void;
  /** Testing seam for the win32 path guards (issue #190); production default
   *  is the real process platform. */
  platform?: NodeJS.Platform;
  /** 票03(spec #299):项目工作目录的 git 事实探测缝(origin 地址 + 默认
   *  分支),供项目房元数据落盘。生产缺省 = 真实 git 探测(collab/git-info);
   *  测试注入假件,绝不 spawn 真 git。 */
  probeGit?: (workdir: string) => Promise<ProjectGitInfo | undefined>;
  /** 票04(spec #299):clone 缝(生产 = 真实 git clone;测试注入假件)。 */
  cloneRepo?: (url: string, destDir: string) => Promise<void>;
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

/** 票 #210:急启动后的会话状态里的当前模型 → `provider/id` 单引用。
 *  客户端未就绪(requireClient/getState 抛)或状态缺字段 → undefined,
 *  欢迎卡省模型行照发 —— 卡片不该被一行模型信息卡住。 */
async function readSessionModelRef(rpc: PiRpc): Promise<string | undefined> {
  try {
    const model = (await rpc.requireClient().getState()).model;
    if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  } catch {
    // fall through — omit the model line
  }
  return undefined;
}

/** /pmctl rm 确认窗(单一持有,i18n 文案插值引用 —— 审计工程批 票19)。 */
export const RM_CONFIRM_WINDOW_MS = 60_000;
const RM_CONFIRM_WINDOW_SECONDS = RM_CONFIRM_WINDOW_MS / 1000;

export class PmctlController {
  private pendingRm = new Map<string, PendingRm>();

  /** 房间消亡销账钩子(issue #114/#117 后续):/pmctl rm 确认成功后以被删
   *  房间 ID 调用一次 —— 挂在该房间的提醒与附件清单随删除同步清理。组合根
   *  在 router 装配完成后回填(构造期 router 尚不存在);best-effort,失败
   *  不阻断 rm,残留条目走 TTL 自然过期。 */
  onRoomRemoved?: (roomId: string) => Promise<void> | void;

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
      await reply(t("pmctl.singleProjectMode"));
      return true;
    }
    // Management commands are only available in the management room
    // (the first paired DM). Project rooms are for conversation only.
    if (!call.isManagementRoom) {
      await reply(t("pmctl.managementRoomOnly"));
      return true;
    }
    // 工单 sec-pmctl-admin-gate:第四道门 —— 与同房间 /login /mcp 对齐的
    // admin 授权面。缺了它,space 模式下配对成功的非 admin trusted 用户被
    // 邀入管理房后即可 /pmctl rm(停进程/删映射/退房)/mv/rename。排在管理
    // 房门之后:管理房外的请求照旧回房间限制,不向非 admin 泄露授权状态。
    if (!call.isAdmin) {
      await reply(t("pmctl.adminOnly"));
      return true;
    }
    const { roomOps } = this.opts;
    if (!roomOps) {
      await reply(t("pmctl.matrixOnly"));
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
      case "claim":
        await this.claim(rest, reply, roomOps);
        return true;
      default:
        await reply(t("pmctl.unknownOp", { op }));
        return true;
    }
  }

  /** Resolve a project path: `~`/`~/` expands to the home directory;
   *  absolute as-is; relative against the project root (config.workdir) —
   *  `/pmctl new myapp myapp` lands in ~/Projects/myapp. A relative path
   *  that escapes the root after normalization returns null (guard-rail
   *  against typos registering a project anywhere; not a security boundary
   *  — /pmctl is management-room-only, and ~/ + absolute stay first-class). */
  private resolveProjectPath(p: string): string | null {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
    // isAbsolute, not startsWith("/"): on win32 the ~/ expansion above yields
    // a drive path (C:\…) that must stay first-class too; POSIX semantics are
    // identical (absolute ⟺ starts with "/").
    if (path.isAbsolute(p)) return p;
    const root = this.opts.store.get().workdir ?? path.join(os.homedir(), "Projects");
    const resolved = path.resolve(root, p);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return resolved;
  }

  private instanceName(): string {
    return effectiveInstanceName(this.opts.store.get());
  }

  /**
   * Windows-only workdir guard (issue #190): refuse paths Windows cannot host
   * (DOS reserved names, NTFS-illegal characters, >259 chars) with a readable
   * message BEFORE any side effect, and refuse a workdir that collides
   * case-insensitively with another project (NTFS is case-insensitive, so
   * "Foo" and "foo" are one directory — two projects would share session
   * state). Returns an error message or null. POSIX hosts skip everything:
   * all three situations are legitimate there, or fail with clear system
   * errors anyway.
   */
  private win32WorkdirError(workdir: string, excludeRoomId?: string): string | null {
    if ((this.opts.platform ?? process.platform) !== "win32") return null;
    const problem = win32PathProblem(workdir);
    if (problem) {
      switch (problem.kind) {
        case "reserved":
          return t("path.win32.reserved", { component: problem.component });
        case "illegalChars":
          return t("path.win32.illegalChars", { component: problem.component });
        case "tooLong":
          return t("path.win32.tooLong", { length: problem.length });
      }
    }
    const clash = this.opts.projectManager
      .listProjects()
      .find(([roomId, p]) => roomId !== excludeRoomId && win32SamePath(p.workdir, workdir));
    if (clash) {
      return t("path.win32.dupWorkdir", { name: projectLabelOf(clash[1]), workdir: clash[1].workdir });
    }
    return null;
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
      await reply(t("pmctl.new.usage"));
      return;
    }
    // Path is optional: default to <project root>/<name>.
    const resolvedWorkdir = workdirArg ? this.resolveProjectPath(workdirArg) : this.resolveProjectPath(pname);
    if (resolvedWorkdir === null) {
      await reply(t("pmctl.pathEscape", { path: workdirArg ?? pname }));
      return;
    }
    // win32-only: hostability + case-insensitive duplicate (issue #190) —
    // before the label check and before any side effect.
    const pathError = this.win32WorkdirError(resolvedWorkdir);
    if (pathError) {
      await reply(pathError);
      return;
    }
    // The project name becomes the log label (spec #34): validate before any
    // side effects — a rejected name must not create a room or register.
    const labelError = validateProjectLabel(pname, this.currentLabels());
    if (labelError) {
      await reply(`❌ ${labelError}`);
      return;
    }
    if (!call.senderMxid) {
      await reply(t("pmctl.noInviteTarget"));
      return;
    }
    try {
      // 置备深函数(票2,spec #99):建房 → 提权 → 挂链 → 品牌,与启动
      // ensure 同一条路径 —— 中途建的项目房与自愈后的房间长相/权限一致;
      // 按套选图规则(项目房=小屋套)也在深函数内部。项目注册走落簿钩子:
      // 建房成功即落盘,后续可选步骤失败不会丢失映射。
      const provision = await provisionManagedRoom(roomOps, this.opts.store, {
        kind: "project",
        name: `${pname}(${this.instanceName()})`,
        inviteUserId: call.senderMxid,
        projectName: pname,
        onCreated: ({ roomId }) => pm.registerProject(roomId, resolvedWorkdir, pname),
      });
      // #42: every trusted user gets admin in the new room via the unified
      // elevation — not just the sender. Failure must not fail the (already
      // created) project: surface it as its own warning reply.
      if (provision.elevationError) {
        await reply(t("pmctl.new.elevationFailed", { message: provision.elevationError.message }));
      }
      // 票03(spec #299):项目房元数据(项目名 + git origin + 默认分支)落盘
      // 到房间状态事件 —— 客座认领(clone)与任何读房者据此识别"这是哪个
      // 仓库"。best-effort:失败只附注,不影响已创建的项目(与挂链/品牌
      // 失败同款机制);URL 空缺(非 git 仓库)也照写,可后补。
      let metaNote = "";
      if (roomOps?.setProjectMeta) {
        try {
          const git = await (this.opts.probeGit ?? probeProjectGit)(resolvedWorkdir);
          await roomOps.setProjectMeta(provision.roomId, { name: pname, ...git });
        } catch (err) {
          logger.warn(`[pmctl] 项目房元数据写入失败(${provision.roomId}): ${errorMessage(err)}`);
          metaNote = t("pmctl.new.metaFailed", { message: errorMessage(err) });
        }
      }
      // 票04(spec #299):owner 侧把自己的 MXID 写进房间 bot 登记簿 ——
      // 客座认领后,其 botFilter/增量信箱靠登记簿识别"谁是 bot"(对称握手:
      // 客座认领时也会写自己)。best-effort。
      try {
        const me = roomOps.getBotUserId();
        if (me) await roomOps.registerRoomBot?.(provision.roomId, me);
      } catch (err) {
        logger.warn(`[pmctl] owner bot 自登记失败(${provision.roomId}): ${errorMessage(err)}`);
      }
      // 票 #209:new 出来的项目就是要开发的项目,进程即刻拉起(急启动),
      // 不等首条消息;预设应用照旧走 getRpcForRoom 内部路径。失败不回滚:
      // 房间与登记保留,首条消息的既有启动路径自然重试,原因以附注进回执
      // (与头像失败同款机制)。启动失败则跳过欢迎卡 —— 项目没起来,不发假卡。
      let startNote = "";
      let welcomeNote = "";
      let rpc: PiRpc | undefined;
      try {
        rpc = await pm.getRpcForRoom(provision.roomId);
      } catch (err) {
        logger.warn(`[pmctl] 项目进程急启动失败(${provision.roomId}): ${errorMessage(err)}`);
        startNote = t("pmctl.new.startFailed", { message: errorMessage(err) });
      }
      // 票 #210:启动成功后读真实会话模型,向新项目房发上线欢迎卡。发送
      // 失败同样只是附注,创建流程不回滚。
      if (rpc && this.opts.notifyRoom) {
        try {
          const versions = await welcomeVersions();
          await this.opts.notifyRoom(
            provision.roomId,
            buildProjectWelcome({
              projectName: pname,
              model: await readSessionModelRef(rpc),
              ...versions,
            })
          );
        } catch (err) {
          logger.warn(`[pmctl] 上线欢迎卡发送失败(${provision.roomId}): ${errorMessage(err)}`);
          welcomeNote = t("pmctl.new.welcomeFailed", { message: errorMessage(err) });
        }
      }
      // 挂链/品牌失败:单点文案附注拼进成功回执(展示层 — 不影响项目)。
      const notes = provision.notes.map((note) => `\n⚠️ ${note}`).join("") + startNote + welcomeNote + metaNote;
      await reply(
        t("pmctl.new.ok", { name: pname, room: provision.roomId, workdir: resolvedWorkdir, notes })
      );
    } catch (err) {
      await reply(t("pmctl.new.failed", { message: errorMessage(err) }));
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
      return t("pmctl.empty");
    }
    const lines = projects.map(([roomId, p]) => {
      const status = pm.isRunning(roomId) ? t("pmctl.statusRunning") : t("pmctl.statusStopped");
      return `• ${projectLabelOf(p)} — ${status}\n  ${p.workdir} (${roomId})`;
    });
    return t("pmctl.list", { count: projects.length, lines: lines.join("\n") });
  }

  /** Resolve a user-supplied target ("name" or room ID) to a project,
   *  matching against the same labels the log filter uses (projectLabelOf). */
  private findProject(target: string): [string, ProjectEntry] | undefined {
    // 按名比较两侧同走 normalizeLabelKey(NFKC 归一 + 折叠):此前只有输入侧
    // 归一,存量标签是全角/组合重音等 NFKC 不稳定形式时永远失配(工单
    // fix-label-nfkc-two-side-normalization,与登记唯一性/日志过滤同口径)。
    const targetKey = normalizeLabelKey(target);
    return this.opts.projectManager
      .listProjects()
      .find(([roomId, p]) => normalizeLabelKey(projectLabelOf(p)) === targetKey || roomId === target);
  }

  private async show(rest: string, reply: Reply): Promise<void> {
    const target = rest.trim();
    if (!target) {
      await reply(t("pmctl.show.usage"));
      return;
    }
    const found = this.findProject(target);
    if (!found) {
      await reply(t("pmctl.notFound", { target }));
      return;
    }
    const [roomId, entry] = found;
    const pm = this.opts.projectManager;
    // 项目预设(issue #119):有什么展示什么,key=value 一行;全空注明
    // 跟随全局默认 —— 预设是"开机默认",与 /model 手动切换互不干扰。
    const presets = [
      entry.model?.trim() ? `model=${entry.model.trim()}` : undefined,
      entry.thinkingLevel?.trim() ? `thinking=${entry.thinkingLevel.trim()}` : undefined,
      projectFallbackChain(entry)?.length ? `fallbacks=${projectFallbackChain(entry)!.join(" → ")}` : undefined,
    ].filter((p): p is string => !!p);
    await reply(
      t("pmctl.show.ok", {
        name: projectLabelOf(entry),
        room: roomId,
        workdir: entry.workdir,
        status: pm.isRunning(roomId) ? t("pmctl.statusRunning") : t("pmctl.statusLazy"),
        session: pm.sessionDirFor(roomId),
        presets: presets.join(" · ") || t("pmctl.show.noPresets"),
      })
    );
  }

  private async rm(rest: string, call: PmctlCall, reply: Reply, roomOps: RoomOps): Promise<void> {
    const pm = this.opts.projectManager;
    const target = rest.trim();
    if (!target) {
      await reply(t("pmctl.rm.usage"));
      return;
    }
    // cancel: clear the armed confirmation
    if (target === "no" || isCancelInput(target)) {
      const had = this.pendingRm.delete(call.chatId);
      await reply(had ? t("pmctl.rm.cancelled") : t("pmctl.rm.nothingPending"));
      return;
    }
    const found = this.findProject(target);
    if (!found) {
      this.pendingRm.delete(call.chatId);
      await reply(t("pmctl.notFound", { target }));
      return;
    }
    const [roomId, entry] = found;
    const pending = this.pendingRm.get(call.chatId);
    if (pending && Date.now() - pending.ts > RM_CONFIRM_WINDOW_MS) {
      this.pendingRm.delete(call.chatId); // expired — treat as a fresh rm
      await reply(t("pmctl.rm.expired", { seconds: RM_CONFIRM_WINDOW_SECONDS }));
    }
    // Only the exact room armed for THIS chat confirms — a stale or
    // different-room pending entry can never delete the wrong project.
    if (this.pendingRm.get(call.chatId)?.roomId === roomId) {
      this.pendingRm.delete(call.chatId);
      await pm.removeProject(roomId);
      // 房间意图销账:删除确认后立即清掉挂在该房间的提醒与附件清单 ——
      // 意图已无人能兑现,不等 TTL。失败不阻断 rm 本身(工程已删)。
      if (this.onRoomRemoved) {
        try {
          await this.onRoomRemoved(roomId);
        } catch (err) {
          logger.warn(`room-death purge failed (entries expire via TTL): ${errorMessage(err)}`);
        }
      }
      await reply(t("pmctl.rm.done", { name: projectLabelOf(entry), workdir: entry.workdir }));
      // Unfile from the space first — once the bot leaves, it can no longer
      // clear the space-side child state (ghost entry). Best-effort: the
      // removal proceeds even if the unlink fails.
      const spaceRoomId = this.activeSpaceRoomId();
      if (spaceRoomId) {
        try {
          await roomOps.removeRoomFromSpace(spaceRoomId, roomId);
        } catch (err) {
          await reply(t("pmctl.rm.unlinkFailed", { message: errorMessage(err) }));
        }
      }
      try {
        await roomOps.leaveRoom(roomId, t("pmctl.leaveReason"));
      } catch (err) {
        await reply(t("pmctl.rm.leaveFailed", { message: errorMessage(err) }));
      }
      return;
    }
    // First send: arm the confirmation only, never delete.
    this.pendingRm.set(call.chatId, { roomId, ts: Date.now() });
    await reply(t("pmctl.rm.confirm", { name: projectLabelOf(entry) }));
  }

  private async mv(rest: string, reply: Reply): Promise<void> {
    const [target, newWorkdir] = splitFirst(rest);
    if (!target || !newWorkdir) {
      await reply(t("pmctl.mv.usage"));
      return;
    }
    const resolvedWorkdir = this.resolveProjectPath(newWorkdir);
    if (resolvedWorkdir === null) {
      await reply(t("pmctl.pathEscape", { path: newWorkdir }));
      return;
    }
    const found = this.findProject(target);
    if (!found) {
      await reply(t("pmctl.notFound", { target }));
      return;
    }
    const [roomId, entry] = found;
    // win32-only: hostability + duplicate check against OTHER projects (the
    // project's own current workdir is not a clash) — issue #190.
    const pathError = this.win32WorkdirError(resolvedWorkdir, roomId);
    if (pathError) {
      await reply(pathError);
      return;
    }
    await this.opts.projectManager.updateProjectWorkdir(roomId, resolvedWorkdir);
    // 会话目录跟随绑定事件决策(spec #299 票01),与 spawn 同一解析源。
    const sessionDirName = path.basename(this.opts.projectManager.sessionDirFor(roomId));
    // 票03(spec #299 评审整改):换目录 = git 事实可能变化,元数据重新探测
    // 落盘,避免 gitUrl 陈旧误导认领方。best-effort:失败不影响 mv 本身。
    if (this.opts.roomOps?.setProjectMeta) {
      try {
        const git = (await (this.opts.probeGit ?? probeProjectGit)(resolvedWorkdir)) ?? {};
        const existing = (await this.opts.roomOps.getProjectMeta?.(roomId)) ?? null;
        await this.opts.roomOps.setProjectMeta(roomId, { name: existing?.name ?? projectLabelOf(entry), ...git });
      } catch (err) {
        logger.warn(`[pmctl] 项目房元数据刷新失败(${roomId}): ${errorMessage(err)}`);
      }
    }
    await reply(t("pmctl.mv.done", { name: projectLabelOf(entry), workdir: resolvedWorkdir, sessionDir: sessionDirName }));
  }

  // ---- 票04(spec #299):客座认领流 -----------------------------------------

  /** 待认领邀请(collab.pendingClaims)的单一写路径:落盘前重读,
   *  防多房间并发发卡时丢更新(与票02 陌生房簿记同一口径)。 */
  private updatePendingClaims(mutate: (claims: PendingClaim[]) => PendingClaim[]): void {
    const fresh = this.opts.store.get().collab;
    this.opts.store.update({
      collab: { ...fresh, pendingClaims: mutate(fresh?.pendingClaims ?? []) },
    });
  }

  private pendingClaims(): PendingClaim[] {
    return this.opts.store.get().collab?.pendingClaims ?? [];
  }

  /** /pmctl claim — 认领确认卡的指令面:空参列清单,`reject <n>` 拒绝,
   *  `<n> [子目录]` 确认(clone 落地 → guest 绑定 → 双向 bot 登记 → 上岗通报)。 */
  private async claim(rest: string, reply: Reply, roomOps: RoomOps): Promise<void> {
    const claims = this.pendingClaims();
    const [first, second] = splitFirst(rest);
    if (!first) {
      if (claims.length === 0) {
        await reply(t("collab.claim.none"));
        return;
      }
      const lines = claims.map((c, i) => {
        const dir = path.join(this.opts.store.get().workdir ?? "~", repoNameFromUrl(c.url));
        return t("collab.claim.listItem", { index: i + 1, room: c.roomId, name: c.projectName, url: c.url, dir });
      });
      await reply(t("collab.claim.listHeader", { count: claims.length }) + "\n" + lines.join("\n"));
      return;
    }
    if (first.toLowerCase() === "reject") {
      const n = Number.parseInt(second, 10);
      if (!Number.isInteger(n) || n < 1 || n > claims.length) {
        await reply(t("collab.claim.indexOOB", { max: claims.length }));
        return;
      }
      const gone = claims.splice(n - 1, 1)[0]!;
      this.updatePendingClaims(() => claims);
      await reply(t("collab.claim.rejected", { room: gone.roomId }));
      return;
    }
    const n = Number.parseInt(first, 10);
    if (!Number.isInteger(n) || n < 1 || n > claims.length) {
      await reply(t("collab.claim.indexOOB", { max: claims.length }));
      return;
    }
    const pending = claims[n - 1]!;
    const dirName = second.trim() || repoNameFromUrl(pending.url);
    const resolvedWorkdir = this.resolveProjectPath(dirName);
    if (resolvedWorkdir === null) {
      await reply(t("pmctl.pathEscape", { path: dirName }));
      return;
    }
    const cloneRepo = this.opts.cloneRepo ?? cloneRepository;
    try {
      // 目录已存在:remote 吻合 → 直接绑已有克隆(不重复 clone);否则追问换目录。
      let existed = false;
      if (existsSync(resolvedWorkdir)) {
        const remote = (await probeProjectGit(resolvedWorkdir))?.gitUrl;
        if (remote && sameRemoteUrl(remote, pending.url)) {
          existed = true;
        } else {
          await reply(t("collab.claim.occupied", { dir: resolvedWorkdir, index: n }));
          return;
        }
      } else {
        await cloneRepo(pending.url, resolvedWorkdir);
      }
      // guest 绑定:mode=guest 持久化(spec #299 决定2);会话目录按绑定事件解析(票01)。
      this.opts.projectManager.registerProject(pending.roomId, resolvedWorkdir, pending.projectName, "guest");
      // 从待认领簿记移除(以函数式过滤走单点写路径)。
      this.updatePendingClaims((list) => list.filter((c) => c.roomId !== pending.roomId));
      // 双向 bot 登记:guest 写自己的 MXID 进房间登记簿 —— owner 侧的
      // botFilter/信箱由此识别"谁是 bot"。失败不致命:只影响对端识别,本侧无碍。
      try {
        const me = roomOps.getBotUserId();
        if (me) await roomOps.registerRoomBot?.(pending.roomId, me);
      } catch (err) {
        logger.warn(`[pmctl] 客座 bot 自登记失败(${pending.roomId}): ${errorMessage(err)}`);
      }
      // 上岗通报:发进项目房,让房主可感知客座就绪。失败仅附注,不回滚绑定。
      let onboardNote = "";
      if (this.opts.notifyRoom) {
        try {
          await this.opts.notifyRoom(
            pending.roomId,
            t("collab.claim.onboarded", { dir: resolvedWorkdir, name: pending.projectName })
          );
        } catch (err) {
          onboardNote = t("collab.claim.onboardFailed", { message: errorMessage(err) });
        }
      }
      await reply(
        t(existed ? "collab.claim.okExisting" : "collab.claim.ok", {
          room: pending.roomId,
          dir: resolvedWorkdir,
          name: pending.projectName,
        }) + onboardNote
      );
    } catch (err) {
      // clone 失败:邀请保留在簿记里,可换目录或修网后重试。
      await reply(t("collab.claim.cloneFailed", { message: errorMessage(err) }));
    }
  }

  private async rename(rest: string, reply: Reply, roomOps: RoomOps): Promise<void> {
    const [target, newName] = splitFirst(rest);
    if (!target || !newName) {
      await reply(t("pmctl.rename.usage"));
      return;
    }
    const found = this.findProject(target);
    if (!found) {
      await reply(t("pmctl.notFound", { target }));
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
    // 头像重选基线:改名前的去重选图(新旧同图则免一次无谓上传)。
    const oldPoolFile = poolFilesForProjects(this.opts.store.get()).get(roomId);
    this.opts.projectManager.renameProject(roomId, newName);
    const renamed = t("pmctl.rename.ok", { name: newName });
    // 头像跟随(v5):自定义头像房按期望状态维护;图池房按新名重选(同空间
    // 去重)。失败附注到回复但不阻塞改名 —— 纯外观问题,下次改名或重启自愈可再刷。
    let avatarNote = "";
    try {
      const cfgNow = this.opts.store.get();
      const customPath = projectAvatarPath(cfgNow.projects?.[roomId]);
      if (customPath) {
        await applyRoomCustomAvatar(roomOps, this.opts.store, roomId, customPath);
      } else {
        const newFile = poolFilesForProjects(cfgNow).get(roomId) ?? pickPoolAvatarFile(newName, "room");
        if (newFile !== oldPoolFile) {
          await ensureRoomAvatar(roomOps, roomId, newFile, { rebrand: true });
        }
      }
    } catch (err) {
      avatarNote = t("pmctl.rename.avatarFailed", { message: errorMessage(err) });
      logger.warn(`[identity] /pmctl rename 头像重选失败(${roomId}): ${errorMessage(err)}`);
    }
    // 票03(spec #299):元数据里的项目名跟随改名(best-effort —— 读不到旧
    // 元数据或写失败都不致命,元数据本就可后补)。
    if (roomOps.getProjectMeta && roomOps.setProjectMeta) {
      try {
        const meta = await roomOps.getProjectMeta(roomId);
        if (meta && meta.name !== newName) {
          await roomOps.setProjectMeta(roomId, { ...meta, name: newName });
        }
      } catch (err) {
        logger.warn(`[pmctl] 项目房元数据改名同步失败(${roomId}): ${errorMessage(err)}`);
      }
    }
    // The project mapping is already renamed; surface room-rename failures
    // instead of swallowing them.
    try {
      await roomOps.setRoomName(roomId, newName);
      await reply(`${renamed}${avatarNote}`);
    } catch (err) {
      await reply(`${renamed}${avatarNote}${t("pmctl.rename.roomFailed", { message: errorMessage(err) })}`);
    }
  }
}
