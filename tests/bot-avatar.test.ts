import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoomOps } from "../src/transports/interface";
import { AVATAR_POOL_SIZE, AVATAR_SET_VERSION, pickPoolAvatarFile, readAvatarBundled } from "../src/space-identity";

/**
 * Tests for the bot profile avatar self-heal (spec #84 ticket 2 + v5
 * override). The Matrix transport is faked at the RoomOps seam; the store is
 * a real ConfigStore isolated to a temp home via the doMock(os) pattern. The
 * heal is driven directly (highest existing seam) — the startup wiring is a
 * one-line call.
 *
 * Semantics under test (只补缺 + 迁移期无条件刷 + 成功才记账 + v5 自定义期望状态):
 * - missing bot avatar + unbooked → set the agent-set pick, book the marker
 * - existing avatar + booked → untouched (manual faces are kept)
 * - existing avatar + unbooked (fresh upgrade) → rebrand unconditionally
 * - any failure → warn, stay pending (no booking), retry next start
 * - runs regardless of space mode (degraded deployments get a face too)
 * - botAvatar configured → desired state: keep while sha256+profile URL match
 *   the booked ref, re-upload on drift, book nothing for the agent set while
 *   the override is in effect, fall back to the pool when the file is broken
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
    const space = await import("../src/space-topology");
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
    await (await import("../src/room-branding")).healBotAvatar(roomOps as unknown as RoomOps, store);
    return { store, roomOps };
  }

  function customFaceFile(name = "face.png"): string {
    const file = join(tmpDir, name);
    writeFileSync(file, readAvatarBundled("agent-02.png"));
    return file;
  }

  function shaOf(): string {
    return createHash("sha256").update(readAvatarBundled("agent-02.png")).digest("hex");
  }

  it("sets the agent-set avatar for a faceless bot and books the marker", async () => {
    const { store, roomOps } = await runHeal();
    const expected = pickPoolAvatarFile("box1", "agent");
    // Buffer.equals (memcmp-fast) instead of toHaveBeenCalledWith's deep
    // equality: the latter walks a full PNG byte-by-byte (slow, flaky under
    // load). Same assertion, same pinned bytes.
    const upload = roomOps.uploadMedia as ReturnType<typeof vi.fn>;
    expect(upload.mock.calls[0]?.[1]).toBe("image/png");
    expect(upload.mock.calls[0]?.[0]).toBeInstanceOf(Buffer);
    expect((upload.mock.calls[0]?.[0] as Buffer).equals(readAvatarBundled(expected))).toBe(true);
    expect(roomOps.setProfileAvatar).toHaveBeenCalledWith("mxc://server/avatar");
    expect(store.get().agentAvatarVersion).toBe(AVATAR_SET_VERSION.agent);
  });

  it("keeps an existing bot avatar once the marker is booked (只补缺)", async () => {
    const { store, roomOps } = await runHeal(
      { agentAvatarVersion: AVATAR_SET_VERSION.agent },
      { getProfileAvatarUrl: vi.fn().mockResolvedValue("mxc://server/custom-face") },
    );
    expect(roomOps.uploadMedia).not.toHaveBeenCalled();
    expect(roomOps.setProfileAvatar).not.toHaveBeenCalled();
    expect(store.get().agentAvatarVersion).toBe(AVATAR_SET_VERSION.agent);
  });

  it("rebrands an existing bot avatar while the agent migration is pending", async () => {
    const { store, roomOps } = await runHeal(
      {},
      { getProfileAvatarUrl: vi.fn().mockResolvedValue("mxc://server/someone-elses-choice") },
    );
    expect(roomOps.setProfileAvatar).toHaveBeenCalledWith("mxc://server/avatar");
    expect(store.get().agentAvatarVersion).toBe(AVATAR_SET_VERSION.agent);
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
    expect(store.get().agentAvatarVersion).toBe(AVATAR_SET_VERSION.agent);
  });

  it("never picks outside the agent pool", () => {
    const file = pickPoolAvatarFile("box1", "agent");
    expect(file).toMatch(/^agent-\d{2}\.png$/);
    const index = Number.parseInt(file.slice("agent-".length, "agent-".length + 2), 10);
    expect(index).toBeGreaterThanOrEqual(1);
    expect(index).toBeLessThanOrEqual(AVATAR_POOL_SIZE);
  });

  describe("botAvatar custom override (v5 desired state)", () => {
    it("uploads the custom face, books the ref and leaves the agent set pending", async () => {
      const file = customFaceFile();
      const { store, roomOps } = await runHeal({ botAvatar: file });
      expect(roomOps.uploadMedia).toHaveBeenCalledTimes(1);
      expect((roomOps.uploadMedia as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe("image/png");
      expect(roomOps.setProfileAvatar).toHaveBeenCalledWith("mxc://server/avatar");
      expect(store.get().botAvatarRef).toEqual({ sha256: shaOf(), mxc: "mxc://server/avatar" });
      // While the override is in effect the bundled agent migration stays
      // pending — removing the override rebrands once from the pool.
      expect(store.get().agentAvatarVersion).toBeUndefined();
    });

    it("keeps the custom face while the ref matches (no re-upload)", async () => {
      const file = customFaceFile();
      const { store, roomOps } = await runHeal(
        { botAvatar: file, botAvatarRef: { sha256: shaOf(), mxc: "mxc://server/avatar" } },
        { getProfileAvatarUrl: vi.fn().mockResolvedValue("mxc://server/avatar") },
      );
      expect(roomOps.uploadMedia).not.toHaveBeenCalled();
      expect(roomOps.setProfileAvatar).not.toHaveBeenCalled();
      expect(store.get().botAvatarRef?.mxc).toBe("mxc://server/avatar");
    });

    it("re-uploads when the file content drifts (sha256 mismatch)", async () => {
      const file = customFaceFile();
      const { store, roomOps } = await runHeal(
        { botAvatar: file, botAvatarRef: { sha256: "stale", mxc: "mxc://server/old" } },
        { getProfileAvatarUrl: vi.fn().mockResolvedValue("mxc://server/old") },
      );
      expect(roomOps.uploadMedia).toHaveBeenCalledTimes(1);
      expect(store.get().botAvatarRef).toEqual({ sha256: shaOf(), mxc: "mxc://server/avatar" });
    });

    it("re-uploads when the profile avatar was changed behind our back", async () => {
      const file = customFaceFile();
      const { store, roomOps } = await runHeal(
        { botAvatar: file, botAvatarRef: { sha256: shaOf(), mxc: "mxc://server/avatar" } },
        { getProfileAvatarUrl: vi.fn().mockResolvedValue("mxc://server/someone-elses") },
      );
      expect(roomOps.uploadMedia).toHaveBeenCalledTimes(1);
      expect(roomOps.setProfileAvatar).toHaveBeenCalledWith("mxc://server/avatar");
      expect(store.get().botAvatarRef?.mxc).toBe("mxc://server/avatar");
    });

    it("falls back to the bundled pool (fill-only) when the file is missing", async () => {
      const { store, roomOps } = await runHeal(
        { botAvatar: join(tmpDir, "gone.png"), agentAvatarVersion: AVATAR_SET_VERSION.agent },
        { getProfileAvatarUrl: vi.fn().mockResolvedValue("mxc://server/existing") },
      );
      expect(roomOps.uploadMedia).not.toHaveBeenCalled();
      expect(roomOps.setProfileAvatar).not.toHaveBeenCalled();
      expect(store.get().botAvatarRef).toBeUndefined();
      expect(store.get().agentAvatarVersion).toBe(AVATAR_SET_VERSION.agent);
    });

    it("falls back to the bundled pool and rebrands when the extension is unsupported", async () => {
      const file = join(tmpDir, "face.txt");
      writeFileSync(file, "not an image");
      const { store, roomOps } = await runHeal(
        { botAvatar: file },
        { getProfileAvatarUrl: vi.fn().mockResolvedValue("mxc://server/someone-elses-choice") },
      );
      const expected = pickPoolAvatarFile("box1", "agent");
      const upload = roomOps.uploadMedia as ReturnType<typeof vi.fn>;
      expect((upload.mock.calls[0]?.[0] as Buffer).equals(readAvatarBundled(expected))).toBe(true);
      expect(store.get().agentAvatarVersion).toBe(AVATAR_SET_VERSION.agent);
    });
  });
});
