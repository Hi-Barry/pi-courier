/**
 * npm global-layout resolution for the CLI's self-update path.
 *
 * Why this exists: `pi-courier update` used to spawn npm directly
 * (`spawnSync("npm", ...)`), which fails on Windows with ENOENT — libuv's
 * PATH search only tries .com/.exe and never resolves npm.cmd. Spawning
 * `node <npm-cli.js>` instead works on every platform, and resolving the
 * same npm that ships with the running node keeps POSIX behavior identical.
 *
 * Also resolves the crypto native-binding package from a package root (#320):
 * `createRequire` follows npm 11's shallow global layout (deps nested under
 * the package) and hoisted layouts, instead of guessing a global prefix.
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

/** Platforms where matrix-sdk-crypto-nodejs publishes a native binding.
 *  Other platforms legitimately run without E2EE; the ensure script treats
 *  them as "fine", so verification must not fail the upgrade there. */
const NATIVE_BINDING_PLATFORMS = new Set<NodeJS.Platform>(["win32", "darwin", "linux"]);

/** True when the crypto package's native binding (.node) exists for this install.
 *  Unsupported platforms return true (no binding is expected there). */
export function nativeBindingExists(
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!NATIVE_BINDING_PLATFORMS.has(platform)) return true;
  const cryptoDir = resolveCryptoPackageDirFrom(packageRoot);
  if (cryptoDir === undefined) return false;
  try {
    return fs.readdirSync(cryptoDir).some((entry) => entry.endsWith(".node"));
  } catch {
    return false;
  }
}
