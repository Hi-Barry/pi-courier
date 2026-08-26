import type { ExternalMessage } from "../types.js";
import type { ITransportProvider } from "./interface.js";

/**
 * Manages multiple transport providers and routes messages
 */
export class TransportManager {
  private transports = new Map<string, ITransportProvider>();
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error, transport: string) => void;

  /**
   * Register a transport provider
   */
  addTransport(transport: ITransportProvider): void {
    this.transports.set(transport.type, transport);

    // Forward messages from this transport
    transport.onMessage((msg) => {
      if (this.messageHandler) {
        this.messageHandler(msg);
      }
    });

    // Forward errors from this transport
    transport.onError((err) => {
      if (this.errorHandler) {
        this.errorHandler(err, transport.type);
      }
    });
  }

  /**
   * Get a specific transport by type
   */
  getTransport(type: string): ITransportProvider | undefined {
    return this.transports.get(type);
  }

  /**
   * Get all registered transports
   */
  getAllTransports(): ITransportProvider[] {
    return Array.from(this.transports.values());
  }

  /**
   * Connect all registered transports
   */
  async connectAll(): Promise<void> {
    const connections = Array.from(this.transports.values()).map((t) =>
      t.connect().catch((err) => {
        throw new Error(`${t.type} connection failed: ${(err as Error).message}`);
      })
    );
    await Promise.all(connections);
  }

  /**
   * Disconnect all transports
   */
  async disconnectAll(): Promise<void> {
    const disconnections = Array.from(this.transports.values()).map((t) =>
      t.disconnect()
    );
    await Promise.allSettled(disconnections);
  }

  /**
   * Send a message to a specific chat via a specific transport
   */
  async sendMessage(
    chatId: string,
    transportType: string,
    text: string
  ): Promise<void> {
    const transport = this.transports.get(transportType);
    if (!transport) {
      throw new Error(`Transport ${transportType} not found`);
    }
    if (!transport.isConnected) {
      throw new Error(`Transport ${transportType} not connected`);
    }
    await transport.sendMessage(chatId, text);
  }

  /**
   * Send typing indicator to a chat via a specific transport
   */
  async sendTyping(chatId: string, transportType: string): Promise<void> {
    const transport = this.transports.get(transportType);
    if (transport?.isConnected) {
      await transport.sendTyping(chatId);
    }
  }

  /**
   * Register handler for incoming messages from all transports
   */
  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register handler for errors from all transports
   */
  onError(handler: (error: Error, transport: string) => void): void {
    this.errorHandler = handler;
  }

  /** Create a private room via the Matrix transport (null if unavailable). */
  async createProjectRoom(name: string, inviteUserId: string): Promise<string | null> {
    const matrix = this.transports.get("matrix");
    if (!matrix?.createProjectRoom) return null;
    return matrix.createProjectRoom(name, inviteUserId);
  }

  /** Rename a room via the Matrix transport (no-op if unavailable). */
  async setRoomName(roomId: string, name: string): Promise<void> {
    const matrix = this.transports.get("matrix");
    if (matrix?.setRoomName) await matrix.setRoomName(roomId, name);
  }

  /** Get a room's current name via the Matrix transport (null if unavailable). */
  async getRoomName(roomId: string): Promise<string | null> {
    const matrix = this.transports.get("matrix");
    if (!matrix?.getRoomName) return null;
    return matrix.getRoomName(roomId);
  }

  /** Have the bot actively leave a room (no-op if unavailable). */
  async leaveRoom(roomId: string, reason?: string): Promise<void> {
    const matrix = this.transports.get("matrix") as ITransportProvider | undefined;
    if (!matrix?.leaveRoom) return;
    await matrix.leaveRoom(roomId, reason);
  }

  /** The bot's own Matrix user ID (null if not connected). */
  getBotUserId(): string | null {
    const matrix = this.transports.get("matrix") as ITransportProvider | undefined;
    return matrix?.getBotUserId?.() ?? null;
  }

  /** Set a user's power level in a room (project owner -> admin). */
  async setUserPowerLevel(roomId: string, userId: string, level: number): Promise<void> {
    const matrix = this.transports.get("matrix") as ITransportProvider | undefined;
    if (!matrix?.setUserPowerLevel) return;
    await matrix.setUserPowerLevel(roomId, userId, level);
  }

  /**
   * Get connection status for all transports
   */
  getStatus(): Array<{ type: string; connected: boolean }> {
    return Array.from(this.transports.values()).map((t) => ({
      type: t.type,
      connected: t.isConnected,
    }));
  }
}
