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

/**
 * Log-line suppression window, shared by every logger instance: while open,
 * lines whose message contains one of the substrings are dropped at every
 * level, from any module. Matching runs on the UNtruncated rendering — a
 * >2000-char noise line must not escape by having its pattern past the
 * truncation point. The one consumer is the Matrix adapter, which opens the
 * window around the SDK's initial sync (it replays history and emits two
 * known-benign error patterns — see matrix.ts). Process-wide state is
 * honest here: the SDK's LogService is itself process-wide. The returned
 * closer removes exactly the substrings this call added.
 */
let suppressionPatterns: string[] = [];

export function suppressLogLines(...substrings: string[]): () => void {
  suppressionPatterns.push(...substrings);
  return () => {
    suppressionPatterns = suppressionPatterns.filter(p => !substrings.includes(p));
  };
}

function isSuppressed(args: unknown[]): boolean {
  if (suppressionPatterns.length === 0) return false;
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  return suppressionPatterns.some(p => msg.includes(p));
}

export interface LeveledLogger {
  setLogLevel(level: LogLevel): void;
  getLogLevel(): LogLevel;
  isEnabled(level: LogLevel): boolean;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Create an isolated leveled logger. The write threshold lives in the
 * instance, so tests never share that piece of module state; the one
 * deliberately shared piece is the suppression window below, which models
 * a process-wide event (the SDK sync whose noise it hides) rather than
 * logger configuration.
 */
export function createLogger(initial: LogLevel = "info"): LeveledLogger {
  let threshold: LogLevel = initial;

  const isEnabled = (level: LogLevel): boolean => LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];

  const write = (level: LogLevel, args: unknown[]): void => {
    if (!isEnabled(level)) return;
    if (isSuppressed(args)) return;
    const line = [`[${new Date().toISOString()}]`, `[${LEVEL_NAMES[level]}]`, ...args.map(formatArg)].join(" ");
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  return {
    setLogLevel: (level: LogLevel) => {
      threshold = level;
    },
    getLogLevel: () => threshold,
    isEnabled,
    debug: (...args: unknown[]) => write("debug", args),
    info: (...args: unknown[]) => write("info", args),
    warn: (...args: unknown[]) => write("warn", args),
    error: (...args: unknown[]) => write("error", args),
  };
}

/** Parse a CLI/config level string; undefined when invalid. */
export function parseLogLevel(value: string): LogLevel | undefined {
  const v = value.trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  if (v === "warning") return "warn";
  if (v === "err" || v === "fatal") return "error";
  return undefined;
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

const defaultLogger = createLogger();

export const logger: LeveledLogger = defaultLogger;
export const setLogLevel = defaultLogger.setLogLevel;
export const getLogLevel = defaultLogger.getLogLevel;
export const isEnabled = defaultLogger.isEnabled;
