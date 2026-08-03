/**
 * Message router — the core wiring between messenger transports and pi RPC.
 *
 * Shared by the standalone entry (and testable in isolation with a mock transport):
 *   incoming messenger message ──> router ──> RPC command / prompt
 *   agent events ────────────────> router ──> reply back to the messenger
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import { loadConfig } from "../config.js";
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

export interface MessageRouterDeps {
  rpc: PiRpc;
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
  /** Handle an agent event (from pi RPC) */
  handleEvent(event: unknown): void;
  /** Chat that the current/last turn belongs to */
  pendingRemoteChat: PendingRemoteChat | null;
}

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  const { rpc, auth, transportManager, sendReply, log, debug } = deps;
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

      if (!isAuthorized) return;

      // Slash commands → RPC mapping (builtin) or passthrough (extensions/skills/templates)
      if (text.startsWith("/")) {
        const handled = await handleSlashCommand(text, {
          rpc,
          reply: async (replyText) => sendReply(msg.chatId, msg.transport, replyText),
        });
        if (handled) return;
      }

      // Plain message → prompt
      try {
        await rpc.prompt(text);
      } catch (err) {
        await sendReply(msg.chatId, msg.transport, `❌ 无法发送给 pi: ${(err as Error).message}`);
      }
    },

    handleEvent(rawEvent: unknown): void {
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
        if (pendingRemoteChat) {
          transportManager
            .sendTyping(pendingRemoteChat.chatId, pendingRemoteChat.transport)
            .catch(() => {});
        }
        return;
      }

      if (event.type === "turn_end") {
        if (!pendingRemoteChat) return;
        const message = event.message as AssistantMessage;
        const responseText = extractTextFromMessage(message);
        const toolCallsText = formatToolCalls(message);
        const pendingTools = hasToolCalls(message);
        const cfg = loadConfig();

        // Reply summary at INFO level — the full conversation is also in pi's
        // session file (path logged below).
        logger.info(
          `[agent] 回复 @${pendingRemoteChat.username}: ${responseText.trim().slice(0, 500)}${responseText.trim().length > 500 ? "…" : ""}`
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
          sendReply(pendingRemoteChat.chatId, pendingRemoteChat.transport, chunk).catch(() => {});
        }

        if (!pendingTools) {
          pendingRemoteChat = null;
        }
        return;
      }

      if (event.type === "extension_error") {
        logger.error(`[agent] 扩展错误 (${event.extensionPath ?? "unknown"}): ${event.error ?? "unknown"}`);
        if (pendingRemoteChat) {
          sendReply(
            pendingRemoteChat.chatId,
            pendingRemoteChat.transport,
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

/** One-line, bounded representation of a tool argument/result payload. */
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
