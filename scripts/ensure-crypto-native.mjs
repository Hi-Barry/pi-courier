#!/usr/bin/env node
/**
 * Postinstall self-check for the matrix-rust-sdk-crypto native binding.
 *
 * WHY: `matrix-bot-sdk` depends on `@matrix-org/matrix-sdk-crypto-nodejs`, whose
 * platform native binary (.node) is only produced by its own `postinstall`
 * script (`node download-lib.js`) on first install. npm >= 11 ships
 * `allow-scripts`, which by default BLOCKS a dependency's install scripts, so
 * that binary never gets downloaded. At runtime the ESM top-level
 * `import matrix-bot-sdk` synchronously requires the crypto module and the
 * process dies with:
 *
 *   Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'
 *
 * This self-check runs during *our* (the root package's) postinstall — that
 * script is NOT blocked by allow-scripts — and, when the native binding is
 * missing, re-runs the crypto package's own downloader so the binary is
 * present before first run. Any failure here degrades to a warning; it never
 * fails the install (the bridge can still run without E2EE crypto).
 *
 * LOCAL CACHE + SHA256 VERIFICATION (issue #48):
 *
 * Every `npm update` reinstalls the dependency tree and wipes the freshly
 * downloaded .node, forcing a ~21MB re-download (≈1min behind slow proxies).
 * To avoid that, a verified copy is kept under
 * `$XDG_CACHE_HOME/pi-courier/native-crypto/<crypto version>/<basename>.node`
 * (default `~/.cache/pi-courier/native-crypto/...`) with a `<basename>.sha256`
 * sidecar recording the observed digest. When a later install finds the
 * binding missing, the cache is consulted first (sidecar + manifest both
 * verified before use) and restored with zero network traffic.
 *
 * Integrity: binaries are loaded by Node as native code, so a tampered
 * download is arbitrary code execution. Every accepted binary's sha256 must
 * match `scripts/crypto-native-hashes.json` (keyed `<version>/<basename>`).
 * A listed version with a mismatching digest is DELETED and E2EE degrades —
 * the binary is never loaded. An unlisted version is accepted TOFU-style with
 * a loud warning asking the maintainer to record the digest. Cache entries
 * whose sidecar disagrees with their bytes are treated as absent.
 *
 * All functions are pure-ish (explicit path/manifest params, injectable
 * downloader) so tests can exercise every branch in temp dirs without network.
 *
 * Usage (from package root): node scripts/ensure-crypto-native.mjs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const LOG_PREFIX = "[pi-courier]";
const CACHE_SUBDIR = join("pi-courier", "native-crypto");
const MANIFEST_FILENAME = "crypto-native-hashes.json";
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Current platform/arch names as napi-rs names them (no .node suffix). */
export function nativeBindingBasename() {
  const { platform, arch } = process;
  if (platform === "win32") return `matrix-sdk-crypto.win32-${arch}-msvc`;
  if (platform === "darwin") return `matrix-sdk-crypto.darwin-${arch}`;
  if (platform === "linux") {
    const libc = isMusl() ? "musl" : "gnu";
    return `matrix-sdk-crypto.linux-${arch}-${libc}`;
  }
  return null; // unsupported platform — native E2EE unavailable, skip silently
}

export function isMusl() {
  // Node >= 10 provides the runtime report; absent report => assume gnu.
  try {
    const { glibcVersionRuntime } = process.report.getReport().header;
    return !glibcVersionRuntime;
  } catch {
    return false;
  }
}

/**
 * Locate the crypto package's own directory. Works both when we are an npm
 * dependency (node_modules/<scope>/<pkg>) and when running from a repo clone.
 */
export function resolveCryptoPackageDir() {
  const paths = [
    // As a dependency (global/local npm install). createRequire resolves
    // relative to this script inside the installed package tree.
    (() => {
      try {
        return require.resolve("@matrix-org/matrix-sdk-crypto-nodejs/package.json");
      } catch {
        return null;
      }
    })(),
    // Nested copy under our own node_modules when hybrid layouts appear.
    (() => {
      try {
        return require.resolve("@matrix-org/matrix-sdk-crypto-nodejs/package.json", {
          paths: [process.cwd()],
        });
      } catch {
        return null;
      }
    })(),
  ].filter(Boolean);

  // Prefer the one actually under a node_modules chain (global installs wire
  // this via the primary resolution); fall back to any hit.
  const hit = paths.find((p) => p.includes("node_modules")) ?? paths[0];
  if (!hit) return null;
  // hit is the package.json path; chop the filename to get the package dir.
  return hit.slice(0, hit.lastIndexOf("package.json"));
}

/**
 * True when the crypto package dir lacks the native binding this platform needs.
 * A platform we don't recognise (nativeBindingBasename() === null) counts as
 * "fine" (skips download) rather than "missing".
 */
export function isNativeBindingMissing(cryptoDir, basename) {
  if (basename === null) return false;
  return !existsSync(`${cryptoDir}/${basename}.node`);
}

/** Run the crypto package's own downloader to fetch the native binding. */
export function runNativeDownloader(cryptoDir) {
  const script = `${cryptoDir}/download-lib.js`;
  if (!existsSync(script)) {
    throw new Error(`crypto downloader not found: ${script}`);
  }
  execFileSync(process.execPath, [script], {
    cwd: cryptoDir,
    stdio: "inherit",
    // Inherit proxy env so machines behind a proxy still reach GitHub.
    env: process.env,
  });
}

// ---------------------------------------------------------------------------
// Local cache + sha256 manifest (issue #48)
// ---------------------------------------------------------------------------

/** Cache root: $XDG_CACHE_HOME/pi-courier/native-crypto, else ~/.cache/… */
export function defaultCacheRoot(env = process.env, home = homedir()) {
  const xdg = env.XDG_CACHE_HOME;
  const base = typeof xdg === "string" && xdg.trim() !== "" ? xdg : join(home, ".cache");
  return join(base, CACHE_SUBDIR);
}

/** Manifest ships next to this script (package.json `files` covers scripts/). */
export function defaultManifestPath() {
  return fileURLToPath(new URL(`./${MANIFEST_FILENAME}`, import.meta.url));
}

/** Cache layout: `<cacheRoot>/<version>/<basename>.node` + `<basename>.sha256`. */
export function cacheEntryPaths(cacheRoot, version, basename) {
  const dir = join(cacheRoot, version);
  const nodePath = join(dir, `${basename}.node`);
  return { dir, nodePath, shaPath: join(dir, `${basename}.sha256`) };
}

/** sha256 of a file's bytes, lowercase hex. */
export function sha256FileSync(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** The crypto package's own version (cache namespace), or null if unreadable. */
export function readCryptoPackageVersion(cryptoDir) {
  try {
    const pkg = JSON.parse(readFileSync(`${cryptoDir}/package.json`, "utf8"));
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Read the sha256 manifest. Any problem (missing, malformed, wrong shape)
 * degrades to an empty manifest — i.e. "nothing is listed", which makes the
 * flow take the TOFU path instead of ever throwing during install.
 */
export function readManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `${LOG_PREFIX} crypto hash manifest unreadable at ${manifestPath} (${message}) — ` +
        `treating every version as unlisted (TOFU).`
    );
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(
      `${LOG_PREFIX} crypto hash manifest malformed at ${manifestPath} — ` +
        `treating every version as unlisted (TOFU).`
    );
    return {};
  }
  return parsed;
}

function manifestLookup(manifest, key) {
  if (key === null) return { listed: false };
  if (!Object.prototype.hasOwnProperty.call(manifest, key)) return { listed: false };
  const expected = String(manifest[key]).trim().toLowerCase();
  return { listed: true, expected: SHA256_HEX.test(expected) ? expected : null };
}

function manifestNag(key, observedSha256) {
    console.warn(
      `${LOG_PREFIX} crypto binding ${key} is NOT in the sha256 manifest ` +
        `(scripts/${MANIFEST_FILENAME}, observed sha256 ${observedSha256}) — ` +
        `accepted this once (TOFU). ` +
        `Please record that digest so future installs verify against it.`
    );
}

/** tmp path for an atomic write; process-unique and random to survive races. */
function tmpPathFor(destPath) {
  return `${destPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
}

/** Write via temp file + atomic rename so an interrupt never leaves half a file. */
function atomicWrite(destPath, write, mode) {
  const tmp = tmpPathFor(destPath);
  try {
    write(tmp);
    chmodSync(tmp, mode);
    renameSync(tmp, destPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort — the tmp residue is inert
    }
    throw err;
  }
}

/**
 * Copy a verified .node into the cache: `<version>/<basename>.node` plus a
 * `<basename>.sha256` sidecar with the observed digest. Dir 0700, files 0600,
 * both written atomically (sidecar last: a torn write at worst drops the
 * sidecar, and a cache entry without a sidecar is treated as absent).
 */
export function writeCacheEntry(cacheRoot, version, basename, sourceNodePath, observedSha256) {
  const { dir, nodePath, shaPath } = cacheEntryPaths(cacheRoot, version, basename);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir mode is umask-filtered; pin it explicitly
  atomicWrite(nodePath, (tmp) => copyFileSync(sourceNodePath, tmp), 0o600);
  atomicWrite(shaPath, (tmp) => writeFileSync(tmp, `${observedSha256}\n`), 0o600);
}

/**
 * Evaluate the cache entry for `<version>/<basename>` without using it yet.
 *
 * A hit requires: the .node exists, its sha256 matches the sidecar, AND (when
 * the version is listed in the manifest) the manifest digest too. Anything
 * else is a miss — the cached copy is not used but also not deleted here.
 * An unlisted-but-self-consistent entry TOFU-hits with a warning (≤1 per run:
 * this is called at most once per install).
 */
export function readCacheEntry(cacheRoot, version, basename, manifest) {
  const { nodePath, shaPath } = cacheEntryPaths(cacheRoot, version, basename);
  if (!existsSync(nodePath)) {
    return { hit: false, reason: "absent" };
  }
  let observed;
  try {
    observed = sha256FileSync(nodePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} could not hash cached crypto binding ${nodePath}: ${message}`);
    return { hit: false, reason: "unreadable" };
  }
  let sidecar;
  try {
    sidecar = readFileSync(shaPath, "utf8").trim().toLowerCase();
  } catch {
    return { hit: false, reason: "sidecar-missing" };
  }
  if (!SHA256_HEX.test(sidecar) || sidecar !== observed) {
    return { hit: false, reason: "sidecar-mismatch", observed };
  }
  const key = `${version}/${basename}`;
  const listed = manifestLookup(manifest, key);
  if (listed.listed) {
    if (listed.expected === null || listed.expected !== observed) {
      return { hit: false, reason: "manifest-mismatch", observed };
    }
    return { hit: true, nodePath, sha256: observed, verified: "manifest" };
  }
  manifestNag(key, observed);
  return { hit: true, nodePath, sha256: observed, verified: "tofu" };
}

/** Atomically copy a verified cache entry back into the crypto package dir. */
export function restoreBindingFromCache(cryptoDir, basename, cacheNodePath) {
  const target = `${cryptoDir}/${basename}.node`;
  atomicWrite(target, (tmp) => copyFileSync(cacheNodePath, tmp), 0o644);
  return target;
}

/**
 * Verify a freshly downloaded binding against the manifest. Pure verdict: the
 * caller decides what to delete. Verdicts:
 *   manifest-match   digest matches the manifest — accept.
 *   manifest-mismatch listed digest differs — caller must DELETE the artifact
 *                    and degrade E2EE; the binary must never be loaded.
 *   manifest-miss    version not listed — TOFU accept; caller warns.
 */
export function verifyDownloadedBinding(nodePath, manifestKey, manifest) {
  const observed = sha256FileSync(nodePath);
  const listed = manifestLookup(manifest, manifestKey);
  if (!listed.listed) {
    return { verdict: "manifest-miss", observed, expected: null };
  }
  if (listed.expected === null || listed.expected !== observed) {
    return { verdict: "manifest-mismatch", observed, expected: listed.expected };
  }
  return { verdict: "manifest-match", observed, expected: listed.expected };
}

/**
 * Orchestration. All inputs are injectable so tests run in temp dirs; the
 * no-argument call keeps the exact pre-cache behaviour contract:
 * `{ok, downloaded, reason?}` with failures warned, never thrown.
 *
 * @param {{
 *   cryptoDir?: string | null,
 *   basename?: string | null,
 *   cacheRoot?: string,
 *   manifestPath?: string,
 *   runDownloader?: (cryptoDir: string) => void,
 * }} [options]
 */
export function ensureCryptoNative(options = {}) {
  const {
    cryptoDir = resolveCryptoPackageDir(),
    basename = nativeBindingBasename(),
    cacheRoot = defaultCacheRoot(),
    manifestPath = defaultManifestPath(),
    runDownloader = runNativeDownloader,
  } = options;

  if (!cryptoDir) {
    console.warn(
      `${LOG_PREFIX} crypto package not found — can't verify native binding; continuing (E2EE may be unavailable).`
    );
    return { ok: false, reason: "crypto-package-not-found" };
  }

  if (!isNativeBindingMissing(cryptoDir, basename)) {
    // Already present (either downloaded once, or platform unsupported).
    // Deliberately no post-hoc verification of an existing binding.
    return { ok: true, downloaded: false };
  }

  const version = readCryptoPackageVersion(cryptoDir);
  const manifest = readManifest(manifestPath);
  const key = version !== null && basename !== null ? `${version}/${basename}` : null;

  // 1) Warm cache: restore a verified copy without touching the network.
  if (key !== null) {
    let entry;
    try {
      entry = readCacheEntry(cacheRoot, version, basename, manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} cache lookup failed: ${message} — falling back to download.`);
      entry = { hit: false };
    }
    if (entry.hit) {
      try {
        restoreBindingFromCache(cryptoDir, basename, entry.nodePath);
        console.info(
          `${LOG_PREFIX} crypto native binding (${basename}.node) restored from local cache ` +
            `(${key}, sha256 ${entry.sha256}) — no download needed.`
        );
        return { ok: true, downloaded: false, restoredFromCache: true, verified: entry.verified };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `${LOG_PREFIX} could not restore crypto binding from cache: ${message} — falling back to download.`
        );
      }
    }
  }

  // 2) Cache miss: run the upstream downloader (inherits proxy env).
  console.info(
    `${LOG_PREFIX} crypto native binding (${basename}.node) missing — downloading (POSTINSTALL due to npm 11 allow-scripts).`
  );
  try {
    runDownloader(cryptoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `${LOG_PREFIX} could not auto-download crypto native binding: ${message}\n` +
        `  The bridge may still run without E2EE. To install manually:\n` +
        `  cd ${cryptoDir} && node download-lib.js`
    );
    return { ok: false, reason: "download-failed" };
  }

  // 3) Verify the downloaded binary before accepting it (or caching it).
  const nodePath = `${cryptoDir}/${basename}.node`;
  let check;
  try {
    check = verifyDownloadedBinding(nodePath, key, manifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `${LOG_PREFIX} could not verify downloaded crypto binding (${nodePath}): ${message} — ` +
        `continuing without it (E2EE may be unavailable).`
    );
    return { ok: false, reason: "verify-failed" };
  }

  if (check.verdict === "manifest-mismatch") {
    // Never load an unverified native binary. Delete and degrade.
    try {
      rmSync(nodePath, { force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} could not delete the unverified binding: ${message}`);
    }
    console.warn(
      `${LOG_PREFIX} downloaded crypto binding ${key} FAILED sha256 verification ` +
        `(expected ${check.expected}, observed ${check.observed}) — file deleted, ` +
        `continuing WITHOUT native E2EE crypto (the bridge still runs, encrypted ` +
        `rooms will be unreadable). Possible tampering or upstream asset change.`
    );
    return { ok: false, reason: "hash-mismatch", verified: "rejected" };
  }

  if (check.verdict === "manifest-miss" && key !== null) {
    manifestNag(key, check.observed);
  }

  // 4) Best-effort: stash the verified copy for future installs.
  if (key !== null) {
    try {
      writeCacheEntry(cacheRoot, version, basename, nodePath, check.observed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} could not cache the crypto binding: ${message}`);
    }
  }

  return {
    ok: true,
    downloaded: true,
    verified: check.verdict === "manifest-match" ? "manifest" : "tofu",
  };
}

// Allow running both as a bin and importing the named exports for tests.
if (process.argv[1] && process.argv[1].endsWith("ensure-crypto-native.mjs")) {
  ensureCryptoNative();
}
