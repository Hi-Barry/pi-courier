import * as fs from "node:fs";
import { t } from "./i18n/index.js";

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
    t("hint.bus.tail1"),
    t("hint.bus.tail2"),
    t("hint.bus.tail3"),
  ];
  if (typeof xdgOwnerUid === "number" && xdgOwnerUid !== euid) {
    return [
      t("hint.bus.ownerMismatch", {
        dir: xdgRuntimeDir ?? t("hint.bus.unsetWithParens"),
        owner: xdgOwnerUid,
        euid,
      }),
      ...tail,
    ].join("\n");
  }
  return [
    t("hint.bus.connectFailed", { dir: xdgRuntimeDir ?? t("hint.bus.unset") }),
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
