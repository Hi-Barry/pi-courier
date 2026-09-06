import * as fs from "node:fs";

/**
 * Targeted hint for the `su`-without-`-` trap (issue #59, observed live on
 * the 2026-09-06 deployment): switching users with `su <user>` inherits the
 * ORIGINAL user's XDG_RUNTIME_DIR, so every `systemctl --user` then tries to
 * connect to another user's bus socket (mode 0700) and fails with
 * "Operation not permitted ... to connect to bus of other user". The stock
 * error never says what to do — this hint does.
 */

/** Decision input; xdgOwnerUid comes from dirOwnerUid (null = unresolvable). */
export interface BusFailureHintInput {
  euid: number;
  xdgRuntimeDir?: string;
  xdgOwnerUid?: number | null;
  stderr?: string;
}

/** Pure decision: is this systemctl failure the bus-owner trap, and if so,
 *  what should the user do? Returns null for everything else — the generic
 *  error output already printed is then the whole story. */
export function busFailureHint(input: BusFailureHintInput): string | null {
  const { euid, xdgRuntimeDir, xdgOwnerUid, stderr } = input;
  const ownerMismatch = typeof xdgOwnerUid === "number" && xdgOwnerUid !== euid;
  const stderrPointsAtBus =
    typeof stderr === "string" &&
    (/connect to bus of other user/i.test(stderr) ||
      (/user scope bus/i.test(stderr) && /not permitted/i.test(stderr)));
  if (!ownerMismatch && !stderrPointsAtBus) return null;
  const dir = xdgRuntimeDir ?? "(未设置)";
  const owner = typeof xdgOwnerUid === "number" ? String(xdgOwnerUid) : "未知";
  return [
    `💡 检测到 XDG_RUNTIME_DIR=${dir}(属主 uid ${owner})指向其他用户的会话总线,而当前用户是 uid ${euid}。`,
    "   常见原因:用 `su <用户>`(不带 -)切换用户时继承了原用户的环境。",
    "   解决:export XDG_RUNTIME_DIR=/run/user/$(id -u) 后重试,或改用 `su - <用户>` 重新切换。",
  ].join("\n");
}

/** Owning uid of dir, or null when it cannot be resolved (missing/unreachable). */
export function dirOwnerUid(dir: string | undefined): number | null {
  if (!dir) return null;
  try {
    return fs.statSync(dir).uid;
  } catch {
    return null;
  }
}
