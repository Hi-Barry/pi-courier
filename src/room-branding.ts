/**
 * Room & bot identity branding (spec #84): the bundled art sets, applied as
 * avatars — the space picks from the landscape set by instance name, the
 * management room has the architecture set's dedicated image, project rooms
 * pick from the architecture set by project name (first-free-slot dedup, so
 * sibling rooms in one space never share an image), and the bot account
 * carries the agent set's profile face. Startup identity self-heal (只补缺 +
 * per-set version migration) lives here; the /pmctl-new provisioning path
 * calls ensureRoomAvatar directly for mid-session rooms.
 *
 * v5 user overrides: `spaceAvatar` / `botAvatar` / `projects[].avatar` point
 * at a custom image file. A configured override is desired state — the heal
 * re-uploads whenever the file's sha256 or the target's current avatar no
 * longer matches the bookkeeping ref (config.spaceAvatarRef / botAvatarRef /
 * roomAvatarRefs), instead of 只补缺. While an override is in effect for a
 * scope, that scope's bundled-set migration stays pending: removing the
 * override makes the next start rebrand the scope from the bundled pool
 * once. A broken override (missing file / unsupported extension / upload
 * failure) warns and falls through to the bundled logic for that start, so a
 * target never ends up without a face.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  activeSpaceRoomId,
  botAvatarPath,
  type ConfigStore,
  customAvatarMime,
  effectiveInstanceName,
  isSpaceMode,
  managementRoomId,
  projectAvatarPath,
  spaceAvatarPath,
} from "./config.js";
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
  poolAvatarSlot,
  readAvatarBundled,
  spaceDisplayName,
} from "./space-identity.js";
import type { RoomOps } from "./transports/interface.js";
import type { AvatarCustomRef, MsgBridgeConfig } from "./types.js";

/** Brand ONE room with the bundled avatar. Default policy is 只补缺: a room
 *  that already has an avatar keeps it. With `rebrand` (the startup heal,
 *  while the room's art-set version migration is pending), an existing avatar
 *  is replaced unconditionally — a set restyle re-brands that set's managed
 *  rooms once, whoever set the current image. Throws on failure — callers pick
 *  the policy (the startup heal warns + retries next start; the /pmctl new
 *  path surfaces a non-fatal note). Returns what happened: "set" (room had
 *  none), "rebranded" (old avatar replaced) or "kept". Shared by the startup
 *  identity heal, the project-room creation path (a mid-session room must
 *  not wait for the next restart to get its face) and the /pmctl rename
 *  re-pick. */
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

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Read a custom avatar file → {data, mime}. Throws when the extension is
 *  unsupported or the file unreadable — callers treat that as "override
 *  broken this boot" (warn + fall through to the bundled pool). */
function readCustomAvatar(filePath: string): { data: Buffer; mime: string } {
  const mime = customAvatarMime(filePath);
  if (!mime) throw new Error(`unsupported avatar extension: ${filePath}`);
  return { data: readFileSync(filePath), mime };
}

function refsDiffer(a: AvatarCustomRef | undefined, b: AvatarCustomRef): boolean {
  return a?.sha256 !== b.sha256 || a?.mxc !== b.mxc;
}

/** 自定义头像期望态内核(2026-10-27 扫描批次 D 收敛):room/space/bot 三个
 *  apply*CustomAvatar 同形 —— 读文件+哈希 →「记账 ref 与文件内容(sha256)、
 *  目标当前头像(mxc)双比对」才重传 → 成功才记账;仅三处不同:当前头像
 *  读取、设置动作、记账键(room 是 per-room map,space/bot 是标量),经
 *  currentMxc/apply/book 注入。维护不变量(比对才重传、成功才记账)一份
 *  直测,改规则不再三处同步。Throws on failure —— 回落策略归调用方。 */
async function applyCustomAvatar(opts: {
  roomOps: RoomOps;
  filePath: string;
  booked: AvatarCustomRef | undefined;
  currentMxc: () => Promise<string | undefined | null>;
  apply: (mxcUrl: string, info: Record<string, unknown>) => Promise<void>;
  book: (ref: AvatarCustomRef) => void;
}): Promise<"kept" | "set"> {
  const { data, mime } = readCustomAvatar(opts.filePath);
  const sha256 = sha256Hex(data);
  if (opts.booked && opts.booked.sha256 === sha256 && (await opts.currentMxc()) === opts.booked.mxc) {
    return "kept";
  }
  const mxcUrl = await opts.roomOps.uploadMedia(data, mime);
  await opts.apply(mxcUrl, avatarInfo(data, mime));
  const ref: AvatarCustomRef = { sha256, mxc: mxcUrl };
  if (refsDiffer(opts.booked, ref)) opts.book(ref);
  return "set";
}

/** Custom-avatar desired state for ONE project room: keep when the booked ref
 *  still matches both the file content (sha256) and the room's current avatar
 *  URL; re-upload + overwrite + re-book (config.roomAvatarRefs) otherwise.
 *  Throws on failure — callers decide the fallback policy. Returns what
 *  happened: "kept" or "set". Shared by the startup heal, the /pmctl new
 *  provisioning path and the /pmctl rename re-pick. */
export async function applyRoomCustomAvatar(
  roomOps: RoomOps,
  store: ConfigStore,
  roomId: string,
  filePath: string,
): Promise<"kept" | "set"> {
  return applyCustomAvatar({
    roomOps,
    filePath,
    booked: store.get().roomAvatarRefs?.[roomId],
    currentMxc: () => roomOps.getRoomAvatar(roomId),
    apply: (mxcUrl, info) => roomOps.setRoomAvatar(roomId, mxcUrl, info),
    book: (ref) => {
      const refs = { ...(store.get().roomAvatarRefs ?? {}) };
      refs[roomId] = ref;
      store.update({ roomAvatarRefs: refs });
    },
  });
}

/** Dedup-aware bundled picks for every configured project room, in config
 *  order: each room starts at its own name bucket and steps forward over
 *  slots an earlier sibling already took (first-free-slot), so two project
 *  rooms in one space never land on the same image. Rooms in `skipRoomIds`
 *  (custom overrides in effect) take no slot. Deterministic: same config →
 *  same assignment. */
export function poolFilesForProjects(
  cfg: MsgBridgeConfig,
  skipRoomIds?: ReadonlySet<string>,
): Map<string, string> {
  const files = new Map<string, string>();
  const occupied = new Set<number>();
  for (const [roomId, project] of Object.entries(cfg.projects ?? {})) {
    if (skipRoomIds?.has(roomId)) continue;
    const file = pickPoolAvatarFile(project.name ?? roomId, "room", occupied);
    occupied.add(poolAvatarSlot(file));
    files.set(roomId, file);
  }
  return files;
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
 *  affects the startup tri-state.
 *  v5 overrides: a configured custom avatar (spaceAvatar / projects[].avatar)
 *  is enforced as desired state for its target and takes that target out of
 *  the bundled pass; the space-set migration stays pending while a space
 *  override is in effect (removing it rebrands once from the bundled pool). */
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
    logger.warn(`[identity] 空间改名检查失败(跳过,下次启动自动重试): ${spaceId}: ${errorMessage(err)}`);
  }

  const brandRoom = async (roomId: string, file: string, label: string, rebrand: boolean): Promise<boolean> => {
    try {
      const result = await ensureRoomAvatar(roomOps, roomId, file, { rebrand });
      if (result === "set") logger.info(`[identity] ${label}头像已设置: ${file}`);
      if (result === "rebranded") logger.info(`[identity] ${label}头像已升级为新风格: ${file}`);
      return true;
    } catch (err) {
      logger.warn(`[identity] ${label}(${roomId})头像设置失败(跳过,下次启动自动重试): ${errorMessage(err)}`);
      return false;
    }
  };

  // Space avatar: custom override wins (desired state); broken override
  // falls through to the bundled pool for this start.
  const spaceCustomPath = spaceAvatarPath(cfg);
  if (spaceCustomPath) {
    try {
      const outcome = await applySpaceCustomAvatar(roomOps, store, spaceId, spaceCustomPath);
      logger.info(`[identity] 空间自定义头像已维护(${outcome === "kept" ? "保持" : "已上传"}): ${spaceCustomPath}`);
    } catch (err) {
      logger.warn(`[identity] 空间自定义头像不可用(${errorMessage(err)}),本启动回落内置图池: ${spaceCustomPath}`);
      await migrateAvatarSet(store, cfg, "space", (rebrand) =>
        brandRoom(spaceId, pickPoolAvatarFile(instanceName, "space"), "空间", rebrand),
      );
    }
  } else {
    await migrateAvatarSet(store, cfg, "space", (rebrand) =>
      brandRoom(spaceId, pickPoolAvatarFile(instanceName, "space"), "空间", rebrand),
    );
  }

  // Project rooms: custom overrides first (desired state, booking included);
  // a room whose override is broken this boot joins the bundled pass below.
  const customOk = new Set<string>();
  for (const [roomId, project] of Object.entries(cfg.projects ?? {})) {
    const filePath = projectAvatarPath(project);
    if (!filePath) continue;
    const label = `项目房间 ${project.name ?? roomId}`;
    try {
      const outcome = await applyRoomCustomAvatar(roomOps, store, roomId, filePath);
      customOk.add(roomId);
      logger.info(`[identity] ${label}自定义头像已维护(${outcome === "kept" ? "保持" : "已上传"}): ${filePath}`);
    } catch (err) {
      logger.warn(`[identity] ${label}自定义头像不可用(${errorMessage(err)}),本启动回落内置图池: ${filePath}`);
    }
  }

  // Bundled pool for the rest — dedup-aware: every project room starts at its
  // own name bucket and skips slots its siblings already took; successful
  // custom rooms take no slot. Management room keeps its dedicated image.
  const roomTargets: Array<{ roomId: string; file: string; label: string }> = [];
  const mgmtRoomId = managementRoomId(cfg);
  if (mgmtRoomId) {
    roomTargets.push({ roomId: mgmtRoomId, file: managementAvatarFile(), label: "管理房间" });
  }
  const poolFiles = poolFilesForProjects(cfg, customOk);
  for (const [roomId, project] of Object.entries(cfg.projects ?? {})) {
    if (customOk.has(roomId)) continue;
    roomTargets.push({
      roomId,
      file: poolFiles.get(roomId) ?? pickPoolAvatarFile(project.name ?? roomId, "room"),
      label: `项目房间 ${project.name ?? roomId}`,
    });
  }
  await migrateAvatarSet(store, cfg, "room", async (rebrand) => {
    // 目标房间相互独立,并行品牌化;单房失败照旧留痕并让该组保持待重刷
    // (审计工程批 票22)。brandRoom 自带逐目标容错(warn + false),并行只是
    // 省时;零图池目标(全部走自定义)时不记账——整套自定义撤销后下次启动
    // 仍能从图池整刷一次。
    const results = await Promise.all(roomTargets.map((target) => brandRoom(target.roomId, target.file, target.label, rebrand)));
    return roomTargets.length > 0 && results.every(Boolean);
  });
}

/** Custom-avatar desired state for the space itself (config.spaceAvatar →
 *  config.spaceAvatarRef booking). Throws on failure — the caller falls back
 *  to the bundled pool path. */
async function applySpaceCustomAvatar(
  roomOps: RoomOps,
  store: ConfigStore,
  spaceId: string,
  filePath: string,
): Promise<"kept" | "set"> {
  return applyCustomAvatar({
    roomOps,
    filePath,
    booked: store.get().spaceAvatarRef,
    currentMxc: () => roomOps.getRoomAvatar(spaceId),
    apply: (mxcUrl, info) => roomOps.setRoomAvatar(spaceId, mxcUrl, info),
    book: (ref) => store.update({ spaceAvatarRef: ref }),
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
 *  v5 override: a configured botAvatar is enforced as desired state
 *  (config.botAvatarRef booking) and keeps the agent-set migration pending —
 *  removing it rebrands once from the bundled pool.
 *  Runs in every mode (space or degraded): the bot account exists either way.
 *  Never throws — purely cosmetic, must not touch the startup tri-state. */
export async function healBotAvatar(roomOps: RoomOps, store: ConfigStore): Promise<void> {
  const cfg = store.get();
  const customPath = botAvatarPath(cfg);
  if (customPath) {
    try {
      const outcome = await applyBotCustomAvatar(roomOps, store, customPath);
      logger.info(`[identity] bot 自定义头像已维护(${outcome === "kept" ? "保持" : "已上传"}): ${customPath}`);
      return;
    } catch (err) {
      logger.warn(`[identity] bot 自定义头像不可用(${errorMessage(err)}),本启动回落内置图池: ${customPath}`);
    }
  }
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
      logger.warn(`[identity] bot 头像设置失败(跳过,下次启动自动重试): ${errorMessage(err)}`);
      return false;
    }
  });
}

/** Custom-avatar desired state for the bot's own profile (config.botAvatar →
 *  config.botAvatarRef booking). Throws on failure — the caller falls back to
 *  the bundled agent-pool path. */
async function applyBotCustomAvatar(
  roomOps: RoomOps,
  store: ConfigStore,
  filePath: string,
): Promise<"kept" | "set"> {
  return applyCustomAvatar({
    roomOps,
    filePath,
    booked: store.get().botAvatarRef,
    currentMxc: () => roomOps.getProfileAvatarUrl(),
    apply: (mxcUrl) => roomOps.setProfileAvatar(mxcUrl),
    book: (ref) => store.update({ botAvatarRef: ref }),
  });
}
