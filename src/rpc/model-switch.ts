/**
 * Model switching primitives (issues #119 / #121) — one home for "turn a
 * provider/id ref into a setModel call" and "pick the next link of a
 * fallback chain", shared by the /model command, project presets and the
 * failure-triggered chain. Keeping the resolution rule in one module is the
 * whole point: the /model command, presets and fallbacks must never drift
 * apart on what a model reference means.
 */

import { parseModelRef } from "../config.js";
import type { PiRpc } from "./pi-rpc.js";

/** Apply a model reference to a running process — same semantics as the
 *  /model command argument: `provider/id` applied verbatim; a bare id is
 *  resolved against the available-models list (first id match wins, current
 *  provider keeps priority unimplemented on purpose — same as /model).
 *  Throws with a replyable message when nothing matches. */
export async function setModelByRef(rpc: PiRpc, ref: string): Promise<{ provider: string; id: string }> {
  const parsed = parseModelRef(ref);
  if (parsed) {
    await rpc.requireClient().setModel(parsed.provider, parsed.id);
    return parsed;
  }
  const models = await rpc.requireClient().getAvailableModels();
  const match = models.find((m) => m.id === ref.trim()) ?? models.find((m) => m.id.includes(ref.trim()));
  if (!match) {
    throw new Error(`model not found: ${ref.trim()}`);
  }
  await rpc.requireClient().setModel(match.provider, match.id);
  return { provider: match.provider, id: match.id };
}

const sameModel = (
  a: { provider: string; id: string },
  b: { provider?: string; id?: string } | undefined
): boolean => !!b && a.provider === b.provider && a.id === b.id;

/** Next fallback target (issue #121): the first chain entry AFTER the current
 *  model's position that differs from it; a current model absent from the
 *  chain starts at the head. Later entries only — the chain advances, it
 *  never revisits. Malformed entries (no `provider/id`) are skipped: startup
 *  validation already warned about them. undefined = chain exhausted. */
export function nextFallbackTarget(
  chain: string[],
  current: { provider?: string; id?: string } | undefined
): { provider: string; id: string } | undefined {
  const entries = chain.map(parseModelRef).filter((e): e is { provider: string; id: string } => !!e);
  const currentIndex = current ? entries.findIndex((e) => sameModel(e, current)) : -1;
  for (let i = currentIndex + 1; i < entries.length; i++) {
    if (!sameModel(entries[i], current)) return entries[i];
  }
  return undefined;
}
