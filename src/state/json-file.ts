/**
 * Generic JSON state file (issue #114): disk is a backup, the in-memory copy
 * is the hot path — the file is never read on the hot path and never allowed
 * to throw. Degradation contract: missing/corrupt/unwritable file degrades to
 * "state not persisted" (pre-#114 behaviour), never to a broken service.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";

export class JsonStateFile<T> {
  constructor(
    private readonly filePath: string,
    private readonly fallback: T,
    /** 磁盘类写失败(ENOSPC/EDQUOT)的可见性缝(spec #247 票04):组合根
     *  注入聚合 recorder;缺省不接,行为与旧版逐字节一致。 */
    private readonly onDiskWriteFailure?: (err: unknown) => void
  ) {}

  /** Missing file (first run) stays quiet; corrupt/unreadable warns. Never throws. */
  load(): T {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`state file unreadable, starting from defaults: ${this.filePath} (${errorMessage(err)})`);
      }
      return structuredClone(this.fallback);
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      // "null" parses fine but is not a usable state shape; neither is a
      // value whose top-level shape disagrees with the fallback (array vs
      // object swaps after a hand-edit or a partial write). Fall back.
      if (!this.shapeMatches(parsed)) {
        logger.warn(`state file shape mismatch, starting from defaults: ${this.filePath}`);
        return structuredClone(this.fallback);
      }
      return (parsed ?? structuredClone(this.fallback)) as T;
    } catch (err) {
      logger.warn(`state file corrupt, starting from defaults: ${this.filePath} (${errorMessage(err)})`);
      return structuredClone(this.fallback);
    }
  }

  /** Top-level shape guard keyed on the fallback's own type: an array
   *  fallback demands an array, a plain-object fallback demands a plain
   *  object, primitives accept anything non-null. Not a schema — it catches
   *  the "wrong shape entirely" class (audit stability batch 票15). */
  private shapeMatches(parsed: unknown): boolean {
    if (parsed === null || parsed === undefined) return false;
    if (Array.isArray(this.fallback)) return Array.isArray(parsed);
    if (typeof this.fallback === "object") {
      return typeof parsed === "object" && !Array.isArray(parsed);
    }
    return true;
  }

  /**
   * Atomic write (tmp + rename) so an interrupted save can never corrupt the
   * previous state; 0600 on the file, 0700 on the directory (may be created
   * here as a fallback — the composition root normally creates it first).
   * The tmp name carries the PID so two processes saving the same state file
   * cannot clobber each other's tmp (audit stability batch 票15). The file is
   * 0600 by creation (the renamed tmp), the dir is tightened separately.
   * Fire-and-forget: failures warn and never throw.
   */
  save(next: T): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      try {
        fs.unlinkSync(tmp);
      } catch {
        // absent tmp is the normal case
      }
      fs.writeFileSync(tmp, JSON.stringify(next, undefined, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      // 0700 only applies when the dir is CREATED — a pre-existing loose
      // directory (older version, manual copy) must be tightened. The file
      // itself needs no chmod: it is the just-created 0600 tmp, renamed.
      // Separate catch so a chmod failure is not misreported as a write
      // failure (the state is safely on disk at this point).
      try {
        fs.chmodSync(path.dirname(this.filePath), 0o700);
      } catch {
        // 权限收紧失败不影响本次落盘
      }
    } catch (err) {
      logger.warn(`state file write failed (memory copy stays authoritative): ${this.filePath} (${errorMessage(err)})`);
      // 磁盘类写失败的聚合可见性(spec #247 票04):缝自身抛错不放大写路径
      try {
        this.onDiskWriteFailure?.(err);
      } catch {
        // 可见性通道失败不影响降级契约
      }
    }
  }
}
