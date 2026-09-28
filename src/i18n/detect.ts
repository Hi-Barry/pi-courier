/**
 * System-locale language detection (issue #83) — the third rung of the
 * language chain: PI_LANGUAGE env > config "language" > system locale > "en".
 *
 * POSIX semantics: LC_ALL overrides LC_MESSAGES overrides LANG; "C"/"POSIX"
 * and empty values carry no language information and are skipped. A value
 * whose language prefix is `zh` (zh, zh_CN, zh-Hant-TW, zh_TW.UTF-8 …)
 * selects zh — note the zh table is Simplified Chinese only, so zh_TW/zh_HK
 * users get Simplified (documented). Any other resolvable value maps to en.
 * No information at all returns null (the caller falls back to "en" and
 * labels the source "default").
 */

import type { Locale } from "./index.js";

const POSIX_LANG_VARS = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

/** One locale value → "zh" | "en" | null (null = no language information). */
export function parseLocaleValue(value: string | undefined): Locale | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "C" || trimmed === "POSIX") return null;
  const prefix = trimmed.split(/[._@-]/)[0]!.toLowerCase();
  return prefix === "zh" ? "zh" : "en";
}

/** Detect from process env (injectable for tests). Null = nothing usable. */
export function detectSystemLanguage(env: NodeJS.ProcessEnv = process.env): Locale | null {
  for (const name of POSIX_LANG_VARS) {
    const parsed = parseLocaleValue(env[name]);
    if (parsed) return parsed;
  }
  return null;
}
