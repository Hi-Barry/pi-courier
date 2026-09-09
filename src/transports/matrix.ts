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
import { createQuoteCache, type QuoteCache, toExcerpt } from "../quote-cache.js";
import type { ExternalMessage } from "../types.js";
import type { MediaSource } from "./attachments.js";
import { AttachmentStore } from "./attachments.js";
import type { Transport } from "./interface.js";
import { MatrixRoomOps } from "./matrix-rooms.js";
import {
  classifyMessageContent,
  extractUsername,
  formatForMatrix,
  isGroupChatRoom,
  shouldPostJoinHint,
  shouldSkipEvent,
  stripBotMention,
  wasBotMentioned,
  type EncryptedMediaFile,
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
  /** Per-room event_id → excerpt ring cache backing reply quotes (issue #56 票5). */
  private quoteCache: QuoteCache = createQuoteCache();
  /** Attachment storage (issue #66) — wired by the composition root. */
  private attachments?: AttachmentStore;

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

  /**
   * Wire the attachment store (issue #66) after construction — the store is
   * backed by this provider's mediaSource, so the composition root creates
   * the provider first, then hands it its store. Absent store (tests) = media
   * events keep the legacy skip-silently behaviour.
   */
  setAttachmentStore(store: AttachmentStore): void {
    this.attachments = store;
  }

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

    // Stickers (issue #66 票3): m.sticker is an EVENT type, not m.room.message,
    // so room.message never fires for it — the content is image-shaped, the
    // attachment path handles it like any other media. In E2EE rooms the
    // sticker arrives here DECRYPTED (the SDK re-emits decrypted events on
    // room.event); in plaintext rooms it arrives as-is. The outer encrypted
    // payload (type m.room.encrypted) fails this filter.
    this.client.on("room.event", (roomId: string, event: any) => {
      if (event?.type !== "m.sticker") return;
      void this.handleMessage(roomId, event).catch((err: Error) => this.errorHandler?.(err));
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

    // Attachment intake (issue #66): media payloads diverge before the text
    // pipeline — they download to disk and forward as path references, they
    // never trigger an agent turn themselves.
    const classified = classifyMessageContent(event.content);
    if (classified.kind === "media") {
      // No store wired (bare transport in tests): legacy skip-silently.
      if (!this.attachments) return;
      await this.handleMediaMessage(roomId, event, classified);
      return;
    }
    if (classified.kind === "other") {
      // 票3:非文本且无媒体载荷(如 m.location)不再静默 — 转发给 router,
      // 由它过授权门后回执礼貌提示。
      this.messageHandler?.({
        ...this.envelope(roomId, event, await this.resolveIsGroupChat(roomId)),
        content: event.content?.body ?? "",
        unsupportedType: classified.msgtype,
      });
      return;
    }

    const chatId = roomId;
    const userId = event.sender; // e.g. @user:matrix.org
    const username = extractUsername(userId);
    const messageText = event.content.body;
    const messageId = event.event_id;

    // Determine if group chat from cached member count (no API call per message)
    const isGroupChat = await this.resolveIsGroupChat(roomId);

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

    // Reply quotes (issue #56 票5): record this message first, then resolve a
    // m.relates_to reply target against the per-room ring cache. A miss (old
    // message from before this process started, unknown event) is a silent
    // downgrade — the message flows on without a quote. E2EE rooms arrive
    // decrypted, so content is read the same way as body above.
    this.quoteCache.record(roomId, messageId, {
      username,
      excerpt: toExcerpt(cleanContent ?? ""),
    });
    const replyTargetEventId: string | undefined = event.content?.["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    const quoted = replyTargetEventId
      ? this.quoteCache.lookup(roomId, replyTargetEventId)
      : undefined;

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
        ...(quoted && { quoted }),
      };

      this.messageHandler(externalMessage);
    }
  }

  /**
   * Media intake (issue #66 票1): download → save → forward as an
   * ExternalMessage carrying the absolute path (or the failure reason).
   * Receipts and the pending-attachment ledger are ROUTER policy — the
   * transport stays pure I/O, exactly like the text pipeline above.
   */
  private async handleMediaMessage(roomId: string, event: any, media: { mxcUrl?: string; encryptedFile?: EncryptedMediaFile; filename: string; sizeHint?: number }): Promise<void> {
    if (!this.client || !this.attachments) return;
    const base = this.envelope(roomId, event, await this.resolveIsGroupChat(roomId));

    try {
      const saved = await this.attachments.save(base.chatId, {
        mxcUrl: media.mxcUrl,
        encryptedFile: media.encryptedFile,
        body: media.filename,
        sizeHint: media.sizeHint,
      });
      logger.info(`[Matrix] 附件已保存: ${saved.path}(${base.username})`);
      this.messageHandler?.({ ...base, content: media.filename, attachments: [saved] });
    } catch (err) {
      logger.warn(`[Matrix] 附件处理失败(${base.username}): ${(err as Error).message}`);
      this.messageHandler?.({ ...base, content: media.filename, attachmentError: (err as Error).message });
    }
  }

  /** The common ExternalMessage envelope fields shared by the text, media
   *  and unsupported-type pipelines (no mention stripping on non-text). */
  private envelope(roomId: string, event: any, isGroupChat: boolean) {
    return {
      chatId: roomId,
      transport: this.type,
      username: extractUsername(event.sender),
      userId: event.sender,
      timestamp: new Date(event.origin_server_ts || Date.now()),
      messageId: event.event_id,
      isGroupChat,
      wasMentioned: false,
    };
  }

  /** Cached member-count lookup shared by the text and media pipelines. */
  private async resolveIsGroupChat(roomId: string): Promise<boolean> {
    let memberCount = this.roomMemberCount.get(roomId);
    if (memberCount === undefined) {
      try {
        const members = await this.client!.getJoinedRoomMembers(roomId);
        memberCount = members.length;
        this.roomMemberCount.set(roomId, memberCount);
      } catch {
        memberCount = 2; // Default to DM if we can't check
      }
    }
    return isGroupChatRoom(memberCount);
  }

  /**
   * The Matrix half of the attachment download seam (issue #66): plaintext
   * media via the authenticated v1 endpoint; E2EE rooms via the crypto
   * client's decryptMedia (download + AES-CTR + SHA-256 in one step).
   * `crypto` is undefined when the deployment runs without encryption.
   */
  get mediaSource(): MediaSource {
    return {
      downloadPlaintext: async (mxcUrl) => {
        const { data } = await this.client!.downloadContent(mxcUrl);
        return data;
      },
      ...(this.config.encryption !== false
        ? {
            downloadEncrypted: async (file) => {
              const crypto = this.client?.crypto;
              if (!crypto) {
                throw new Error("E2EE crypto 原生库不可用,无法解密加密附件");
              }
              // Our EncryptedMediaFile is a structural subset of the SDK's
              // EncryptedFile; at runtime this IS the event's original object,
              // so every field the Rust decrypt needs (kty/key_ops/…) is there.
              return crypto.decryptMedia(file as Parameters<typeof crypto.decryptMedia>[0]);
            },
          }
        : {}),
    };
  }

}
