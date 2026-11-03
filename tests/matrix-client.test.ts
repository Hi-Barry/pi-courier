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
  let storePaths: { storagePath: string; cryptoDir: string };
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier.mclient-")));
    // 存储路径注入缝(spec #258 票03):组合根传布局解析的 dataDir 叶子;
    // 测试注入临时路径,SDK 存储不再耦合真实 ~/.pi。
    const dataDir = path.join(home, "data", "pi-courier");
    storePaths = { storagePath: path.join(dataDir, "matrix-store.json"), cryptoDir: path.join(dataDir, "matrix-crypto") };
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cryptoStorage.impl = null;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function makeClient(overrides: Record<string, unknown> = {}) {
    return createMatrixClient(
      {
        homeserverUrl: "http://localhost:8008",
        accessToken: "test-token",
        ...overrides,
      },
      storePaths
    );
  }

  it("missing store paths is a wiring bug — throws loudly (no legacy fallback)", () => {
    expect(() =>
      createMatrixClient({ homeserverUrl: "http://localhost:8008", accessToken: "t" }, undefined as never)
    ).toThrow(/storage paths are required/i);
  });

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

  it("an unidentifiable undefined rejection propagates — degradation stays reserved for native-load failures", () => {
    cryptoStorage.impl = () => {
      throw undefined; // eslint-disable-line no-throw-literal
    };

    expect(() => makeClient()).toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("any OTHER construction failure propagates (no silent E2EE loss)", () => {
    cryptoStorage.impl = () => {
      throw new Error("EACCES: crypto store path not writable");
    };

    expect(() => makeClient()).toThrow("EACCES: crypto store path not writable");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("sendReaction:发 m.reaction 事件,m.relates_to 为 annotation 三元组,事件 id 穿出(票01 #268)", async () => {
    // encryption:false 绕开 crypto 构造(SDK 对 mock 的 crypto 类会拒绝实例化;
    // reaction 原语与 crypto 无关,E2EE 加密由 sendEvent 自身处理)
    const client = makeClient({ encryption: false });
    // 端口类型不含 SDK 的 sendEvent 成员名;运行时它是同一个真 SDK 实例,
    // 经结构化断言取回 sendEvent 引用做 spy(工厂直返 client,同一引用必命中)。
    const sdk = client as unknown as {
      sendEvent: (roomId: string, eventType: string, content: unknown) => Promise<string>;
    };
    const sendEvent = vi.spyOn(sdk, "sendEvent").mockResolvedValue("$reaction-1");

    await expect(client.sendReaction("!room:server", "$orig-1", "✅")).resolves.toBe("$reaction-1");
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith("!room:server", "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", event_id: "$orig-1", key: "✅" },
    });
  });

  it("sendReaction:SDK 错误照常上抛(失败降级由调用方负责)", async () => {
    const client = makeClient({ encryption: false });
    const sdk = client as unknown as {
      sendEvent: (roomId: string, eventType: string, content: unknown) => Promise<string>;
    };
    vi.spyOn(sdk, "sendEvent").mockRejectedValue(new Error("M_LIMIT_EXCEEDED"));

    await expect(client.sendReaction("!room:server", "$orig-1", "❌")).rejects.toThrow(
      "M_LIMIT_EXCEEDED"
    );
  });
});
