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
import * as os from "node:os";
import * as path from "node:path";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import { adminCommandHelpText } from "../auth/admin-commands.js";
import type { BashResultView, PiRpc } from "./pi-rpc.js";

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
  /** Every rpc of this instance (default + started project rpcs) — enables
   *  `/reload all` (issue #55). Absent = /reload stays single-process. */
  allRpcs?: () => PiRpc[];
  /** 在跑 bash 记账(/bashstop 的"列出"数据源)。Absence = /bashstop 只能
   *  盲停(仍然可用:上游 abortBash 无在跑命令时是无害空操作)。 */
  bashTracker?: BashTracker;
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
  const match = /^([!！]{1,2})\s+(\S.*)$/.exec(text);
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
 *  退出码;被中止时显示已捕获的部分输出,不打退出码。excluded 附注语义。 */
export function formatBashReply(command: string, result: BashResultView, excluded = false): string {
  const suffix = excluded ? "(结果未写入上下文)" : "";
  const output = result.output.length > 3000
    ? result.output.slice(0, 3000) + "\n…(已截断)"
    : result.output;
  if (result.cancelled) {
    return `⏹ 已中止: ${command}${suffix}\n\`\`\`\n${output || "(无输出)"}\n\`\`\``;
  }
  return `$ ${command}${suffix}\n\`\`\`\n${output || "(无输出)"}\n\`\`\`\n退出码: ${result.exitCode}`;
}

/** Collapse a queue entry to one bounded line for chat display. */
function truncateLine(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Unified queue warning for /stop and /interrupt replies: abort preserves the
 * upstream queues (RPC has no clear_queue), so remaining messages would fire
 * on the NEXT turn — surface that explicitly. Null when nothing is queued.
 */
export function queueWarning(snapshot: QueueSnapshot | undefined): string | null {
  const steering = snapshot?.steering ?? [];
  const followUp = snapshot?.followUp ?? [];
  const total = steering.length + followUp.length;
  if (total === 0) return null;
  const lines = [...steering, ...followUp].map((m) => `- ${truncateLine(m)}`);
  return `⚠️ 队列中仍有 ${total} 条消息将在下一轮生效:\n${lines.join("\n")}`;
}

/** Append the queue warning (if any) to a reply line. */
function withQueueWarning(replyText: string, snapshot: QueueSnapshot | undefined): string {
  const warning = queueWarning(snapshot);
  return warning ? `${replyText}\n${warning}` : replyText;
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
  return rpc.label ?? "默认";
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
  const parts: string[] = [];
  parts.push(
    result.restarted.length > 0
      ? `✅ 已重启 ${result.restarted.length} 个空闲进程: ${result.restarted.join("、")}`
      : "💤 没有需要重启的空闲进程"
  );
  if (result.busy.length > 0) {
    parts.push(`⚠️ 跳过 ${result.busy.length} 个忙碌进程: ${result.busy.join("、")}(完成后执行 /reload all)`);
  }
  if (result.skipped.length > 0) {
    parts.push(`⏭️ 未启动/不可达(下次启动自动读取新配置): ${result.skipped.join("、")}`);
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
      await reply(`📋 本地队列为空,但上游报告仍有 ${upstream} 条待处理消息(以实际执行为准)。`);
      return;
    }
    await reply("📋 队列为空:没有排队中的 steering / followUp 消息。");
    return;
  }
  const lines: string[] = ["📋 当前消息队列:"];
  if (steering.length > 0) {
    lines.push(`steering(${steering.length} 条,注入当前运行):`);
    for (const m of steering) lines.push(`- ${truncateLine(m)}`);
  }
  if (followUp.length > 0) {
    lines.push(`followUp(${followUp.length} 条,后续轮次执行):`);
    for (const m of followUp) lines.push(`- ${truncateLine(m)}`);
  }
  // Cross-check the in-memory mirror against upstream's pendingMessageCount —
  // a mismatch means the mirror is stale (e.g. events were missed); upstream wins.
  if (typeof upstream === "number" && upstream !== mirrored) {
    lines.push(`ℹ️ 上游报告待处理 ${upstream} 条(本地镜像 ${mirrored} 条),以实际执行为准。`);
  }
  await reply(lines.join("\n"));
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
 */
export function listSessions(dir: string): SessionSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: SessionSummary[] = [];
  for (const file of names) {
    if (!file.endsWith(".jsonl")) continue;
    const full = path.join(dir, file);
    try {
      sessions.push({ path: full, file, mtimeMs: fs.statSync(full).mtimeMs });
    } catch {
      // Raced deletion between readdir and stat — skip.
    }
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The session dir a process scans: its own --session-dir, else pi's default. */
export function resolveSessionDir(rpc: PiRpc): string {
  return rpc.sessionDir ?? path.join(os.homedir(), ".pi", "agent", "sessions");
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
    const reason = fs.existsSync(dir) ? "会话目录为空" : "找不到会话目录";
    await reply(`📭 ${reason}: ${dir}`);
    return;
  }
  const lines = sessions.map((s, i) => {
    const name = readSessionName(s.path);
    return `${i + 1}. ${s.file}  ${formatMtime(s.mtimeMs)}${name ? `  ${name}` : ""}`;
  });
  await reply(`📚 会话(最近修改优先):\n${lines.join("\n")}\n\n用 /switch <序号> 切换。`);
}

/** Returns true if the command was handled (something was done / replied). */
export async function handleSlashCommand(
  text: string,
  ctx: SlashCommandContext
): Promise<boolean> {
  const { rpc, reply, queueView } = ctx;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;

  const spaceIndex = trimmed.indexOf(" ");
  const name = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const args = (spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1)).trim();

  try {
    switch (name) {
      // --- Session lifecycle -------------------------------------------------
      case "/new":
      case "/clear": {
        const { cancelled } = await rpc.requireClient().newSession();
        await reply(cancelled ? "⚠️ 新会话被扩展取消" : "✅ 已开始新会话");
        return true;
      }

      case "/compact": {
        const result = await rpc.requireClient().compact(args || undefined);
        const line = [
          "✅ 已压缩",
          `  tokens: ${result.tokensBefore} → 压缩后(见摘要)`,
          `\n摘要: ${result.summary.slice(0, 500)}`,
        ].join("");
        await reply(line);
        return true;
      }

      case "/stop":
      case "/abort": {
        await rpc.requireClient().abort();
        // abort preserves the upstream queues (RPC has no clear_queue) — the
        // warning makes that limitation explicit instead of surprising the user.
        await reply(withQueueWarning("🛑 已停止所有任务,等待下一步指示。", queueView?.()));
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
        await reply("📥 已排队:不打断当前任务,将在空闲后自动执行。");
        return true;
      }

      case "/interrupt": {
        if (!args) {
          await reply("用法: /interrupt <新指令> — 打断当前任务并立即下发新指令。");
          return true;
        }
        const state = await rpc.requireClient().getState();
        if (!state.isStreaming) {
          await rpc.prompt(args);
          await reply("▶️ 当前没有运行中的任务,已直接下发新指令。");
          return true;
        }
        await rpc.requireClient().abort();
        await rpc.requireClient().waitForIdle();
        await rpc.prompt(args);
        await reply(withQueueWarning("🛑 已打断,新指令已发出。", queueView?.()));
        return true;
      }

      // --- Small utilities (issue #56 票5) ------------------------------------
      case "/last": {
        const last = await rpc.requireClient().getLastAssistantText();
        const text = last?.trim();
        if (!text) {
          await reply("💤 没有可复述的回复(本会话还没有 assistant 输出)。");
          return true;
        }
        await reply(text.length > 3000 ? `${text.slice(0, 3000)}\n…(已截断)` : text);
        return true;
      }

      case "/cyclemodel": {
        const result = await rpc.requireClient().cycleModel();
        if (!result) {
          await reply("❌ 没有可轮换的模型(启动未限定模型列表?)。用 /model <provider/id> 直接指定。");
          return true;
        }
        await reply(`✅ 已切换模型: ${result.model.provider}/${result.model.id}(思考: ${result.thinkingLevel})`);
        return true;
      }

      case "/cyclethinking": {
        const result = await rpc.requireClient().cycleThinkingLevel();
        if (!result) {
          await reply("❌ 没有可轮换的思考级别。");
          return true;
        }
        await reply(`✅ 思考级别已轮换为: ${result.level}`);
        return true;
      }

      case "/autocompact": {
        const arg = args.toLowerCase();
        if (arg !== "on" && arg !== "off") {
          const state = await rpc.requireClient().getState();
          await reply(
            `当前自动压缩: ${state.autoCompactionEnabled ? "开" : "关"}\n` +
              "用法: /autocompact on|off(实例级生效:写入 pi 全局设置,一个项目房间切换影响全部项目)"
          );
          return true;
        }
        await rpc.requireClient().setAutoCompaction(arg === "on");
        await reply(`✅ 自动压缩已${arg === "on" ? "开启" : "关闭"}(实例级生效)。`);
        return true;
      }

      case "/autoretry": {
        const arg = args.toLowerCase();
        if (arg !== "on" && arg !== "off") {
          // RpcSessionState exposes no autoRetry query field — usage only.
          await reply(
            "用法: /autoretry on|off\n(上游未暴露当前状态查询;实例级生效:写入 pi 全局设置,一个项目房间切换影响全部项目)"
          );
          return true;
        }
        await rpc.requireClient().setAutoRetry(arg === "on");
        await reply(`✅ 自动重试已${arg === "on" ? "开启" : "关闭"}(实例级生效)。`);
        return true;
      }

      case "/sessions": {
        await replySessionList(rpc, reply);
        return true;
      }

      case "/switch": {
        const state = await rpc.requireClient().getState();
        if (state.isStreaming) {
          await reply("⚠️ 当前任务流式进行中,请先 /stop 再切换会话。");
          return true;
        }
        const index = Number.parseInt(args, 10);
        if (!args || Number.isNaN(index) || index < 1) {
          await reply("用法: /switch <序号> — 切换到 /sessions 列表中的会话。");
          return true;
        }
        const sessions = listSessions(resolveSessionDir(rpc)).slice(0, 10);
        const target = sessions[index - 1];
        if (!target) {
          await reply(`❌ 序号超出范围: ${index}(用 /sessions 查看当前列表)。`);
          return true;
        }
        const result = await rpc.requireClient().switchSession(target.path);
        await reply(result.cancelled ? "⚠️ 切换会话被扩展取消" : `✅ 已切换会话: ${target.file}`);
        return true;
      }

      case "/reload": {
        // /reload all (issue #55): every rpc of the instance, idle ones only.
        if (args === "all") {
          if (!ctx.allRpcs) {
            await reply("❌ /reload all 不可用(当前部署未启用多进程枚举)。");
            return true;
          }
          await reply("🔄 正在逐个重启全部 pi 进程(空闲才重启,忙碌跳过)…");
          const result = await restartIdleRpcs(ctx.allRpcs());
          await reply(formatReloadAllResult(result));
          return true;
        }
        await reply("🔄 正在重启 pi 进程(扩展/技能/配置将重新加载)…");
        try {
          await rpc.restart();
          const state = await rpc.requireClient().getState();
          await reply(`✅ pi 已重启,模型: ${state.model?.id ?? "unknown"}`);
        } catch (err) {
          await reply(`❌ 重启失败: ${(err as Error).message}`);
        }
        return true;
      }

      // --- Model / thinking --------------------------------------------------
      case "/model": {
        if (!args) {
          const models = await rpc.requireClient().getAvailableModels();
          if (models.length === 0) {
            await reply("没有可用模型(未配置 provider?)");
            return true;
          }
          const current = await rpc.requireClient().getState();
          const list = models
            .map((m) => `• ${m.provider}/${m.id}${m.id === current.model?.id ? " ← 当前" : ""}`)
            .join("\n");
          await reply(`可用模型:\n${list}\n\n用法: /model <provider/model-id>`);
          return true;
        }
        const parsed = parseModelArg(args);
        if (!parsed.provider) {
          // Bare id — try to find a matching model and use its provider
          const models = await rpc.requireClient().getAvailableModels();
          const match = models.find((m) => m.id.includes(parsed.modelId));
          if (!match) {
            await reply(`❌ 找不到模型 "${parsed.modelId}"。用 /models 查看可用列表。`);
            return true;
          }
          parsed.provider = match.provider;
          parsed.modelId = match.id;
        }
        const result = (await rpc.requireClient().setModel(parsed.provider, parsed.modelId)) as { id?: string };
        await reply(`✅ 已切换模型: ${result.id ?? `${parsed.provider}/${parsed.modelId}`}`);
        return true;
      }

      case "/models": {
        const models = await rpc.requireClient().getAvailableModels();
        if (models.length === 0) {
          await reply("没有可用模型(未配置 provider?)");
          return true;
        }
        const current = await rpc.requireClient().getState();
        await reply(
          models
            .map((m) => `• ${m.provider}/${m.id}${m.id === current.model?.id ? " ← 当前" : ""}`)
            .join("\n")
        );
        return true;
      }

      case "/thinking": {
        if (!args) {
          const state = await rpc.requireClient().getState();
          await reply(
            `当前思考级别: ${state.thinkingLevel}\n可用级别: off, minimal, low, medium, high, xhigh, max\n用法: /thinking <level>`
          );
          return true;
        }
        await rpc.requireClient().setThinkingLevel(args as Parameters<RpcClient['setThinkingLevel']>[0]);
        await reply(`✅ 思考级别已设为: ${args}`);
        return true;
      }

      // --- Session info / export ---------------------------------------------
      case "/session":
      case "/cost": {
        const stats = await rpc.requireClient().getSessionStats();
        await reply(
          [
            `📊 会话: ${stats.sessionId}`,
            `消息数: ${stats.totalMessages}`,
            `tokens: ${stats.tokens.total}`,
            `费用: $${stats.cost.toFixed(4)}`,
          ].join("\n")
        );
        return true;
      }

      case "/status": {
        const state = await rpc.requireClient().getState();
        const modelName = state.model?.name || state.model?.id || "unknown";
        await reply(`⚙️ 模型: ${modelName}\n流式中: ${state.isStreaming ? "是" : "否"}`);
        return true;
      }

      case "/name": {
        if (!args) {
          await reply("用法: /name <会话名>");
          return true;
        }
        await rpc.requireClient().setSessionName(args);
        await reply(`✅ 会话已命名: ${args}`);
        return true;
      }

      case "/export": {
        const result = await rpc.requireClient().exportHtml(args || undefined);
        await reply(`✅ 已导出: ${result.path}`);
        return true;
      }

      // --- Bash ----------------------------------------------------------------
      case "/bash": {
        if (!args) {
          await reply("用法: /bash <shell 命令> — 在 pi 的工作目录执行并写入上下文");
          return true;
        }
        const release = ctx.bashTracker?.track(rpc, args);
        try {
          const result = await rpc.bash(args);
          await reply(formatBashReply(args, result));
          return true;
        } finally {
          release?.();
        }
      }

      case "/bashstop": {
        const inflight = ctx.bashTracker?.list(rpc) ?? [];
        if (inflight.length === 0) {
          await reply("💤 没有在跑的 bash 命令。");
          return true;
        }
        const lines = inflight.map(
          (entry) => `- \`${entry.command}\`(已跑 ${formatElapsed(Date.now() - entry.startedAt)})`
        );
        await rpc.requireClient().abortBash();
        await reply(`⏹ 已请求中止 ${inflight.length} 条在跑命令:\n${lines.join("\n")}\n各命令已捕获的输出随后回帖。`);
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
    await reply(`❌ 命令执行失败: ${(err as Error).message}`);
    return true;
  }
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

/** Project list text: name, status, workdir, room id. */
function helpText(): string {
  return [
    "**Pi 命令**(通过 RPC 执行):",
    "• `/new` — 新会话",
    "• `/compact [说明]` — 压缩上下文",
    "• `/model` / `/model <provider/id>` — 查看/切换模型",
    "• `/models` — 列出可用模型",
    "• `/thinking [level]` — 查看/设置思考级别",
    "• `/cyclemodel` / `/cyclethinking` — 轮换到下一个模型 / 思考级别",
    "• `/autocompact on|off` — 自动压缩开关(实例级生效:写入 pi 全局设置,一个项目房间切换影响全部项目)",
    "• `/autoretry on|off` — 自动重试开关(实例级生效,同上)",
    "• `/sessions` — 列出最近会话(按修改时间)",
    "• `/switch <序号>` — 切换到 /sessions 列出的会话(流式中需先 /stop)",
    "• `/last` — 复述 agent 最近一次回复",
    "• `/session` — 会话统计与费用",
    "• `/status` — 当前模型与状态",
    "• `/name <名字>` — 会话命名",
    "• `/export [路径]` — 导出会话 HTML",
    "• `/bash <命令>` — 执行 shell 命令(写入上下文)",
    "• `! <命令>` — 快捷执行 shell 命令(≈ TUI 的 `!`,结果写入上下文;感叹号后需空格)",
    "• `!! <命令>` — 同上,但结果不写入上下文(≈ TUI 的 `!!`)",
    "• `/bashstop` — 列出并中止在跑的 bash 命令(`!`/`!!`/`/bash` 通用)",
    "• `/queue [文本]` — 无参:查看队列;带文本:排队不打断当前任务(≈ Alt+Enter)",
    "• `/interrupt <新指令>` — 打断当前任务并立即下发新指令(一条消息完成)",
    "• `/stop` — 立即停止所有任务(≈ TUI 的 Esc;别名 `/abort`)",
    "• `/reload` — 重启 pi 进程(装插件/改配置后使用);`/reload all` — 重启本实例全部进程(空闲才重启,忙碌跳过)",
    "• `/login [provider [oauth|api_key]]` — 无参:可登录 provider 列表;带参:无头登录(仅管理员 + 管理房间)",
    "• `/logout <provider>` — 删除 provider 凭据(仅管理员 + 管理房间)",
    "• `/auth` — 查看已保存的 provider 凭据(仅管理员 + 管理房间)",
    "• `/pmctl new <名称> <路径>` — 创建项目(管理房间)",
    "• `/pmctl list` — 项目列表",
    "• `/pmctl show|rm|mv|rename` — 项目详情/删除/迁移/重命名(管理房间;",
    "  rm 需二次确认,确认后停止进程并退出房间)",
    "",
    "**透传**: `/skill:名称`、提示词模板、扩展命令会直接执行;普通文本发给模型。",
    adminCommandHelpText(),
  ].join("\n");
}
