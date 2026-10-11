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

  /** Entries usable as loss reports: well-formed and non-empty. Malformed
   *  shapes are skipped silently (same degradation contract as the
   *  attachments ledger). */
  loadValid(): QueueSnapshotEntry[] {
    return this.load().filter(isValidEntry);
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

function isValidEntry(entry: unknown): entry is QueueSnapshotEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<QueueSnapshotEntry>;
  if (typeof candidate.roomId !== "string" || candidate.roomId.length === 0) return false;
  if (typeof candidate.at !== "number") return false;
  const snapshot = candidate.snapshot;
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!Array.isArray(snapshot.steering) || !Array.isArray(snapshot.followUp)) return false;
  return queueTotal({ steering: snapshot.steering, followUp: snapshot.followUp }) > 0;
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
  for (const entry of entries) {
    if (!consumer.isProjectRoom(entry.roomId)) continue;
    const view = clearedQueuesView(entry.snapshot);
    if (!view) continue;
    try {
      await consumer.send(entry.roomId, t("queue.lost.service.notice", view));
      sent += 1;
      const ageMin = Math.max(0, Math.round((Date.now() - entry.at) / 60_000));
      logger.info(`queue lost notice sent to ${entry.roomId} (snapshot ${ageMin} min old, ${view.count} message(s))`);
    } catch (err) {
      logger.warn(`queue lost notice failed for ${entry.roomId} — entry dropped: ${errorMessage(err)}`);
    }
  }
  store.clear();
  if (sent > 0) {
    logger.info(`queue snapshot consumption done: ${sent} notice(s) sent after service restart`);
  }
  return sent;
}
