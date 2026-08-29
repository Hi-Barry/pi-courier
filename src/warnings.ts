/**
 * Shared load-time warning suppression for both entries (cli / standalone).
 *
 * Filters the known `util._extend` deprecation warning emitted by some
 * transport dependencies — it pollutes interactive output. Each entry calls
 * this at module load; the patch is idempotent (a second call is a no-op),
 * so cli's dynamic import of standalone won't double-wrap emitWarning.
 */

let patched = false;

export function suppressKnownWarnings(): void {
  if (patched) return;
  patched = true;
  const orig = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const msg = typeof warning === "string" ? warning : (warning as Error | undefined)?.message ?? "";
    if (msg.includes("util._extend")) return;
    (orig as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
}
