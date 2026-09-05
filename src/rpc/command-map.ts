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
import { adminCommandHelpText } from "../auth/admin-commands.js";
import type { PiRpc } from "./pi-rpc.js";

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

/** "/queue" without arguments — render the steering/followUp mirror. */
async function replyQueueView(rpc: PiRpc, snapshot: QueueSnapshot | undefined, reply: (text: string) => Promise<void>): Promise<void> {
  const steering = snapshot?.steering ?? [];
  const followUp = snapshot?.followUp ?? [];
  if (steering.length === 0 && followUp.length === 0) {
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
  try {
    const state = await rpc.getState();
    const upstream = state.pendingMessageCount;
    const mirrored = steering.length + followUp.length;
    if (typeof upstream === "number" && upstream !== mirrored) {
      lines.push(`ℹ️ 上游报告待处理 ${upstream} 条(本地镜像 ${mirrored} 条),以实际执行为准。`);
    }
  } catch {
    // get_state unavailable — the mirror-only view still stands.
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
        const { cancelled } = await rpc.newSession();
        await reply(cancelled ? "⚠️ 新会话被扩展取消" : "✅ 已开始新会话");
        return true;
      }

      case "/compact": {
        const result = await rpc.compact(args || undefined);
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
        await rpc.abort();
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
        const state = await rpc.getState();
        if (!state.isStreaming) {
          await rpc.prompt(args);
          await reply("▶️ 当前没有运行中的任务,已直接下发新指令。");
          return true;
        }
        await rpc.abort();
        await rpc.waitForIdle();
        await rpc.prompt(args);
        await reply(withQueueWarning("🛑 已打断,新指令已发出。", queueView?.()));
        return true;
      }

      // --- Small utilities (issue #56 票5) ------------------------------------
      case "/last": {
        const last = await rpc.getLastAssistantText();
        const text = last?.trim();
        if (!text) {
          await reply("💤 没有可复述的回复(本会话还没有 assistant 输出)。");
          return true;
        }
        await reply(text.length > 3000 ? `${text.slice(0, 3000)}\n…(已截断)` : text);
        return true;
      }

      case "/cyclemodel": {
        const result = await rpc.cycleModel();
        if (!result) {
          await reply("❌ 没有可轮换的模型(启动未限定模型列表?)。用 /model <provider/id> 直接指定。");
          return true;
        }
        await reply(`✅ 已切换模型: ${result.model.provider}/${result.model.id}(思考: ${result.thinkingLevel})`);
        return true;
      }

      case "/cyclethinking": {
        const result = await rpc.cycleThinkingLevel();
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
          const state = await rpc.getState();
          await reply(
            `当前自动压缩: ${state.autoCompactionEnabled ? "开" : "关"}\n` +
              "用法: /autocompact on|off(实例级生效:写入 pi 全局设置,一个项目房间切换影响全部项目)"
          );
          return true;
        }
        await rpc.setAutoCompaction(arg === "on");
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
        await rpc.setAutoRetry(arg === "on");
        await reply(`✅ 自动重试已${arg === "on" ? "开启" : "关闭"}(实例级生效)。`);
        return true;
      }

      case "/sessions": {
        await replySessionList(rpc, reply);
        return true;
      }

      case "/switch": {
        const state = await rpc.getState();
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
        const result = await rpc.switchSession(target.path);
        await reply(result.cancelled ? "⚠️ 切换会话被扩展取消" : `✅ 已切换会话: ${target.file}`);
        return true;
      }

      case "/reload": {
        await reply("🔄 正在重启 pi 进程(扩展/技能/配置将重新加载)…");
        try {
          await rpc.restart();
          const state = await rpc.getState();
          await reply(`✅ pi 已重启,模型: ${state.model?.id ?? "unknown"}`);
        } catch (err) {
          await reply(`❌ 重启失败: ${(err as Error).message}`);
        }
        return true;
      }

      // --- Model / thinking --------------------------------------------------
      case "/model": {
        if (!args) {
          const models = await rpc.getAvailableModels();
          if (models.length === 0) {
            await reply("没有可用模型(未配置 provider?)");
            return true;
          }
          const current = await rpc.getState();
          const list = models
            .map((m) => `• ${m.provider}/${m.id}${m.id === current.model?.id ? " ← 当前" : ""}`)
            .join("\n");
          await reply(`可用模型:\n${list}\n\n用法: /model <provider/model-id>`);
          return true;
        }
        const parsed = parseModelArg(args);
        if (!parsed.provider) {
          // Bare id — try to find a matching model and use its provider
          const models = await rpc.getAvailableModels();
          const match = models.find((m) => m.id.includes(parsed.modelId));
          if (!match) {
            await reply(`❌ 找不到模型 "${parsed.modelId}"。用 /models 查看可用列表。`);
            return true;
          }
          parsed.provider = match.provider;
          parsed.modelId = match.id;
        }
        const result = (await rpc.setModel(parsed.provider, parsed.modelId)) as { id?: string };
        await reply(`✅ 已切换模型: ${result.id ?? `${parsed.provider}/${parsed.modelId}`}`);
        return true;
      }

      case "/models": {
        const models = await rpc.getAvailableModels();
        if (models.length === 0) {
          await reply("没有可用模型(未配置 provider?)");
          return true;
        }
        const current = await rpc.getState();
        await reply(
          models
            .map((m) => `• ${m.provider}/${m.id}${m.id === current.model?.id ? " ← 当前" : ""}`)
            .join("\n")
        );
        return true;
      }

      case "/thinking": {
        if (!args) {
          const state = await rpc.getState();
          await reply(
            `当前思考级别: ${state.thinkingLevel}\n可用级别: off, minimal, low, medium, high, xhigh, max\n用法: /thinking <level>`
          );
          return true;
        }
        await rpc.setThinkingLevel(args);
        await reply(`✅ 思考级别已设为: ${args}`);
        return true;
      }

      // --- Session info / export ---------------------------------------------
      case "/session":
      case "/cost": {
        const stats = await rpc.getSessionStats();
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
        const state = await rpc.getState();
        const modelName = state.model?.name || state.model?.id || "unknown";
        await reply(`⚙️ 模型: ${modelName}\n流式中: ${state.isStreaming ? "是" : "否"}`);
        return true;
      }

      case "/name": {
        if (!args) {
          await reply("用法: /name <会话名>");
          return true;
        }
        await rpc.setSessionName(args);
        await reply(`✅ 会话已命名: ${args}`);
        return true;
      }

      case "/export": {
        const result = await rpc.exportHtml(args || undefined);
        await reply(`✅ 已导出: ${result.path}`);
        return true;
      }

      // --- Bash ----------------------------------------------------------------
      case "/bash": {
        if (!args) {
          await reply("用法: /bash <shell 命令> — 在 pi 的工作目录执行并写入上下文");
          return true;
        }
        const result = await rpc.bash(args);
        const output = result.output.length > 3000
          ? result.output.slice(0, 3000) + "\n…(已截断)"
          : result.output;
        await reply(`$ ${args}\n\`\`\`\n${output || "(无输出)"}\n\`\`\`\n退出码: ${result.exitCode}`);
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
    "• `/queue [文本]` — 无参:查看队列;带文本:排队不打断当前任务(≈ Alt+Enter)",
    "• `/interrupt <新指令>` — 打断当前任务并立即下发新指令(一条消息完成)",
    "• `/stop` — 立即停止所有任务(≈ TUI 的 Esc;别名 `/abort`)",
    "• `/reload` — 重启 pi 进程(装插件/改配置后使用)",
    "• `/pmctl new <名称> <路径>` — 创建项目(管理房间)",
    "• `/pmctl list` — 项目列表",
    "• `/pmctl show|rm|mv|rename` — 项目详情/删除/迁移/重命名(管理房间;",
    "  rm 需二次确认,确认后停止进程并退出房间)",
    "",
    "**透传**: `/skill:名称`、提示词模板、扩展命令会直接执行;普通文本发给模型。",
    adminCommandHelpText(),
  ].join("\n");
}
