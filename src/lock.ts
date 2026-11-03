import * as fs from "node:fs";
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
 *
 * 注入缝(spec #258 票03):锁路径由组合根注入(acquireLock/releaseLock 的
 * lockPath 参数,取布局解析的 layout.lockPath = stateDir/pi-courier.lock)。
 * 锁从 ~/.pi 挪进 stateDir:它本质是运行痕迹而非配置;旧锁不迁移,由
 * legacy-migration 在启动早期按陈旧判断清理,新锁在此按需重建。
 */

// 锁模块刻意零项目依赖:跨进程竞争测试以原生 node 直跑本文件(TS
// type-stripping 解析不了 .js→.ts 源内导入),故不能引 paths/config 取锁路径
// (审计批3 评审;票03 维持该约束,路径改为调用方注入而非模块内计算)。

const g = global as any;
if (!g.__msgBridgeInstanceId) {
  g.__msgBridgeInstanceId = Math.random().toString(36).slice(2);
}
const instanceId: string = g.__msgBridgeInstanceId;

/** Parse "pid:owner" out of the lock file; null when unreadable or corrupt
 *  (empty, no colon, non-numeric pid). A corrupt file carries no valid
 *  ownership claim. */
function readLockFile(lockPath: string): { pid: number; owner: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf-8");
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

/**
 * 锁陈旧判定(单点,spec #258 评审修复:legacy-migration 的 defaultIsLockStale
 * 复制品由此收敛,改 import 本函数)。与 acquireLock 的接管判断完全同源同义:
 * 读不到或内容损坏(无有效持有声明)、持有者是本进程 PID、持有进程确死
 * (ESRCH)三者之一 → 陈旧;活进程或探测不了(EPERM 等)→ 不陈旧,绝不偷
 * 活锁。零项目依赖约束不变(只触及 fs/path/process,见上方注)。
 */
export function lockIsStale(lockPath: string): boolean {
  const existing = readLockFile(lockPath);
  if (existing === null) return true; // 读不到 = 无有效持有声明(存在性由调用方先行判断)
  if (existing.pid === process.pid) return true; // 己方 PID:acquireLock 同款接管语义
  return processIsGone(existing.pid);
}

/** 取单实例锁(持有声明写在注入的 lockPath)。同进程重入幂等;活锁不偷。 */
export function acquireLock(lockPath: string): boolean {
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
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    }
    try {
      fs.writeFileSync(lockPath, content, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      const existing = readLockFile(lockPath);
      const takeover =
        existing === null ||
        existing.pid === process.pid ||
        processIsGone(existing.pid);
      if (!takeover) return false; // a live competitor holds the lock
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // already gone — someone else's takeover, re-race below
      }
      try {
        fs.writeFileSync(lockPath, content, { mode: 0o600, flag: "wx" });
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException)?.code !== "EEXIST") throw err2;
        return false; // lost the takeover race to a live writer
      }
    }
  } catch (err) {
    // Lock file mechanics failed — exclusivity cannot be guaranteed, so fail
    // closed instead of letting a second bridge believe it owns the room.
    console.warn(
      `[lock] acquiring ${lockPath} failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }

  g.__msgBridgeConnected = true;
  g.__msgBridgeOwner = instanceId;
  return true;
}

/** 放锁(只unlink归属可验证的锁;损坏条目留着无害,acquire 会接管)。 */
export function releaseLock(lockPath: string): void {
  if (g.__msgBridgeOwner !== instanceId) return;
  g.__msgBridgeConnected = false;
  g.__msgBridgeOwner = undefined;
  try {
    const lock = readLockFile(lockPath);
    // Only unlink a lock that verifiably belongs to us; a corrupt entry stays
    // (harmless — acquire treats it as having no valid claim and takes over).
    if (lock && lock.pid === process.pid && lock.owner === instanceId) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore — best-effort cleanup
  }
}
