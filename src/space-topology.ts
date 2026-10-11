/**
 * Startup space ensure + the managed-room provision deep function (票2,
 * spec #99): `provisionManagedRoom` holds the invariant「中途建的房间 ≡
 * 启动自愈后的房间」— one four-step path (create → elevate → space-link →
 * brand) shared by /pmctl new and the startup ensure. Elevation comes from
 * power-heal, branding from room-branding — this module is the topology
 * orchestrator (rooms, links, invites, adoption bookkeeping).
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
import { errorMessage } from "./errors.js";
import { t } from "./i18n/index.js";
import { logger } from "./logger.js";
import { buildManagementRoomHelp, managementRoomName } from "./management-room.js";
import { elevateTrustedUsersInRoom } from "./power-heal.js";
import { ensureRoomAvatar } from "./room-branding.js";
import { managementAvatarFile, pickPoolAvatarFile, spaceDisplayName } from "./space-identity.js";
import type { RoomOps } from "./transports/interface.js";
import type { ExternalMessage } from "./types.js";

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
            // freshly created room is the single-element write this used to be.
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
        const botAccount = roomOps.getBotUserId() ?? t("common.unknownAccount");
        await sendReply(
          mgmtRoomId,
          "matrix",
          `${buildManagementRoomHelp(instanceName, botAccount, workdir)}\n\n` +
            `${t("mgmt.adminPowerNote")}`
        );
      } catch (err) {
        // The usage guide is nice-to-have; room setup must not depend on it.
        logger.debug(`[space] usage guide send skipped: ${errorMessage(err)}`);
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
      `[space] 空间初始化失败,本次以无空间模式运行(下次启动自动重试): ${errorMessage(err)}`
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
  // 已有管理房(含本房间即管理房)一律不再品牌化另一个(两守卫合并:审计工程批 票20)
  if (existing !== undefined) return;
  try {
    const instanceName = effectiveInstanceName(cfg);
    const botAccount = roomOps.getBotUserId() ?? t("common.unknownAccount");
    const workdir = effectiveWorkdir(cfg);
    const roomName = managementRoomName(instanceName);
    await roomOps.setRoomName(msg.chatId, roomName);
    await sendReply(msg.chatId, msg.transport, buildManagementRoomHelp(instanceName, botAccount, workdir));
    // The guards above mean the list was empty — adopt writes the single entry.
    store.update(adoptManagementRoom(cfg, msg.chatId));
    logger.info(`[project] 管理房间已初始化: ${msg.chatId} (${roomName})`);
  } catch (err) {
    // Non-matrix transport or transient failure — skip branding, try again
    // later. 降级必留痕:品牌化/收养哪一步败了、为什么(审计稳定性批 票12)。
    logger.warn(`[project] 管理房间初始化失败(跳过,下次启动自动重试): ${errorMessage(err)}`);
  }
}

/** 挂链/品牌失败的警告附注 —— 单点文案(票2,spec #99):两条置备路径共用,
 *  不再各自手写、不再漂移。挂链的重试语义随变体而不同:管理房每次启动由
 *  ensure 重申链接(自动重试);项目房没有对应的重申,失败不影响项目本身。
 *  品牌失败两条路径语义一致:启动身份自愈兜底(下次启动自动补)。文案不含
 *  渠道前缀 —— /pmctl 拼成 ⚠️ 行进成功回执,启动 ensure 打 warn 日志。 */
function spaceLinkNote(kind: "project" | "management", err: unknown): string {
  const msg = errorMessage(err);
  return kind === "management"
    ? t("space.linkFailedMgmt", { message: msg })
    : t("space.linkFailed", { message: msg });
}

function avatarNote(err: unknown): string {
  return t("space.avatarFailed", { message: errorMessage(err) });
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
 * 路径 elevateTrustedUsersInRoom(#41/#42,信任即管理员,power-heal),失败记入
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

  // 提权:既有幂等路径(#41/#42,power-heal)。失败不阻塞后续步骤,由调用方按渠道报告;
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
    logger.warn(`[space] 邀请 ${namespacedUser} 进空间失败(下次启动自愈): ${errorMessage(err)}`);
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
    logger.warn(`[space] 邀请 ${namespacedUser} 进管理房间失败(下次启动自愈): ${errorMessage(err)}`);
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
