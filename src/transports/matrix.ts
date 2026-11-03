import MarkdownIt from "markdown-it";
import type { InboxMode } from "../config.js";
import { escapeBackslashesOutsideFences } from "../formatting.js";
import { t } from "../i18n/index.js";
import { logger, suppressLogLines } from "../logger.js";
import { buildGroupJoinHint } from "../management-room.js";
import { createQuoteCache, type QuoteCache } from "../quote-cache.js";
import type { ExternalMessage } from "../types.js";
import {
  AttachmentStore,
  AttachmentTooLargeError,
  DOWNLOAD_TIMEOUT_MS,
  decryptEncryptedMedia,
  type MediaSource,
  readCapped,
} from "./attachments.js";
import type { EventLedger } from "./event-ledger.js";
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
  private reactionHandler?: (reaction: MatrixReaction) => void;
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

  private eventLedger?: EventLedger;
  private inbox: InboxMode = "confirm";

  /**
   * Wire the processed-event ledger (issue #113) after construction — same
   * seam as setAttachmentStore: the composition root creates both ends.
   * Absent ledger (tests) = stale events keep the legacy drop behaviour.
   * `mode` is the config derivation (inboxMode); "off" skips the lookup
   * entirely (byte-identical to pre-#113 releases).
   */
  setEventLedger(ledger: EventLedger | undefined, mode: InboxMode): void {
    this.eventLedger = ledger;
    this.inbox = mode;
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
      // isNew 去重:matrix-client 的邀请处理器在 API join 成功后补发一次
      // room.join(见彼处注释),SDK 的 sync 扫描若在之后也 sighting 到同一
      // 次加入,真事件迟到时不再二次发提示(提示只跟「首次见到加入」走)。
      const isNewJoin = !this.joinedRooms.has(roomId);
      this.joinedRooms.add(roomId);
      // Refresh member count asynchronously
      this.client?.getJoinedRoomMembers(roomId)
        .then(members => {
          this.roomMemberCount.set(roomId, members.length);
          // Multi-user room that isn't explicitly enabled: post a one-time
          // hint so the inviter knows how to enable it. room.join 只在首次
          // 加入(含邀请自动加入的补发)时提示;rejoin 由 isNew 重新放行。
          if (isNewJoin && shouldPostJoinHint(members.length, this.isRoomEnabled(roomId))) {
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
      // Reactions (票01 #268): m.reaction 也只从 room.event 进(room.message
      // 不发非消息事件),E2EE 房同样经 SDK 解密后补发。走自己的分发缝,
      // 与消息管道互不相通。
      if (event?.type === "m.reaction") {
        try {
          this.handleReaction(roomId, event);
        } catch (err) {
          this.errorHandler?.(err as Error);
        }
        return;
      }
      if (event?.type !== "m.sticker") return;
      void this.handleMessage(roomId, event).catch((err: Error) => this.errorHandler?.(err));
    });

    try {
      // Initial-sync replay noise (silence policy entry 1, src/logger.ts):
      // the SDK's first sync replays history and emits two known-benign
      // error patterns ("Decryption error" for messages we lack keys for,
      // "M_NOT_FOUND" for purged events behind a stale sync token). Our
      // connectedAt filter skips these events anyway, so the errors are
      // noise. The window covers the sync only — closing it (even on
      // failure) keeps real errors afterwards visible. The per-call
      // expected-miss silence for RoomOps queries lives at the adapter
      // boundary (matrix-rooms.ts); this window is the only other one.
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

  /**
   * 发送一条文本消息,返回底层服务器分配的 event_id(issue #235 票1:返回值
   * 从「无」穿出为事件 ID 字符串,调用方——后续票的活卡状态机——凭它发起
   * 编辑)。空白文本仍是既有行为:不发送、早退返回空串(无事件可指)。
   */
  async sendMessage(chatId: string, text: string): Promise<string> {
    if (!this.client) {
      throw new Error("Matrix client not connected");
    }
    if (!text?.trim()) return "";

    const { body, formattedBody } = formatForMatrix(text);

    return this.enqueueSend(chatId, () => {
      // 排队期间可能已 disconnect(client 置空):报可读错误而非 TypeError。
      if (!this.client) throw new Error("Matrix client not connected");
      return this.client.sendMessage(chatId, {
        msgtype: "m.text",
        body,
        ...(formattedBody && {
          format: "org.matrix.custom.html",
          formatted_body: formattedBody,
        }),
      });
    });
  }

  /**
   * 就地编辑一条已发出的消息(MSC2676,已入正式规范 v1.3+;issue #235 票1):
   * 向 `messageId` 指向的原事件发一条 rel_type "m.replace" 的替换事件——
   * 支持编辑的客户端把原消息就地替换,旧客户端退回顶层 fallback 文本
   * (带 `* ` 前缀)。`m.new_content` 与普通消息同构:复用 sendMessage 的
   * formatForMatrix 口径(markdown→HTML 富文本、win32 平台反斜杠预转义),
   * 纯文本 body 始终是原文。返回替换事件自己的 event_id。未连接时报与
   * sendMessage 相同的可读错误。编辑与相邻消息走同一条 per-room FIFO:
   * 入队顺序 = 房间事件流顺序 = 客户端展示顺序。
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<string> {
    if (!this.client) {
      throw new Error("Matrix client not connected");
    }

    const { body, formattedBody } = formatForMatrix(text);

    return this.enqueueSend(chatId, () => {
      // 排队期间可能已 disconnect(client 置空):报可读错误而非 TypeError。
      if (!this.client) throw new Error("Matrix client not connected");
      return this.client.sendMessage(chatId, {
        msgtype: "m.text",
        body: `* ${body}`,
        "m.new_content": {
          msgtype: "m.text",
          body,
          ...(formattedBody && {
            format: "org.matrix.custom.html",
            formatted_body: formattedBody,
          }),
        },
        "m.relates_to": {
          rel_type: "m.replace",
          event_id: messageId,
        },
      });
    });
  }

  /**
   * 在一条已发出的消息上种一个表情 reaction(票01,#268):向端口原语直传
   * (roomId, 目标 event_id, key),端口生产实现发 m.reaction 事件(E2EE 房由
   * SDK 自动加密)。返回 reaction 事件自己的 event_id。
   *
   * 刻意不走 per-room FIFO:种表情的先后顺序无关紧要,不必排在消息链后;
   * 未连接时报与 sendMessage 相同的可读错误,SDK 错误照常上抛——逐表情的
   * try/catch 降级由调用方(种表情的各流)负责。
   */
  async sendReaction(chatId: string, targetEventId: string, key: string): Promise<string> {
    if (!this.client) {
      throw new Error("Matrix client not connected");
    }
    return this.client.sendReaction(chatId, targetEventId, key);
  }

  /**
   * Per-room FIFO 发送链(issue #195):homeserver 按收到顺序把事件排进
   * 房间事件流(txnId 只做幂等去重不参与排序),并发 PUT 即乱序 —— 分片
   * 回复、终答与紧随的回执都可能颠倒。这里让同房间的消息严格按入队顺序
   * 一条发完再发下一条:入队顺序 = 房间事件流顺序 = 客户端展示顺序。
   *
   * - 不同房间各持一条链,互不阻塞(单房间网络抖动不拖累其他房间);
   * - 单条失败照常 reject 给调用方记账,但链上后续消息照发(断链传播);
   * - 只管房间文本消息:typing、媒体上传、state 事件、房间管理操作不进队列;
   * - 底层返回值(事件 event_id)原样穿出给调用方(issue #235 票1)。
   */
  private sendQueues = new Map<string, Promise<void>>();

  private enqueueSend<T>(chatId: string, send: () => Promise<T>): Promise<T> {
    const prev = this.sendQueues.get(chatId) ?? Promise.resolve();
    // 上一步的失败不传染本步:链上每条独立结算。
    const run = prev.then(send, send);
    // 队尾只记“完成与否”,永不持有 rejection —— 链条不被污染。
    const next = run.then(
      () => undefined,
      () => undefined
    );
    this.sendQueues.set(chatId, next);
    // 空链清理:本条结算时队列尾部若仍是自己(期间无新消息入队),删除
    // 条目,Map 只持有在途房间;新消息已替换队尾则保留。
    void next.then(() => {
      if (this.sendQueues.get(chatId) === next) this.sendQueues.delete(chatId);
    });
    return run;
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

  /**
   * reaction 入站订阅缝(票01,#268):m.reaction 事件(用户点击表情)经
   * room.event 过滤后从这里分发,一房一回调(与 onMessage 同风格,后注册
   * 覆盖前者)。无订阅者时事件照常被消费丢弃——原语先行,消费方后续票接线。
   */
  onReaction(handler: (reaction: MatrixReaction) => void): void {
    this.reactionHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  private async handleMessage(roomId: string, event: any): Promise<void> {
    if (!this.client || !this.botUserId || !this.translator) return;

    // Pure filter — module-bottom pure function (own messages, stale
    // replay, unjoined rooms, m.notice silence, edits).
    const skipReason = shouldSkipEvent(event, this.botUserId, this.connectedAt, this.joinedRooms, roomId);
    if (skipReason) {
      // 离线积压(issue #113):stale 且台账确认从未受理 = 桥不在线的窗口里
      // 真收到的消息。受理记账后照常走翻译管道,带 replayed 标记交给 router
      // 征询;台账见过(历史回放)与首运会话(初始同步无法区分)维持丢弃。
      if (this.isBacklogCandidate(event, skipReason)) {
        const eventId = event.event_id as string;
        logger.info(`offline backlog accepted: ${eventId} (${roomId})`);
        this.eventLedger!.record(eventId);
        const outcome = await this.translator.translate(roomId, event);
        if (outcome.info) logger.info(outcome.info);
        if (outcome.warn) logger.warn(outcome.warn);
        if (outcome.message) {
          outcome.message.replayed = true;
          this.messageHandler?.(outcome.message);
        }
      }
      return;
    }

    // 受理即记账(issue #113 的另一半):实时路径的每一件也必须入台账 ——
    // 否则重启后的同步回放里,「已处理过的历史」与「真积压」无从区分,
    // 全会被误判成积压而重复执行。记账在翻译之前:过了过滤器就算受理。
    if (this.eventLedger && typeof event.event_id === "string" && event.event_id) {
      this.eventLedger.record(event.event_id);
    }

    // Translation (spec #72 票2/C2): classification, mention stripping, quote
    // bookkeeping and attachment persistence live in the translator module;
    // this transport only wires the SDK to it and logs its lines.
    const outcome = await this.translator.translate(roomId, event);
    if (outcome.info) logger.info(outcome.info);
    if (outcome.warn) logger.warn(outcome.warn);
    if (outcome.message) this.messageHandler?.(outcome.message);
  }

  /**
   * m.reaction 入站分发(票01,#268):room.event 放行后走到这里。次序与
   * shouldSkipEvent 的语义对齐——先过滤(bot 自己种的、结构畸形的),再新鲜度
   * (早于 connectedAt 的重启回放直接丢),过了全部过滤器才算受理,受理才记
   * 台账(幂等;与实时消息「受理即记账」同一原则),最后触发 onReaction。
   * 静默忽略是有意的噪音策略:不认识的 reaction 不回任何帖子。
   */
  private handleReaction(roomId: string, event: any): void {
    if (!this.client || !this.botUserId) return;
    // bot 自己种的表情不当用户应答(防「自己确认自己」循环)
    if (event?.sender === this.botUserId) return;
    const sender = event?.sender;
    const relates = event?.content?.["m.relates_to"] as
      | { rel_type?: unknown; event_id?: unknown; key?: unknown }
      | undefined;
    // 只认 annotation 关系,且四元组字段齐全,残缺事件静默丢弃
    if (relates?.rel_type !== "m.annotation") return;
    const { event_id: targetEventId, key } = relates;
    if (
      typeof sender !== "string" ||
      typeof targetEventId !== "string" ||
      !targetEventId ||
      typeof key !== "string" ||
      !key
    ) {
      logger.debug(`[Matrix] ignoring malformed reaction event ${event?.event_id ?? "(no id)"}`);
      return;
    }
    // 重启回放的迟到 reaction:早于本连接的建立点,直接丢(不发回调、不记账)
    const eventTs = event.origin_server_ts || 0;
    if (eventTs < this.connectedAt) return;
    // 受理即记账(幂等):与实时消息同一原则——过了过滤器就算受理
    if (this.eventLedger && typeof event.event_id === "string" && event.event_id) {
      this.eventLedger.record(event.event_id);
    }
    this.reactionHandler?.({ chatId: roomId, targetEventId, key, sender });
  }

  /**
   * issue #113:「stale」事件何时算离线积压候选 —— 台账已装配且非首运会话
   * (freshStart 挡住全新部署/升级首启的初始同步回放)、inbox 模式要处理
   * 积压、事件 id 形态合法、且台账里没见过。分类裁决仍归 shouldSkipEvent,
   * 「命中与否」的裁决在调用方(本函数)。
   */
  private isBacklogCandidate(event: {
    event_id?: unknown;
    content?: { msgtype?: unknown; body?: unknown; "m.new_content"?: unknown };
  }, skipReason: string): boolean {
    if (skipReason !== "stale") return false;
    if (this.inbox === "off") return false;
    const ledger = this.eventLedger;
    if (!ledger || ledger.freshStart) return false;
    // 三条既有静默策略不因积压破例:其它服务的 m.notice(防 bot 循环)、
    // 编辑事件、无 body 的非文本——都不算积压候选。
    const content = event.content;
    if (content?.msgtype === "m.notice") return false;
    if (typeof content?.body !== "string" || !content.body) return false;
    if (content["m.new_content"]) return false;
    const eventId = event.event_id;
    if (typeof eventId !== "string" || !eventId) return false;
    return !ledger.seen(eventId);
  }

  /** Fail-closed stand-in member count for rooms whose live lookup failed
   *  twice: isGroupChatRoom(3) is true, so mention gating stays on. Deliberate
   *  coupling to isGroupChatRoom's "> 2" threshold — keep the two in sync. */
  private static readonly FAIL_CLOSED_MEMBER_COUNT = 3;

  /** Cached member-count lookup shared by the text and media pipelines.
   *  One retry for transient API blips; if the lookup still fails, fail
   *  CLOSED — assume a group so mention gating applies. The old DM default
   *  let group traffic bypass mention/authorization on transient failures
   *  (audit fix). Successful lookups are cached; failures are not, so the
   *  next event retries. */
  private async resolveIsGroupChat(roomId: string): Promise<boolean> {
    let memberCount = this.roomMemberCount.get(roomId);
    if (memberCount === undefined) {
      for (let attempt = 0; attempt < 2 && memberCount === undefined; attempt += 1) {
        try {
          memberCount = (await this.client!.getJoinedRoomMembers(roomId)).length;
        } catch {
          memberCount = undefined;
        }
      }
      if (memberCount !== undefined) {
        this.roomMemberCount.set(roomId, memberCount);
      } else {
        logger.warn(
          `[Matrix] member count lookup failed twice for ${roomId} — failing closed as a group chat (repeats until the lookup recovers)`
        );
      }
    }
    // Unresolvable count → assume group, never default to DM.
    return isGroupChatRoom(memberCount ?? MatrixProvider.FAIL_CLOSED_MEMBER_COUNT);
  }

  /**
   * The Matrix half of the attachment download seam (issue #66): media via
   * the authenticated v1 endpoint, streamed with a hard byte cap enforced
   * DURING the transfer (sec 下载 OOM 修复:SDK 的 downloadContent /
   * crypto.decryptMedia 都是整包进内存后才能判大小,谎报 sizeHint 的房间
   * 成员或恶意联邦媒体服务器可致 OOM)。E2EE 附件 = 带上限的密文流式下载 +
   * 本地规范解密(decryptEncryptedMedia,node:crypto,经与 Rust Attachment
   * 双向互认验证)—— 附件解密不再依赖原生 crypto 库。
   */
  get mediaSource(): MediaSource {
    return {
      downloadPlaintext: async (mxcUrl, maxBytes) => this.downloadMediaCapped(mxcUrl, maxBytes),
      ...(this.config.encryption !== false
        ? {
            downloadEncrypted: async (file, maxBytes) =>
              decryptEncryptedMedia(file, await this.downloadMediaCapped(file.url, maxBytes)),
          }
        : {}),
    };
  }

  /**
   * 流式下载一个 mxc 的原始字节(明文或密文),全程实施 maxBytes 硬上限。
   * 端点与转义规则同 SDK 0.8.0 的 downloadContent(认证版 v1 媒体端点),
   * 但逐块计数、超限即中止。fetch 走进程全局调度:配置了代理时由 proxy.ts
   * 装配的 EnvHttpProxyAgent 接管,与 SDK request 腿共用同一套代理规则。
   */
  private async downloadMediaCapped(mxcUrl: string, maxBytes: number): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(mediaDownloadUrl(this.config.homeserverUrl, mxcUrl), {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        // 错误体也必须有界读:恶意服务器同样可以在错误响应里塞大 body。
        const detail = (await readBoundedErrorText(res)).trim().slice(0, 200);
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      // Content-Length 先拒:声明超限就不读 body(便宜的一手;分块传输/
      // 谎报长度由 readCapped 的逐块计数兜住)。
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        throw new AttachmentTooLargeError(declared, maxBytes);
      }
      try {
        return await readCapped(res.body as ReadableStream<Uint8Array>, maxBytes);
      } catch (err) {
        // 超限中止时确保连接被掐断(readCapped 抛出走迭代器 return,
        // 这里再兜一层 abort,双保险)。
        if (err instanceof AttachmentTooLargeError) controller.abort();
        throw err;
      }
    } catch (err) {
      // 上限判定原样上抛(store 据此给"附件过大"回执);超时翻成人话
      // (与 attachments.ts withTimeout 同一文案);其余原样交给 store
      // 统一包装成下载失败回执。
      if (err instanceof AttachmentTooLargeError) throw err;
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw new Error(t("attach.downloadTimeout", { seconds: DOWNLOAD_TIMEOUT_MS / 1000 }));
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

}

/**
 * reaction 入站信封(票01,#268):m.reaction 不进消息管道,经 onReaction
 * 自带四元组分发——router 侧(后续票)凭 targetEventId 认领悬置的征询/提问,
 * key 原样上抛(emoji 语义映射不在 transport 层)。
 */
export interface MatrixReaction {
  /** 房间 id(= chatId,与 ExternalMessage.chatId 同一口径)。 */
  chatId: string;
  /** 被标注的目标事件 id(m.relates_to.event_id)。 */
  targetEventId: string;
  /** 原始 reaction key(✅/❌/键帽数字等),未做任何归一化。 */
  key: string;
  /** 点击者(mxid;bot 自己种的已在分发前过滤)。 */
  sender: string;
}

// ─── 纯函数区(spec #99/#101:自 matrix-utils.ts 归位到唯一属主 transport)───
// 出站渲染、事件过滤、群聊判定——无 SDK/网络依赖,可直测。

/**
 * mxc:// → 认证版 v1 媒体下载 URL。端点与转义规则与 SDK 0.8.0 的
 * downloadContent 完全一致(domain/mediaId 分别 encodeURIComponent,mediaId
 * 只取路径首段,忽略尾部文件名段),保证与 SDK 行为逐字对齐。
 */
export function mediaDownloadUrl(homeserverUrl: string, mxcUrl: string): string {
  if (!mxcUrl.toLowerCase().startsWith("mxc://")) {
    throw new Error("'mxcUrl' does not begin with mxc://");
  }
  const urlParts = mxcUrl.substring("mxc://".length).split("/");
  const domain = encodeURIComponent(urlParts[0] ?? "");
  const mediaId = encodeURIComponent(urlParts[1]?.split("/")[0] ?? "");
  if (!domain || !mediaId) {
    throw new Error(`invalid mxc URI: ${mxcUrl}`);
  }
  return `${homeserverUrl}/_matrix/client/v1/media/download/${domain}/${mediaId}?allow_remote=true`;
}

/**
 * 有界读一个错误响应体(≤2KB):错误路径同样不能被大 body 打爆内存 ——
 * 恶意服务器可以在 4xx/5xx 响应里塞任意大的错误页。读一半断流不影响
 * 主错误(外层关心的是 HTTP 状态码与错误摘要)。
 */
async function readBoundedErrorText(res: Response): Promise<string> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= 2048) break;
    }
  } catch {
    // 错误体读不出来就空着,主错误照抛
  }
  return Buffer.concat(chunks).toString("utf8");
}

// html:false escapes raw HTML (pi output must never inject tags);
// breaks:true keeps chat-style single newlines as <br>;
// linkify turns bare URLs into links.
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

/**
 * Convert markdown to Matrix HTML. Returns plain body (fallback) + formatted HTML.
 *
 * win32 门控的反斜杠预转义(spec #233):CommonMark 转义会在渲染时吞掉
 * Windows 路径里 `\`+标点 的反斜杠(`\.`、`\_`),发送端先补成 `\\` 让
 * 渲染还原;纯文本 body 始终是原文。非 win32 平台零变化。
 */
export function formatForMatrix(
  text: string,
  platform: NodeJS.Platform = process.platform,
): { body: string; formattedBody?: string } {
  const source = platform === "win32" ? escapeBackslashesOutsideFences(text) : text;
  return { body: text, formattedBody: md.render(source).trim() };
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
