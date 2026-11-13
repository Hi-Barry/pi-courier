/**
 * doctor C 组检查:pi-courier 配置(spec #337 票 #340)。
 *
 *  - C1:配置文件存在/可读/JSON 合法;缺失/坏 → ❌ + 提示先跑 setup
 *       (不可修复档,--fix 永不代生成配置)。
 *  - C2:关键字段类型(homeserver、trustedUsers、workdir、sessionDir 等),
 *       直接对原始文件做类型表检查 —— loadConfig 会静默丢弃畸形条目
 *       (sanitizeFileConfig),被丢掉的坏字段恰恰要在原始字节里点名。
 *  - C3:配置 0600(POSIX;win32 的 libuv 只报 0666/0444,等价语义缺失 →
 *       ⏭️,与 config.ts 自检的 POSIX-only 同理由)。可修复(备份先于 chmod)。
 *  - C4:workdir 存在且可写(含多项目全部 projects,一个坏项目不掩盖其他
 *       项目);缺失/不可写 ❌ + 下一步命令,绝不代建(提示档);未配置的
 *       默认根缺失 ⚠️(运行时 spawn 前会自建,能跑但有降级)。
 *  - C5:proxy scheme 合法(resolveProxySettings 同源,校验错误原样上报)。
 *  - C6:sessionDir 存在且可写;未配置走 pi 默认 ✅。
 *
 * 检查函数契约与 B 组一致:能确定答案才返回结果,无法确定就抛 → ⏭️。
 */

import * as fs from "node:fs";
import { t } from "../i18n/index.js";
import type { CheckResult, DoctorCheckEntry, DoctorContext } from "./types.js";

/** C2 的字段类型表(「等」= 表驱动,加字段只改这里)。 */
const FIELD_TYPES: ReadonlyArray<{ path: string; kind: "string" | "string[]" | "boolean" | "object" }> = [
  { path: "matrix", kind: "object" },
  { path: "matrix.homeserverUrl", kind: "string" },
  { path: "matrix.accessToken", kind: "string" },
  { path: "auth", kind: "object" },
  { path: "auth.trustedUsers", kind: "string[]" },
  { path: "auth.guestUsers", kind: "string[]" },
  { path: "workdir", kind: "string" },
  { path: "sessionDir", kind: "string" },
  { path: "proxy", kind: "string" },
  { path: "cliPath", kind: "string" },
  { path: "multiProject", kind: "boolean" },
  { path: "logLevel", kind: "string" },
];

function typeLabel(value: unknown): string {
  if (Array.isArray(value)) return "array";
  return value === null ? "null" : typeof value;
}

function matchesKind(value: unknown, kind: string): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/** 逐段下钻 dotted path(undefined 段 = 字段缺省,合法)。 */
function fieldAt(root: Record<string, unknown>, dotted: string): { present: boolean; value: unknown } {
  let cur: unknown = root;
  for (const seg of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null) return { present: true, value: undefined };
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return { present: false, value: undefined };
  }
  return { present: true, value: cur };
}

/** 目录可写性(fs-only)。 */
function dirWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 目录检查的公共结果构造(存在且可写 ✅ / 缺失 ❌+mkdir 指引 / 不可写 ❌)。 */
function dirCheckResult(
  id: string,
  summaryOk: string,
  summaryMissing: string,
  summaryUnwritable: string,
  dir: string,
  nextStep: string | undefined,
): CheckResult {
  if (!fs.existsSync(dir)) {
    return {
      id,
      group: "C",
      severity: "fail",
      summary: summaryMissing,
      detail: dir,
      ...(nextStep ? { nextStep } : {}),
    };
  }
  if (!dirWritable(dir)) {
    return {
      id,
      group: "C",
      severity: "fail",
      summary: summaryUnwritable,
      detail: dir,
      nextStep: `chmod u+w "${dir}"`,
    };
  }
  return { id, group: "C", severity: "ok", summary: summaryOk, detail: dir };
}

export function checkGroupC(ctx: DoctorContext): DoctorCheckEntry[] {
  const configPath = ctx.deps.layout.configPath;
  const config = ctx.config;

  const c1: DoctorCheckEntry = {
    id: "C1",
    group: "C",
    run: async () => {
      if (!fs.existsSync(configPath)) {
        return {
          id: "C1",
          group: "C",
          severity: "fail",
          summary: t("doctor.c1.missing"),
          nextStep: "pi-courier setup",
        };
      }
      try {
        JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch (err) {
        return {
          id: "C1",
          group: "C",
          severity: "fail",
          summary: t("doctor.c1.corrupt"),
          detail: err instanceof Error ? err.message : String(err),
          nextStep: t("doctor.c1.corruptNext"),
        };
      }
      return { id: "C1", group: "C", severity: "ok", summary: t("doctor.c1.ok"), detail: configPath };
    },
  };

  const c2: DoctorCheckEntry = {
    id: "C2",
    group: "C",
    run: async () => {
      // 对原始文件做类型表检查(loadConfig 静默丢畸形条目;原始字节才看得到)
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      } catch {
        return { id: "C2", group: "C", severity: "skip", summary: t("doctor.c2.skipCorrupt") };
      }
      const bad: string[] = [];
      for (const { path: fieldPath, kind } of FIELD_TYPES) {
        const { present, value } = fieldAt(raw, fieldPath);
        if (!present) continue;
        if (!matchesKind(value, kind)) {
          bad.push(`${fieldPath} (${t("doctor.c2.gotType", { type: typeLabel(value) })})`);
        }
      }
      if (bad.length > 0) {
        return {
          id: "C2",
          group: "C",
          severity: "fail",
          summary: t("doctor.c2.bad", { count: bad.length }),
          detail: bad.join("\n"),
          nextStep: t("doctor.c2.next"),
        };
      }
      return { id: "C2", group: "C", severity: "ok", summary: t("doctor.c2.ok") };
    },
  };

  const c3: DoctorCheckEntry = {
    id: "C3",
    group: "C",
    run: async () => {
      if (ctx.deps.platform === "win32") {
        // libuv 对常规文件只报 0666/0444,0600 契约在 Windows 无意义(config.ts
        // 自检同理由);等价语义缺失 → 如实标 ⏭️,不误报。
        return { id: "C3", group: "C", severity: "skip", summary: t("doctor.c3.win32") };
      }
      if (!fs.existsSync(configPath)) {
        return { id: "C3", group: "C", severity: "skip", summary: t("doctor.c3.noFile") };
      }
      const mode = fs.statSync(configPath).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return {
          id: "C3",
          group: "C",
          severity: "warn",
          summary: t("doctor.c3.loose", { mode: mode.toString(8) }),
          nextStep: "pi-courier doctor --fix",
        };
      }
      return { id: "C3", group: "C", severity: "ok", summary: t("doctor.c3.ok"), detail: mode.toString(8) };
    },
  };

  const c4: DoctorCheckEntry = {
    id: "C4",
    group: "C",
    run: async () => {
      const results: CheckResult[] = [];
      const { effectiveWorkdir } = await import("../config.js");
      const explicit = typeof config?.workdir === "string" && config.workdir !== "";
      const defaultDir = effectiveWorkdir(config ?? {});
      const configuredDir = explicit ? (config?.workdir as string) : defaultDir;
      if (!explicit) {
        // 未配置 = 走默认根:运行时 spawn 前会自建,缺失报 ⚠️ 提示(不挡 CI)
        results.push(
          fs.existsSync(defaultDir) && dirWritable(defaultDir)
            ? { id: "C4", group: "C", severity: "ok", summary: t("doctor.c4.defaultOk"), detail: defaultDir }
            : {
                id: "C4",
                group: "C",
                severity: "warn",
                summary: t("doctor.c4.defaultMissing"),
                detail: defaultDir,
                nextStep: `mkdir -p "${defaultDir}"`,
              },
        );
      } else {
        results.push(
          dirCheckResult(
            "C4",
            t("doctor.c4.ok"),
            t("doctor.c4.missing"),
            t("doctor.c4.unwritable"),
            configuredDir,
            `mkdir -p "${configuredDir}"`,
          ),
        );
      }
      // 多项目全部 projects(按 roomId 排序,序号稳定):一个坏项目不掩盖其他
      const projectIds = Object.keys(config?.projects ?? {}).sort();
      projectIds.forEach((roomId, index) => {
        const project = config?.projects?.[roomId];
        const dir = project?.workdir;
        if (typeof dir !== "string" || dir === "") {
          results.push({
            id: `C4.${index + 1}`,
            group: "C",
            severity: "fail",
            summary: t("doctor.c4.projectNoDir", { room: roomId }),
            detail: roomId,
          });
          return;
        }
        results.push({
          ...dirCheckResult(
            `C4.${index + 1}`,
            t("doctor.c4.ok"),
            t("doctor.c4.missing"),
            t("doctor.c4.unwritable"),
            dir,
            `mkdir -p "${dir}"`,
          ),
          detail: `${roomId} → ${dir}`,
        });
      });
      return results;
    },
  };

  const c5: DoctorCheckEntry = {
    id: "C5",
    group: "C",
    run: async () => {
      const { resolveProxySettings } = await import("../proxy.js");
      let settings: Awaited<ReturnType<typeof resolveProxySettings>>;
      try {
        // resolveProxySettings 是纯决策函数,违规输入抛双语校验错误 —— 那是
        // 「确认坏了」(启动接线会同样抛错停下),必须按 ❌ 分类,不能落进
        // guardCheck 的 ⏭️(无法确认)。
        settings = resolveProxySettings(config ?? {}, ctx.deps.env);
      } catch (err) {
        return {
          id: "C5",
          group: "C",
          severity: "fail",
          summary: t("doctor.c5.invalid"),
          detail: err instanceof Error ? err.message : String(err),
          nextStep: t("doctor.c5.next"),
        };
      }
      if (settings.source === "none") {
        return { id: "C5", group: "C", severity: "ok", summary: t("doctor.c5.none") };
      }
      return {
        id: "C5",
        group: "C",
        severity: "ok",
        summary: t("doctor.c5.ok", { source: settings.source }),
        detail: settings.proxy,
      };
    },
  };

  const c6: DoctorCheckEntry = {
    id: "C6",
    group: "C",
    run: async () => {
      const sessionDir = config?.sessionDir;
      if (typeof sessionDir !== "string" || sessionDir === "") {
        return { id: "C6", group: "C", severity: "ok", summary: t("doctor.c6.unset") };
      }
      return dirCheckResult(
        "C6",
        t("doctor.c6.ok"),
        t("doctor.c6.missing"),
        t("doctor.c6.unwritable"),
        sessionDir,
        `mkdir -p "${sessionDir}"`,
      );
    },
  };

  return [c1, c2, c3, c4, c5, c6];
}
