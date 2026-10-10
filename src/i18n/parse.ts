/**
 * Language-sensitive INPUT parsing (issue #83) — the cancel keyword.
 *
 * 「取消」 is not just display copy, it is the input protocol for backing out
 * of pending extension-ui questions and login flows. Both spellings are
 * accepted in EVERY locale: an existing zh user who switches the deployment
 * to en keeps their habit, and en users never have to learn the zh word.
 */

/** True when the trimmed message is a cancel keyword (取消 / cancel, any case). */
export function isCancelInput(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "取消" || trimmed.toLowerCase() === "cancel";
}

/**
 * 离线积压征询的应答词(issue #113),与 isCancelInput 同一套双语约定:
 * 每种拼写在所有语言下都认,提示文案只展示当前语言的那个。
 * 「执行」= 按序处理积压;「忽略」= 丢弃(取消词也算忽略 —— 想反悔的人
 * 的第一反应就是取消)。
 */

/** True when the trimmed message approves the pending backlog (执行 / execute / run). */
export function isExecuteInput(text: string): boolean {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  return trimmed === "执行" || lower === "execute" || lower === "run";
}

/** True when the trimmed message discards the pending backlog (忽略 / ignore / discard / cancel words). */
export function isIgnoreInput(text: string): boolean {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  return trimmed === "忽略" || lower === "ignore" || lower === "discard" || isCancelInput(trimmed);
}

