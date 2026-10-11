/**
 * 命令登记表(架构候选3):**受限命令**的策略位——访客禁用与敏感审计面
 * ——集中一处,router 的审计接线与 guest-policy 的裁决都由此派生,新增
 * 命令登记一次。纯数据 + 纯函数、零 import:auth 与 rpc 两侧都能安全依赖
 * (command-map 因引用 admin-commands 与 auth 相连,当年 guest-policy 只好
 * 复制正则靠快照钉等价——本模块落地后创可贴退役)。
 *
 * 语义备忘:
 *  - 本表只登记需要「blocked」的命令;/abort=/stop 这类别名各自成条
 *    (裁决按输入词命中,回执礼貌)。未登记的命令默认放行——放行侧是
 *    文档化语义、无判定逻辑,只读命令清单见下方 GUEST_READ_ONLY_DOC。
 *    加新命令先问:访客碰它会不会影响共享状态?会就登记 blocked。
 *  - auditEvent 只记「命令本身即敏感动作」的面(/bash /bashstop /reload);
 *    清队等由命令层按真实语义上报的走 router 的 audit 缝,不经本表。
 *    handled=false 的未识别斜杠不落账(规则归 router 的 slashCommands 阶段)。
 *  - 审计事件名的词汇表归 audit-log 的 AUDIT_EVENTS;本表存字符串,由测试
 *    钉住「表内事件名 ∈ AUDIT_EVENTS 值集」,防止两处漂移。
 */

/** bang 触发规则(与 pi TUI 的 !/!! 同源):1~2 个全/半角感叹号 + 空白 +
 *  非空命令。单一持有:command-map 的 parseBangCommand 与 guest-policy 的
 *  裁决都从这里取。 */
export const BANG_COMMAND = /^([!！]{1,2})\s+(\S.*)$/;

export interface CommandPolicy {
  /** 主名(小写含斜杠)。 */
  name: string;
  /** 访客档:blocked = 桥侧硬拦;未列出的命令默认放行。 */
  guest?: "blocked";
  /** 命令经 slashCommands 落账的审计事件名;缺省不落账。 */
  auditEvent?: string;
}

/** 登记表主数据。条目顺序按域分组(与 #120 票面清单同序),判定用查表。 */
export const COMMAND_REGISTRY: readonly CommandPolicy[] = [
  // shell 执行(访客禁 + 敏感审计)
  { name: "/bash", guest: "blocked", auditEvent: "bash.exec" },
  { name: "/bashstop", guest: "blocked", auditEvent: "bash.stop" },
  // 项目管理(访客禁;/pmctl 前缀族由裁决函数按前缀拦,不入表)
  { name: "/pmctl", guest: "blocked" },
  { name: "/newproject", guest: "blocked" },
  { name: "/projects", guest: "blocked" },
  // 认证(访客禁)
  { name: "/login", guest: "blocked" },
  { name: "/logout", guest: "blocked" },
  { name: "/auth", guest: "blocked" },
  // 生命周期(访客禁;reload 另是敏感审计面)
  { name: "/reload", guest: "blocked", auditEvent: "reload" },
  { name: "/stop", guest: "blocked" },
  { name: "/abort", guest: "blocked" },
  { name: "/interrupt", guest: "blocked" },
  { name: "/enable", guest: "blocked" },
  { name: "/disable", guest: "blocked" },
  { name: "/switch", guest: "blocked" },
  { name: "/multiproject", guest: "blocked" },
  // 名单与显示(访客禁)
  { name: "/trusted", guest: "blocked" },
  { name: "/revoke", guest: "blocked" },
  { name: "/toggletools", guest: "blocked" },
  // 主动外发(访客禁)
  { name: "/remind", guest: "blocked" },
  // 会话镜像(访客禁:动共享会话)
  { name: "/attach", guest: "blocked" },
  { name: "/detach", guest: "blocked" },
  // 会话与代理状态(访客禁:全部动共享会话/代理运行状态,#156 按表头
  // 既定登记规则补齐;这些命令由 pi 会话侧消费,桥只拦访客)
  { name: "/new", guest: "blocked" },
  { name: "/clear", guest: "blocked" },
  { name: "/compact", guest: "blocked" },
  { name: "/model", guest: "blocked" },
  { name: "/thinking", guest: "blocked" },
  { name: "/cyclemodel", guest: "blocked" },
  { name: "/cyclethinking", guest: "blocked" },
  { name: "/autocompact", guest: "blocked" },
  { name: "/autoretry", guest: "blocked" },
  { name: "/name", guest: "blocked" },
];

/** 只读命令清单(纯文档,无判定语义:未登记命令一律默认放行)。快照测试
 *  钉住;/find(#118)与 /recap(#122)这类只读命令落地即在此列。 */
export const GUEST_READ_ONLY_DOC: readonly string[] = [
  "/help",
  "/status",
  "/cost",
  "/models",
  "/sessions",
  "/last",
  "/queue",
  "/find",
  "/recap",
];

/** 查表:命令主名(小写含斜杠)→ 策略位;未登记返回 undefined(默认放行、
 *  不审计)。入参自防御归一化(去空白 + 小写):本函数是访客黑名单的
 *  判定底座,调用方忘记归一化也不能变成 fail-open 面。 */
export function commandPolicy(name: string): CommandPolicy | undefined {
  const normalized = name.trim().toLowerCase();
  return COMMAND_REGISTRY.find((c) => c.name === normalized);
}
