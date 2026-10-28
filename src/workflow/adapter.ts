/**
 * dwf 快照 → 内部 IR 的纯函数 adapter(spec 票1)。
 *
 * 边界约束(spec 验收项):dwf 专属字段名(promptPreview / currentPhase /
 * agentIds / estimatedTokens 等)与 customType 字符串
 * "pi-dynamic-workflows:progress" 只允许出现在本文件与类型定义处
 * (src/workflow/adapter.ts、src/workflow/types.ts),渲染器与路由层
 * 一律消费内部 IR,不得出现 dwf 字符串。
 */
import type { WorkflowAgentStatus, WorkflowAgentView, WorkflowProgressIR, WorkflowRunStatus } from "./types.js";
import { isTerminal } from "./types.js";

/** dwf 进度事件的自定义类型标识(全仓库唯一出现处) */
export const WORKFLOW_PROGRESS_CUSTOM_TYPE = "pi-dynamic-workflows:progress";

/** 只认快照版本 1;其余丢弃。 */
const SUPPORTED_VERSION = 1;

/** resultPreview / agent preview 截断上限(字符) */
const PREVIEW_MAX = 120;

/** dwf → IR 运行态归一映射;未知状态视为 running(下个快照会再校准)。 */
const RUN_STATUS_MAP: Record<string, WorkflowRunStatus> = {
  running: "running",
  paused: "paused",
  aborted: "stopped",
  stopped: "stopped",
  completed: "finished",
  failed: "error",
};

/** dwf → IR 子代理运行态归一映射;未知状态视为 running。 */
const AGENT_STATUS_MAP: Record<string, WorkflowAgentStatus> = {
  running: "running",
  done: "done",
  skipped: "skipped",
  error: "error",
};

/** dwf 快照的宽松形状(字段均按 unknown 读,不信任来源)。 */
interface DwfSnapshot {
  version?: unknown;
  runId?: unknown;
  name?: unknown;
  status?: unknown;
  currentPhase?: unknown;
  tokens?: unknown;
  cost?: unknown;
  resultPreview?: unknown;
  agents?: unknown;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function truncate(s: string): string {
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) : s;
}

/**
 * 解析一条 dwf 进度快照并与上一份 IR 累积合并。
 * 非 dwf 进度事件、版本非 1、形状不合法 → undefined(调用方跳过)。
 * 累积规则:agents 按 id upsert(完成/跳过者不从后续快照消失,但状态/计数
 * 以最新快照为准);seenPhases 按首见顺序去重追加;tokens/cost 取快照最新值。
 */
export function parseWorkflowProgress(raw: unknown, prev?: WorkflowProgressIR): WorkflowProgressIR | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const event = raw as { customType?: unknown; data?: unknown };
  if (event.customType !== WORKFLOW_PROGRESS_CUSTOM_TYPE) return undefined;
  const data = (typeof event.data === "object" && event.data !== null ? event.data : undefined) as DwfSnapshot | undefined;
  if (!data || data.version !== SUPPORTED_VERSION) return undefined;
  const runId = asString(data.runId);
  const name = asString(data.name);
  const rawStatus = asString(data.status);
  if (!runId || !name || !rawStatus) return undefined;
  const status = RUN_STATUS_MAP[rawStatus];
  if (!status) return undefined;

  const agents: WorkflowAgentView[] = [];
  if (Array.isArray(data.agents)) {
    for (const a of data.agents) {
      if (typeof a !== "object" || a === null) continue;
      const agent = a as Record<string, unknown>;
      const id = asNumber(agent.id);
      const label = asString(agent.label);
      const phase = asString(agent.phase);
      const agentRawStatus = asString(agent.status);
      if (id === undefined || !label || !agentRawStatus) continue;
      const agentStatus = AGENT_STATUS_MAP[agentRawStatus];
      if (!agentStatus) continue;
      const preview = asString(agent.resultPreview);
      const tokens = asNumber(agent.tokens);
      agents.push({
        id,
        label,
        phase: phase ?? "",
        status: agentStatus,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(preview ? { preview: truncate(preview) } : {}),
      });
    }
  }

  const currentPhase = asString(data.currentPhase);
  const tokens = asNumber(data.tokens);
  const cost = asNumber(data.cost);
  const resultPreview = asString(data.resultPreview);

  // 累积合并:以 prev 为底,按 id upsert 快照里的 agents,再按快照 agentIds
  // 顺序重排 —— 完成的子代理不从后续快照消失。
  const byId = new Map<number, WorkflowAgentView>();
  if (prev) for (const a of prev.agents) byId.set(a.id, a);
  for (const a of agents) byId.set(a.id, a);
  const merged = Array.isArray(data.agents)
    ? [...byId.values()].sort((x, y) => x.id - y.id)
    : (prev?.agents ?? []);

  const seenPhases = [...(prev?.seenPhases ?? [])];
  if (currentPhase && !seenPhases.includes(currentPhase)) seenPhases.push(currentPhase);

  return {
    runId,
    name,
    status,
    ...(currentPhase ? { currentPhase } : {}),
    seenPhases,
    agents: merged,
    tokens: tokens ?? prev?.tokens ?? 0,
    ...(cost !== undefined ? { cost } : prev?.cost !== undefined ? { cost: prev.cost } : {}),
    ...(resultPreview ? { resultPreview: truncate(resultPreview) } : prev?.resultPreview ? { resultPreview: prev.resultPreview } : {}),
  };
}

export { isTerminal };
