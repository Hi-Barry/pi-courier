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
import { t } from "../i18n/index.js";
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
  const suffix = excluded ? t("cmd.bash.notWritten") : "";
  const output = result.output.length > 3000
    ? result.output.slice(0, 3000) + `\n${t("common.truncated")}`
    : result.output;
  if (result.cancelled) {
    return `${t("cmd.bash.aborted", { command, suffix })}\n\`\`\`\n${output || t("common.noOutput")}\n\`\`\``;
  }
  return `$ ${command}${suffix}\n\`\`\`\n${output || t("common.noOutput")}\n\`\`\`\n${t("common.exitCode", { code: result.exitCode })}`;
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
  return t("cmd.queue.warning", { count: total, lines: lines.join("\n") });
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
        await reply(cancelled ? t("cmd.new.cancelled") : t("cmd.new.ok"));
        if (!cancelled) {
          // 镜像(active)跟随房间进程而非写死的文件 id,目录级 watch 对新
          // 会话照常生效;过期的是终端里那条附加命令 —— 指路重新 /attach。
          if (ctx.sessionMirror?.active()) {
            ctx.sessionMirror.rebase(await ctx.sessionMirror.currentSessionFile());
            await reply(t("cmd.new.mirrorHint"));
          }
        }
        return true;
      }

      case "/compact": {
        const result = await rpc.requireClient().compact(args || undefined);
        const line = [
          t("cmd.compact.ok"),
          t("cmd.compact.tokens", { before: result.tokensBefore }),
          t("cmd.compact.summary", { summary: result.summary.slice(0, 500) }),
        ].join("");
        await reply(line);
        return true;
      }

      case "/stop":
      case "/abort": {
        await rpc.requireClient().abort();
        // abort preserves the upstream queues (RPC has no clear_queue) — the
        // warning makes that limitation explicit instead of surprising the user.
        await reply(withQueueWarning(t("cmd.stop.ok"), queueView?.()));
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
        await rpc.requireClient().abort();
        await rpc.requireClient().waitForIdle();
        await rpc.prompt(args);
        await reply(withQueueWarning(t("cmd.interrupt.done"), queueView?.()));
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
          await reply(t("cmd.reload.failed", { message: (err as Error).message }));
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
            .map((m) => `• ${m.provider}/${m.id}${m.id === current.model?.id ? t("cmd.model.currentMarker") : ""}`)
            .join("\n");
          await reply(t("cmd.model.list", { list }));
          return true;
        }
        const parsed = parseModelArg(args);
        if (!parsed.provider) {
          // Bare id — try to find a matching model and use its provider
          const models = await rpc.requireClient().getAvailableModels();
          const match = models.find((m) => m.id.includes(parsed.modelId));
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
            .map((m) => `• ${m.provider}/${m.id}${m.id === current.model?.id ? t("cmd.model.currentMarker") : ""}`)
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
        const modelName = state.model?.name || state.model?.id || "unknown";
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
          await reply(formatBashReply(args, result));
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
    await reply(t("cmd.generic.error", { message: (err as Error).message }));
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
    t("cmd.help.piCommands"),
    "",
    t("cmd.help.passthrough"),
    adminCommandHelpText(),
  ].join("\n");
}
