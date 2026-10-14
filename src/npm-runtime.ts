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
