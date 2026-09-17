/**
 * Room identity: how pi-courier names and brands the rooms it manages.
 *
 * The space is named `π <instanceName>` (short; the old `pi-courier · <name>`
 * template is migrated on startup — see isLegacySpaceName). Every managed room
 * also gets a bundled avatar from one of three art sets in assets/avatars/
 * (original AI-generated artwork, soft candy / marshmallow style, scripts/
 * generate-avatars-v4.mjs): spaces pick from the cool-pastel landscape set by
 * instanceName hash, project rooms from the warm cottage set by project name
 * hash (so a space and a room are telling apart at a glance), and the bot
 * account's own profile avatar (the agent's face) picks from the animal set —
 * each deployment lands on a stable image (recreates and restarts keep it)
 * while different instances/projects usually differ. The management room uses
 * the dedicated room-management.png from the cottage set. All artwork is
 * original AI-generated, no third-party assets; users can swap any PNG for
 * their own (same filename) without touching code.
 */

import { readFileSync } from "node:fs";

/** Number of images in each art-set pool (`<set>-01 … <set>-12`). */
export const AVATAR_POOL_SIZE = 12;

/** The three bundled art sets: agent = the bot account's own face (animal
 *  pool), space = landscape pool for Matrix spaces, room = cottage pool for
 *  project rooms. Filenames are `<set>-<NN>.png` (+ room-management.png). */
export type AvatarSet = "agent" | "space" | "room";

/** Display name for the space: short instance label with a π brand prefix. */
export function spaceDisplayName(instanceName: string): string {
  return `π ${instanceName}`;
}

/** The pre-rename template. Only an EXACT match is ever renamed, so a name a
 *  user typed themselves is never clobbered by the startup self-heal. */
export function isLegacySpaceName(name: string, instanceName: string): boolean {
  return name === `pi-courier · ${instanceName}`;
}

/** djb2 over the UTF-8 bytes — tiny, stable across processes and runtimes
 *  (plain u32 arithmetic, no locale/crypto dependence). */
export function nameHash(name: string): number {
  let hash = 5381;
  for (const byte of Buffer.from(name, "utf8")) hash = (hash * 33 + byte) >>> 0;
  return hash;
}

/** Pick a pool filename from a set for a name: same name → same image, forever. */
export function pickPoolAvatarFile(name: string, set: AvatarSet): string {
  const index = (nameHash(name) % AVATAR_POOL_SIZE) + 1;
  return `${set}-${String(index).padStart(2, "0")}.png`;
}

/** The management room's dedicated image (always the same, always one of a kind). */
export function managementAvatarFile(): string {
  return "room-management.png";
}

/**
 * Per-set version markers of the bundled art (the #84 multi-set system):
 * bump a set's entry ONLY when that set ships a full restyle. While a
 * deployment's booking for a set (config.`<set>AvatarVersion`, read through
 * bookedAvatarVersion) lags behind the marker, the startup heal re-brands
 * that set's scope once — the managed rooms for space/room, the bot's
 * profile avatar for agent — then books the marker and goes back to
 * fill-only. Each set migrates independently: one set failing keeps only
 * that set pending.
 *
 * 1 (v4): first per-set markers — the landscape set for spaces, the cottage
 * set for rooms (management included), the animal pool as the agent set.
 * Replaces the pre-#84 single AVATAR_POOL_VERSION marker (last value 3, the
 * candy pool): that field is no longer read — a v3 deployment migrates all
 * three sets exactly once on first v4 start, same art-to-art rebrand as any
 * restyle.
 */
export const AVATAR_SET_VERSION: Record<AvatarSet, number> = { agent: 1, space: 1, room: 1 };

/** A deployment's booked version for an art set; 0 = never migrated (the
 *  field is absent — see the `<set>AvatarVersion` config fields). */
export function bookedAvatarVersion(
  cfg: { agentAvatarVersion?: number; spaceAvatarVersion?: number; roomAvatarVersion?: number },
  set: AvatarSet,
): number {
  switch (set) {
    case "agent":
      return cfg.agentAvatarVersion ?? 0;
    case "space":
      return cfg.spaceAvatarVersion ?? 0;
    case "room":
      return cfg.roomAvatarVersion ?? 0;
  }
}

/** Read a bundled avatar PNG. Throws if the asset is missing — callers treat
 *  that like any other identity-heal failure (warn + retry next start). */
export function readAvatarBundled(file: string): Buffer {
  return readFileSync(avatarAssetUrl(file));
}

function avatarAssetUrl(file: string): URL {
  // src/space-identity.ts and dist/space-identity.js both sit one level below
  // the package root, so ../assets resolves in the repo and in the npm tarball.
  if (!/^[\w.-]+\.png$/.test(file)) throw new Error(`非法的头像文件名: ${file}`);
  return new URL(`../assets/avatars/${file}`, import.meta.url);
}

/** m.room.avatar `info` sub-block describing the bundled 512×512 PNGs. */
export function avatarInfo(data: Buffer): Record<string, unknown> {
  return { mimetype: "image/png", width: 512, height: 512, size: data.length };
}
