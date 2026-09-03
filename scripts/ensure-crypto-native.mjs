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
 * Usage (from package root): node scripts/ensure-crypto-native.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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

export function ensureCryptoNative() {
  const basename = nativeBindingBasename();
  const cryptoDir = resolveCryptoPackageDir();

  if (!cryptoDir) {
    console.warn(
      "[pi-courier] crypto package not found — can't verify native binding; continuing (E2EE may be unavailable)."
    );
    return { ok: false, reason: "crypto-package-not-found" };
  }

  if (!isNativeBindingMissing(cryptoDir, basename)) {
    // Already present (either downloaded once, or platform unsupported).
    return { ok: true, downloaded: false };
  }

  console.info(
    `[pi-courier] crypto native binding (${basename}.node) missing — downloading (POSTINSTALL due to npm 11 allow-scripts).`
  );
  try {
    runNativeDownloader(cryptoDir);
    return { ok: true, downloaded: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[pi-courier] could not auto-download crypto native binding: ${message}\n` +
        `  The bridge may still run without E2EE. To install manually:\n` +
        `  cd ${cryptoDir} && node download-lib.js`
    );
    return { ok: false, reason: "download-failed" };
  }
}

// Allow running both as a bin and importing the named exports for tests.
if (process.argv[1] && process.argv[1].endsWith("ensure-crypto-native.mjs")) {
  ensureCryptoNative();
}