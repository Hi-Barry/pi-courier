import { describe, expect, it } from "vitest";
import {
  AVATAR_POOL_SIZE,
  isLegacySpaceName,
  managementAvatarFile,
  nameHash,
  pickPoolAvatarFile,
  poolAvatarSlot,
  readAvatarBundled,
  spaceDisplayName,
} from "../src/space-identity";

/**
 * Pure-function coverage for the room identity helpers (naming + avatar
 * picking, v5 first-free-slot dedup) plus a packaging guard: the bundled
 * avatar pool must be complete and valid, or every startup identity heal
 * would warn forever.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("space identity", () => {
  it("names the space `π <instance>`", () => {
    expect(spaceDisplayName("home-picourier")).toBe("π home-picourier");
  });

  it("detects only the exact legacy template (user names are never touched)", () => {
    expect(isLegacySpaceName("pi-courier · home-picourier", "home-picourier")).toBe(true);
    expect(isLegacySpaceName("π home-picourier", "home-picourier")).toBe(false);
    expect(isLegacySpaceName("我的小窝", "home-picourier")).toBe(false);
    expect(isLegacySpaceName("pi-courier · other", "home-picourier")).toBe(false);
  });

  it("hashes a name stably (u32 djb2)", () => {
    expect(nameHash("box1")).toBe(nameHash("box1"));
    expect(nameHash("box1")).not.toBe(nameHash("box2"));
    expect(nameHash("box1")).toBeLessThanOrEqual(0xffffffff);
  });

  it("picks a stable, in-range pool image per name for each art set", () => {
    for (const set of ["agent", "space", "room"] as const) {
      for (const name of ["box1", "home-picourier", "工作机", "π"]) {
        const file = pickPoolAvatarFile(name, set);
        expect(file).toBe(pickPoolAvatarFile(name, set));
        expect(file).toMatch(new RegExp(`^${set}-\\d{2}\\.png$`));
        expect(poolAvatarSlot(file)).toBeGreaterThanOrEqual(0);
        expect(poolAvatarSlot(file)).toBeLessThan(AVATAR_POOL_SIZE);
        expect(poolAvatarSlot(file)).toBe(nameHash(name) % AVATAR_POOL_SIZE);
      }
    }
    // A space and a project room with the same name land on DIFFERENT sets, so
    // the two room kinds never share a face even when the names collide.
    expect(pickPoolAvatarFile("box1", "space")).not.toBe(pickPoolAvatarFile("box1", "room"));
  });

  it("skips occupied slots (first-free-slot) so siblings never share an image", () => {
    const own = nameHash("box1") % AVATAR_POOL_SIZE;
    const file = pickPoolAvatarFile("box1", "room", new Set([own]));
    expect(poolAvatarSlot(file)).toBe((own + 1) % AVATAR_POOL_SIZE);
    // A whole run of occupied slots is stepped over.
    const run = new Set([own, (own + 1) % AVATAR_POOL_SIZE, (own + 2) % AVATAR_POOL_SIZE]);
    expect(poolAvatarSlot(pickPoolAvatarFile("box1", "room", run))).toBe((own + 3) % AVATAR_POOL_SIZE);
    // Wraps around the end of the pool.
    const wrap = new Set<number>();
    for (let i = 0; i < AVATAR_POOL_SIZE - 1; i++) wrap.add((own + i) % AVATAR_POOL_SIZE);
    expect(poolAvatarSlot(pickPoolAvatarFile("box1", "room", wrap))).toBe((own + AVATAR_POOL_SIZE - 1) % AVATAR_POOL_SIZE);
    // A full pool falls back to the name's own bucket (never throws, never empty).
    const full = new Set(Array.from({ length: AVATAR_POOL_SIZE }, (_, i) => i));
    expect(pickPoolAvatarFile("box1", "room", full)).toBe(pickPoolAvatarFile("box1", "room"));
    // No occupancy → identical to the plain hash pick.
    expect(pickPoolAvatarFile("box1", "room", new Set())).toBe(pickPoolAvatarFile("box1", "room"));
  });

  it("dedicates a fixed image to the management room", () => {
    expect(managementAvatarFile()).toBe("room-management.png");
  });

  it("ships a complete, valid avatar pool across all three art sets", () => {
    const files = [
      ...(["agent", "space", "room"] as const).flatMap((set) =>
        Array.from({ length: AVATAR_POOL_SIZE }, (_, i) => `${set}-${String(i + 1).padStart(2, "0")}.png`),
      ),
      managementAvatarFile(),
    ];
    expect(files).toHaveLength(3 * AVATAR_POOL_SIZE + 1);
    expect(new Set(files).size).toBe(3 * AVATAR_POOL_SIZE + 1);
    for (const file of files) {
      const data = readAvatarBundled(file);
      expect(data.length).toBeGreaterThan(100);
      expect(data.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      // IHDR: width/height as big-endian u32 at bytes 16..24 must match what
      // avatarInfo() declares from the same bytes, or Element shows a
      // stretched avatar. Pool images ship at 256×256 (v5); the management
      // image predates v5 and stays 512×512.
      const expected = file === managementAvatarFile() ? 512 : 256;
      expect(data.readUInt32BE(16)).toBe(expected);
      expect(data.readUInt32BE(20)).toBe(expected);
    }
  });
});
