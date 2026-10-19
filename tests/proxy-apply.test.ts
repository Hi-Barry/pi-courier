/**
 * 代理启动接线测试(spec #201 票 #203)。
 *
 * 缝 B(纯注入):applyProxySettings 的环境覆写与调度器装配用假 env 和
 * spy installer 断言 —— 覆写内容(大小写两套、noProxy 语义)、装配时机
 * (覆写先于装配)、无代理零动作、校验失败不落任何副作用。
 *
 * 缝 C(真实集成):vitest 内起本地假 CONNECT 代理 + 假源站,真实装配后
 * 全局 fetch 真实经代理到达源站(代理侧连接计数断言);直连对照断言代理
 * 侧零连接。全程本地回环,零外网依赖。
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { applyProxySettings, type DispatcherInstaller, type ProxySettings } from "../src/proxy.js";
import { clearProxyEnv, restoreProxyEnv, saveProxyEnv } from "./proxy-env-fixture.js";

// ── 缝 B:注入式断言(不碰 process.env)─────────────────────────────────

/** spy installer:记录装配时机与被装配对象,装配瞬间的 env 快照一并存下。 */
function spyInstaller(env: NodeJS.ProcessEnv) {
  const calls: { agent: unknown; envSnapshot: NodeJS.ProcessEnv }[] = [];
  const install: DispatcherInstaller = (agent) => {
    calls.push({ agent, envSnapshot: { ...env } });
  };
  return { calls, install };
}

function fakeEnv(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...values };
}

describe("applyProxySettings 缝 B:环境覆写与调度器装配(注入)", () => {
  it("无代理时零动作:环境不动、调度器不装(遗留 NO_PROXY 原样保留)", () => {
    const env = fakeEnv({ NO_PROXY: "intra" });
    const spy = spyInstaller(env);
    const result = applyProxySettings({}, { env, installDispatcher: spy.install });
    expect(result).toEqual({ proxy: undefined, noProxy: [], source: "none" });
    expect(spy.calls).toHaveLength(0);
    expect(env.NO_PROXY).toBe("intra");
  });

  it("env 兜底:shell 遗留的小写 http_proxy 即生效代理,归一化为大小写两套", () => {
    const env = fakeEnv({ http_proxy: "http://shell-exported:9" });
    const spy = spyInstaller(env);
    const result = applyProxySettings({}, { env, installDispatcher: spy.install });
    expect(result).toEqual({ proxy: "http://shell-exported:9", noProxy: [], source: "env" });
    expect(spy.calls).toHaveLength(1);
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      expect(env[name]).toBe("http://shell-exported:9");
    }
    // 遗留 NO_PROXY 本来就不存在:覆写后依然不存在(无豁免)
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });

  it("config 代理生效:大小写两套全部覆写,遗留 NO_PROXY 被清(未填即无豁免)", () => {
    const env = fakeEnv({
      HTTP_PROXY: "http://old:1",
      https_proxy: "http://old:2",
      NO_PROXY: "leftover",
      no_proxy: "leftover",
    });
    const spy = spyInstaller(env);
    const result = applyProxySettings(
      { proxy: "http://config:1" },
      { env, installDispatcher: spy.install },
    );
    expect(result.source).toBe("config");
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      expect(env[name]).toBe("http://config:1");
    }
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });

  it("noProxy 填了:逗号串写大小写两套", () => {
    const env = fakeEnv();
    const spy = spyInstaller(env);
    applyProxySettings(
      { proxy: "http://config:1", noProxy: ["intra.example.com", "10.0.0.0/8"] },
      { env, installDispatcher: spy.install },
    );
    const joined = "intra.example.com,10.0.0.0/8";
    expect(env.NO_PROXY).toBe(joined);
    expect(env.no_proxy).toBe(joined);
  });

  it("env 兜底代理:同样归一化为大小写两套,noProxy 透传自 env 列表", () => {
    const env = fakeEnv({ https_proxy: "http://env:1", no_proxy: " a.internal , b " });
    const spy = spyInstaller(env);
    const result = applyProxySettings({}, { env, installDispatcher: spy.install });
    expect(result).toEqual({ proxy: "http://env:1", noProxy: ["a.internal", "b"], source: "env" });
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      expect(env[name]).toBe("http://env:1");
    }
    expect(env.NO_PROXY).toBe("a.internal,b");
    expect(env.no_proxy).toBe("a.internal,b");
  });

  it("装配时机:调度器装配发生在环境覆写完成之后", () => {
    const env = fakeEnv({ HTTP_PROXY: "http://old:1" });
    const spy = spyInstaller(env);
    applyProxySettings({ proxy: "http://config:1" }, { env, installDispatcher: spy.install });
    expect(spy.calls).toHaveLength(1);
    // 装配瞬间,覆写已落定 —— 消费方(request / undici)读到的一定是生效值
    expect(spy.calls[0].envSnapshot.http_proxy).toBe("http://config:1");
    expect(spy.calls[0].envSnapshot.HTTP_PROXY).toBe("http://config:1");
  });

  it("装配物是 undici EnvHttpProxyAgent", () => {
    const env = fakeEnv();
    const spy = spyInstaller(env);
    applyProxySettings({ proxy: "http://config:1" }, { env, installDispatcher: spy.install });
    expect(spy.calls[0].agent).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("校验失败:scheme 违规先抛错,环境与调度器零副作用", () => {
    const env = fakeEnv({ HTTPS_PROXY: "http://keep:1" });
    const spy = spyInstaller(env);
    let error: unknown;
    try {
      applyProxySettings({ proxy: "socks5://g:1" }, { env, installDispatcher: spy.install });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/socks5:\/\/g:1/);
    expect(env).toEqual({ HTTPS_PROXY: "http://keep:1" });
    expect(spy.calls).toHaveLength(0);
  });
});

// ── 缝 C:真实集成(本地假 CONNECT 代理 + 假源站,零外网)──────────────

/** 起服务并返回端口。 */
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** 收尾:先掐 keep-alive 连接再 close,undici 的连接池不留悬挂句柄。 */
async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 假 CONNECT 代理:对 connect 事件回 200 后把控制流与目标 socket 对接;
 *  记录隧道建立次数(非 CONNECT 的普通请求一律不算数、直接掐断)。 */
function createFakeConnectProxy() {
  let connects = 0;
  const server = http.createServer((_req, res) => {
    res.destroy();
  });
  server.on("connect", (req, clientSocket, head) => {
    connects += 1;
    const [host, port] = String(req.url).split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return { server, connectCount: () => connects };
}

/** applyProxySettings 装配会换全局 fetch / 调度器 —— 本 describe 的每个用例
 *  结束后都把全局调度器复位成默认直连,防止污染同进程的其他用例。 */
async function resetGlobalDispatcher(): Promise<void> {
  const dispatcher = getGlobalDispatcher();
  if (dispatcher instanceof EnvHttpProxyAgent) {
    await dispatcher.close().catch(() => {});
  }
  setGlobalDispatcher(new Agent());
}

/** 本机 shell 可能预置真实代理变量(如 http_proxy):缝 C 的用例触及
 *  process.env,六个键(全部可改动范围)用例前保存、用例后还原 —— 样板
 *  在 ./proxy-env-fixture.js 共享。 */
const savedProxyEnv: Record<string, string | undefined> = {};

describe("applyProxySettings 缝 C:请求真实经本地假 CONNECT 代理", () => {
  afterEach(async () => {
    restoreProxyEnv(savedProxyEnv);
    await resetGlobalDispatcher();
  });

  it("fetch 经假代理到达源站,代理侧连接计数 >= 1;配置优先于 shell 遗留变量", { timeout: 15000 }, async () => {
    saveProxyEnv(savedProxyEnv);
    const origin = http.createServer((_req, res) => {
      res.end("hello-via-proxy");
    });
    const originPort = await listen(origin);
    const proxy = createFakeConnectProxy();
    const proxyPort = await listen(proxy.server);

    try {
      // config 显式给本地假代理:即便 shell 遗留了真实 http_proxy(本机预
      // 置 http://10.88.88.8:10809 之类),生效的也必须是配置值 —— 用错会
      // 连到真代理而拿不到本地源站响应,本用例随之失败暴露。
      const settings: ProxySettings = applyProxySettings(
        { proxy: `http://127.0.0.1:${proxyPort}` },
        { env: process.env },
      );
      expect(settings.source).toBe("config");
      // request 腿的基线:进程环境大小写两套已指向假代理
      expect(process.env.HTTP_PROXY).toBe(`http://127.0.0.1:${proxyPort}`);
      expect(process.env.http_proxy).toBe(`http://127.0.0.1:${proxyPort}`);

      const res = await fetch(`http://127.0.0.1:${originPort}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello-via-proxy");
      expect(proxy.connectCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await resetGlobalDispatcher();
      await stopServer(origin);
      await stopServer(proxy.server);
    }
  });

  it("无代理配置:fetch 直连源站,代理侧零连接", { timeout: 15000 }, async () => {
    saveProxyEnv(savedProxyEnv);
    // 清干净包括 shell 遗留在内的全部代理变量 —— "未配置即直连"的前提
    clearProxyEnv();

    const origin = http.createServer((_req, res) => {
      res.end("hello-direct");
    });
    const originPort = await listen(origin);
    const proxy = createFakeConnectProxy();
    const proxyPort = await listen(proxy.server);

    try {
      const settings = applyProxySettings({}, { env: process.env });
      expect(settings.source).toBe("none");
      // 全局调度器保持默认直连(applyProxySettings 未装配 —— 缝 B 已锁定),
      // 这里证明直连路径真实可达且完全不经过代理
      const res = await fetch(`http://127.0.0.1:${originPort}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello-direct");
      expect(proxy.connectCount()).toBe(0);
    } finally {
      await stopServer(origin);
      await stopServer(proxy.server);
    }
  });
});
