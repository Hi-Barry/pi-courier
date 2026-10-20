/**
 * 代理决策纯函数直测(spec #201 票 #202,缝 A):优先级、env 兜底、
 * 大小写变量、scheme 白名单、来源标记、非法输入全部集中在这里锁定。
 * 决策规则只存在于 src/proxy.ts —— 本文件是它的行为规格。
 */
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../src/i18n/index.js";
import { resolveProxySettings } from "../src/proxy.js";

describe("resolveProxySettings", () => {
  it("config wins over env, source=config", () => {
    const result = resolveProxySettings(
      { proxy: "http://config-proxy:1", noProxy: ["a.internal"] },
      { HTTPS_PROXY: "http://env-proxy:2", NO_PROXY: "localhost" },
    );
    expect(result).toEqual({
      proxy: "http://config-proxy:1",
      noProxy: ["a.internal"],
      source: "config",
    });
  });

  it("falls back to env when config has no proxy, source=env", () => {
    const result = resolveProxySettings(
      {},
      { HTTPS_PROXY: "http://env-proxy:2", NO_PROXY: "localhost,.internal" },
    );
    expect(result).toEqual({
      proxy: "http://env-proxy:2",
      noProxy: ["localhost", ".internal"],
      source: "env",
    });
  });

  it("resolves to nothing when neither config nor env has a proxy, source=none", () => {
    expect(resolveProxySettings({}, {})).toEqual({
      proxy: undefined,
      noProxy: [],
      source: "none",
    });
  });

  it("recognizes each env variable spelling on its own", () => {
    for (const [env, expected] of [
      [{ https_proxy: "http://a:1" }, "http://a:1"],
      [{ HTTPS_PROXY: "http://a:1" }, "http://a:1"],
      [{ http_proxy: "http://a:1" }, "http://a:1"],
      [{ HTTP_PROXY: "http://a:1" }, "http://a:1"],
    ] as const) {
      expect(resolveProxySettings({}, env)).toEqual({
        proxy: expected,
        noProxy: [],
        source: "env",
      });
    }
  });

  it("prefers lowercase over uppercase and https over http among env vars", () => {
    expect(
      resolveProxySettings(
        {},
        { https_proxy: "http://lower:1", HTTPS_PROXY: "http://upper:2" },
      ).proxy,
    ).toBe("http://lower:1");
    expect(
      resolveProxySettings(
        {},
        { HTTPS_PROXY: "http://https:1", HTTP_PROXY: "http://http:2" },
      ).proxy,
    ).toBe("http://https:1");
    expect(
      resolveProxySettings(
        {},
        { http_proxy: "http://lower-http:1", HTTP_PROXY: "http://upper-http:2" },
      ).proxy,
    ).toBe("http://lower-http:1");
  });

  it("trims surrounding whitespace off the effective proxy; blanks count as unset", () => {
    expect(resolveProxySettings({ proxy: "  http://padded:1  " }, {}).proxy).toBe("http://padded:1");
    // 空串/纯空白 = 未配置:回落 env 兜底
    expect(resolveProxySettings({ proxy: "" }, { HTTP_PROXY: "http://env:1" }).proxy).toBe("http://env:1");
    expect(resolveProxySettings({ proxy: "   " }, { HTTP_PROXY: "http://env:1" }).proxy).toBe("http://env:1");
    // env 空串跳过,取下一个候选
    expect(resolveProxySettings({}, { HTTPS_PROXY: "", http_proxy: "http://next:1" }).proxy).toBe(
      "http://next:1",
    );
  });

  it("accepts http/https schemes from either origin", () => {
    expect(resolveProxySettings({ proxy: "http://p:1" }, {}).source).toBe("config");
    expect(resolveProxySettings({ proxy: "https://p:1" }, {}).source).toBe("config");
    expect(resolveProxySettings({}, { HTTP_PROXY: "http://p:1" }).source).toBe("env");
    expect(resolveProxySettings({}, { HTTP_PROXY: "https://p:1" }).source).toBe("env");
  });

  it("rejects non-whitelisted schemes from config", () => {
    for (const bad of ["socks5://g:1", "ftp://g:1", "example.com:3128", "not a url"]) {
      expect(() => resolveProxySettings({ proxy: bad }, {})).toThrowError(/http\/https/);
    }
  });

  it("rejects non-whitelisted schemes from env too (origin-agnostic)", () => {
    expect(() => resolveProxySettings({}, { HTTPS_PROXY: "socks5://g:1" })).toThrowError(/http\/https/);
    expect(() => resolveProxySettings({}, { http_proxy: "socks5://g:1" })).toThrowError(/http\/https/);
  });

  it("config proxy without noProxy means NO exemptions (env NO_PROXY ignored)", () => {
    const result = resolveProxySettings(
      { proxy: "http://config:1" },
      { NO_PROXY: "localhost" },
    );
    expect(result.noProxy).toEqual([]);
  });

  it("explicit empty config noProxy stays empty; entries pass through as-is", () => {
    expect(resolveProxySettings({ proxy: "http://c:1", noProxy: [] }, {}).noProxy).toEqual([]);
    expect(
      resolveProxySettings({ proxy: "http://c:1", noProxy: ["intra.example.com", "10.0.0.0/8"] }, {})
        .noProxy,
    ).toEqual(["intra.example.com", "10.0.0.0/8"]);
  });

  it("config noProxy wins over env NO_PROXY when the proxy falls back to env", () => {
    const result = resolveProxySettings(
      { noProxy: ["from-config"] },
      { HTTP_PROXY: "http://env:1", NO_PROXY: "from-env" },
    );
    expect(result).toEqual({ proxy: "http://env:1", noProxy: ["from-config"], source: "env" });
  });

  it("parses env NO_PROXY comma list (lowercase wins, entries trimmed, empties dropped)", () => {
    expect(resolveProxySettings({}, { HTTP_PROXY: "http://e:1", no_proxy: " a.internal , b , " }).noProxy).toEqual([
      "a.internal",
      "b",
    ]);
    expect(resolveProxySettings({}, { HTTP_PROXY: "http://e:1", NO_PROXY: "upper" }).noProxy).toEqual(["upper"]);
    // env 代理但完全没有 NO_PROXY → 空豁免
    expect(resolveProxySettings({}, { HTTP_PROXY: "http://e:1" }).noProxy).toEqual([]);
  });

  it("no exemptions when nothing is in effect (noProxy without a proxy is inert)", () => {
    expect(resolveProxySettings({ noProxy: ["intra"] }, {})).toEqual({
      proxy: undefined,
      noProxy: [],
      source: "none",
    });
  });
});

describe("resolveProxySettings 错误信息双语齐全", () => {
  afterEach(() => {
    // tests/setup.ts 全局锚 zh;这里临时切 en 后必须还原,避免污染同文件后续断言。
    setLocale("zh");
  });

  it("zh error names the value and origin, says only http/https is supported", () => {
    setLocale("zh");
    expect(() => resolveProxySettings({ proxy: "socks5://g:1" }, {})).toThrow(
      /socks5:\/\/g:1/,
    );
    expect(() => resolveProxySettings({ proxy: "socks5://g:1" }, {})).toThrow(
      /config\.proxy/,
    );
    expect(() => resolveProxySettings({ proxy: "socks5://g:1" }, {})).toThrow(
      /http\/https/,
    );
  });

  it("en error names the value and origin, says only http/https is supported", () => {
    setLocale("en");
    expect(() =>
      resolveProxySettings({}, { HTTPS_PROXY: "socks5://g:1" }),
    ).toThrow(/socks5:\/\/g:1/);
    expect(() =>
      resolveProxySettings({}, { HTTPS_PROXY: "socks5://g:1" }),
    ).toThrow(/HTTPS_PROXY/);
    expect(() =>
      resolveProxySettings({}, { HTTPS_PROXY: "socks5://g:1" }),
    ).toThrow(/http\/https/);
  });
});
