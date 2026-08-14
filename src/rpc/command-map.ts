/**
 * Slash command map — turns `/command args` messages from messengers into RPC calls.
 *
 * Layer ordering (matches previous extension behaviour, minus the conflicts):
 *  1. Bridge admin commands (/help, /trusted, ...) are handled by ChallengeAuth before this module
 *  2. Builtin pi commands that have a dedicated RPC command are mapped here
 *  3. Everything else starting with "/" is forwarded via prompt: extension commands,
 *     skill commands (/skill:name) and prompt templates (/template) are expanded by pi itself
 *  4. Unknown commands get a helpful error listing what is available
 */
import type { PiRpc } from "./pi-rpc.js";
import type { ProjectManager } from "./project-manager.js";
import { loadConfig } from "../config.js";

export interface SlashCommandContext {
  rpc: PiRpc;
  /** Send a reply back to the originating chat */
  reply: (text: string) => Promise<void>;
  /** Multi-project management (project rooms). Optional. */
  projectManager?: ProjectManager;
  /** Create a private room + invite a user (Matrix). Optional. */
  createProjectRoom?: (name: string, inviteUserId: string) => Promise<string | null>;
  /** Admin user MXID (invite target for /newproject), e.g. matrix:@barry:server. */
  adminUserId?: string;
}

/** Returns true if the command was handled (something was done / replied). */
export async function handleSlashCommand(
  text: string,
  ctx: SlashCommandContext
): Promise<boolean> {
  const { rpc, reply } = ctx;
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
        await reply("🛑 已停止所有任务,等待下一步指示。");
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

      // --- Project management ------------------------------------------------
      case "/newproject": {
        if (!ctx.projectManager || !ctx.createProjectRoom) {
          await reply("❌ /newproject 不可用(仅 Matrix 部署支持)");
          return true;
        }
        const space = args.indexOf(" ");
        const name = (space === -1 ? args : args.slice(0, space)).trim();
        const workdir = (space === -1 ? "" : args.slice(space + 1)).trim();
        if (!name || !workdir) {
          await reply(
            "用法: /newproject <项目名> <项目路径>\n例: /newproject myapp /home/you/Projects/myapp\n项目路径必须是绝对路径。"
          );
          return true;
        }
        if (!workdir.startsWith("/")) {
          await reply(`❌ 路径必须是绝对路径(以 / 开头): ${workdir}`);
          return true;
        }
        // Create a private room named after the project and invite the admin.
        const inviteMxid = (ctx.adminUserId ?? "").replace(/^matrix:/, "");
        if (!inviteMxid) {
          await reply("❌ 缺少邀请对象(未配置信任用户)");
          return true;
        }
        try {
          const roomId = await ctx.createProjectRoom(name, inviteMxid);
          if (!roomId) {
            await reply("❌ 房间创建失败(Matrix 未连接?)");
            return true;
          }
          ctx.projectManager.registerProject(roomId, workdir);
          await reply(
            `✅ 项目「${name}」创建完成!\n\n` +
              `• 房间: ${roomId}\n` +
              `• 工作目录: ${workdir}\n` +
              `• 已邀请你进入新房间\n\n` +
              `项目对话请到新房间进行(独立上下文与工作目录)。`
          );
        } catch (err) {
          await reply(`❌ 创建项目失败: ${(err as Error).message}`);
        }
        return true;
      }

      case "/projects": {
        const projects = ctx.projectManager
          ? loadProjectsText()
          : "无(未启用多项目)";
        await reply(projects);
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

/** One-line list of configured projects (roomId -> workdir). */
function loadProjectsText(): string {
  const projects = loadConfig().projects ?? {};
  const lines = Object.entries(projects).map(([roomId, p]) => `• ${roomId} → ${p.workdir}`);
  return lines.length > 0 ? `**项目列表**:\n${lines.join("\n")}` : "暂无项目(用 /newproject 创建)";
}

function helpText(): string {
  return [
    "**Pi 命令**(通过 RPC 执行):",
    "• `/new` — 新会话",
    "• `/compact [说明]` — 压缩上下文",
    "• `/model` / `/model <provider/id>` — 查看/切换模型",
    "• `/models` — 列出可用模型",
    "• `/thinking [level]` — 查看/设置思考级别",
    "• `/session` — 会话统计与费用",
    "• `/status` — 当前模型与状态",
    "• `/name <名字>` — 会话命名",
    "• `/export [路径]` — 导出会话 HTML",
    "• `/bash <命令>` — 执行 shell 命令(写入上下文)",
    "• `/stop` — 立即停止所有任务(≈ TUI 的 Esc;别名 `/abort`)",
    "• `/reload` — 重启 pi 进程(装插件/改配置后使用)",
    "• `/newproject <项目名> <路径>` — 创建新项目(自动建私有房间;DM 里使用)",
    "• `/projects` — 查看项目列表",
    "",
    "**透传**: `/skill:名称`、提示词模板、扩展命令会直接执行;普通文本发给模型。",
    "**Bridge 管理命令**: `/help`(本帮助)、`/trusted`、`/revoke`、`/channels`、`/enable`、`/disable`、`/toggletools`",
  ].join("\n");
}
