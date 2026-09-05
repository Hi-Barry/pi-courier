/**
 * Message router — the core wiring between messenger transports and pi RPC.
 *
 * Shared by the standalone entry (and testable in isolation with a mock transport):
 *   incoming messenger message ──> router ──> RPC command / prompt
 *   agent events ────────────────> router ──> reply back to the messenger
 */

import * as os from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { handleAdminCommand } from "../auth/admin-commands.js";
import { type ChallengeAuth, namespacedId } from "../auth/challenge-auth.js";
import { type ConfigStore, defaultProjectsRoot } from "../config.js";
import {
  extractTextFromMessage,
  formatToolCalls,
  hasToolCalls,
  splitMessage,
} from "../formatting.js";
import { isEnabled, type LeveledLogger, logger } from "../logger.js";
import { buildManagementRoomHelp, managementRoomName } from "../management-room.js";
import { demoteTrustedUserEverywhere, inviteUserToManagementRoomOnce, inviteUserToSpaceOnce } from "../space.js";
import type { RoomOps } from "../transports/interface.js";
import type { ExternalMessage, ReplyTarget } from "../types.js";
import { handleSlashCommand, type QueueSnapshot } from "./command-map.js";
import type { PiRpc } from "./pi-rpc.js";
import type { PmctlController } from "./pmctl-controller.js";
import type { ProjectManager } from "./project-manager.js";

export interface MessageRouterDeps {
  /** Multi-project routing: resolves the PiRpc for a room (default when unmapped). */
  projectManager: ProjectManager;
  auth: ChallengeAuth;
  /** Send a text reply to a chat via a transport (errors swallowed by caller) */
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>;
  /** Best-effort typing indicator (silent no-op when unavailable) */
  sendTyping: (chatId: string, transport: string) => Promise<void>;
  /** Injected config store — the single runtime read/write path. */
  store: ConfigStore;
  /** Room-management capability (Matrix). Optional: absent in single-project
   *  or non-Matrix deployments; only the /pmctl path and management-room
   *  branding consume it. */
  roomOps?: RoomOps;
  /** Multi-project management (/pmctl family): gates + actions in one module. */
  pmctl: PmctlController;
  /** Space-mode gate: while the organizational space is enabled, the
   *  management room is bot-created at startup and first-DM adoption is
   *  reserved for the degraded path (space ensure failed this run). Absent
   *  = always allowed (legacy deployments). */
  managementRoomAdoptionAllowed?: () => boolean;
}

export interface MessageRouter {
  /** Handle an incoming messenger message */
  handleIncoming(msg: ExternalMessage): Promise<void>;
  /** Handle an agent event emitted by `rpc` — the reply target comes from
   *  the rpc's binding (see RoomBinding), never from a global slot. */
  handleEvent(rawEvent: unknown, rpc: PiRpc): void;
}

/**
 * Reply routing: every pi process is bound to the chat that prompted it.
 * Project rpcs are pinned to their owning room (re-bound here with the real
 * transport/username); the shared default rpc is re-bound by each DM prompt.
 * Because bindings are per-process, a project-room prompt can never misroute
 * a DM reply — the b7a5d7f bug class dies structurally. Cross-conversation
 * attribution inside ONE shared process is a protocol limit (pi's RPC has no
 * chat concept), so the default rpc's binding legitimately follows the most
 * recent prompter.
 */
interface RoomBinding {
  /** Pinned bindings (project rooms) survive completed turns; the shared
   *  default rpc's binding releases after one. */
  pinned: boolean;
  replyTarget: ReplyTarget;
}

/** Format a completed turn into reply text. Returns text = null when the turn
 *  has no replyable content (the binding is kept for the follow-up turn). */
export function buildTurnReply(
  message: AssistantMessage,
  hideToolCalls?: boolean
): { text: string | null; pendingTools: boolean } {
  const responseText = extractTextFromMessage(message);
  const toolCallsText = formatToolCalls(message);
  const pendingTools = hasToolCalls(message);
  const parts: string[] = [];
  const trimmed = responseText.trim();
  if (trimmed) parts.push(trimmed);
  if (toolCallsText && !hideToolCalls) parts.push(toolCallsText);
  if (parts.length === 0) return { text: null, pendingTools };
  return { text: parts.join("\n\n"), pendingTools };
}

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  const { projectManager, auth, sendReply, sendTyping, roomOps, store, pmctl, managementRoomAdoptionAllowed } = deps;
  const bindings = new WeakMap<PiRpc, RoomBinding>();
  const bindReplyTarget = (rpc: PiRpc, replyTarget: ReplyTarget, pinned: boolean): void => {
    bindings.set(rpc, { pinned, replyTarget });
  };

  // Live steering/followUp queue mirror per rpc, refreshed by queue_update
  // events (/queue display and the stop/interrupt warning read it). RPC has no
  // clear_queue, so the mirror intentionally keeps reflecting the upstream
  // queues even after abort — that persistence is surfaced to the user.
  const queueMirrors = new WeakMap<PiRpc, QueueSnapshot>();

  return {
    async handleIncoming(msg: ExternalMessage): Promise<void> {
      const text = msg.content.trim();
      if (!text) return;

      // Project tagging (spec #34): a mapped room's lines carry its label;
      // everything else (single-project mode, DM, unmapped rooms) resolves to
      // undefined = the plain logger, byte-identical to the old output.
      const label = projectManager.labelForRoom(msg.chatId);
      const log = logger.withLabel(label);

      if (isEnabled("debug")) {
        log.debug(`📥 [${msg.transport}] @${msg.username}: ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}`);
      } else {
        log.info(`📥 [${msg.transport}] @${msg.username}: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
      }

      // Authorization (initiates 6-digit challenge for unknown users in DMs)
      const isAuthorized = await auth.checkAuthorization(
        msg.userId,
        msg.chatId,
        msg.username,
        msg.isGroupChat,
        msg.wasMentioned ?? false,
        async (cId, replyText) => sendReply(cId, msg.transport, replyText),
        msg.transport
      );

      // Bridge admin commands + challenge codes in DMs.
      // /help is reserved for pi (the RPC command help also lists bridge commands).
      if (!msg.isGroupChat && (text.startsWith("/") || /^\d{6}$/.test(text))) {
        const cmdName = text.split(/\s+/)[0].toLowerCase();
        if (!text.startsWith("/") || cmdName !== "/help") {
          const result = handleAdminCommand(auth, {
            text,
            userId: msg.userId,
            transport: msg.transport,
            hideToolCalls: store.get().hideToolCalls,
          });
          if (result.handled) {
            for (const replyText of result.replies) {
              await sendReply(msg.chatId, msg.transport, replyText);
            }
            for (const notification of result.notifications) {
              logger.info(`[auth:${notification.level}] ${notification.message}`);
            }
            for (const effect of result.effects) {
              if (effect.kind === "persistAuth") {
                store.update({ auth: auth.exportConfig() });
              } else if (effect.kind === "hideToolCalls") {
                store.update({ hideToolCalls: effect.value });
              } else if (effect.kind === "spaceInvite" && roomOps) {
                // Trust just granted (challenge passed): invite into the
                // organizational space — fire-once, best-effort (see space.ts).
                await inviteUserToSpaceOnce(
                  roomOps,
                  store,
                  namespacedId(effect.userId, effect.transport)
                );
              } else if (effect.kind === "managementRoomInvite" && roomOps) {
                // Trust just granted: the management room (/pmctl home) must be
                // reachable too — fire-once, best-effort, space mode only; the
                // degraded path's adopted DM is never used to pull people in.
                await inviteUserToManagementRoomOnce(
                  roomOps,
                  store,
                  namespacedId(effect.userId, effect.transport)
                );
              } else if (effect.kind === "powerDemote" && roomOps) {
                // Trust just revoked (ticket 3): strip the admin power this
                // instance once granted — every managed room, PL 0. Best-effort
                // like the invite effects: failures warn and stay in the
                // powerElevatedUsers bookkeeping for the startup heal to retry;
                // the revoke itself stands either way.
                await demoteTrustedUserEverywhere(
                  roomOps,
                  store,
                  namespacedId(effect.userId, effect.transport)
                );
              }
            }
            return;
          }
        }
      }

      // Group chats: a trusted user can enable the current room without
      // knowing its ID — send "/enable <mode>" right in the room. This must
      // run BEFORE authorization (unenabled rooms are not authorized).
      if (msg.isGroupChat && text.startsWith("/enable")) {
        const isTrusted = auth.isTrustedUser(msg.userId, msg.transport);
        if (isTrusted) {
          const parts = text.split(/\s+/);
          const mode = (parts[1] || "trusted-only") as "all" | "mentions" | "trusted-only";
          if (mode !== "all" && mode !== "mentions" && mode !== "trusted-only") {
            await sendReply(msg.chatId, msg.transport, "用法: /enable <all|mentions|trusted-only>(本房间)");
            return;
          }
          // "all" responds to everyone — admin-only. Trusted users may only
          // request trusted-only / mentions.
          if (mode === "all" && !auth.isAdminUser(msg.userId, msg.transport)) {
            await sendReply(msg.chatId, msg.transport, "❌ all 模式仅管理员可用(可采用 trusted-only 或 mentions)");
            return;
          }
          auth.enableChannel(msg.chatId, mode);
          store.update({ auth: auth.exportConfig() });
          await sendReply(msg.chatId, msg.transport, `✅ 本房间已启用 (mode: ${mode})`);
          logger.info(`[auth] 房间 ${msg.chatId} 已由 ${msg.username} 启用 (${mode})`);
          return;
        }
      }

      if (!isAuthorized) return;

      // /multiproject — switch single/multi project mode. Config read/write;
      // takes effect on restart. Trusted users may toggle.
      if (text.startsWith("/multiproject")) {
        const isTrusted = auth.isTrustedUser(msg.userId, msg.transport);
        if (!isTrusted) {
          await sendReply(msg.chatId, msg.transport, "❌ 无权限(仅信任用户可切换多工程模式)");
          return;
        }
        const action = text.split(/\s+/)[1]?.toLowerCase() ?? "";
        const current = projectManager.isMultiProject ? "多工程模式(开启)" : "单工程模式(关闭)";
        if (action === "on" || action === "off") {
          const next = action === "on";
          if (next === projectManager.isMultiProject) {
            await sendReply(msg.chatId, msg.transport, `当前已是${current},无需切换。`);
            return;
          }
          store.update({ multiProject: next });
          await sendReply(
            msg.chatId,
            msg.transport,
            `✅ 已${next ? "开启" : "关闭"}多工程模式。\n重启生效:运行 \`pi-courier restart\`(${next ? "重启后将启用管理房间/项目房间 /pmctl" : "重启后所有房间直接连默认 pi"})。`
          );
        } else {
          await sendReply(
            msg.chatId,
            msg.transport,
            `当前: ${current}\n\n用法:\n/multiproject on  — 开启多工程(重启生效)\n/multiproject off — 关闭多工程,回到单工程(重启生效)`
          );
        }
        return;
      }

      // Management room = the FIRST accepted message in a private (≤2 person)
      // non-project room fixes that room's ID (managementRooms[0]). Works for
      // BOTH challenge-code pairing and config-driven trusted users. Only in
      // multi-project mode.
      const multiProject = projectManager.isMultiProject;
      if (
        multiProject &&
        roomOps &&
        (managementRoomAdoptionAllowed?.() ?? true) &&
        !store.get().managementRooms?.[0] &&
        !msg.isGroupChat &&
        !projectManager.isProjectRoom(msg.chatId)
      ) {
        await maybeInitManagementRoom(msg, sendReply, roomOps, store);
      }
      const isManagementRoom = multiProject && (store.get().managementRooms?.[0] ?? "") === msg.chatId;

      // Resolve the pi process for this room: project rooms get their own
      // (lazily started), everything else (DM) uses the shared default Rpc.
      let roomRpc: PiRpc;
      try {
        roomRpc = await projectManager.getRpcForRoom(msg.chatId);
      } catch (err) {
        await sendReply(
          msg.chatId,
          msg.transport,
          `❌ 无法启动 pi 进程: ${(err as Error).message}`
        );
        return;
      }

      // Bind this room to the pi process that will serve it (per-process
      // binding — see RoomBinding above). Binding unconditionally is safe:
      // a project-room prompt only ever re-pins the project rpc to its own
      // room, so the default rpc's DM binding is untouched.
      bindReplyTarget(
        roomRpc,
        { chatId: msg.chatId, transport: msg.transport, username: msg.username },
        projectManager.isProjectRoom(msg.chatId)
      );

      // /pmctl family first: gates + actions live in the controller. The
      // invite target arrives pre-resolved (transport-native MXID).
      if (await pmctl.handle(text, { chatId: msg.chatId, senderMxid: msg.userId, isManagementRoom }, async (replyText) => sendReply(msg.chatId, msg.transport, replyText))) {
        return;
      }

      // Slash commands → RPC mapping (builtin) or passthrough (extensions/skills/templates)
      if (text.startsWith("/")) {
        try {
          const handled = await handleSlashCommand(text, {
            rpc: roomRpc,
            reply: async (replyText) => sendReply(msg.chatId, msg.transport, replyText),
            queueView: () => queueMirrors.get(roomRpc),
          });
          if (handled) return;
        } catch (err) {
          await sendReply(msg.chatId, msg.transport, `❌ 命令执行失败: ${(err as Error).message}`);
          return;
        }
      }

      // Plain message → prompt
      try {
        await roomRpc.prompt(text);
      } catch (err) {
        await sendReply(msg.chatId, msg.transport, `❌ 无法发送给 pi: ${(err as Error).message}`);
      }
    },

    handleEvent(rawEvent: unknown, rpc: PiRpc): void {
      // The reply target comes from the rpc's own binding — project rpcs are
      // pinned to their room, the default rpc follows its latest prompter.
      const target = bindings.get(rpc)?.replyTarget;

      // Tagged view: a project rpc's events all carry its label; the default
      // rpc's do not (rpc.label is undefined there — spec #34).
      const log = logger.withLabel(rpc.label);

      // extension_error is emitted by the RPC layer but is not part of the
      // typed AgentSessionEvent union — widen for runtime event checking.
      const event = rawEvent as AgentEventView;


      logAgentEvent(event, log);

      // Refresh the queue mirror before any routing decisions — /queue and the
      // stop/interrupt queue warning read this snapshot.
      if (event.type === "queue_update") {
        queueMirrors.set(rpc, {
          steering: [...(event.steering ?? [])],
          followUp: [...(event.followUp ?? [])],
        });
      }

      if (event.type === "turn_start") {
        if (target) {
          sendTyping(target.chatId, target.transport).catch(() => {});
        }
        return;
      }

      if (event.type === "turn_end") {
        if (!target) return;
        const turn = buildTurnReply(event.message as AssistantMessage, store.get().hideToolCalls);

        // Reply summary at INFO level — the full conversation is also in pi's
        // session file.
        const replyPreview = turn.text ?? "";
        log.info(`[agent] 回复 @${target.username}: ${replyPreview.slice(0, 500)}${replyPreview.length > 500 ? "…" : ""}`);

        if (turn.text === null) {
          // No content this turn — keep the binding for a follow-up turn
          return;
        }

        for (const chunk of splitMessage(turn.text, 4000)) {
          sendReply(target.chatId, target.transport, chunk).catch(() => {});
        }

        // A completed conversational turn releases unpinned bindings (the
        // shared default rpc) so late events never reply to a stale chat.
        // Pinned project bindings survive (parity with the old roomId path).
        const binding = bindings.get(rpc);
        if (!turn.pendingTools && binding && !binding.pinned) {
          bindings.delete(rpc);
        }
        return;
      }

      if (event.type === "extension_error") {
        log.error(`[agent] 扩展错误 (${event.extensionPath ?? "unknown"}): ${event.error ?? "unknown"}`);
        if (target) {
          sendReply(
            target.chatId,
            target.transport,
            `⚠️ 扩展错误 (${event.extensionPath ?? "unknown"}): ${event.error ?? "unknown"}`
          ).catch(() => {});
        }
      }
    },
  };
}

/** Compact one-line summary of a streamed delta event (thinking/text/tool deltas). */
function summarizeStreamDelta(event: {
  assistantMessageEvent?: unknown;
  message?: AssistantMessage;
}): string {
  const e = event.assistantMessageEvent as
    | { type?: string; text?: string; thinking?: string; delta?: string; toolCall?: unknown }
    | undefined;
  if (!e) return "(无增量)";
  if (e.type === "text" && e.text) return e.text.slice(0, 300);
  if (e.type === "thinking" && e.thinking) return `思考: ${e.thinking.slice(0, 300)}`;
  if (e.type === "tool_call") return "工具调用增量";
  if (e.delta) return e.delta.slice(0, 300);
  return `(${e.type ?? "unknown"})`;
}

type AgentEventView = {
        type: string;
        message?: AssistantMessage;
        assistantMessageEvent?: unknown;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        partialResult?: unknown;
        isError?: boolean;
        willRetry?: boolean;
        attempt?: number;
        maxAttempts?: number;
        delayMs?: number;
        errorMessage?: string;
        finalError?: string;
        success?: boolean;
        reason?: string;
        aborted?: boolean;
        level?: unknown;
        name?: string;
        steering?: readonly string[];
        followUp?: readonly string[];
        extensionPath?: string;
        error?: string;
     };

/**
 * Session-replay logging, fully separated from routing: muting it (log
 * level, or removing calls) can never affect reply routing.
 */
function logAgentEvent(event: AgentEventView, log: LeveledLogger): void {
  switch (event.type) {
    case "agent_start":
      log.debug("[agent] run 开始");
      break;
    case "agent_end":
      log.debug(`[agent] run 结束(willRetry: ${event.willRetry ?? false})`);
      break;
    case "agent_settled":
      log.debug("[agent] 已收敛");
      break;
    case "message_start":
      log.debug("[agent] 消息开始");
      break;
    case "message_update":
      // Streaming delta (includes thinking deltas). DEBUG level, truncated.
      log.debug(`[agent] 流式增量: ${summarizeStreamDelta(event)}`);
      break;
    case "message_end":
      log.debug("[agent] 消息完成");
      break;
    case "tool_execution_start":
      log.info(`[agent] 🔧 工具调用: ${event.toolName ?? "?"}(${summarizeArg(event.args)})`);
      break;
    case "tool_execution_update":
      log.debug(`[agent] 工具进度: ${event.toolName ?? "?"} → ${summarizeArg(event.partialResult, 300)}`);
      break;
    case "tool_execution_end":
      log.info(
        `[agent] 工具完成: ${event.toolName ?? "?"} → ${event.isError ? "❌ 错误" : "✅ 成功"} ${summarizeArg(event.result, 500)}`
      );
      break;
    case "compaction_start":
      log.warn(`[agent] 上下文压缩开始(${event.reason ?? "?"})`);
      break;
    case "compaction_end":
      log.warn(
        `[agent] 上下文压缩${event.aborted ? "中止" : "结束"}(${event.reason ?? "?"}${event.errorMessage ? `, 错误: ${event.errorMessage}` : ""})`
      );
      break;
    case "auto_retry_start":
      log.warn(`[agent] 自动重试 ${event.attempt}/${event.maxAttempts}(${event.errorMessage ?? ""})`);
      break;
    case "auto_retry_end":
      log.warn(`[agent] 自动重试结束: ${event.success ? "成功" : `失败(${event.finalError ?? ""})`}`);
      break;
    case "queue_update":
      log.debug(`[agent] 队列更新(steer: ${event.steering?.length ?? 0}, followUp: ${event.followUp?.length ?? 0})`);
      break;
    case "thinking_level_changed":
      log.info(`[agent] 思考级别: ${String(event.level ?? "?")}`);
      break;
    case "session_info_changed":
      log.debug(`[agent] 会话名称: ${event.name ?? "(清除)"}`);
      break;
    case "entry_appended":
      log.debug("[agent] 会话条目已写入");
      break;
    default:
      log.debug(`[agent] 事件: ${event.type}`);
      break;
  }
}

/**
 * First-time branding: rename the room to "项目管理(<instance>)" and send the
 * usage guide. Idempotent via config.managementRooms so restarts don't
 * re-trigger (and a user-renamed room is never overwritten).
 */
async function maybeInitManagementRoom(
  msg: ExternalMessage,
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>,
  roomOps: RoomOps,
  store: ConfigStore
): Promise<void> {
  const cfg = store.get();
  const rooms = cfg.managementRooms ?? [];
  if (rooms.includes(msg.chatId)) return; // already the management room
  if (rooms.length > 0) return; // a management room already exists — never brand another
  try {
    const instanceName = cfg.instanceName ?? os.hostname();
    const botAccount = roomOps.getBotUserId() ?? "(未知)";
    const workdir = cfg.workdir ?? defaultProjectsRoot();
    const roomName = managementRoomName(instanceName);
    await roomOps.setRoomName(msg.chatId, roomName);
    await sendReply(msg.chatId, msg.transport, buildManagementRoomHelp(instanceName, botAccount, workdir));
    store.update({ managementRooms: [...rooms, msg.chatId] });
    logger.info(`[project] 管理房间已初始化: ${msg.chatId} (${roomName})`);
  } catch {
    // Non-matrix transport or transient failure — skip branding, try again later.
  }
}
function summarizeArg(arg: unknown, max = 500): string {
  if (arg === undefined || arg === null) return "";
  if (typeof arg === "string") {
    const s = arg.replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }
  try {
    const s = JSON.stringify(arg);
    if (!s) return "";
    const oneLine = s.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  } catch {
    return String(arg);
  }
}
