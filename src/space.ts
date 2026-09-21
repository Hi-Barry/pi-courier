/**
 * Startup space ensure + trusted-user permission self-heal, plus the managed-
 * room provision deep function (票2, spec #99): `provisionManagedRoom` holds
 * the invariant「中途建的房间 ≡ 启动自愈后的房间」— one four-step path
 * (create → elevate → space-link → brand) shared by /pmctl new and the
 * startup ensure, with the per-set avatar rule kept inside this module.
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

import { activeSpaceRoomId, adoptManagementRoom, type ConfigStore, effectiveInstanceName, effectiveWorkdir, isSpaceMode, managementRoomId, nativeMxid } from "./config.js";
import { logger } from "./logger.js";
import { buildManagementRoomHelp, managementRoomName } from "./management-room.js";
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
import type { ExternalMessage, MsgBridgeConfig } from "./types.js";

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

  const instanceName = effectiveInstanceName(cfg);
  const inviteUserIds = (cfg.auth?.trustedUsers ?? []).map(nativeMxid);
  const workdir = effectiveWorkdir(cfg);

  try {
    let spaceId = cfg.space?.roomId;
    if (!spaceId) {
      spaceId = await roomOps.createSpace({
        name: spaceDisplayName(instanceName),
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

    let mgmtRoomId = managementRoomId(cfg);
    let mgmtRoomCreated = false;
    if (!mgmtRoomId) {
      // 置备深函数(票2):建房 → 提权 → 挂链 → 品牌,与 /pmctl new 同一条
      // 路径 —— 中途建的管理房与启动自愈后的房间长相/权限一致。落簿钩子把
      // "房间已存在"先于可选步骤落盘,崩溃不会导致下次启动重复建房。
      const provisioned = await provisionManagedRoom(roomOps, store, {
        kind: "management",
        name: managementRoomName(instanceName),
        inviteUserIds,
        onCreated: ({ roomId }) => {
          // Creation's invite list covered every trusted user — record them in
          // the management bookkeeping too (mirror of invitedUsers above) so
          // the self-heal never re-invites them (Matrix rejects re-invites).
          store.update({
            // The guard above means the list was empty here — adopting the
            // freshly created room appends exactly the single-element write
            // this used to be.
            ...adoptManagementRoom(cfg, roomId),
            space: {
              ...(store.get().space ?? {}),
              managementInvitedUsers: cfg.auth?.trustedUsers ?? [],
            },
          });
        },
      });
      mgmtRoomId = provisioned.roomId;
      mgmtRoomCreated = true;
      logger.info(
        `[space] 管理房间已创建: ${mgmtRoomId}${provisioned.encrypted ? " (E2EE)" : ""}`
      );
      // 附注(挂链/品牌失败)由启动路径以 warn 投递;提权失败不在此重复报告
      // —— 紧随启动的 healTrustedPowerLevels 扫描以既有文案警告并下次重试。
      for (const note of provisioned.notes) logger.warn(`[space] ${note}`);
      try {
        const botAccount = roomOps.getBotUserId() ?? "(未知)";
        await sendReply(
          mgmtRoomId,
          "matrix",
          `${buildManagementRoomHelp(instanceName, botAccount, workdir)}\n\n` +
            `🛡️ 信任用户会自动获得房间管理员权限(含新建的项目房间)。`
        );
      } catch {
        // The usage guide is nice-to-have; room setup must not depend on it.
      }
    }

    // (Re-)assert the link for a room THIS RUN DID NOT CREATE — idempotent
    // state, best-effort. It self-heals a failed link from an earlier start,
    // and a legacy adopted DM (bot not its owner) may reject the child-side
    // parent event. A freshly provisioned room was already linked inside the
    // deep function (its failure surfaced as a note above).
    if (!mgmtRoomCreated) {
      try {
        await roomOps.addRoomToSpace(spaceId, mgmtRoomId);
        logger.debug(`[space] 空间链接就绪: ${mgmtRoomId} → ${spaceId}`);
      } catch (err) {
        logger.warn(`[space] ${spaceLinkNote("management", err)}`);
      }
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

/**
 * First-time branding for the DM adoption path (spec #99 票3 / issue #104:
 * moved here from the router — 收养是空间侧的管理房语义,router 只调用):
 * rename the room to "项目管理(<instance>)" and send the usage guide.
 * Idempotent via config.managementRooms so restarts don't re-trigger (and a
 * user-renamed room is never overwritten). 管理房判定走 config 的
 * managementRoomId 派生,收养写走 adoptManagementRoom(收养写侧单点)。
 */
export async function maybeInitManagementRoom(
  msg: ExternalMessage,
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>,
  roomOps: RoomOps,
  store: ConfigStore
): Promise<void> {
  const cfg = store.get();
  const existing = managementRoomId(cfg);
  if (existing === msg.chatId) return; // already the management room
  if (existing !== undefined) return; // a management room already exists — never brand another
  try {
    const instanceName = effectiveInstanceName(cfg);
    const botAccount = roomOps.getBotUserId() ?? "(未知)";
    const workdir = effectiveWorkdir(cfg);
    const roomName = managementRoomName(instanceName);
    await roomOps.setRoomName(msg.chatId, roomName);
    await sendReply(msg.chatId, msg.transport, buildManagementRoomHelp(instanceName, botAccount, workdir));
    // The guards above mean the list was empty — adopt appends the first entry.
    store.update(adoptManagementRoom(cfg, msg.chatId));
    logger.info(`[project] 管理房间已初始化: ${msg.chatId} (${roomName})`);
  } catch {
    // Non-matrix transport or transient failure — skip branding, try again later.
  }
}

/** 挂链/品牌失败的警告附注 —— 单点文案(票2,spec #99):两条置备路径共用,
 *  不再各自手写、不再漂移。挂链的重试语义随变体而不同:管理房每次启动由
 *  ensure 重申链接(自动重试);项目房没有对应的重申,失败不影响项目本身。
 *  品牌失败两条路径语义一致:启动身份自愈兜底(下次启动自动补)。文案不含
 *  渠道前缀 —— /pmctl 拼成 ⚠️ 行进成功回执,启动 ensure 打 warn 日志。 */
function spaceLinkNote(kind: "project" | "management", err: unknown): string {
  const msg = (err as Error).message;
  return kind === "management"
    ? `管理房间挂入空间失败(下次启动自动重试,房间仍可用): ${msg}`
    : `挂入空间失败(不影响项目): ${msg}`;
}

function avatarNote(err: unknown): string {
  return `头像设置失败(下次启动自动补): ${(err as Error).message}`;
}

/** 建房成功后、可选步骤之前的落簿钩子(崩溃安全):两条路径各自的持久化
 *  (/pmctl 注册项目;启动 ensure 收养管理房)必须先于提权/挂链/品牌落盘,
 *  进程崩溃才不会在下次启动重复建房。抛错向上传播(沿用调用方既有失败
 *  语义:/pmctl 报"创建项目失败",ensure 整体降级)。 */
type ManagedRoomCreatedHook = (created: { roomId: string; encrypted: boolean }) => Promise<void> | void;

/** 房间意图(票2,spec #99 / issue #103):置备深函数的输入。 */
export type ManagedRoomIntent =
  | {
      /** 项目房:createProjectRoom 单人邀请,小屋套按项目名选图。 */
      kind: "project";
      name: string;
      /** 被邀请人(原生 MXID,单人)。 */
      inviteUserId: string;
      /** 小屋套选图键(项目名)。 */
      projectName: string;
      onCreated?: ManagedRoomCreatedHook;
    }
  | {
      /** 管理房:createRoom 全量邀请,E2EE 按配置与加密能力判定,管理专用图。 */
      kind: "management";
      name: string;
      /** 邀请名单(原生 MXID;启动 ensure 传全部信任用户)。 */
      inviteUserIds: string[];
      onCreated?: ManagedRoomCreatedHook;
    };

export interface ManagedRoomProvision {
  roomId: string;
  /** 建房时实际生效的 E2EE 状态(管理房按配置开关 + 加密能力判定;项目房
   *  恒 false)—— 供调用方回读日志,不必再猜一遍判定规则。 */
  encrypted: boolean;
  /** 提权失败(非阻塞;既有幂等路径,下次启动自愈)。启动路径由紧随其后的
   *  healTrustedPowerLevels 扫描以既有文案警告并重试,可忽略此字段。 */
  elevationError?: Error;
  /** 挂链/品牌失败的警告附注(单点文案;空数组 = 全部成功)。 */
  notes: string[];
}

/**
 * 置备一个托管房间的深函数(票2,spec #99 / issue #103):建房 → 信任用户
 * 提权 → 挂入空间(best-effort)→ 按套品牌(best-effort),一步到位。
 * /pmctl new 的项目房与启动 ensure 的管理房都走这里 ——「中途建的房间 ≡
 * 启动自愈后的房间长相/权限一致」这条不变量由本函数持有:同一房间意图
 * 经过它,产出相同的房间操作序列(等价性钉点见
 * tests/provision-managed-room.test.ts)。按套选图的素材映射规则(项目房 =
 * 小屋套按项目名选图、管理房 = 管理专用图)也收回模块内部,调用方不再
 * 直接触 pickPoolAvatarFile。
 *
 * 失败语义:建房失败向上抛(房间不存在,调用方各自处理);提权走既有幂等
 * 路径 elevateTrustedUsersInRoom(#41/#42,信任即管理员),失败记入
 * elevationError,不阻塞;挂链与品牌失败产出单点文案附注 notes,不抛 ——
 * 调用方决定投递渠道。
 */
export async function provisionManagedRoom(
  roomOps: RoomOps,
  store: ConfigStore,
  intent: ManagedRoomIntent
): Promise<ManagedRoomProvision> {
  // 建房:变体决定原语与 E2EE —— 项目房走 createProjectRoom(与既有行为
  // 一致,不带加密态);管理房走 createRoom,按配置开关 + 加密能力判定。
  const encrypted =
    intent.kind === "management" &&
    store.get().matrix?.encryption !== false &&
    roomOps.encryptionAvailable;
  const roomId =
    intent.kind === "project"
      ? await roomOps.createProjectRoom(intent.name, intent.inviteUserId)
      : await roomOps.createRoom({ name: intent.name, inviteUserIds: intent.inviteUserIds, encrypted });
  // 落簿钩子:先于一切可选步骤 —— 房间已存在的事实先落盘,崩溃才不会在
  // 下次启动重复建房(两条路径的历史契约,见 ensure 内联注释)。
  await intent.onCreated?.({ roomId, encrypted });

  // 提权:既有幂等路径(#41/#42)。失败不阻塞后续步骤,由调用方按渠道报告;
  // 启动路径另有紧随的扫描兜底。
  let elevationError: Error | undefined;
  try {
    await elevateTrustedUsersInRoom(roomOps, store, roomId);
  } catch (err) {
    elevationError = err as Error;
  }

  const notes: string[] = [];

  // 挂入空间(best-effort):空间未物化(功能关停或降级)则整体跳过。
  const spaceId = activeSpaceRoomId(store.get());
  if (spaceId) {
    try {
      await roomOps.addRoomToSpace(spaceId, roomId);
    } catch (err) {
      notes.push(spaceLinkNote(intent.kind, err));
    }
  }

  // 按套品牌(best-effort):选图规则在模块内部 —— 项目房按项目名选小屋套,
  // 管理房用管理专用图;失败由启动身份自愈兜底(只补缺,不覆盖)。
  try {
    const file =
      intent.kind === "project" ? pickPoolAvatarFile(intent.projectName, "room") : managementAvatarFile();
    await ensureRoomAvatar(roomOps, roomId, file);
  } catch (err) {
    notes.push(avatarNote(err));
  }

  return { roomId, encrypted, elevationError, notes };
}

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
  if (rebrand && allOk) store.update(avatarVersionMarker(set));
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

/** Shared invite outcome (issue #62): whether the invite went out or the
 *  user was already in the room, the bookkeeping write is the same — one
 *  list key gets the user appended. Already-in-room logs at info with its
 *  own phrasing so the two cases stay distinguishable in the journal. */
function recordInvited(
  store: ConfigStore,
  listKey: "invitedUsers" | "managementInvitedUsers",
  invited: string[],
  namespacedUser: string,
  already: boolean,
  where: string
): true {
  store.update({
    space: { ...(store.get().space ?? {}), [listKey]: [...invited, namespacedUser] },
  });
  logger.info(
    already
      ? `[space] ${namespacedUser} 已在${where},无需重复邀请`
      : `[space] 信任用户已邀请进${where}: ${namespacedUser}`
  );
  return true;
}

/** Fire-once space invite for ONE namespaced user. Bookkeeping: space.
 *  invitedUsers — every user we have invited (decliners included) so nobody
 *  is pinged twice. A failed invite is NOT recorded — the startup ensure
 *  self-heals it. Single implementation shared by the router's spaceInvite
 *  effect and the ensure's self-heal pass. Returns true when the invite
 *  went out (or was already effectively done — issue #62). */
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
    return recordInvited(store, "invitedUsers", invited, namespacedUser, false, "空间");
  } catch (err) {
    if (isAlreadyInRoomError(err)) {
      // Issue #62: the invite's goal state is already reached — record it so
      // the startup self-heal stops re-inviting (and failing) on every boot.
      return recordInvited(store, "invitedUsers", invited, namespacedUser, true, "空间");
    }
    logger.warn(`[space] 邀请 ${namespacedUser} 进空间失败(下次启动自愈): ${(err as Error).message}`);
    return false;
  }
}

/** Fire-once management-room invite for ONE namespaced user — the issue #43
 *  twin of inviteUserToSpaceOnce: the management room is where /pmctl lives,
 *  and a space member who was never invited into it could see the room under
 *  the space but never enter it. Guards: space mode must be active with a
 *  created space (activeSpaceRoomId) AND a management room must exist
 *  (managementRoomId) — the degraded path's adopted management DM is never
 *  used to pull people in.
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
  const mgmtRoomId = managementRoomId(cfg);
  if (!mgmtRoomId) return false;
  const invited = cfg.space?.managementInvitedUsers ?? [];
  if (invited.includes(namespacedUser)) return false;
  try {
    await roomOps.inviteUser(mgmtRoomId, nativeMxid(namespacedUser));
    return recordInvited(store, "managementInvitedUsers", invited, namespacedUser, false, "管理房间");
  } catch (err) {
    if (isAlreadyInRoomError(err)) {
      // Issue #62: same as the space twin — already in the room means done.
      return recordInvited(store, "managementInvitedUsers", invited, namespacedUser, true, "管理房间");
    }
    logger.warn(`[space] 邀请 ${namespacedUser} 进管理房间失败(下次启动自愈): ${(err as Error).message}`);
    return false;
  }
}

/** Issue #62: an M_FORBIDDEN "already in the room" rejection means the
 *  invite's goal is already met — the user is in. Treating it as a failure
 *  made the startup self-heal re-invite (and fail) on every boot. */
export function isAlreadyInRoomError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /M_FORBIDDEN/.test(message) && /already in the room/i.test(message);
}
