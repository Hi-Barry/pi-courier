import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Single-instance connection guard.
 *
 * Two layers:
 *  1. global flag  — catches same-process re-entrant calls (e.g. sub-agents
 *                    spawned inside the same Node.js process, same PID).
 *  2. PID lock file — catches separate-process duplicates (e.g. sub-agents
 *                    launched as child processes with different PIDs).
 */

const LOCK_PATH = path.join(os.homedir(), ".pi", "msg-bridge.lock");

const g = global as any;
if (!g.__msgBridgeInstanceId) {
  g.__msgBridgeInstanceId = Math.random().toString(36).slice(2);
}
const instanceId: string = g.__msgBridgeInstanceId;

export function acquireLock(): boolean {
  // Layer 1: same-process guard via a global flag
  if (g.__msgBridgeConnected && g.__msgBridgeOwner !== instanceId) {
    return false;
  }

  // Layer 2: cross-process guard via PID lock file
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const raw = fs.readFileSync(LOCK_PATH, "utf-8").trim().split(":");
      const pid = parseInt(raw[0], 10);
      const owner = raw[1] ?? "";
      if (!Number.isNaN(pid) && pid === process.pid && owner !== instanceId) {
        return false;
      }
      if (!Number.isNaN(pid) && pid !== process.pid) {
        try {
          process.kill(pid, 0); // throws if process does not exist
          return false; // another live process holds the lock
        } catch {
          // stale lock from a dead process — overwrite below
        }
      }
    }
    const configDir = path.join(os.homedir(), ".pi");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(LOCK_PATH, `${process.pid}:${instanceId}`, { mode: 0o600 });
  } catch {
    // lock file mechanics failed — fall through, global flag is still set below
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
    if (fs.existsSync(LOCK_PATH)) {
      const raw = fs.readFileSync(LOCK_PATH, "utf-8").trim().split(":");
      const pid = parseInt(raw[0], 10);
      const owner = raw[1] ?? "";
      if (pid === process.pid && owner === instanceId) {
        fs.unlinkSync(LOCK_PATH);
      }
    }
  } catch {
    // ignore
  }
}
