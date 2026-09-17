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
 * Version marker for the bundled avatar pool. Bump ONLY when the pool ships
 * a full restyle (v2 pixel → v3 candy bumped 1 → 2): while config lags behind
 * this marker, the startup identity heal re-brands every managed room once
 * (see ensureRoomAvatar), then books the marker and goes back to
 * fill-only. User-set avatars are kept again on every later start.
 *
 * 3 (0.1.48): the 0.1.47 migration under marker 2 shipped with a sender
 * guard that skipped rooms whose avatar a human had set — the intended
 * "update re-brands every room" promise silently missed those. The guard is
 * reverted; bumping the marker re-runs the unconditional rebrand once so
 * machines that booked 2 converge too (same art, idempotent re-upload).
 *
 * Transition note (spec #84): this single marker is scheduled to be replaced
 * by per-set version bookkeeping (agent/space/room) in this same release —
 * the config fields and the heal orchestration land with tickets #86/#87.
 * Until then this marker behaves exactly as in 0.1.48; existing deployments
 * that booked 3 keep their current room avatars until the per-set migration
 * lands.
 */
export const AVATAR_POOL_VERSION = 3;

/**
 * Version marker for the agent art set — the bot account's own profile
 * avatar, the first per-set marker of the #84 multi-set system. While
 * config.agentAvatarVersion lags behind, the startup heal sets the bot's
 * profile avatar unconditionally (whoever set the current image), then books
 * the marker only after success — same rebrand-then-book semantics as the
 * room avatars, but scoped to this one set. 1 (v4): the animal pool
 * repurposed as the agent set.
 */
export const AGENT_AVATAR_VERSION = 1;

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
