import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeBindingBasename,
  isMusl,
  resolveCryptoPackageDir,
  isNativeBindingMissing,
  defaultCacheRoot,
  cacheEntryPaths,
  sha256FileSync,
  readCryptoPackageVersion,
  readManifest,
  readCacheEntry,
  writeCacheEntry,
  restoreBindingFromCache,
  verifyDownloadedBinding,
  ensureCryptoNative,
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

// ---------------------------------------------------------------------------
// Cache + sha256 verification (issue #48). All tests use temp dirs and an
// injected downloader — nothing here touches the real ~/.cache or network.
// ---------------------------------------------------------------------------

const BASENAME = "matrix-sdk-crypto.test-x64-gnu";
const VERSION = "0.4.0";
const KEY = `${VERSION}/${BASENAME}`;
const FAKE_BINDING = Buffer.from("fake-native-binding-bytes\n", "utf8");
const FAKE_SHA = createHash("sha256").update(FAKE_BINDING).digest("hex");
const ZERO_SHA = "0".repeat(64);

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

/** Fake installed crypto package dir with just a package.json (no binding). */
function makeCryptoPkg(version = VERSION): string {
  const dir = tempDir("crypto-pkg-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  return dir;
}

/** Temp manifest file with the given entries. */
function makeManifest(entries: Record<string, string>): string {
  const dir = tempDir("crypto-manifest-");
  const file = join(dir, "crypto-native-hashes.json");
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

/** console.warn capture; call restore() at the end of the test. */
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

/** A downloader stand-in that "downloads" by writing the fake binding. */
function fakeDownloader(cryptoDir: string): void {
  writeFileSync(join(cryptoDir, `${BASENAME}.node`), FAKE_BINDING);
}

/** Options bundle wiring ensureCryptoNative into a sandbox. */
function sandbox(opts: {
  cryptoDir: string;
  cacheRoot: string;
  manifestPath: string;
  runDownloader: (cryptoDir: string) => void;
}) {
  return {
    cryptoDir: opts.cryptoDir,
    basename: BASENAME as string | null,
    cacheRoot: opts.cacheRoot,
    manifestPath: opts.manifestPath,
    runDownloader: vi.fn(opts.runDownloader),
  };
}

describe("defaultCacheRoot", () => {
  it("honours XDG_CACHE_HOME when set", () => {
    expect(defaultCacheRoot({ XDG_CACHE_HOME: "/xdg" }, "/home/u")).toBe(
      join("/xdg", "pi-courier", "native-crypto")
    );
  });

  it("falls back to ~/.cache when XDG_CACHE_HOME is unset or empty", () => {
    expect(defaultCacheRoot({}, "/home/u")).toBe(
      join("/home/u", ".cache", "pi-courier", "native-crypto")
    );
    expect(defaultCacheRoot({ XDG_CACHE_HOME: "" }, "/home/u")).toBe(
      join("/home/u", ".cache", "pi-courier", "native-crypto")
    );
  });
});

describe("cacheEntryPaths / sha256FileSync / readCryptoPackageVersion", () => {
  it("lays out <version>/<basename>.node with a <basename>.sha256 sidecar", () => {
    const { dir, nodePath, shaPath } = cacheEntryPaths("/cache", "0.4.0", BASENAME);
    expect(dir).toBe(join("/cache", "0.4.0"));
    expect(nodePath).toBe(join("/cache", "0.4.0", `${BASENAME}.node`));
    expect(shaPath).toBe(join("/cache", "0.4.0", `${BASENAME}.sha256`));
  });

  it("hashes file bytes (known sha256 vector)", () => {
    const dir = tempDir("crypto-hash-");
    const file = join(dir, "abc.bin");
    writeFileSync(file, "abc");
    expect(sha256FileSync(file)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("reads the package version, or null when unreadable", () => {
    expect(readCryptoPackageVersion(makeCryptoPkg("9.9.9"))).toBe("9.9.9");
    expect(readCryptoPackageVersion(tempDir("crypto-empty-"))).toBe(null);
  });
});

describe("readManifest", () => {
  it("parses a valid manifest", () => {
    const file = makeManifest({ [KEY]: FAKE_SHA });
    expect(readManifest(file)).toEqual({ [KEY]: FAKE_SHA });
  });

  it("treats malformed JSON as an empty manifest and warns (no throw)", () => {
    const dir = tempDir("crypto-manifest-bad-");
    const file = join(dir, "crypto-native-hashes.json");
    writeFileSync(file, "{ definitely not json");
    const { lines, restore } = captureWarn();
    try {
      expect(readManifest(file)).toEqual({});
      expect(lines.join("\n")).toMatch(/manifest/i);
    } finally {
      restore();
    }
  });

  it("treats a missing file as an empty manifest and warns (no throw)", () => {
    const { lines, restore } = captureWarn();
    try {
      expect(readManifest(join(tempDir("crypto-manifest-none-"), "absent.json"))).toEqual({});
      expect(lines.join("\n")).toMatch(/manifest/i);
    } finally {
      restore();
    }
  });
});

describe("writeCacheEntry / readCacheEntry", () => {
  it("writes the copy + sidecar with dir 0700 and files 0600", () => {
    const cacheRoot = tempDir("crypto-cache-");
    const sourceDir = tempDir("crypto-src-");
    const source = join(sourceDir, "binding.node");
    writeFileSync(source, FAKE_BINDING);

    writeCacheEntry(cacheRoot, VERSION, BASENAME, source, FAKE_SHA);

    const { dir, nodePath, shaPath } = cacheEntryPaths(cacheRoot, VERSION, BASENAME);
    expect(existsSync(nodePath)).toBe(true);
    expect(readFileSync(nodePath)).toEqual(FAKE_BINDING);
    expect(readFileSync(shaPath, "utf8").trim()).toBe(FAKE_SHA);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(nodePath).mode & 0o777).toBe(0o600);
    expect(statSync(shaPath).mode & 0o777).toBe(0o600);
  });

  it("hits when sidecar and manifest both match", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    const res = readCacheEntry(cacheRoot, VERSION, BASENAME, { [KEY]: FAKE_SHA });
    expect(res.hit).toBe(true);
    expect(res.verified).toBe("manifest");
    expect(res.sha256).toBe(FAKE_SHA);
  });

  it("TOFU-hits when the manifest lacks the key, warning once", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    const { lines, restore } = captureWarn();
    try {
      const res = readCacheEntry(cacheRoot, VERSION, BASENAME, {});
      expect(res.hit).toBe(true);
      expect(res.verified).toBe("tofu");
      expect(lines.join("\n")).toMatch(/manifest/i);
    } finally {
      restore();
    }
  });

  it("misses when the sidecar is missing", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    rmSync(cacheEntryPaths(cacheRoot, VERSION, BASENAME).shaPath);
    expect(readCacheEntry(cacheRoot, VERSION, BASENAME, { [KEY]: FAKE_SHA }).hit).toBe(false);
  });

  it("misses when the sidecar disagrees with the file bytes (corrupt cache)", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    // Tamper with the cached binary; the sidecar now describes the old bytes.
    writeFileSync(cacheEntryPaths(cacheRoot, VERSION, BASENAME).nodePath, Buffer.from("tampered"));
    expect(readCacheEntry(cacheRoot, VERSION, BASENAME, { [KEY]: FAKE_SHA }).hit).toBe(false);
    // And when the manifest is absent too — sidecar mismatch alone is enough.
    expect(readCacheEntry(cacheRoot, VERSION, BASENAME, {}).hit).toBe(false);
  });

  it("misses when the manifest disagrees even with a self-consistent sidecar", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    const { lines, restore } = captureWarn();
    try {
      const res = readCacheEntry(cacheRoot, VERSION, BASENAME, { [KEY]: ZERO_SHA });
      expect(res.hit).toBe(false);
      expect(lines.join("\n")).not.toMatch(/add it to/i); // no TOFU nag on a rejected entry
    } finally {
      restore();
    }
  });

  it("misses when there is no cache entry at all", () => {
    const cacheRoot = tempDir("crypto-cache-");
    expect(readCacheEntry(cacheRoot, VERSION, BASENAME, { [KEY]: FAKE_SHA }).hit).toBe(false);
  });

  it("ignores leftover tmp files from an interrupted write", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    const { nodePath, shaPath } = cacheEntryPaths(cacheRoot, VERSION, BASENAME);
    // Simulate an interrupted atomic write leaving temp residue behind.
    writeFileSync(`${nodePath}.424242.ab3df.tmp`, Buffer.from("half-written"));
    writeFileSync(`${shaPath}.424242.ab3df.tmp`, "half-written");
    const res = readCacheEntry(cacheRoot, VERSION, BASENAME, { [KEY]: FAKE_SHA });
    expect(res.hit).toBe(true);
    expect(existsSync(`${nodePath}.424242.ab3df.tmp`)).toBe(true); // residue untouched, harmless
  });
});

describe("verifyDownloadedBinding", () => {
  it("verdicts manifest-match / manifest-mismatch / manifest-miss", () => {
    const dir = tempDir("crypto-verify-");
    const file = join(dir, "downloaded.node");
    writeFileSync(file, FAKE_BINDING);

    expect(verifyDownloadedBinding(file, KEY, { [KEY]: FAKE_SHA })).toEqual({
      verdict: "manifest-match",
      observed: FAKE_SHA,
      expected: FAKE_SHA,
    });
    expect(verifyDownloadedBinding(file, KEY, { [KEY]: ZERO_SHA })).toEqual({
      verdict: "manifest-mismatch",
      observed: FAKE_SHA,
      expected: ZERO_SHA,
    });
    expect(verifyDownloadedBinding(file, KEY, {})).toEqual({
      verdict: "manifest-miss",
      observed: FAKE_SHA,
      expected: null,
    });
    // The verdict is pure: it never deletes anything itself.
    expect(existsSync(file)).toBe(true);
  });
});

describe("restoreBindingFromCache", () => {
  it("atomically copies the cached binding into the package dir", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    const cryptoDir = makeCryptoPkg();
    const { nodePath } = cacheEntryPaths(cacheRoot, VERSION, BASENAME);

    const target = restoreBindingFromCache(cryptoDir, BASENAME, nodePath);
    expect(target).toBe(join(cryptoDir, `${BASENAME}.node`));
    expect(readFileSync(target)).toEqual(FAKE_BINDING);
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
});

describe("ensureCryptoNative (cache + verification, injected deps, no network)", () => {
  let warns: string[];
  let infos: string[];
  let spies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    warns = [];
    infos = [];
    spies = [
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      }),
      vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
        infos.push(args.map(String).join(" "));
      }),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it("after a real download: caches the copy + sidecar with correct paths/modes", () => {
    const cryptoDir = makeCryptoPkg();
    const cacheRoot = tempDir("crypto-cache-");
    const manifestPath = makeManifest({ [KEY]: FAKE_SHA });

    const s = sandbox({ cryptoDir, cacheRoot, manifestPath, runDownloader: fakeDownloader });
    const res = ensureCryptoNative(s);

    expect(res).toMatchObject({ ok: true, downloaded: true, verified: "manifest" });
    const { dir, nodePath, shaPath } = cacheEntryPaths(cacheRoot, VERSION, BASENAME);
    expect(readFileSync(nodePath)).toEqual(FAKE_BINDING);
    expect(readFileSync(shaPath, "utf8").trim()).toBe(FAKE_SHA);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(nodePath).mode & 0o777).toBe(0o600);
    expect(statSync(shaPath).mode & 0o777).toBe(0o600);
  });

  it("second install with warm cache: restores without downloading", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    const cryptoDir = makeCryptoPkg(); // fresh install: binding wiped by npm
    const manifestPath = makeManifest({ [KEY]: FAKE_SHA });

    const s = sandbox({
      cryptoDir,
      cacheRoot,
      manifestPath,
      runDownloader: () => {
        throw new Error("network must not be touched on a cache hit");
      },
    });
    const res = ensureCryptoNative(s);

    expect(s.runDownloader).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, downloaded: false, restoredFromCache: true });
    expect(readFileSync(join(cryptoDir, `${BASENAME}.node`))).toEqual(FAKE_BINDING);
  });

  it("manifest hit with wrong hash: deletes the artifact, refuses, warns", () => {
    const cryptoDir = makeCryptoPkg();
    const cacheRoot = tempDir("crypto-cache-");
    const manifestPath = makeManifest({ [KEY]: ZERO_SHA }); // known, but different

    const s = sandbox({ cryptoDir, cacheRoot, manifestPath, runDownloader: fakeDownloader });
    const res = ensureCryptoNative(s);

    expect(res).toMatchObject({ ok: false, reason: "hash-mismatch", verified: "rejected" });
    // The unverified binary must not remain anywhere it could be loaded from.
    expect(existsSync(join(cryptoDir, `${BASENAME}.node`))).toBe(false);
    expect(existsSync(cacheEntryPaths(cacheRoot, VERSION, BASENAME).nodePath)).toBe(false);
    expect(warns.join("\n")).toMatch(/sha256/i);
    expect(warns.join("\n")).toMatch(/E2EE/i);
  });

  it("manifest miss on real download: TOFU accept + nag + sidecar records observed hash", () => {
    const cryptoDir = makeCryptoPkg();
    const cacheRoot = tempDir("crypto-cache-");
    const manifestPath = makeManifest({}); // version not listed yet

    const s = sandbox({ cryptoDir, cacheRoot, manifestPath, runDownloader: fakeDownloader });
    const res = ensureCryptoNative(s);

    expect(res).toMatchObject({ ok: true, downloaded: true, verified: "tofu" });
    const { nodePath, shaPath } = cacheEntryPaths(cacheRoot, VERSION, BASENAME);
    expect(readFileSync(nodePath)).toEqual(FAKE_BINDING);
    expect(readFileSync(shaPath, "utf8").trim()).toBe(FAKE_SHA);
    expect(warns.join("\n")).toMatch(/manifest/i);
    expect(warns.join("\n")).toContain(FAKE_SHA); // hands the maintainer the hash to record
  });

  it("corrupted cache (sidecar mismatch): treated as a miss, falls back to real download", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    writeFileSync(cacheEntryPaths(cacheRoot, VERSION, BASENAME).nodePath, Buffer.from("tampered"));
    const cryptoDir = makeCryptoPkg();
    const manifestPath = makeManifest({ [KEY]: FAKE_SHA });

    const s = sandbox({ cryptoDir, cacheRoot, manifestPath, runDownloader: fakeDownloader });
    const res = ensureCryptoNative(s);

    expect(s.runDownloader).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ ok: true, downloaded: true });
    expect(res.restoredFromCache).toBeFalsy();
    expect(readFileSync(join(cryptoDir, `${BASENAME}.node`))).toEqual(FAKE_BINDING);
    // The fresh verified copy replaces the corrupt cache entry.
    expect(readFileSync(cacheEntryPaths(cacheRoot, VERSION, BASENAME).nodePath)).toEqual(
      FAKE_BINDING
    );
  });

  it("malformed manifest JSON: treated as unlisted, install flow keeps working", () => {
    const cryptoDir = makeCryptoPkg();
    const cacheRoot = tempDir("crypto-cache-");
    const dir = tempDir("crypto-manifest-bad-");
    const manifestPath = join(dir, "crypto-native-hashes.json");
    writeFileSync(manifestPath, "{ not json");

    const s = sandbox({ cryptoDir, cacheRoot, manifestPath, runDownloader: fakeDownloader });
    const res = ensureCryptoNative(s);

    expect(res).toMatchObject({ ok: true, downloaded: true, verified: "tofu" });
    expect(warns.join("\n")).toMatch(/manifest/i);
  });

  it("SDK version bump: old cache entry does not satisfy the new version", () => {
    const cacheRoot = tempDir("crypto-cache-");
    writeCacheEntry(cacheRoot, VERSION, BASENAME, withFakeBinding(), FAKE_SHA);
    const cryptoDir = makeCryptoPkg("0.5.0");
    const manifestPath = makeManifest({ [KEY]: FAKE_SHA }); // only 0.4.0 listed

    const s = sandbox({ cryptoDir, cacheRoot, manifestPath, runDownloader: fakeDownloader });
    const res = ensureCryptoNative(s);

    expect(s.runDownloader).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ ok: true, downloaded: true });
    expect(res.restoredFromCache).toBeFalsy();
    // Old entry left in place; a fresh 0.5.0 entry gets recorded.
    expect(existsSync(cacheEntryPaths(cacheRoot, VERSION, BASENAME).nodePath)).toBe(true);
    expect(readFileSync(cacheEntryPaths(cacheRoot, "0.5.0", BASENAME).nodePath)).toEqual(
      FAKE_BINDING
    );
  });

  it("unsupported platform (basename null): silently skips, downloader never called", () => {
    const cryptoDir = makeCryptoPkg();
    const cacheRoot = tempDir("crypto-cache-");
    const manifestPath = makeManifest({});

    const res = ensureCryptoNative({
      cryptoDir,
      basename: null,
      cacheRoot,
      manifestPath,
      runDownloader: () => {
        throw new Error("must not download on unsupported platforms");
      },
    });

    expect(res).toMatchObject({ ok: true, downloaded: false });
    expect(existsSync(join(cryptoDir, `${BASENAME}.node`))).toBe(false);
  });

  it("binding already present: current behaviour unchanged, cache untouched", () => {
    const cryptoDir = makeCryptoPkg();
    writeFileSync(join(cryptoDir, `${BASENAME}.node`), FAKE_BINDING);
    const cacheRoot = tempDir("crypto-cache-");
    const manifestPath = makeManifest({});

    const s = sandbox({
      cryptoDir,
      cacheRoot,
      manifestPath,
      runDownloader: () => {
        throw new Error("must not download when the binding exists");
      },
    });
    const res = ensureCryptoNative(s);

    expect(s.runDownloader).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, downloaded: false });
    // No cache side effects on the happy path (the version dir is never created).
    expect(existsSync(cacheEntryPaths(cacheRoot, VERSION, BASENAME).dir)).toBe(false);
  });

  it("download failure: warn + degrade, never throws, nothing cached", () => {
    const cryptoDir = makeCryptoPkg();
    const cacheRoot = tempDir("crypto-cache-");
    const manifestPath = makeManifest({ [KEY]: FAKE_SHA });

    const s = sandbox({
      cryptoDir,
      cacheRoot,
      manifestPath,
      runDownloader: () => {
        throw new Error("ENOTFOUND: github.com");
      },
    });
    const res = ensureCryptoNative(s);

    expect(res).toMatchObject({ ok: false, reason: "download-failed" });
    expect(warns.join("\n")).toMatch(/could not auto-download/i);
    expect(existsSync(cacheEntryPaths(cacheRoot, VERSION, BASENAME).nodePath)).toBe(false);
  });
});

/** Helper: a temp source file holding the fake binding bytes. */
function withFakeBinding(): string {
  const dir = tempDir("crypto-binding-src-");
  const file = join(dir, "binding.node");
  writeFileSync(file, FAKE_BINDING);
  return file;
}
