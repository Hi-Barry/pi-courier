/**
 * createMatrixClient E2EE degradation contract (audit batch 1 票10): the
 * crypto storage constructor is the only place E2EE silently turns itself
 * off — that is reserved for the ONE expected failure (the native binding
 * failing to load). Any other construction failure propagates loudly, and
 * non-Error rejections render readable in the log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "../src/logger.js";
import { createMatrixClient } from "../src/transports/matrix-client.js";

const cryptoStorage = vi.hoisted(() => ({
  /** Per-test construction behavior; null = succeed silently. */
  impl: null as ((...args: unknown[]) => void) | null,
}));

vi.mock("matrix-bot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("matrix-bot-sdk")>();
  class FakeRustSdkCryptoStorageProvider {
    constructor(...args: unknown[]) {
      cryptoStorage.impl?.(...args);
    }
  }
  return {
    ...actual,
    RustSdkCryptoStorageProvider: FakeRustSdkCryptoStorageProvider,
    // The enum is a types-only re-export on some builds — the mocked ctor
    // ignores its arguments, any placeholder satisfies the import.
    RustSdkCryptoStoreType: { Sqlite: 1 },
  };
});

describe("createMatrixClient E2EE degradation (audit batch 1 票10)", () => {
  let home: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier.mclient-")));
    fs.mkdirSync(path.join(home, ".pi"), { recursive: true });
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cryptoStorage.impl = null;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function makeClient(overrides: Record<string, unknown> = {}) {
    return createMatrixClient({
      homeserverUrl: "http://localhost:8008",
      accessToken: "test-token",
      ...overrides,
    });
  }

  it("native binding load failure (ERR_DLOPEN_FAILED): degrades with an error-level log", () => {
    const err = new Error("Could not locate the bindings file") as NodeJS.ErrnoException;
    err.code = "ERR_DLOPEN_FAILED";
    cryptoStorage.impl = () => {
      throw err;
    };

    const client = makeClient();

    expect(client).toBeDefined();
    expect(client.crypto).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("native binding failed to load"),
      expect.anything()
    );
  });

  it("MODULE_NOT_FOUND and message-based dlopen text also degrade", () => {
    const err = new Error("Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs'") as NodeJS.ErrnoException;
    err.code = "MODULE_NOT_FOUND";
    cryptoStorage.impl = () => {
      throw err;
    };
    expect(makeClient()).toBeDefined();

    cryptoStorage.impl = () => {
      throw new Error("dlopen failed: incompatible architecture");
    };
    expect(makeClient()).toBeDefined();
  });

  it("a non-Error rejection still renders a readable log line (no literal undefined)", () => {
    cryptoStorage.impl = () => {
      throw "dlopen failed: some plain string reason"; // eslint-disable-line no-throw-literal
    };

    expect(makeClient()).toBeDefined();
    const logged = errorSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("dlopen failed: some plain string reason");
    expect(logged).not.toContain("undefined");
  });

  it("any OTHER construction failure propagates (no silent E2EE loss)", () => {
    cryptoStorage.impl = () => {
      throw new Error("EACCES: crypto store path not writable");
    };

    expect(() => makeClient()).toThrow("EACCES: crypto store path not writable");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
