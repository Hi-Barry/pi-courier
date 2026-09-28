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
import { t } from "./i18n/index.js";

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
 *  facing, in the configured locale) or null when the label is acceptable. */
export function validateProjectLabel(candidate: string, existingLabels: string[]): string | null {
  const name = candidate.trim();
  if (!name) return t("label.empty");
  if (/[[\]]/.test(name)) return t("label.noBrackets");
  if (/\s/.test(name)) return t("label.noWhitespace");
  if (name.length > MAX_LABEL_LENGTH) return t("label.tooLong", { max: MAX_LABEL_LENGTH, length: name.length });
  const lower = name.toLowerCase();
  const clash = existingLabels.find((l) => l.toLowerCase() === lower);
  if (clash) return t("label.caseClash", { name, clash });
  return null;
}
