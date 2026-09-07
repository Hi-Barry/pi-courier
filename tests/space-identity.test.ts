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

  it("picks a stable, in-range pool image per name", () => {
    for (const name of ["box1", "home-picourier", "工作机", "π"]) {
      const file = pickPoolAvatarFile(name);
      expect(file).toBe(pickPoolAvatarFile(name));
      expect(file).toMatch(/^instance-\d{2}\.png$/);
      const index = Number.parseInt(file.slice(9, 11), 10);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(AVATAR_POOL_SIZE);
    }
  });

  it("dedicates a fixed image to the management room", () => {
    expect(managementAvatarFile()).toBe("management.png");
  });

  it("ships a complete, valid avatar pool", () => {
    const files = [
      ...Array.from({ length: AVATAR_POOL_SIZE }, (_, i) => `instance-${String(i + 1).padStart(2, "0")}.png`),
      managementAvatarFile(),
    ];
    for (const file of files) {
      const data = readAvatarBundled(file);
      expect(data.length).toBeGreaterThan(100);
      expect(data.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    }
  });
});
