/**
 * npm global-layout resolution for the CLI's self-update path.
 *
 * Why this exists: `pi-courier update` used to spawn npm directly
 * (`spawnSync("npm", ...)`), which fails on Windows with ENOENT — libuv's
 * PATH search only tries .com/.exe and never resolves npm.cmd. Spawning
 * `node <npm-cli.js>` instead works on every platform, and resolving the
 * same npm that ships with the running node keeps POSIX behavior identical.
 *
 * Kept free of cli.ts imports (cli.ts runs main() at module load) so these
 * helpers stay unit-testable in isolation.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/**
 * Locate npm's JS entry (npm-cli.js) next to a node binary. Two layouts:
 *  - `<nodeDir>/node_modules/npm/bin/npm-cli.js` — Windows installs
 *    (npm's Windows prefix lives beside node.exe)
 *  - `<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js` — Unix global
 *    layout, one extra `lib` level
 *
 * Returns undefined when neither exists; callers fall back to the bare
 * "npm" command so exotic layouts keep the historical behavior.
 * Parameterized on the node exec path for unit tests.
 */
export function resolveNpmCli(nodeExecPath: string): string | undefined {
  const nodeDir = path.dirname(nodeExecPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Environment inputs for {@link globalNodeModulesDir} (injectable for tests). */
export interface GlobalNodeModulesEnv {
  platform: NodeJS.Platform;
  /** process.execPath of the running node binary */
  execPath: string;
  /** %APPDATA% (Windows only; falls back to <home>/AppData/Roaming when unset) */
  appData?: string;
  /** os.homedir() */
  homeDir: string;
}

/**
 * npm's global node_modules directory:
 *  - win32: `%APPDATA%\npm\node_modules` (npm's default prefix on Windows;
 *    historically this code hard-coded the POSIX prefix and never matched)
 *  - POSIX: `<nodeDir>/../lib/node_modules` — the long-standing Unix global
 *    layout, unchanged.
 */
export function globalNodeModulesDir(env: GlobalNodeModulesEnv): string {
  if (env.platform === "win32") {
    const appData = env.appData ?? path.join(env.homeDir, "AppData", "Roaming");
    return path.join(appData, "npm", "node_modules");
  }
  return path.join(path.dirname(env.execPath), "..", "lib", "node_modules");
}

/**
 * Resolve the installed crypto package directory from a package root, using
 * Node's own module resolution instead of guessing a global prefix.
 *
 * Why: npm 11 global installs use the shallow layout — dependencies live in
 * <packageRoot>/node_modules, not at the global prefix root. Hoisted layouts
 * put them in an ancestor node_modules. `createRequire` from the package's
 * package.json follows both (and custom prefixes) by construction.
 *
 * Returns undefined when the package is not installed / cannot be resolved.
 */
export function resolveCryptoPackageDirFrom(packageRoot: string): string | undefined {
  try {
    const requireFromPackage = createRequire(path.resolve(packageRoot, "package.json"));
    const pkgJsonPath = requireFromPackage.resolve(
      "@matrix-org/matrix-sdk-crypto-nodejs/package.json",
    );
    return path.dirname(pkgJsonPath);
  } catch {
    return undefined;
  }
}

/** True when the crypto package's native binding (.node) exists for this install. */
export function nativeBindingExists(packageRoot: string): boolean {
  const cryptoDir = resolveCryptoPackageDirFrom(packageRoot);
  if (cryptoDir === undefined) return false;
  try {
    return fs.readdirSync(cryptoDir).some((entry) => entry.endsWith(".node"));
  } catch {
    return false;
  }
}
