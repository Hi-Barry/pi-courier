/**
 * doctor E 组检查:网络(spec #337 票 #342)。
 *
 *  - E1:Matrix whoami(凭据有效性)—— 200 ✅ / 4xx ❌(homeserver 明确拒绝
 *       凭据)/ 5xx ⚠️(服务端错误)/ 连接失败 ❌ / 超时 ⏭️;
 *  - E2:homeserver 可达(_matrix/client/versions,免凭据)—— 200 ✅ /
 *       连接失败 ❌ / 超时 ⏭️;
 *  - E3:代理可达 —— 未配置 ✅ 直连 / 任意 HTTP 应答 ✅(代理是转发器,状态
 *       码本身无意义,TCP+HTTP 有应答即可达)/ 连接失败 ❌ / 超时 ⏭️。
 *
 * 核心契约(spec 用户故事 12):每项 5 秒上限,超时判 ⏭️「查不出来」不判 ❌
 * —— 网络慢绝不误报成配置坏。--offline 整组跳过(检查清单直接不收集,
 * 报告头带 offlineNote)。全部经注入 fetch,目标由配置派生;token 走
 * Authorization 头(不进 URL,渲染层脱敏兜底)。
 */

import { t } from "../i18n/index.js";
import type { CheckResult, DoctorCheckEntry, DoctorContext } from "./types.js";

/** 每项网络检查的上限(spec:5 秒,超时 ⏭️)。 */
export const NETWORK_TIMEOUT_MS = 5_000;

/** fetch + 5 秒竞速:超时返回 undefined(不 reject)。AbortController 断开
 *  底层连接,不泄漏挂起的 socket。 */
async function fetchWithTimeout(
  fetch: DoctorContext["deps"]["fetch"],
  url: string,
  init?: RequestInit,
): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  // 竞速败者的计时器必须在 finally 一并清理:胜者确定后败者 timer 仍挂在
  // 事件循环上,而 cli 的 exit 只设 exitCode 靠事件循环自然收尾 —— 不清的
  // 话在线跑完 doctor 后进程最多再挂 5 秒(CI 的每次 --json 都被拖慢)。
  let resolveRace!: (value: undefined) => void;
  const raceTimer = setTimeout(() => resolveRace(undefined), NETWORK_TIMEOUT_MS);
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      new Promise<undefined>((resolve) => {
        resolveRace = resolve;
      }),
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(raceTimer);
  }
}

/** 区分超时(⏭️)、主动跳过(⏭️)与立即失败(❌/⚠️)的统一结果构造。
 *  skip 与 timeout 同为 ⏭️,但文案由调用方给:超时是「等了 N 秒没响应」,
 *  「未配置目标」与「配置非法」一个请求都没发,不能套超时模板(评审发现:
 *  否则报告陈述与事实不符,zh 下还叠成双前缀病句)。 */
function networkResult(
  id: string,
  outcome: { kind: "ok"; summary: string; detail?: string } | { kind: "fail" | "warn" | "skip"; summary: string; detail?: string; nextStep?: string } | { kind: "timeout"; what: string },
): CheckResult {
  const base = { id, group: "E" as const };
  if (outcome.kind === "timeout") {
    return { ...base, severity: "skip", summary: t("doctor.e.timeout", { what: outcome.what, seconds: Math.round(NETWORK_TIMEOUT_MS / 1000) }) };
  }
  return {
    ...base,
    severity: outcome.kind === "ok" ? "ok" : outcome.kind,
    summary: outcome.summary,
    ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    ...((outcome as { nextStep?: string }).nextStep !== undefined
      ? { nextStep: (outcome as { nextStep?: string }).nextStep }
      : {}),
  };
}

export function checkGroupE(ctx: DoctorContext): DoctorCheckEntry[] {
  // --offline:整组跳过(清单不收集,fetch 零调用;报告头 offlineNote 兜底)
  if (ctx.options.offline) return [];

  const matrix = ctx.config?.matrix;
  const homeserver = typeof matrix?.homeserverUrl === "string" ? matrix.homeserverUrl.replace(/\/+$/, "") : undefined;
  const token = typeof matrix?.accessToken === "string" ? matrix.accessToken : undefined;

  const e1: DoctorCheckEntry = {
    id: "E1",
    group: "E",
    run: async (): Promise<CheckResult> => {
      if (!homeserver || !token) {
        return networkResult("E1", { kind: "warn", summary: t("doctor.e.whoami.unconfigured"), nextStep: "pi-courier setup" });
      }
      let res: Response | undefined;
      try {
        res = await fetchWithTimeout(ctx.deps.fetch, `${homeserver}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        return networkResult("E1", {
          kind: "fail",
          summary: t("doctor.e.whoami.unreachable"),
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      if (res === undefined) return networkResult("E1", { kind: "timeout", what: t("doctor.e.whoami.name") });
      if (res.ok) {
        let userId = "";
        try {
          const body = (await res.json()) as { user_id?: string };
          userId = typeof body.user_id === "string" ? body.user_id : "";
        } catch {
          // 响应体解析失败仍算通(200 即凭据有效)
        }
        return networkResult("E1", {
          kind: "ok",
          summary: t("doctor.e.whoami.ok"),
          ...(userId ? { detail: userId } : {}),
        });
      }
      if (res.status >= 400 && res.status < 500) {
        return networkResult("E1", {
          kind: "fail",
          summary: t("doctor.e.whoami.rejected", { status: res.status }),
          nextStep: "pi-courier setup",
        });
      }
      return networkResult("E1", { kind: "warn", summary: t("doctor.e.whoami.serverError", { status: res.status }) });
    },
  };

  const e2: DoctorCheckEntry = {
    id: "E2",
    group: "E",
    run: async (): Promise<CheckResult> => {
      if (!homeserver) {
        // 一个请求都没发:走 skip(⏭️)而不是 timeout,文案不能声称「等了 5 秒」
        return networkResult("E2", { kind: "skip", summary: t("doctor.e.homeserver.unconfigured") });
      }
      let res: Response | undefined;
      try {
        res = await fetchWithTimeout(ctx.deps.fetch, `${homeserver}/_matrix/client/versions`);
      } catch (err) {
        return networkResult("E2", {
          kind: "fail",
          summary: t("doctor.e.homeserver.unreachable"),
          detail: err instanceof Error ? err.message : String(err),
          nextStep: t("doctor.e.homeserver.next"),
        });
      }
      if (res === undefined) return networkResult("E2", { kind: "timeout", what: t("doctor.e.homeserver.name") });
      if (res.ok) return networkResult("E2", { kind: "ok", summary: t("doctor.e.homeserver.ok"), detail: homeserver });
      return networkResult("E2", {
        kind: "warn",
        summary: t("doctor.e.homeserver.serverError", { status: res.status }),
        detail: homeserver,
      });
    },
  };

  const e3: DoctorCheckEntry = {
    id: "E3",
    group: "E",
    run: async (): Promise<CheckResult> => {
      const { resolveProxySettings } = await import("../proxy.js");
      let proxy: string | undefined;
      try {
        proxy = resolveProxySettings(ctx.config ?? {}, ctx.deps.env).proxy;
      } catch (err) {
        // 代理 scheme 非法:C5 已 ❌ 点名,这里按「无法确认」不重复定级;
        // 一个请求都没发,走 skip 而非 timeout(文案不声称超时)。
        return networkResult("E3", {
          kind: "skip",
          summary: t("doctor.degraded", { reason: err instanceof Error ? err.message : String(err) }),
        });
      }
      if (!proxy) {
        return networkResult("E3", { kind: "ok", summary: t("doctor.e.proxy.none") });
      }
      let origin: string;
      try {
        origin = new URL(proxy).origin;
      } catch {
        // 无可用 origin:一个请求都没发,skip 而非 timeout
        return networkResult("E3", { kind: "skip", summary: t("doctor.e.proxy.invalid") });
      }
      let res: Response | undefined;
      try {
        // 对代理 origin 发任意请求:代理是转发器,状态码无意义,有 HTTP 应答即可达
        res = await fetchWithTimeout(ctx.deps.fetch, origin);
      } catch (err) {
        return networkResult("E3", {
          kind: "fail",
          summary: t("doctor.e.proxy.unreachable", { proxy }),
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      if (res === undefined) return networkResult("E3", { kind: "timeout", what: t("doctor.e.proxy.name") });
      return networkResult("E3", { kind: "ok", summary: t("doctor.e.proxy.ok"), detail: proxy });
    },
  };

  return [e1, e2, e3];
}
