/**
 * 代理环境变量的测试共享样板(先例:matrix-fakes.ts):PROXY_ENV_KEYS 六键
 * 是代理注入逻辑可能读写的全部范围。本机 shell 可能预置真实代理变量(如
 * http_proxy),用例前保存/清空、用例后逐一还原,隔离真实环境
 * (消费方:pi-rpc-proxy-env.test.ts、proxy-apply.test.ts)。
 */

/** 六个标准代理环境变量键:代理与豁免 × 大小写两套。 */
export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

/** 把六个键的当前值存入 saved(原缺省的键记 undefined)。 */
export function saveProxyEnv(saved: Record<string, string | undefined>): void {
  for (const key of PROXY_ENV_KEYS) saved[key] = process.env[key];
}

/** 从进程环境清空六个键,得到「无代理」基线。 */
export function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
}

/** 按 saved 还原六个键:原缺省的键删除,原有的键写回。 */
export function restoreProxyEnv(saved: Record<string, string | undefined>): void {
  for (const key of PROXY_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}
