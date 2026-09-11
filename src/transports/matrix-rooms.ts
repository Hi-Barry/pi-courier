import { type MatrixClient, MatrixError } from "matrix-bot-sdk";
import type { RoomOps } from "./interface.js";

/** A missing (or not-visible) state event is a query answer, not a failure —
 *  shared by every getRoomStateEvent-backed query member. */
function isStateNotFound(err: unknown): boolean {
  return err instanceof MatrixError && (err.statusCode === 404 || err.errcode === "M_NOT_FOUND");
}

/**
 * RoomOps adapter for Matrix — the room-capability half of the Matrix
 * integration. MatrixProvider composes this instance and the composition
 * root hands it to the /pmctl path and the startup space ensure; the
 * message-I/O half (Transport) stays in matrix.ts.
 *
 * The adapter reaches the live client through injected accessors instead
 * of holding the provider, so nothing in here can accidentally grow
 * transport concerns. Failure semantics follow the RoomOps doc: every
 * operation throws with a meaningful message, the query members
 * (getBotUserId, encryptionAvailable, getPowerLevels) report not-connected
 * or not-present instead.
 */
export class MatrixRoomOps implements RoomOps {
  /** Set by MatrixProvider after connect, once the crypto stack verdict is in. */
  encryptionAvailable = false;

  constructor(
    private deps: {
      getClient: () => MatrixClient | undefined;
      getBotUserId: () => string | undefined;
      /** Transport-side cache purge after the bot actively leaves a room. */
      onLeftRoom: (roomId: string) => void;
    }
  ) {}

  private get client(): MatrixClient {
    const client = this.deps.getClient();
    if (!client) throw new Error("Matrix 未连接");
    return client;
  }

  /** Create a private room — the general primitive (name + invitees; E2EE
   *  state opt-in, only pass encrypted=true when encryptionAvailable). */
  async createRoom(opts: { name: string; inviteUserIds: string[]; encrypted?: boolean }): Promise<string> {
    const roomId = await this.client.createRoom({
      name: opts.name,
      invite: opts.inviteUserIds,
      preset: "private_chat",
      ...(opts.encrypted
        ? {
            initial_state: [
              {
                type: "m.room.encryption",
                state_key: "",
                content: { algorithm: "m.megolm.v1.aes-sha2" },
              },
            ],
          }
        : {}),
    });
    return roomId;
  }

  /** Create a private project room (used by /pmctl new). */
  async createProjectRoom(name: string, inviteUserId: string): Promise<string> {
    return this.createRoom({ name, inviteUserIds: [inviteUserId] });
  }

  /** Create a private space (m.space organizational container). */
  async createSpace(opts: { name: string; inviteUserIds: string[] }): Promise<string> {
    return this.client.createRoom({
      name: opts.name,
      invite: opts.inviteUserIds,
      preset: "private_chat",
      visibility: "private",
      creation_content: { type: "m.space" },
    });
  }

  /** Link a room into a space (used by the startup space ensure). */
  async addRoomToSpace(spaceRoomId: string, childRoomId: string): Promise<void> {
    const botUserId = this.deps.getBotUserId();
    const via = botUserId ? [botUserId.split(":")[1] ?? ""] : [];
    // m.space.child (state_key = child room id) is what makes Element show
    // the room inside the space.
    await this.client.sendStateEvent(spaceRoomId, "m.space.child", childRoomId, { via });
    // m.room.parent lives in the child room; the bot may lack power there
    // (rooms it did not create). Element works from m.space.child alone.
    try {
      await this.client.sendStateEvent(childRoomId, "m.room.parent", spaceRoomId, {
        via,
        canonical: true,
      });
    } catch {
      // best-effort
    }
  }

  /** Unlink a room from a space (used by /pmctl rm). */
  async removeRoomFromSpace(spaceRoomId: string, childRoomId: string): Promise<void> {
    // Empty content drops the child from the space's view (m.space.child
    // with no via servers is not a resolvable child).
    await this.client.sendStateEvent(spaceRoomId, "m.space.child", childRoomId, {});
    // Clear the child-side badge too — best-effort; the bot leaves the room
    // right after, so remaining members keep a clean room header.
    try {
      await this.client.sendStateEvent(childRoomId, "m.room.parent", spaceRoomId, {});
    } catch {
      // best-effort
    }
  }

  /** Invite a user into a room (space membership). */
  async inviteUser(roomId: string, userId: string): Promise<void> {
    await this.client.inviteUser(userId, roomId);
  }

  /** Rename a room (used to brand the DM as the management room). */
  async setRoomName(roomId: string, name: string): Promise<void> {
    await this.client.sendStateEvent(roomId, "m.room.name", "", { name });
  }

  /** Read a room's display name; null when absent (query-member contract,
   *  same 404 / M_NOT_FOUND handling as getPowerLevels). */
  async getRoomName(roomId: string): Promise<string | null> {
    try {
      const event = (await this.client.getRoomStateEvent(roomId, "m.room.name", "")) as { name?: string };
      return event?.name ?? null;
    } catch (err) {
      if (isStateNotFound(err)) return null;
      throw err;
    }
  }

  /** Read a room's avatar mxc URL; null when the room has none. */
  async getRoomAvatar(roomId: string): Promise<string | null> {
    try {
      const content = (await this.client.getRoomStateEvent(roomId, "m.room.avatar", "")) as { url?: string };
      return content?.url ?? null;
    } catch (err) {
      if (isStateNotFound(err)) return null;
      throw err;
    }
  }

  /** Set a room's avatar from an uploaded mxc URL (m.room.avatar state). */
  async setRoomAvatar(roomId: string, avatarUrl: string, info?: Record<string, unknown>): Promise<void> {
    await this.client.sendStateEvent(roomId, "m.room.avatar", "", {
      url: avatarUrl,
      ...(info ? { info } : {}),
    });
  }

  /** Upload media to the homeserver's content repository; returns mxc URL. */
  async uploadMedia(data: Buffer, contentType: string): Promise<string> {
    return this.client.uploadContent(data, contentType);
  }

  /** Set a user's power level in a room (used to make the project owner admin). */
  async setUserPowerLevel(roomId: string, userId: string, level: number): Promise<void> {
    await this.client.setUserPowerLevel(userId, roomId, level);
  }

  /** Read a room's power-level state (m.room.power_levels); null when the
   *  room reports 404 / M_NOT_FOUND for it (the query-member contract). */
  async getPowerLevels(roomId: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.client.getRoomStateEvent(roomId, "m.room.power_levels", "")) as Record<string, unknown>;
    } catch (err) {
      // A room without (visible) power levels is a query result, not a
      // failure: 404 / M_NOT_FOUND reports null and the unified trusted-user
      // elevation treats it as an empty users map (writes anyway).
      if (isStateNotFound(err)) return null;
      throw err;
    }
  }

  /** Have the bot actively leave a room (used by /pmctl rm). */
  async leaveRoom(roomId: string, reason?: string): Promise<void> {
    await this.client.leaveRoom(roomId, reason);
    this.deps.onLeftRoom(roomId);
  }

  /** The bot's own Matrix user ID (null if not connected). */
  getBotUserId(): string | null {
    return this.deps.getBotUserId() ?? null;
  }
}
