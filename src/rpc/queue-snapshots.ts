/**
 * Cross-process queue snapshot persistence (issue #115 stage 2) — the disk
 * half of the in-memory queue mirror. Every mirror change (queue_update
 * refreshes, /stop pin-to-empty, restart invalidation) lands here through
 * the RpcTransientState mirror-changed hook, so the file always says what a
 * live process still owes; after a service-level restart (systemd/machine)
 * the loaded entries become one "never ran" notice per project room.
 *
 * Conservative route (per the ticket): only project rooms are persisted —
 * their room↔process mapping lives in config and survives restarts. The
 * single-project default process binds to whatever DM is live, so restoring
 * its target could deliver the notice into a stale room; that degradation
 * is accepted, not a bug.
 */

import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";
import { logger } from "../logger.js";
import { JsonStateFile } from "../state/json-file.js";
import { clearedQueuesView, type QueueSnapshot, queueTotal } from "./command-map.js";

/** Disk shape of one entry — an array, not a keyed map, so room ids stay
 *  values (same reasoning as the attachments ledger). */
export interface QueueSnapshotEntry {
  roomId: string;
  /** Epoch ms of the last refresh — diagnostics only (log staleness). */
  at: number;
  snapshot: QueueSnapshot;
}

export class QueueSnapshotStore {
  constructor(private readonly file: JsonStateFile<QueueSnapshotEntry[]>) {}

  /** Replace-or-insert the entry for a room. Empty snapshots remove the
   *  entry: the queue no longer exists in any live process, and the next
   *  service start must not resurrect it as a loss report. */
  save(roomId: string, snapshot: QueueSnapshot): void {
    if (queueTotal(snapshot) === 0) {
      this.remove(roomId);
      return;
    }
    const rest = this.load().filter((entry) => entry.roomId !== roomId);
    this.file.save([...rest, { roomId, at: Date.now(), snapshot }]);
  }

  remove(roomId: string): void {
    const all = this.load();
    const rest = all.filter((entry) => entry.roomId !== roomId);
    // Skip the write when nothing changed — the common case is "no entry".
    if (rest.length === all.length) return;
    this.file.save(rest);
  }

  /** Entries usable as loss reports: structurally sound and non-empty,
   *  with queue elements coerced to the QueueSnapshot string-element
   *  invariant. Structural junk is skipped silently (same degradation
   *  contract as the attachments ledger); type-junk elements inside an
   *  otherwise sound entry are coerced (same contract as truncateLine,
   *  审计批2 票17) instead of dropping the whole loss report. */
  loadValid(): QueueSnapshotEntry[] {
    const out: QueueSnapshotEntry[] = [];
    for (const entry of this.load()) {
      const normalized = normalizeEntry(entry);
      if (normalized) out.push(normalized);
    }
    return out;
  }

  /** Consume-once support: startup sends each notice best-effort and then
   *  wipes the file — a snapshot reports a dead process; retrying against a
   *  deleted room forever would be worse than one missed notice. */
  clear(): void {
    this.file.save([]);
  }

  private load(): QueueSnapshotEntry[] {
    const raw = this.file.load();
    return Array.isArray(raw) ? raw : [];
  }
}

/** Coerce queue elements to string (审计批2 票17 的处置哲学:队列元素形状
 *  不可信,强转归一而非拒绝——个别元素类型坏不应丢整条 loss report)。
 *  强转不了的元素(Object.create(null) 这类)单独剔除,不连累其余。 */
function coerceQueueElements(list: unknown[]): string[] {
  const out: string[] = [];
  for (const m of list) {
    if (typeof m === "string") {
      out.push(m);
      continue;
    }
    try {
      out.push(String(m));
    } catch {
      // 强转失败的元素丢弃,条目其余部分照常报告
    }
  }
  return out;
}

/** 结构校验 + 元素归一一步完成:返回的条目满足 QueueSnapshot 的元素类型
 *  不变量(steering/followUp 均为 string[]),结构性坏条目返回 null 由
 *  loadValid 按 skip-silently 契约丢弃。此前只查数组不查元素,违反
 *  元素类型不变量(sec-queue-snapshot-validate 票整改:归一保契约,
 *  而非整条剔除)。 */
function normalizeEntry(entry: unknown): QueueSnapshotEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const candidate = entry as Partial<QueueSnapshotEntry>;
  if (typeof candidate.roomId !== "string" || candidate.roomId.length === 0) return null;
  if (typeof candidate.at !== "number") return null;
  const snapshot = candidate.snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  if (!Array.isArray(snapshot.steering) || !Array.isArray(snapshot.followUp)) return null;
  const normalized = {
    steering: coerceQueueElements(snapshot.steering),
    followUp: coerceQueueElements(snapshot.followUp),
  };
  if (queueTotal(normalized) === 0) return null;
  return { roomId: candidate.roomId, at: candidate.at, snapshot: normalized };
}

export interface QueueSnapshotConsumer {
  /** The room must still be a configured project — entries for removed
   *  projects are dropped, never delivered. */
  isProjectRoom: (roomId: string) => boolean;
  /** Raw transport send (throws on failure so per-room dead ends are
   *  visible); the caller wires this to the connected transport. */
  send: (roomId: string, text: string) => Promise<void>;
}

/**
 * Startup consumption (issue #115 stage 2): one service-restart notice per
 * entry, then the file is cleared regardless of per-room send failures.
 * The service-restart wording differs from the stage-1 notice ("服务重启",
 * not "子进程重启") — the process that lost the queue is this whole bridge.
 */
export async function consumeQueueSnapshots(
  store: QueueSnapshotStore,
  consumer: QueueSnapshotConsumer
): Promise<number> {
  const entries = store.loadValid();
  if (entries.length === 0) return 0;
  let sent = 0;
  // 房间之间相互独立,并行投递(原逐房串行白等 —— 审计工程批 票22);
  // 单房失败照旧只丢该房并留痕。
  await Promise.all(
    entries.map(async (entry) => {
      // 防御性兜底:per-room 全流程(含注入的 isProjectRoom/send)都在 try
      // 里,任何单房异常只丢该房并留痕,不拒绝整个 Promise.all、不影响
      // 其他房间补发与文件清理——与 per-room send 失败的既有隔离语义
      // 保持一致(sec-queue-snapshot-validate 票整改)。现基座上 loadValid
      // 已归一元素、真实接线不抛,此 try 是契约级纵深防御,非已发生崩溃。
      try {
        if (!consumer.isProjectRoom(entry.roomId)) return;
        const view = clearedQueuesView(entry.snapshot);
        if (!view) return;
        await consumer.send(entry.roomId, t("queue.lost.service.notice", view));
        sent += 1;
        const ageMin = Math.max(0, Math.round((Date.now() - entry.at) / 60_000));
        logger.info(`queue lost notice sent to ${entry.roomId} (snapshot ${ageMin} min old, ${view.count} message(s))`);
      } catch (err) {
        logger.warn(`queue lost notice failed for ${entry.roomId} — entry dropped: ${errorMessage(err)}`);
      }
    })
  );
  store.clear();
  if (sent > 0) {
    logger.info(`queue snapshot consumption done: ${sent} notice(s) sent after service restart`);
  }
  return sent;
}
