import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Single-instance connection guard.
 *
 * Two layers:
 *  1. global flag  — catches same-process re-entrant calls from a different
 *                    owner instance (fresh module import, same PID).
 *  2. PID lock file — catches separate-process duplicates. Acquisition is
 *                    atomic (exclusive create); takeover of a stale lock goes
 *                    through unlink + exclusive re-create so two concurrent
 *                    takers cannot both win.
 */

// 锁模块刻意零依赖:跨进程竞争测试以原生 node 直跑本文件(TS type-stripping
// 解析不了 .js→.ts 源内导入),故配置目录独立计算,不引 config(审计批3 评审)。
const LOCK_PATH = path.join(os.homedir(), ".pi", "pi-courier.lock");

const g = global as any;
if (!g.__msgBridgeInstanceId) {
  g.__msgBridgeInstanceId = Math.random().toString(36).slice(2);
}
const instanceId: string = g.__msgBridgeInstanceId;

/** Parse "pid:owner" out of the lock file; null when unreadable or corrupt
 *  (empty, no colon, non-numeric pid). A corrupt file carries no valid
 *  ownership claim. */
function readLockFile(): { pid: number; owner: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(LOCK_PATH, "utf-8");
  } catch {
    return null;
  }
  const line = raw.trim();
  const sep = line.indexOf(":");
  if (sep <= 0) return null;
  const pid = parseInt(line.slice(0, sep), 10);
  if (Number.isNaN(pid)) return null;
  return { pid, owner: line.slice(sep + 1) };
}

/** True only when the process is provably gone (ESRCH). Alive, or probe
 *  failures like EPERM (alive but owned by another user) — conservatively
 *  treated as live: a held lock is never stolen. */
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0); // throws if process does not exist
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

export function acquireLock(): boolean {
  // Layer 1: same-process guard — reject when a different owner instance in
  // this process already holds the connection.
  if (g.__msgBridgeConnected && g.__msgBridgeOwner !== instanceId) {
    return false;
  }

  // Layer 2: cross-process guard via PID lock file. Exclusive-create makes
  // acquisition atomic; on EEXIST the existing claim is probed: our own PID
  // is never a live competitor (PID reuse, container restarts), a provably
  // dead process's lock is taken over, anything else is respected.
  const content = `${process.pid}:${instanceId}`;
  try {
    const configDir = path.join(os.homedir(), ".pi");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    try {
      fs.writeFileSync(LOCK_PATH, content, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      const existing = readLockFile();
      const takeover =
        existing === null ||
        existing.pid === process.pid ||
        processIsGone(existing.pid);
      if (!takeover) return false; // a live competitor holds the lock
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {
        // already gone — someone else's takeover, re-race below
      }
      try {
        fs.writeFileSync(LOCK_PATH, content, { mode: 0o600, flag: "wx" });
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException)?.code !== "EEXIST") throw err2;
        return false; // lost the takeover race to a live writer
      }
    }
  } catch (err) {
    // Lock file mechanics failed — exclusivity cannot be guaranteed, so fail
    // closed instead of letting a second bridge believe it owns the room.
    console.warn(
      `[lock] acquiring ${LOCK_PATH} failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }

  g.__msgBridgeConnected = true;
  g.__msgBridgeOwner = instanceId;
  return true;
}

export function releaseLock(): void {
  if (g.__msgBridgeOwner !== instanceId) return;
  g.__msgBridgeConnected = false;
  g.__msgBridgeOwner = undefined;
  try {
    const lock = readLockFile();
    // Only unlink a lock that verifiably belongs to us; a corrupt entry stays
    // (harmless — acquire treats it as having no valid claim and takes over).
    if (lock && lock.pid === process.pid && lock.owner === instanceId) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {
    // ignore — best-effort cleanup
  }
}
