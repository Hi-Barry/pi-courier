/**
 * 配置向导「出网代理」可选步骤(spec #201 票 #205,缝 B 假 stdin):
 * 完整跑 runSetup,输入经 fake stdin(与 tests/setup-prompter.test.ts 同一
 * EOF 协议)按行喂入;config 读写、whoami fetch、进程 env 全部打桩,
 * 向导产出的 merged 配置直接喂回 resolveProxySettings 断言往返一致。
 * HOME 重定向到一次性临时目录:即使打桩失效也绝无写真实 ~/.pi 的可能。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgBridgeConfig } from "../src/types.js";

/** 向导默认值全部可回车沿用的既有配置(language 定 zh,提示词断言随之)。 */
const FIXTURE: MsgBridgeConfig = {
  language: "zh",
  matrix: {
    homeserverUrl: "https://matrix.example.org",
    accessToken: "syt_kept_token",
    encryption: false,
  },
  auth: { trustedUsers: ["matrix:@boss:example.org"], adminUserId: "matrix:@boss:example.org" },
  deviceId: "PICOURIERTEST01",
  workdir: "/tmp/proj",
  instanceName: "testbox",
  attachments: { directory: "/tmp/att", maxMb: 10 },
  multiProject: false,
};

describe("setup 向导·出网代理步骤(票 #205)", () => {
  let handlers: Record<string, Array<(arg?: unknown) => void>>;
  let fakeHome: string;
  let fixture: MsgBridgeConfig;
  let saved: MsgBridgeConfig | undefined;
  let stdoutWrite: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    handlers = {};
    fixture = structuredClone(FIXTURE);
    saved = undefined;
    // 双保险:~/.pi 重定向到一次性临时目录(打桩失效也不碰真实配置)。
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-setup-proxy-"));
    vi.stubEnv("HOME", fakeHome);
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 沿用 token 路径的 whoami 打桩:向导不发任何网络请求。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ user_id: "@bot:example.org" }) })),
    );
    const fakeStdin = {
      isTTY: false,
      setEncoding: vi.fn(),
      on: (ev: string, fn: (arg?: unknown) => void) => {
        (handlers[ev] ??= []).push(fn);
      },
      once: (ev: string, fn: (arg?: unknown) => void) => {
        (handlers[ev] ??= []).push(fn);
      },
      removeAllListeners: vi.fn(),
    };
    vi.doMock("node:process", () => ({ stdin: fakeStdin, stdout: process.stdout }));
    vi.doMock("../src/config.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/config.js")>();
      return {
        ...actual,
        loadConfig: () => structuredClone(fixture),
        saveConfig: (cfg: MsgBridgeConfig) => {
          saved = cfg;
        },
      };
    });
    // 本机 shell 可能预置真实代理变量(如小写 http_proxy):全部清零,
    // 每个用例只显式摆出自己需要的值。
    for (const name of [
      "https_proxy",
      "HTTPS_PROXY",
      "http_proxy",
      "HTTP_PROXY",
      "no_proxy",
      "NO_PROXY",
    ]) {
      vi.stubEnv(name, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  /** 代理两问之前的全部回车(11 问,沿用 fixture 默认值)。 */
  const baseLines = (): string[] => Array<string>(11).fill("");

  async function runWithInput(lines: string[]) {
    const { runSetup } = await import("../src/setup");
    const { resolveProxySettings } = await import("../src/proxy.js");
    const running = runSetup();
    handlers.data!.forEach((f) => f(`${lines.join("\n")}\n`));
    handlers.end!.forEach((f) => f());
    await running;
    expect(saved).toBeDefined(); // 走到了保存(行序错位/打桩失效都会在这暴露)
    expect(errorSpy).not.toHaveBeenCalled(); // 向导整体未失败
    return { resolveProxySettings };
  }

  it("环境已有代理变量:检测值提示为默认,回车采纳并写入配置(往返一致)", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://env-proxy:3128");
    vi.stubEnv("NO_PROXY", "localhost,.internal");
    const { resolveProxySettings } = await runWithInput([...baseLines(), "", ""]);
    expect(saved?.proxy).toBe("http://env-proxy:3128");
    expect(saved?.noProxy).toEqual(["localhost", ".internal"]);
    // 往返一致:向导产物必须被票 1 解析器当作 config 来源原样消费。
    expect(resolveProxySettings(saved!, {})).toEqual({
      proxy: "http://env-proxy:3128",
      noProxy: ["localhost", ".internal"],
      source: "config",
    });
  });

  it("正常填写:proxy 去空白、逗号分隔 noProxy 拆分写入(往返一致)", async () => {
    const { resolveProxySettings } = await runWithInput([
      ...baseLines(),
      " http://my-proxy:8080 ",
      " a.internal , b.org ,",
    ]);
    expect(saved?.proxy).toBe("http://my-proxy:8080");
    expect(saved?.noProxy).toEqual(["a.internal", "b.org"]);
    expect(resolveProxySettings(saved!, {})).toEqual({
      proxy: "http://my-proxy:8080",
      noProxy: ["a.internal", "b.org"],
      source: "config",
    });
  });

  it("非法 scheme 当场重问:打印双语错误,二次输入生效", async () => {
    const { resolveProxySettings } = await runWithInput([
      ...baseLines(),
      "socks5://bad:1080",
      "https://good:8443",
      "",
    ]);
    // 代理提问出现了两次(首次被拒后重问)
    const prompts = stdoutWrite.mock.calls.map((c) => String(c[0]));
    expect(prompts.filter((p) => p.includes("出网代理 URL")).length).toBe(2);
    // 拒绝时打印的是 resolveProxySettings 的双语人话(点名值与 scheme 规则)
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("socks5://bad:1080");
    expect(logged).toContain("http/https");
    expect(saved?.proxy).toBe("https://good:8443");
    expect(saved?.noProxy).toEqual([]);
    expect(resolveProxySettings(saved!, {})).toEqual({
      proxy: "https://good:8443",
      noProxy: [],
      source: "config",
    });
  });

  it("留空跳过:配置里不出现 proxy/noProxy 键,解析器给 none", async () => {
    const { resolveProxySettings } = await runWithInput([...baseLines(), ""]);
    expect("proxy" in saved!).toBe(false);
    expect("noProxy" in saved!).toBe(false);
    expect(resolveProxySettings(saved!, {}).source).toBe("none");
  });

  it("existing 配置已有代理:回车全沿用(proxy 与 noProxy 默认一起带出)", async () => {
    fixture = { ...fixture, proxy: "http://kept:1", noProxy: ["kept.internal"] };
    const { resolveProxySettings } = await runWithInput([...baseLines(), "", ""]);
    expect(saved?.proxy).toBe("http://kept:1");
    expect(saved?.noProxy).toEqual(["kept.internal"]);
    expect(resolveProxySettings(saved!, {})).toEqual({
      proxy: "http://kept:1",
      noProxy: ["kept.internal"],
      source: "config",
    });
  });

  it("env 变量非法(scheme 不支持):提示后按无默认继续,回车跳过不写键", async () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://broken:1");
    await runWithInput([...baseLines(), ""]);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("socks5://broken:1");
    expect("proxy" in saved!).toBe(false);
    expect("noProxy" in saved!).toBe(false);
  });
});
