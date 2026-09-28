/**
 * Management-room naming + usage guide — the single assembly point for the
 * management room's user-facing text. Both entry points (DM adoption and the
 * bot-created room in the startup space ensure — both in space.ts) import
 * from here so the two can never drift. All copy comes from the i18n tables
 * (issue #83) — the locale is fixed at startup; already-created rooms keep
 * their original name/guide (no retroactive rebranding).
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
