import type { ExternalMessage } from "../types.js";

/**
 * Message I/O seam — one adapter per messenger platform. The router depends
 * only on this surface for receiving and replying.
 */
export interface Transport {
  /** Transport type identifier */
  readonly type: string;

  /** Is the transport currently connected? */
  readonly isConnected: boolean;

  /**
   * Connect to the messenger service
   * @throws Error if connection fails
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the messenger service
   */
  disconnect(): Promise<void>;

  /**
   * Send a text message to a chat
   * @param chatId - Chat/channel identifier
   * @param text - Message content
   */
  sendMessage(chatId: string, text: string): Promise<void>;

  /**
   * Send typing indicator to a chat
   * @param chatId - Chat/channel identifier
   */
  sendTyping(chatId: string): Promise<void>;

  /**
   * Register callback for incoming messages
   * @param handler - Message handler function
   */
  onMessage(handler: (message: ExternalMessage) => void): void;

  /**
   * Register callback for errors
   * @param handler - Error handler function
   */
  onError(handler: (error: Error) => void): void;
}

/**
 * Room-management capability (Matrix rooms today). Consumed by the /pmctl
 * path, management-room branding and the startup space ensure; absent in
 * single-project or non-Matrix deployments. A second transport with a real
 * "room" concept is the point at which this graduates to a multi-platform
 * seam — until then it is a concrete capability, not a hypothetical one.
 *
 * Failure semantics are uniform for operations: every method THROWS with a
 * meaningful message (callers reply with it). No null returns, no silent
 * no-ops. The exceptions are the QUERY members (getBotUserId,
 * encryptionAvailable), which legitimately report a not-yet-connected or
 * unavailable capability instead of throwing.
 */
export interface RoomOps {
  /** Create a private room — the general primitive (name + invitees; E2EE
   *  state opt-in, only meaningful when encryptionAvailable). Returns room ID. */
  createRoom(opts: { name: string; inviteUserIds: string[]; encrypted?: boolean }): Promise<string>;
  /** Create a private project room with a name and invite a user. Returns room ID. */
  createProjectRoom(name: string, inviteUserId: string): Promise<string>;
  /** Create a private space (m.space organizational container). Returns space room ID. */
  createSpace(opts: { name: string; inviteUserIds: string[] }): Promise<string>;
  /** Link a room into a space: space-side m.space.child (the load-bearing
   *  event for Element) plus child-side m.room.parent, the latter
   *  best-effort — the bot may lack power in rooms it did not create. */
  addRoomToSpace(spaceRoomId: string, childRoomId: string): Promise<void>;
  /** Unlink a room from a space (used by /pmctl rm): clears m.space.child
   *  so the space view loses the room, plus the child-side m.room.parent,
   *  best-effort. */
  removeRoomFromSpace(spaceRoomId: string, childRoomId: string): Promise<void>;
  /** Rename a room. */
  setRoomName(roomId: string, name: string): Promise<void>;
  /** The bot's own user ID (null if not connected). */
  getBotUserId(): string | null;
  /** Whether E2EE is truly usable in this process (the config switch may be
   *  on while the Rust crypto stack failed to load — rooms must not be
   *  marked encrypted in that case). */
  readonly encryptionAvailable: boolean;
  /** Set a user's power level in a room (project owner -> admin). */
  setUserPowerLevel(roomId: string, userId: string, level: number): Promise<void>;
  /** Have the bot actively leave a room. */
  leaveRoom(roomId: string, reason?: string): Promise<void>;
}
