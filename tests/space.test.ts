import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoomOps } from "../src/transports/interface";

/**
 * Direct tests for the startup space ensure (issue #17). The Matrix transport
 * is faked at the RoomOps seam; the store is a real ConfigStore isolated to a
 * temp home via the config.test doMock(os) pattern — store.update() must
 * never touch the developer's real ~/.pi config.
 */
describe("space ensure", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-space-"));
    vi.resetModules();
  });

  afterEach(() => {
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

  function makeRoomOps(overrides: Record<string, unknown> = {}) {
    return {
      createRoom: vi.fn().mockResolvedValue("!mgmt:server"),
      createProjectRoom: vi.fn().mockResolvedValue("!proj:server"),
      createSpace: vi.fn().mockResolvedValue("!space:server"),
      addRoomToSpace: vi.fn().mockResolvedValue(undefined),
      setRoomName: vi.fn().mockResolvedValue(undefined),
      setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      getBotUserId: vi.fn().mockReturnValue("@bot:server"),
      encryptionAvailable: true,
      ...overrides,
    };
  }

  function baseConfig() {
    return {
      multiProject: true,
      space: { enabled: true },
      matrix: { homeserverUrl: "https://matrix.example", accessToken: "tok" },
      auth: {
        trustedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
        adminUserId: "matrix:@barry:server",
      },
      instanceName: "box1",
      workdir: "/home/you/Projects",
      managementRooms: [] as string[],
    };
  }

  async function runEnsure(configOverrides: Record<string, unknown> = {}, roomOpsOverrides: Record<string, unknown> = {}) {
    const { config, space } = await importModules();
    const store = new config.ConfigStore({ ...baseConfig(), ...configOverrides });
    const sendReply = vi.fn().mockResolvedValue(undefined);
    const roomOps = makeRoomOps(roomOpsOverrides);
    const result = await space.ensureSpaceAndManagementRoom({
      roomOps: roomOps as unknown as RoomOps,
      store,
      sendReply,
    });
    return { store, sendReply, roomOps, result };
  }

  it("skips in single-project mode", async () => {
    const { roomOps, result } = await runEnsure({ multiProject: false });
    expect(result).toBe("skipped");
    expect(roomOps.createSpace).not.toHaveBeenCalled();
    expect(roomOps.createRoom).not.toHaveBeenCalled();
  });

  it("skips when space is not enabled (incl. legacy config without the field)", async () => {
    for (const spaceCfg of [undefined, { enabled: false }]) {
      const { roomOps, store, result } = await runEnsure({ space: spaceCfg });
      expect(result).toBe("skipped");
      expect(roomOps.createSpace).not.toHaveBeenCalled();
      expect(store.get().space?.roomId).toBeUndefined();
    }
  });

  it("creates the space and the management room end to end, persisting both", async () => {
    const { store, sendReply, roomOps, result } = await runEnsure();
    expect(result).toBe("ready");

    // Space: private, named with the instance, invites use native MXIDs
    // (the "matrix:" namespace prefix is a config-storage concern only).
    expect(roomOps.createSpace).toHaveBeenCalledTimes(1);
    expect(roomOps.createSpace).toHaveBeenCalledWith({
      name: "pi-courier · box1",
      inviteUserIds: ["@barry:server", "@carol:server"],
    });
    expect(store.get().space?.roomId).toBe("!space:server");

    // Management room: E2EE per config switch, named like the router brands it.
    expect(roomOps.createRoom).toHaveBeenCalledTimes(1);
    expect(roomOps.createRoom).toHaveBeenCalledWith({
      name: "项目管理（box1）",
      inviteUserIds: ["@barry:server", "@carol:server"],
      encrypted: true,
    });
    expect(roomOps.addRoomToSpace).toHaveBeenCalledWith("!space:server", "!mgmt:server");

    // Usage guide is sent to the new room; the room is the management room.
    expect(sendReply).toHaveBeenCalledWith("!mgmt:server", "matrix", expect.stringContaining("项目管理房间"));
    expect(store.get().managementRooms).toEqual(["!mgmt:server"]);
  });

  it("creates an unencrypted management room when the config switch is off", async () => {
    const { roomOps } = await runEnsure({
      matrix: { homeserverUrl: "https://matrix.example", accessToken: "tok", encryption: false },
    });
    expect(roomOps.createRoom).toHaveBeenCalledWith(expect.objectContaining({ encrypted: false }));
  });

  it("falls back to unencrypted when the crypto stack failed to load", async () => {
    const { roomOps } = await runEnsure({}, { encryptionAvailable: false });
    expect(roomOps.createRoom).toHaveBeenCalledWith(expect.objectContaining({ encrypted: false }));
  });

  it("is idempotent when both the space and the management room already exist", async () => {
    const { store, sendReply, roomOps, result } = await runEnsure({
      space: { enabled: true, roomId: "!space:server" },
      managementRooms: ["!mgmt:server"],
    });
    expect(result).toBe("ready");
    expect(roomOps.createSpace).not.toHaveBeenCalled();
    expect(roomOps.createRoom).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
    // The link is (re-)asserted — idempotent state, no re-invites.
    expect(roomOps.addRoomToSpace).toHaveBeenCalledTimes(1);
    expect(roomOps.addRoomToSpace).toHaveBeenCalledWith("!space:server", "!mgmt:server");
    expect(store.get().space?.roomId).toBe("!space:server");
  });

  it("re-link failure is best-effort: the run stays ready and self-heals next start", async () => {
    const { store, result } = await runEnsure(
      {
        space: { enabled: true, roomId: "!space:server" },
        managementRooms: ["!mgmt:server"],
      },
      { addRoomToSpace: vi.fn().mockRejectedValue(new Error("power too low")) }
    );
    expect(result).toBe("ready");
    expect(store.get().managementRooms).toEqual(["!mgmt:server"]);
    // Next start (default stub) asserts the link again — the retry path.
    const { roomOps, result: result2 } = await runEnsure({
      space: { enabled: true, roomId: "!space:server" },
      managementRooms: ["!mgmt:server"],
    });
    expect(result2).toBe("ready");
    expect(roomOps.addRoomToSpace).toHaveBeenCalledWith("!space:server", "!mgmt:server");
  });

  it("self-heals the management room without recreating the space", async () => {
    const { store, roomOps, result } = await runEnsure({
      space: { enabled: true, roomId: "!space:server" },
    });
    expect(result).toBe("ready");
    expect(roomOps.createSpace).not.toHaveBeenCalled();
    expect(roomOps.createRoom).toHaveBeenCalledTimes(1);
    expect(roomOps.addRoomToSpace).toHaveBeenCalledWith("!space:server", "!mgmt:server");
    expect(store.get().managementRooms).toEqual(["!mgmt:server"]);
  });

  it("transition path: links an already-adopted management room into the new space instead of creating another", async () => {
    const { store, roomOps, result } = await runEnsure({
      managementRooms: ["!dm:server"],
    });
    expect(result).toBe("ready");
    expect(roomOps.createSpace).toHaveBeenCalledTimes(1);
    expect(roomOps.createRoom).not.toHaveBeenCalled();
    expect(roomOps.addRoomToSpace).toHaveBeenCalledWith("!space:server", "!dm:server");
    expect(store.get().managementRooms).toEqual(["!dm:server"]);
    expect(store.get().space?.roomId).toBe("!space:server");
  });

  it("degrades without persisting anything when space creation fails", async () => {
    const { store, roomOps, result } = await runEnsure(
      {},
      { createSpace: vi.fn().mockRejectedValue(new Error("M_UNSUPPORTED")) }
    );
    expect(result).toBe("degraded");
    expect(roomOps.createRoom).not.toHaveBeenCalled();
    expect(store.get().space?.roomId).toBeUndefined();
    expect(store.get().managementRooms).toEqual([]);
  });

  it("keeps the persisted space but degrades when management-room creation fails", async () => {
    const { store, result } = await runEnsure(
      {},
      { createRoom: vi.fn().mockRejectedValue(new Error("boom")) }
    );
    expect(result).toBe("degraded");
    expect(store.get().space?.roomId).toBe("!space:server");
    expect(store.get().managementRooms).toEqual([]);
  });

  it("treats space-linking failure as non-fatal: the management room still stands", async () => {
    const { store, sendReply, result } = await runEnsure(
      {},
      { addRoomToSpace: vi.fn().mockRejectedValue(new Error("power too low")) }
    );
    expect(result).toBe("ready");
    expect(sendReply).toHaveBeenCalled();
    expect(store.get().managementRooms).toEqual(["!mgmt:server"]);
    expect(store.get().space?.roomId).toBe("!space:server");
  });

  it("treats guide-delivery failure as non-fatal", async () => {
    const { config, space } = await importModules();
    const store = new config.ConfigStore(baseConfig());
    const roomOps = makeRoomOps();
    const result = await space.ensureSpaceAndManagementRoom({
      roomOps: roomOps as unknown as RoomOps,
      store,
      sendReply: vi.fn().mockRejectedValue(new Error("transport down")),
    });
    expect(result).toBe("ready");
    expect(store.get().managementRooms).toEqual(["!mgmt:server"]);
    expect(store.get().space?.roomId).toBe("!space:server");
  });
});
