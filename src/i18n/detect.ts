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
 *
 * Windows fallback (issue #189): Windows sets none of the POSIX variables,
 * so a Chinese Windows box used to fall through to "en". When the host is
 * win32 AND the POSIX chain is empty, consult the ICU default locale —
 * Node seeds it from the system regional setting, so a zh* value means a
 * Chinese Windows. This is deliberately NOT a general cross-platform rung:
 * POSIX hosts keep the exact pre-#189 behavior (env vars or null), and the
 * fallback stays win32-gated. Caveat: the ICU locale reflects the regional
 * format, not strictly the display language — for the overwhelmingly common
 * "display language and region agree" case the two coincide; users in a
 * mixed configuration can always pin PI_LANGUAGE / config language.
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

/** ICU default locale probe — never throws (a detection failure must not
 *  break startup; the chain then reports "nothing usable"). */
export function defaultWindowsLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * Detect from process env (injectable for tests). Null = nothing usable.
 * `platform` and `windowsLocale` are seams so the win32 branch is testable
 * on any CI runner (production callers rely on the defaults).
 */
export function detectSystemLanguage(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  windowsLocale: () => string | undefined = defaultWindowsLocale
): Locale | null {
  for (const name of POSIX_LANG_VARS) {
    const parsed = parseLocaleValue(env[name]);
    if (parsed) return parsed;
  }
  if (platform === "win32") return parseLocaleValue(windowsLocale());
  return null;
}
