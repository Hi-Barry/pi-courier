/**
 * CLI resolution through a pi.dev managed install (issue #111): there
 * `bin/pi` is a POSIX shell wrapper — not a symlink — so node would die
 * parsing shell syntax as JS. resolveCliPath must follow the releases-v1
 * layout to the real JS entry, while symlinked npm installs and unknown
 * wrappers keep their old behavior.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiRpc } from "../src/rpc/pi-rpc.js";

describe("resolveCliPath — pi.dev managed install (issue #111)", () => {
  let tmpDir: string;
  let origPath: string | undefined;

  beforeEach(() => {
    // realpath so assertion paths match even when tmpdir() has symlinked
    // segments (macOS /tmp → /private/tmp).
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier.cliresolve-")),
    );
    origPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function putOnPath(): void {
    process.env.PATH = `${path.join(tmpDir, "bin")}:${process.env.PATH ?? ""}`;
  }

  /** Fake a pi.dev managed install: <root>/bin/pi wrapper + releases layout. */
  function fakeManagedInstall(version = "0.87.1"): string {
    const bin = path.join(tmpDir, "bin", "pi");
    const pkg = path.join(
      tmpDir,
      "install",
      "releases",
      version,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    fs.mkdirSync(path.join(tmpDir, "bin"), { recursive: true });
    fs.mkdirSync(path.join(pkg, "dist", "bundle"), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\ncase "$0" in\nesac\n');
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(path.join(tmpDir, "install", "current-version"), `${version}\n`);
    fs.writeFileSync(path.join(pkg, "dist", "bundle", "cli.js"), "console.log('pi');\n");
    return bin;
  }

  it("resolves the shell wrapper to the release's dist/bundle/cli.js", async () => {
    fakeManagedInstall();
    putOnPath();

    await expect(PiRpc.resolveCliPath()).resolves.toBe(
      path.join(
        tmpDir,
        "install",
        "releases",
        "0.87.1",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "bundle",
        "cli.js",
      ),
    );
  });

  it("follows a version bump via install/current-version", async () => {
    fakeManagedInstall("0.88.0");
    putOnPath();

    await expect(PiRpc.resolveCliPath()).resolves.toBe(
      path.join(
        tmpDir,
        "install",
        "releases",
        "0.88.0",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "bundle",
        "cli.js",
      ),
    );
  });

  it("still resolves a symlinked npm install via realpath untouched", async () => {
    const target = path.join(tmpDir, "npm", "pi-coding-agent", "dist", "cli.js");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "console.log('pi');\n");
    // `which` skips non-executable files — npm-installed entries are +x.
    fs.chmodSync(target, 0o755);
    fs.mkdirSync(path.join(tmpDir, "bin"), { recursive: true });
    fs.symlinkSync(target, path.join(tmpDir, "bin", "pi"));
    putOnPath();

    await expect(PiRpc.resolveCliPath()).resolves.toBe(target);
  });

  it("passes an unrecognized wrapper through so the spawn error stays visible", async () => {
    const bin = path.join(tmpDir, "bin", "pi");
    fs.mkdirSync(path.join(tmpDir, "bin"), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nexec /opt/pi/run\n");
    fs.chmodSync(bin, 0o755);
    putOnPath();

    await expect(PiRpc.resolveCliPath()).resolves.toBe(bin);
  });

  it("falls through to the local node_modules copy when no system pi exists", async () => {
    process.env.PATH = "";

    const resolved = await PiRpc.resolveCliPath();
    expect(resolved).toMatch(/cli\.js$/);
    expect(resolved).toContain(path.join("dist"));
  });
});
