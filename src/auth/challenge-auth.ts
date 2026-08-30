/**
 * Challenge-based authentication strategy engine.
 * Ported from vscode-chonky-remote-pilot.
 *
 * Pure strategy: authorization decisions, challenge lifecycle, channel modes
 * and trust state — every method either reads state, mutates it in memory, or
 * (for the challenge prompt) sends through the sender passed as a parameter.
 * No persistence and no admin-command handling happens here: the caller
 * applies persistence effects (see admin-commands.ts) through the injected
 * config store.
 */

interface ChallengeData {
  code: string;
  userId: string;
  chatId: string;
  username: string;
  expiresAt: number;
  attempts: number;
}

interface ChannelAuth {
  enabled: boolean;
  mode: "all" | "mentions" | "trusted-only";
}

export type ChallengeOutcome = "authenticated" | "expired" | "wrong" | "blocked";

export class ChallengeAuth {
  private challenges = new Map<string, ChallengeData>();
  private trustedUsers = new Set<string>();
  private channelAuth = new Map<string, ChannelAuth>();
  private blockedUsers = new Map<string, number>(); // userId -> unblock timestamp
  private adminUserId?: string;

  constructor(
    private onShowCode: (code: string, username: string) => void,
    private onNotify: (message: string, level?: "info" | "warning" | "error") => void
  ) {}

  /**
   * Initialize auth state from config
   */
  loadFromConfig(config: {
    trustedUsers?: string[];
    adminUserId?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  }): void {
    if (config.trustedUsers) {
      this.trustedUsers = new Set(config.trustedUsers);
    }
    if (config.adminUserId) {
      this.adminUserId = config.adminUserId;
    }
    if (config.channels) {
      this.channelAuth = new Map(Object.entries(config.channels));
    }
  }

  /**
   * Export auth state for config persistence
   */
  exportConfig(): {
    trustedUsers: string[];
    adminUserId?: string;
    channels: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  } {
    return {
      trustedUsers: Array.from(this.trustedUsers),
      adminUserId: this.adminUserId,
      channels: Object.fromEntries(this.channelAuth),
    };
  }

  /**
   * Check if a user is authorized to send messages. Unknown DM users get a
   * challenge; the prompt goes out through the sender passed here — the
   * engine never stores a sender on itself.
   */
  async checkAuthorization(
    userId: string,
    chatId: string,
    username: string,
    isGroupChat: boolean,
    wasMentioned: boolean,
    sendMessage?: (chatId: string, message: string) => Promise<void>,
    transport?: string
  ): Promise<boolean> {
    // Create namespaced user ID (transport:userId)
    const namespacedUserId = transport ? `${transport}:${userId}` : userId;

    // Check if user is blocked
    const blockedUntil = this.blockedUsers.get(namespacedUserId);
    if (blockedUntil && Date.now() < blockedUntil) {
      return false;
    }
    if (blockedUntil && Date.now() >= blockedUntil) {
      this.blockedUsers.delete(namespacedUserId);
    }

    // DM: check trusted or initiate challenge
    if (!isGroupChat) {
      if (this.trustedUsers.has(namespacedUserId)) {
        // Set as admin if first trusted user
        if (!this.adminUserId) {
          this.adminUserId = namespacedUserId;
          this.onNotify(`🔐 ${username} is now the admin`, "info");
        }
        return true;
      }

      return await this.initiateChallenge(namespacedUserId, chatId, username, sendMessage);
    }

    // Group chat: check channel authorization
    const channelAuthData = this.channelAuth.get(chatId);

    // Channel not enabled
    if (!channelAuthData?.enabled) {
      return false;
    }

    // Check mode
    switch (channelAuthData.mode) {
      case "all":
        return true;
      case "mentions":
        return wasMentioned || false;
      case "trusted-only":
        return this.trustedUsers.has(namespacedUserId);
      default:
        return false;
    }
  }

  /** Whether a user is in the trusted list (per transport). */
  isTrustedUser(userId: string, transport?: string): boolean {
    const namespaced = transport ? `${transport}:${userId}` : userId;
    return this.trustedUsers.has(namespaced);
  }

  /** Whether this user is the admin (namespaced comparison, per transport). */
  isAdminUser(userId: string, transport?: string): boolean {
    if (!this.adminUserId) return false;
    const namespaced = transport ? `${transport}:${userId}` : userId;
    return this.adminUserId === namespaced || this.adminUserId === userId;
  }

  /** Whether a group chat has been explicitly enabled by the admin. */
  isChannelEnabled(chatId: string): boolean {
    return this.channelAuth.get(chatId)?.enabled === true;
  }

  /** Enable a group chat with a mode (in-memory only; the caller persists). */
  enableChannel(chatId: string, mode: "all" | "mentions" | "trusted-only"): void {
    this.channelAuth.set(chatId, { enabled: true, mode });
  }

  /** Disable a group chat (in-memory only; the caller persists). */
  disableChannel(chatId: string): void {
    this.channelAuth.delete(chatId);
  }

  /** Revoke trust. Matching rule: full namespaced IDs (or exact entries)
   *  match exactly; any other form — bare telegram IDs AND native MXIDs as
   *  displayed by /trusted — matches the `:<id>` suffix of one entry.
   *  Returns whether anything was revoked. */
  revokeUser(revokeId: string): boolean {
    if (this.trustedUsers.has(revokeId)) {
      this.trustedUsers.delete(revokeId);
      return true;
    }
    for (const id of this.trustedUsers) {
      if (id.endsWith(`:${revokeId}`)) {
        this.trustedUsers.delete(id);
        return true;
      }
    }
    return false;
  }

  /**
   * Validate a challenge code. Mutates trust/blocked/challenge state and
   * returns the outcome — the caller turns it into replies and persistence.
   */
  validateChallengeCode(namespacedUserId: string, code: string): ChallengeOutcome | "none" {
    const challenge = this.challenges.get(namespacedUserId);
    if (!challenge) return "none";

    // Expired?
    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(namespacedUserId);
      return "expired";
    }

    // Correct code?
    if (code === challenge.code) {
      this.trustedUsers.add(namespacedUserId);
      this.challenges.delete(namespacedUserId);
      this.onNotify(`✅ ${challenge.username} authenticated`, "info");
      return "authenticated";
    }

    // Wrong code
    challenge.attempts++;
    if (challenge.attempts >= 3) {
      this.challenges.delete(namespacedUserId);
      this.blockedUsers.set(namespacedUserId, Date.now() + 5 * 60 * 1000); // 5 min block
      this.onNotify(`🚫 ${challenge.username} blocked (3 failed attempts)`, "warning");
      return "blocked";
    }

    return "wrong";
  }

  /** Attempts left on the active challenge (0 when none/blocked). */
  attemptsLeft(namespacedUserId: string): number {
    const challenge = this.challenges.get(namespacedUserId);
    return challenge ? Math.max(0, 3 - challenge.attempts) : 0;
  }

  /**
   * Initiate or re-check a challenge for a DM user. Returns false (the user
   * is not yet authorized); the prompt is delivered via the sender argument.
   */
  private async initiateChallenge(
    userId: string,
    chatId: string,
    username: string,
    sendMessage?: (chatId: string, message: string) => Promise<void>
  ): Promise<boolean> {
    const existingChallenge = this.challenges.get(userId);

    // An active challenge just waits for the code — no new code, no re-send.
    if (existingChallenge) {
      if (Date.now() > existingChallenge.expiresAt) {
        this.challenges.delete(userId);
        return await this.initiateChallenge(userId, chatId, username, sendMessage);
      }
      return false;
    }

    // Create new challenge
    const code = this.generateCode();
    const expiresAt = Date.now() + 2 * 60 * 1000; // 2 minutes

    this.challenges.set(userId, {
      code,
      userId,
      chatId,
      username,
      expiresAt,
      attempts: 0,
    });

    // Show code in terminal FIRST
    this.onShowCode(code, username);

    // Then send message to user asking for the code
    if (sendMessage) {
      try {
        await sendMessage(
          chatId,
          "🔐 Please enter the 6-digit code provided by the bot admin.\n⏱️ Expires in 2 minutes."
        );
      } catch (_err) {
        // Ignore send errors
      }
    }

    return false;
  }

  /**
   * Generate a random 6-digit code
   */
  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
