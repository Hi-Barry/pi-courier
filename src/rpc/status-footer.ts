/**
 * 回复末尾状态脚注:终答出站时把 工作目录 / 上下文占用 / 模型·思考等级
 * 拼成一行语言中立的注脚(全符号+路径+数字,无需 i18n)。数据现拉现用
 * ——没有模型/思考变更的推送事件可依赖,每条终答两次本地 stdio RPC
 * 往返(/status 同款取法);每项独立 try/catch,任何一段取不到就显示
 * '?',collectStatusFooter 永不抛。
 */
import type { PiRpc } from "./pi-rpc.js";

/** 三段脚注的取数结果;null = 该段取不到(拼接时显示 '?')。 */
export interface StatusFooterInfo {
  cwd: string | null;
  context: string | null;
  model: string | null;
}

/** 上下文窗口的人类刻度:≥1e6 一位小数 M(1_000_000→'1.0M'),≥1e3 整数 k
 *  (200_000→'200k'),否则原值(999→'999')。 */
export function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 从 rpc 现拉三段数据。每项独立容错 —— 含测试 mock 缺方法的 TypeError
 *  与 requireClient 的未连接抛错,任何异常都只降级为该段 null('?')。 */
export async function collectStatusFooter(rpc: PiRpc): Promise<StatusFooterInfo> {
  const info: StatusFooterInfo = { cwd: null, context: null, model: null };
  try {
    info.cwd = rpc.cwd ?? null;
  } catch {
    // 该段保持 null('📂 ?')
  }
  try {
    const state = await rpc.requireClient().getState();
    const name = state.model?.name || state.model?.id;
    // 思考等级缺失时只显示模型;'·' 直连不分隔(如 GLM-5.3·high)。
    if (name) info.model = state.thinkingLevel ? `${name}·${state.thinkingLevel}` : name;
  } catch {
    // 模型·思考合并段保持 null(getState 整体失败 → '🤖 ?')
  }
  try {
    const usage = (await rpc.requireClient().getSessionStats()).contextUsage;
    if (usage) {
      // percent 为 null(手动压缩后无新 LLM 响应)→ '?',窗口仍可显示。
      const percent = typeof usage.percent === "number" ? `${usage.percent.toFixed(1)}%` : "?";
      info.context = `${percent}/${formatContextWindow(usage.contextWindow)}`;
    }
  } catch {
    // 上下文段保持 null('📜 ?')
  }
  return info;
}

/** 正文是否停在未闭合的代码围栏里(模型漏关 ``` 或分片恰好切进围栏)。
 *  围栏行 = 行首 0-3 空格 + ≥3 个连续 ` 或 ~;只有同字符、长度不小于开栏
 *  的围栏行才能闭合。返回未闭合的开栏标记(如 '```'),已闭合返回 null。 */
function unclosedFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m?.[1]) continue;
    const marker = m[1];
    if (open === null) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = null;
  }
  return open;
}

/** 把脚注行接到正文末尾。分割线前必须空行('\n\n')——MarkdownIt 下
 *  '---' 不带空行会把正文上一行吞成 setext <h2>,带空行才渲染 <hr>;
 *  段间 ' · '(空格+间隔号)即窄屏自然折行点。正文停在未闭合代码围栏
 *  里时先补上同款闭合围栏 —— 否则分割线与脚注整体落进代码块按字面
 *  渲染(markdown-it 实测 <pre> 内无 <hr>)。 */
export function appendStatusFooter(text: string, info: StatusFooterInfo): string {
  const open = unclosedFence(text);
  const body = open ? `${text}\n${open}` : text;
  return `${body}\n\n---\n\n📂 ${info.cwd ?? "?"} · 📜 ${info.context ?? "?"} · 🤖 ${info.model ?? "?"}`;
}
