/**
 * 工作流进度活卡(spec:dwf 快照 → 内部 IR)。本文件只放类型,零逻辑;
 * 快照→IR 的归一在 adapter.ts,渲染在 render.ts。
 */

/** 工作流运行态(IR 归一后)。映射:dwf running→running;paused→paused;
 *  aborted/stopped→stopped;completed→finished;failed→error。 */
export type WorkflowRunStatus = "running" | "paused" | "stopped" | "finished" | "error";

/** 子代理运行态(IR 归一后)。映射:dwf running→running;done→done;
 *  skipped→skipped;error→error。 */
export type WorkflowAgentStatus = "running" | "done" | "skipped" | "error";

export function isTerminal(status: WorkflowRunStatus): boolean {
  return status === "stopped" || status === "finished" || status === "error";
}

/** 单个子代理的视图。agents 按 id 累积合并 —— 完成/跳过的子代理不从后续快照消失。 */
export interface WorkflowAgentView {
  /** dwf agent id,累积合并的合并键 */
  id: number;
  /** 子代理名称(如 "P3 agent 3") */
  label: string;
  /** 所属阶段名(如 "P3") */
  phase: string;
  status: WorkflowAgentStatus;
  tokens?: number;
  /** resultPreview 截断(adapter 内限 120 字符) */
  preview?: string;
}

/** 一次工作流运行的内部表示,渲染层唯一输入。 */
export interface WorkflowProgressIR {
  /** 卡片身份,per-rpc 账本的 Map 键 */
  runId: string;
  /** 工作流名 */
  name: string;
  status: WorkflowRunStatus;
  currentPhase?: string;
  /** 已见阶段按首见顺序累积去重,渲染阶段链用 */
  seenPhases: string[];
  /** 按 id 累积保留历史(完成/跳过者不从后续快照消失) */
  agents: WorkflowAgentView[];
  /** 累计 */
  tokens: number;
  /** 累计 */
  cost?: number;
  resultPreview?: string;
}
