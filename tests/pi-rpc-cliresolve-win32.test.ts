/**
 * resolveCliPath on win32 (evaluation 2026-10-13): Windows has no `which` —
 * spawning it fails with ENOENT every time — so discovery must skip the PATH
 * lookup entirely, try pi.dev's install.ps1 managed layout at ~/.pi/agent
 * first, then the local node_modules copy, and say PI_CLI_PATH otherwise.
 *
 * These cases need file-level module mocks: process.platform is flipped via
 * Object.defineProperty (configurable, verified on Node 24), but homedir and
 * execFileSync cannot be vi.spyOn'd — ESM builtin namespaces are not
 * configurable — so node:os / node:child_process are mocked with vi.mock
 * factories that forward every other export untouched. Kept in a separate
 * file so the mocks can't leak into the POSIX cases.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiRpc } from "../src/rpc/pi-rpc.js";

const mocks = vi.hoisted(() => ({
  /** Mocked os.homedir(); empty string = forward to the real homedir. */
  homeDir: "",
  /** How many times execFileSync (the `which` hop) was spawned. */
  whichCalls: 0,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => (mocks.homeDir ? mocks.homeDir : actual.homedir()),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      mocks.whichCalls++;
      return actual.execFileSync(...args);
    },
  };
});

describe("resolveCliPath — win32 (no `which`)", () => {
  let tmpDir: string;
  let platformDescriptor: PropertyDescriptor;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier.cliwin-")),
    );
    platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    mocks.homeDir = tmpDir;
    mocks.whichCalls = 0;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    mocks.homeDir = "";
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Fake pi.dev's install.ps1 result under the (mocked) home root. Layout
   * verified against the official install.ps1: Get-PiAgentDir returns
   * `UserProfile\.pi\agent`, the shim sits at `<agent>\bin\pi*` and the
   * managed tree at `<agent>\install\...` (Select-PiManagedInstallDir).
   */
  function fakeManagedInstall(version = "0.87.1"): string {
    const pkg = path.join(
      tmpDir,
      ".pi",
      "agent",
      "install",
      "releases",
      version,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    fs.mkdirSync(path.join(pkg, "dist", "bundle"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".pi", "agent", "install", "current-version"), `${version}\n`);
    fs.writeFileSync(path.join(pkg, "dist", "bundle", "cli.js"), "console.log('pi');\n");
    return path.join(pkg, "dist", "bundle", "cli.js");
  }

  it("resolves the install.ps1 managed layout at ~/.pi/agent without ever spawning `which`", async () => {
    const expected = fakeManagedInstall();

    await expect(PiRpc.resolveCliPath()).resolves.toBe(expected);
    expect(mocks.whichCalls).toBe(0);
  });

  it("falls back to the local node_modules copy — still never spawning `which`", async () => {
    // Empty home root: no managed install to find.
    fs.rmSync(path.join(tmpDir, ".pi"), { recursive: true, force: true });

    const resolved = await PiRpc.resolveCliPath();
    expect(resolved).toMatch(/cli\.js$/);
    expect(resolved).toContain(path.join("dist"));
    expect(mocks.whichCalls).toBe(0);
  });
});
