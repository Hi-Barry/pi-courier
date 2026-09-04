/**
 * Startup space ensure + trusted-user permission self-heal.
 *
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
 *
 * The space itself remains an organizational view (m.space): when the space
 * feature is enabled (multi-project only), the bot lazily creates a private
 * space on first run and puts the management room inside it. Every failure
 * degrades to today's unspace'd behaviour (warn + retry on the next start),
 * so neither the space nor the power sweep can become an availability single
 * point.
 *
 * Idempotency lives in the config: `space.roomId` (space exists) and
 * `managementRooms[0]` (management room exists) — whichever is missing is
 * (re-)created, the other is left alone. The space link is (re-)asserted on
 * every start: m.space.child state is idempotent, so this self-heals a
 * previous start's link failure, and a pre-space deployment's adopted
 * management DM gets linked instead of duplicated.
 */

import * as os from "node:os";
import { activeSpaceRoomId, type ConfigStore, defaultProjectsRoot, isSpaceMode, nativeMxid } from "./config.js";
import { logger } from "./logger.js";
import { buildManagementRoomHelp, managementRoomName } from "./management-room.js";
import type { RoomOps } from "./transports/interface.js";
import type { MsgBridgeConfig } from "./types.js";

export interface SpaceEnsureDeps {
  roomOps: RoomOps;
  store: ConfigStore;
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>;
}

export type SpaceEnsureResult = "skipped" | "ready" | "degraded";

/** Trusted users are admins in every room pi-courier manages (#42). A fixed
 *  rule — deliberately not configurable. */
export const TRUSTED_POWER_LEVEL = 100;

export async function ensureSpaceAndManagementRoom(deps: SpaceEnsureDeps): Promise<SpaceEnsureResult> {
  const { roomOps, store, sendReply } = deps;
  const cfg = store.get();
  if (!isSpaceMode(cfg)) return "skipped";

  const instanceName = cfg.instanceName ?? os.hostname();
  const inviteUserIds = (cfg.auth?.trustedUsers ?? []).map(nativeMxid);
  const workdir = cfg.workdir ?? defaultProjectsRoot();

  try {
    let spaceId = cfg.space?.roomId;
    if (!spaceId) {
      spaceId = await roomOps.createSpace({
        name: `pi-courier · ${instanceName}`,
        inviteUserIds,
      });
      // createRoom's invite list covers every trusted user — record them all
      // so neither the self-heal below nor challenge-pass invites re-ping
      // anyone (decliners included: one invite per user, ever).
      store.update({
        space: {
          ...cfg.space,
          roomId: spaceId,
          invitedUsers: cfg.auth?.trustedUsers ?? [],
        },
      });
      logger.info(`[space] 空间已创建: ${spaceId}`);
    }

    let managementRoomId = (cfg.managementRooms ?? [])[0];
    if (!managementRoomId) {
      const encrypted = cfg.matrix?.encryption !== false && roomOps.encryptionAvailable;
      managementRoomId = await roomOps.createRoom({
        name: managementRoomName(instanceName),
        inviteUserIds,
        encrypted,
      });
      // The room exists now — persist it before the optional steps so a
      // crash can never lead to a duplicate management room on the next start.
      // Creation's invite list covered every trusted user — record them in the
      // management bookkeeping too (mirror of invitedUsers above) so the
      // self-heal never re-invites them (Matrix rejects re-invites).
      store.update({
        managementRooms: [managementRoomId],
        space: {
          ...(store.get().space ?? {}),
          managementInvitedUsers: cfg.auth?.trustedUsers ?? [],
        },
      });
      logger.info(
        `[space] 管理房间已创建: ${managementRoomId}${encrypted ? " (E2EE)" : ""}`
      );
      try {
        const botAccount = roomOps.getBotUserId() ?? "(未知)";
        await sendReply(
          managementRoomId,
          "matrix",
          `${buildManagementRoomHelp(instanceName, botAccount, workdir)}\n\n` +
            `🛡️ 信任用户会自动获得房间管理员权限(含新建的项目房间)。`
        );
      } catch {
        // The usage guide is nice-to-have; room setup must not depend on it.
      }
    }

    // (Re-)assert the link unconditionally: idempotent state, best-effort.
    // It self-heals a failed link from an earlier start, and a legacy
    // adopted DM (bot not its owner) may reject the child-side parent event.
    try {
      await roomOps.addRoomToSpace(spaceId, managementRoomId);
      logger.debug(`[space] 空间链接就绪: ${managementRoomId} → ${spaceId}`);
    } catch (err) {
      logger.warn(
        `[space] 管理房间挂入空间失败(下次启动自动重试,房间仍可用): ${(err as Error).message}`
      );
    }

    // Invite self-heal: trusted users missing from invitedUsers — trust
    // granted while degraded, or an invite that failed earlier — get their
    // (single) invite now. Failures stay unrecorded and retry next start.
    // The same pass covers the management-room bookkeeping (issue #43): a
    // trusted user without that invite sees the /pmctl room under the space
    // but could never enter it.
    const current = store.get();
    for (const user of (cfg.auth?.trustedUsers ?? []).filter((u) => !(current.space?.invitedUsers ?? []).includes(u))) {
      await inviteUserToSpaceOnce(roomOps, store, user);
    }
    for (const user of (cfg.auth?.trustedUsers ?? []).filter((u) => !(current.space?.managementInvitedUsers ?? []).includes(u))) {
      await inviteUserToManagementRoomOnce(roomOps, store, user);
    }

    return "ready";
  } catch (err) {
    logger.warn(
      `[space] 空间初始化失败,本次以无空间模式运行(下次启动自动重试): ${(err as Error).message}`
    );
    return "degraded";
  }
}

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

/** Fire-once space invite for ONE namespaced user: space.invitedUsers records
 *  every user we have invited (decliners included) so nobody is pinged twice.
 *  A failed invite is NOT recorded — the startup ensure self-heals it.
 *  Single implementation shared by the router's spaceInvite effect and the
 *  ensure's self-heal pass. Returns true when the invite went out. */
export async function inviteUserToSpaceOnce(
  roomOps: RoomOps,
  store: ConfigStore,
  namespacedUser: string
): Promise<boolean> {
  const spaceId = activeSpaceRoomId(store.get());
  if (!spaceId) return false;
  const invited = store.get().space?.invitedUsers ?? [];
  if (invited.includes(namespacedUser)) return false;
  try {
    await roomOps.inviteUser(spaceId, nativeMxid(namespacedUser));
    store.update({
      space: { ...(store.get().space ?? {}), roomId: spaceId, invitedUsers: [...invited, namespacedUser] },
    });
    logger.info(`[space] 信任用户已邀请进空间: ${namespacedUser}`);
    return true;
  } catch (err) {
    logger.warn(`[space] 邀请 ${namespacedUser} 进空间失败(下次启动自愈): ${(err as Error).message}`);
    return false;
  }
}

/** Fire-once management-room invite for ONE namespaced user — the issue #43
 *  twin of inviteUserToSpaceOnce: the management room is where /pmctl lives,
 *  and a space member who was never invited into it could see the room under
 *  the space but never enter it. Guards: space mode must be active with a
 *  created space (activeSpaceRoomId) AND managementRooms[0] must exist — the
 *  degraded path's adopted management DM is never used to pull people in.
 *  Bookkeeping: space.managementInvitedUsers; a failed invite is NOT
 *  recorded — the startup ensure self-heals it. Returns true when the invite
 *  went out. */
export async function inviteUserToManagementRoomOnce(
  roomOps: RoomOps,
  store: ConfigStore,
  namespacedUser: string
): Promise<boolean> {
  const cfg = store.get();
  if (!activeSpaceRoomId(cfg)) return false;
  const managementRoomId = (cfg.managementRooms ?? [])[0];
  if (!managementRoomId) return false;
  const invited = cfg.space?.managementInvitedUsers ?? [];
  if (invited.includes(namespacedUser)) return false;
  try {
    await roomOps.inviteUser(managementRoomId, nativeMxid(namespacedUser));
    store.update({
      space: { ...(store.get().space ?? {}), managementInvitedUsers: [...invited, namespacedUser] },
    });
    logger.info(`[space] 信任用户已邀请进管理房间: ${namespacedUser}`);
    return true;
  } catch (err) {
    logger.warn(`[space] 邀请 ${namespacedUser} 进管理房间失败(下次启动自愈): ${(err as Error).message}`);
    return false;
  }
}
