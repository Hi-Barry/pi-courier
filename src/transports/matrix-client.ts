/**
 * Matrix client port + production adapter (spec #99, issue #100).
 *
 * The port captures exactly the matrix-bot-sdk surface the two Matrix
 * adapters (matrix.ts message I/O, matrix-rooms.ts room capabilities)
 * actually use — no more — so tests can inject fakes and the SDK stays
 * quarantined in this module. The production factory wires storage paths,
 * E2EE crypto storage (with graceful degradation), the auto-join handler and
 * the SDK log facade; the real MatrixClient structurally satisfies the
 * port, so no wrapper class is needed.
 */
import type { CryptoClient, ILogger, RoomCreateOptions } from "matrix-bot-sdk";
import {
  LogService,
  MatrixClient,
  RustSdkCryptoStorageProvider,
  RustSdkCryptoStoreType,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk";
import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";

/** Whether the error is the expected "native crypto binding failed to load"
 *  failure (missing download, ABI mismatch, unsupported loader). */
function isNativeLoadFailure(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "MODULE_NOT_FOUND" || code === "ERR_DLOPEN_FAILED") return true;
  return /matrix-sdk-crypto|\.node\b|dlopen|cannot find module|dynamic loading|incompatible architecture|load error/i.test(
    errorMessage(err)
  );
}

/** Outgoing room message content (the shape sendMessage is called with).
 *  The MSC2676 edit fields (m.new_content / m.relates_to) ride the same
 *  outbound channel — edits are just room message content with two extra
 *  keys (issue #235 票1). */
export interface MatrixMessageContent {
  msgtype: string;
  body: string;
  format?: string;
  formatted_body?: string;
  /** MSC2676 replacement payload — present only on edit events; same
   *  structure as an ordinary message's content. */
  "m.new_content"?: MatrixMessageContent;
  /** MSC2676 relation — rel_type "m.replace" pointing at the original
   *  event_id being replaced; annotation (rel_type "m.annotation") adds the
   *  reaction `key` (m.reaction events, 票01 #268). */
  "m.relates_to"?: { rel_type: string; event_id: string; key?: string };
}

/** Events the adapters subscribe to. room.join / room.leave deliver only
 *  the roomId; room.message / room.event deliver (roomId, event). */
export type MatrixClientEvent = "room.join" | "room.leave" | "room.message" | "room.event";

/**
 * The Matrix client port: connection lifecycle, event registration, reads,
 * outbound sends, media and room capabilities, grouped as the adapters use
 * them.
 */
export interface MatrixClientPort {
  // ── 连接生命周期 ──
  /** Start the sync loop (initial sync replays history before resolving). */
  start(): Promise<unknown>;
  stop(): void;
  getUserId(): Promise<string>;

  // ── 事件注册 ──
  on(event: MatrixClientEvent, handler: (roomId: string, event?: any) => void): void;

  // ── 读取 ──
  getJoinedRooms(): Promise<string[]>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  /** 全量房间状态(原始事件数组,type/state_key/content)——bot 登记簿
   *  (spec #299 票02)按自定义类型过滤 state_key 用,不做逐 key 探测。 */
  getRoomState(roomId: string): Promise<Array<{ type: string; state_key: string; content: any }>>;

  // ── 出站 ──
  sendMessage(roomId: string, content: MatrixMessageContent): Promise<string>;
  /** 在一条已发出的消息上标注一个 reaction(票01 #268):发 m.reaction 事件,
   *  m.relates_to 为 { rel_type: "m.annotation", event_id, key }。返回
   *  reaction 事件自己的 event_id。 */
  sendReaction(roomId: string, eventId: string, key: string): Promise<string>;
  setTyping(roomId: string, typing: boolean, timeoutMs?: number): Promise<unknown>;

  // ── 媒体 ──
  // 附件下载不走端口:SDK 的 downloadContent/decryptMedia 都是整包进内存后
  // 才能判大小(sec 下载 OOM 修复),媒体下载经 matrix.ts 的流式带上限实现
  // (mediaSource)。端口刻意不收留无上限的下载原语,防止未来适配器误用绕过
  // 全部上限。
  /** Present only when the Rust crypto stack loaded successfully at connect
   *  time — the port consumes its PRESENCE only (E2EE availability gating);
   *  attachment decryption is local (attachments.ts) and needs no methods.
   *  Typed as the SDK's CryptoClient so the real client satisfies the port
   *  structurally without a wrapper. */
  crypto?: CryptoClient;

  // ── 房间能力 ──
  createRoom(properties?: RoomCreateOptions): Promise<string>;
  sendStateEvent(roomId: string, type: string, stateKey: string, content: any): Promise<string>;
  getRoomStateEvent(roomId: string, type: string, stateKey: string): Promise<any>;
  inviteUser(userId: string, roomId: string): Promise<unknown>;
  setUserPowerLevel(userId: string, roomId: string, newLevel: number): Promise<unknown>;
  setAvatarUrl(avatarUrl: string): Promise<unknown>;
  getUserProfile(userId: string): Promise<any>;
  uploadContent(data: Buffer, contentType?: string): Promise<string>;
  leaveRoom(roomId: string, reason?: string): Promise<unknown>;
}

/** Factory configuration — the provider's own config shape, passed through. */
export interface MatrixClientConfig {
  homeserverUrl: string;
  accessToken: string;
  encryption?: boolean;
}

export type MatrixClientFactory = (
  config: MatrixClientConfig,
  paths?: MatrixStorePaths,
) => MatrixClientPort;

/**
 * Matrix SDK 的磁盘存储路径(spec #258 票03 注入缝):组合根从布局解析取
 * (storagePath = dataDir/matrix-store.json,cryptoDir = dataDir/matrix-crypto),
 * 本模块不再各自拼 ~/.pi。旧 0.2.x 布局的 ~/.pi/pi-courier-matrix-store.json
 * 与 pi-courier-matrix-crypto/ 由启动期迁移模块搬进新家。
 */
export interface MatrixStorePaths {
  /** 消息存储文件(sync token、房间成员关系,重启存活)。 */
  storagePath: string;
  /** 加密库存放目录(原生 Rust/SQLite)。 */
  cryptoDir: string;
}

/**
 * Production factory: builds the real matrix-bot-sdk client against the
 * on-disk stores at the injected paths (dataDir leaves since spec #258).
 *
 * - Storage: SimpleFsStorageProvider at paths.storagePath (sync token, room
 *   membership — survives restarts).
 * - Crypto: RustSdkCryptoStorageProvider at paths.cryptoDir (native Rust,
 *   SQLite on disk) when encryption is enabled. Crypto state persists across
 *   restarts — same device, same keys; the device must be verified once from
 *   another Matrix client (Element, etc). A native-load failure degrades to a
 *   crypto-less client (error-level log); any other construction failure
 *   propagates — silent degradation is reserved for the one expected failure,
 *   not for misconfiguration. The port's absent `crypto` member is the
 *   deployment-wide E2EE verdict. Missing paths is a wiring bug and throws
 *   loudly at construction — there is no legacy fallback location to be
 *   silently right about (tests inject fakes and never hit this).
 */
export function createMatrixClient(config: MatrixClientConfig, paths?: MatrixStorePaths): MatrixClientPort {
  if (!paths?.storagePath || !paths?.cryptoDir) {
    throw new Error("Matrix storage paths are required (composition root injects layout storagePath/cryptoDir)");
  }
  const storage = new SimpleFsStorageProvider(paths.storagePath);

  let cryptoProvider: RustSdkCryptoStorageProvider | undefined;
  if (config.encryption !== false) {
    try {
      cryptoProvider = new RustSdkCryptoStorageProvider(paths.cryptoDir, RustSdkCryptoStoreType.Sqlite);
      logger.info("[Matrix] E2EE crypto storage enabled (Rust/SQLite)");
    } catch (err) {
      // Degrade ONLY on the expected failure — the native binding failing to
      // load (missing download, ABI mismatch). Anything else is a deployment
      // problem that must fail loudly instead of silently turning E2EE off
      // while the owner believes the bot is encrypted (audit fix).
      if (isNativeLoadFailure(err)) {
        logger.error("[Matrix] E2EE crypto native binding failed to load, continuing WITHOUT encryption:", errorMessage(err));
      } else {
        throw err;
      }
    }
  }

  const client = new MatrixClient(config.homeserverUrl, config.accessToken, storage, cryptoProvider);

  // Auto-join rooms the bot is invited to — best-effort, never fatal. The
  // SDK's AutojoinRoomsMixin returns the joinRoom promise from the listener
  // and EventEmitter drops listener return values, so any unjoinable invite
  // (remote room without via servers, banned, gone) surfaces as an unhandled
  // rejection that kills the process (issue #110). Register our own handler
  // with an explicit catch instead.
  client.on("room.invite", (roomId: string) => {
    client.joinRoom(roomId)
      .then(() => {
        // SDK 的 room.join 只在 sync 的 join 段 timeline 里看到自己的 join
        // 事件时才发出 —— 而 API 直接 join 后,该事件通常落在同一响应的
        // state 段,SDK 永远看不到:自动加入的群不触发 room.join,joinedRooms
        // 不记账、群聊一次性提示不发(2026-10-11 真机复现:bot 已 join、
        // 房间零消息)。join 成功后主动补发一次;transport 侧按 isNew 去重,
        // SDK 若在后续 sync 里迟到真事件也不会二次提示。
        client.emit("room.join", roomId);
      })
      .catch((err: unknown) => {
        logger.warn(
          "[Matrix] auto-join failed for invited room, skipping:",
          roomId,
          err instanceof Error ? err.message : err,
        );
      });
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

  // MatrixClient structurally satisfies the port (crypto is set by the SDK
  // iff a crypto store was handed in). One member the SDK lacks by name is
  // the reaction primitive (票01 #268): attached on the instance via the SDK's
  // generic sendEvent — an m.reaction event whose m.relates_to is the
  // annotation triple. E2EE rooms are handled by sendEvent itself (it
  // encrypts the payload when the room is encrypted), so reactions work in
  // encrypted rooms too.
  return Object.assign(client, {
    sendReaction(roomId: string, eventId: string, key: string): Promise<string> {
      return client.sendEvent(roomId, "m.reaction", {
        "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key },
      });
    },
  });
}
