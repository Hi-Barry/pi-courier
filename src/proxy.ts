/**
 * 出网代理决策(spec #201 票 #202)—— 代理的优先级、env 兜底、scheme
 * 白名单全项目只在这里解释一次,启动接线(#203)、pi 注入(#204)、向导
 * 默认值(#205)都消费本函数的输出,永不各写一份规则。
 *
 * 决策规则:
 *  1. 优先级:配置文件 > 环境变量。
 *  2. env 兜底依次认 https_proxy → HTTPS_PROXY → http_proxy → HTTP_PROXY:
 *     https 在前(三类出网流量全部 https 为主);同一语义内小写优先于
 *     大写 —— 与底层消费方(request 的 getProxyFromURI、undici 的
 *     EnvHttpProxyAgent)的既有惯例一致,避免「桥选了大写、消费方认了
 *     小写」的解释错位。
 *  3. noProxy:配置优先;配置了 proxy 而未填 noProxy 即「无豁免」(不回落
 *     环境变量 NO_PROXY —— 以配置为准,语义完全确定);代理回落自 env 时
 *     才解析 NO_PROXY/no_proxy(逗号分隔标准格式,只做拆分不做匹配)。
 *  4. 校验:生效代理 URL 的 scheme 必须是 http:/https:,否则无论来自配置
 *     还是环境变量一律抛错停下(双语提示)—— 提前给人话,不留给下游连接
 *     超时去猜。resolveProxySettings 是纯函数(env 显式传入),抛错时机由
 *     调用方决定;带副作用的启动接线只有本文件底部的 applyProxySettings,
 *     它也只消费上面的决策,不另写规则。
 */
import * as undici from "undici";
import { t } from "./i18n/index.js";

/** 生效代理的来源标记。 */
export type ProxySource = "config" | "env" | "none";

/** resolveProxySettings 的配置侧输入(MsgBridgeConfig 结构兼容,可直接传)。 */
export interface ProxyConfigInput {
  proxy?: string;
  noProxy?: string[];
}

/** 生效三元组:proxy 为 undefined = 无代理,全部直连(现状行为)。 */
export interface ProxySettings {
  /** 生效代理 URL(去首尾空白后原样保留,不改写用户输入)。 */
  proxy: string | undefined;
  /** 生效豁免列表(条目原样透传;无代理时恒为空)。 */
  noProxy: string[];
  /** 生效代理来源:config(配置文件)/ env(环境变量)/ none(未配置)。 */
  source: ProxySource;
}

const ENV_PROXY_VARS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;
const ENV_NO_PROXY_VARS = ["no_proxy", "NO_PROXY"] as const;

/** 空串与纯空白一律视作「未配置」(与向导「留空跳过」同语义)。 */
function trimmedNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** scheme 白名单(http:/https:)外的生效代理一律拒绝;无法解析的输入
 *  同样拒绝 —— 它必然不是合法的 http/https 地址。origin 说明值的出处
 *  (config.proxy 或具体环境变量名),双语错误里直接点名,免去翻配置。 */
function assertSupportedScheme(proxyUrl: string, origin: string): void {
  let scheme: string | undefined;
  try {
    scheme = new URL(proxyUrl).protocol;
  } catch {
    scheme = undefined;
  }
  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error(t("proxy.unsupportedScheme", { value: proxyUrl, origin }));
  }
}

/** 解析标准 no_proxy 格式:逗号分隔、去空白、丢空段。只做拆分,不做匹配
 *  (spec 拍板:匹配语义归各消费方)。env 兜底与向导(#205)共用,拆分
 *  规则全项目只有这里一份。 */
export function parseNoProxyList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** 解析 env 兜底的 NO_PROXY/no_proxy:逗号分隔、去空白、丢空段。只做
 *  拆分,不做匹配(spec 拍板:匹配语义归各消费方)。 */
function envNoProxyList(env: NodeJS.ProcessEnv): string[] {
  for (const name of ENV_NO_PROXY_VARS) {
    const value = trimmedNonEmpty(env[name]);
    if (value === undefined) continue;
    return parseNoProxyList(value);
  }
  return [];
}

/**
 * 解析生效代理三元组;违规输入抛双语校验错误。决策规则的唯一解释点,
 * 详见模块头注释。
 */
export function resolveProxySettings(
  config: ProxyConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): ProxySettings {
  const fromConfig = trimmedNonEmpty(config.proxy);
  if (fromConfig !== undefined) {
    assertSupportedScheme(fromConfig, "config.proxy");
    return { proxy: fromConfig, noProxy: config.noProxy ?? [], source: "config" };
  }

  for (const name of ENV_PROXY_VARS) {
    const fromEnv = trimmedNonEmpty(env[name]);
    if (fromEnv === undefined) continue;
    assertSupportedScheme(fromEnv, name);
    return { proxy: fromEnv, noProxy: config.noProxy ?? envNoProxyList(env), source: "env" };
  }

  return { proxy: undefined, noProxy: [], source: "none" };
}

// ── 启动接线(spec #201 票 #203)──────────────────────────────────────────
// 把生效三元组落到进程上:覆写标准环境变量(request 腿自动认)+ 装配
// undici 全局调度器(桥自己的 fetch 腿必须代码级装配)。pi 子进程注入
// (票 #204)与向导默认值(票 #205)各自消费 resolveProxySettings,不走
// 本函数。

/** 出网代理的标准环境变量名,大小写两套全部写齐 —— request 的
 *  getProxyFromURI 与 undici 都小写优先,只写大写会被 shell 遗留小写变量
 *  抢跑,只写小写则 Windows 等大写惯例的消费方认不到。桥侧进程覆写
 *  (#203 applyProxySettings)与 pi 子进程注入(#204 proxySpawnEnv)共用
 *  此键集;两处的第三态语义有意不同(删键 / 空串压制 / 不写),共享的
 *  只是键集与拼串,不是语义分支。 */
export const PROXY_ENV_NAMES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] as const;

/** NO_PROXY 的标准键名,大小写两套(理由同 PROXY_ENV_NAMES)。 */
export const NO_PROXY_ENV_NAMES = ["NO_PROXY", "no_proxy"] as const;

/** 豁免列表 → 标准逗号串(条目原样 join,不改写用户输入);写大小写
 *  两套时与 NO_PROXY_ENV_NAMES 配对使用。 */
export function joinNoProxyList(noProxy: readonly string[]): string {
  return noProxy.join(",");
}

/** 调度器装配缝:默认实现真正装配全局调度器并换装 undici fetch;测试注入
 *  spy,断言装配时机(此刻环境已覆写完毕)与装配物(EnvHttpProxyAgent)。 */
export type DispatcherInstaller = (agent: undici.EnvHttpProxyAgent) => void;

export interface ApplyProxyOptions {
  /** 被覆写的环境(默认 process.env;测试传假对象,不污染真实环境)。 */
  env?: NodeJS.ProcessEnv;
  /** 调度器装配缝(默认真实装配)。 */
  installDispatcher?: DispatcherInstaller;
}

/** 与上游 pi 同款(http-dispatcher.ts):setGlobalDispatcher 之后把 undici
 *  自己的 fetch 实现一并 install 到 globalThis —— 让 fetch 与调度器始终在
 *  同一 undici 实现上,避免 Node 内置 fetch 消费 npm undici 调度器的版本
 *  错配(新版本 Node 才修正压缩响应的解压行为)。 */
function installGlobalProxyDispatcher(agent: undici.EnvHttpProxyAgent): void {
  undici.setGlobalDispatcher(agent);
  undici.install();
}

/**
 * 把生效代理落到进程上,启动路径的唯一调用点:解析 → 校验 → 覆写环境 →
 * 装配调度器,必须先于任何出网(Matrix 客户端创建、pi 拉起、向导进入)。
 * 无代理时零动作 —— 环境不动、调度器不装,行为与旧版直连完全一致。
 *
 * noProxy 以配置为准:代理生效而未填时把环境遗留的 NO_PROXY 删掉,
 * 「未填即无豁免」在进程环境里同样成立;填了则以逗号串写大小写两套。
 */
export function applyProxySettings(
  config: ProxyConfigInput,
  options: ApplyProxyOptions = {},
): ProxySettings {
  const env = options.env ?? process.env;
  const settings = resolveProxySettings(config, env);
  if (settings.proxy === undefined) return settings;

  for (const name of PROXY_ENV_NAMES) {
    env[name] = settings.proxy;
  }
  if (settings.noProxy.length > 0) {
    const joined = joinNoProxyList(settings.noProxy);
    for (const name of NO_PROXY_ENV_NAMES) env[name] = joined;
  } else {
    for (const name of NO_PROXY_ENV_NAMES) delete env[name];
  }

  const installDispatcher = options.installDispatcher ?? installGlobalProxyDispatcher;
  // proxyTunnel: true —— 同上游 pi:http 目标也走 CONNECT 隧道(undici 8.7
  // 起默认改为普通代理请求;固定走隧道让桥的 fetch 腿与矩阵 request 腿的
  // 隧道行为一致,集成测试也只验证这一种配方)。
  installDispatcher(new undici.EnvHttpProxyAgent({ proxyTunnel: true }));
  return settings;
}
