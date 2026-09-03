/** Type declarations for scripts/ensure-crypto-native.mjs (postinstall self-check). */

export interface EnsureResult {
  ok: boolean;
  downloaded?: boolean;
  reason?: string;
}

export function nativeBindingBasename(): string | null;

export function isMusl(): boolean;

export function resolveCryptoPackageDir(): string | null;

export function isNativeBindingMissing(cryptoDir: string, basename: string | null): boolean;

export function runNativeDownloader(cryptoDir: string): void;

export function ensureCryptoNative(): EnsureResult;