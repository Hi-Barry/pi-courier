import { describe, expect, it } from "vitest";
import {
  AVATAR_POOL_SIZE,
  isLegacySpaceName,
  managementAvatarFile,
  nameHash,
  pickPoolAvatarFile,
  readAvatarBundled,
  spaceDisplayName,
} from "../src/space-identity";

/**
 * Pure-function coverage for the room identity helpers (naming + avatar
 * picking) plus a packaging guard: the bundled avatar pool must be complete
 * and valid, or every startup identity heal would warn forever.
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
        const index = Number.parseInt(file.slice(set.length + 1, set.length + 3), 10);
        expect(index).toBeGreaterThanOrEqual(1);
        expect(index).toBeLessThanOrEqual(AVATAR_POOL_SIZE);
      }
    }
    // A space and a project room with the same name land on DIFFERENT sets, so
    // the two room kinds never share a face even when the names collide.
    expect(pickPoolAvatarFile("box1", "space")).not.toBe(pickPoolAvatarFile("box1", "room"));
  });

  it("dedicates a fixed image to the management room", () => {
    expect(managementAvatarFile()).toBe("room-management.png");
  });

  it("ships a complete, valid 512×512 avatar pool across all three art sets", () => {
    const files = [
      ...(["agent", "space", "room"] as const).flatMap((set) =>
        Array.from({ length: AVATAR_POOL_SIZE }, (_, i) => `${set}-${String(i + 1).padStart(2, "0")}.png`),
      ),
      managementAvatarFile(),
    ];
    expect(files).toHaveLength(37);
    expect(new Set(files).size).toBe(37);
    for (const file of files) {
      const data = readAvatarBundled(file);
      expect(data.length).toBeGreaterThan(100);
      expect(data.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      // IHDR: width/height as big-endian u32 at bytes 16..24 must both be 512
      // — the code declares 512×512 in m.room.avatar info, so the assets have
      // to match or Element shows a stretched avatar.
      expect(data.readUInt32BE(16)).toBe(512);
      expect(data.readUInt32BE(20)).toBe(512);
    }
  });
});
