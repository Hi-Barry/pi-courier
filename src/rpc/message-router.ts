/**
 * Message router — the core wiring between messenger transports and pi RPC.
 *
 * Shared by the standalone entry (and testable in isolation with a mock transport):
 *   incoming messenger message ──> router ──> RPC command / prompt
 *   agent events ────────────────> router ──> reply back to the messenger
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { handleAdminCommand } from "../auth/admin-commands.js";
import { type ChallengeAuth } from "../auth/challenge-auth.js";
import { LoginManager } from "../auth/headless-login.js";
import { type ConfigStore, managementRoomId } from "../config.js";
import {
  extractTextFromMessage,
  formatToolCalls,
  hasToolCalls,
  splitMessage,
} from "../formatting.js";
import { namespacedId } from "../identity.js";
import { t } from "../i18n/index.js";
import { isEnabled, type LeveledLogger, logger } from "../logger.js";
import { demoteTrustedUserEverywhere, inviteUserToManagementRoomOnce, inviteUserToSpaceOnce, maybeInitManagementRoom } from "../space.js";
import { formatBytes } from "../transports/attachments.js";
import type { RoomOps } from "../transports/interface.js";
import type { ExternalMessage, MessageAttachment, ReplyTarget } from "../types.js";
import {
  type BashTracker,
  createBashTracker,
  formatBashReply,
  handleSlashCommand,
  parseBangCommand,
} from "./command-map.js";
import { ExtensionQuestions, type ExtensionUIRequestView, extensionUiTimeoutMs } from "./extension-questions.js";
import type { PiRpc } from "./pi-rpc.js";
import type { PmctlController } from "./pmctl-controller.js";
import type { ProjectManager } from "./project-manager.js";
import { RpcTransientState } from "./rpc-transient-state.js";

export interface MessageRouterDeps {
  /** Multi-project routing: resolves the PiRpc for a room (default when unmapped). */
  projectManager: ProjectManager;
  auth: ChallengeAuth;
  /** Send a text reply to a chat via a transport (errors swallowed by caller) */
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>;
  /** Best-effort typing indicator (silent no-op when unavailable) */
  sendTyping: (chatId: string, transport: string) => Promise<void>;
  /** Injected config store — the single runtime read/write path. */
  store: ConfigStore;
  /** Room-management capability (Matrix). Optional: absent in single-project
   *  or non-Matrix deployments; only the /pmctl path and management-room
   *  branding consume it. */
  roomOps?: RoomOps;
  /** Multi-project management (/pmctl family): gates + actions in one module. */
  pmctl: PmctlController;
  /** Space-mode gate: while the organizational space is enabled, the
   *  management room is bot-created at startup and first-DM adoption is
   *  reserved for the degraded path (space ensure failed this run). Absent
   *  = always allowed (legacy deployments). */
  managementRoomAdoptionAllowed?: () => boolean;
  /** Headless login (issue #55): owns /login /logout /auth and captures the
   *  answers of in-flight login flows. Injected by tests (mock runtime);
   *  defaults to a real ModelRuntime at pi's standard credential file. */
  login?: LoginManager;
}

/**
 * 管道阶段声明(spec #72 票3/C1):顺序约束与消耗语义升格为结构——
 * 每个阶段自述它与授权门、附件待处理清单、pi 进程懒启动的关系,
 * 取代"第 N 级 return 是否消耗清单"式的注释守护。
 */
export interface PipelineStageView {
  name: string;
  /** 在授权门之前运行(自带门禁的命令族)。 */
  preAuth: boolean;
  /** 到达本阶段即消耗附件待处理清单——全管道只有 prompt。 */
  consumesLedger: boolean;
  /** 需要为当前房间解析 pi 进程(懒启动副作用发生在第一次取用)。 */
  needsRpc: boolean;
}

interface StageContext {
  msg: ExternalMessage;
  text: string;
  log: LeveledLogger;
  isAuthorized: boolean;
  isManagementRoom: boolean;
  multiProject: boolean;
  /** 懒解析 pi 进程:第一次取用才 spawn,失败回执并抛 RPC_ABORT。 */
  roomRpc: () => Promise<PiRpc>;
}

export interface MessageRouter {
  /** Handle an incoming messenger message */
  handleIncoming(msg: ExternalMessage): Promise<void>;
  /** 管道阶段视图(spec #72 票3/C1):顺序即执行顺序,属性即不变量——
   *  供测试钉住"阶段表",供导航时一眼读出管道形状。 */
  pipeline(): PipelineStageView[];
  /** Handle an agent event emitted by `rpc` — the reply target comes from
   *  the rpc's binding (see RoomBinding), never from a global slot. */
  handleEvent(rawEvent: unknown, rpc: PiRpc): void;
}

/**
 * Reply routing: every pi process is bound to the chat that prompted it.
 * Project rpcs are pinned to their owning room (re-bound here with the real
 * transport/username); the shared default rpc is re-bound by each DM prompt.
 * Because bindings are per-process, a project-room prompt can never misroute
 * a DM reply — the b7a5d7f bug class dies structurally. Cross-conversation
 * attribution inside ONE shared process is a protocol limit (pi's RPC has no
 * chat concept), so the default rpc's binding legitimately follows the most
 * recent prompter.
 */
interface RoomBinding {
  /** Pinned bindings (project rooms) survive completed turns; the shared
   *  default rpc's binding releases after one. */
  pinned: boolean;
  replyTarget: ReplyTarget;
}

/** Format a completed turn into reply text. Returns text = null when the turn
 *  has no replyable content (the binding is kept for the follow-up turn).
 *  Error turns (stopReason "error") always yield replyable text — the failure
 *  line rides along even when the model produced no content (issue #52). */
export function buildTurnReply(
  message: AssistantMessage,
  hideToolCalls?: boolean
): { text: string | null; pendingTools: boolean } {
  const responseText = extractTextFromMessage(message);
  const toolCallsText = formatToolCalls(message);
  const pendingTools = hasToolCalls(message);
  const parts: string[] = [];
  const trimmed = responseText.trim();
  if (trimmed) parts.push(trimmed);
  if (toolCallsText && !hideToolCalls) parts.push(toolCallsText);
  // Error visibility (issue #52): a turn ending with stopReason "error" must
  // reach the room even when the model produced no text — the text=null path
  // used to swallow failed turns silently (holding an unpinned binding
  // forever). Partial content survives; the failure line rides along.
  if (message.stopReason === "error") {
    parts.push(t("router.turn.failed", { message: message.errorMessage ?? t("common.unknownError") }));
  }
  if (parts.length === 0) return { text: null, pendingTools };
  return { text: parts.join("\n\n"), pendingTools };
}

/**
 * Extension UI 提问机(spec #99 票3 / issue #104):extension_ui_request 的
 * 接纳、FIFO 队列、答案解析、超时代答与重启失效整体住在
 * ./extension-questions.ts(ExtensionQuestions,模块形状对照 LoginManager)。
 * router 只编排 —— handleEvent 的事件路径与 extensionCapture 管道阶段调用
 * 它;提问文案、答案映射与超时时长(extensionUiTimeoutMs)等纯函数也随迁,
 * 供模块测试直测。
 */

/**
 * Reply-quote prefix (issue #56 票5): when a message replies to a known
 * historical message, prepend a one-line excerpt so the agent can resolve
 * "这个"/"上面那个". Only the text sent to pi changes — slash-command
 * detection runs earlier on the raw text and stays untouched.
 */
export function withQuotePrefix(
  text: string,
  quoted?: { username: string; excerpt: string }
): string {
  if (!quoted?.excerpt) return text;
  return `「@${quoted.username}: ${quoted.excerpt}」\n${text}`;
}

/**
 * 附件路径注入(issue #66 票1):把待处理清单里的附件以绝对路径列表的形式
 * 放在用户原文前 — pi 按原生工作流用 read 工具查看文件(与 TUI 的 @路径
 * 一致)。纯函数,router 测试直接断言其输出。
 */
export function withAttachmentPrefix(
  text: string,
  attachments?: MessageAttachment[]
): string {
  if (!attachments?.length) return text;
  const lines = attachments.map((a) => `- ${a.path}`);
  return `${t("router.attach.inject")}\n${lines.join("\n")}\n\n${text}`;
}

/** 附件清单的记账键:房间 + 发送者(群聊里甲的图不被乙的消息消耗)。 */
export function attachmentLedgerKey(chatId: string, userId: string): string {
  return `${chatId}\u0000${userId}`;
}

/** 保存成功回执(issue #66 票1):路径可见,清单状态不静默。 */
export function attachmentSavedReply(attachment: MessageAttachment): string {
  return t("router.attach.saved", { path: attachment.path, bytes: formatBytes(attachment.bytes) });
}

/** 附件失败回执:transport 给出的原因原样透传(下载/解密/超限各有文案)。 */
export function attachmentErrorReply(reason: string): string {
  return `❌ ${reason}`;
}

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  const { projectManager, auth, sendReply, sendTyping, roomOps, store, pmctl, managementRoomAdoptionAllowed } = deps;
  const bindings = new WeakMap<PiRpc, RoomBinding>();
  const bindReplyTarget = (rpc: PiRpc, replyTarget: ReplyTarget, pinned: boolean): void => {
    bindings.set(rpc, { pinned, replyTarget });
  };

  // 瞬态状态(spec #72 票6/C5):队列镜像 + 悬置提问,失效时机自治 ——
  // 状态模块订阅 PiRpc 的重启生命周期,不再有外借的 clearRpcState 扳机。
  const transient = new RpcTransientState((rpc, handler) => rpc.onRestarted?.(handler));

  // 待处理附件清单(issue #66 票1):按 房间+发送者 记账,内存态 — 重启即清
  // (每张回执都带路径,不构成数据丢失)。消耗规则:该发送者在同一条管道里
  // 真正发给 pi 的下一条对话消息(prompt 唯一注入点)一次性带上全部并清空;
  // 管理命令、登录/extension-ui 应答捕获都在注入点之前 return,天然不消耗。
  const pendingAttachments = new Map<string, MessageAttachment[]>();

  // 在跑 bash 记账(/bashstop 的数据源):/bash 与 `!`/`!!` 共用一份,
  // 按 pi 进程记账,promise 落定自动销账(见 createBashTracker)。
  const bashTracker: BashTracker = createBashTracker();

  // Headless login (issue #55): /login /logout /auth + answer capture. The
  // default manager writes credentials straight to pi's auth.json via an
  // independent ModelRuntime (never through the RPC subprocesses).
  const login =
    deps.login ??
    new LoginManager({
      sendReply,
      allRpcs: () => projectManager.allRpcs(),
    });

  // Extension-UI 提问机(spec #99 票3 / issue #104):状态(FIFO 队列 + 超时
  // 计时器)与不变量都在模块里;router 只注入出口 —— 发帖、extension_ui 应答
  // 写入口、超时时长派生与重启生命周期订阅(与瞬态状态同一接缝)。
  const questions = new ExtensionQuestions({
    sendReply,
    respond: (rpc, payload) => rpc.respondExtensionUI(payload),
    timeoutMs: () => extensionUiTimeoutMs(store.get()),
    subscribeRestart: (rpc, handler) => rpc.onRestarted?.(handler),
  });

  // ── 管道阶段(spec #72 票3/C1)─────────────────────────────────────
  // 顺序即执行顺序。每个阶段的 handle 返回 true = 消息已被处理(管道终止)。
  // 不变量:consumesLedger=true 的阶段有且仅有 prompt(附件待处理清单的
  // 唯一消耗点);preAuth=true 的阶段自带门禁,在授权门之前运行。
  const RPC_ABORT = Symbol("rpc-abort");

  const stages: Array<PipelineStageView & { handle: (ctx: StageContext) => Promise<boolean> }> = [
    {
      name: "authorization",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Authorization (initiates 6-digit challenge for unknown users in DMs):
      // computing it has the side effect of the challenge flow, so it runs for
      // every message — even for preAuth stages above that ignore the result.
      handle: async (ctx) => {
        ctx.isAuthorized = await auth.checkAuthorization(
          ctx.msg.userId,
          ctx.msg.chatId,
          ctx.msg.username,
          ctx.msg.isGroupChat,
          ctx.msg.wasMentioned ?? false,
          async (cId, replyText) => sendReply(cId, ctx.msg.transport, replyText),
          ctx.msg.transport
        );
        return false;
      },
    },
    {
      name: "attachments",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // 附件/失败/不支持载荷的分流:必须在斜杠/挑战码解析之前截住 — 文件名
      // 可能碰巧以 "/" 或 6 位数字开头。回执是 router 政策:未授权用户与
      // 文本消息同等对待(静默丢弃,文件已落盘但不入清单)。
      handle: async (ctx) => {
        if (ctx.msg.payload.kind === "text") return false;
        if (!ctx.isAuthorized) return true;
        switch (ctx.msg.payload.kind) {
          case "mediaError":
            await sendReply(ctx.msg.chatId, ctx.msg.transport, attachmentErrorReply(ctx.msg.payload.reason));
            return true;
          case "unsupported":
            await sendReply(
              ctx.msg.chatId,
              ctx.msg.transport,
              t("router.payload.unsupported", { msgtype: ctx.msg.payload.msgtype })
            );
            return true;
          case "media": {
            const key = attachmentLedgerKey(ctx.msg.chatId, ctx.msg.userId);
            const ledger = pendingAttachments.get(key) ?? [];
            for (const attachment of ctx.msg.payload.saved) {
              ledger.push(attachment);
              await sendReply(ctx.msg.chatId, ctx.msg.transport, attachmentSavedReply(attachment));
            }
            pendingAttachments.set(key, ledger);
            return true;
          }
        }
      },
    },
    {
      name: "adminCommands",
      preAuth: true,
      consumesLedger: false,
      needsRpc: false,
      // Bridge admin commands + challenge codes in DMs. /help is reserved
      // for pi (the RPC command help also lists bridge commands).
      handle: async (ctx) => {
        const { msg, text } = ctx;
        if (msg.isGroupChat || (!text.startsWith("/") && !/^\d{6}$/.test(text))) return false;
        const cmdName = text.split(/\s+/)[0].toLowerCase();
        if (text.startsWith("/") && cmdName === "/help") return false;
        const result = handleAdminCommand(auth, {
          text,
          userId: msg.userId,
          transport: msg.transport,
          chatId: msg.chatId,
          hideToolCalls: store.get().hideToolCalls,
        });
        if (!result.handled) return false;
        for (const replyText of result.replies) {
          await sendReply(msg.chatId, msg.transport, replyText);
        }
        for (const notification of result.notifications) {
          logger.info(`[auth:${notification.level}] ${notification.message}`);
        }
        for (const effect of result.effects) {
          if (effect.kind === "persistAuth") {
            store.update({ auth: auth.exportConfig() });
          } else if (effect.kind === "hideToolCalls") {
            store.update({ hideToolCalls: effect.value });
          } else if (effect.kind === "spaceInvite" && roomOps) {
            // Trust just granted (challenge passed): invite into the
            // organizational space — fire-once, best-effort (see space.ts).
            await inviteUserToSpaceOnce(
              roomOps,
              store,
              namespacedId(effect.userId, effect.transport)
            );
          } else if (effect.kind === "managementRoomInvite" && roomOps) {
            // Trust just granted: the management room (/pmctl home) must be
            // reachable too — fire-once, best-effort, space mode only; the
            // degraded path's adopted DM is never used to pull people in.
            await inviteUserToManagementRoomOnce(
              roomOps,
              store,
              namespacedId(effect.userId, effect.transport)
            );
          } else if (effect.kind === "powerDemote" && roomOps) {
            // Trust just revoked (ticket 3): strip the admin power this
            // instance once granted — every managed room, PL 0. Best-effort
            // like the invite effects: failures warn and stay in the
            // powerElevatedUsers bookkeeping for the startup heal to retry;
            // the revoke itself stands either way.
            await demoteTrustedUserEverywhere(
              roomOps,
              store,
              namespacedId(effect.userId, effect.transport)
            );
          }
        }
        return true;
      },
    },
    {
      name: "groupEnable",
      preAuth: true,
      consumesLedger: false,
      needsRpc: false,
      // Group chats: a trusted user can enable the current room without
      // knowing its ID — send "/enable <mode>" right in the room. This must
      // run BEFORE authorization (unenabled rooms are not authorized).
      handle: async (ctx) => {
        const { msg, text } = ctx;
        if (!msg.isGroupChat || !text.startsWith("/enable")) return false;
        const isTrusted = auth.isTrustedUser(msg.userId, msg.transport);
        if (!isTrusted) return false;
        const parts = text.split(/\s+/);
        const mode = (parts[1] || "trusted-only") as "all" | "mentions" | "trusted-only";
        if (mode !== "all" && mode !== "mentions" && mode !== "trusted-only") {
          await sendReply(msg.chatId, msg.transport, t("router.enable.usage"));
          return true;
        }
        // "all" responds to everyone — admin-only. Trusted users may only
        // request trusted-only / mentions.
        if (mode === "all" && !auth.isAdminUser(msg.userId, msg.transport)) {
          await sendReply(msg.chatId, msg.transport, t("router.enable.allAdminOnly"));
          return true;
        }
        auth.enableChannel(msg.chatId, mode);
        store.update({ auth: auth.exportConfig() });
        await sendReply(msg.chatId, msg.transport, t("router.enable.ok", { mode }));
        logger.info(`[auth] 房间 ${msg.chatId} 已由 ${msg.username} 启用 (${mode})`);
        return true;
      },
    },
    {
      name: "authorizationGate",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Unauthorized senders stop here, silently — same treatment as text.
      handle: async (ctx) => !ctx.isAuthorized,
    },
    {
      name: "multiproject",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // /multiproject — switch single/multi project mode. Config read/write;
      // takes effect on restart. Trusted users may toggle.
      handle: async (ctx) => {
        const { msg, text } = ctx;
        if (!text.startsWith("/multiproject")) return false;
        const isTrusted = auth.isTrustedUser(msg.userId, msg.transport);
        if (!isTrusted) {
          await sendReply(msg.chatId, msg.transport, t("router.multiproject.forbidden"));
          return true;
        }
        const action = text.split(/\s+/)[1]?.toLowerCase() ?? "";
        const current = projectManager.isMultiProject ? t("router.multiproject.currentOn") : t("router.multiproject.currentOff");
        if (action === "on" || action === "off") {
          const next = action === "on";
          if (next === projectManager.isMultiProject) {
            await sendReply(msg.chatId, msg.transport, t("router.multiproject.noChange", { current }));
            return true;
          }
          store.update({ multiProject: next });
          await sendReply(
            msg.chatId,
            msg.transport,
            t("router.multiproject.switched", {
              state: next ? t("common.enabled") : t("common.disabled"),
              detail: next ? t("router.multiproject.detailOn") : t("router.multiproject.detailOff"),
            })
          );
        } else {
          await sendReply(msg.chatId, msg.transport, t("router.multiproject.usage", { current }));
        }
        return true;
      },
    },
    {
      name: "managementAdoption",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Management room = the FIRST accepted message in a private (≤2 person)
      // non-project room fixes that room's ID (managementRooms[0]). Works for
      // BOTH challenge-code pairing and config-driven trusted users. Only in
      // multi-project mode.
      handle: async (ctx) => {
        if (
          ctx.multiProject &&
          roomOps &&
          (managementRoomAdoptionAllowed?.() ?? true) &&
          !managementRoomId(store.get()) &&
          !ctx.msg.isGroupChat &&
          !projectManager.isProjectRoom(ctx.msg.chatId)
        ) {
          await maybeInitManagementRoom(ctx.msg, sendReply, roomOps, store);
        }
        ctx.isManagementRoom = ctx.multiProject && managementRoomId(store.get()) === ctx.msg.chatId;
        return false;
      },
    },
    {
      name: "roomBinding",
      preAuth: false,
      consumesLedger: false,
      needsRpc: true,
      // Resolve + bind the room's pi process (post-gate — old behaviour):
      // extension_ui questions and agent events route back through the
      // RoomBinding, so every conversational/management message that reaches
      // here must leave the room bound. Unmapped rooms resolve to the running
      // default rpc (no spawn); mapped project rooms start theirs exactly as
      // they always did.
      handle: async (ctx) => {
        await ctx.roomRpc();
        return false;
      },
    },
    {
      name: "pmctl",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // /pmctl family: gates + actions live in the controller. The invite
      // target arrives pre-resolved (transport-native MXID). No pi process
      // is started for management commands.
      handle: async (ctx) =>
        await pmctl.handle(ctx.text, { chatId: ctx.msg.chatId, senderMxid: ctx.msg.userId, isManagementRoom: ctx.isManagementRoom }, async (replyText) => sendReply(ctx.msg.chatId, ctx.msg.transport, replyText)),
    },
    {
      name: "login",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Headless login (issue #55): /login /logout /auth — admin + management
      // room only. Single-project mode has no management room: a DM counts as
      // one (that is where the admin talks to the bot there).
      handle: async (ctx) => {
        const { msg, text } = ctx;
        if (!/^\/(login|logout|auth)(\s|$)/.test(text)) return false;
        const loginRoomAllowed = ctx.multiProject
          ? ctx.isManagementRoom
          : !msg.isGroupChat;
        if (!auth.isAdminUser(msg.userId, msg.transport)) {
          await sendReply(msg.chatId, msg.transport, t("router.login.forbidden"));
          return true;
        }
        if (!loginRoomAllowed) {
          await sendReply(msg.chatId, msg.transport, t("router.login.roomRestricted"));
          return true;
        }
        const loginCmd = text.split(/\s+/)[0]!.toLowerCase();
        const loginArgs = text.slice(loginCmd.length).trim();
        if (loginCmd === "/login") {
          if (!loginArgs) {
            await login.listProviders(msg.chatId, msg.transport);
          } else {
            const [providerId, method] = loginArgs.split(/\s+/);
            await login.startLogin(msg.chatId, msg.transport, providerId!, method);
          }
          return true;
        }
        if (loginCmd === "/logout") {
          if (!loginArgs) {
            await sendReply(msg.chatId, msg.transport, t("router.login.logoutUsage"));
            return true;
          }
          await login.logout(msg.chatId, msg.transport, loginArgs.split(/\s+/)[0]!);
          return true;
        }
        await login.authStatus(msg.chatId, msg.transport);
        return true;
      },
    },
    {
      name: "slashCommands",
      preAuth: false,
      consumesLedger: false,
      needsRpc: true,
      // Slash commands → RPC mapping (builtin) or passthrough (extensions/
      // skills/templates). Unhandled slashes fall through to the prompt —
      // pi expands its own commands/skills/templates.
      handle: async (ctx) => {
        if (!ctx.text.startsWith("/")) return false;
        const rpc = await ctx.roomRpc();
        try {
          const handled = await handleSlashCommand(ctx.text, {
            rpc,
            reply: async (replyText) => sendReply(ctx.msg.chatId, ctx.msg.transport, replyText),
            queueView: () => transient.mirror(rpc),
            allRpcs: () => projectManager.allRpcs(),
            bashTracker,
          });
          return handled;
        } catch (err) {
          await sendReply(ctx.msg.chatId, ctx.msg.transport, t("cmd.generic.error", { message: (err as Error).message }));
          return true;
        }
      },
    },
    {
      name: "bashBang",
      preAuth: false,
      consumesLedger: false,
      needsRpc: true,
      // `!`/`!!` bash 快捷执行(≈ pi TUI 的 !/!!):收到即回执,完成(或被
      // /bashstop 中止)后回帖结果。不等待完成 —— 长命令不阻塞管道,后续
      // 消息照常处理;记账进 bashTracker 供 /bashstop 列出/中止。
      handle: async (ctx) => {
        const bang = parseBangCommand(ctx.text);
        if (!bang) return false;
        const rpc = await ctx.roomRpc();
        const release = bashTracker.track(rpc, bang.command);
        void sendReply(
          ctx.msg.chatId,
          ctx.msg.transport,
          t("router.bang.inProgress", { command: bang.command, suffix: bang.excluded ? t("cmd.bash.excludedNote") : "" })
        ).catch(() => {});
        rpc.bash(bang.command, { excludeFromContext: bang.excluded })
          .then((result) => sendReply(ctx.msg.chatId, ctx.msg.transport, formatBashReply(bang.command, result, bang.excluded)))
          .catch((err: unknown) =>
            sendReply(ctx.msg.chatId, ctx.msg.transport, t("cmd.bash.error", { message: (err as Error).message }))
          )
          .catch(() => {})
          .finally(release);
        return true;
      },
    },
    {
      name: "loginCapture",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Answer capture for plain (non-"/") messages: login flows (issue #55)
      // capture FIRST — while a login waits in this room its answer wins over
      // any pending extension_ui question (ticket requirement); 「取消」 aborts
      // the login at any moment. Messages arriving between prompts (OAuth
      // polling) are NOT consumed — the room stays usable during long waits.
      handle: async (ctx) => {
        if (ctx.text.startsWith("/")) return false;
        return login.isPending(ctx.msg.chatId) && (await login.deliver(ctx.msg.chatId, ctx.text));
      },
    },
    {
      name: "extensionCapture",
      preAuth: false,
      consumesLedger: false,
      needsRpc: true,
      // Pending extension_ui questions are answered by the room's next plain
      // message (issue #54). The 提问机 owns the FIFO and its invariants; an
      // unconsumed message (no pending question / another room's question is
      // oldest) falls through to the prompt.
      handle: async (ctx) => {
        if (ctx.text.startsWith("/")) return false;
        const rpc = await ctx.roomRpc();
        return questions.deliver(rpc, ctx.text, ctx.msg, ctx.log);
      },
    },
    {
      name: "prompt",
      preAuth: false,
      consumesLedger: true,
      needsRpc: true,
      // Plain message → prompt (a resolved reply quote is prepended — see
      // withQuotePrefix; command handling above saw the raw text). Pending
      // attachments (issue #66 票1) ride along here and ONLY here: the unique
      // consumption point for the per-room+sender ledger. The ledger is
      // cleared only after the send succeeded — a failed prompt keeps the
      // attachments parked so the retry carries them.
      handle: async (ctx) => {
        const rpc = await ctx.roomRpc();
        try {
          const key = attachmentLedgerKey(ctx.msg.chatId, ctx.msg.userId);
          const carried = pendingAttachments.get(key);
          const pending = carried?.length ? carried : undefined;
          const quoted = ctx.msg.payload.kind === "text" ? ctx.msg.payload.quoted : undefined;
          await rpc.prompt(withAttachmentPrefix(withQuotePrefix(ctx.text, quoted), pending));
          pendingAttachments.delete(key);
        } catch (err) {
          if (err === RPC_ABORT) throw err;
          await sendReply(ctx.msg.chatId, ctx.msg.transport, t("router.prompt.failed", { message: (err as Error).message }));
        }
        return true;
      },
    },
  ];

  return {
    /** 管道阶段表:顺序即执行顺序(导航入口,直测面见 pipeline())。 */
    pipeline(): PipelineStageView[] {
      return stages.map(({ name, preAuth, consumesLedger, needsRpc }) => ({ name, preAuth, consumesLedger, needsRpc }));
    },

    async handleIncoming(msg: ExternalMessage): Promise<void> {
      const text = msg.payload.kind === "text" ? msg.payload.text.trim() : "";
      // 空文本本身直接返回 — 非文本载荷(附件/失败/不支持)必须继续走,
      // 否则就是又一个静默吞消息的点(issue #66 票3)。
      if (msg.payload.kind === "text" && !text) return;

      // Project tagging (spec #34): a mapped room's lines carry its label;
      // everything else (single-project mode, DM, unmapped rooms) resolves to
      // undefined = the plain logger, byte-identical to the old output.
      const label = projectManager.labelForRoom(msg.chatId);
      const log = logger.withLabel(label);

      const payloadSummary = msg.payload.kind === "text" ? text : `[${msg.payload.kind}]`;
      if (isEnabled("debug")) {
        log.debug(`📥 [${msg.transport}] @${msg.username}: ${payloadSummary.slice(0, 500)}${payloadSummary.length > 500 ? "…" : ""}`);
      } else {
        log.info(`📥 [${msg.transport}] @${msg.username}: ${payloadSummary.slice(0, 200)}${payloadSummary.length > 200 ? "…" : ""}`);
      }

      let rpcOnce: Promise<PiRpc> | undefined;
      const ctx: StageContext = {
        msg,
        text,
        log,
        isAuthorized: false,
        isManagementRoom: false,
        multiProject: projectManager.isMultiProject,
        roomRpc: () => {
          // 懒解析(spec #72 票3):pi 进程只为真正需要它的阶段启动——
          // 命令族(附件/pmux 管理命令/登录)不触发 spawn。失败回执后以
          // RPC_ABORT 静默终止管道(通用错误由 standalone 兜底)。
          rpcOnce ??= Promise.resolve(projectManager.getRpcForRoom(msg.chatId)).then((rpc) => {
            // Per-process binding (see RoomBinding above) — resolution time is
            // the natural bind point: project rooms pin, the shared default
            // rpc follows its latest prompter.
            bindReplyTarget(
              rpc,
              { chatId: msg.chatId, transport: msg.transport, username: msg.username },
              projectManager.isProjectRoom(msg.chatId)
            );
            return rpc;
          }).catch((err: unknown) => {
            void sendReply(msg.chatId, msg.transport, t("router.rpc.startFailed", { message: (err as Error).message }));
            throw RPC_ABORT;
          });
          return rpcOnce;
        },
      };

      try {
        for (const stage of stages) {
          if (await stage.handle(ctx)) return;
        }
      } catch (err) {
        if (err !== RPC_ABORT) throw err;
      }
    },

    handleEvent(rawEvent: unknown, rpc: PiRpc): void {
      // The reply target comes from the rpc's own binding — project rpcs are
      // pinned to their room, the default rpc follows its latest prompter.
      const target = bindings.get(rpc)?.replyTarget;

      // Tagged view: a project rpc's events all carry its label; the default
      // rpc's do not (rpc.label is undefined there — spec #34).
      const log = logger.withLabel(rpc.label);

      // extension_error is emitted by the RPC layer but is not part of the
      // typed AgentSessionEvent union — widen for runtime event checking.
      const event = rawEvent as AgentEventView;


      logAgentEvent(event, log);

      // Refresh the queue mirror before any routing decisions — /queue and the
      // stop/interrupt queue warning read this snapshot.
      if (event.type === "queue_update") {
        transient.setMirror(rpc, {
          steering: [...(event.steering ?? [])],
          followUp: [...(event.followUp ?? [])],
        });
      }

      // Extension UI (issue #54): questions are asked in the bound room and
      // parked for the next plain message to answer; notify is presented by
      // level; TUI-only display methods are ignored. 提问机模块自持队列与
      // 超时计时器(spec #99 票3 / issue #104)。
      if (event.type === "extension_ui_request") {
        questions.handle(rawEvent as ExtensionUIRequestView, rpc, target, log);
        return;
      }

      if (event.type === "turn_start") {
        if (target) {
          sendTyping(target.chatId, target.transport).catch(() => {});
        }
        return;
      }

      if (event.type === "turn_end") {
        if (!target) return;
        const turn = buildTurnReply(event.message as AssistantMessage, store.get().hideToolCalls);

        // Reply summary at INFO level — the full conversation is also in pi's
        // session file.
        const replyPreview = turn.text ?? "";
        log.info(`[agent] 回复 @${target.username}: ${replyPreview.slice(0, 500)}${replyPreview.length > 500 ? "…" : ""}`);

        if (turn.text === null) {
          // No content this turn — keep the binding for a follow-up turn
          return;
        }

        for (const chunk of splitMessage(turn.text, 4000)) {
          sendReply(target.chatId, target.transport, chunk).catch(() => {});
        }

        // A completed conversational turn releases unpinned bindings (the
        // shared default rpc) so late events never reply to a stale chat.
        // Pinned project bindings survive (parity with the old roomId path).
        const binding = bindings.get(rpc);
        if (!turn.pendingTools && binding && !binding.pinned) {
          bindings.delete(rpc);
        }
        return;
      }

      // Error visibility (issue #52): auto-retry progress reaches the room so
      // a failing round is never silent. Same guard as turn_start's typing:
      // only with a live binding (logAgentEvent above already logs both).
      if (event.type === "auto_retry_start") {
        if (target) {
          sendReply(
            target.chatId,
            target.transport,
            t("router.retry.inProgress", {
              attempt: event.attempt ?? "?",
              max: event.maxAttempts ?? "?",
              error: summarizeArg(event.errorMessage, 200) || t("common.unknownError"),
            })
          ).catch(() => {});
        }
        return;
      }

      // Retries exhausted: the final error goes to the room; a successful
      // retry (success === true) needs no reply — the turn continues normally.
      if (event.type === "auto_retry_end") {
        if (event.success !== true && target) {
          sendReply(
            target.chatId,
            target.transport,
            t("router.retry.exhausted", { error: summarizeArg(event.finalError, 300) || t("common.unknownError") })
          ).catch(() => {});
        }
        return;
      }

      if (event.type === "extension_error") {
        log.error(`[agent] 扩展错误 (${event.extensionPath ?? "unknown"}): ${event.error ?? "unknown"}`);
        if (target) {
          sendReply(
            target.chatId,
            target.transport,
            `⚠️ 扩展错误 (${event.extensionPath ?? "unknown"}): ${event.error ?? "unknown"}`
          ).catch(() => {});
        }
      }
    },
  };
}

/** Compact one-line summary of a streamed delta event (thinking/text/tool deltas). */
function summarizeStreamDelta(event: {
  assistantMessageEvent?: unknown;
  message?: AssistantMessage;
}): string {
  const e = event.assistantMessageEvent as
    | { type?: string; text?: string; thinking?: string; delta?: string; toolCall?: unknown }
    | undefined;
  if (!e) return "(无增量)";
  if (e.type === "text" && e.text) return e.text.slice(0, 300);
  if (e.type === "thinking" && e.thinking) return `思考: ${e.thinking.slice(0, 300)}`;
  if (e.type === "tool_call") return "工具调用增量";
  if (e.delta) return e.delta.slice(0, 300);
  return `(${e.type ?? "unknown"})`;
}

type AgentEventView = {
        type: string;
        message?: AssistantMessage;
        assistantMessageEvent?: unknown;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        partialResult?: unknown;
        isError?: boolean;
        willRetry?: boolean;
        attempt?: number;
        maxAttempts?: number;
        delayMs?: number;
        errorMessage?: string;
        finalError?: string;
        success?: boolean;
        reason?: string;
        aborted?: boolean;
        level?: unknown;
        name?: string;
        steering?: readonly string[];
        followUp?: readonly string[];
        extensionPath?: string;
        error?: string;
     };

/**
 * Session-replay logging, fully separated from routing: muting it (log
 * level, or removing calls) can never affect reply routing.
 */
function logAgentEvent(event: AgentEventView, log: LeveledLogger): void {
  switch (event.type) {
    case "agent_start":
      log.debug("[agent] run 开始");
      break;
    case "agent_end":
      log.debug(`[agent] run 结束(willRetry: ${event.willRetry ?? false})`);
      break;
    case "agent_settled":
      log.debug("[agent] 已收敛");
      break;
    case "message_start":
      log.debug("[agent] 消息开始");
      break;
    case "message_update":
      // Streaming delta (includes thinking deltas). DEBUG level, truncated.
      log.debug(`[agent] 流式增量: ${summarizeStreamDelta(event)}`);
      break;
    case "message_end":
      log.debug("[agent] 消息完成");
      break;
    case "tool_execution_start":
      log.info(`[agent] 🔧 工具调用: ${event.toolName ?? "?"}(${summarizeArg(event.args)})`);
      break;
    case "tool_execution_update":
      log.debug(`[agent] 工具进度: ${event.toolName ?? "?"} → ${summarizeArg(event.partialResult, 300)}`);
      break;
    case "tool_execution_end":
      log.info(
        `[agent] 工具完成: ${event.toolName ?? "?"} → ${event.isError ? "❌ 错误" : "✅ 成功"} ${summarizeArg(event.result, 500)}`
      );
      break;
    case "compaction_start":
      log.warn(`[agent] 上下文压缩开始(${event.reason ?? "?"})`);
      break;
    case "compaction_end":
      log.warn(
        `[agent] 上下文压缩${event.aborted ? "中止" : "结束"}(${event.reason ?? "?"}${event.errorMessage ? `, 错误: ${event.errorMessage}` : ""})`
      );
      break;
    case "auto_retry_start":
      log.warn(`[agent] 自动重试 ${event.attempt}/${event.maxAttempts}(${event.errorMessage ?? ""})`);
      break;
    case "auto_retry_end":
      log.warn(`[agent] 自动重试结束: ${event.success ? "成功" : `失败(${event.finalError ?? ""})`}`);
      break;
    case "queue_update":
      log.debug(`[agent] 队列更新(steer: ${event.steering?.length ?? 0}, followUp: ${event.followUp?.length ?? 0})`);
      break;
    case "thinking_level_changed":
      log.info(`[agent] 思考级别: ${String(event.level ?? "?")}`);
      break;
    case "session_info_changed":
      log.debug(`[agent] 会话名称: ${event.name ?? "(清除)"}`);
      break;
    case "entry_appended":
      log.debug("[agent] 会话条目已写入");
      break;
    default:
      log.debug(`[agent] 事件: ${event.type}`);
      break;
  }
}

/**
 * 管理房收养(spec #99 票3 / issue #104):maybeInitManagementRoom 迁到
 * space.ts 侧 —— 收养是管理房的空间侧语义,与 startup ensure 的自建路径同址;
 * router 的 managementAdoption 阶段只调用,管理房判定走 config 的
 * managementRoomId 派生、收养写走 adoptManagementRoom。
 */
function summarizeArg(arg: unknown, max = 500): string {
  if (arg === undefined || arg === null) return "";
  if (typeof arg === "string") {
    const s = arg.replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }
  try {
    const s = JSON.stringify(arg);
    if (!s) return "";
    const oneLine = s.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  } catch {
    return String(arg);
  }
}
