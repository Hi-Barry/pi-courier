/**
 * Pure utility functions for Matrix transport.
 * Extracted for testability — no SDK or network dependencies.
 */
import MarkdownIt from "markdown-it";

// html:false escapes raw HTML (pi output must never inject tags);
// breaks:true keeps chat-style single newlines as <br>;
// linkify turns bare URLs into links.
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

/** Convert markdown to Matrix HTML. Returns plain body (fallback) + formatted HTML. */
export function formatForMatrix(text: string): { body: string; formattedBody?: string } {
  return { body: text, formattedBody: md.render(text).trim() };
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

  // Only process text messages
  const content = event.content;
  if (content?.msgtype !== "m.text" || !content?.body) return "not_text";

  // Ignore edits (we only process original messages)
  if (content["m.new_content"]) return "edit";

  // Skip events from rooms we're not in (cached, no API call)
  if (!joinedRooms.has(roomId)) return "not_joined";

  return null;
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
