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
 *  error output already printed is then the whole story.
 *
 *  Two corroborated shapes (issue #59 acceptance: unrelated failures like a
 *  missing unit must NOT get this hint):
 *   - XDG_RUNTIME_DIR is owned by another user AND stderr shows the EPERM
 *     connect failure (on such a machine connect always fails first);
 *   - stderr itself carries the connect signature (XDG_RUNTIME_DIR unset or
 *     unresolvable — e.g. a shell without a full login session). */
export function busFailureHint(input: BusFailureHintInput): string | null {
  const { euid, xdgRuntimeDir, xdgOwnerUid, stderr } = input;
  const stderrText = typeof stderr === "string" ? stderr : undefined;
  const stderrPointsAtBus =
    !!stderrText &&
    (/connect to bus of other user/i.test(stderrText) ||
      (/user scope bus/i.test(stderrText) && /not permitted/i.test(stderrText)));
  const ownerMismatchWithEperm =
    typeof xdgOwnerUid === "number" &&
    xdgOwnerUid !== euid &&
    !!stderrText &&
    /not permitted|EPERM/i.test(stderrText);
  if (!stderrPointsAtBus && !ownerMismatchWithEperm) return null;

  const tail = [
    "   常见原因:用 `su <用户>`(不带 -)切换用户时继承了原用户的环境,或当前 shell 缺少完整登录会话。",
    "   解决:export XDG_RUNTIME_DIR=/run/user/$(id -u) 后重试,或改用 `su - <用户>` 重新切换;",
    "   若 /run/user/$(id -u) 不存在,请以该用户登录一次,或由 root 执行 loginctl enable-linger <用户>。",
  ];
  if (typeof xdgOwnerUid === "number" && xdgOwnerUid !== euid) {
    return [
      `💡 检测到 XDG_RUNTIME_DIR=${xdgRuntimeDir ?? "(未设置)"}(属主 uid ${xdgOwnerUid})指向其他用户的会话总线,而当前用户是 uid ${euid}。`,
      ...tail,
    ].join("\n");
  }
  return [
    `💡 未能连接到当前用户的 systemd 会话总线(XDG_RUNTIME_DIR=${xdgRuntimeDir ?? "未设置"})。`,
    ...tail,
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
