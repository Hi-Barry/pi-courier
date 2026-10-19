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
 *     超时去猜。本函数是纯函数(env 显式传入),抛错时机由调用方决定。
 */
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

/** 解析 env 兜底的 NO_PROXY/no_proxy:逗号分隔、去空白、丢空段。只做
 *  拆分,不做匹配(spec 拍板:匹配语义归各消费方)。 */
function envNoProxyList(env: NodeJS.ProcessEnv): string[] {
  for (const name of ENV_NO_PROXY_VARS) {
    const value = trimmedNonEmpty(env[name]);
    if (value === undefined) continue;
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
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
