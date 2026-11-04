/**
 * log-filter — the pure argv builder behind `pi-courier logs/status` (spec #34).
 *
 * Journal filtering works on the LINE, not on journald fields: custom stdout
 * field assignments (PROJECT=…) are not parsed by journald (measured on
 * systemd 257), and the `PRIORITY` field is useless under the default
 * `StandardOutput=inherit` (every line lands at 6) — which is why the old
 * `-p <priority>` --level filter never matched anything real. Instead the
 * bridge writes `[LEVEL] [label]` into each line and this module compiles
 * user requests into an anchored `journalctl --grep` pattern.
 *
 * Requirements: journalctl with PCRE2 (`--grep`, `--case`). Absent → the CLI
 * errors via journalctl itself; no silent fallback (spec #34 decision).
 */

import { t } from "./i18n/index.js";
import type { LogLevel } from "./logger.js";
import { parseLogLevel } from "./logger.js";
import { normalizeLabelKey } from "./project-labels.js";

/** Lower-bound thresholds: `--level X` shows X and everything louder. */
const LEVEL_ALTERNATIONS: Record<LogLevel, string> = {
  debug: "DEBUG|INFO|WARN|ERROR",
  info: "INFO|WARN|ERROR",
  warn: "WARN|ERROR",
  error: "ERROR",
};

export interface LogFilterRequest {
  /** Labels of all registered projects (stored verbatim from projectLabelOf —
   *  the same spelling the log lines carry; name matching uses
   *  normalizeLabelKey (NFKC + case fold) on both sides). */
  availableLabels: string[];
  /** Positional args after the subcommand — each is a project label. */
  requestedProjects: string[];
  /** Already-parsed level option; kept a string so the CLI can report unknown values. */
  level: string;
  /** follow mode (`logs` true, `status` false). */
  follow: boolean;
  /** For status: -n <lineCount> after the filters. */
  lineCount?: number;
  /** Service unit name (cli passes its SERVICE_NAME constant — one owner). */
  unit: string;
}

export type LogFilterResult = { ok: true; args: string[] } | { ok: false; message: string };

/** Escape a literal for the PCRE pattern (labels are user-visible names that
 *  validation keeps free of brackets/whitespace, but metacharacters like .
 *  remain possible). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildLogFilterArgs(req: LogFilterRequest): LogFilterResult {
  const args: string[] = ["--user", "-u", req.unit];
  if (req.follow) args.push("-f");

  const level = parseLogLevel(req.level);
  if (!level) {
    return { ok: false, message: t("logs.unknownLevel", { level: req.level }) };
  }

  if (req.requestedProjects.length > 0) {
    // 按名比较两侧同走 normalizeLabelKey(NFKC 归一 + 折叠),与登记唯一性、
    // /pmctl 按名解析同口径 —— 只折叠一侧时 NFKC 变体拼写永远失配(工单
    // fix-label-nfkc-two-side-normalization)。
    const resolve = (requested: string) =>
      req.availableLabels.find((l) => normalizeLabelKey(l) === normalizeLabelKey(requested));
    const unknown = req.requestedProjects.filter((p) => !resolve(p));
    if (unknown.length > 0) {
      const list = req.availableLabels.length > 0 ? req.availableLabels.join(", ") : t("logs.noProjects");
      return {
        ok: false,
        message: t("logs.projectsNotFound", { unknown: unknown.join(", "), list }),
      };
    }
    // 模式嵌入解析出的存量标签原始形式(日志行 [label] 与 availableLabels
    // 同源同形 —— 都是 projectLabelOf 的输出),而非用户的变体拼写:PCRE2 的
    // (?i:…) 只做大小写折叠、不做 NFKC,嵌变体拼写会出现「检测通过但 grep
    // 永远空匹配」。(?i:…) 退为兼容历史日志大小写漂移的兜底;LEVEL 名恒为
    // 大写、不参与折叠 —— 全局 --case=0 会让正文里的 `[error] [label]` 误中
    // (审计工程批 票21)。
    const projects = [...new Set(req.requestedProjects.map((p) => escapeRe(resolve(p)!)))].join("|");
    args.push("--grep", `\\[(${LEVEL_ALTERNATIONS[level]})\\] \\[(?i:(${projects}))\\]`);
  } else if (level !== "debug") {
    args.push("--grep", `\\[(${LEVEL_ALTERNATIONS[level]})\\] `);
  }
  // level=debug without projects: no grep — everything passes (matches the
  // pre-spec intent of `--level debug`, which was silently broken via -p).

  if (req.lineCount !== undefined) args.push("-n", String(req.lineCount));
  return { ok: true, args };
}
