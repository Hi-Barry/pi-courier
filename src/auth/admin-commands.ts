/**
 * Admin command handling for the auth engine (/trusted /revoke /channels
 * /enable /disable /toggletools + challenge-code entry).
 *
 * Pure input → output: text + identity in, handled / replies /
 * notifications / effects out. The engine's in-memory mutations happen
 * through ChallengeAuth methods; persistence (auth snapshot, tool-call
 * visibility) is returned as effects for the CALLER to apply through the
 * injected config store — this module touches no disk and holds no state.
 */

import { type ChallengeAuth, namespacedId } from "./challenge-auth.js";

export type AdminEffect = { kind: "persistAuth" } | { kind: "hideToolCalls"; value: boolean };

export interface AdminNotification {
  message: string;
  level: "info" | "warning";
}

export interface AdminCommandInput {
  text: string;
  userId: string;
  transport?: string;
  /** Current tool-call visibility (read by the caller before dispatch). */
  hideToolCalls?: boolean;
}

export interface AdminCommandResult {
  handled: boolean;
  replies: string[];
  notifications: AdminNotification[];
  effects: AdminEffect[];
}

function handled(result: Omit<AdminCommandResult, "handled">): AdminCommandResult {
  return { handled: true, ...result };
}

/** Admin command help — the auth-owned section of the unified /help output
 *  (assembled by the command map; the management-room guide belongs to the
 *  router and pi-command help to the command map). */
export function adminCommandHelpText(): string {
  return [
    "**Bridge 管理命令**: `/help`(本帮助)、`/trusted`、`/revoke`、`/channels`、`/enable`、`/disable`、`/toggletools`",
    "**认证**: 首次私聊 bot → bot 终端显示 6 位验证码 → 在聊天里输入验证码即成为信任用户(第一个信任用户 = 管理员)。群聊由信任用户在群里发 `/enable <模式>` 启用。",
  ].join("\n");
}

/**
 * Handle bridge admin commands and challenge-code entry in DMs.
 * Returns handled: false when the text is not an admin command and no
 * challenge validation applies (the caller then continues its pipeline).
 */
export function handleAdminCommand(auth: ChallengeAuth, input: AdminCommandInput): AdminCommandResult {
  const namespacedUserId = namespacedId(input.userId, input.transport);

  // Non-admin users: challenge-code entry (only when a challenge is active).
  if (!auth.isTrustedUser(input.userId, input.transport)) {
    if (/^\d{6}$/.test(input.text.trim())) {
      const outcome = auth.validateChallengeCode(namespacedUserId, input.text.trim());
      switch (outcome) {
        case "authenticated":
          return handled({
            replies: ["✅ Authenticated! You can now chat with the agent."],
            notifications: [],
            effects: [{ kind: "persistAuth" }],
          });
        case "expired":
          return handled({
            replies: ["⏱️ Challenge expired. Send any message to get a new code."],
            notifications: [],
            effects: [],
          });
        case "blocked":
          return handled({
            replies: ["🚫 Too many failed attempts. Blocked for 5 minutes."],
            notifications: [],
            effects: [],
          });
        case "wrong":
          return handled({
            replies: [`❌ Wrong code. ${auth.attemptsLeft(namespacedUserId)} attempts remaining.`],
            notifications: [],
            effects: [],
          });
        default:
          return { handled: false, replies: [], notifications: [], effects: [] };
      }
    }
    return { handled: false, replies: [], notifications: [], effects: [] };
  }

  // Admin commands
  const parts = input.text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/enable": {
      if (parts.length < 3) {
        return handled({ replies: ["Usage: /enable <chatId> <all|mentions|trusted-only>"], notifications: [], effects: [] });
      }
      const mode = parts[2] as "all" | "mentions" | "trusted-only";
      if (mode !== "all" && mode !== "mentions" && mode !== "trusted-only") {
        return handled({ replies: ["Usage: /enable <chatId> <all|mentions|trusted-only>"], notifications: [], effects: [] });
      }
      auth.enableChannel(parts[1], mode);
      return handled({
        replies: [`✅ Channel ${parts[1]} enabled (mode: ${parts[2]})`],
        notifications: [{ message: `Channel ${parts[1]} enabled (${parts[2]})`, level: "info" }],
        effects: [{ kind: "persistAuth" }],
      });
    }

    case "/disable": {
      if (parts.length < 2) {
        return handled({ replies: ["Usage: /disable <chatId>"], notifications: [], effects: [] });
      }
      auth.disableChannel(parts[1]);
      return handled({
        replies: [`❌ Channel ${parts[1]} disabled`],
        notifications: [{ message: `Channel ${parts[1]} disabled`, level: "info" }],
        effects: [{ kind: "persistAuth" }],
      });
    }

    case "/channels": {
      const channels = auth
        .exportConfig()
        .channels;
      const lines = Object.entries(channels).map(
        ([id, channel]) => `• ${id}: ${channel.enabled ? "✅" : "❌"} (${channel.mode})`
      );
      return handled({ replies: [lines.join("\n") || "No channels configured"], notifications: [], effects: [] });
    }

    case "/trusted": {
      const snapshot = auth.exportConfig();
      const trusted = snapshot.trustedUsers
        .map((id) => {
          const [transport, uid] = id.split(":");
          return uid ? `${uid} (${transport})` : id;
        })
        .join(", ");
      return handled({
        replies: [`Trusted users (${snapshot.trustedUsers.length}):\n${trusted || "None"}`],
        notifications: [],
        effects: [],
      });
    }

    case "/toggletools": {
      const next = !input.hideToolCalls;
      return handled({
        replies: [`🔧 Tool calls ${next ? "hidden" : "shown"} in remote messages`],
        notifications: [],
        effects: [{ kind: "hideToolCalls", value: next }],
      });
    }

    case "/revoke": {
      if (parts.length < 2) {
        return handled({
          replies: ["Usage: /revoke <userId> or /revoke <transport:userId>"],
          notifications: [],
          effects: [],
        });
      }
      const revokeId = parts[1];
      const revoked = auth.revokeUser(revokeId);
      if (revoked) {
        return handled({
          replies: [`🔓 Revoked trust for ${revokeId}`],
          notifications: [{ message: `Revoked: ${revokeId}`, level: "warning" }],
          effects: [{ kind: "persistAuth" }],
        });
      }
      return handled({
        replies: [`❌ User ${revokeId} not found in trusted users`],
        notifications: [],
        effects: [],
      });
    }

    default:
      return { handled: false, replies: [], notifications: [], effects: [] };
  }
}
