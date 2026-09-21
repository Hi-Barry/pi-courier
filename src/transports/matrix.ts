import MarkdownIt from "markdown-it";
import { logger, suppressLogLines } from "../logger.js";
import { buildGroupJoinHint } from "../management-room.js";
import { createQuoteCache, type QuoteCache, toExcerpt } from "../quote-cache.js";
import type { ExternalMessage } from "../types.js";
import type { MediaSource } from "./attachments.js";
import { AttachmentStore } from "./attachments.js";
import {
  createMatrixClient,
  type MatrixClientConfig,
  type MatrixClientFactory,
  type MatrixClientPort,
} from "./matrix-client.js";
import { createEventTranslator, isMediaContent, type MediaEventContent } from "./matrix-events.js";
import { MatrixRoomOps } from "./matrix-rooms.js";

/**
 * Matrix transport provider using matrix-bot-sdk
 * Works with any Matrix homeserver — Element X, Element Web, FluffyChat, etc.
 *
 * Message I/O only. The room-capability half (RoomOps) lives in the
 * composed matrix-rooms adapter; the composition root hands that to the
 * /pmctl path and the startup space ensure.
 *
 * The SDK client is reached only through the MatrixClientPort (built by the
 * injected factory, default = the production adapter in matrix-client.ts):
 * storage paths, crypto storage, the auto-join mixin and the SDK log facade
 * all live in the factory module, so this file holds no concrete SDK
 * classes and tests inject fakes.
 */
export class MatrixProvider {
  readonly type = "matrix";
  private client?: MatrixClientPort;
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
  /** Event translator (spec #72 票2/C2) — assembled once botUserId is known. */
  private translator?: ReturnType<typeof createEventTranslator>;

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
    private config: MatrixClientConfig,
    /** Whether a group room is enabled for the bridge (join-hint UX only;
     *  all policy — authorization, challenges, admin commands, group /enable —
     *  lives in the message-router pipeline). */
    private isRoomEnabled: (chatId: string) => boolean,
    /** Client factory seam (tests inject fakes; production uses the default). */
    private clientFactory: MatrixClientFactory = createMatrixClient
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

  // Outbound formatting, event filtering and group predicates are pure
  // functions at the bottom of this module (spec #99/#101).

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const { homeserverUrl, accessToken } = this.config;

    if (!homeserverUrl || !accessToken) {
      throw new Error("Matrix homeserver URL and access token required");
    }

    // Storage paths, crypto storage (with graceful degradation), the
    // auto-join mixin and the SDK log facade live in the factory module —
    // the provider talks to the client only through the port.
    this.client = this.clientFactory(this.config);

    // Cache bot user ID (never changes)
    this.botUserId = await this.client.getUserId();
    this.translator = createEventTranslator({
      transportType: this.type,
      botUserId: this.botUserId,
      quoteCache: this.quoteCache,
      resolveIsGroupChat: (roomId) => this.resolveIsGroupChat(roomId),
      ...(this.attachments ? { attachments: this.attachments } : {}),
    });

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
            this.sendMessage(roomId, buildGroupJoinHint()).catch(() => {});
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

    try {
      // During initial sync the SDK replays historical events and tries to
      // decrypt them. For E2EE rooms this produces two known error patterns:
      //   1. "Decryption error" — old messages we don't have keys for
      //   2. "M_NOT_FOUND"     — stale sync token references a purged event
      // Our connectedAt filter skips these events anyway, so the errors are
      // noise. The facade's suppression window filters exactly these
      // patterns for the sync only — closing it (even on failure) keeps
      // real errors afterwards visible.
      // Mark the connection point BEFORE the initial sync: everything the
      // sync replays (older than this instant) is "stale" for shouldSkipEvent
      // — a fresh token must not execute rooms' backlogged messages as live
      // commands (spec #93 ticket 1). The assignment after start() below
      // re-marks, so anything arriving DURING the multi-second sync is
      // dropped as backlog too.
      this.connectedAt = Date.now();
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
    // The port carries the crypto verdict: the factory leaves `crypto`
    // undefined when encryption is off or the Rust stack failed to load.
    this.roomOps.encryptionAvailable = this.client.crypto !== undefined;
    const cryptoStatus = this.client.crypto ? "E2EE enabled" : "E2EE disabled";
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
    if (!this.client || !this.botUserId || !this.translator) return;

    // Pure filter — module-bottom pure function (own messages, stale
    // replay, unjoined rooms, m.notice silence, edits).
    const skipReason = shouldSkipEvent(event, this.botUserId, this.connectedAt, this.joinedRooms, roomId);
    if (skipReason) return;

    // Translation (spec #72 票2/C2): classification, mention stripping, quote
    // bookkeeping and attachment persistence live in the translator module;
    // this transport only wires the SDK to it and logs its lines.
    const outcome = await this.translator.translate(roomId, event);
    if (outcome.info) logger.info(outcome.info);
    if (outcome.warn) logger.warn(outcome.warn);
    if (outcome.message) this.messageHandler?.(outcome.message);
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
              return crypto.decryptMedia(file);
            },
          }
        : {}),
    };
  }

}

// ─── 纯函数区(spec #99/#101:自 matrix-utils.ts 归位到唯一属主 transport)───
// 出站渲染、事件过滤、群聊判定——无 SDK/网络依赖,可直测。

// html:false escapes raw HTML (pi output must never inject tags);
// breaks:true keeps chat-style single newlines as <br>;
// linkify turns bare URLs into links.
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

/** Convert markdown to Matrix HTML. Returns plain body (fallback) + formatted HTML. */
export function formatForMatrix(text: string): { body: string; formattedBody?: string } {
  return { body: text, formattedBody: md.render(text).trim() };
}

/**
 * Determine whether to skip a Matrix room event before processing.
 * Returns a reason string if the event should be skipped, or null if it should be processed.
 */
export function shouldSkipEvent(
  event: { sender?: string; origin_server_ts?: number; content?: any },
  botUserId: string,
  connectedAt: number,
  joinedRooms: Set<string>,
  roomId: string
): string | null {
  // Ignore own messages
  if (event.sender === botUserId) return "own_message";

  // Skip events from before this connection (stale replay from initial sync)
  const eventTs = event.origin_server_ts || 0;
  if (eventTs < connectedAt) return "stale";

  // m.notice stays silent in every branch (issue #66 票3: the ONE deliberate
  // silence — other bots/services' notices must not trigger receipts or the
  // bot loops).
  if (event.content?.msgtype === "m.notice") return "notice";

  // Media events (issue #66) flow through the attachment path. Everything
  // else with a body flows on too: m.text/m.emote are classified as text,
  // exotic msgtypes (m.location…) reach the router's polite receipt — the
  // filter itself no longer silently drops them (票3). Only body-less
  // messages and edits stay skipped here.
  if (!isMediaEventContent(event.content)) {
    const content = event.content;
    if (!content?.body) return "not_text";

    // Ignore edits (we only process original messages)
    if (content["m.new_content"]) return "edit";
  }

  // Skip events from rooms we're not in (cached, no API call)
  if (!joinedRooms.has(roomId)) return "not_joined";

  return null;
}

/** shouldSkipEvent 用的窄判别:内容带媒体载荷即视为媒体事件(不查白名单 —
 *  白名单归类由 classifyMessageContent 负责,m.file 等在票3 前落入 "other")。 */
function isMediaEventContent(content: unknown): boolean {
  return isMediaContent(content) && typeof (content as MediaEventContent & { msgtype?: string }).msgtype === "string";
}

/** A room is a group chat when it holds more than two members (bot + one other = DM). */
export function isGroupChatRoom(memberCount: number): boolean {
  return memberCount > 2;
}

/** Whether to post the one-time join hint: a multi-user room that is not yet enabled. */
export function shouldPostJoinHint(memberCount: number, isEnabled: boolean): boolean {
  return isGroupChatRoom(memberCount) && !isEnabled;
}
