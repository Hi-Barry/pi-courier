/**
 * Project-welcome copy home: the single assembly point for the "project is
 * online" card posted into a brand-new project room (spec #208 票2/#210).
 * Mirrors management-room.ts: all copy comes from the i18n tables (locale is
 * fixed at startup); the builder is a pure function so the version/model
 * degradation matrix stays unit-testable, and version lookup is best-effort —
 * a missing entry just drops its segment of the identity line.
 */

import { t } from "./i18n/index.js";
import { readBridgeVersion } from "./version.js";

export interface WelcomeFacts {
  projectName: string;
  /** `${provider}/${id}` read from the started session's state; absent = omit the model line. */
  model?: string;
  piVersion?: string;
  courierVersion?: string;
}

export function buildProjectWelcome(facts: WelcomeFacts): string {
  // 缺谁省谁(票 #210 评审回炉):四种版本形态各走一条完整栈段模板 ——
  // 间距是文案决策,留在 i18n 表里(· 紧贴全角括号、拉丁词两侧留空),
  // 代码不做字符串拼接;单缺只省缺的那段版本号,名字段永远在。
  const stackKey = facts.piVersion
    ? facts.courierVersion
      ? "welcome.project.stack.both"
      : "welcome.project.stack.piOnly"
    : facts.courierVersion
      ? "welcome.project.stack.courierOnly"
      : "welcome.project.stack.neither";
  const stack = t(stackKey, {
    piVersion: facts.piVersion ?? "",
    courierVersion: facts.courierVersion ?? "",
  });
  const identity = facts.model
    ? t("welcome.project.identity.model", { stack, model: facts.model })
    : t("welcome.project.identity.plain", { stack });
  return [
    t("welcome.project.header", { name: facts.projectName }),
    identity,
    t("welcome.project.capabilities"),
    t("welcome.project.try"),
    t("welcome.project.helpHint"),
  ].join("\n\n");
}

/** Versions for the welcome identity line — best-effort on both entries. */
export async function welcomeVersions(): Promise<{ piVersion?: string; courierVersion?: string }> {
  return { piVersion: await piCodingAgentVersion(), courierVersion: readBridgeVersion() };
}

/** pi coding agent's own VERSION export (lazy import — same shape as the
 *  pi-rpc seam; the package is a peer dependency, so it may be unreadable
 *  only in a broken install, which degrades the copy instead of crashing). */
async function piCodingAgentVersion(): Promise<string | undefined> {
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    return mod.VERSION || undefined;
  } catch {
    return undefined;
  }
}
