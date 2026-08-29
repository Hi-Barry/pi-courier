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
 * Room-management capability (Matrix rooms today). Consumed ONLY by the
 * /pmctl path and management-room branding; absent in single-project or
 * non-Matrix deployments. A second transport with a real "room" concept is
 * the point at which this graduates to a multi-platform seam — until then it
 * is a concrete capability, not a hypothetical one.
 *
 * Failure semantics are uniform for operations: every method THROWS with a
 * meaningful message (callers reply with it). No null returns, no silent
 * no-ops. The one exception is the getBotUserId QUERY, which legitimately
 * returns null before connecting.
 */
export interface RoomOps {
  /** Create a private room with a name and invite a user. Returns room ID. */
  createProjectRoom(name: string, inviteUserId: string): Promise<string>;
  /** Rename a room. */
  setRoomName(roomId: string, name: string): Promise<void>;
  /** The bot's own user ID (null if not connected). */
  getBotUserId(): string | null;
  /** Set a user's power level in a room (project owner -> admin). */
  setUserPowerLevel(roomId: string, userId: string, level: number): Promise<void>;
  /** Have the bot actively leave a room. */
  leaveRoom(roomId: string, reason?: string): Promise<void>;
}
