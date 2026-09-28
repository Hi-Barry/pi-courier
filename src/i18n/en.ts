/**
 * English message table (issue #83). Key-aligned to the zh baseline table by
 * the compiler: Record<MessageKey, string> rejects both missing and extra
 * keys at typecheck time — the two tables can never drift.
 */
import type { MessageKey } from "./zh.js";

const en: Record<MessageKey, string> = {
  // ── common ────────────────────────────────────────────────────────────
  "common.cancel": "cancel",
  "common.on": "on",
  "common.off": "off",

  // ── cmd ───────────────────────────────────────────────────────────────
  "cmd.new.ok": "✅ New session started",
  "cmd.new.cancelled": "⚠️ New session cancelled by an extension",
  "cmd.generic.error": "❌ Command failed: {message}",

  // ── startup ───────────────────────────────────────────────────────────
  "startup.language.system":
    "language: {locale} (detected from the system locale; set \"language\" in ~/.pi/pi-courier.json or PI_LANGUAGE to override)",
  "startup.language.default":
    "language: {locale} (default; set \"language\" in ~/.pi/pi-courier.json or PI_LANGUAGE to override)",
};

export default en;
