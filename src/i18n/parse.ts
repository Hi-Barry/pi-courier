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
