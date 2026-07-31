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

      if (debug) log(`📥 [${msg.transport}] @${msg.username}: ${text.slice(0, 200)}`);

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
        extensionPath?: string;
        error?: string;
      };

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
        if (pendingRemoteChat) {
          sendReply(
            pendingRemoteChat.chatId,
            pendingRemoteChat.transport,
            `⚠️ 扩展错误 (${event.extensionPath ?? "unknown"}): ${event.error ?? "unknown"}`
          ).catch(() => {});
        }
        log("⚠️ extension_error:", event.extensionPath, event.error);
      }
    },
  };
}
