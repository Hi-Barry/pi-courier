/**
 * Auto-join resilience (issue #110): an invite the bot can't accept must
 * degrade to a warn log, never an unhandled rejection. The SDK's own
 * AutojoinRoomsMixin returns the joinRoom promise from its listener and
 * EventEmitter drops listener return values, so a single bad invite
 * (remote room without via servers, banned, gone) used to kill the
 * process. These tests pin the replacement best-effort handler.
 *
 * node:os is patched file-wide so the on-disk stores land in a temp home
 * instead of the developer's real ~/.pi.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.js";
import { createMatrixClient } from "../src/transports/matrix-client.js";

const home = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

describe("matrix auto-join resilience (issue #110)", () => {
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    home.dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier.autojoin-")),
    );
    fs.mkdirSync(path.join(home.dir, ".pi"), { recursive: true });
    warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home.dir, { recursive: true, force: true });
  });

  function makeClient() {
    return createMatrixClient({
      homeserverUrl: "http://localhost:8008",
      accessToken: "test-token",
      encryption: false,
    });
  }

  function emitInvite(client: unknown, roomId: string): void {
    // Second arg is the invite event the SDK's own DM-sync listener reads
    // (content?.is_direct); a minimal non-DM payload keeps it quiet.
    (client as { emit(event: string, ...args: unknown[]): boolean }).emit("room.invite", roomId, {
      content: {},
      sender: "@someone:example.org",
    });
  }

  /** Replace joinRoom on the real client (present on the SDK class, outside
   *  the port's structural surface) and return the mock for assertions. */
  function stubJoinRoom(client: unknown, mock: ReturnType<typeof vi.fn>): void {
    (client as { joinRoom: unknown }).joinRoom = mock;
  }

  it("a rejected joinRoom degrades to a warn — no unhandled rejection, process stays up", async () => {
    const client = makeClient();
    const joinRoom = vi
      .fn()
      .mockRejectedValue(new Error("M_UNKNOWN: Can't join remote room because no servers that are in the room have been provided."));
    stubJoinRoom(client, joinRoom);

    emitInvite(client, "!unjoinable:example.org");
    // Let the rejection propagate through the handler's catch before
    // asserting — an uncaught one would fail the whole test file.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(joinRoom).toHaveBeenCalledWith("!unjoinable:example.org");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-join failed"),
      "!unjoinable:example.org",
      expect.stringContaining("M_UNKNOWN"),
    );
  });

  it("a successful join logs nothing", async () => {
    const client = makeClient();
    const joinRoom = vi.fn().mockResolvedValue("!joined:example.org");
    stubJoinRoom(client, joinRoom);

    emitInvite(client, "!good:example.org");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(joinRoom).toHaveBeenCalledWith("!good:example.org");
    expect(warn).not.toHaveBeenCalled();
  });

  it("non-Error rejection values still land in the warn log", async () => {
    const client = makeClient();
    const joinRoom = vi.fn().mockRejectedValue("forbidden");
    stubJoinRoom(client, joinRoom);

    emitInvite(client, "!odd:example.org");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("auto-join failed"),
      "!odd:example.org",
      "forbidden",
    );
  });
});
