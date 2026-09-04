/**
 * Startup space ensure — the Element space (m.space) organizational view.
 *
 * Pure display-layer grouping: it never touches the trust model or room
 * permissions. When the space feature is enabled (multi-project only), the
 * bot lazily creates a private space on first run and puts the management
 * room inside it. Every failure degrades to today's unspace'd behaviour
 * (warn + retry on the next start), so the feature can never become an
 * availability single point.
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

export interface SpaceEnsureDeps {
  roomOps: RoomOps;
  store: ConfigStore;
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>;
}

export type SpaceEnsureResult = "skipped" | "ready" | "degraded";

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
        await sendReply(managementRoomId, "matrix", buildManagementRoomHelp(instanceName, botAccount, workdir));
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
