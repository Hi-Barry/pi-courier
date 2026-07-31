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
