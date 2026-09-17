/**
 * Pure utility functions for Matrix transport.
 * Extracted for testability — no SDK or network dependencies.
 */
import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";

// html:false escapes raw HTML (pi output must never inject tags);
// breaks:true keeps chat-style single newlines as <br>;
// linkify turns bare URLs into links.
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

/** Convert markdown to Matrix HTML. Returns plain body (fallback) + formatted HTML. */
export function formatForMatrix(text: string): { body: string; formattedBody?: string } {
  return { body: text, formattedBody: md.render(text).trim() };
}

// ─── 附件输入(issue #66)────────────────────────────────────────

/** 加密附件块(EncryptedFileInfo)的最小结构视图 — 与 matrix-bot-sdk 的
 *  MessageEvent.EncryptedFile 结构兼容,避免本模块依赖 SDK。 */
export interface EncryptedMediaFile {
  url: string;
  key: { k: string };
  iv: string;
  hashes: { sha256: string };
  v?: string;
}

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

/**
 * 文件名消毒(issue #66 票1):防路径穿越/分隔符注入,输出确定性的
 * "<mxc mediaId 哈希前缀>-<安全化原名>"。body 为空时回退 "file"。
 */
export function sanitizeMediaFilename(body: string | undefined, mxcUrl: string): string {
  const hash = createHash("sha256").update(mxcUrl).digest("hex").slice(0, 12);
  const base = (body ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, "") // 控制字符
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "") // 防 ".."/"."(必须先 trim —— " .." 形式会绕过前导点剥离,fast-check 反例)
    .replace(/\.{2,}/g, ".") // 折叠连续点:".." 永不出现在文件名里(fast-check 反例 "!..")
    .trim();
  const safe = cleaned.length > 0 ? cleaned : "file";
  return `${hash}-${safe.slice(0, 150)}`;
}

/**
 * Determine whether to skip a Matrix room event before processing.
 * Returns a reason string if the event should be skipped, or null if it should be processed.
 */
export function shouldSkipEvent(
  event: { sender?: string; origin_server_ts?: number; content?: any },
  botUserId: string,
  connectedAt: number,
  joinedRooms: Set<string>,
  roomId: string
): string | null {
  // Ignore own messages
  if (event.sender === botUserId) return "own_message";

  // Skip events from before this connection (stale replay from initial sync)
  const eventTs = event.origin_server_ts || 0;
  if (eventTs < connectedAt) return "stale";

  // m.notice stays silent in every branch (issue #66 票3: the ONE deliberate
  // silence — other bots/services' notices must not trigger receipts or the
  // bot loops).
  if (event.content?.msgtype === "m.notice") return "notice";

  // Media events (issue #66) flow through the attachment path. Everything
  // else with a body flows on too: m.text/m.emote are classified as text,
  // exotic msgtypes (m.location…) reach the router's polite receipt — the
  // filter itself no longer silently drops them (票3). Only body-less
  // messages and edits stay skipped here.
  if (!isMediaEventContent(event.content)) {
    const content = event.content;
    if (!content?.body) return "not_text";

    // Ignore edits (we only process original messages)
    if (content["m.new_content"]) return "edit";
  }

  // Skip events from rooms we're not in (cached, no API call)
  if (!joinedRooms.has(roomId)) return "not_joined";

  return null;
}

/** shouldSkipEvent 用的窄判别:内容带媒体载荷即视为媒体事件(不查白名单 —
 *  白名单归类由 classifyMessageContent 负责,m.file 等在票3 前落入 "other")。 */
function isMediaEventContent(content: unknown): boolean {
  return isMediaContent(content) && typeof (content as MediaEventContent & { msgtype?: string }).msgtype === "string";
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

/** A room is a group chat when it holds more than two members (bot + one other = DM). */
export function isGroupChatRoom(memberCount: number): boolean {
  return memberCount > 2;
}

/** Whether to post the one-time join hint: a multi-user room that is not yet enabled. */
export function shouldPostJoinHint(memberCount: number, isEnabled: boolean): boolean {
  return isGroupChatRoom(memberCount) && !isEnabled;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
