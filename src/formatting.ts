import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Extract text from assistant message.
 */
export function extractTextFromMessage(message: AssistantMessage): string {
  const textParts = message.content.filter((part) => part.type === "text");
  return textParts.map((part: any) => part.text).join("\n");
}

/**
 * Check if assistant message contains tool calls (more turns will follow).
 */
export function hasToolCalls(message: AssistantMessage): boolean {
  return message.content.some((part) => part.type === "toolCall");
}

/**
 * Format tool call summaries for the remote user.
 */
export function formatToolCalls(message: AssistantMessage): string {
  const toolCalls = message.content.filter((part) => part.type === "toolCall");
  if (toolCalls.length === 0) return "";
  return toolCalls
    .map((tc: any) => {
      const name = tc.name || "tool";
      const args = tc.arguments || {};

      const argPairs = Object.entries(args)
        .map(([k, v]) => {
          const valStr = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${truncate(valStr, 50)}`;
        })
        .join(", ");

      // Wrap the tool name in backticks so messengers render it as inline
      // code — preserves snake_case readability across Telegram (which would
      // otherwise have to backslash-escape underscores), Discord, Slack,
      // Matrix, and WhatsApp uniformly.
      return argPairs ? `🔧 \`${name}\` (${argPairs})` : `🔧 \`${name}\``;
    })
    .join("\n");
}

/**
 * Collapse to one line and bound the length, "…" marking truncation — the
 * single home of the "queue entry / excerpt / arg summary" shape. Distinct
 * from truncate() below: that one bounds a string as-is (no whitespace
 * collapse, ASCII dots); this one is for showing arbitrary multi-line text
 * as one bounded chat line. The router's audit detail deliberately does NOT
 * use this (it truncates without an ellipsis marker — audit lines stay raw).
 */
export function truncateLine(text: string, max = 120): string {
  // RPC 队列里的元素形状不可信(上游可能给非字符串),防御性归一,
  // 不让截断工具成为崩溃点(审计稳定性批 票17)。
  const raw = typeof text === "string" ? text : String(text);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Truncate string to max length with ellipsis.
 */
export function truncate(str: string, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Split long messages into chunks, breaking at newlines when possible.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen * 0.5) {
      breakAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (breakAt < maxLen * 0.3) {
      breakAt = maxLen;
    }

    chunks.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).trimStart();
  }

  return chunks;
}
