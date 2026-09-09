/**
 * Matrix event translator (spec #72 票2/C2) — the deep module that turns a
 * decrypted SDK room event into the transport-agnostic ExternalMessage and
 * its side effects (attachment persistence). Everything that used to live as
 * branch logic inside the transport's message handler is implementation here;
 * the interface is one function per event.
 *
 * Ports (accepted, never created): the per-room quote cache, the member-count
 * resolver and the attachment store are transport state injected by the
 * composition root. No SDK types cross this module — the event is read
 * structurally, so tests drive it without a Matrix connection.
 */

import type { QuoteCache } from "../quote-cache.js";
import { toExcerpt } from "../quote-cache.js";
import type { ExternalMessage } from "../types.js";
import type { AttachmentStore } from "./attachments.js";
import {
  classifyMessageContent,
  type EncryptedMediaFile,
  extractUsername,
  stripBotMention,
  wasBotMentioned,
} from "./matrix-utils.js";

export interface EventTranslatorPorts {
  /** Transport identity for the ExternalMessage envelope ("matrix"). */
  transportType: string;
  /** Bot MXID — mention detection and stripping for group text messages. */
  botUserId: string;
  /** Per-room quote excerpt ring cache (transport-owned state). */
  quoteCache: QuoteCache;
  /** Cached member-count resolution; DM default on failure (transport-owned). */
  resolveIsGroupChat: (roomId: string) => Promise<boolean>;
  /** Attachment persistence; absent = media events keep the legacy
   *  skip-silently behaviour (bare transports in tests). */
  attachments?: AttachmentStore;
}

export interface TranslatedEvent {
  /** Forward to the message router when present. */
  message?: ExternalMessage;
  /** Info-level transport log line (attachment saved). */
  info?: string;
  /** Warn-level transport log line (attachment failed). */
  warn?: string;
}

export function createEventTranslator(ports: EventTranslatorPorts) {
  const { transportType, botUserId, quoteCache, resolveIsGroupChat, attachments } = ports;

  /** The common ExternalMessage envelope fields (no mention stripping on
   *  non-text payloads — filenames cannot carry a meaningful mention). */
  function envelope(roomId: string, event: any, isGroupChat: boolean) {
    return {
      chatId: roomId,
      transport: transportType,
      username: extractUsername(event.sender),
      userId: event.sender,
      timestamp: new Date(event.origin_server_ts || Date.now()),
      messageId: event.event_id,
      isGroupChat,
      wasMentioned: false,
    };
  }

  async function translate(roomId: string, event: any): Promise<TranslatedEvent> {
    const classified = classifyMessageContent(event.content);
    if (classified.kind === "media") {
      // No store wired (bare transport in tests): legacy skip-silently.
      if (!attachments) return {};
      return translateMedia(roomId, event, classified);
    }
    if (classified.kind === "other") {
      // 非文本且无媒体载荷(如 m.location)不再静默 — 转发给 router,
      // 由它过授权门后回执礼貌提示(issue #66 票3)。
      return {
        message: {
          ...envelope(roomId, event, await resolveIsGroupChat(roomId)),
          payload: { kind: "unsupported", msgtype: classified.msgtype },
        },
      };
    }

    // ── text pipeline ──────────────────────────────────────────────
    const chatId = roomId;
    const userId = event.sender; // e.g. @user:matrix.org
    const username = extractUsername(userId);
    const messageText = event.content.body;
    const messageId = event.event_id;
    const isGroupChat = await resolveIsGroupChat(roomId);

    const wasMentioned = isGroupChat ? wasBotMentioned(messageText, botUserId) : false;
    const cleanContent = wasMentioned && botUserId
      ? stripBotMention(messageText, botUserId)
      : messageText;

    // Reply quotes (issue #56 票5): record this message first, then resolve a
    // m.relates_to reply target against the per-room ring cache. A miss (old
    // message from before this process started, unknown event) is a silent
    // downgrade — the message flows on without a quote. E2EE rooms arrive
    // decrypted, so the body reads the same as plaintext.
    quoteCache.record(roomId, messageId, {
      username,
      excerpt: toExcerpt(cleanContent ?? ""),
    });
    const replyTargetEventId: string | undefined = event.content?.["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    const quoted = replyTargetEventId
      ? quoteCache.lookup(roomId, replyTargetEventId)
      : undefined;

    if (!cleanContent) return {};
    return {
      message: {
        chatId,
        transport: transportType,
        username,
        userId,
        timestamp: new Date(event.origin_server_ts || Date.now()),
        messageId,
        isGroupChat,
        wasMentioned,
        payload: {
          kind: "text",
          text: cleanContent,
          ...(quoted && { quoted }),
        },
      },
    };
  }

  /** Media intake (issue #66 票1): download → save → forward the saved path
   *  (or the failure reason as mediaError). Receipts and the pending-attachment
   *  ledger are ROUTER policy — this module only persists and reports. */
  async function translateMedia(roomId: string, event: any, media: { mxcUrl?: string; encryptedFile?: EncryptedMediaFile; filename: string; sizeHint?: number }): Promise<TranslatedEvent> {
    const base = envelope(roomId, event, await resolveIsGroupChat(roomId));
    const username = base.username;
    try {
      const saved = await attachments!.save(base.chatId, {
        mxcUrl: media.mxcUrl,
        encryptedFile: media.encryptedFile,
        body: media.filename,
        sizeHint: media.sizeHint,
      });
      return {
        info: `[Matrix] 附件已保存: ${saved.path}(${username})`,
        message: { ...base, payload: { kind: "media", saved: [saved] } },
      };
    } catch (err) {
      return {
        warn: `[Matrix] 附件处理失败(${username}): ${(err as Error).message}`,
        message: { ...base, payload: { kind: "mediaError", reason: (err as Error).message } },
      };
    }
  }

  return { translate };
}
