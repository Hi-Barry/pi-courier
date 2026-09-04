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
    // The dynamically imported graph holds its own logger instance — return
    // it so warn-spies observe the same object space.ts writes through.
    const loggerModule = await import("../src/logger");
    return { config, space, loggerModule };
  }

  function makeRoomOps(overrides: Record<string, unknown> = {}) {
    return {
      createRoom: vi.fn().mockResolvedValue("!mgmt:server"),
      createProjectRoom: vi.fn().mockResolvedValue("!proj:server"),
      createSpace: vi.fn().mockResolvedValue("!space:server"),
      addRoomToSpace: vi.fn().mockResolvedValue(undefined),
      inviteUser: vi.fn().mockResolvedValue(undefined),
      setRoomName: vi.fn().mockResolvedValue(undefined),
      setUserPowerLevel: vi.fn().mockResolvedValue(undefined),
      getPowerLevels: vi.fn().mockResolvedValue(null),
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

    // Creation invited every trusted user — all recorded, no re-invite later.
    expect(store.get().space?.invitedUsers).toEqual(["matrix:@barry:server", "matrix:@carol:server"]);
    expect(roomOps.inviteUser).not.toHaveBeenCalled();
  });

  it("self-heal invites trusted users missing from invitedUsers (recorded on success)", async () => {
    const { store, roomOps, result } = await runEnsure({
      space: {
        enabled: true,
        roomId: "!space:server",
        invitedUsers: ["matrix:@barry:server"],
        // Management bookkeeping already complete — this test targets the space pass.
        managementInvitedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
      },
      managementRooms: ["!mgmt:server"],
    });
    expect(result).toBe("ready");
    expect(roomOps.inviteUser).toHaveBeenCalledTimes(1);
    expect(roomOps.inviteUser).toHaveBeenCalledWith("!space:server", "@carol:server");
    expect(store.get().space?.invitedUsers).toEqual(["matrix:@barry:server", "matrix:@carol:server"]);
  });

  it("self-heal invite failure stays unrecorded and retries next start", async () => {
    const overrides = { inviteUser: vi.fn().mockRejectedValue(new Error("M_LIMIT_EXCEEDED")) };
    const first = await runEnsure(
      { space: { enabled: true, roomId: "!space:server", invitedUsers: ["matrix:@barry:server"] }, managementRooms: ["!mgmt:server"] },
      overrides
    );
    expect(first.result).toBe("ready");
    expect(first.store.get().space?.invitedUsers).toEqual(["matrix:@barry:server"]);
    // Next start (default stub) — the missing user is retried.
    const second = await runEnsure({
      space: { enabled: true, roomId: "!space:server", invitedUsers: ["matrix:@barry:server"] },
      managementRooms: ["!mgmt:server"],
    });
    expect(second.roomOps.inviteUser).toHaveBeenCalledWith("!space:server", "@carol:server");
    expect(second.store.get().space?.invitedUsers).toEqual(["matrix:@barry:server", "matrix:@carol:server"]);
  });

  it("self-heal is a no-op when everyone is already invited", async () => {
    const { roomOps } = await runEnsure({
      space: {
        enabled: true,
        roomId: "!space:server",
        invitedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
        managementInvitedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
      },
      managementRooms: ["!mgmt:server"],
    });
    expect(roomOps.inviteUser).not.toHaveBeenCalled();
  });

  it("users trusted while degraded are caught up when the space is finally created", async () => {
    // Degraded run: space creation fails, eve's challenge pass meanwhile
    // records her as trusted (config-level, no invite possible).
    const degraded = await runEnsure(
      { auth: { trustedUsers: ["matrix:@barry:server", "matrix:@eve:server"], adminUserId: "matrix:@barry:server" } },
      { createSpace: vi.fn().mockRejectedValue(new Error("M_UNRECOGNIZED")) }
    );
    expect(degraded.result).toBe("degraded");
    expect(degraded.roomOps.inviteUser).not.toHaveBeenCalled();
    // Next start: the space is created and its creation invite covers ALL
    // current trusted users (barry + eve) — the catch-up path from #20's AC.
    const created = await runEnsure(
      { auth: { trustedUsers: ["matrix:@barry:server", "matrix:@eve:server"], adminUserId: "matrix:@barry:server" } }
    );
    expect(created.result).toBe("ready");
    expect(created.roomOps.createSpace).toHaveBeenCalledWith({
      name: "pi-courier · box1",
      inviteUserIds: ["@barry:server", "@eve:server"],
    });
    expect(created.roomOps.inviteUser).not.toHaveBeenCalled(); // covered by creation
    expect(created.store.get().space?.invitedUsers).toEqual(["matrix:@barry:server", "matrix:@eve:server"]);
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

  // ---- trusted-user power self-heal (issue #42) ------------------------------
  // The unified elevation: every trusted user is admin (PL 100) in every
  // managed room, regardless of join state; a full sweep derives the room set
  // from config (space + management rooms + projects). RoomOps stays a pure
  // vi.fn() seam; the store writes into the tmpDir home.

  const fullRooms = {
    space: { enabled: true, roomId: "!space:server" },
    managementRooms: ["!mgmt:server"],
    projects: { "!proj:server": { workdir: "/w/p" } },
  };

  async function runHeal(configOverrides: Record<string, unknown> = {}, roomOpsOverrides: Record<string, unknown> = {}) {
    const { config, space } = await importModules();
    const store = new config.ConfigStore({ ...baseConfig(), ...configOverrides });
    const roomOps = makeRoomOps(roomOpsOverrides);
    await space.healTrustedPowerLevels(roomOps as unknown as RoomOps, store);
    return { store, roomOps };
  }

  it("elevates below-target trusted users to 100 across space, management and project rooms", async () => {
    const { store, roomOps } = await runHeal(fullRooms, {
      // barry is a member at 0; carol is absent (non-member) — written anyway.
      getPowerLevels: vi.fn().mockResolvedValue({ users: { "@barry:server": 0 } }),
    });
    for (const roomId of ["!space:server", "!mgmt:server", "!proj:server"]) {
      expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith(roomId, "@barry:server", 100);
      expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith(roomId, "@carol:server", 100);
    }
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledTimes(6);
    // Both were actually elevated — both are booked (namespaced ids).
    expect(store.get().powerElevatedUsers).toEqual(["matrix:@barry:server", "matrix:@carol:server"]);
  });

  it("is idempotent: users already at 100 produce no writes and no bookkeeping", async () => {
    const { store, roomOps } = await runHeal(fullRooms, {
      getPowerLevels: vi.fn().mockResolvedValue({ users: { "@barry:server": 100, "@carol:server": 100 } }),
    });
    expect(roomOps.setUserPowerLevel).not.toHaveBeenCalled();
    expect(store.get().powerElevatedUsers).toBeUndefined();
  });

  it("treats a missing power-level event (null) as an empty users map and writes everyone", async () => {
    const { roomOps } = await runHeal(
      { ...fullRooms, projects: {} },
      { getPowerLevels: vi.fn().mockResolvedValue(null) }
    );
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!space:server", "@barry:server", 100);
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!space:server", "@carol:server", 100);
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!mgmt:server", "@barry:server", 100);
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!mgmt:server", "@carol:server", 100);
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledTimes(4);
  });

  it("a single-room failure warns (with the roomId) and the sweep continues elsewhere", async () => {
    const { config, space, loggerModule } = await importModules();
    const warnSpy = vi.spyOn(loggerModule.logger, "warn");
    const store = new config.ConfigStore({
      ...baseConfig(),
      ...fullRooms,
      projects: {},
    });
    const roomOps = makeRoomOps({
      getPowerLevels: vi.fn().mockImplementation((roomId: string) =>
        roomId === "!mgmt:server"
          ? Promise.reject(new Error("M_LIMIT_EXCEEDED"))
          : Promise.resolve({ users: {} })
      ),
    });
    await space.healTrustedPowerLevels(roomOps as unknown as RoomOps, store);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("!mgmt:server"));
    // The other room in the sweep was still processed.
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!space:server", "@barry:server", 100);
    expect(roomOps.setUserPowerLevel).not.toHaveBeenCalledWith("!mgmt:server", expect.anything(), expect.anything());
  });

  it("bookkeeping records only actually-elevated users, deduped against prior entries", async () => {
    const { store } = await runHeal(
      { ...fullRooms, projects: {}, powerElevatedUsers: ["matrix:@carol:server"] },
      // carol already at 100 (must not be re-booked), barry gets elevated.
      { getPowerLevels: vi.fn().mockResolvedValue({ users: { "@carol:server": 100 } }) }
    );
    expect(store.get().powerElevatedUsers).toEqual(["matrix:@carol:server", "matrix:@barry:server"]);
  });

  it("a mid-loop write failure still books the users elevated before it", async () => {
    const { config, space, loggerModule } = await importModules();
    const warnSpy = vi.spyOn(loggerModule.logger, "warn");
    const store = new config.ConfigStore({ ...baseConfig(), ...fullRooms, projects: {} });
    const roomOps = makeRoomOps({
      getPowerLevels: vi.fn().mockResolvedValue({ users: {} }),
      // barry lands, carol throws — barry must still be booked.
      setUserPowerLevel: vi.fn().mockImplementation((roomId: string, userId: string) =>
        userId === "@carol:server" ? Promise.reject(new Error("M_LIMIT_EXCEEDED")) : Promise.resolve()
      ),
    });
    await space.healTrustedPowerLevels(roomOps as unknown as RoomOps, store);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("!space:server"));
    expect(store.get().powerElevatedUsers).toEqual(["matrix:@barry:server"]);
  });

  it("degraded mode (no space.roomId) still heals management rooms and projects", async () => {
    const { roomOps } = await runHeal(
      { space: undefined, managementRooms: ["!mgmt:server"], projects: { "!proj:server": { workdir: "/w/p" } } },
      { getPowerLevels: vi.fn().mockResolvedValue({ users: {} }) }
    );
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!mgmt:server", "@barry:server", 100);
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!mgmt:server", "@carol:server", 100);
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!proj:server", "@barry:server", 100);
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!proj:server", "@carol:server", 100);
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledTimes(4);
  });

  // ---- revoke demotion loop (issue #44) --------------------------------------
  // The symmetric closed loop: book-kept users who have since lost trust get
  // the granted power stripped (PL 0) in every managed room; the bookkeeping
  // is the sole authority — anyone outside it is never written a 0.

  it("demotes book-kept users who lost trust to 0 everywhere and clears the book", async () => {
    // eve was elevated once (booked) and has since been revoked; barry and
    // carol are still trusted and already at 100 (no elevation writes).
    const { store, roomOps } = await runHeal(
      {
        ...fullRooms,
        powerElevatedUsers: ["matrix:@barry:server", "matrix:@carol:server", "matrix:@eve:server"],
      },
      {
        getPowerLevels: vi.fn().mockResolvedValue({
          users: { "@barry:server": 100, "@carol:server": 100, "@eve:server": 100 },
        }),
      }
    );
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledTimes(3);
    for (const roomId of ["!space:server", "!mgmt:server", "!proj:server"]) {
      expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith(roomId, "@eve:server", 0);
    }
    // Only the revoked user left the books.
    expect(store.get().powerElevatedUsers).toEqual(["matrix:@barry:server", "matrix:@carol:server"]);
  });

  it("a partial demotion failure keeps the book entry, warns, and still strips the rooms that succeeded", async () => {
    const { config, space, loggerModule } = await importModules();
    const warnSpy = vi.spyOn(loggerModule.logger, "warn");
    const store = new config.ConfigStore({
      ...baseConfig(),
      ...fullRooms,
      powerElevatedUsers: ["matrix:@eve:server"],
    });
    const roomOps = makeRoomOps({
      // Everyone already at target level — the only writes are eve's demotion.
      getPowerLevels: vi.fn().mockResolvedValue({
        users: { "@barry:server": 100, "@carol:server": 100, "@eve:server": 100 },
      }),
      // The management room refuses; the other two go through.
      setUserPowerLevel: vi.fn().mockImplementation((roomId: string) =>
        roomId === "!mgmt:server" ? Promise.reject(new Error("M_FORBIDDEN")) : Promise.resolve()
      ),
    });
    await space.healTrustedPowerLevels(roomOps as unknown as RoomOps, store);
    // Successful rooms were stripped...
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!space:server", "@eve:server", 0);
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!proj:server", "@eve:server", 0);
    // ...the failed one warned with its roomId...
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("!mgmt:server"));
    // ...and the bookkeeping survives whole for the next-start retry (already-
    // demoted rooms are rewritten to 0 harmlessly — idempotent).
    expect(store.get().powerElevatedUsers).toEqual(["matrix:@eve:server"]);
  });

  it("high-power users outside the books (external admins, the bot itself) are never written a 0", async () => {
    const { roomOps } = await runHeal(fullRooms, {
      getPowerLevels: vi.fn().mockResolvedValue({
        users: {
          "@barry:server": 0, // trusted — elevated as usual
          "@carol:server": 0, // trusted — elevated as usual
          "@owner:server": 100, // external room owner: not trusted, not booked
          "@bot:server": 100, // the bot itself (room creator)
        },
      }),
    });
    expect(roomOps.setUserPowerLevel).toHaveBeenCalledWith("!space:server", "@barry:server", 100);
    // Every write in the sweep is an elevation: the demotion loop's authority
    // is the books, and neither the owner nor the bot is in them.
    for (const call of (roomOps.setUserPowerLevel as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]).not.toBe(0);
      expect(call[1]).not.toBe("@owner:server");
      expect(call[1]).not.toBe("@bot:server");
    }
  });

  it("books consistent with the trust set produce no demotion writes at all", async () => {
    const { store, roomOps } = await runHeal(
      { ...fullRooms, powerElevatedUsers: ["matrix:@barry:server", "matrix:@carol:server"] },
      { getPowerLevels: vi.fn().mockResolvedValue({ users: { "@barry:server": 100, "@carol:server": 100 } }) }
    );
    expect(roomOps.setUserPowerLevel).not.toHaveBeenCalled();
    expect(store.get().powerElevatedUsers).toEqual(["matrix:@barry:server", "matrix:@carol:server"]);
  });

  it("management-room creation records every trusted user in the management bookkeeping (issue #43)", async () => {
    const { store, roomOps, result } = await runEnsure();
    expect(result).toBe("ready");
    // createRoom's invite list covered everyone — recorded (namespaced), so
    // the self-heal never re-pings them (Matrix rejects re-invites).
    expect(store.get().space?.managementInvitedUsers).toEqual([
      "matrix:@barry:server",
      "matrix:@carol:server",
    ]);
    expect(roomOps.inviteUser).not.toHaveBeenCalled();
  });

  it("self-heal catches up trusted users missing from the management-room bookkeeping (issue #43)", async () => {
    const { store, roomOps, result } = await runEnsure({
      space: {
        enabled: true,
        roomId: "!space:server",
        invitedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
        managementInvitedUsers: ["matrix:@barry:server"],
      },
      managementRooms: ["!mgmt:server"],
    });
    expect(result).toBe("ready");
    // Native MXID over the wire, namespaced form in the bookkeeping.
    expect(roomOps.inviteUser).toHaveBeenCalledTimes(1);
    expect(roomOps.inviteUser).toHaveBeenCalledWith("!mgmt:server", "@carol:server");
    expect(store.get().space?.managementInvitedUsers).toEqual([
      "matrix:@barry:server",
      "matrix:@carol:server",
    ]);
  });

  it("management-room invite failure stays unrecorded and retries next start", async () => {
    // Space bookkeeping is complete: the only invites attempted are the
    // management-room ones, and both fail.
    const overrides = { inviteUser: vi.fn().mockRejectedValue(new Error("M_LIMIT_EXCEEDED")) };
    const first = await runEnsure(
      {
        space: {
          enabled: true,
          roomId: "!space:server",
          invitedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
        },
        managementRooms: ["!mgmt:server"],
      },
      overrides
    );
    expect(first.result).toBe("ready"); // best-effort — the run stays ready
    expect(first.store.get().space?.managementInvitedUsers).toBeUndefined();
    // Next start (default stub): the missing invites are retried.
    const second = await runEnsure({
      space: {
        enabled: true,
        roomId: "!space:server",
        invitedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
      },
      managementRooms: ["!mgmt:server"],
    });
    expect(second.roomOps.inviteUser).toHaveBeenCalledWith("!mgmt:server", "@barry:server");
    expect(second.roomOps.inviteUser).toHaveBeenCalledWith("!mgmt:server", "@carol:server");
    expect(second.store.get().space?.managementInvitedUsers).toEqual([
      "matrix:@barry:server",
      "matrix:@carol:server",
    ]);
  });

  it("management-room invite is a silent no-op in degraded mode (the adopted DM is never used to pull people in)", async () => {
    const { config, space } = await importModules();
    const store = new config.ConfigStore({
      multiProject: true,
      // Degraded: the space never materialized, but a DM was adopted as the
      // management room — trust spread must not reach into that DM.
      managementRooms: ["!dm:server"],
      auth: { trustedUsers: ["matrix:@carol:server"], adminUserId: "matrix:@carol:server" },
    });
    const roomOps = makeRoomOps();
    const invited = await space.inviteUserToManagementRoomOnce(
      roomOps as unknown as RoomOps,
      store,
      "matrix:@carol:server"
    );
    expect(invited).toBe(false);
    expect(roomOps.inviteUser).not.toHaveBeenCalled();
    expect(store.get().space?.managementInvitedUsers).toBeUndefined();
  });

  it("management-room invite is a no-op while the management room does not exist yet", async () => {
    const { config, space } = await importModules();
    const store = new config.ConfigStore({
      multiProject: true,
      space: { enabled: true, roomId: "!space:server" },
      managementRooms: [],
    });
    const roomOps = makeRoomOps();
    const invited = await space.inviteUserToManagementRoomOnce(
      roomOps as unknown as RoomOps,
      store,
      "matrix:@carol:server"
    );
    expect(invited).toBe(false);
    expect(roomOps.inviteUser).not.toHaveBeenCalled();
  });
});
