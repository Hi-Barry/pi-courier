/**
 * npm global-layout resolution (Windows adaptation for `pi-courier update`,
 * evaluation 2026-10-13): resolveNpmCli finds npm-cli.js beside the running
 * node — two install layouts — and globalNodeModulesDir picks npm's
 * per-platform global prefix: %APPDATA%\npm on win32 (with a home-relative
 * fallback when APPDATA is unset), the historical lib/ layout on POSIX.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globalNodeModulesDir, resolveNpmCli } from "../src/npm-runtime.js";

describe("resolveNpmCli", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier.npmruntime-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Materialize one npm-cli.js under <root>/npm/bin/ (layout tail is shared). */
  function putNpmCli(dir: string): string {
    const cli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "// npm-cli.js stub\n");
    return cli;
  }

  it("finds npm-cli.js in the Windows layout (beside node.exe)", () => {
    const nodeExecPath = path.join(tmpDir, "bin", "node.exe");
    const expected = putNpmCli(path.join(tmpDir, "bin"));

    expect(resolveNpmCli(nodeExecPath)).toBe(expected);
  });

  it("finds npm-cli.js in the Unix global layout (one lib level up)", () => {
    const nodeExecPath = path.join(tmpDir, "bin", "node");
    const expected = putNpmCli(path.join(tmpDir, "lib"));

    expect(resolveNpmCli(nodeExecPath)).toBe(expected);
  });

  it("prefers the near layout when both exist", () => {
    const nodeExecPath = path.join(tmpDir, "bin", "node");
    const beside = putNpmCli(path.join(tmpDir, "bin"));
    putNpmCli(path.join(tmpDir, "lib"));

    expect(resolveNpmCli(nodeExecPath)).toBe(beside);
  });

  it("returns undefined when neither layout exists", () => {
    expect(resolveNpmCli(path.join(tmpDir, "bin", "node"))).toBeUndefined();
  });
});

describe("globalNodeModulesDir", () => {
  const homeDir = path.join("/home", "alice");
  const execPath = path.join("/usr", "local", "bin", "node");

  it("uses %APPDATA%\\npm\\node_modules on win32", () => {
    expect(
      globalNodeModulesDir({
        platform: "win32",
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        appData: "C:\\Users\\alice\\AppData\\Roaming",
        homeDir: "C:\\Users\\alice",
      }),
    ).toBe(path.join("C:\\Users\\alice\\AppData\\Roaming", "npm", "node_modules"));
  });

  it("falls back to <home>\\AppData\\Roaming on win32 when APPDATA is unset", () => {
    expect(
      globalNodeModulesDir({
        platform: "win32",
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        homeDir: "C:\\Users\\alice",
      }),
    ).toBe(
      path.join("C:\\Users\\alice", "AppData", "Roaming", "npm", "node_modules"),
    );
  });

  it("keeps the POSIX prefix unchanged (<nodeDir>/../lib/node_modules)", () => {
    expect(globalNodeModulesDir({ platform: "linux", execPath, homeDir })).toBe(
      path.join(path.dirname(execPath), "..", "lib", "node_modules"),
    );
  });
});
