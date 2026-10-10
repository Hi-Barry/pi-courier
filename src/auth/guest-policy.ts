/**
 * Guest policy (issue #120): what a guest may not do. Pure module — a
 * constant blocklist plus one verdict function, snapshot-pinned by tests so
 * a new dangerous command that forgets to register here turns a test red.
 *
 * The boundary is the bridge-side surface only: guests chat freely (their
 * conversation may still drive the agent's own tools — pi has no per-session
 * tool switch, and prompt-prefix "limits" are not a permission boundary).
 * Room enable modes keep their semantics: a `trusted-only` room keeps guests
 * out entirely (mode first, tier second).
 */

/** 触发规则与 command-map 的 parseBangCommand 同源(1~2 个全/半角感叹号 +
 *  空白 + 非空命令);跨域 import 会成 auth→rpc→auth 环,故此处自持同一
 *  正则,等价性由 guest-policy 测试钉住(两解析器对样例集必须一致)。 */
const BANG_COMMAND = /^([!！]{1,2})\s+(\S.*)$/;

/** 访客禁用清单(issue #120,v1):桥侧可完全强制执行的危险面。按域分组
 *  只为可读性,判定用扁平集合。/abort=/stop 别名、/multiproject(实例级
 *  开关)、/attach /detach(会话镜像动共享会话)在票面清单之外按「危险即
 *  禁」补入 —— 加新命令时先问:访客碰它会不会影响共享状态?会就登记。 */
export const GUEST_BLOCKED_COMMANDS: readonly string[] = [
  // shell 执行
  "/bash",
  "/bashstop",
  // 项目管理
  "/pmctl",
  "/newproject",
  "/projects",
  // 认证
  "/login",
  "/logout",
  "/auth",
  // 生命周期(影响整条共享进程)
  "/reload",
  "/stop",
  "/abort",
  "/interrupt",
  "/enable",
  "/disable",
  "/switch",
  "/multiproject",
  // 名单与显示
  "/trusted",
  "/revoke",
  "/toggletools",
  // 主动外发
  "/remind",
  // 会话镜像(动共享会话)
  "/attach",
  "/detach",
];

/** 放行清单(白名单语义的文档化:guest.denied 只给禁用清单,其余照常)。
 *  只读命令照常;/find(#118)与 /recap(#122)落地即在此列。 */
export const GUEST_ALLOWED_COMMANDS: readonly string[] = [
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

export interface GuestVerdict {
  blocked: boolean;
  /** 命中的触发词(回执与审计用);未命中时为 ""。 */
  command: string;
}

/** 访客对一条输入的裁决:shell bang 与禁用斜杠命中的都算越权,回执礼貌
 *  说明 + 审计留痕;普通对话与放行命令照常进管道。 */
export function guestCommandVerdict(text: string): GuestVerdict {
  const trimmed = text.trim();
  const bang = BANG_COMMAND.exec(trimmed);
  if (bang) {
    return { blocked: true, command: `${bang[1]} ${bang[2]!.split(/\s+/)[0]}` };
  }
  if (!trimmed.startsWith("/")) return { blocked: false, command: "" };
  const name = trimmed.split(/\s+/)[0]!.toLowerCase();
  if (GUEST_BLOCKED_COMMANDS.includes(name) || name.startsWith("/pmctl")) {
    return { blocked: true, command: name };
  }
  return { blocked: false, command: "" };
}
