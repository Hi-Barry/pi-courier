/**
 * doctor H 组检查:pi 侧只读静态(spec #337 票 #341,禁区档)。
 *
 *  - H1:getAgentDir() 解析(pi 包同源);
 *  - H2:settings/auth/models JSON 合法、可读(存在且损坏按档:auth ❌ ——
 *       凭据不可用;settings/models ⚠️ —— pi 有内置默认);
 *  - H3:至少一个凭据或默认模型(缺失 ⚠️ —— 桥能连但 pi 调不了模型;
 *       新装未登录属常见态,不误报 ❌)。
 *
 * 禁区档:全部只读,--fix 永不写入 pi 侧任何文件(本模块不产生修复动作,
 * 不存在即硬边界)。detail 只报文件状态与 provider 名,绝不携带凭据内容
 * (报告与 JSON 的脱敏由渲染层兜底,本组从源头不落值)。
 *
 * 引擎门预检:pi 1.0+ 包在 Node <22.19 上 import 即崩(模块求值期),加载前
 * 先按 peer 包 engines 与当前 Node 比较,不满足 → H 组整体 ⏭️,绝不触发崩溃。
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n/index.js";
import { nodeSatisfiesEngine, parseVersionTriple } from "./checks-b.js";
import { packageRootOf } from "./checks-a.js";
import type { CheckResult, DoctorCheckEntry, DoctorContext } from "./types.js";

interface PiPaths {
  agentDir: string;
  authPath: string;
  settingsPath: string;
  modelsPath: string;
}

/** 当前 Node 能否安全 import pi 包(engines 门预检;读不到 engines → 放行)。
 *  底线解析与 B3/B4 同源(pi-rpc 的 minNodeVersionOf)。 */
async function piImportableByEngine(): Promise<boolean> {
  try {
    const requireFromRoot = createRequire(path.join(packageRootOf(), "package.json"));
    const pkgPath = requireFromRoot.resolve("@earendil-works/pi-coding-agent/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      version?: string;
      engines?: { node?: string };
    };
    const major = parseVersionTriple(pkg.version ?? "")?.[0] ?? 0;
    if (major < 1) return true; // 0.x:engines 声称不可靠(assertPiEngineSupported 同语义)
    const running = parseVersionTriple(process.version);
    if (!pkg.engines?.node || !running) return true;
    const { minNodeVersionOf } = await import("../rpc/pi-rpc.js");
    const required = minNodeVersionOf(pkg.engines.node);
    if (!required) return true;
    return nodeSatisfiesEngine(running, required);
  } catch {
    return true; // 读不出引擎信息 → 交给动态 import 的 try/catch 降级
  }
}

/** 加载 pi 包并取 pi 侧路径;任何失败抛错(调用方 → ⏭️)。
 *  pi 包入口只导出 getAgentDir(getAuthPath 等不在 exports 里),叶子名按
 *  pi 包 config.js 的冻结拼法(auth.json/settings.json/models.json)。 */
async function loadPiPaths(): Promise<PiPaths> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const agentDir = pi.getAgentDir();
  return {
    agentDir,
    authPath: path.join(agentDir, "auth.json"),
    settingsPath: path.join(agentDir, "settings.json"),
    modelsPath: path.join(agentDir, "models.json"),
  };
}

/** 单个 pi 侧 JSON 文件的只读状态(绝不返回文件内容)。 */
function jsonFileStatus(
  filePath: string,
  label: string,
  brokenSeverity: "warn" | "fail",
): { severity: "ok" | "warn" | "fail"; line: string } {
  if (!fs.existsSync(filePath)) {
    return { severity: "ok", line: t("doctor.h.fileAbsent", { file: label }) };
  }
  try {
    JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return { severity: "ok", line: t("doctor.h.fileOk", { file: label }) };
  } catch {
    return { severity: brokenSeverity, line: t("doctor.h.fileBroken", { file: label }) };
  }
}

export function checkGroupH(_ctx: DoctorContext): DoctorCheckEntry[] {
  return [
    {
      id: "H1",
      group: "H",
      run: async (): Promise<CheckResult> => {
        if (!(await piImportableByEngine())) {
          return {
            id: "H1",
            group: "H",
            severity: "skip",
            summary: t("doctor.h.engineGate"),
          };
        }
        const { agentDir } = await loadPiPaths();
        if (typeof agentDir !== "string" || agentDir === "") {
          return { id: "H1", group: "H", severity: "warn", summary: t("doctor.h.agentDirEmpty") };
        }
        return { id: "H1", group: "H", severity: "ok", summary: t("doctor.h.agentDirOk"), detail: agentDir };
      },
    },
    {
      id: "H2",
      group: "H",
      run: async (): Promise<CheckResult> => {
        if (!(await piImportableByEngine())) {
          return { id: "H2", group: "H", severity: "skip", summary: t("doctor.h.engineGate") };
        }
        const { authPath, settingsPath, modelsPath } = await loadPiPaths();
        const auth = jsonFileStatus(authPath, "auth.json", "fail");
        const settings = jsonFileStatus(settingsPath, "settings.json", "warn");
        const models = jsonFileStatus(modelsPath, "models.json", "warn");
        const worst: CheckResult["severity"] =
          auth.severity === "fail" || settings.severity === "fail" || models.severity === "fail"
            ? "fail"
            : auth.severity === "warn" || settings.severity === "warn" || models.severity === "warn"
              ? "warn"
              : "ok";
        const detail = [auth, settings, models].map((s) => s.line).join("\n");
        if (worst === "fail") {
          return { id: "H2", group: "H", severity: "fail", summary: t("doctor.h.jsonFail"), detail };
        }
        if (worst === "warn") {
          return { id: "H2", group: "H", severity: "warn", summary: t("doctor.h.jsonWarn"), detail };
        }
        return { id: "H2", group: "H", severity: "ok", summary: t("doctor.h.jsonOk"), detail };
      },
    },
    {
      id: "H3",
      group: "H",
      run: async (): Promise<CheckResult> => {
        if (!(await piImportableByEngine())) {
          return { id: "H3", group: "H", severity: "skip", summary: t("doctor.h.engineGate") };
        }
        const { authPath, modelsPath } = await loadPiPaths();
        // 凭据:auth.json 顶层至少一个 provider 条目;只数名字,绝不携带值
        let hasCredential = false;
        let providerHint: string | undefined;
        if (fs.existsSync(authPath)) {
          try {
            const auth = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<string, unknown>;
            const providers = Object.keys(auth).filter((k) => k !== "" && auth[k] !== null);
            if (providers.length > 0) {
              hasCredential = true;
              providerHint = t("doctor.h.providers", { providers: providers.join(", ") });
            }
          } catch {
            // auth.json 坏 → H2 已报 ❌,H3 不重复定级
          }
        }
        if (hasCredential) {
          return {
            id: "H3",
            group: "H",
            severity: "ok",
            summary: t("doctor.h.credentialOk"),
            ...(providerHint ? { detail: providerHint } : {}),
          };
        }
        // 默认模型:models.json 至少一个条目(结构由 pi 解释,这里只判「有配置」)
        let hasModel = false;
        if (fs.existsSync(modelsPath)) {
          try {
            const models = JSON.parse(fs.readFileSync(modelsPath, "utf-8")) as Record<string, unknown>;
            hasModel = Object.keys(models).length > 0;
          } catch {
            // 坏 → H2 已报
          }
        }
        if (hasModel) {
          return { id: "H3", group: "H", severity: "ok", summary: t("doctor.h.modelOk") };
        }
        return {
          id: "H3",
          group: "H",
          severity: "warn",
          summary: t("doctor.h.noCredentialNoModel"),
          nextStep: "pi  # 在 pi 里登录 provider(/login 或 pi dev 流程)",
        };
      },
    },
  ];
}
