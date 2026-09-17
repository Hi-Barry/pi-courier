import type { ExternalMessage } from "../types.js";

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
 * encryptionAvailable, getPowerLevels, getRoomName, getRoomAvatar), which
 * legitimately report a
 * not-yet-connected or unavailable/not-present capability instead of
 * throwing.
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
  /** Invite a user into a room (space membership for newly trusted users). */
  inviteUser(roomId: string, userId: string): Promise<void>;
  /** Rename a room. */
  setRoomName(roomId: string, name: string): Promise<void>;
  /** Read a room's display name (m.room.name content), or null when the room
   *  has no (visible) name — 404 / M_NOT_FOUND. Query member: reports absence
   *  instead of throwing (same contract as getPowerLevels). */
  getRoomName(roomId: string): Promise<string | null>;
  /** Read a room's avatar mxc URL (m.room.avatar content url), or null when
   *  unset/not visible — 404 / M_NOT_FOUND. Query member: same contract. */
  getRoomAvatar(roomId: string): Promise<string | null>;
  /** Set a room's avatar (m.room.avatar) from an already-uploaded mxc URL. */
  setRoomAvatar(roomId: string, avatarUrl: string, info?: Record<string, unknown>): Promise<void>;
  /** Read the bot account's own profile avatar mxc URL, or null when unset —
   *  account-level profile data, not room state; null follows the same
   *  query-member contract as the room reads. */
  getProfileAvatarUrl(): Promise<string | null>;
  /** Set the bot account's own profile avatar from an already-uploaded mxc
   *  URL (profile avatar_url — one face for the whole account). */
  setProfileAvatar(avatarUrl: string): Promise<void>;
  /** Upload media to the content repository; returns the mxc:// URL. */
  uploadMedia(data: Buffer, contentType: string): Promise<string>;
  /** The bot's own user ID (null if not connected). */
  getBotUserId(): string | null;
  /** Whether E2EE is truly usable in this process (the config switch may be
   *  on while the Rust crypto stack failed to load — rooms must not be
   *  marked encrypted in that case). */
  readonly encryptionAvailable: boolean;
  /** Set a user's power level in a room (project owner -> admin; since #42
   *  also the trusted-user admin rule). */
  setUserPowerLevel(roomId: string, userId: string, level: number): Promise<void>;
  /** Read a room's power-level state (m.room.power_levels content), or null
   *  when the room has no (visible) such state — 404 / M_NOT_FOUND. Like the
   *  other query members this reports absence instead of throwing; the
   *  trusted-user elevation treats null as an empty users map and writes
   *  anyway. */
  getPowerLevels(roomId: string): Promise<Record<string, unknown> | null>;
  /** Have the bot actively leave a room. */
  leaveRoom(roomId: string, reason?: string): Promise<void>;
}
