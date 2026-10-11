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

/** Lower-bound thresholds: `--level X` shows X and everything louder. */
const LEVEL_ALTERNATIONS: Record<LogLevel, string> = {
  debug: "DEBUG|INFO|WARN|ERROR",
  info: "INFO|WARN|ERROR",
  warn: "WARN|ERROR",
  error: "ERROR",
};

export interface LogFilterRequest {
  /** Labels of all registered projects (case-sensitively stored; matched with `--case=0`). */
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
    const unknown = req.requestedProjects.filter(
      (p) => !req.availableLabels.some((l) => l.toLowerCase() === p.toLowerCase())
    );
    if (unknown.length > 0) {
      const list = req.availableLabels.length > 0 ? req.availableLabels.join(", ") : t("logs.noProjects");
      return {
        ok: false,
        message: t("logs.projectsNotFound", { unknown: unknown.join(", "), list }),
      };
    }
    // 大小写折叠只作用于项目组(PCRE2 内联 (?i:…)),LEVEL 名恒为大写、
    // 不参与折叠 —— 全局 --case=0 会让正文里的 `[error] [label]` 误中
    // (审计工程批 票21)。JS 侧未知项目检测同样只折叠标签,两侧口径一致。
    const projects = req.requestedProjects.map(escapeRe).join("|");
    args.push("--grep", `\\[(${LEVEL_ALTERNATIONS[level]})\\] \\[(?i:(${projects}))\\]`);
  } else if (level !== "debug") {
    args.push("--grep", `\\[(${LEVEL_ALTERNATIONS[level]})\\] `);
  }
  // level=debug without projects: no grep — everything passes (matches the
  // pre-spec intent of `--level debug`, which was silently broken via -p).

  if (req.lineCount !== undefined) args.push("-n", String(req.lineCount));
  return { ok: true, args };
}
