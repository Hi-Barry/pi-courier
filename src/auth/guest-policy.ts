import { BANG_COMMAND, commandPolicy, PMCTL_COMMAND } from "../command-registry.js";

/**
 * Guest policy (issue #120): what a guest may not do. Pure module — one
 * verdict function over the command registry (架构候选3). Snapshot-pinned
 * by tests: a new dangerous command that forgets to register there turns a
 * test red.
 *
 * The boundary is the bridge-side surface only: guests chat freely (their
 * conversation may still drive the agent's own tools — pi has no per-session
 * tool switch, and prompt-prefix "limits" are not a permission boundary).
 * Room enable modes keep their semantics: a `trusted-only` room keeps guests
 * out entirely (mode first, tier second).
 */

// bang 触发规则与禁用清单单一持有于 command-registry(架构候选3:零依赖
// 叶子,auth 依赖它无环)——本模块保留裁决语义,是 auth 侧的守门人。

export interface GuestVerdict {
  blocked: boolean;
  /** 命中的触发词(回执与审计用);未命中时为 ""。 */
  command: string;
}

/** 访客对一条输入的裁决:shell bang 与禁用斜杠命中的都算越权,回执礼貌
 *  说明 + 审计留痕;普通对话与放行命令照常进管道。 */
export function guestCommandVerdict(text: string): GuestVerdict {
  const trimmed = text.trim();
  const bang = BANG_COMMAND.exec(trimmed);
  if (bang) {
    return { blocked: true, command: `${bang[1]} ${bang[2]!.split(/\s+/)[0]}` };
  }
  if (!trimmed.startsWith("/")) return { blocked: false, command: "" };
  const name = trimmed.split(/\s+/)[0]!.toLowerCase();
  if (commandPolicy(name)?.guest === "blocked" || name.startsWith(PMCTL_COMMAND)) {
    return { blocked: true, command: name };
  }
  return { blocked: false, command: "" };
}
