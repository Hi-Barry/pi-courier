/**
 * Management-room naming + usage guide — the single assembly point for the
 * management room's user-facing text. Both entry points (DM adoption in the
 * router, bot-created room in the startup space ensure) import from here so
 * the two can never drift.
 */

/** Management-room display name. */
export function managementRoomName(instanceName: string): string {
  return `项目管理（${instanceName}）`;
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
  return (
    `🏗️ **项目管理房间**（${instanceName}）\n\n` +
    `• bot 账号: \`${botAccount}\`\n` +
    `• 默认工作目录: \`${workdir}\`\n\n` +
    `这里是本实例的管理台。直接发消息 = 在默认项目(${workdir})里与 pi 对话。\n\n` +
    `📁 **项目管理**(仅本房间可用)\n` +
    `• \`/pmctl new <名称> [路径]\` — 创建项目(自动建私有房间并拉你进入)\n` +
    `• \`/pmctl list\` — 项目列表\n` +
    `• \`/pmctl show|rm|mv|rename\` — 项目详情/删除/迁移/重命名\n\n` +
    `⚡ **常用命令**\n` +
    `• \`/stop\` — 停止当前任务\n` +
    `• \`/reload\` — 重启 pi 进程\n` +
    `• \`/help\` — 完整帮助`
  );
}
