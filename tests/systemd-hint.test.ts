import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busFailureHint, dirOwnerUid } from "../src/systemd-hint";

describe("busFailureHint (issue #59 — the `su` without `-` trap)", () => {
  it("hints when XDG_RUNTIME_DIR is owned by another user (EPERM-corroborated)", () => {
    const hint = busFailureHint({
      euid: 1005,
      xdgRuntimeDir: "/run/user/1000",
      xdgOwnerUid: 1000,
      stderr: "Failed to connect to user scope bus via local transport: Operation not permitted",
    });
    expect(hint).toBeTruthy();
    expect(hint).toContain("/run/user/1000");
    expect(hint).toContain("uid 1000");
    expect(hint).toContain("uid 1005");
    expect(hint).toContain("export XDG_RUNTIME_DIR=");
    expect(hint).toContain("su -");
  });

  it("hints from the stderr signature alone when the owner is unresolvable", () => {
    const stderr =
      "Failed to connect to user scope bus via local transport: Operation not permitted (consider using --machine=<user>@.host --user to connect to bus of other user)";
    const hint = busFailureHint({ euid: 1005, xdgRuntimeDir: undefined, xdgOwnerUid: null, stderr });
    expect(hint).toBeTruthy();
    expect(hint).toContain("export XDG_RUNTIME_DIR=");
  });

  it("hints from the stderr signature when XDG_RUNTIME_DIR is unset (no false ownership claim)", () => {
    const stderr = "Failed to connect to user scope bus via local transport: Operation not permitted";
    const hint = busFailureHint({ euid: 1005, xdgOwnerUid: null, stderr });
    expect(hint).toBeTruthy();
    expect(hint).toContain("export XDG_RUNTIME_DIR=");
    // The unset case must not claim "points at another user" — it usually
    // means no usable session at all.
    expect(hint).not.toContain("指向其他用户");
  });

  it("returns null when nothing points at the bus-owner trap", () => {
    expect(busFailureHint({ euid: 1005, xdgRuntimeDir: "/run/user/1005", xdgOwnerUid: 1005 })).toBeNull();
    expect(busFailureHint({ euid: 1005, xdgOwnerUid: null, stderr: "Unit pi-courier.service not found." })).toBeNull();
    expect(busFailureHint({ euid: 1005, xdgOwnerUid: null })).toBeNull();
  });

  it("owner mismatch alone does not hint without an EPERM-shaped stderr (issue #59 acceptance)", () => {
    // Wrong-owner XDG but a failure that is clearly NOT the bus trap: the
    // hint must stay silent so unrelated errors don't get a misleading tip.
    expect(
      busFailureHint({
        euid: 1005,
        xdgRuntimeDir: "/run/user/1000",
        xdgOwnerUid: 1000,
        stderr: "Unit pi-courier.service not found.",
      })
    ).toBeNull();
    // With an EPERM-shaped stderr the trap is corroborated and the hint shows.
    expect(
      busFailureHint({
        euid: 1005,
        xdgRuntimeDir: "/run/user/1000",
        xdgOwnerUid: 1000,
        stderr: "Failed to connect to user scope bus via local transport: Operation not permitted",
      })
    ).toBeTruthy();
  });

  it("matches the real-world stderr verbatim (2026-09-06 deployment incident)", () => {
    const stderr =
      "Failed to connect to user scope bus via local transport: Operation not permitted (consider using --machine=<user>@.host --user to connect to bus of other user)";
    expect(busFailureHint({ euid: 1005, xdgRuntimeDir: "/run/user/1000", xdgOwnerUid: 1000, stderr })).toBeTruthy();
  });
});

describe("dirOwnerUid", () => {
  it("resolves the owning uid of an existing directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-courier-hint-"));
    try {
      expect(dirOwnerUid(dir)).toBe(typeof process.getuid === "function" ? process.getuid() : -1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a missing directory or undefined input", () => {
    expect(dirOwnerUid("/run/user/does-not-exist-12345")).toBeNull();
    expect(dirOwnerUid(undefined)).toBeNull();
  });
});
