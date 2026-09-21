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
 *
 * Content classification and mention parsing are pure functions at the bottom
 * of this module — their only natural owner is the translator that consumes
 * them (spec #99/#101: formerly matrix-utils.ts).
 */

import type { QuoteCache } from "../quote-cache.js";
import { toExcerpt } from "../quote-cache.js";
import type { ExternalMessage } from "../types.js";
import { type AttachmentStore, type EncryptedMediaFile } from "./attachments.js";

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

// ─── 内容分类与提及解析(纯函数;spec #99/#101 自 matrix-utils.ts 归位)───

/** 媒体事件内容的分类视图(纯结构,来自 event.content)。 */
export interface MediaEventContent {
  /** mxc:// 明文地址(加密附件时可能缺失 — 以 file 为准) */
  url?: string;
  /** 加密附件块(E2EE 房间);与 url 并存时优先 */
  file?: EncryptedMediaFile;
  /** 原始文件名(Element 粘贴发送时通常是 image.png 之类) */
  body?: string;
  /** 事件声明的元信息 — size 仅作超限预检,不作为信任依据 */
  info?: { size?: number; mimetype?: string; w?: number; h?: number };
}

/** 当前按媒体处理的类型全集(票3):m.image/m.file/m.audio/m.video 四种
 *  msgtype 内容同构;m.sticker 是事件类型(内容同构但无 msgtype 字段)。 */
export const MEDIA_MSGTYPES = new Set<string>(["m.image", "m.file", "m.audio", "m.video", "m.sticker"]);

/** Classification of one room message content (issue #66 票1). */
export type MessageContentClassification =
  | { kind: "text" }
  | { kind: "media"; msgtype: string; mxcUrl?: string; encryptedFile?: EncryptedMediaFile; filename: string; sizeHint?: number }
  | { kind: "other"; msgtype: string };

/** 判断内容是否携带媒体载荷(url 明文或 file 加密块)。 */
export function isMediaContent(content: unknown): content is MediaEventContent {
  if (typeof content !== "object" || content === null) return false;
  const c = content as Record<string, unknown>;
  return typeof c.url === "string" || typeof c.file === "object";
}

/** 对一条房间消息内容做分类:文本 / 媒体(带下载所需信息) / 其他。 */
export function classifyMessageContent(content: unknown): MessageContentClassification {
  if (isMediaContent(content)) {
    const c = content as MediaEventContent & { msgtype?: string };
    // m.sticker 事件的内容不带 msgtype(它是事件类型,非 m.room.message);
    // 带媒体载荷却缺 msgtype 的只会是 sticker(m.room.message 必有 msgtype)。
    const msgtype = typeof c.msgtype === "string" && c.msgtype ? c.msgtype : "m.sticker";
    if (MEDIA_MSGTYPES.has(msgtype)) {
      return {
        kind: "media",
        msgtype,
        // 加密附件与明文 url 并存时以加密版优先(票2 裁决)
        ...(c.file ? { encryptedFile: c.file } : { mxcUrl: c.url }),
        filename: c.body ?? "",
        ...(typeof c.info?.size === "number" ? { sizeHint: c.info.size } : {}),
      };
    }
    return { kind: "other", msgtype };
  }
  // 无媒体载荷:m.text / m.emote 走文本管道,其余(如 m.location)是
  // "other" — 由 router 回执礼貌提示(票3 消灭静默吞消息)。
  const msgtype = (content as { msgtype?: string } | null)?.msgtype;
  if (msgtype === "m.text" || msgtype === "m.emote") return { kind: "text" };
  return { kind: "other", msgtype: msgtype || "(unknown)" };
}

/** Extract Matrix username (localpart) from a full MXID like @user:matrix.org */
export function extractUsername(userId: string): string {
  return userId.replace(/^@/, "").replace(/:.*$/, "");
}

/**
 * Check if bot was mentioned, matching either:
 *  - the full MXID `@user:server`
 *  - `@localpart` as a leading-@ word (avoids false-positives on bare names)
 */
export function wasBotMentioned(messageText: string, botUserId: string): boolean {
  if (messageText.includes(botUserId)) return true;
  const localpart = extractUsername(botUserId);
  if (!localpart) return false;
  const re = new RegExp(`@${escapeRegExp(localpart)}\\b`, "i");
  return re.test(messageText);
}

/** Strip bot mention from message text — symmetric with wasBotMentioned */
export function stripBotMention(text: string, botUserId: string): string {
  const localpart = extractUsername(botUserId);
  let out = text.replace(new RegExp(escapeRegExp(botUserId), "g"), "");
  if (localpart) {
    out = out.replace(new RegExp(`@${escapeRegExp(localpart)}\\b`, "gi"), "");
  }
  return out.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
