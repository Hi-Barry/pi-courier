/**
 * Management-room concept home: naming + usage guide (the single assembly
 * point for the management room's user-facing text — DM adoption and the
 * bot-created room in the startup space ensure both import from here so the
 * two can never drift) AND the「至多一个管理房」adoption-write invariant
 * (架构候选4). All copy comes from the i18n tables (issue #83) — the locale
 * is fixed at startup; already-created rooms keep their original name/guide
 * (no retroactive rebranding).
 */

import { t } from "./i18n/index.js";

/** Management-room display name. */
export function managementRoomName(instanceName: string): string {
  return t("mgmt.name", { name: instanceName });
}

/**
 * 群聊入群提示(spec #72 票2/C2):住在管理文案单点而非 transport —— /enable
 * 的用法知识归 router 侧,transport 只负责发送。房间成员数超过两人且未启用
 * 时由 transport 的 room.join 钩子调用。
 */
export function buildGroupJoinHint(): string {
  return t("mgmt.groupJoinHint");
}

/**
 * Build the management-room guide, labelled with the instance name, the bot
 * account and the working directory — so when the bridge runs on several
 * machines you can tell which project belongs to which box/account.
 */
export function buildManagementRoomHelp(
  instanceName: string,
  botAccount: string,
  workdir: string
): string {
  return t("mgmt.help", { instanceName, botAccount, workdir });
}

/** 「管理房至多一个」的收养写侧不变量(架构候选4,2026-10-27 扫描批次
 *  收窄形状):已有管理房(列表非空)→ undefined 拒绝再写;空/未配置 →
 *  单元素新列表。原来这条不变量靠调用方先查 managementRoomId 的纪律维持
 *  (config 注释自称「两条写路径都保证」,而原实现是 append),现结构化于
 *  此——config 的 adoptManagementRoom 委托本函数并翻译为 patch 形状,未来
 *  新写路径不可能悄悄破坏不变量。返回窄形状:新列表或 undefined(拒绝),
 *  patch 装配知识归 config 侧单一适配器,不再让每个调用方懂展开语义。
 *  读侧语义不变:managementRoomId 取首个(权威读取器,仍在 config);
 *  手编残留的全表容忍归 power-heal 的 managedRoomIds(spec #99 评审修复)。 */
export function nextManagementRooms(
  current: readonly string[] | undefined,
  roomId: string
): string[] | undefined {
  if (current && current.length > 0) return undefined;
  return [roomId];
}
