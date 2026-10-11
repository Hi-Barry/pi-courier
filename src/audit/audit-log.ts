/**
 * Audit log (issue #124) — append-only JSONL evidence of sensitive actions:
 * who, when, what. The file is evidence, not a hot path: writes are
 * fire-and-forget and never throw into the caller; consecutive failures count
 * up and surface ONE degraded-notice per threshold window (management-room
 * warning via the injected callback) so an audit outage is visible without
 * spamming. Append-only means existing lines are never rewritten; growth is
 * bounded by size-based rotation (current + N rotated siblings).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../logger.js";

export const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;
export const AUDIT_ROTATE_KEEP = 2;
export const AUDIT_WARN_THRESHOLD = 10;

/** One JSONL line. `detail` stays a short single line (we control every
 *  call site) so concurrent-looking writes can never interleave mid-line. */
export interface AuditEntry {
  ts: number;
  event: string;
  /** Namespaced actor identity ("matrix:@user:server") or "system". */
  actor: string;
  chatId: string;
  detail?: string;
}

/** The v1 event registry (issue #124): every sensitive action this bridge
 *  can be asked to name. Central constants — a new dangerous command that
 *  forgets to register here is a snapshot-test failure, not a silent gap. */
export const AUDIT_EVENTS = {
  bridgeStart: "bridge.start",
  pairingSuccess: "pairing.success",
  pairingWrong: "pairing.wrong",
  pairingBlocked: "pairing.blocked",
  trustList: "trust.list",
  trustRevoke: "trust.revoke",
  bashExec: "bash.exec",
  bashStop: "bash.stop",
  pmctlRemove: "pmctl.rm",
  loginFlow: "login.flow",
  reload: "reload",
  queueClear: "queue.clear",
  backlogExecute: "backlog.execute",
  guestDenied: "guest.denied",
  modelFallback: "model.fallback",
} as const;

export interface AuditLogOptions {
  rotateBytes?: number;
  rotateKeep?: number;
  warnThreshold?: number;
  /** Fired once per threshold window when writes keep failing — the
   *  composition root routes this to the management room. */
  onDegraded?: (message: string) => void;
}

export class AuditLog {
  private readonly rotateBytes: number;
  private readonly rotateKeep: number;
  private readonly warnThreshold: number;
  private consecutiveFailures = 0;
  private permissionsEnforced = false;

  constructor(
    private readonly filePath: string,
    private readonly options: AuditLogOptions = {}
  ) {
    this.rotateBytes = options.rotateBytes ?? AUDIT_ROTATE_BYTES;
    this.rotateKeep = options.rotateKeep ?? AUDIT_ROTATE_KEEP;
    this.warnThreshold = options.warnThreshold ?? AUDIT_WARN_THRESHOLD;
  }

  /** Fire-and-forget append. Never throws; failures degrade per the
   *  threshold contract above. */
  append(event: string, actor: string, chatId: string, detail?: string): void {
    const entry: AuditEntry = { ts: Date.now(), event, actor, chatId, ...(detail ? { detail } : {}) };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      this.rotateIfNeeded();
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      if (!this.permissionsEnforced) {
        // 0600/0700 only apply on creation — a pre-existing loose file/dir
        // (older version, manual copy) gets tightened once on the first
        // successful append; rotation recreates files at 0600 by itself.
        try {
          fs.chmodSync(this.filePath, 0o600);
          fs.chmodSync(path.dirname(this.filePath), 0o700);
          this.permissionsEnforced = true;
        } catch {
          // 权限收紧失败不影响本次落账,下次 append 重试
        }
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.warnThreshold) {
        const message = `audit log unavailable (${this.consecutiveFailures} consecutive failures) — the service keeps running without evidence: ${(err as Error).message}`;
        logger.warn(message);
        try {
          this.options.onDegraded?.(message);
        } catch {
          // 告警通道自身的失败不影响主流程
        }
        this.consecutiveFailures = 0; // 重新武装:下满一个阈值窗口再告警一次
      }
    }
  }

  /** Size-based rotation: current → .1 → .2 (…→ .keep), the oldest sibling
   *  falls off the cliff by rename-overwrite. Absent files shift silently. */
  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return; // 尚无文件,无可轮转
    }
    if (size < this.rotateBytes) return;
    for (let i = this.rotateKeep - 1; i >= 1; i -= 1) {
      this.shift(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`);
    }
    this.shift(this.filePath, `${this.filePath}.1`);
  }

  private shift(from: string, to: string): void {
    try {
      fs.renameSync(from, to);
    } catch {
      // 缺席的源是轮转链的正常形态
    }
  }
}
