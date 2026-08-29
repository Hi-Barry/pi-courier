/**
 * Slash command map — turns `/command args` messages from messengers into RPC calls.
 *
 * Layer ordering (matches previous extension behaviour, minus the conflicts):
 *  1. ChallengeAuth handles challenge codes and its own admin commands
 *     (/trusted, /revoke, /channels, /enable, /disable, /toggletools) in the
 *     router pipeline before this module
 *  2. Builtin pi commands that have a dedicated RPC command are mapped here
 *  3. Everything else starting with "/" is forwarded via prompt: extension commands,
 *     skill commands (/skill:name) and prompt templates (/template) are expanded by pi itself
 *  4. Unknown commands get a helpful error listing what is available
 *  /help is unified HERE (pi commands + bridge admin commands) — the single
 *  help surface; ChallengeAuth no longer has its own help text.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ConfigStore } from "../config.js";
import type { PiRpc } from "./pi-rpc.js";
import type { ProjectManager } from "./project-manager.js";

/**
 * Resolve a project path: absolute paths are used as-is; relative paths are
 * resolved against the project root (config.workdir, the setup-time default
 * project directory) — so `/pmctl new myapp myapp` lands in ~/Projects/myapp.
 */
function resolveProjectPath(p: string, store: ConfigStore): string {
  if (p.startsWith("/")) return p;
  const root = store.get().workdir ?? path.join(os.homedir(), "Projects");
  return path.join(root, p);
}

export interface SlashCommandContext {
  rpc: PiRpc;
  /** Send a reply back to the originating chat */
  reply: (text: string) => Promise<void>;
  /** Multi-project management (project rooms). Optional. */
  projectManager?: ProjectManager;
  /** Create a private room + invite a user (RoomOps; throws on failure). Optional. */
  createProjectRoom?: (name: string, inviteUserId: string) => Promise<string>;
  /** Admin user MXID (invite target for /pmctl new), e.g. matrix:@barry:server. */
  adminUserId?: string;
  /** The user who sent this command (invite target for /pmctl new). */
  senderUserId?: string;
  /** The room this command came from. */
  chatId?: string;
  /** Whether this room is the management room (first paired DM). */
  isManagementRoom?: boolean;
  /** Whether multi-project mode is active (for /pmctl availability). */
  isMultiProject?: boolean;
  /** Injected config store — the single runtime read path. */
  store: ConfigStore;
  /** Rename a room via the Matrix transport (optional). */
  setRoomName?: (roomId: string, name: string) => Promise<void>;
  /** Have the bot leave a room via the Matrix transport (optional). */
  leaveRoom?: (roomId: string, reason?: string) => Promise<void>;
  /** Promote a user in a room via the Matrix transport (optional). */
  setUserPowerLevel?: (roomId: string, userId: string, level: number) => Promise<void>;
}

/**
 * Pending /pmctl rm confirmation, keyed by the chat that issued the request.
 * A first `/pmctl rm <target>` only arms the delete; the same command issued
 * again in the same chat confirms it.
 */
const pendingRm = new Map<string, { roomId: string; name: string; ts: number }>();

/** Returns true if the command was handled (something was done / replied). */
export async function handleSlashCommand(
  text: string,
  ctx: SlashCommandContext
): Promise<boolean> {
  const { rpc, reply } = ctx;
  const chatId = ctx.chatId ?? "";
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

      // --- Project management (/pmctl, management room only) ------------------
      case "/pmctl":
      case "/newproject":
      case "/projects": {
        // In single-project mode /pmctl is not available.
        if (ctx.isMultiProject === false) {
          await reply("❌ 当前为单工程模式,未启用项目管理。\n如需多工程:发 `/multiproject on` 并重启(pi-courier restart)。");
          return true;
        }
        // Management commands are only available in the management room
        // (the first paired DM). Project rooms are for conversation only.
        if (!ctx.isManagementRoom) {
          await reply("❌ /pmctl 仅可在管理房间(与 bot 的私聊)使用");
          return true;
        }
        if (!ctx.projectManager || !ctx.createProjectRoom) {
          await reply("❌ /pmctl 不可用(仅 Matrix 部署支持)");
          return true;
        }
        const pm = ctx.projectManager;
        const legacyNewProject = name === "/newproject";
        const legacyProjects = name === "/projects";

        // Resolve the sub-command.
        let op: string;
        let rest = args;
        if (legacyNewProject) {
          op = "new";
        } else if (legacyProjects) {
          op = "list";
        } else {
          const sp = args.indexOf(" ");
          op = (sp === -1 ? args : args.slice(0, sp)).trim() || "list";
          rest = (sp === -1 ? "" : args.slice(sp + 1)).trim();
        }

        switch (op) {
          case "new": {
            const sp = rest.indexOf(" ");
            const pname = (sp === -1 ? rest : rest.slice(0, sp)).trim();
            const workdirArg = (sp === -1 ? "" : rest.slice(sp + 1)).trim();
            if (!pname) {
              await reply(
                "用法: /pmctl new <项目名> [路径]\n" +
                  "路径可选:缺省为工程根下同名目录(如 newapp → ~/Projects/newapp);" +
                  "也可用相对路径或绝对路径。"
              );
              return true;
            }
            // Path is optional: default to <project root>/<name>.
            const resolvedWorkdir = workdirArg
              ? resolveProjectPath(workdirArg, ctx.store)
              : resolveProjectPath(pname, ctx.store);
            const inviteMxid = (ctx.senderUserId ?? ctx.adminUserId ?? "").replace(/^matrix:/, "");
            if (!inviteMxid) {
              await reply("❌ 缺少邀请对象(未配置信任用户)");
              return true;
            }
            try {
              const instance = ctx.store.get().instanceName ?? os.hostname();
              const roomId = await ctx.createProjectRoom(`${pname}(${instance})`, inviteMxid);
              pm.registerProject(roomId, resolvedWorkdir, pname);
              // The bot creates the room, so make the sender the room admin
              // so they can rename / invite / manage it themselves. Failure
              // here must not fail the (already created) project.
              if (ctx.setUserPowerLevel && inviteMxid) {
                try {
                  await ctx.setUserPowerLevel(roomId, inviteMxid, 100);
                } catch (err) {
                  await reply(`⚠️ 房间已创建,但设为管理员失败(可手动设置): ${(err as Error).message}`);
                }
              }
              await reply(
                `✅ 项目「${pname}」创建完成!\n\n` +
                  `• 房间: ${roomId}\n` +
                  `• 工作目录: ${resolvedWorkdir}\n` +
                  `• 已邀请你进入新房间\n\n` +
                  `项目对话请到新房间进行(独立上下文与工作目录)。`
              );
            } catch (err) {
              await reply(`❌ 创建项目失败: ${(err as Error).message}`);
            }
            return true;
          }

          case "list": {
            await reply(pmctlListText(pm));
            return true;
          }

          case "show": {
            const target = rest.trim();
            if (!target) {
              await reply("用法: /pmctl show <项目名|房间ID>");
              return true;
            }
            const found = pm.listProjects().find(
              ([roomId, p]) => p.name === target || roomId === target
            );
            if (!found) {
              await reply(`❌ 未找到项目: ${target}(用 /pmctl list 查看)`);
              return true;
            }
            const [roomId, entry] = found;
            await reply(
              `📁 项目: ${entry.name ?? roomId}\n` +
                `• 房间: ${roomId}\n` +
                `• 工作目录: ${entry.workdir}\n` +
                `• 状态: ${pm.isRunning(roomId) ? "✅ 运行中" : "⏸️ 未启动(lazy)"}\n` +
                `• 会话: ${entry.workdir}/.pi-session`
            );
            return true;
          }

          case "rm": {
            const target = rest.trim();
            if (!target) {
              await reply("用法: /pmctl rm <项目名|房间ID>");
              return true;
            }
            // cancel: 清除待确认状态
            if (target === "cancel" || target === "no" || target === "取消") {
              const had = pendingRm.delete(chatId);
              await reply(had ? "✅ 已取消删除" : "当前没有待确认的删除操作");
              return true;
            }
            const found = pm.listProjects().find(
              ([roomId, p]) => p.name === target || roomId === target
            );
            if (!found) {
              pendingRm.delete(chatId);
              await reply(`❌ 未找到项目: ${target}(用 /pmctl list 查看)`);
              return true;
            }
            const [roomId, entry] = found;
            // A pending confirmation expires after 60s to avoid a stale
            // confirmation silently deleting a project much later.
            const pending = pendingRm.get(chatId);
            if (pending?.ts && Date.now() - pending.ts > 60_000) {
              pendingRm.delete(chatId); // expired — treat as a fresh rm
              await reply(`⏳ 上次确认已超时(60 秒),需重新确认。`);
            }
            const pendingCurrent = pendingRm.get(chatId);
            if (pendingCurrent && pendingCurrent.roomId === roomId) {
              pendingRm.delete(chatId);
              await pm.removeProject(roomId);
              await reply(
                `🗑️ 项目「${entry.name ?? roomId}」已删除\n` +
                  `• 已解除映射并停止进程\n` +
                  `• 工作目录保留: ${entry.workdir}(如需删除请自行处理)\n` +
                  `• 正在主动退出房间…`
              );
              if (ctx.leaveRoom) {
                try {
                  await ctx.leaveRoom(roomId, "项目已删除");
                } catch (err) {
                  await reply(`⚠️ 房间退出失败(可手动退出): ${(err as Error).message}`);
                }
              }
              return true;
            }
            // 第一次:仅要求确认,不删除
            pendingRm.set(chatId, { roomId, name: entry.name ?? roomId, ts: Date.now() });
            await reply(
              `⚠️ 确认删除项目「${entry.name ?? roomId}」?\n\n` +
                `再次发送 \`/pmctl rm ${entry.name ?? roomId}\` 确认删除。\n` +
                `确认后我会停止进程并主动退出该房间。\n` +
                `(发送 \`/pmctl rm cancel\` 取消)`
            );
            return true;
          }

          case "mv": {
            const sp = rest.indexOf(" ");
            const target = (sp === -1 ? rest : rest.slice(0, sp)).trim();
            const newWorkdir = (sp === -1 ? "" : rest.slice(sp + 1)).trim();
            if (!target || !newWorkdir) {
              await reply("用法: /pmctl mv <项目名|房间ID> <新路径>(相对路径基于工程根)");
              return true;
            }
            const resolvedWorkdir = resolveProjectPath(newWorkdir, ctx.store);
            const found = pm.listProjects().find(
              ([roomId, p]) => p.name === target || roomId === target
            );
            if (!found) {
              await reply(`❌ 未找到项目: ${target}(用 /pmctl list 查看)`);
              return true;
            }
            const [roomId, entry] = found;
            pm.updateProjectWorkdir(roomId, resolvedWorkdir);
            await reply(
              `🚚 项目「${entry.name ?? roomId}」已迁移\n` +
                `• 新工作目录: ${resolvedWorkdir}\n` +
                `• 会话将重新开始(旧会话保留在旧目录 .pi-session)`
            );
            return true;
          }

          case "rename": {
            const sp = rest.indexOf(" ");
            const target = (sp === -1 ? rest : rest.slice(0, sp)).trim();
            const newName = (sp === -1 ? "" : rest.slice(sp + 1)).trim();
            if (!target || !newName) {
              await reply("用法: /pmctl rename <项目名|房间ID> <新名称>");
              return true;
            }
            const found = pm.listProjects().find(
              ([roomId, p]) => p.name === target || roomId === target
            );
            if (!found) {
              await reply(`❌ 未找到项目: ${target}(用 /pmctl list 查看)`);
              return true;
            }
            const [roomId] = found;
            pm.renameProject(roomId, newName);
            const renamed = `✏️ 项目已重命名为「${newName}」`;
            if (ctx.setRoomName) {
              // The project mapping is already renamed; surface room-rename
              // failures instead of swallowing them.
              try {
                await ctx.setRoomName(roomId, newName);
                await reply(renamed);
              } catch (err) {
                await reply(`${renamed}(房间改名失败: ${(err as Error).message})`);
              }
            } else {
              await reply(renamed);
            }
            return true;
          }

          default:
            await reply(`❌ 未知操作: ${op}\n可用操作: new / list / show / rm / mv / rename`);
            return true;
        }
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
function pmctlListText(pm: ProjectManager): string {
  const projects = pm.listProjects();
  if (projects.length === 0) {
    return "暂无项目(用 /pmctl new <名称> <路径> 创建)";
  }
  const lines = projects.map(([roomId, p]) => {
    const status = pm.isRunning(roomId) ? "✅ 运行中" : "⏸️ 未启动";
    return `• ${p.name ?? roomId} — ${status}\n  ${p.workdir} (${roomId})`;
  });
  return `**项目列表** (${projects.length}):\n${lines.join("\n")}`;
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
    "• `/pmctl new <名称> <路径>` — 创建项目(管理房间)",
    "• `/pmctl list` — 项目列表",
    "• `/pmctl show|rm|mv|rename` — 项目详情/删除/迁移/重命名(管理房间;",
    "  rm 需二次确认,确认后停止进程并退出房间)",
    "",
    "**透传**: `/skill:名称`、提示词模板、扩展命令会直接执行;普通文本发给模型。",
    "**Bridge 管理命令**: `/help`(本帮助)、`/trusted`、`/revoke`、`/channels`、`/enable`、`/disable`、`/toggletools`",
    "**认证**: 首次私聊 bot → bot 终端显示 6 位验证码 → 在聊天里输入验证码即成为信任用户(第一个信任用户 = 管理员)。群聊由信任用户在群里发 `/enable <模式>` 启用。",
  ].join("\n");
}
