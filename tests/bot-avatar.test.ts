import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoomOps } from "../src/transports/interface";
import { AVATAR_POOL_SIZE, pickPoolAvatarFile, readAvatarBundled } from "../src/space-identity";

/**
 * Tests for the bot profile avatar self-heal (spec #84 ticket 2). The Matrix
 * transport is faked at the RoomOps seam; the store is a real ConfigStore
 * isolated to a temp home via the doMock(os) pattern. The heal is driven
 * directly (highest existing seam) — the startup wiring is a one-line call.
 *
 * Semantics under test (只补缺 + 迁移期无条件刷 + 成功才记账):
 * - missing bot avatar + unbooked → set the agent-set pick, book the marker
 * - existing avatar + booked → untouched (manual faces are kept)
 * - existing avatar + unbooked (fresh upgrade) → rebrand unconditionally
 * - any failure → warn, stay pending (no booking), retry next start
 * - runs regardless of space mode (degraded deployments get a face too)
 */
describe("bot profile avatar heal", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-bot-avatar-"));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importModules() {
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpDir };
    });
    const config = await import("../src/config");
    const space = await import("../src/space");
    return { config, space };
  }

  function baseConfig() {
    return {
      multiProject: true,
      space: { enabled: true },
      matrix: { homeserverUrl: "https://matrix.example", accessToken: "tok" },
      auth: {
        trustedUsers: ["matrix:@barry:server"],
        adminUserId: "matrix:@barry:server",
      },
      instanceName: "box1",
      workdir: "/home/you/Projects",
      managementRooms: [] as string[],
    };
  }

  function makeRoomOps(overrides: Record<string, unknown> = {}) {
    return {
      getProfileAvatarUrl: vi.fn().mockResolvedValue(null),
      setProfileAvatar: vi.fn().mockResolvedValue(undefined),
      uploadMedia: vi.fn().mockResolvedValue("mxc://server/avatar"),
      ...overrides,
    };
  }

  async function runHeal(
    configOverrides: Record<string, unknown> = {},
    roomOpsOverrides: Record<string, unknown> = {},
  ) {
    const { config, space } = await importModules();
    const store = new config.ConfigStore({ ...baseConfig(), ...configOverrides });
    const roomOps = makeRoomOps(roomOpsOverrides);
    await space.healBotAvatar(roomOps as unknown as RoomOps, store);
    return { store, roomOps };
  }

  it("sets the agent-set avatar for a faceless bot and books the marker", async () => {
    const { store, roomOps } = await runHeal();
    const expected = pickPoolAvatarFile("box1", "agent");
    expect(roomOps.uploadMedia).toHaveBeenCalledWith(readAvatarBundled(expected), "image/png");
    expect(roomOps.setProfileAvatar).toHaveBeenCalledWith("mxc://server/avatar");
    expect(store.get().agentAvatarVersion).toBe(1);
  });

  it("keeps an existing bot avatar once the marker is booked (只补缺)", async () => {
    const { store, roomOps } = await runHeal(
      { agentAvatarVersion: 1 },
      { getProfileAvatarUrl: vi.fn().mockResolvedValue("mxc://server/custom-face") },
    );
    expect(roomOps.uploadMedia).not.toHaveBeenCalled();
    expect(roomOps.setProfileAvatar).not.toHaveBeenCalled();
    expect(store.get().agentAvatarVersion).toBe(1);
  });

  it("rebrands an existing bot avatar while the agent migration is pending", async () => {
    const { store, roomOps } = await runHeal(
      {},
      { getProfileAvatarUrl: vi.fn().mockResolvedValue("mxc://server/someone-elses-choice") },
    );
    expect(roomOps.setProfileAvatar).toHaveBeenCalledWith("mxc://server/avatar");
    expect(store.get().agentAvatarVersion).toBe(1);
  });

  it("does not book the marker when the set fails (retry next start)", async () => {
    const { store, roomOps } = await runHeal(
      {},
      { setProfileAvatar: vi.fn().mockRejectedValue(new Error("M_LIMITED: rate limited")) },
    );
    expect(roomOps.uploadMedia).toHaveBeenCalled();
    expect(store.get().agentAvatarVersion).toBeUndefined();
  });

  it("does not book the marker when the profile read fails", async () => {
    const { store, roomOps } = await runHeal(
      {},
      { getProfileAvatarUrl: vi.fn().mockRejectedValue(new Error("network down")) },
    );
    expect(roomOps.setProfileAvatar).not.toHaveBeenCalled();
    expect(store.get().agentAvatarVersion).toBeUndefined();
  });

  it("runs in non-space (degraded classic) mode too", async () => {
    const { store, roomOps } = await runHeal({ space: { enabled: false }, multiProject: false });
    expect(roomOps.setProfileAvatar).toHaveBeenCalledWith("mxc://server/avatar");
    expect(store.get().agentAvatarVersion).toBe(1);
  });

  it("never picks outside the agent pool (hash lands within 1..12)", () => {
    const file = pickPoolAvatarFile("box1", "agent");
    expect(file).toMatch(/^agent-\d{2}\.png$/);
    const index = Number.parseInt(file.slice("agent-".length, "agent-".length + 2), 10);
    expect(index).toBeGreaterThanOrEqual(1);
    expect(index).toBeLessThanOrEqual(AVATAR_POOL_SIZE);
  });
});
