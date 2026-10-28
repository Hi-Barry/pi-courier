/**
 * /mcp 指令族(spec #246)的三个纯函数 —— 只依赖 i18n 叶子模块
 * (src/i18n/index.ts,其自身零依赖;卡片与提示文案全部走 t() 双表,
 * zh 为键集基准):
 *  ① tokenizeChatArgs:聊天文本 → argv(shell 风格引号分词,`--` token 原样
 *     保留在 argv 里,命令层遇 `--` 即把剩余全部当位置参数透传给 pi);
 *  ② parseMcpListJson / formatMcpStatusCard:`pi mcp list --json` 输出 → 聊天
 *     状态卡(JSON 判成败、错误截断、needs-auth 附登录指引、空列表附添加指引);
 *  ③ createLoginLineParser:登录 stdout 逐行解析器(授权 URL 行即时上抛、
 *     已登录/成功行识别;未识别行降级为原文透传,容忍 pi 文案漂移)。
 *
 * 钉住的 pi 1.0.0 文案与结构来源(实测,pi 文案漂移时此处须同步):
 *  - list --json 顶层:{ servers, errors, note? },server 报告字段
 *    name/scope/source/enabled/exposure/transport/state/tools[/toolExposure/
 *    resources/resourceTemplates/error],成败判定不看退出码 —— pi 对任一
 *    启用服务器未连接即退出非零(exit 1),JSON 内容才是真相。
 *  - login:授权 URL 行 `Sign in to MCP server "X" in your browser:`(URL 在
 *    下一行)、已登录 `Already signed in to MCP server "X" (N tools).`、
 *    成功 `Signed in to MCP server "X" (N tools).`。
 */
import { t } from "../i18n/index.js";

// ---------------------------------------------------------------------------
// ① 聊天文本 → argv 分词器
// ---------------------------------------------------------------------------

export interface TokenizeResult {
  /** false = 分词失败(未闭合引号);argv 仅含已解析前缀,供诊断,不可执行。 */
  ok: boolean;
  argv: string[];
  /** ok=false 时的人话描述。 */
  error?: string;
}

/**
 * shell 风格引号分词。规则(与 POSIX sh 对齐的够用子集):
 *  - 空白(空格/制表/换行)分隔;连续空白同一个分隔符;
 *  - 单引号内一切字面(无转义);双引号内保留特殊字符,`\"` `\\` 两对转义;
 *  - 引号外反斜杠转义紧随的任一字符(含空格与引号);
 *  - `--`  token 原样保留在 argv(它是命令层「其后透传」的锚点,不是分词器
 *    的语义;`--` 之后引号照常解析,否则 `--header "A B"` 之类无法工作)。
 * 空输入/纯空白 → ok 且 argv 为空(命令层据此给用法回执)。
 */
export function tokenizeChatArgs(text: string): TokenizeResult {
  const argv: string[] = [];
  let current = "";
  let hasToken = false;
  let i = 0;
  const flush = () => {
    if (hasToken) argv.push(current);
    current = "";
    hasToken = false;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) {
        // 未闭合引号:已解析前缀保留在 argv 供诊断,但 ok=false。
        flush();
        return { ok: false, argv, error: t("cmd.mcp.tokenize.unclosedSingle") };
      }
      current += text.slice(i + 1, close);
      hasToken = true;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      // 双引号逐字符扫:只认 \\ 与 \" 两对转义(POSIX sh 同判),其余
      // 反斜杠序列原样保留;不能整体 indexOf 找闭引号,否则 \" 会提前闭合。
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const c = text[j]!;
        if (c === "\\" && (text[j + 1] === "\\" || text[j + 1] === '"')) {
          current += text[j + 1] === '"' ? '"' : "\\";
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          break;
        }
        current += c;
        j += 1;
      }
      if (!closed) {
        flush();
        return { ok: false, argv, error: t("cmd.mcp.tokenize.unclosedDouble") };
      }
      hasToken = true;
      i = j + 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= text.length) {
        flush();
        return { ok: false, argv, error: t("cmd.mcp.tokenize.danglingBackslash") };
      }
      current += text[i + 1]!;
      hasToken = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }
    current += ch;
    hasToken = true;
    i += 1;
  }
  flush();
  return { ok: true, argv };
}

// ---------------------------------------------------------------------------
// ② `pi mcp list --json` 输出 → 聊天状态卡
// ---------------------------------------------------------------------------

/** server 报告(pi 1.0.0 实测形状;缺失字段按 optional 容忍,渲染处给缺省)。 */
export interface McpServerReport {
  name: string;
  scope?: string;
  source?: string;
  enabled?: boolean;
  exposure?: string;
  transport?: string;
  state?: string;
  tools?: string[];
  toolExposure?: Record<string, string>;
  resources?: number;
  resourceTemplates?: number;
  error?: string;
}

/** list --json 顶层载荷。 */
export interface McpListPayload {
  servers: McpServerReport[];
  errors?: string[];
  note?: string;
}

/**
 * 把 `pi mcp list --json` 的 stdout 解析成载荷。不是 pi 的 list JSON 形状
 * (缺 servers 数组 / JSON 非法)→ undefined,调用方据此走失败分支 ——
 * 旧版 pi 会把未知命令当 prompt 喂模型(stdout 是任意模型回复,exit 0),
 * 这里就是把它挡在「解析失败」上的那道门。
 */
export function parseMcpListJson(stdout: string): McpListPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.servers)) return undefined;
  const servers: McpServerReport[] = [];
  for (const entry of record.servers) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string") continue;
    servers.push({
      name: item.name,
      scope: typeof item.scope === "string" ? item.scope : undefined,
      source: typeof item.source === "string" ? item.source : undefined,
      enabled: typeof item.enabled === "boolean" ? item.enabled : undefined,
      exposure: typeof item.exposure === "string" ? item.exposure : undefined,
      transport: typeof item.transport === "string" ? item.transport : undefined,
      state: typeof item.state === "string" ? item.state : undefined,
      tools: Array.isArray(item.tools)
        ? item.tools.filter((tool): tool is string => typeof tool === "string")
        : undefined,
      toolExposure:
        typeof item.toolExposure === "object" && item.toolExposure !== null
          ? Object.fromEntries(
              Object.entries(item.toolExposure as Record<string, unknown>)
                .filter((pair): pair is [string, string] => typeof pair[1] === "string"),
            )
          : undefined,
      resources: typeof item.resources === "number" ? item.resources : undefined,
      resourceTemplates:
        typeof item.resourceTemplates === "number" ? item.resourceTemplates : undefined,
      error: typeof item.error === "string" ? item.error : undefined,
    });
  }
  return {
    servers,
    errors: Array.isArray(record.errors)
      ? record.errors.filter((item): item is string => typeof item === "string")
      : undefined,
    note: typeof record.note === "string" ? record.note : undefined,
  };
}

/** 状态词的本地化;未知 state 原样透传(容忍 pi 文案漂移,不猜)。 */
function stateLabel(state: string | undefined, enabled: boolean | undefined): string {
  if (enabled === false) return t("cmd.mcp.state.disabled");
  switch (state) {
    case "connected":
      return t("cmd.mcp.state.connected");
    case "needs-auth":
      return t("cmd.mcp.state.needsAuth");
    case "disabled":
      return t("cmd.mcp.state.disabled");
    case "connecting":
      return t("cmd.mcp.state.connecting");
    default:
      return state ?? t("cmd.mcp.state.unknown");
  }
}

/** 单行截断上限(错误信息等自由文本);超出以 … 标记。 */
const DETAIL_MAX = 160;
/** 状态卡里最多逐个列出的工具数,超出折叠为计数。 */
const MAX_TOOLS_SHOWN = 8;

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > DETAIL_MAX ? `${collapsed.slice(0, DETAIL_MAX)}…` : collapsed;
}

/**
 * 渲染聊天状态卡(纯文本,markdown 列表形态)。成败由调用方依据载荷本身
 * 判定(JSON 解析成功即渲染;errors 数组/逐服务器 error 都进卡片,不吞)。
 */
export function formatMcpStatusCard(payload: McpListPayload): string {
  const lines: string[] = [];
  if (payload.servers.length === 0 && (payload.errors?.length ?? 0) === 0) {
    lines.push(t("cmd.mcp.card.empty"));
    return lines.join("\n");
  }

  lines.push(t("cmd.mcp.card.header", { count: payload.servers.length }));
  for (const server of payload.servers) {
    const exposure = server.exposure ?? "codemode";
    const scope = server.scope ?? "global";
    lines.push(
      t("cmd.mcp.card.server", {
        name: server.name,
        state: stateLabel(server.state, server.enabled),
        exposure,
        scope,
      }),
    );
    if (server.transport) lines.push(t("cmd.mcp.card.transport", { transport: oneLine(server.transport) }));
    if (server.state === "needs-auth") {
      lines.push(t("cmd.mcp.card.needsAuth", { server: server.name }));
    }
    const tools = server.tools ?? [];
    if (tools.length > 0) {
      const shown = tools.slice(0, MAX_TOOLS_SHOWN);
      const more = tools.length > MAX_TOOLS_SHOWN ? t("cmd.mcp.card.toolsMore", { count: tools.length }) : "";
      lines.push(t("cmd.mcp.card.tools", { count: tools.length, tools: shown.join(", "), more }));
    }
    if (server.resources !== undefined) {
      lines.push(
        t("cmd.mcp.card.resources", {
          count: server.resources,
          templates: server.resourceTemplates ?? 0,
        }),
      );
    }
    if (server.error) lines.push(t("cmd.mcp.card.serverError", { error: oneLine(server.error) }));
  }

  if (payload.errors && payload.errors.length > 0) {
    lines.push(t("cmd.mcp.card.errorsHeader"));
    for (const message of payload.errors) lines.push(t("cmd.mcp.card.errorLine", { message: oneLine(message) }));
  }
  if (payload.note) lines.push(t("cmd.mcp.card.note", { note: oneLine(payload.note) }));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ③ 登录 stdout 行解析器
// ---------------------------------------------------------------------------

export type McpLoginLine =
  /** 授权 URL(pi 在 browser 提示行的下一行输出;命令层即时转发聊天)。 */
  | { kind: "auth-url"; url: string }
  /** 「本已登录」收尾行(pi exit 0,编排器据此出已完成回执)。 */
  | { kind: "already-signed-in" }
  /** 登录成功收尾行(pi exit 0)。 */
  | { kind: "signed-in" }
  /** 未识别行(含 browser 提示行与失败文案):降级原文透传。 */
  | { kind: "raw"; text: string };

export interface McpLoginLineParser {
  (line: string): McpLoginLine;
}

/**
 * 造一个逐行解析器(带一格状态:browser 提示行的下一行才是 URL)。
 * 钉住的 pi 文案见模块头注释;匹配用子串且大小写敏感 ——
 * `Already signed in to MCP server` 与 `Signed in to MCP server` 靠 "Already"
 * 前缀区分,`Sign-in to MCP server ... failed`(连字符)不会误中成功行。
 */
export function createLoginLineParser(): McpLoginLineParser {
  let pendingUrl = false;
  const urlLike = /^https?:\/\/\S+$/;
  return (line: string): McpLoginLine => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return { kind: "raw", text: line };
    if (pendingUrl && urlLike.test(trimmed)) {
      pendingUrl = false;
      return { kind: "auth-url", url: trimmed };
    }
    pendingUrl = false;
    if (trimmed.includes("in your browser:")) {
      // 容错漂移:URL 与提示同行时直接取行内 URL;否则等下一行。
      const inline = /https?:\/\/\S+/.exec(trimmed);
      if (inline) return { kind: "auth-url", url: inline[0] };
      pendingUrl = true;
      return { kind: "raw", text: line };
    }
    if (trimmed.includes("Already signed in")) return { kind: "already-signed-in" };
    if (trimmed.includes("Signed in to MCP server")) return { kind: "signed-in" };
    return { kind: "raw", text: line };
  };
}
