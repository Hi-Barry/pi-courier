/**
 * npm CLI resolution (Windows adaptation for `pi-courier update`,
 * evaluation 2026-10-13): resolveNpmCli finds npm-cli.js beside the running
 * node — two install layouts. The crypto-binding tests pin package-relative
 * resolution for npm 11's shallow global layout (#320).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nativeBindingExists,
  resolveCryptoPackageDirFrom,
  resolveNpmCli,
} from "../src/npm-runtime.js";

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

describe("crypto native binding resolution (package-relative)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier.crypto-")),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Materialize <base>/node_modules/@matrix-org/...; returns the package dir. */
  function putCryptoPackage(base: string, withNode: boolean): string {
    const dir = path.join(base, "node_modules", "@matrix-org", "matrix-sdk-crypto-nodejs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    if (withNode) {
      fs.writeFileSync(path.join(dir, "matrix-sdk-crypto.fake.node"), "stub");
    }
    return dir;
  }

  function appRoot(): string {
    const app = path.join(root, "app");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "package.json"), "{}");
    return app;
  }

  it("finds a nested crypto package (npm 11 shallow global layout)", () => {
    const app = appRoot();
    const pkg = putCryptoPackage(app, true);

    expect(resolveCryptoPackageDirFrom(app)).toBe(pkg);
    expect(nativeBindingExists(app)).toBe(true);
  });

  it("finds a hoisted crypto package in an ancestor node_modules", () => {
    const app = appRoot();
    const pkg = putCryptoPackage(root, true);

    expect(resolveCryptoPackageDirFrom(app)).toBe(pkg);
    expect(nativeBindingExists(app)).toBe(true);
  });

  it("prefers the package-local copy over the hoisted one", () => {
    const app = appRoot();
    const nested = putCryptoPackage(app, true);
    putCryptoPackage(root, true);

    expect(resolveCryptoPackageDirFrom(app)).toBe(nested);
  });

  it("reports the package dir but no binding when the .node file is absent", () => {
    const app = appRoot();
    const pkg = putCryptoPackage(app, false);

    expect(resolveCryptoPackageDirFrom(app)).toBe(pkg);
    expect(nativeBindingExists(app)).toBe(false);
  });

  it("returns undefined / false when the crypto package is not installed", () => {
    expect(resolveCryptoPackageDirFrom(appRoot())).toBeUndefined();
    expect(nativeBindingExists(appRoot())).toBe(false);
  });

  it("treats unsupported platforms as fine (no native binding expected)", () => {
    expect(nativeBindingExists(appRoot(), "freebsd")).toBe(true);
  });
});
