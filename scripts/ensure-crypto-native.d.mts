/** Type declarations for scripts/ensure-crypto-native.mjs (postinstall self-check). */

export interface EnsureResult {
  ok: boolean;
  downloaded?: boolean;
  reason?: string;
  /** True when the binding was restored from the local cache (no download). */
  restoredFromCache?: boolean;
  /** How the binary's sha256 was checked: manifest match, TOFU accept, or rejected. */
  verified?: "manifest" | "tofu" | "rejected";
}

/** Options for ensureCryptoNative(); all optional, defaulting to real resolution. */
export interface EnsureCryptoNativeOptions {
  cryptoDir?: string | null;
  basename?: string | null;
  cacheRoot?: string;
  manifestPath?: string;
  runDownloader?: (cryptoDir: string) => void;
}

/** Cache entry layout under the cache root. */
export interface CacheEntryPaths {
  dir: string;
  nodePath: string;
  shaPath: string;
}

/** Result of evaluating a cache entry (readCacheEntry). */
export interface CacheEntryResult {
  hit: boolean;
  nodePath?: string;
  sha256?: string;
  verified?: "manifest" | "tofu";
  reason?: "absent" | "unreadable" | "sidecar-missing" | "sidecar-mismatch" | "manifest-mismatch";
}

/** Verdict of verifyDownloadedBinding against the sha256 manifest. */
export interface VerifyDownloadedResult {
  verdict: "manifest-match" | "manifest-mismatch" | "manifest-miss";
  observed: string;
  expected: string | null;
}

export function nativeBindingBasename(): string | null;

export function isMusl(): boolean;

export function resolveCryptoPackageDir(): string | null;

export function isNativeBindingMissing(cryptoDir: string, basename: string | null): boolean;

export function runNativeDownloader(cryptoDir: string): void;

export function defaultCacheRoot(
  env?: Record<string, string | undefined>,
  home?: string
): string;

export function defaultManifestPath(): string;

export function cacheEntryPaths(
  cacheRoot: string,
  version: string,
  basename: string
): CacheEntryPaths;

export function sha256FileSync(filePath: string): string;

export function readCryptoPackageVersion(cryptoDir: string): string | null;

/** Returns {} on missing/malformed manifest (warns); never throws. */
export function readManifest(manifestPath: string): Record<string, string>;

export function readCacheEntry(
  cacheRoot: string,
  version: string,
  basename: string,
  manifest: Record<string, string>
): CacheEntryResult;

export function writeCacheEntry(
  cacheRoot: string,
  version: string,
  basename: string,
  sourceNodePath: string,
  observedSha256: string
): void;

export function restoreBindingFromCache(
  cryptoDir: string,
  basename: string,
  cacheNodePath: string
): string;

export function verifyDownloadedBinding(
  nodePath: string,
  manifestKey: string | null,
  manifest: Record<string, string>
): VerifyDownloadedResult;

export function ensureCryptoNative(options?: EnsureCryptoNativeOptions): EnsureResult;
