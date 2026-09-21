/**
 * Matrix client port + production adapter (spec #99, issue #100).
 *
 * The port captures exactly the matrix-bot-sdk surface the two Matrix
 * adapters (matrix.ts message I/O, matrix-rooms.ts room capabilities)
 * actually use — no more — so tests can inject fakes and the SDK stays
 * quarantined in this module. The production factory wires storage paths,
 * E2EE crypto storage (with graceful degradation), the auto-join mixin and
 * the SDK log facade; the real MatrixClient structurally satisfies the
 * port, so no wrapper class is needed.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ILogger, RoomCreateOptions } from "matrix-bot-sdk";
import {
  AutojoinRoomsMixin,
  LogService,
  MatrixClient,
  RustSdkCryptoStorageProvider,
  RustSdkCryptoStoreType,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk";
import { logger } from "../logger.js";
import type { EncryptedMediaFile } from "./attachments.js";

/** The crypto half of the client — present only when the Rust crypto stack
 *  loaded successfully at connect time; its presence gates E2EE features. */
export interface MatrixClientCrypto {
  decryptMedia(file: EncryptedMediaFile): Promise<Buffer>;
}

/** Outgoing room message content (the shape sendMessage is called with). */
export interface MatrixMessageContent {
  msgtype: string;
  body: string;
  format?: string;
  formatted_body?: string;
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

  // ── 出站 ──
  sendMessage(roomId: string, content: MatrixMessageContent): Promise<string>;
  setTyping(roomId: string, typing: boolean, timeoutMs?: number): Promise<unknown>;

  // ── 媒体 ──
  downloadContent(mxcUrl: string): Promise<{ data: Buffer; contentType: string }>;
  /** Absent when the deployment runs without the crypto stack. */
  crypto?: MatrixClientCrypto;

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

export type MatrixClientFactory = (config: MatrixClientConfig) => MatrixClientPort;

/**
 * Production factory: builds the real matrix-bot-sdk client against the
 * on-disk stores under ~/.pi.
 *
 * - Storage: SimpleFsStorageProvider at ~/.pi/pi-courier-matrix-store.json
 *   (sync token, room membership — survives restarts).
 * - Crypto: RustSdkCryptoStorageProvider at ~/.pi/pi-courier-matrix-crypto
 *   (native Rust, SQLite on disk) when encryption is enabled. Crypto state
 *   persists across restarts — same device, same keys; the device must be
 *   verified once from another Matrix client (Element, etc). Construction
 *   failure degrades gracefully to a crypto-less client (warn only) — the
 *   port's absent `crypto` member is the deployment-wide E2EE verdict.
 */
export function createMatrixClient(config: MatrixClientConfig): MatrixClientPort {
  const storagePath = path.join(os.homedir(), ".pi", "pi-courier-matrix-store.json");
  const storage = new SimpleFsStorageProvider(storagePath);

  let cryptoProvider: RustSdkCryptoStorageProvider | undefined;
  if (config.encryption !== false) {
    try {
      const cryptoStorePath = path.join(os.homedir(), ".pi", "pi-courier-matrix-crypto");
      cryptoProvider = new RustSdkCryptoStorageProvider(cryptoStorePath, RustSdkCryptoStoreType.Sqlite);
      logger.info("[Matrix] E2EE crypto storage enabled (Rust/SQLite)");
    } catch (err) {
      logger.warn("[Matrix] E2EE crypto not available, continuing without encryption:", (err as Error).message);
    }
  }

  const client = new MatrixClient(config.homeserverUrl, config.accessToken, storage, cryptoProvider);

  // Auto-join rooms the bot is invited to
  AutojoinRoomsMixin.setupOnClient(client);

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
  // iff a crypto store was handed in).
  return client;
}
