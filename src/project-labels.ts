/**
 * Project labels — the single resolution/validation point for the `[标签]`
 * segment on tagged log lines (spec #34).
 *
 * One rule used by three consumers so they can never drift:
 *  - log rendering (withLabel on the project's logger view)
 *  - /pmctl validation (new + rename reject what the log format cannot carry)
 *  - `pi-courier logs <项目>` matching (CLI filters by the same value)
 *
 * Resolution: explicit name, else the workdir basename (never the raw room
 * ID — unreadable as a tag). Validation guards the line format itself: no
 * brackets/whitespace (the tag is delimited by them), length cap (bounded
 * lines), and case-insensitive uniqueness (log filtering is case-insensitive,
 * so two labels differing only in case would collide in `logs <name>`).
 */

import * as path from "node:path";

export interface LabelSource {
  name?: string;
  workdir: string;
}

/** The label for a project entry: trimmed name when present, else the
 *  workdir basename (empty basename — the root "/" workdir — falls back to
 *  the workdir itself, so a label is never empty). */
export function projectLabelOf(entry: LabelSource): string {
  const name = entry.name?.trim();
  return name || path.basename(entry.workdir) || entry.workdir;
}

const MAX_LABEL_LENGTH = 30;

/** Validate a user-supplied label against the format rules and the existing
 *  labels (case-insensitive uniqueness). Returns an error message (user-
 *  facing, Chinese) or null when the label is acceptable. */
export function validateProjectLabel(candidate: string, existingLabels: string[]): string | null {
  const name = candidate.trim();
  if (!name) return "项目名不能为空";
  if (/[[\]]/.test(name)) return "项目名不能包含方括号 [ ](会破坏日志格式)";
  if (/\s/.test(name)) return "项目名不能包含空白字符";
  if (name.length > MAX_LABEL_LENGTH) return `项目名最长 ${MAX_LABEL_LENGTH} 字符(当前 ${name.length})`;
  const lower = name.toLowerCase();
  const clash = existingLabels.find((l) => l.toLowerCase() === lower);
  if (clash) return `项目名「${name}」与现有项目「${clash}」仅大小写不同(日志过滤按名字匹配,会混淆)`;
  return null;
}
