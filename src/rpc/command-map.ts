/**
 * Slash command map — turns `/command args` messages from messengers into RPC calls.
 *
 * Layer ordering (matches previous extension behaviour, minus the conflicts):
 *  1. The auth pipeline handles challenge codes and admin commands
 *     (handleAdminCommand: /trusted, /revoke, /channels, /enable, /disable,
 *     /toggletools) in the router pipeline before this module
 *  2. /pmctl-family commands are dispatched by PmctlController in the router
 *     pipeline before this module
 *  3. Builtin pi commands that have a dedicated RPC command are mapped here
 *  4. Everything else starting with "/" is forwarded via prompt: extension commands,
 *     skill commands (/skill:name) and prompt templates (/template) are expanded by pi itself
 *  5. Unknown commands get a helpful error listing what is available
 *  /help is unified HERE (pi commands + bridge admin commands) — the single
 *  help surface; ChallengeAuth no longer has its own help text.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import { adminCommandHelpText } from "../auth/admin-commands.js";
import { BANG_COMMAND } from "../command-registry.js";
import { BASH_OUTPUT_LIMIT_DEFAULT, CONFIG_DIR } from "../config.js";
import { errorMessage } from "../errors.js";
import { truncateLine } from "../formatting.js";
import { type MessageKey, t } from "../i18n/index.js";
import { logger } from "../logger.js";
import { formatReminderTime, parseReminderTime } from "../reminders/reminder-parse.js";
import { MAX_REMINDERS_PER_ROOM, type ReminderEntry } from "../reminders/reminder-store.js";
import type { BashResultView, PiRpc, UpstreamQueues } from "./pi-rpc.js";
import { upstreamClearQueueSend } from "./pi-rpc.js";
import { RecapBusyError, RecapEmptyError } from "./recap.js";

/** 上游「已压缩过」的即时校验错误,两通道各一形态(票 #219):应答 error
 *  为裸串,事件 errorMessage 带 Compaction failed: 前缀。精确集合匹配,
 *  防真失败消息偶然含该词组被误吞;上游改词时此处同步。 */
const UPSTREAM_ALREADY_COMPACTED = new Set(["Already compacted", "Compaction failed: Already compacted"]);

/** Mirror of the upstream steering/followUp queues (router's queue_update view). */
export interface QueueSnapshot {
  steering: string[];
  followUp: string[];
}

export interface SlashCommandContext {
  rpc: PiRpc;
  /** Send a reply back to the originating chat */
  reply: (text: string) => Promise<void>;
  /** Live queue snapshot maintained by the router (queue_update mirror).
   *  Absent/undefined entries mean "no queue seen yet" = empty. */
  queueView?: () => QueueSnapshot | undefined;
  /** 清队成功后把镜像钉成权威空(issue #115 阶段1):/stop //interrupt 自己
   *  清掉的队列若只等上游 queue_update 推送归零,推送与重启生命周期之间的
   *  竞态会让「自己清的」误触发队列丢失回执。Absence = 不钉(测试场景)。 */
  setQueueMirror?: (snapshot: QueueSnapshot) => void;
  /** 审计缝(issue #124):命令层只按真实语义上报「发生了什么」(如 /stop
   *  实际清掉几条),落账仍在 router。Absence = 不上报(测试场景)。 */
  audit?: (event: string, detail?: string) => void;
  /** 交接卡(issue #122):/recap 显式生成;/new //clear 前的自动出卡
   *  (recap.onNew 开 + 轮数达标才动)。卡片投递(含多工程管理房抄送)在
   *  router 侧;这里只见类型化错误(忙/空)与重置记账的钩子。Absence =
   *  能力未装配,不吞命令(落回 pi,未知命令得到正常报错)。 */
  recap?: {
    run: () => Promise<void>;
    beforeNew: () => Promise<void>;
    onSwitched: () => void;
  };
  /** Every rpc of this instance (default + started project rpcs) — enables
   *  `/reload all` (issue #55). Absent = /reload stays single-process. */
  allRpcs?: () => PiRpc[];
  /** 在跑 bash 记账(/bashstop 的"列出"数据源)。Absence = /bashstop 只能
   *  盲停(仍然可用:上游 abortBash 无在跑命令时是无害空操作)。 */
  bashTracker?: BashTracker;
  /** bash 回帖截断上限(字符,config `bashOutputLimit` 派生值)。Absence =
   *  默认值(BASH_OUTPUT_LIMIT_DEFAULT)。 */
  bashOutputLimit?: number;
  /** TUI ↔ Matrix 会话镜像(/attach /detach,TUI 双端协同)。attach/detach
   *  返回已渲染好的房间文案(router 侧拼装:绑定房间 + i18n);rebase 在
   *  /new /switch 换会话后同步镜像的「当前会话文件」;active 供 /new 追加
   *  「重新 /attach」提示的判据。Absence = 镜像能力不可用,回复不可用文案。 */
  sessionMirror?: {
    attach: () => Promise<string>;
    detach: () => Promise<string>;
    /** 本进程当前是否挂着镜像。 */
    active: () => boolean;
    /** 换会话成功后同步镜像基线(新 sessionFile;尚无文件时传 undefined)。 */
    rebase: (sessionFile: string | undefined) => void;
    /** 当前会话文件路径(换会话后取新值用;不可用时 undefined)。 */
    currentSessionFile: () => Promise<string | undefined>;
  };
  /** 聊天里的定时提醒(/remind,issue #117):router 按本消息的房间与发起人
   *  预先绑定好的视图 —— 命令层不接触 chatId/userId。Absence = 未装配
   *  (回复不可用文案)。 */
  reminders?: {
    /** 落盘 + 起定时器;false = 本房间达到活跃提醒上限。 */
    add(text: string, dueAt: number): boolean;
    /** 本房间的活跃提醒,最早到期优先。 */
    list(): ReminderEntry[];
    /** 取消本房间列表的第 index(1 基)条;序号不存在返回 undefined。 */
    removeByIndex(index: number): ReminderEntry | undefined;
  };
  /** Router-owned per-rpc transient state (queue mirror, pending extension
   *  questions) must not survive a restart: the new subprocess knows nothing
   *  of old question ids, and a stale question would swallow the room's next
   *  message as a bogus "answer". */
}

// ── `!`/`!!` bash 快捷执行(≈ pi TUI 的 !/!!)──────────────────────────

/** 解析结果:excluded = `!!` 语义(结果不写入上下文)。 */
export interface BangCommand {
  excluded: boolean;
  command: string;
}

/**
 * 触发规则(共识):1~2 个感叹号(全角 ！/半角 !/混用)+ 空白 + 非空命令。
 * 无空格(`!git`)、光杆 `!`、三个以上感叹号(`!!! 好厉害`)一律返回 null ——
 * 消息照常走 prompt 当普通文本,聊天里的感叹句永不误触。
 */
export function parseBangCommand(text: string): BangCommand | null {
  const match = BANG_COMMAND.exec(text);
  if (!match) return null;
  return { excluded: match[1]!.length === 2, command: match[2]!.trim() };
}

/** 在跑 bash 的一笔账:命令文本 + 开始时刻(/bashstop 列表展示用)。 */
export interface InFlightBash {
  command: string;
  startedAt: number;
}

/**
 * 在跑 bash 记账。上游 RpcSessionState 不暴露"bash 是否在跑",courier 只能
 * 自己记自己发出的命令(/bash 与 `!`/`!!` 共用);/bashstop 据此列出后调用
 * 上游 abortBash 一刀切中止。WeakMap 按 pi 进程记账;销账靠 promise 落定的
 * finally —— 进程重启后久未落定的残账最多让列表多显示一行,abortBash 对新
 * 进程是无害空操作。
 */
export interface BashTracker {
  list(rpc: PiRpc): InFlightBash[];
  /** 记账;返回销账函数(promise 落定的 finally 调用,幂等)。 */
  track(rpc: PiRpc, command: string): () => void;
}

export function createBashTracker(): BashTracker {
  const inflight = new WeakMap<PiRpc, InFlightBash[]>();
  return {
    list(rpc) {
      return (inflight.get(rpc) ?? []).map((entry) => ({ ...entry }));
    },
    track(rpc, command) {
      const entries = inflight.get(rpc) ?? [];
      const entry: InFlightBash = { command, startedAt: Date.now() };
      entries.push(entry);
      inflight.set(rpc, entries);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = inflight.get(rpc);
        const index = current?.indexOf(entry) ?? -1;
        if (index >= 0) current!.splice(index, 1);
      };
    },
  };
}

/** 秒级时长的人类可读形式(列表里"已跑多久"):59s / 1m05s / 12m30s。 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** bash 结果的统一回帖(/bash 与 `!`/`!!` 共用):命令行 + 代码块输出 +
 *  退出码;被中止时显示已捕获的部分输出,不打退出码。excluded 附注语义。
 *  limit = 截断上限(字符,config bashOutputLimit 派生;缺省用默认值)。 */
export function formatBashReply(
  command: string,
  result: BashResultView,
  excluded = false,
  limit: number = BASH_OUTPUT_LIMIT_DEFAULT,
): string {
  const suffix = excluded ? t("cmd.bash.notWritten") : "";
  const output = result.output.length > limit
    ? result.output.slice(0, limit) + `\n${t("common.truncated")}`
    : result.output;
  if (result.cancelled) {
    return `${t("cmd.bash.aborted", { command, suffix })}\n\`\`\`\n${output || t("common.noOutput")}\n\`\`\``;
  }
  return `$ ${command}${suffix}\n\`\`\`\n${output || t("common.noOutput")}\n\`\`\`\n${t("common.exitCode", { code: result.exitCode })}`;
}

/** Total queued messages in a snapshot (0 when absent). */
export function queueTotal(snapshot: QueueSnapshot | undefined): number {
  return (snapshot?.steering.length ?? 0) + (snapshot?.followUp.length ?? 0);
}

/**
 * Fallback queue warning for /stop and /interrupt replies on old upstreams
 * (<0.84.4, clear_queue rejected — issue #112): abort alone preserves the
 * queues, so remaining messages would fire on the NEXT turn — surface that
 * explicitly. Null when nothing is queued. On current upstreams the commands
 * clear the queue instead and report what was dropped.
 */
export function queueWarning(snapshot: QueueSnapshot | undefined): string | null {
  const total = queueTotal(snapshot);
  if (total === 0) return null;
  const lines = [...(snapshot?.steering ?? []), ...(snapshot?.followUp ?? [])].map(
    (m) => `- ${truncateLine(m)}`
  );
  return t("cmd.queue.warning", { count: total, lines: lines.join("\n") });
}

/** Append the queue warning (if any) to a reply line. */
function withQueueWarning(replyText: string, snapshot: QueueSnapshot | undefined): string {
  const warning = queueWarning(snapshot);
  return warning ? `${replyText}\n${warning}` : replyText;
}

/**
 * View of one clear_queue answer for the i18n reply (issue #112): count +
 * bounded line list, same rendering style as queueWarning. Null when the
 * upstream had nothing left to clear (e.g. the turn consumed the queue
 * between our mirror snapshot and the clear).
 */
export function clearedQueuesView(cleared: UpstreamQueues): { count: number; lines: string } | null {
  const all = [...cleared.steering, ...cleared.followUp];
  if (all.length === 0) return null;
  return { count: all.length, lines: all.map((m) => `- ${truncateLine(m)}`).join("\n") };
}

// --- Instance-wide restart (/reload all + login success — issue #55) --------

export interface ReloadAllResult {
  /** Labels of rpcs that were idle and got restarted. */
  restarted: string[];
  /** Labels of rpcs that were streaming — skipped, need a later /reload. */
  busy: string[];
  /** Labels of rpcs that could not be queried (not started / unreachable) —
   *  they pick the new credentials up on their next start anyway. */
  skipped: string[];
}

/** The display name of an rpc in reload summaries (project label or 默认). */
function rpcDisplayName(rpc: PiRpc): string {
  return rpc.label ?? t("cmd.rpc.defaultName");
}

/**
 * Restart every IDLE rpc of the instance so a fresh pi subprocess re-reads
 * pi's credential/config files (issue #55: after /login writes credentials,
 * and for /reload all). Busy (streaming) rpcs are skipped — an abrupt restart
 * would kill a running turn; the room is told to /reload them later.
 * Unqueryable rpcs (lazy, never started) are skipped: their FIRST start reads
 * the fresh file anyway.
 */
export async function restartIdleRpcs(
  rpcs: readonly PiRpc[]
): Promise<ReloadAllResult> {
  const result: ReloadAllResult = { restarted: [], busy: [], skipped: [] };
  for (const rpc of rpcs) {
    const name = rpcDisplayName(rpc);
    try {
      const state = await rpc.requireClient().getState();
      if (state.isStreaming) {
        result.busy.push(name);
        continue;
      }
      // 重启生命周期由 PiRpc 自身广播(瞬态状态自清,spec #72 票6)
      await rpc.restart();
      result.restarted.push(name);
    } catch {
      result.skipped.push(name);
    }
  }
  return result;
}

/** Render a reload summary for the room. Pure — directly testable. */
export function formatReloadAllResult(result: ReloadAllResult): string {
  const sep = t("common.listSep");
  const parts: string[] = [];
  parts.push(
    result.restarted.length > 0
      ? t("cmd.reloadAll.restarted", { count: result.restarted.length, names: result.restarted.join(sep) })
      : t("cmd.reloadAll.none")
  );
  if (result.busy.length > 0) {
    parts.push(t("cmd.reloadAll.skippedBusy", { count: result.busy.length, names: result.busy.join(sep) }));
  }
  if (result.skipped.length > 0) {
    parts.push(t("cmd.reloadAll.unreachable", { names: result.skipped.join(sep) }));
  }
  return parts.join("\n");
}

/** "/queue" without arguments — render the steering/followUp mirror. The
 *  pendingMessageCount cross-check runs on the EMPTY path too: a mirror that
 *  looks empty only because queue_update events were missed must not read as
 *  "queue is empty" when upstream still holds pending messages. */
async function replyQueueView(rpc: PiRpc, snapshot: QueueSnapshot | undefined, reply: (text: string) => Promise<void>): Promise<void> {
  const steering = snapshot?.steering ?? [];
  const followUp = snapshot?.followUp ?? [];
  let upstream: number | undefined;
  try {
    const state = await rpc.requireClient().getState();
    if (typeof state.pendingMessageCount === "number") upstream = state.pendingMessageCount;
  } catch {
    // State query is best-effort; the mirror alone still serves the reply.
  }
  const mirrored = steering.length + followUp.length;
  if (mirrored === 0) {
    if (typeof upstream === "number" && upstream > 0) {
      await reply(t("cmd.queue.localEmptyUpstreamHas", { count: upstream }));
      return;
    }
    await reply(t("cmd.queue.empty"));
    return;
  }
  const lines: string[] = [t("cmd.queue.header")];
  if (steering.length > 0) {
    lines.push(t("cmd.queue.steering", { count: steering.length }));
    for (const m of steering) lines.push(`- ${truncateLine(m)}`);
  }
  if (followUp.length > 0) {
    lines.push(t("cmd.queue.followUp", { count: followUp.length }));
    for (const m of followUp) lines.push(`- ${truncateLine(m)}`);
  }
  // Cross-check the in-memory mirror against upstream's pendingMessageCount —
  // a mismatch means the mirror is stale (e.g. events were missed); upstream wins.
  if (typeof upstream === "number" && upstream !== mirrored) {
    lines.push(t("cmd.queue.mismatch", { upstream, mirror: mirrored }));
  }
  await reply(lines.join("\n"));
}

/**
 * 等 agent 空闲:轮询 getState,不依赖 agent_settled 事件。
 *
 * 上游 RpcClient.waitForIdle 只订阅未来的 agent_settled、不查当前状态 ——
 * abort 在订阅完成前就已 settle 时(快模型/回声场景,毫秒级),它必然
 * 空等 60s 超时,/interrupt 的新指令随之丢失(2026-10-11 真机复现:
 * 日志里 run 已 settled,waitForIdle 仍报 "Timeout waiting for agent to
 * become idle")。轮询对任何 abort→settle 时序都成立。
 */
export async function waitForAgentIdle(
  client: { getState(): Promise<{ isStreaming: boolean }> },
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await client.getState()).isStreaming) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("agent did not become idle after abort");
}

/** /stop 与 //interrupt 共用的清队机制(issue #112):快照 → 上游清队,
 *  旧上游拒清即 clearFailed。钉零(#115)刻意留给调用方在各自原时点做
 *  (/stop 在 abort 后,//interrupt 在 prompt 后):清队 RPC 应答与 clear
 *  之前生成的事件推送之间没有有序性保证,早钉会被迟到的非空推送覆写且
 *  无人再钉 —— 原时点钉零是 #115 验证过的形态,不因抽 helper 而改变。
 *  module 内部缝:回执文案(stop.* vs interrupt.*)与后续动作(审计 /
 *  waitForIdle+prompt)归各 case。 */
async function clearQueuesBeforeAbort(
  rpc: PiRpc,
  queueView: (() => QueueSnapshot | undefined) | undefined
): Promise<{ snapshot: QueueSnapshot | undefined; cleared: UpstreamQueues | undefined; clearFailed: boolean }> {
  const snapshot = queueView?.();
  let cleared: UpstreamQueues | undefined;
  let clearFailed = false;
  if (queueTotal(snapshot) > 0) {
    try {
      cleared = await upstreamClearQueueSend(rpc.requireClient());
    } catch {
      clearFailed = true;
    }
  }
  return { snapshot, cleared, clearFailed };
}

// --- Session directory scanning (/sessions, /switch — issue #56 票5) ----------

export interface SessionSummary {
  /** Absolute path — what /switch hands to switchSession. */
  path: string;
  /** File name, e.g. 2026-09-05T12-00-00-000Z_<sessionId>.jsonl. */
  file: string;
  /** Last-modified time (ms epoch) — the list sorts by it, newest first. */
  mtimeMs: number;
}

/**
 * Scan a session dir for pi session files (*.jsonl), newest first. A missing
 * or unreadable dir yields [] (the caller reports "找不到会话目录").
 *
 * Recursive on purpose: pi lays sessions out as `<base>/<workdir-slug>/<file>.jsonl`
 * (one subdirectory per working directory, e.g. `--tmp-pi-verify-workdir--`), so a
 * flat readdir of the base sees zero files even when sessions exist — /sessions
 * reported "📭 会话目录为空" and /switch 永远序号越界 (2026-10-11 真机发现).
 */
export function listSessions(dir: string): SessionSummary[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  const sessions: SessionSummary[] = [];
  for (const rel of entries) {
    if (!rel.endsWith(".jsonl")) continue;
    const full = path.join(dir, rel);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      sessions.push({ path: full, file: path.basename(rel), mtimeMs: st.mtimeMs });
    } catch {
      // Raced deletion between readdir and stat — skip.
    }
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The session dir a process scans: its own --session-dir, else pi's default. */
export function resolveSessionDir(rpc: PiRpc): string {
  return rpc.sessionDir ?? path.join(CONFIG_DIR, "agent", "sessions");
}

/**
 * Display name of a session: the LAST "session_info" entry's name field.
 * Regex-scanned per jsonl line (no full JSON parse); giant files skip the
 * lookup — the name is a display nicety, never load-bearing.
 */
export function readSessionName(filePath: string): string | undefined {
  try {
    if (fs.statSync(filePath).size > 2 * 1024 * 1024) return undefined;
    const text = fs.readFileSync(filePath, "utf-8");
    let last: string | undefined;
    for (const match of text.matchAll(/"type":"session_info".*?"name":"((?:[^"\\]|\\.)*)"/g)) {
      try {
        last = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        last = match[1];
      }
    }
    const name = last?.replace(/\s+/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Compact local time for the /sessions list: YYYY-MM-DD HH:mm. */
function formatMtime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "/sessions" — the top-10 newest sessions with a /switch hint. */
async function replySessionList(rpc: PiRpc, reply: (text: string) => Promise<void>): Promise<void> {
  const dir = resolveSessionDir(rpc);
  const sessions = listSessions(dir).slice(0, 10);
  if (sessions.length === 0) {
    const reason = fs.existsSync(dir) ? t("cmd.sessions.emptyDir") : t("cmd.sessions.noDir");
    await reply(t("cmd.sessions.empty", { reason, dir }));
    return;
  }
  const lines = sessions.map((s, i) => {
    const name = readSessionName(s.path);
    return `${i + 1}. ${s.file}  ${formatMtime(s.mtimeMs)}${name ? `  ${name}` : ""}`;
  });
  await reply(t("cmd.sessions.list", { lines: lines.join("\n") }));
}

// --- Skill listing (/skills — spec #214) -------------------------------------

/**
 * /skills 的最小输入形状:上游 RpcSlashCommand 的结构投影,只取展示所需
 * 字段 —— 纯函数测试不必伪造完整 SourceInfo,真实 RpcSlashCommand[] 结构
 * 兼容、可直接传入。
 */
export interface SkillCommandView {
  /** 已含 "skill:" 前缀(如 "skill:ask-matt"),行首展示 "/skill:ask-matt"。 */
  name: string;
  description?: string;
  source: string;
  sourceInfo?: { scope?: string };
}

/** 分组展示顺序(user → project → other),标签键一一对应。 */
const SKILL_GROUP_ORDER = ["user", "project", "other"] as const;
type SkillGroupKey = (typeof SKILL_GROUP_ORDER)[number];

const SKILL_GROUP_LABEL_KEY: Record<SkillGroupKey, MessageKey> = {
  user: "cmd.skills.group.user",
  project: "cmd.skills.group.project",
  other: "cmd.skills.group.other",
};

/** scope → 分组键:只认 user/project,未知值(含上游 temporary)一律归
 *  「其他」—— 防御性归组,不因未知枚举值崩溃。 */
function skillGroupKey(scope: string | undefined): SkillGroupKey {
  if (scope === "user" || scope === "project") return scope;
  return "other";
}

/** 单行展示:`/skill:名称 — 描述`(描述单行化并约 60 字符截断);
 *  缺描述只显名字、不带空描述段。 */
export function formatSkillLine(entry: SkillCommandView): string {
  const invocation = `/${entry.name}`;
  const description = entry.description?.trim();
  return description ? `${invocation} — ${truncateLine(description, 60)}` : invocation;
}

/**
 * /skills 回复文本(spec #214):只列技能(source === "skill"),不混扩展
 * 命令与提示词模板;按作用域分组、组内按名字母序,全量不设上限;零技能时
 * 回复安装指路。纯函数,直接单测 —— 与 listSessions 同一接缝风格。
 */
export function formatSkillsList(commands: readonly SkillCommandView[]): string {
  const skills = commands.filter((c) => c.source === "skill");
  if (skills.length === 0) return t("cmd.skills.empty");
  const groups = new Map<SkillGroupKey, SkillCommandView[]>();
  for (const skill of skills) {
    const key = skillGroupKey(skill.sourceInfo?.scope);
    const bucket = groups.get(key) ?? [];
    bucket.push(skill);
    groups.set(key, bucket);
  }
  const blocks: string[] = [];
  for (const key of SKILL_GROUP_ORDER) {
    const bucket = groups.get(key);
    if (!bucket) continue;
    // 按名字母序(码元比较,确定性优先于 locale 语义 —— 技能名是标识符)。
    bucket.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    blocks.push(
      t("cmd.skills.group", {
        label: t(SKILL_GROUP_LABEL_KEY[key]),
        lines: bucket.map(formatSkillLine).join("\n"),
      })
    );
  }
  return t("cmd.skills.header", { lines: blocks.join("\n\n") });
}

/** Returns true if the command was handled (something was done / replied). */
export async function handleSlashCommand(
  text: string,
  ctx: SlashCommandContext
): Promise<boolean> {
  const { rpc, reply, queueView, setQueueMirror } = ctx;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  // 命令名(审计详情用):/stop 与 /abort 的别名同语义,如实上报触发词。
  const commandWord = trimmed.split(/\s+/)[0]!.toLowerCase();

  const spaceIndex = trimmed.indexOf(" ");
  // 分发键统一小写:/Stop /Help 这类大写输入此前会落 default 被当普通
  // 文本转发(审计工程批 票21;命令大小写不敏感与登记表/裁决口径一致)。
  const name = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
  const args = (spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1)).trim();

  try {
    switch (name) {
      // --- Session lifecycle -------------------------------------------------
      case "/recap": {
        // 交接卡(issue #122):先「生成中」回执再等卡片,两段式(/bash 先例)。
        // 忙碌/空会话以类型化错误抛出,这里转人话;其余错误透传信息。
        if (!ctx.recap) return false;
        await reply(t("cmd.recap.generating"));
        try {
          await ctx.recap.run();
        } catch (err) {
          if (err instanceof RecapBusyError) await reply(t("cmd.recap.busy"));
          else if (err instanceof RecapEmptyError) await reply(t("cmd.recap.empty"));
          else await reply(t("cmd.generic.error", { message: errorMessage(err) }));
        }
        return true;
      }

      case "/new":
      case "/clear": {
        // /new 联动(issue #122):旧会话被清掉「之前」出卡 —— 生成失败在
        // beforeNew 内部吞掉(warn),绝不阻塞换会话。失败不吞换会话的
        // 钉点测试在 recap 集成里。
        await ctx.recap?.beforeNew();
        const { cancelled } = await rpc.requireClient().newSession();
        await reply(cancelled ? t("cmd.new.cancelled") : t("cmd.new.ok"));
        if (!cancelled) {
          // 镜像(active)跟随房间进程而非写死的文件 id,目录级 watch 对新
          // 会话照常生效;过期的是终端里那条附加命令 —— 指路重新 /attach。
          if (ctx.sessionMirror?.active()) {
            ctx.sessionMirror.rebase(await ctx.sessionMirror.currentSessionFile());
            await reply(t("cmd.new.mirrorHint"));
          }
          ctx.recap?.onSwitched(); // 轮数记账归零:新会话的 /recap 从零数起
        }
        return true;
      }

      case "/compact": {
        // 两段式(spec #218 票 #219):先「压缩中」回执,结果由 PiRpc.compact
        // 双源(RPC 应答 / compaction_end 事件)收尾 —— 上游 send() 应答超时
        // 写死 30s,慢压缩走旧路径必然假失败,重试又撞 Already compacted。
        await reply(t("cmd.compact.generating"));
        const outcome = await rpc.compact(args || undefined);
        switch (outcome.kind) {
          case "ok": {
            if (!outcome.result) {
              // 旧版对端:事件无 result 载荷,能确认压缩完成即收。
              await reply(t("cmd.compact.okSimple"));
              break;
            }
            const line = [
              t("cmd.compact.ok"),
              t("cmd.compact.tokens", { before: outcome.result.tokensBefore }),
              t("cmd.compact.summary", { summary: outcome.result.summary.slice(0, 500) }),
            ].join("");
            await reply(line);
            break;
          }
          case "failed": {
            // 事件 errorMessage 带「Compaction failed: 」前缀,应答 error 不带
            // —— 展示前剥掉。Already compacted 是正常重入(两通道各一形态,
            // 精确匹配防真失败消息含该词组被误吞),人话提示而非报错。
            if (UPSTREAM_ALREADY_COMPACTED.has(outcome.message)) {
              await reply(t("cmd.compact.alreadyCompacted"));
            } else {
              await reply(t("cmd.generic.error", { message: outcome.message.replace(/^Compaction failed: /, "") }));
            }
            break;
          }
          case "interrupted":
            await reply(t("cmd.compact.interrupted"));
            break;
        }
        return true;
      }

      case "/stop":
      case "/abort": {
        // pi TUI Esc semantics (issue #112): clear the queue BEFORE aborting
        // (reverse order lets abort keep consuming queued messages), then
        // report exactly what was dropped. Old upstreams (<0.84.4) reject
        // clear_queue → fall back to the spec #51 behaviour: abort only, and
        // warn that the queue survives.
        const { snapshot, cleared, clearFailed } = await clearQueuesBeforeAbort(rpc, queueView);
        await rpc.requireClient().abort();
        // 钉零(#115):清队成功 = 上游权威为空,镜像立即归零,不等
        // queue_update 推送 —— 推送与重启生命周期赛跑时会误触发「队列丢失」回执。
        if (cleared) setQueueMirror?.({ steering: [], followUp: [] });
        // 审计(issue #124,#115 回填):队列清理是运行时突变 —— 命令层
        // 按真实语义上报(实际清掉的条数),router 落账。
        if (cleared) {
          const clearedCount = cleared.steering.length + cleared.followUp.length;
          ctx.audit?.("queue.clear", `${commandWord} cleared ${clearedCount} queued message(s)`);
        }
        const view = cleared ? clearedQueuesView(cleared) : null;
        if (view) {
          await reply(t("cmd.stop.cleared", view));
        } else if (cleared) {
          // Clear succeeded with nothing left (the turn consumed the queue
          // between our mirror snapshot and the clear) — upstream is
          // authoritatively empty; a stale mirror must not resurrect it.
          await reply(t("cmd.stop.ok"));
        } else if (clearFailed) {
          await reply(withQueueWarning(`${t("cmd.stop.ok")}\n${t("cmd.queue.clearUnsupported")}`, snapshot));
        } else {
          await reply(withQueueWarning(t("cmd.stop.ok"), snapshot));
        }
        return true;
      }

      // --- Reminders (issue #117):先落盘再跑,重启不丢 -------------------------
      case "/remind": {
        if (!ctx.reminders) {
          await reply(t("cmd.remind.unavailable"));
          return true;
        }
        if (!args) {
          await reply(t("cmd.remind.usage"));
          return true;
        }
        if (args === "list") {
          const roomList = ctx.reminders.list();
          if (roomList.length === 0) {
            await reply(t("cmd.remind.list.empty"));
            return true;
          }
          const lines = roomList.map((entry, i) =>
            t("cmd.remind.list.item", { n: i + 1, when: formatReminderTime(entry.dueAt), text: entry.text, user: entry.username })
          );
          await reply(t("cmd.remind.list.header", { lines: lines.join("\n") }));
          return true;
        }
        if (args === "rm" || args.startsWith("rm ")) {
          const numText = args.slice(2).trim();
          const index = Number(numText);
          if (!numText || !Number.isInteger(index) || index < 1) {
            await reply(t("cmd.remind.rm.usage"));
            return true;
          }
          const removed = ctx.reminders.removeByIndex(index);
          await reply(removed ? t("cmd.remind.rm.ok", { text: removed.text }) : t("cmd.remind.rm.notFound"));
          return true;
        }
        const spaceIndex = args.indexOf(" ");
        const whenText = spaceIndex === -1 ? args : args.slice(0, spaceIndex);
        const text = spaceIndex === -1 ? "" : args.slice(spaceIndex + 1).trim();
        if (!text) {
          await reply(t("cmd.remind.usage"));
          return true;
        }
        const dueAt = parseReminderTime(whenText, Date.now());
        if (dueAt === null) {
          await reply(t("cmd.remind.invalidTime", { input: whenText }));
          return true;
        }
        if (!ctx.reminders.add(text, dueAt)) {
          await reply(t("cmd.remind.limit", { max: MAX_REMINDERS_PER_ROOM }));
          return true;
        }
        await reply(t("cmd.remind.ok", { when: formatReminderTime(dueAt), text }));
        return true;
      }

      // --- Send semantics (pi TUI parity) -------------------------------------
      case "/queue": {
        if (!args) {
          await replyQueueView(rpc, queueView?.(), reply);
          return true;
        }
        // Alt+Enter semantics: followUp queue while streaming; an idle session
        // degenerates to a plain prompt upstream (deliberately no state check).
        await rpc.promptQueued(args);
        await reply(t("cmd.queue.enqueued"));
        return true;
      }

      case "/interrupt": {
        if (!args) {
          await reply(t("cmd.interrupt.usage"));
          return true;
        }
        const state = await rpc.requireClient().getState();
        if (!state.isStreaming) {
          await rpc.prompt(args);
          await reply(t("cmd.interrupt.idle"));
          return true;
        }
        // Same clear-first order as /stop (issue #112) — the clear mechanics
        // live in clearQueuesBeforeAbort; the #115 pin stays at this command's
        // original post-prompt timing (see the helper's doc for why).
        const { snapshot, cleared, clearFailed } = await clearQueuesBeforeAbort(rpc, queueView);
        await rpc.requireClient().abort();
        await waitForAgentIdle(rpc.requireClient());
        await rpc.prompt(args);
        // 与 /stop 同款钉零(issue #115):清队成功后不等 queue_update 推送。
        if (cleared) setQueueMirror?.({ steering: [], followUp: [] });
        const view = cleared ? clearedQueuesView(cleared) : null;
        if (view) {
          await reply(`${t("cmd.interrupt.done")}\n${t("cmd.interrupt.cleared", view)}`);
        } else if (cleared) {
          // Authoritatively empty upstream (see /stop) — no stale warning.
          await reply(t("cmd.interrupt.done"));
        } else if (clearFailed) {
          await reply(withQueueWarning(`${t("cmd.interrupt.done")}\n${t("cmd.queue.clearUnsupported")}`, snapshot));
        } else {
          await reply(withQueueWarning(t("cmd.interrupt.done"), snapshot));
        }
        return true;
      }

      // --- Small utilities (issue #56 票5) ------------------------------------
      case "/last": {
        const last = await rpc.requireClient().getLastAssistantText();
        const text = last?.trim();
        if (!text) {
          await reply(t("cmd.last.none"));
          return true;
        }
        await reply(text.length > 3000 ? `${text.slice(0, 3000)}\n${t("common.truncated")}` : text);
        return true;
      }

      case "/cyclemodel": {
        const result = await rpc.requireClient().cycleModel();
        if (!result) {
          await reply(t("cmd.cyclemodel.none"));
          return true;
        }
        await reply(t("cmd.cyclemodel.ok", { model: `${result.model.provider}/${result.model.id}`, thinking: result.thinkingLevel }));
        return true;
      }

      case "/cyclethinking": {
        const result = await rpc.requireClient().cycleThinkingLevel();
        if (!result) {
          await reply(t("cmd.cyclethinking.none"));
          return true;
        }
        await reply(t("cmd.cyclethinking.ok", { level: result.level }));
        return true;
      }

      case "/autocompact": {
        const arg = args.toLowerCase();
        if (arg !== "on" && arg !== "off") {
          const state = await rpc.requireClient().getState();
          await reply(
            t("cmd.autocompact.usage", { state: state.autoCompactionEnabled ? t("common.on") : t("common.off") })
          );
          return true;
        }
        await rpc.requireClient().setAutoCompaction(arg === "on");
        await reply(t("cmd.autocompact.ok", { state: arg === "on" ? t("common.enabled") : t("common.disabled") }));
        return true;
      }

      case "/autoretry": {
        const arg = args.toLowerCase();
        if (arg !== "on" && arg !== "off") {
          // RpcSessionState exposes no autoRetry query field — usage only.
          await reply(t("cmd.autoretry.usage"));
          return true;
        }
        await rpc.requireClient().setAutoRetry(arg === "on");
        await reply(t("cmd.autoretry.ok", { state: arg === "on" ? t("common.enabled") : t("common.disabled") }));
        return true;
      }

      case "/sessions": {
        await replySessionList(rpc, reply);
        return true;
      }

      case "/switch": {
        const state = await rpc.requireClient().getState();
        if (state.isStreaming) {
          await reply(t("cmd.switch.streaming"));
          return true;
        }
        const index = Number.parseInt(args, 10);
        if (!args || Number.isNaN(index) || index < 1) {
          await reply(t("cmd.switch.usage"));
          return true;
        }
        const sessions = listSessions(resolveSessionDir(rpc)).slice(0, 10);
        const target = sessions[index - 1];
        if (!target) {
          await reply(t("cmd.switch.outOfRange", { index }));
          return true;
        }
        const result = await rpc.requireClient().switchSession(target.path);
        await reply(result.cancelled ? t("cmd.switch.cancelled") : t("cmd.switch.ok", { file: target.file }));
        if (!result.cancelled) {
          ctx.sessionMirror?.rebase(await ctx.sessionMirror.currentSessionFile());
        }
        return true;
      }

      // --- TUI ↔ Matrix 会话镜像 ------------------------------------------------
      case "/attach": {
        if (!ctx.sessionMirror) {
          await reply(t("cmd.attach.unavailable"));
          return true;
        }
        await reply(await ctx.sessionMirror.attach());
        return true;
      }

      case "/detach": {
        if (!ctx.sessionMirror) {
          await reply(t("cmd.attach.unavailable"));
          return true;
        }
        await reply(await ctx.sessionMirror.detach());
        return true;
      }

      case "/reload": {
        // /reload all (issue #55): every rpc of the instance, idle ones only.
        if (args === "all") {
          if (!ctx.allRpcs) {
            await reply(t("cmd.reload.allUnavailable"));
            return true;
          }
          await reply(t("cmd.reload.allInProgress"));
          const result = await restartIdleRpcs(ctx.allRpcs());
          await reply(formatReloadAllResult(result));
          return true;
        }
        await reply(t("cmd.reload.inProgress"));
        try {
          await rpc.restart();
          const state = await rpc.requireClient().getState();
          await reply(t("cmd.reload.ok", { model: state.model?.id ?? "unknown" }));
        } catch (err) {
          await reply(t("cmd.reload.failed", { message: errorMessage(err) }));
        }
        return true;
      }

      // --- Model / thinking --------------------------------------------------
      case "/model": {
        if (!args) {
          const models = await rpc.requireClient().getAvailableModels();
          if (models.length === 0) {
            await reply(t("cmd.model.none"));
            return true;
          }
          const current = await rpc.requireClient().getState();
          const list = models
            .map((m) => `• ${m.provider}/${m.id}${isCurrentModel(m, current.model) ? t("cmd.model.currentMarker") : ""}`)
            .join("\n");
          await reply(t("cmd.model.list", { list }));
          return true;
        }
        const parsed = parseModelArg(args);
        if (!parsed.provider) {
          // Bare id — try to find a matching model and use its provider
          const models = await rpc.requireClient().getAvailableModels();
          // 精确 id 优先,子串兜底 —— 防 glm-5.3 误切 glm-5.3-air(审计工程批 票21)
          const match =
            models.find((m) => m.id === parsed.modelId) ??
            models.find((m) => m.id.includes(parsed.modelId));
          if (!match) {
            await reply(t("cmd.model.notFound", { id: parsed.modelId }));
            return true;
          }
          parsed.provider = match.provider;
          parsed.modelId = match.id;
        }
        const result = (await rpc.requireClient().setModel(parsed.provider, parsed.modelId)) as { id?: string };
        await reply(t("cmd.model.ok", { model: result.id ?? `${parsed.provider}/${parsed.modelId}` }));
        return true;
      }

      case "/models": {
        const models = await rpc.requireClient().getAvailableModels();
        if (models.length === 0) {
          await reply(t("cmd.model.none"));
          return true;
        }
        const current = await rpc.requireClient().getState();
        await reply(
          models
            .map((m) => `• ${m.provider}/${m.id}${isCurrentModel(m, current.model) ? t("cmd.model.currentMarker") : ""}`)
            .join("\n")
        );
        return true;
      }

      case "/thinking": {
        if (!args) {
          const state = await rpc.requireClient().getState();
          await reply(t("cmd.thinking.usage", { level: state.thinkingLevel }));
          return true;
        }
        await rpc.requireClient().setThinkingLevel(args as Parameters<RpcClient['setThinkingLevel']>[0]);
        await reply(t("cmd.thinking.ok", { level: args }));
        return true;
      }

      // --- Session info / export ---------------------------------------------
      case "/session":
      case "/cost": {
        const stats = await rpc.requireClient().getSessionStats();
        await reply(
          [
            t("cmd.session.sessionId", { id: stats.sessionId }),
            t("cmd.session.messages", { count: stats.totalMessages }),
            t("cmd.session.tokens", { count: stats.tokens.total }),
            t("cmd.session.cost", { cost: `$${stats.cost.toFixed(4)}` }),
          ].join("\n")
        );
        return true;
      }

      case "/status": {
        const state = await rpc.requireClient().getState();
        const modelName = state.model
          ? `${state.model.provider}/${state.model.name || state.model.id}`
          : "unknown";
        await reply(t("cmd.status.ok", { model: modelName, streaming: state.isStreaming ? t("common.yes") : t("common.no") }));
        return true;
      }

      case "/name": {
        if (!args) {
          await reply(t("cmd.name.usage"));
          return true;
        }
        await rpc.requireClient().setSessionName(args);
        await reply(t("cmd.name.ok", { name: args }));
        return true;
      }

      case "/export": {
        const result = await rpc.requireClient().exportHtml(args || undefined);
        await reply(t("cmd.export.ok", { path: result.path }));
        return true;
      }

      // --- Bash ----------------------------------------------------------------
      case "/bash": {
        if (!args) {
          await reply(t("cmd.bash.usage"));
          return true;
        }
        const release = ctx.bashTracker?.track(rpc, args);
        try {
          const result = await rpc.bash(args);
          await reply(formatBashReply(args, result, false, ctx.bashOutputLimit));
          return true;
        } finally {
          release?.();
        }
      }

      case "/bashstop": {
        const inflight = ctx.bashTracker?.list(rpc) ?? [];
        if (inflight.length === 0) {
          await reply(t("cmd.bashstop.none"));
          return true;
        }
        const lines = inflight.map(
          (entry) => `- \`${entry.command}\`${t("cmd.bashstop.running", { elapsed: formatElapsed(Date.now() - entry.startedAt) })}`
        );
        await rpc.requireClient().abortBash();
        await reply(t("cmd.bashstop.ok", { count: inflight.length, lines: lines.join("\n") }));
        return true;
      }

      // --- Skills(技能发现,spec #214)----------------------------------------
      case "/skills": {
        // 只列技能;无参数、不支持过滤(带参数也不产生过滤效果)。查询失败
        // 落既有 catch 管道的 cmd.generic.error 回执,不新增错误分支。
        const commands = await rpc.requireClient().getCommands();
        await reply(formatSkillsList(commands));
        return true;
      }

      case "/help": {
        await reply(helpText());
        return true;
      }

      // --- Fallthrough: extension commands, skills, prompt templates -----------
      default: {
        // /skill:name, /template and extension commands are expanded by pi
        // itself. Always forward: pi's prompt treats unknown commands as plain
        // text and expands skills/templates, so a whitelist here would break
        // /skill: (skills are never in get_commands).
        await rpc.prompt(trimmed);
        return true;
      }
    }
  } catch (err) {
    // 命令名进日志(F5 顺手):「谁遭殃」一眼可查 —— 例:登录成功触发的自动
    // 重启连带击杀在途命令时,回执只有笼统文案,日志必须能对上是哪条命令。
    logger.error(`❌ 命令执行失败 [${commandWord}]: ${errorMessage(err)}`);
    await reply(t("cmd.generic.error", { message: errorMessage(err) }));
    return true;
  }
}

/** 「当前模型」标记判定:provider 与 id 双比较 —— 同名模型(如 glm-5.3)常在
 *  多家 provider 目录并存,单比 id 会同时标记两行。 */
function isCurrentModel(model: { provider: string; id: string }, current: { provider?: string; id?: string } | undefined): boolean {
  return !!current && model.provider === current.provider && model.id === current.id;
}

/** Parse "/model <provider>/<modelId>" or a bare id; bare ids keep the current provider. */
function parseModelArg(arg: string): { provider: string; modelId: string } {
  const trimmed = arg.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
  }
  return { provider: "", modelId: trimmed };
}

/** 统一 /help 文本:Pi 原生组 → 桥增强组 → 透传说明 → 管理组(auth 侧拥有,
 *  见 admin-commands 的 adminCommandHelpText)。 */
function helpText(): string {
  return [
    t("cmd.help.group.pi"),
    "",
    t("cmd.help.group.bridge"),
    "",
    t("cmd.help.passthrough"),
    "",
    adminCommandHelpText(),
  ].join("\n");
}
