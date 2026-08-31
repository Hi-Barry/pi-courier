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
import { type ConfigStore, defaultProjectsRoot, nativeMxid } from "./config.js";
import { logger } from "./logger.js";
import { buildManagementRoomHelp, managementRoomName } from "./rpc/message-router.js";
import type { RoomOps } from "./transports/interface.js";
import type { MsgBridgeConfig } from "./types.js";

export interface SpaceEnsureDeps {
  roomOps: RoomOps;
  store: ConfigStore;
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>;
}

export type SpaceEnsureResult = "skipped" | "ready" | "degraded";

/** Space mode = multi-project deployment with the organizational space
 *  switched on. Single source of truth for standalone's adoption gate and
 *  this module's skip path. */
export function isSpaceMode(cfg: MsgBridgeConfig): boolean {
  return cfg.multiProject === true && cfg.space?.enabled === true;
}

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
      store.update({ space: { ...cfg.space, roomId: spaceId } });
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
      store.update({ managementRooms: [managementRoomId] });
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

    return "ready";
  } catch (err) {
    logger.warn(
      `[space] 空间初始化失败,本次以无空间模式运行(下次启动自动重试): ${(err as Error).message}`
    );
    return "degraded";
  }
}
