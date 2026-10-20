/**
 * PiRpc 派生 pi 子进程的代理 env 注入(spec #201 票 #204,缝 B)。
 *
 * doStart 里 `new RpcClient({...})` 的 env 三态断言:配置出场覆写 / 仅
 * 环境变量继承 / 两者皆无直连(不传 env,与现状逐键一致)。手法:上游
 * `@earendil-works/pi-coding-agent` 整体 mock —— doStart 经动态 import 取
 * RpcClient,假类只记录构造参数并让 start/getState/stop 立即就绪;loadConfig
 * 同样 mock 掉,隔离开发者机器上的真实 ~/.pi/pi-courier.json。本机 shell
 * 可能预置真实代理变量(如 http_proxy),六个代理键用例前清空、用例后
 * 还原 —— 样板在 ./proxy-env-fixture.js 共享(先例:proxy-apply.test.ts)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiRpc, type PiRpcOptions } from "../src/rpc/pi-rpc";
import { clearProxyEnv, PROXY_ENV_KEYS, restoreProxyEnv, saveProxyEnv } from "./proxy-env-fixture.js";

const { constructed, fileConfig } = vi.hoisted(() => ({
  /** 每次 new RpcClient 的构造参数(pi-rpc.ts 传给上游 spawn 的 options)。 */
  constructed: [] as Array<Record<string, unknown>>,
  /** loadConfig 的替身返回值(fileConfig.current 即"配置文件内容")。 */
  fileConfig: { current: {} as Record<string, unknown> },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  RpcClient: class {
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
    async start(): Promise<void> {}
    async getState(): Promise<unknown> {
      return {};
    }
    async stop(): Promise<void> {}
    onEvent(): () => void {
      return () => {};
    }
  },
}));

vi.mock("../src/config", () => ({
  loadConfig: () => fileConfig.current,
}));

/** cliPath 指向不存在路径:引擎门禁找不到 package.json 即跳过,动态
 *  import 落到上面的假类 —— 全程不碰真实 pi、不 spawn 任何进程。 */
function startRpc(options: PiRpcOptions = {}): Promise<PiRpc> {
  const rpc = new PiRpc({ cliPath: "/nonexistent/pi-cli.js", ...options });
  return rpc.start().then(() => rpc);
}

const lastOptions = (): Record<string, unknown> => constructed[constructed.length - 1];

/** 本机 shell 可能预置真实代理变量:六个键用例前保存并清空(无代理
 *  基线)、用例后逐一还原,实现见 ./proxy-env-fixture.js。 */
const savedProxyEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  constructed.length = 0;
  fileConfig.current = {};
  saveProxyEnv(savedProxyEnv);
  clearProxyEnv();
});

afterEach(() => restoreProxyEnv(savedProxyEnv));

describe("PiRpc spawn 代理 env 注入(票 #204 三态)", () => {
  it("配置出场:大小写两套全部覆写为生效值,带 noProxy", async () => {
    await startRpc({
      proxyConfig: { proxy: "http://cfg:1", noProxy: ["intra.example.com", "10.0.0.0/8"] },
    });
    expect(constructed).toHaveLength(1);
    expect(lastOptions().env).toEqual({
      HTTP_PROXY: "http://cfg:1",
      http_proxy: "http://cfg:1",
      HTTPS_PROXY: "http://cfg:1",
      https_proxy: "http://cfg:1",
      NO_PROXY: "intra.example.com,10.0.0.0/8",
      no_proxy: "intra.example.com,10.0.0.0/8",
    });
  });

  it("配置出场未填 noProxy:遗留 NO_PROXY 被置空串压制(merge 无法删键)", async () => {
    process.env.NO_PROXY = "leftover";
    process.env.no_proxy = "leftover";
    await startRpc({ proxyConfig: { proxy: "http://cfg:1" } });
    const env = lastOptions().env as Record<string, string>;
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      expect(env[name]).toBe("http://cfg:1");
    }
    // 「以配置为准,未填即无豁免」在子进程里同样成立:父进程遗留值不得穿透
    expect(env.NO_PROXY).toBe("");
    expect(env.no_proxy).toBe("");
  });

  it("仅环境变量继承:算出的值与父进程 env 相同,键集不超标准代理键", async () => {
    process.env.http_proxy = "http://env:2";
    process.env.no_proxy = " a.internal , b ";
    await startRpc({ proxyConfig: {} });
    const env = lastOptions().env as Record<string, string>;
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      expect(env[name]).toBe("http://env:2");
    }
    expect(env.NO_PROXY).toBe("a.internal,b");
    expect(env.no_proxy).toBe("a.internal,b");
    // 不引入意外键:覆写增量只含标准代理键,其余环境照旧由上游 merge 继承
    const keys = Object.keys(env);
    expect(keys.length).toBe(6);
    expect(keys.every((key) => (PROXY_ENV_KEYS as readonly string[]).includes(key))).toBe(true);
  });

  it("仅环境变量且无 NO_PROXY:两键不写,不引入父进程没有的键", async () => {
    process.env.HTTP_PROXY = "http://env:3";
    await startRpc({ proxyConfig: {} });
    const env = lastOptions().env as Record<string, string>;
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
    // 键集恰好是四个代理键(上面的逐键断言 + 数量锁死,不引入意外键)
    expect(Object.keys(env)).toHaveLength(4);
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      expect(env[name]).toBe("http://env:3");
    }
  });

  it("两者皆无:不传 env,其余构造参数与现状逐键一致", async () => {
    await startRpc({ proxyConfig: {}, cwd: "/tmp/workdir-x", args: ["--continue"] });
    expect(constructed).toHaveLength(1);
    expect(lastOptions()).toEqual({
      cliPath: "/nonexistent/pi-cli.js",
      cwd: "/tmp/workdir-x",
      args: ["--continue"],
    });
  });

  it("proxyConfig 缺省:spawn 自读配置文件(loadConfig 兜底),spawn 点自洽", async () => {
    fileConfig.current = { proxy: "http://file:1" };
    await startRpc();
    const env = lastOptions().env as Record<string, string>;
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      expect(env[name]).toBe("http://file:1");
    }
  });

  it("重启重读配置:stop 后再 start,env 按新配置现算", async () => {
    fileConfig.current = { proxy: "http://old:1" };
    const rpc = await startRpc();
    expect((lastOptions().env as Record<string, string>).HTTP_PROXY).toBe("http://old:1");
    fileConfig.current = { proxy: "http://new:1" };
    await rpc.stop();
    await rpc.start();
    expect(constructed).toHaveLength(2);
    expect((lastOptions().env as Record<string, string>).HTTP_PROXY).toBe("http://new:1");
  });

  it("配置 scheme 违规:start 拒绝并抛提示,子进程不被拉起", async () => {
    await expect(startRpc({ proxyConfig: { proxy: "socks5://g:1" } })).rejects.toThrow(/socks5:\/\/g:1/);
    expect(constructed).toHaveLength(0);
  });
});
