/**
 * Message router — the core wiring between messenger transports and pi RPC.
 *
 * Shared by the standalone entry (and testable in isolation with a mock transport):
 *   incoming messenger message ──> router ──> RPC command / prompt
 *   agent events ────────────────> router ──> reply back to the messenger
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import { loadConfig, saveConfig } from "../config.js";
import {
  extractTextFromMessage,
  formatToolCalls,
  hasToolCalls,
  splitMessage,
} from "../formatting.js";
import { isEnabled, logger } from "../logger.js";
import type { TransportManager } from "../transports/manager.js";
import type { ExternalMessage, PendingRemoteChat } from "../types.js";
import { handleSlashCommand } from "./command-map.js";
import type { PiRpc } from "./pi-rpc.js";
import type { ProjectManager } from "./project-manager.js";

export interface MessageRouterDeps {
  rpc: PiRpc;
  /** Multi-project routing: resolves the PiRpc for a room (default when unmapped). */
  projectManager: ProjectManager;
  auth: ChallengeAuth;
  transportManager: TransportManager;
  /** Send a text reply to a chat via a transport (errors swallowed by caller) */
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>;
  log: (...args: unknown[]) => void;
  debug: boolean;
}

export interface MessageRouter {
  /** Handle an incoming messenger message */
  handleIncoming(msg: ExternalMessage): Promise<void>;
  /** Handle an agent event (from pi RPC). roomId = the room that owns the
   *  pi process (project rooms); omitted for the shared default Rpc. */
  handleEvent(event: unknown, roomId?: string): void;
  /** Chat that the current/last turn belongs to */
  pendingRemoteChat: PendingRemoteChat | null;
}

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  const { rpc, projectManager, auth, transportManager, sendReply, log, debug } = deps;
  let pendingRemoteChat: PendingRemoteChat | null = null;

  return {
    get pendingRemoteChat(): PendingRemoteChat | null {
      return pendingRemoteChat;
    },

    async handleIncoming(msg: ExternalMessage): Promise<void> {
      pendingRemoteChat = {
        chatId: msg.chatId,
        transport: msg.transport,
        username: msg.username,
        messageId: msg.messageId,
      };

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
          const handled = await auth.handleAdminCommand(
            text,
            msg.chatId,
            msg.userId,
            async (replyText) => sendReply(msg.chatId, msg.transport, replyText),
            msg.transport
          );
          if (handled) return;
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
          auth.enableChannel(msg.chatId, mode);
          await sendReply(msg.chatId, msg.transport, `✅ 本房间已启用 (mode: ${mode})`);
          logger.info(`[auth] 房间 ${msg.chatId} 已由 ${msg.username} 启用 (${mode})`);
          return;
        }
      }

      if (!isAuthorized) return;

      // DM management-room branding: the FIRST admin DM becomes the
      // management room (rename + usage guide, persisted by room ID). All
      // later checks are room-ID driven — project rooms, other 2-person
      // rooms and other users' DMs are never management rooms.
      const adminRaw = (auth.exportConfig().adminUserId ?? "").replace(/^matrix:/, "");
      if (!msg.isGroupChat && msg.userId === adminRaw && !projectManager.isProjectRoom(msg.chatId)) {
        await maybeInitManagementRoom(msg, sendReply, transportManager);
      }
      // Management room = the recorded room ID (managementRooms[0]).
      const isManagementRoom = loadConfig().managementRooms?.[0] === msg.chatId;

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

      // Slash commands → RPC mapping (builtin) or passthrough (extensions/skills/templates)
      if (text.startsWith("/")) {
        try {
          const handled = await handleSlashCommand(text, {
            rpc: roomRpc,
            reply: async (replyText) => sendReply(msg.chatId, msg.transport, replyText),
            projectManager,
            createProjectRoom: async (name, inviteMxid) =>
              transportManager.createProjectRoom(name, inviteMxid),
            setRoomName: async (roomId, name) => transportManager.setRoomName(roomId, name),
            adminUserId: auth.exportConfig().adminUserId,
            chatId: msg.chatId,
            // Management room = the recorded room ID (unique, stable).
            isManagementRoom,
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

    handleEvent(rawEvent: unknown, roomId?: string): void {
      // For project rooms the reply target is the room itself (the pi
      // process is owned by that room). For the shared default Rpc we use
      // pendingRemoteChat as before.
      const target = roomId
        ? { chatId: roomId, transport: "matrix", username: "user" }
        : pendingRemoteChat;

      // extension_error is emitted by the RPC layer but is not part of the
      // typed AgentSessionEvent union — widen for runtime event checking.
      const event = rawEvent as {
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

      // ---- full session replay log (leveled) -----------------------------
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

      if (event.type === "turn_start") {
        if (target) {
          transportManager
            .sendTyping(target.chatId, target.transport)
            .catch(() => {});
        }
        return;
      }

      if (event.type === "turn_end") {
        if (!target) return;
        const message = event.message as AssistantMessage;
        const responseText = extractTextFromMessage(message);
        const toolCallsText = formatToolCalls(message);
        const pendingTools = hasToolCalls(message);
        const cfg = loadConfig();

        // Reply summary at INFO level — the full conversation is also in pi's
        // session file (path logged below).
        logger.info(
          `[agent] 回复 @${target.username}: ${responseText.trim().slice(0, 500)}${responseText.trim().length > 500 ? "…" : ""}`
        );

        const parts: string[] = [];
        const trimmed = responseText.trim();
        if (trimmed) parts.push(trimmed);
        if (toolCallsText && !cfg.hideToolCalls) parts.push(toolCallsText);

        if (parts.length === 0) {
          // No content this turn — keep pendingRemoteChat for a follow-up turn
          return;
        }

        const fullText = parts.join("\n\n");
        const chunks = splitMessage(fullText, 4000);
        for (const chunk of chunks) {
          sendReply(target.chatId, target.transport, chunk).catch(() => {});
        }

        if (!pendingTools && !roomId) {
          pendingRemoteChat = null;
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

/**
 * First-time DM branding: rename the room to "项目管理" and send the usage
 * guide. Idempotent via config.managementRooms so restarts don't re-trigger
 * (and a user-renamed room is never overwritten).
 */
async function maybeInitManagementRoom(
  msg: ExternalMessage,
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>,
  transportManager: TransportManager
): Promise<void> {
  const cfg = loadConfig();
  const rooms = cfg.managementRooms ?? [];
  if (rooms.includes(msg.chatId)) return; // already the management room
  if (rooms.length > 0) return; // a management room already exists — never brand another
  try {
    await transportManager.setRoomName(msg.chatId, "项目管理");
    await sendReply(msg.chatId, msg.transport, MANAGEMENT_ROOM_HELP);
    saveConfig({ ...cfg, managementRooms: [...rooms, msg.chatId] });
    logger.info(`[project] 管理房间已初始化: ${msg.chatId}`);
  } catch {
    // Non-matrix transport or transient failure — skip branding, try again later.
  }
}

const MANAGEMENT_ROOM_HELP = `🏗️ **项目管理房间**

这里是 pi-courier 的管理台。直接发消息 = 在默认项目(~/Projects)里与 pi 对话。

📁 **项目管理**(仅本房间可用)
• \`/pmctl new <名称> <路径>\` — 创建项目(自动建私有房间并拉你进入)
• \`/pmctl list\` — 项目列表
• \`/pmctl show|rm|mv|rename\` — 项目详情/删除/迁移/重命名

⚡ **常用命令**
• \`/stop\` — 停止当前任务
• \`/reload\` — 重启 pi 进程
• \`/help\` — 完整帮助`;
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
