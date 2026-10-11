/**
 * Room & bot identity branding (spec #84): the bundled art sets, applied as
 * avatars — the space picks from the landscape set by instance name, the
 * management room has the cottage set's dedicated image, project rooms pick
 * from the cottage set by project name, and the bot account carries the
 * agent set's profile face. Startup identity self-heal (只补缺 + per-set
 * version migration) lives here; the /pmctl-new provisioning path calls
 * ensureRoomAvatar directly for mid-session rooms.
 */

import { activeSpaceRoomId, type ConfigStore, effectiveInstanceName, isSpaceMode, managementRoomId } from "./config.js";
import { errorMessage } from "./errors.js";
import { logger } from "./logger.js";
import {
  AVATAR_SET_VERSION,
  type AvatarSet,
  avatarInfo,
  avatarVersionMarker,
  bookedAvatarVersion,
  isLegacySpaceName,
  managementAvatarFile,
  pickPoolAvatarFile,
  readAvatarBundled,
  spaceDisplayName,
} from "./space-identity.js";
import type { RoomOps } from "./transports/interface.js";
import type { MsgBridgeConfig } from "./types.js";

/** Brand ONE room with the bundled avatar. Default policy is 只补缺: a room
 *  that already has an avatar keeps it. With `rebrand` (the startup heal,
 *  while the room's art-set version migration is pending), an existing avatar
 *  is replaced unconditionally — a set restyle re-brands that set's managed
 *  rooms once, whoever set the current image. Throws on failure — callers pick
 *  the policy (the startup heal warns + retries next start; the /pmctl new
 *  path surfaces a non-fatal note). Returns what happened: "set" (room had
 *  none), "rebranded" (old avatar replaced) or "kept". Shared by the startup
 *  identity heal and the project-room creation path (a mid-session room must
 *  not wait for the next restart to get its face). */
export async function ensureRoomAvatar(
  roomOps: RoomOps,
  roomId: string,
  file: string,
  opts: { rebrand?: boolean } = {},
): Promise<"set" | "rebranded" | "kept"> {
  const had = await roomOps.getRoomAvatar(roomId);
  if (had && !opts.rebrand) return "kept";
  const data = readAvatarBundled(file);
  const mxcUrl = await roomOps.uploadMedia(data, "image/png");
  await roomOps.setRoomAvatar(roomId, mxcUrl, avatarInfo(data));
  return had ? "rebranded" : "set";
}

/** The ONE migration driver for all three art sets (spec #84 ticket 3
 *  semantics; single point since spec #99 #105). A set's migration is:
 *  pending → run the set's re-brand pass → book the marker only when the
 *  WHOLE set succeeded. A failed room/target is the pass's job to warn (with
 *  its own label); it reports false and the set simply stays pending — the
 *  next start retries it while every other set migrates normally. A set
 *  whose marker is already booked still runs its pass (fill-only semantics
 *  live in the pass) but never re-books.
 *  `run(rebrand)` executes the pass and returns whether every target in the
 *  set succeeded; `rebrand` says whether this set's migration is pending. */
async function migrateAvatarSet(
  store: ConfigStore,
  cfg: MsgBridgeConfig,
  set: AvatarSet,
  run: (rebrand: boolean) => Promise<boolean>,
): Promise<void> {
  const rebrand = bookedAvatarVersion(cfg, set) < AVATAR_SET_VERSION[set];
  const allOk = await run(rebrand);
  if (rebrand && allOk) {
    try {
      store.update(avatarVersionMarker(set));
    } catch (err) {
      // 记账失败 = 下次启动整组重新品牌化,必须留痕(审计稳定性批 票12 评审修复)
      logger.warn(`[identity] ${set} 头像版本记账失败(下次启动将重刷): ${errorMessage(err)}`);
    }
  }
}

/** Startup identity self-heal: brand the managed rooms with the short space
 *  name and the bundled art sets (space + management + project rooms).
 *  Space mode only — a degraded run's adopted management DM is never touched.
 *  Safety rules: a space is renamed ONLY when its name still exactly matches
 *  the legacy `pi-courier · <instance>` template; an avatar is set when the
 *  room has none — plus, while a set's version migration is pending, that
 *  set's managed rooms are re-branded once (a restyle means the bundled art
 *  is the single source of truth for that start), each of the three sets
 *  booking and migrating independently. Per-room failures warn and retry on
 *  the next start; like healTrustedPowerLevels this never throws and never
 *  affects the startup tri-state. */
export async function healRoomIdentities(roomOps: RoomOps, store: ConfigStore): Promise<void> {
  const cfg = store.get();
  if (!isSpaceMode(cfg)) return;
  const spaceId = activeSpaceRoomId(cfg);
  if (!spaceId) return;

  const instanceName = effectiveInstanceName(cfg);

  // Legacy name migration (exact old-template match only, see above).
  try {
    const name = await roomOps.getRoomName(spaceId);
    if (name && isLegacySpaceName(name, instanceName)) {
      const renamed = spaceDisplayName(instanceName);
      await roomOps.setRoomName(spaceId, renamed);
      logger.info(`[identity] 空间名已迁移: ${name} → ${renamed}`);
    }
  } catch (err) {
    logger.warn(`[identity] 空间改名检查失败(跳过,下次启动自动重试): ${spaceId}: ${(err as Error).message}`);
  }

  // Avatars: three per-set pools (spec #84) — the space picks from the
  // landscape set by instance name, the management room has the cottage set's
  // dedicated image, project rooms pick from the cottage set by project name
  // (roomId fallback for legacy records without one) — same name, same image,
  // forever. Each set migrates through the shared per-set driver
  // (migrateAvatarSet): while a set's marker in config lags behind
  // AVATAR_SET_VERSION (a restyle of THAT set shipped), the set's rooms are
  // re-branded once; the marker is booked only after every one of the set's
  // rooms succeeded — a failed room retries that set's migration next start
  // while other sets book normally.
  const brandRoom = async (roomId: string, file: string, label: string, rebrand: boolean): Promise<boolean> => {
    try {
      const result = await ensureRoomAvatar(roomOps, roomId, file, { rebrand });
      if (result === "set") logger.info(`[identity] ${label}头像已设置: ${file}`);
      if (result === "rebranded") logger.info(`[identity] ${label}头像已升级为新风格: ${file}`);
      return true;
    } catch (err) {
      logger.warn(`[identity] ${label}(${roomId})头像设置失败(跳过,下次启动自动重试): ${(err as Error).message}`);
      return false;
    }
  };

  await migrateAvatarSet(store, cfg, "space", (rebrand) =>
    brandRoom(spaceId, pickPoolAvatarFile(instanceName, "space"), "空间", rebrand),
  );

  const roomTargets: Array<{ roomId: string; file: string; label: string }> = [];
  const mgmtRoomId = managementRoomId(cfg);
  if (mgmtRoomId) {
    roomTargets.push({ roomId: mgmtRoomId, file: managementAvatarFile(), label: "管理房间" });
  }
  for (const [roomId, project] of Object.entries(cfg.projects ?? {})) {
    roomTargets.push({
      roomId,
      file: pickPoolAvatarFile(project.name ?? roomId, "room"),
      label: `项目房间 ${project.name ?? roomId}`,
    });
  }
  await migrateAvatarSet(store, cfg, "room", async (rebrand) => {
    let allOk = true;
    for (const target of roomTargets) {
      // A failed room warns here (with its label) and keeps the ROOM set
      // pending; the space set has already booked independently above.
      if (!(await brandRoom(target.roomId, target.file, target.label, rebrand))) allOk = false;
    }
    return allOk;
  });
}

/** Startup self-heal for the bot account's own face (spec #84 ticket 2): the
 *  agent-set avatar picked by instance-name hash, set on the bot's Matrix
 *  profile — one face for the whole account, shown in every member list and
 *  next to every message the bot sends. Default policy is 只补缺: a bot that
 *  already has a profile avatar keeps it (a manually set face is respected,
 *  same rule as room avatars). While the agent art-set version is pending
 *  (bookedAvatarVersion lags AVATAR_SET_VERSION.agent — a restyle shipped),
 *  the profile avatar is set unconditionally and the marker is booked only
 *  after success; a failure warns and retries next start, never booking.
 *  The pending→换装→记账 loop is the shared migrateAvatarSet driver — the
 *  same one the room identity heal uses for its two sets.
 *  Runs in every mode (space or degraded): the bot account exists either way.
 *  Never throws — purely cosmetic, must not touch the startup tri-state. */
export async function healBotAvatar(roomOps: RoomOps, store: ConfigStore): Promise<void> {
  const cfg = store.get();
  await migrateAvatarSet(store, cfg, "agent", async (rebrand) => {
    try {
      const had = await roomOps.getProfileAvatarUrl();
      if (had && !rebrand) return true;
      const file = pickPoolAvatarFile(effectiveInstanceName(cfg), "agent");
      const data = readAvatarBundled(file);
      const mxcUrl = await roomOps.uploadMedia(data, "image/png");
      await roomOps.setProfileAvatar(mxcUrl);
      logger.info(`[identity] bot 头像已${had ? "更新" : "设置"}(agent 套): ${file}`);
      return true;
    } catch (err) {
      // Failed set: stay pending so the next start retries the whole agent
      // migration — the marker is only ever booked on a confirmed success.
      logger.warn(`[identity] bot 头像设置失败(跳过,下次启动自动重试): ${(err as Error).message}`);
      return false;
    }
  });
}
