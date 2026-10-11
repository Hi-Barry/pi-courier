/**
 * Shared error-surface helpers (audit engineering batch, 票24;与稳定性批
 * 同文件同内容,合并时以任一侧为准)。One place that turns an unknown
 * thrown value into a readable message — every catch / .catch() that logs
 * a rejection goes through here, so non-Error rejections (strings,
 * undefined, numbers) never render as a bare "undefined".
 */

/** Safe message extraction: Error → message, string → as-is, null/undefined
 *  → readable placeholder, anything else → String(). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === undefined || err === null) return "(no error value)";
  return String(err);
}
