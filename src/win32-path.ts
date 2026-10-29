/**
 * Windows path robustness guards (issue #190) — a win32-only sanity check for
 * project workdirs, applied at registration time (/pmctl new, /pmctl mv) so a
 * path that Windows cannot host is refused with a readable message BEFORE any
 * room is created or any process spawned.
 *
 * Three failure classes, all observed as cryptic downstream errors otherwise:
 *  - DOS reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or
 *    without an extension — "NUL.txt" is reserved too): mkdir of such a
 *    component fails with EPERM/EINVAL deep inside the pi spawn.
 *  - Characters illegal in NTFS names (`< > : " | ? *`, plus the drive-letter
 *    colon as the one legal colon): a name like `a:b` silently becomes an
 *    alternate data stream.
 *  - Paths over the classic MAX_PATH (260): whether long paths work depends
 *    on the machine's long-path policy (registry + process manifest), so the
 *    prerequirement for a deterministic outcome is a readable refusal.
 *
 * POSIX hosts are untouched: the check is win32-gated at the call site, and
 * these pure functions are platform-parameterized for tests. The component
 * scanner is deliberately string-based (no path.win32 dependency) so the
 * win32 branch is testable on any CI runner.
 */

/** OK, or one of the three refusal kinds. */
export type Win32PathProblem =
  | { kind: "reserved"; component: string }
  | { kind: "illegalChars"; component: string }
  | { kind: "tooLong"; length: number };

/** 260 including the terminator — 259 usable characters is the classic limit. */
export const MAX_PATH_LENGTH = 260;

const RESERVED_COMPONENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Characters NTFS rejects inside a component. The drive-letter colon is
 *  handled by splitting: a leading `X:` segment is exempt. */
const ILLEGAL_CHARS = /[<>:"|?*]/;

/** First offending problem in `workdir`, or null when Windows can host it. */
export function win32PathProblem(workdir: string): Win32PathProblem | null {
  if (workdir.length > MAX_PATH_LENGTH - 1) {
    return { kind: "tooLong", length: workdir.length };
  }
  const segments = workdir.split(/[/\\]/);
  for (let i = 0; i < segments.length; i += 1) {
    const component = segments[i]!;
    if (!component) continue; // UNC double-slash runs and leading/trailing separators
    // A bare drive designator (C:) is legal exactly in position 0.
    if (i === 0 && /^[A-Za-z]:$/.test(component)) continue;
    if (RESERVED_COMPONENT.test(component)) return { kind: "reserved", component };
    if (ILLEGAL_CHARS.test(component)) return { kind: "illegalChars", component };
  }
  return null;
}

/** Whether two workdirs denote the same directory on case-insensitive NTFS.
 *  Compares folded forms; callers only use this on win32 — on POSIX the two
 *  case variants are genuinely different directories. */
export function win32SamePath(a: string, b: string): boolean {
  return a.normalize("NFKC").toLowerCase() === b.normalize("NFKC").toLowerCase();
}

/**
 * Whether a shell command contains an UNQUOTED drive-letter backslash path
 * (`X:\...`, spec #256). Outside quotes bash strips those backslashes as
 * escapes (`d:\share\Projects` → `d:shareProjects`), so such a command fails
 * with a cryptic error on the Git Bash that backs `!`/`!!`/`/bash` on Windows.
 * Callers use the signal to append a syntax hint to the failure reply — the
 * command itself is never rewritten.
 *
 * Quote-aware scanner, mirroring the shell semantics that actually matter
 * here: outside quotes `\` escapes the next character; inside single quotes
 * everything is literal; inside double quotes a `\` before `$ ` \ "` — the
 * POSIX special few — is an escape (scanned conservatively as "escapes the
 * next character"; identical verdict either way), so a quoted path reaches
 * Git Bash intact and works — no signal. A doubled backslash (`d:\\share`)
 * also arrives intact, and bash keeps a lone trailing `\` at end of input
 * literal; only a single backslash escaping a real character signals.
 * `X:/...` works unquoted either way.
 */
export function unquotedWin32DrivePath(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\") i += 1; // escaped char inside double quotes
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // Drive form at an unescaped `X:`: the separator backslash only mangles
    // the path when it escapes a REAL character other than a backslash (a
    // trailing lone `\` at end of input stays literal in bash).
    if (ch === ":" && i > 0 && /[A-Za-z]/.test(command[i - 1]!)) {
      const next = command[i + 1];
      if (next === "\\" && i + 2 < command.length && command[i + 2] !== "\\") return true;
    }
    if (ch === "\\") {
      i += 1; // escaped char outside quotes (`d:\\share` arrives intact)
    }
  }
  return false;
}
