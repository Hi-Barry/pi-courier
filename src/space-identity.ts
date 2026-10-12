/**
 * Room identity: how pi-courier names and brands the rooms it manages.
 *
 * The space is named `π <instanceName>` (short; the old `pi-courier · <name>`
 * template is migrated on startup — see isLegacySpaceName). Every managed room
 * also gets a bundled avatar from one of three art sets in assets/avatars/
 * (original AI-generated artwork, soft candy / marshmallow style, scripts/
 * generate-avatars-v5.mjs): spaces pick from the landscape set by
 * instanceName hash, project rooms from the architecture set by project name
 * hash (so a space and a room are telling apart at a glance), and the bot
 * account's own profile avatar (the agent's face) picks from the animal set —
 * each deployment lands on a stable image (recreates and restarts keep it)
 * while different instances/projects usually differ: every pool spreads 24
 * distinct subjects across 24 distinct dominant hues (the v5 hue wheel), and
 * project rooms additionally skip slots already taken by a sibling room in
 * the same space (first-free-slot, see pickPoolAvatarFile). The management
 * room uses the dedicated room-management.png from the architecture set. All
 * artwork is original AI-generated, no third-party assets; users can swap any
 * PNG for their own (same filename) without touching code.
 */

import { readFileSync } from "node:fs";
import { t } from "./i18n/index.js";

/** Number of images in each art-set pool (`<set>-01 … <set>-24`). */
export const AVATAR_POOL_SIZE = 24;

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

/** Pick a pool filename from a set for a name: same name → same image, forever.
 *  `occupied` (index numbers already taken in the same space) turns selection
 *  into a first-free-slot scan: start at the name's own bucket, step forward
 *  until an unoccupied slot is found, so two projects in one space never land
 *  on the same image. Fully deterministic given the occupied set; when every
 *  slot is occupied the name's own bucket is returned unchanged. */
export function pickPoolAvatarFile(
  name: string,
  set: AvatarSet,
  occupied?: ReadonlySet<number>,
): string {
  const own = nameHash(name) % AVATAR_POOL_SIZE;
  let index = own;
  if (occupied) {
    for (let steps = 0; steps < AVATAR_POOL_SIZE && occupied.has(index); steps++) {
      index = (index + 1) % AVATAR_POOL_SIZE;
    }
  }
  return `${set}-${String(index + 1).padStart(2, "0")}.png`;
}

/** The zero-based pool slot of a pool filename (`room-07.png` → 6) — the
 *  bookkeeping half of pickPoolAvatarFile's first-free-slot scan. */
export function poolAvatarSlot(file: string): number {
  return Number.parseInt(file.replace(/^\w+-/, ""), 10) - 1;
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
 * 2 (v5): full restyle of all three sets (scripts/generate-avatars-v5.mjs,
 * qwen-image-3.0-pro art): the pools grow from 12 to 24 images each, the
 * subjects diversify within a set (landscapes from aurora to galaxies,
 * architecture from cottages to pagodas and space pods, 24 animal faces) and
 * the dominant hues are spread across the color wheel, so coexisting
 * deployments and rooms stay visually apart. The bump re-brands every
 * deployment's three sets exactly once on first v5 start.
 */
export const AVATAR_SET_VERSION: Record<AvatarSet, number> = { agent: 2, space: 2, room: 2 };

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

/** The write twin of bookedAvatarVersion: the config patch that books a
 *  set's migration marker once its re-brand pass fully succeeded. Typed per
 *  set (no string-computed keys) so the store update stays fully checked. */
export function avatarVersionMarker(
  set: AvatarSet,
): { agentAvatarVersion: number } | { spaceAvatarVersion: number } | { roomAvatarVersion: number } {
  switch (set) {
    case "agent":
      return { agentAvatarVersion: AVATAR_SET_VERSION.agent };
    case "space":
      return { spaceAvatarVersion: AVATAR_SET_VERSION.space };
    case "room":
      return { roomAvatarVersion: AVATAR_SET_VERSION.room };
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
  if (!/^[\w.-]+\.png$/.test(file)) throw new Error(t("space.badAvatarFile", { file }));
  return new URL(`../assets/avatars/${file}`, import.meta.url);
}

/** m.room.avatar `info` sub-block. Width/height come from the PNG IHDR header
 *  when the data is a PNG (the bundled art: pool images are 256×256, the
 *  management image 512×512); for any other format the block carries only
 *  mimetype and size — Element scales avatars for display regardless. */
export function avatarInfo(data: Buffer, mimetype = "image/png"): Record<string, unknown> {
  const info: Record<string, unknown> = { mimetype, size: data.length };
  if (mimetype === "image/png" && data.length >= 24 && data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    info.width = data.readUInt32BE(16);
    info.height = data.readUInt32BE(20);
  }
  return info;
}
