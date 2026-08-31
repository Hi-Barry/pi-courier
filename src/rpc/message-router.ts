/**
 * Message router — the core wiring between messenger transports and pi RPC.
 *
 * Shared by the standalone entry (and testable in isolation with a mock transport):
 *   incoming messenger message ──> router ──> RPC command / prompt
 *   agent events ────────────────> router ──> reply back to the messenger
 */

import * as os from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { handleAdminCommand } from "../auth/admin-commands.js";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import { type ConfigStore, defaultProjectsRoot } from "../config.js";
import {
  extractTextFromMessage,
  formatToolCalls,
  hasToolCalls,
  splitMessage,
} from "../formatting.js";
import { isEnabled, logger } from "../logger.js";
import type { RoomOps } from "../transports/interface.js";
import type { ExternalMessage, ReplyTarget } from "../types.js";
import { handleSlashCommand } from "./command-map.js";
import type { PiRpc } from "./pi-rpc.js";
import type { PmctlController } from "./pmctl-controller.js";
import type { ProjectManager } from "./project-manager.js";

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
}

export interface MessageRouter {
  /** Handle an incoming messenger message */
  handleIncoming(msg: ExternalMessage): Promise<void>;
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
 *  has no replyable content (the binding is kept for the follow-up turn). */
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
  if (parts.length === 0) return { text: null, pendingTools };
  return { text: parts.join("\n\n"), pendingTools };
}

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  const { projectManager, auth, sendReply, sendTyping, roomOps, store, pmctl, managementRoomAdoptionAllowed } = deps;
  const bindings = new WeakMap<PiRpc, RoomBinding>();
  const bindReplyTarget = (rpc: PiRpc, replyTarget: ReplyTarget, pinned: boolean): void => {
    bindings.set(rpc, { pinned, replyTarget });
  };

  return {
    async handleIncoming(msg: ExternalMessage): Promise<void> {
      const text = msg.content.trim();
      if (!text) return;

      if (isEnabled("debug")) {
        logger.debug(`📥 [${msg.transport}] @${msg.username}: ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}`);
      } else {
        logger.info(`📥 [${msg.transport}] @${msg.username}: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
      }

      // Authorization (initiates 6-digit challenge for unknown users in DMs)
      const isAuthorized = await auth.checkAuthorization(
        msg.userId,
        msg.chatId,
        msg.username,
        msg.isGroupChat,
        msg.wasMentioned ?? false,
        async (cId, replyText) => sendReply(cId, msg.transport, replyText),
        msg.transport
      );

      // Bridge admin commands + challenge codes in DMs.
      // /help is reserved for pi (the RPC command help also lists bridge commands).
      if (!msg.isGroupChat && (text.startsWith("/") || /^\d{6}$/.test(text))) {
        const cmdName = text.split(/\s+/)[0].toLowerCase();
        if (!text.startsWith("/") || cmdName !== "/help") {
          const result = handleAdminCommand(auth, {
            text,
            userId: msg.userId,
            transport: msg.transport,
            hideToolCalls: store.get().hideToolCalls,
          });
          if (result.handled) {
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
              }
            }
            return;
          }
        }
      }

      // Group chats: a trusted user can enable the current room without
      // knowing its ID — send "/enable <mode>" right in the room. This must
      // run BEFORE authorization (unenabled rooms are not authorized).
      if (msg.isGroupChat && text.startsWith("/enable")) {
        const isTrusted = auth.isTrustedUser(msg.userId, msg.transport);
        if (isTrusted) {
          const parts = text.split(/\s+/);
          const mode = (parts[1] || "trusted-only") as "all" | "mentions" | "trusted-only";
          if (mode !== "all" && mode !== "mentions" && mode !== "trusted-only") {
            await sendReply(msg.chatId, msg.transport, "用法: /enable <all|mentions|trusted-only>(本房间)");
            return;
          }
          // "all" responds to everyone — admin-only. Trusted users may only
          // request trusted-only / mentions.
          if (mode === "all" && !auth.isAdminUser(msg.userId, msg.transport)) {
            await sendReply(msg.chatId, msg.transport, "❌ all 模式仅管理员可用(可采用 trusted-only 或 mentions)");
            return;
          }
          auth.enableChannel(msg.chatId, mode);
          store.update({ auth: auth.exportConfig() });
          await sendReply(msg.chatId, msg.transport, `✅ 本房间已启用 (mode: ${mode})`);
          logger.info(`[auth] 房间 ${msg.chatId} 已由 ${msg.username} 启用 (${mode})`);
          return;
        }
      }

      if (!isAuthorized) return;

      // /multiproject — switch single/multi project mode. Config read/write;
      // takes effect on restart. Trusted users may toggle.
      if (text.startsWith("/multiproject")) {
        const isTrusted = auth.isTrustedUser(msg.userId, msg.transport);
        if (!isTrusted) {
          await sendReply(msg.chatId, msg.transport, "❌ 无权限(仅信任用户可切换多工程模式)");
          return;
        }
        const action = text.split(/\s+/)[1]?.toLowerCase() ?? "";
        const current = projectManager.isMultiProject ? "多工程模式(开启)" : "单工程模式(关闭)";
        if (action === "on" || action === "off") {
          const next = action === "on";
          if (next === projectManager.isMultiProject) {
            await sendReply(msg.chatId, msg.transport, `当前已是${current},无需切换。`);
            return;
          }
          store.update({ multiProject: next });
          await sendReply(
            msg.chatId,
            msg.transport,
            `✅ 已${next ? "开启" : "关闭"}多工程模式。\n重启生效:运行 \`pi-courier restart\`(${next ? "重启后将启用管理房间/项目房间 /pmctl" : "重启后所有房间直接连默认 pi"})。`
          );
        } else {
          await sendReply(
            msg.chatId,
            msg.transport,
            `当前: ${current}\n\n用法:\n/multiproject on  — 开启多工程(重启生效)\n/multiproject off — 关闭多工程,回到单工程(重启生效)`
          );
        }
        return;
      }

      // Management room = the FIRST accepted message in a private (≤2 person)
      // non-project room fixes that room's ID (managementRooms[0]). Works for
      // BOTH challenge-code pairing and config-driven trusted users. Only in
      // multi-project mode.
      const multiProject = projectManager.isMultiProject;
      if (
        multiProject &&
        roomOps &&
        (managementRoomAdoptionAllowed?.() ?? true) &&
        !store.get().managementRooms?.[0] &&
        !msg.isGroupChat &&
        !projectManager.isProjectRoom(msg.chatId)
      ) {
        await maybeInitManagementRoom(msg, sendReply, roomOps, store);
      }
      const isManagementRoom = multiProject && (store.get().managementRooms?.[0] ?? "") === msg.chatId;

      // Resolve the pi process for this room: project rooms get their own
      // (lazily started), everything else (DM) uses the shared default Rpc.
      let roomRpc: PiRpc;
      try {
        roomRpc = await projectManager.getRpcForRoom(msg.chatId);
      } catch (err) {
        await sendReply(
          msg.chatId,
          msg.transport,
          `❌ 无法启动 pi 进程: ${(err as Error).message}`
        );
        return;
      }

      // Bind this room to the pi process that will serve it (per-process
      // binding — see RoomBinding above). Binding unconditionally is safe:
      // a project-room prompt only ever re-pins the project rpc to its own
      // room, so the default rpc's DM binding is untouched.
      bindReplyTarget(
        roomRpc,
        { chatId: msg.chatId, transport: msg.transport, username: msg.username },
        projectManager.isProjectRoom(msg.chatId)
      );

      // /pmctl family first: gates + actions live in the controller. The
      // invite target arrives pre-resolved (transport-native MXID).
      if (await pmctl.handle(text, { chatId: msg.chatId, senderMxid: msg.userId, isManagementRoom }, async (replyText) => sendReply(msg.chatId, msg.transport, replyText))) {
        return;
      }

      // Slash commands → RPC mapping (builtin) or passthrough (extensions/skills/templates)
      if (text.startsWith("/")) {
        try {
          const handled = await handleSlashCommand(text, {
            rpc: roomRpc,
            reply: async (replyText) => sendReply(msg.chatId, msg.transport, replyText),
          });
          if (handled) return;
        } catch (err) {
          await sendReply(msg.chatId, msg.transport, `❌ 命令执行失败: ${(err as Error).message}`);
          return;
        }
      }

      // Plain message → prompt
      try {
        await roomRpc.prompt(text);
      } catch (err) {
        await sendReply(msg.chatId, msg.transport, `❌ 无法发送给 pi: ${(err as Error).message}`);
      }
    },

    handleEvent(rawEvent: unknown, rpc: PiRpc): void {
      // The reply target comes from the rpc's own binding — project rpcs are
      // pinned to their room, the default rpc follows its latest prompter.
      const target = bindings.get(rpc)?.replyTarget;

      // extension_error is emitted by the RPC layer but is not part of the
      // typed AgentSessionEvent union — widen for runtime event checking.
      const event = rawEvent as AgentEventView;


      logAgentEvent(event);

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
        logger.info(`[agent] 回复 @${target.username}: ${replyPreview.slice(0, 500)}${replyPreview.length > 500 ? "…" : ""}`);

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

      if (event.type === "extension_error") {
        logger.error(`[agent] 扩展错误 (${event.extensionPath ?? "unknown"}): ${event.error ?? "unknown"}`);
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
function logAgentEvent(event: AgentEventView): void {
  switch (event.type) {
    case "agent_start":
      logger.debug("[agent] run 开始");
      break;
    case "agent_end":
      logger.debug(`[agent] run 结束(willRetry: ${event.willRetry ?? false})`);
      break;
    case "agent_settled":
      logger.debug("[agent] 已收敛");
      break;
    case "message_start":
      logger.debug("[agent] 消息开始");
      break;
    case "message_update":
      // Streaming delta (includes thinking deltas). DEBUG level, truncated.
      logger.debug(`[agent] 流式增量: ${summarizeStreamDelta(event)}`);
      break;
    case "message_end":
      logger.debug("[agent] 消息完成");
      break;
    case "tool_execution_start":
      logger.info(`[agent] 🔧 工具调用: ${event.toolName ?? "?"}(${summarizeArg(event.args)})`);
      break;
    case "tool_execution_update":
      logger.debug(`[agent] 工具进度: ${event.toolName ?? "?"} → ${summarizeArg(event.partialResult, 300)}`);
      break;
    case "tool_execution_end":
      logger.info(
        `[agent] 工具完成: ${event.toolName ?? "?"} → ${event.isError ? "❌ 错误" : "✅ 成功"} ${summarizeArg(event.result, 500)}`
      );
      break;
    case "compaction_start":
      logger.warn(`[agent] 上下文压缩开始(${event.reason ?? "?"})`);
      break;
    case "compaction_end":
      logger.warn(
        `[agent] 上下文压缩${event.aborted ? "中止" : "结束"}(${event.reason ?? "?"}${event.errorMessage ? `, 错误: ${event.errorMessage}` : ""})`
      );
      break;
    case "auto_retry_start":
      logger.warn(`[agent] 自动重试 ${event.attempt}/${event.maxAttempts}(${event.errorMessage ?? ""})`);
      break;
    case "auto_retry_end":
      logger.warn(`[agent] 自动重试结束: ${event.success ? "成功" : `失败(${event.finalError ?? ""})`}`);
      break;
    case "queue_update":
      logger.debug(`[agent] 队列更新(steer: ${event.steering?.length ?? 0}, followUp: ${event.followUp?.length ?? 0})`);
      break;
    case "thinking_level_changed":
      logger.info(`[agent] 思考级别: ${String(event.level ?? "?")}`);
      break;
    case "session_info_changed":
      logger.debug(`[agent] 会话名称: ${event.name ?? "(清除)"}`);
      break;
    case "entry_appended":
      logger.debug("[agent] 会话条目已写入");
      break;
    default:
      logger.debug(`[agent] 事件: ${event.type}`);
      break;
  }
}

/**
 * Build the management-room guide, labelled with the instance name, the bot
 * account and the working directory — so when the bridge runs on several
 * machines you can tell which project belongs to which box/account.
 * Exported for the bot-created management room (space ensure) — both entry
 * points must present the same guide.
 */
export function buildManagementRoomHelp(
  instanceName: string,
  botAccount: string,
  workdir: string
): string {
  return (
    `🏗️ **项目管理房间**（${instanceName}）\n\n` +
    `• bot 账号: \`${botAccount}\`\n` +
    `• 默认工作目录: \`${workdir}\`\n\n` +
    `这里是本实例的管理台。直接发消息 = 在默认项目(${workdir})里与 pi 对话。\n\n` +
    `📁 **项目管理**(仅本房间可用)\n` +
    `• \`/pmctl new <名称> [路径]\` — 创建项目(自动建私有房间并拉你进入)\n` +
    `• \`/pmctl list\` — 项目列表\n` +
    `• \`/pmctl show|rm|mv|rename\` — 项目详情/删除/迁移/重命名\n\n` +
    `⚡ **常用命令**\n` +
    `• \`/stop\` — 停止当前任务\n` +
    `• \`/reload\` — 重启 pi 进程\n` +
    `• \`/help\` — 完整帮助`
  );
}

/** Management-room display name — shared by adoption branding and the
 *  bot-created space path so the two cannot drift. */
export function managementRoomName(instanceName: string): string {
  return `项目管理（${instanceName}）`;
}

/**
 * First-time branding: rename the room to "项目管理(<instance>)" and send the
 * usage guide. Idempotent via config.managementRooms so restarts don't
 * re-trigger (and a user-renamed room is never overwritten).
 */
async function maybeInitManagementRoom(
  msg: ExternalMessage,
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>,
  roomOps: RoomOps,
  store: ConfigStore
): Promise<void> {
  const cfg = store.get();
  const rooms = cfg.managementRooms ?? [];
  if (rooms.includes(msg.chatId)) return; // already the management room
  if (rooms.length > 0) return; // a management room already exists — never brand another
  try {
    const instanceName = cfg.instanceName ?? os.hostname();
    const botAccount = roomOps.getBotUserId() ?? "(未知)";
    const workdir = cfg.workdir ?? defaultProjectsRoot();
    const roomName = managementRoomName(instanceName);
    await roomOps.setRoomName(msg.chatId, roomName);
    await sendReply(msg.chatId, msg.transport, buildManagementRoomHelp(instanceName, botAccount, workdir));
    store.update({ managementRooms: [...rooms, msg.chatId] });
    logger.info(`[project] 管理房间已初始化: ${msg.chatId} (${roomName})`);
  } catch {
    // Non-matrix transport or transient failure — skip branding, try again later.
  }
}
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
