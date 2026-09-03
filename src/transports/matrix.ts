import * as os from "node:os";
import * as path from "node:path";
import type { ILogger } from "matrix-bot-sdk";
import {
  AutojoinRoomsMixin,
  LogService,
  MatrixClient,
  RustSdkCryptoStorageProvider,
  RustSdkCryptoStoreType,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk";
import { logger, suppressLogLines } from "../logger.js";
import type { ExternalMessage } from "../types.js";
import type { Transport } from "./interface.js";
import { MatrixRoomOps } from "./matrix-rooms.js";
import {
  extractUsername,
  formatForMatrix,
  isGroupChatRoom,
  shouldPostJoinHint,
  shouldSkipEvent,
  stripBotMention,
  wasBotMentioned,
} from "./matrix-utils.js";

/**
 * Matrix transport provider using matrix-bot-sdk
 * Works with any Matrix homeserver — Element X, Element Web, FluffyChat, etc.
 *
 * Message I/O only. The room-capability half (RoomOps) lives in the
 * composed matrix-rooms adapter; the composition root hands that to the
 * /pmctl path and the startup space ensure.
 */
export class MatrixProvider implements Transport {
  readonly type = "matrix";
  private client?: MatrixClient;
  private _isConnected = false;
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error) => void;
  private botUserId?: string;
  private joinedRooms = new Set<string>();
  private roomMemberCount = new Map<string, number>();
  private connectedAt = 0;

  /** Room-capability half of the Matrix integration (see matrix-rooms.ts). */
  readonly roomOps = new MatrixRoomOps({
    getClient: () => this.client,
    getBotUserId: () => this.botUserId,
    onLeftRoom: (roomId) => {
      this.joinedRooms.delete(roomId);
      this.roomMemberCount.delete(roomId);
    },
  });

  constructor(
    private config: { homeserverUrl: string; accessToken: string; encryption?: boolean },
    /** Whether a group room is enabled for the bridge (join-hint UX only;
     *  all policy — authorization, challenges, admin commands, group /enable —
     *  lives in the message-router pipeline). */
    private isRoomEnabled: (chatId: string) => boolean
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  // Formatting delegated to matrix-utils.ts (pure, testable)

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const { homeserverUrl, accessToken } = this.config;

    if (!homeserverUrl || !accessToken) {
      throw new Error("Matrix homeserver URL and access token required");
    }

    const storagePath = path.join(
      os.homedir(),
      ".pi",
      "pi-courier-matrix-store.json"
    );
    const storage = new SimpleFsStorageProvider(storagePath);

    // Set up E2EE crypto storage if encryption is enabled.
    // Uses @matrix-org/matrix-sdk-crypto-nodejs (native Rust, SQLite on disk).
    // Crypto state persists across restarts — same device, same keys.
    // The device must be verified once from another Matrix client (Element, etc).
    let cryptoProvider: RustSdkCryptoStorageProvider | undefined;
    if (this.config.encryption !== false) {
      try {
        const cryptoStorePath = path.join(
          os.homedir(),
          ".pi",
          "pi-courier-matrix-crypto"
        );
        cryptoProvider = new RustSdkCryptoStorageProvider(cryptoStorePath, RustSdkCryptoStoreType.Sqlite);
        logger.info("[Matrix] E2EE crypto storage enabled (Rust/SQLite)");
      } catch (err) {
        logger.warn("[Matrix] E2EE crypto not available, continuing without encryption:", (err as Error).message);
      }
    }

    this.client = new MatrixClient(
      homeserverUrl,
      accessToken,
      storage,
      cryptoProvider
    );

    // Auto-join rooms the bot is invited to
    AutojoinRoomsMixin.setupOnClient(this.client);

    // Cache bot user ID (never changes)
    this.botUserId = await this.client.getUserId();

    // Track room membership and member counts
    this.client.on("room.join", (roomId: string) => {
      this.joinedRooms.add(roomId);
      // Refresh member count asynchronously
      this.client?.getJoinedRoomMembers(roomId)
        .then(members => {
          this.roomMemberCount.set(roomId, members.length);
          // Multi-user room that isn't explicitly enabled: post a one-time
          // hint so the inviter knows how to enable it. The room.join event
          // only fires on (re)join, so this is naturally idempotent.
          if (shouldPostJoinHint(members.length, this.isRoomEnabled(roomId))) {
            this.sendMessage(
              roomId,
              `🤖 我已加入这个群聊,但默认不回应群消息。\n\n` +
                `启用方式:直接在群里发 /enable trusted-only\n` +
                `(或 all = 回应所有人 / mentions = 只回应 @我;仅信任用户可启用)`
            ).catch(() => {});
          }
        })
        .catch(() => {});
    });
    this.client.on("room.leave", (roomId: string) => {
      this.joinedRooms.delete(roomId);
      this.roomMemberCount.delete(roomId);
    });

    // Handle incoming messages
    this.client.on("room.message", async (roomId: string, event: any) => {
      try {
        await this.handleMessage(roomId, event);
      } catch (err) {
        if (this.errorHandler) {
          this.errorHandler(err as Error);
        }
      }
    });

    // Route SDK-internal logs through the shared leveled logger — trace/debug
    // land on debug (silent at the default info threshold), info/warn/error
    // keep their level. The [matrix-sdk:*] prefix keeps SDK lines greppable
    // apart from the adapter's own [Matrix] state logs.
    const sdkLogAdapter: ILogger = {
      trace: (mod, ...args) => logger.debug(`[matrix-sdk:${mod}]`, ...args),
      debug: (mod, ...args) => logger.debug(`[matrix-sdk:${mod}]`, ...args),
      info:  (mod, ...args) => logger.info(`[matrix-sdk:${mod}]`, ...args),
      warn:  (mod, ...args) => logger.warn(`[matrix-sdk:${mod}]`, ...args),
      error: (mod, ...args) => logger.error(`[matrix-sdk:${mod}]`, ...args),
    };
    LogService.setLogger(sdkLogAdapter);

    try {
      // During initial sync the SDK replays historical events and tries to
      // decrypt them. For E2EE rooms this produces two known error patterns:
      //   1. "Decryption error" — old messages we don't have keys for
      //   2. "M_NOT_FOUND"     — stale sync token references a purged event
      // Our connectedAt filter skips these events anyway, so the errors are
      // noise. The facade's suppression window filters exactly these
      // patterns for the sync only — closing it (even on failure) keeps
      // real errors afterwards visible.
      const closeSyncNoiseWindow = suppressLogLines("Decryption error", "M_NOT_FOUND");
      try {
        await this.client.start();
      } finally {
        closeSyncNoiseWindow();
      }
    } catch (error) {
      // Clean up dangling state so connect() can be retried
      this.client = undefined;
      this.botUserId = undefined;
      this.joinedRooms.clear();
      this.roomMemberCount.clear();
      // The facade renders Error objects as "{}", so pass the stack (which
      // carries the message) to keep the old console.error's diagnostic value.
      logger.error("[Matrix] Failed to connect:", (error as Error).stack ?? String(error));
      throw error;
    }

    // Seed joined rooms and member count caches
    const rooms = await this.client.getJoinedRooms();
    this.joinedRooms = new Set(rooms);
    await Promise.all(rooms.map(async (roomId) => {
      try {
        const members = await this.client!.getJoinedRoomMembers(roomId);
        this.roomMemberCount.set(roomId, members.length);
      } catch {
        // Will be fetched on first message if needed
      }
    }));
    this.connectedAt = Date.now();
    this._isConnected = true;
    this.roomOps.encryptionAvailable = cryptoProvider !== undefined;
    const cryptoStatus = cryptoProvider ? "E2EE enabled" : "E2EE disabled";
    logger.info(`✅ Matrix connected as ${this.botUserId} (${rooms.length} rooms, ${cryptoStatus})`);
  }

  async disconnect(): Promise<void> {
    if (!this._isConnected || !this.client) return;

    this.client.stop();
    this._isConnected = false;
    this.client = undefined;
    this.botUserId = undefined;
    this.joinedRooms.clear();
    this.roomMemberCount.clear();
    this.connectedAt = 0;
    logger.info("[Matrix] Disconnected");
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error("Matrix client not connected");
    }
    if (!text?.trim()) return;

    const { body, formattedBody } = formatForMatrix(text);

    await this.client.sendMessage(chatId, {
      msgtype: "m.text",
      body,
      ...(formattedBody && {
        format: "org.matrix.custom.html",
        formatted_body: formattedBody,
      }),
    });
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setTyping(chatId, true, 10000);
    } catch {
      // Ignore typing indicator errors
    }
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  private async handleMessage(roomId: string, event: any): Promise<void> {
    if (!this.client || !this.botUserId) return;

    // Pure filter — delegates to testable utility
    const skipReason = shouldSkipEvent(event, this.botUserId, this.connectedAt, this.joinedRooms, roomId);
    if (skipReason) return;

    const chatId = roomId;
    const userId = event.sender; // e.g. @user:matrix.org
    const username = extractUsername(userId);
    const messageText = event.content.body;
    const messageId = event.event_id;

    // Determine if group chat from cached member count (no API call per message)
    let memberCount = this.roomMemberCount.get(roomId);
    if (memberCount === undefined) {
      // Cache miss — fetch once and cache
      try {
        const members = await this.client.getJoinedRoomMembers(roomId);
        memberCount = members.length;
        this.roomMemberCount.set(roomId, memberCount);
      } catch {
        memberCount = 2; // Default to DM if we can't check
      }
    }
    const isGroupChat = isGroupChatRoom(memberCount);

    // Check if bot was mentioned (pure utility)
    const wasMentioned = isGroupChat ? wasBotMentioned(messageText, this.botUserId) : false;

    // Transport is pure I/O: EVERY message passing the filter above is
    // forwarded. Authorization, challenges, admin commands and group /enable
    // are policy and run in the message-router pipeline — a gate here would
    // make later pipeline stages (e.g. /enable in an unenabled room)
    // unreachable dead code.

    // Strip bot mention from message (pure utility)
    const cleanContent = wasMentioned && this.botUserId
      ? stripBotMention(messageText, this.botUserId)
      : messageText;

    // Forward to message handler
    if (this.messageHandler && cleanContent) {
      const externalMessage: ExternalMessage = {
        chatId,
        transport: this.type,
        content: cleanContent,
        username,
        userId,
        timestamp: new Date(event.origin_server_ts || Date.now()),
        messageId,
        isGroupChat,
        wasMentioned,
      };

      this.messageHandler(externalMessage);
    }
  }

}
