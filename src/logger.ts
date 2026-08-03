/**
 * Leveled logger shared by the bridge runtime.
 *
 * Levels: debug < info < warn < error. The write threshold defaults to
 * "info" (DEBUG lines are not emitted unless raised); the CLI can raise it
 * via `--level debug` (run / logs), and config `logLevel` can lower/raise
 * the write threshold for the service.
 *
 * Output format: `[ISO timestamp] [LEVEL] message` — one line per call.
 * Objects are JSON-serialized; long strings are truncated (bounded lines,
 * journald-friendly).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_NAMES: Record<LogLevel, string> = { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" };

/** Truncation limits keep log lines bounded (journald-friendly). */
const MAX_STRING = 2000;

let writeThreshold: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  writeThreshold = level;
}

export function getLogLevel(): LogLevel {
  return writeThreshold;
}

/** Parse a CLI/config level string; undefined when invalid. */
export function parseLogLevel(value: string): LogLevel | undefined {
  const v = value.trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  if (v === "warning") return "warn";
  if (v === "err" || v === "fatal") return "error";
  return undefined;
}

export function isEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[writeThreshold];
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg.length > MAX_STRING ? `${arg.slice(0, MAX_STRING)}…(+${arg.length - MAX_STRING} chars)` : arg;
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      const s = JSON.stringify(arg);
      return s && s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : (s ?? String(arg));
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function write(level: LogLevel, args: unknown[]): void {
  if (!isEnabled(level)) return;
  const line = [`[${new Date().toISOString()}]`, `[${LEVEL_NAMES[level]}]`, ...args.map(formatArg)].join(" ");
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (...args: unknown[]): void => write("debug", args),
  info: (...args: unknown[]): void => write("info", args),
  warn: (...args: unknown[]): void => write("warn", args),
  error: (...args: unknown[]): void => write("error", args),
};
