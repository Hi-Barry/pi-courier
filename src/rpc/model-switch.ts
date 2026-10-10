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

/** 触发自动切换所需的连续彻底失败轮数(stopReason=error,pi 的 auto-retry
 *  已耗尽或未开)。 */
export const MODEL_FALLBACK_THRESHOLD = 2;

/** 降级链连败记账(issue #121):每进程一份,内存即权威 —— 重启归零可接受
 *  (重启本身常已排除瞬时故障)。阈值判定与「链耗尽只提示一次」都在这里;
 *  链解析、切换与回执 I/O 归调用方。成功(或任何非 error)轮 clear() 清零
 *  并重武装耗尽提示。 */
export class FallbackStreak {
  private runs = new WeakMap<PiRpc, { failures: number; exhaustedNotified: boolean }>();

  /** 失败轮喂入:达到阈值 → true(记账已重置,该推进下一跳了);未到 →
   *  false(保持静默,继续数)。 */
  recordFailure(rpc: PiRpc): boolean {
    const run = this.runs.get(rpc) ?? { failures: 0, exhaustedNotified: false };
    run.failures += 1;
    this.runs.set(rpc, run);
    if (run.failures < MODEL_FALLBACK_THRESHOLD) return false;
    run.failures = 0; // 重新武装:切换后的新模型要再连败 N 轮才推进下一跳
    return true;
  }

  /** 链已走完时调用:true = 该发一次耗尽提示(此后同一条 streak 静默)。 */
  markExhaustedNotified(rpc: PiRpc): boolean {
    const run = this.runs.get(rpc);
    if (!run || run.exhaustedNotified) return false;
    run.exhaustedNotified = true;
    return true;
  }

  /** 成功(或任何非 error)轮:整条 streak 清零,耗尽提示重新武装。 */
  clear(rpc: PiRpc): void {
    this.runs.delete(rpc);
  }
}
