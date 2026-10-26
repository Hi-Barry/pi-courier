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
 * 一条围栏行的形状:围栏字符、长度、开围栏的 info string(如 ```ts 的 "ts")。
 */
interface FenceMarker {
  char: "`" | "~";
  len: number;
  info: string;
}

/**
 * 识别一行是否围栏行(行首至多 3 空格缩进的 ``` 或 ~~~)。
 * ``` 行的 info string 里含反引号时按 CommonMark 不算围栏(markdown-it 同判)
 * ——切分的围栏判定必须与渲染器对齐,否则会切在渲染器不认为是边界的地方。
 */
function parseFenceLine(line: string): FenceMarker | null {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
  if (!match) return null;
  const char = match[1][0] as "`" | "~";
  const info = match[2].trim();
  if (char === "`" && info.includes("`")) return null;
  return { char, len: match[1].length, info };
}

/** marker 行能否闭合 open 开的代码块:同字符、长度不小于开围栏、不带 info。 */
function closesFence(open: FenceMarker, marker: FenceMarker): boolean {
  return marker.char === open.char && marker.len >= open.len && marker.info === "";
}

/**
 * 扫描 text[0, end) 结尾处的围栏状态:是否处于未闭合代码块内,及开围栏信息。
 * 块内的围栏行是文本不是围栏,只有块外才开新围栏;闭围栏要求同字符、
 * 长度不小于开围栏且不带 info string(与 markdown-it 一致)。
 */
function scanFences(
  text: string,
  end: number,
): { inFence: false } | { inFence: true; open: FenceMarker; openLineStart: number } {
  let open: FenceMarker | null = null;
  let openLineStart = 0;
  let pos = 0;
  while (pos < end) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : Math.min(nl, end);
    const marker = parseFenceLine(text.slice(pos, lineEnd));
    if (marker) {
      if (open && closesFence(open, marker)) {
        open = null;
      } else if (!open) {
        open = marker;
        openLineStart = pos;
      }
    }
    if (nl === -1 || nl >= end) break;
    pos = nl + 1;
  }
  return open ? { inFence: true, open, openLineStart } : { inFence: false };
}

/**
 * 从 openLineStart 之后找闭围栏行,返回该行行尾偏移(不含换行)。
 * limit 内找不到(含块从未闭合)返回 -1,调用方据此判定"块装不进一段"。
 */
function findFenceCloseEnd(
  text: string,
  open: FenceMarker,
  openLineStart: number,
  limit: number,
): number {
  const firstNl = text.indexOf("\n", openLineStart);
  if (firstNl === -1) return -1;
  let pos = firstNl + 1;
  while (pos < limit && pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const marker = parseFenceLine(text.slice(pos, lineEnd));
    if (marker && closesFence(open, marker)) {
      return lineEnd;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return -1;
}

/**
 * Split long messages into chunks, breaking at newlines when possible.
 *
 * 切分对 markdown 代码围栏感知(issue #223):候选切点落在围栏内部时,
 * 块装得进一段就让切点回退到块前(块在段首则前推到块尾),块整体不拆;
 * 块本身超长装不进一段,才在块内下刀,并补齐两半的围栏让各自渲染合法。
 */
export function splitMessage(text: string, maxLen: number): string[] {
  // maxLen ≤ 0 会让 while 永不推进(死循环)—— 钳到 1(审计工程批 票23)
  const safeMax = Math.max(1, maxLen);
  if (text.length <= safeMax) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= safeMax) {
      chunks.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf("\n", safeMax);
    if (breakAt < safeMax * 0.5) {
      breakAt = remaining.lastIndexOf(" ", safeMax);
    }
    if (breakAt < safeMax * 0.3) {
      breakAt = safeMax;
    }

    // 候选切点处的围栏状态:切进未闭合块内就不能裸切
    const fenceAtCut = scanFences(remaining, breakAt);
    if (fenceAtCut.inFence) {
      const closeEnd = findFenceCloseEnd(
        remaining,
        fenceAtCut.open,
        fenceAtCut.openLineStart,
        fenceAtCut.openLineStart + safeMax,
      );
      if (closeEnd === -1) {
        // 块整体装不进一段:在块内容里下刀,段尾补闭围栏,剩余头保留开围栏
        // 行(语言标记随之复现),两半各自围栏配对(issue #223 方案 B)。
        const lineEnd = remaining.indexOf("\n", fenceAtCut.openLineStart);
        if (lineEnd !== -1) {
          const contentStart = lineEnd + 1;
          let cut = remaining.lastIndexOf("\n", contentStart + safeMax);
          // 切点必须让块内容净推进 ≥1 字符(换行会被 trimStart 吃掉),
          // 否则重建的剩余与上一轮相同,死循环。
          if (cut < contentStart + 2) cut = contentStart + safeMax;
          chunks.push(
            `${remaining.slice(0, cut)}\n${fenceAtCut.open.char.repeat(fenceAtCut.open.len)}`,
          );
          // 剩余头只保留开围栏行本身(语言标记随之复现);若连切点前的
          // 普通前缀一起留下,下一轮会原样重切,死循环。
          remaining =
            remaining.slice(fenceAtCut.openLineStart, contentStart) +
            remaining.slice(cut).trimStart();
          continue;
        }
        // 开围栏行就是文本尾,块内容为空:无从下刀,放行普通切。
      } else {
        // 块装得进一段:切点让路 —— 块前有文本就回退到块前,块在段首就
        // 前推到块尾,让块整体留在同一段(issue #223 方案 A)。
        breakAt = fenceAtCut.openLineStart > 0 ? fenceAtCut.openLineStart : closeEnd;
      }
    }

    chunks.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).trimStart();
  }

  return chunks;
}
