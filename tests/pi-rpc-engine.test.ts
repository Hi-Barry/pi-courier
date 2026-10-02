/**
 * pi 1.0+ Node engine gate: upstream treats engines.node as a hard contract
 * from 1.0 (fs.globSync import dies as SyntaxError on Node <22.19), while
 * the 0.x line runs fine on Node 20 despite claiming >=22.19. The gate must
 * block exactly the first case — and never guess when the engines range or
 * the runtime version can't be parsed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPiEngineSupported,
  minNodeVersionOf,
  piPackageEngines,
} from "../src/rpc/pi-rpc.js";

describe("minNodeVersionOf", () => {
  it("parses the >=x[.y[.z]] form upstream ships", () => {
    expect(minNodeVersionOf(">=22.19.0")).toEqual([22, 19, 0]);
    expect(minNodeVersionOf(">=20")).toEqual([20, 0, 0]);
    expect(minNodeVersionOf(">= 21.5")).toEqual([21, 5, 0]);
  });

  it("returns undefined for ranges it does not understand (skip, don't guess)", () => {
    expect(minNodeVersionOf("^20.0.0")).toBeUndefined();
    expect(minNodeVersionOf(">=20 <22")).toBeUndefined();
    expect(minNodeVersionOf("")).toBeUndefined();
    expect(minNodeVersionOf("banana")).toBeUndefined();
  });
});

describe("piPackageEngines", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier.engine-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakePiInstall(version: string, enginesNode?: string, name?: string): string {
    const pkgDir = path.join(
      tmpDir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    const cli = path.join(pkgDir, "dist", "cli.js");
    fs.writeFileSync(cli, "// entry stub\n");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: name ?? "@earendil-works/pi-coding-agent",
        version,
        ...(enginesNode === undefined ? {} : { engines: { node: enginesNode } }),
      }),
    );
    return cli;
  }

  it("reads version and engines.node from the package above the CLI entry", () => {
    const cli = fakePiInstall("1.0.0", ">=22.19.0");
    expect(piPackageEngines(cli)).toEqual({
      version: "1.0.0",
      enginesNode: ">=22.19.0",
    });
  });

  it("tolerates a missing engines block", () => {
    const cli = fakePiInstall("1.0.0");
    expect(piPackageEngines(cli)).toEqual({ version: "1.0.0", enginesNode: undefined });
  });

  it("ignores packages that are not pi", () => {
    const cli = fakePiInstall("9.9.9", ">=10", "some-other-package");
    expect(piPackageEngines(cli)).toBeUndefined();
  });

  it("returns undefined when no package.json exists above the entry", () => {
    const cli = path.join(tmpDir, "nowhere", "dist", "cli.js");
    expect(piPackageEngines(cli)).toBeUndefined();
  });
});

describe("assertPiEngineSupported", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier.gate-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakePiInstall(version: string, enginesNode?: string, name?: string): string {
    const pkgDir = path.join(
      tmpDir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    fs.mkdirSync(path.join(pkgDir, "dist", "bundle"), { recursive: true });
    const cli = path.join(pkgDir, "dist", "bundle", "cli.js");
    fs.writeFileSync(cli, "// entry stub\n");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: name ?? "@earendil-works/pi-coding-agent",
        version,
        ...(enginesNode === undefined ? {} : { engines: { node: enginesNode } }),
      }),
    );
    return cli;
  }

  it("blocks pi 1.x on a Node below the engines floor, with a human-readable error", () => {
    const cli = fakePiInstall("1.0.0", ">=22.19.0");
    expect(() => assertPiEngineSupported(cli, "v20.20.2")).toThrowError(
      /pi@1\.0\.0 requires Node >=22\.19\.0.*Node v20\.20\.2/s,
    );
  });

  it("lets pi 1.x through on a sufficient Node", () => {
    const cli = fakePiInstall("1.0.0", ">=22.19.0");
    expect(() => assertPiEngineSupported(cli, "v22.19.0")).not.toThrow();
    expect(() => assertPiEngineSupported(cli, "v24.20.0")).not.toThrow();
  });

  it("exempts the 0.x line — its engines claim is unreliable but real runs are fine", () => {
    const cli = fakePiInstall("0.83.0", ">=22.19.0");
    expect(() => assertPiEngineSupported(cli, "v20.20.2")).not.toThrow();
  });

  it("skips the gate on unparseable engines ranges, foreign packages, or odd versions", () => {
    expect(() => assertPiEngineSupported(fakePiInstall("1.0.0", "^22.19.0"), "v20.20.2")).not.toThrow();
    expect(() => assertPiEngineSupported(fakePiInstall("1.0.0"), "v20.20.2")).not.toThrow();
    expect(() =>
      assertPiEngineSupported(
        fakePiInstall("1.0.0", ">=22.19.0", "some-other-package"),
        "v20.20.2",
      ),
    ).not.toThrow();
    expect(() =>
      assertPiEngineSupported(fakePiInstall("1.0.0", ">=22.19.0"), "not-a-version"),
    ).not.toThrow();
  });
});
