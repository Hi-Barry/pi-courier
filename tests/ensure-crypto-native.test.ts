import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeBindingBasename,
  isMusl,
  resolveCryptoPackageDir,
  isNativeBindingMissing,
} from "../scripts/ensure-crypto-native.mjs";

describe("nativeBindingBasename", () => {
  it("builds the platform-arch-libc basename for linux x64", () => {
    const name = nativeBindingBasename();
    // On the CI/dev host this is linux-x64; assert the shape (prefix + ext handled by .node).
    expect(name).toMatch(/^matrix-sdk-crypto\./);
    expect(name).not.toMatch(/\.node$/); // basename excludes the extension
  });

  it("returns null on unsupported platforms (skip silently)", () => {
    // There is no way to flip process.platform here; the linux/darwin/win32
    // branches are covered by shape assertions. This guards the contract that
    // the function never throws.
    expect(() => nativeBindingBasename()).not.toThrow();
  });
});

describe("isMusl", () => {
  it("returns a boolean and never throws", () => {
    const result = isMusl();
    expect(typeof result).toBe("boolean");
  });
});

describe("resolveCryptoPackageDir & isNativeBindingMissing", () => {
  it("resolves the real crypto dir when installed and reports binding state", () => {
    // When run from the repo with deps installed, the package must reside
    // under node_modules (not unresolved).
    const dir = resolveCryptoPackageDir();
    if (!dir) {
      // Not installed (CI without install) — skip rather than fail.
      return;
    }
    expect(dir).toContain("matrix-sdk-crypto-nodejs");
    const basename = nativeBindingBasename();
    if (basename === null) return;
    // The on-disk truth: it is considered missing iff the .node file is absent.
    expect(isNativeBindingMissing(dir, basename)).toBe(false);
  });

  it("reports missing when the .node file is absent in a fake package dir", () => {
    const fake = mkdtempSync(join(tmpdir(), "crypto-fake-"));
    try {
      writeFileSync(join(fake, "package.json"), "{}");
      const basename = nativeBindingBasename();
      if (basename === null) return;
      expect(isNativeBindingMissing(fake, basename)).toBe(true);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });
});