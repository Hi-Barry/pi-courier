/**
 * 工作流进度活卡渲染(spec 票2):内部 IR → Markdown 活卡文本的纯函数。
 *
 * 边界约束(spec 验收项):本模块的唯一输入是 src/workflow/types.ts 的
 * WorkflowProgressIR;源码禁出现 dwf 事件类型字符串与 dwf
 * 快照字段名(promptPreview / agentIds / estimatedTokens 等)—— 那些只
 * 归 src/workflow/adapter.ts。文案全部经 i18n 键以 labels 结构传入,
 * 渲染器自身不直接调用 t(),同一文案表可被非 locale 语境复用。
 */

import type { MessageKey } from "../i18n/index.js";
import { t } from "../i18n/index.js";
import type { WorkflowAgentStatus, WorkflowAgentView, WorkflowProgressIR, WorkflowRunStatus } from "./types.js";
import { isTerminal } from "./types.js";

/** 子代理表格裁剪:运行中全部保留,最近完成的保留 4 行,其余折叠成计数。 */
export const RECENT_DONE_KEEP = 4;

/** 一条文案(已是插值后的成品字符串)。 */
export type WorkflowLabel = string;

/** 带插值参数的文案模板:由 i18n 组装层调用。 */
export type WorkflowLabelTemplate = (params: Record<string, string | number>) => string;

/** 渲染所需文案(键经 i18n 组装,见下 WorkflowCardLabels 的注释)。 */
export interface WorkflowCardLabels {
  /** 运行态图标,按 WorkflowRunStatus 取 */
  statusIcon: Record<WorkflowRunStatus, WorkflowLabel>;
  /** 子代理状态文案,按 WorkflowAgentStatus 取 */
  agentStatus: Record<WorkflowAgentStatus, WorkflowLabel>;
  /** 标题行:阶段进度 + tokens/cost 摘要 */
  title: WorkflowLabelTemplate;
  phaseDone: WorkflowLabelTemplate;
  phaseCurrent: WorkflowLabelTemplate;
  phasePending: WorkflowLabelTemplate;
  /** 子代理表头(含换行的 Markdown 表头) */
  agentHeader: WorkflowLabel;
  agentRow: WorkflowLabelTemplate;
  /** 其余已完成子任务的折叠计数行 */
  agentCollapsed: WorkflowLabelTemplate;
  /** 终态结果行 */
  result: WorkflowLabelTemplate;
  /** 尾注:自然语言操控提示 */
  controlHint: WorkflowLabel;
}

/** tokens 人类可读:4210 → 4.2k;不足 1000 原样;百万级 → m。 */
export function formatTokensShort(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = Math.round(n / 100) / 10;
    return `${v}k`;
  }
  const v = Math.round(n / 100_000) / 10;
  return `${v}m`;
}

/** cost 人类可读:有值且 > 0 → "$0.031";否则空串。 */
function formatCost(cost: number | undefined): string {
  return cost !== undefined && cost > 0 ? ` · $${cost.toFixed(3).replace(/0$/, "")}` : "";
}

/** 阶段链行:已见阶段全保留;终态全勾,运行中当前阶段之前视为完成、
 *  之后(上一暂停期见过的阶段)视为未开始。 */
function renderPhaseChain(ir: WorkflowProgressIR, labels: WorkflowCardLabels): string {
  if (ir.seenPhases.length === 0) return "";
  const currentIdx = ir.currentPhase !== undefined ? ir.seenPhases.indexOf(ir.currentPhase) : -1;
  const parts = ir.seenPhases.map((phase, idx) => {
    if (isTerminal(ir.status)) return labels.phaseDone({ phase });
    if (phase === ir.currentPhase) return labels.phaseCurrent({ phase });
    return idx < currentIdx ? labels.phaseDone({ phase }) : labels.phasePending({ phase });
  });
  return parts.join("  ");
}

/**
 * 子代理表格:运行中全部 + 最近完成 RECENT_DONE_KEEP 行 + 其余折叠为计数。
 * 运行/错误行视为「须保留」;完成/跳过的只保留最近 N 行。
 */
export function selectAgentRows(agents: WorkflowAgentView[]): WorkflowAgentView[] {
  const live = agents.filter((a) => a.status === "running" || a.status === "error");
  const finished = agents.filter((a) => a.status === "done" || a.status === "skipped");
  return [...live, ...finished.slice(-RECENT_DONE_KEEP)];
}

/** IR → Markdown 活卡文本。纯函数:不读全局、不发请求、不改入参。 */
export function renderWorkflowProgress(ir: WorkflowProgressIR, labels: WorkflowCardLabels): string {
  // 阶段进度 x/y:终态全勾(y/x);运行中数「当前阶段之前」的阶段,
  // 当前阶段算进行中不计入完成数。
  const currentIdx = ir.currentPhase !== undefined ? ir.seenPhases.indexOf(ir.currentPhase) : -1;
  const doneCount = isTerminal(ir.status) ? ir.seenPhases.length : Math.max(currentIdx, 0);
  const title = labels.title({
    icon: labels.statusIcon[ir.status],
    name: ir.name,
    done: doneCount,
    total: ir.seenPhases.length,
    tokens: formatTokensShort(ir.tokens),
    cost: formatCost(ir.cost),
  });

  const lines: string[] = [title];
  const chain = renderPhaseChain(ir, labels);
  if (chain) lines.push(chain);

  if (ir.agents.length > 0) {
    const rows = selectAgentRows(ir.agents);
    const collapsedCount = ir.agents.length - rows.length;
    lines.push(labels.agentHeader);
    for (const a of rows) {
      lines.push(labels.agentRow({
        label: a.label,
        phase: a.phase || "-",
        status: labels.agentStatus[a.status],
        tokens: a.tokens !== undefined ? formatTokensShort(a.tokens) : "-",
      }));
    }
    if (collapsedCount > 0) {
      lines.push(labels.agentCollapsed({ count: collapsedCount }));
    }
  }

  if (isTerminal(ir.status) && ir.resultPreview) {
    lines.push(labels.result({ result: ir.resultPreview }));
  }
  lines.push(labels.controlHint);
  return lines.join("\n");
}

/** i18n 键集(workflow.* 前缀,zh 表为键集基准)。 */
interface WorkflowKeys {
  statusIcon: Record<WorkflowRunStatus, MessageKey>;
  agentStatus: Record<WorkflowAgentStatus, MessageKey>;
  title: MessageKey;
  phaseDone: MessageKey;
  phaseCurrent: MessageKey;
  phasePending: MessageKey;
  agentHeader: MessageKey;
  agentRow: MessageKey;
  agentCollapsed: MessageKey;
  result: MessageKey;
  controlHint: MessageKey;
}

const WORKFLOW_KEYS: WorkflowKeys = {
  statusIcon: {
    running: "workflow.icon.running",
    paused: "workflow.icon.paused",
    stopped: "workflow.icon.stopped",
    finished: "workflow.icon.finished",
    error: "workflow.icon.error",
  },
  agentStatus: {
    running: "workflow.agentStatus.running",
    done: "workflow.agentStatus.done",
    skipped: "workflow.agentStatus.skipped",
    error: "workflow.agentStatus.error",
  },
  title: "workflow.card.title",
  phaseDone: "workflow.phase.done",
  phaseCurrent: "workflow.phase.current",
  phasePending: "workflow.phase.pending",
  agentHeader: "workflow.agent.header",
  agentRow: "workflow.agent.row",
  agentCollapsed: "workflow.agent.collapsed",
  result: "workflow.result",
  controlHint: "workflow.control.hint",
};

/** 从 i18n 表组装渲染文案(当前 locale);路由层一次组装、反复使用。 */
export function workflowCardLabels(): WorkflowCardLabels {
  return {
    statusIcon: {
      running: t(WORKFLOW_KEYS.statusIcon.running),
      paused: t(WORKFLOW_KEYS.statusIcon.paused),
      stopped: t(WORKFLOW_KEYS.statusIcon.stopped),
      finished: t(WORKFLOW_KEYS.statusIcon.finished),
      error: t(WORKFLOW_KEYS.statusIcon.error),
    },
    agentStatus: {
      running: t(WORKFLOW_KEYS.agentStatus.running),
      done: t(WORKFLOW_KEYS.agentStatus.done),
      skipped: t(WORKFLOW_KEYS.agentStatus.skipped),
      error: t(WORKFLOW_KEYS.agentStatus.error),
    },
    title: (p) => t(WORKFLOW_KEYS.title, p),
    phaseDone: (p) => t(WORKFLOW_KEYS.phaseDone, p),
    phaseCurrent: (p) => t(WORKFLOW_KEYS.phaseCurrent, p),
    phasePending: (p) => t(WORKFLOW_KEYS.phasePending, p),
    agentHeader: t(WORKFLOW_KEYS.agentHeader),
    agentRow: (p) => t(WORKFLOW_KEYS.agentRow, p),
    agentCollapsed: (p) => t(WORKFLOW_KEYS.agentCollapsed, p),
    result: (p) => t(WORKFLOW_KEYS.result, p),
    controlHint: t(WORKFLOW_KEYS.controlHint),
  };
}
