/**
 * CommandDispatch — 管线命令族的处理器住址(#358,评审卡5 第一步)。
 *
 * 此前一个命令的一生摊在 4 个文件 6 个角色上:管线归属散在各阶段的局部
 * 正则,分层规则只活在注释里。第一步按族渐进:策略位(name/guest/audit/
 * stage)统一在 command-registry 登记;本模块收容族的处理器(pmctl/login
 * 先入住),router 的阶段壳只管编排 —— 后续族(admin/groupEnable/
 * roomToolsToggle/multiproject/slashCommands)按同款迁移。
 *
 * 审计 helper 一并归位:normalizeDetailLine(一行以内)同时被 router 的
 * slashCommands 审计接线引用(自本模块导出);redactLoginDetail 仅 login
 * 族使用。
 */

import { AUDIT_EVENTS } from "../audit/audit-log.js";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import type { LoginManager } from "../auth/headless-login.js";
import { t } from "../i18n/index.js";
import type { PmctlController } from "./pmctl-controller.js";

/** 审计落账缝(router 的 auditTrail 同形):谁(消息)干了什么(event)、
 *  一行以内的 detail。 */
export type CommandAudit = (
  event: string,
  actor: { userId: string; transport: string; chatId: string },
  detail?: string,
) => void;

/** 直发通道(与普通回复同一条 transport FIFO)。 */
export type CommandReply = (chatId: string, transport: string, text: string) => Promise<void>;

/** 审计 detail 归一:空白收敛 + 120 字符截断(敏感面 detail 一行以内)。 */
export function normalizeDetailLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * provider 位按内容判定(sec-redact-login-detail):形如 provider id 才
 * 原样保留 —— 全小写 kebab(字母开头、段内字母数字)、长度 ≤ 32、且不以
 * `sk-` 开头(密钥生态最常见前缀)。其余一律按潜在密钥折叠为 `***`:
 * 宁可掩掉一个命名怪异的 provider,也不让密钥落进审计 JSONL。已拦下的
 * 常见形态:oc_sk_*、sk-* 系、ghp_*、xox*、JWT(eyJ…)、含下划线/大写/
 * 数字开头的随机串、超长串。
 */
const looksLikeProviderId = (token: string): boolean =>
  token.length <= 32 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(token) && !token.startsWith("sk-");

/**
 * /login 族(/login /logout /auth)审计 detail 的脱敏(spec #211 / 票
 * sec-redact-login-detail):按「指令名 provider [方式词] [密钥…]」的结构
 * 脱敏,且每个保留位都按内容判定 —— 指令名固定保留;provider 位仅当形如
 * provider id(looksLikeProviderId)才保留,否则视为漏输 provider 段而顶到
 * 该位的密钥,折叠为 `***`;第 3 个 token 仅当是方式词(oauth|api_key,
 * 忽略大小写)时保留,其余 token 连同其后所有内容折叠为单个 `***`。
 * 掩码必须发生在截断之前,超长密钥才不会因截断漏出前半截。
 */
export function redactLoginDetail(text: string): string {
  const tokens = text.replace(/\s+/g, " ").trim().split(" ");
  const kept = tokens.slice(0, 1);
  if (tokens.length > 1) kept.push(looksLikeProviderId(tokens[1]!) ? tokens[1]! : "***");
  const rest = tokens.slice(2);
  if (rest.length > 0) {
    if (/^(oauth|api_key)$/i.test(rest[0]!)) {
      kept.push(rest[0]!);
      if (rest.length > 1) kept.push("***");
    } else {
      kept.push("***");
    }
  }
  return normalizeDetailLine(kept.join(" "));
}

/** /pmctl 族阶段处理器(#358 自 router 迁入):审计(pmctl rm)+ 控制器
 *  分派。返回 handled(router 阶段壳原样透传)。 */
export async function handlePmctlFamily(
  deps: { pmctl: PmctlController; auth: ChallengeAuth; audit: CommandAudit; reply: CommandReply },
  ctx: {
    text: string;
    msg: { userId: string; transport: string; chatId: string };
    isManagementRoom: boolean;
  },
): Promise<boolean> {
  // 审计(issue #124):项目删除是最重的一刀,确认链的每一步都留痕
  // (/pmctl rm 与其确认词都命中这里);其余子命令 v1 不记。
  if (/^\/pmctl\s+rm(\s|$)/i.test(ctx.text.trim())) {
    deps.audit(AUDIT_EVENTS.pmctlRemove, ctx.msg, normalizeDetailLine(ctx.text));
  }
  // 工单 sec-pmctl-admin-gate:isAdmin 按 /login 同款口径在此计算
  // (auth.isAdminUser),控制器只收判定结果 —— 门禁决策仍在控制器。
  return await deps.pmctl.handle(
    ctx.text,
    {
      chatId: ctx.msg.chatId,
      senderMxid: ctx.msg.userId,
      isManagementRoom: ctx.isManagementRoom,
      isAdmin: deps.auth.isAdminUser(ctx.msg.userId, ctx.msg.transport),
    },
    async (replyText) => deps.reply(ctx.msg.chatId, ctx.msg.transport, replyText),
  );
}

/** /login 族阶段处理器(#358 自 router 迁入):审计(放行与否都记)+ 门禁
 *  (admin + 房间语义)+ 三命令分派。命中 /login /logout /auth 才返回 true,
 *  否则 false(交还管线)。 */
export async function handleLoginFamily(
  deps: { auth: ChallengeAuth; login: LoginManager; audit: CommandAudit; reply: CommandReply },
  ctx: {
    text: string;
    msg: { userId: string; transport: string; chatId: string; isGroupChat: boolean };
    multiProject: boolean;
    isManagementRoom: boolean;
  },
): Promise<boolean> {
  if (!/^\/(login|logout|auth)(\s|$)/.test(ctx.text)) return false;
  const { msg } = ctx;
  // 审计(issue #124):认证面 —— 放行与否都记(被拒的尝试更要留痕)。
  deps.audit(AUDIT_EVENTS.loginFlow, msg, redactLoginDetail(ctx.text));
  const loginRoomAllowed = ctx.multiProject ? ctx.isManagementRoom : !msg.isGroupChat;
  if (!deps.auth.isAdminUser(msg.userId, msg.transport)) {
    await deps.reply(msg.chatId, msg.transport, t("router.login.forbidden"));
    return true;
  }
  if (!loginRoomAllowed) {
    await deps.reply(msg.chatId, msg.transport, t("router.login.roomRestricted"));
    return true;
  }
  const loginCmd = ctx.text.split(/\s+/)[0]!.toLowerCase();
  const loginArgs = ctx.text.slice(loginCmd.length).trim();
  if (loginCmd === "/login") {
    if (!loginArgs) {
      await deps.login.listProviders(msg.chatId, msg.transport);
    } else {
      const [providerId, method] = loginArgs.split(/\s+/);
      // starterId(sec-login-sender-guard):流程绑定发起者,只有 TA 的
      // 后续消息能作答/取消 —— 管理房内其他受信成员无权代答。
      await deps.login.startLogin(msg.chatId, msg.transport, providerId!, msg.userId, method);
    }
    return true;
  }
  if (loginCmd === "/logout") {
    if (!loginArgs) {
      await deps.reply(msg.chatId, msg.transport, t("router.login.logoutUsage"));
      return true;
    }
    await deps.login.logout(msg.chatId, msg.transport, loginArgs.split(/\s+/)[0]!);
    return true;
  }
  await deps.login.authStatus(msg.chatId, msg.transport);
  return true;
}
