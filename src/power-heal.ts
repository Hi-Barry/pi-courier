/**
 * Trust model (#42): being a trusted user (config auth.trustedUsers) means
 * admin (TRUSTED_POWER_LEVEL) in every room pi-courier manages — the space,
 * the management room(s) and every project room — regardless of how trust
 * was granted (setup wizard or challenge code) and regardless of membership
 * (non-members are written too, so the level already holds on first join).
 * `elevateTrustedUsersInRoom` is the single idempotent write path: one read
 * of the room's power levels, then only trusted users actually below the
 * target get written. `healTrustedPowerLevels` sweeps every managed room
 * (derived from config) at startup, in space mode and degraded mode alike.
 * Actual low→100 elevations are booked into config.powerElevatedUsers, and
 * the same heal runs the symmetric demotion loop (ticket 3, issue #44):
 * booked users who have since lost trust are stripped back to PL 0 across
 * every managed room — the books are the sole authority, so nobody else
 * (external admins, the bot itself) is ever demoted. Legacy admins from the
 * old /pmctl-new sender special case are deliberately not in the books.
 */

import { type ConfigStore, nativeMxid } from "./config.js";
import { logger } from "./logger.js";
import type { RoomOps } from "./transports/interface.js";
import type { MsgBridgeConfig } from "./types.js";

/** Trusted users are admins in every room pi-courier manages (#42). A fixed
 *  rule — deliberately not configurable. */
export const TRUSTED_POWER_LEVEL = 100;

/** Unified idempotent elevation for ONE room (#42): read the room's power
 *  levels once, then write TRUSTED_POWER_LEVEL only for trusted users whose
 *  current level is below it — absent from the users map counts as below
 *  (non-members get written so the level already holds on first join), and a
 *  missing power-level event (null) counts as an empty users map. Every
 *  actual low→100 elevation is booked into config.powerElevatedUsers
 *  (deduped) for the demotion loop (ticket 3); users already at 100 are
 *  neither written nor booked. Returns the namespaced users elevated here.
 *  Throws on room-level failure — callers decide whether that skips a sweep
 *  room or warns a reply. */
export async function elevateTrustedUsersInRoom(
  roomOps: RoomOps,
  store: ConfigStore,
  roomId: string
): Promise<string[]> {
  const trusted = store.get().auth?.trustedUsers ?? [];
  if (trusted.length === 0) return [];

  const levels = await roomOps.getPowerLevels(roomId);
  const users = (levels?.users ?? {}) as Record<string, unknown>;

  const elevated: string[] = [];
  // Book in a finally: a write that throws mid-loop must not lose the users
  // already elevated — they are at 100 now, so a retry would skip (and never
  // book) them, leaving demotion blind. The error still propagates.
  try {
    for (const namespaced of trusted) {
      const mxid = nativeMxid(namespaced);
      const current = users[mxid];
      if (typeof current === "number" && current >= TRUSTED_POWER_LEVEL) continue;
      await roomOps.setUserPowerLevel(roomId, mxid, TRUSTED_POWER_LEVEL);
      elevated.push(namespaced);
    }
  } finally {
    if (elevated.length > 0) {
      store.update({
        powerElevatedUsers: [...new Set([...(store.get().powerElevatedUsers ?? []), ...elevated])],
      });
      logger.info(
        `[power] 房间 ${roomId}: ${elevated.length} 名信任用户已提为管理员(PL ${TRUSTED_POWER_LEVEL})`
      );
    }
  }
  return elevated;
}

/** Derive every room this instance manages from config: the space, the
 *  management room(s) and every project room — deduped, empties dropped.
 *  The power sweep covers EVERY managementRooms entry: the public read/write
 *  semantics is a single management room (`managementRoomId` is the
 *  authoritative accessor), but a hand-edited legacy config may carry
 *  residual entries, and elevation/demotion must not silently skip them —
 *  the sweep keeps master's full-list semantics (spec #99 评审修复).
 *  Shared by the elevation sweep (#42) and the demotion loop (#44) so both
 *  always agree on what "everywhere" means. */
export function managedRoomIds(cfg: MsgBridgeConfig): string[] {
  return [
    ...new Set(
      [cfg.space?.roomId, ...(cfg.managementRooms ?? []), ...Object.keys(cfg.projects ?? {})].filter(
        (id): id is string => Boolean(id)
      )
    ),
  ];
}

/** Full startup self-heal (#42 + #44): first strip the power that was granted
 *  to users who have since lost trust (the demotion loop), then sweep every
 *  room this instance manages (derived from config, deduped, empties dropped)
 *  re-granting it to the currently trusted. Runs in space mode AND degraded
 *  mode (an adopted management DM needs it as much as a bot-created one).
 *  Per-room failures (no power-level access, network) warn with the roomId
 *  and skip just that room — the sweep never throws and never affects the
 *  startup result tri-state. */
export async function healTrustedPowerLevels(roomOps: RoomOps, store: ConfigStore): Promise<void> {
  const cfg = store.get();
  const roomIds = managedRoomIds(cfg);
  // Demotion loop (ticket 3, issue #44): book-kept users no longer in the
  // trust set get their granted power stripped before the elevation pass.
  // `stale` is disjoint from trusted by construction, so nobody is demoted
  // and re-elevated in the same sweep; and the books are the sole authority —
  // users outside them (external admins, the bot itself) are never touched.
  // Failed demotions stay booked and retry on the next start.
  const trusted = cfg.auth?.trustedUsers ?? [];
  for (const user of (cfg.powerElevatedUsers ?? []).filter((u) => !trusted.includes(u))) {
    await demoteTrustedUserEverywhere(roomOps, store, user);
  }
  for (const roomId of roomIds) {
    try {
      await elevateTrustedUsersInRoom(roomOps, store, roomId);
    } catch (err) {
      logger.warn(`[power] 房间 ${roomId} 信任用户补权失败(跳过,下次启动自动重试): ${(err as Error).message}`);
    }
  }
}

/** Symmetric closed loop (ticket 3, issue #44): strip the admin power this
 *  instance once granted. Writes PL 0 for ONE namespaced user in every
 *  managed room — blind writes, so retrying an already-demoted room is
 *  harmless. Only when ALL rooms succeeded is the user removed from
 *  config.powerElevatedUsers (through ConfigStore.update(), the single write
 *  path); any per-room failure warns with the roomId and keeps the entry so
 *  the next startup heal retries. Returns whether the demotion fully
 *  succeeded. The caller names the target (the /revoke effect or a stale
 *  book entry) — this never picks victims on its own. */
export async function demoteTrustedUserEverywhere(
  roomOps: RoomOps,
  store: ConfigStore,
  namespacedUser: string
): Promise<boolean> {
  let failed = false;
  for (const roomId of managedRoomIds(store.get())) {
    try {
      await roomOps.setUserPowerLevel(roomId, nativeMxid(namespacedUser), 0);
    } catch (err) {
      failed = true;
      logger.warn(
        `[power] 房间 ${roomId} 撤销降权失败(保留簿记,下次启动自动重试): ${(err as Error).message}`
      );
    }
  }
  if (failed) return false;
  const books = store.get().powerElevatedUsers ?? [];
  const next = books.filter((u) => u !== namespacedUser);
  if (next.length !== books.length) {
    store.update({ powerElevatedUsers: next });
    logger.info(`[power] 已撤销信任的用户 ${namespacedUser} 已在全部托管房间降为 PL 0,并移出提权簿记`);
  }
  return true;
}
