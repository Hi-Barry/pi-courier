/**
 * 表情语义映射(spec #267 票02,#269):两条确认流(离线积压征询、extension
 * 提问)共用的 emoji 常量与 key→语义 解析纯函数,集中一处 —— 换表情符号
 * 或加新映射只动本模块。只做纯映射,不 import 传输层/路由层;种表情的
 * 发送降级与授权闸门都在调用方(router/各流)。
 *
 * 双形态约定(spec #267 Implementation Decisions):键帽数字既认键帽形
 * (`1️⃣` = `1\uFE0F\u20E3`,digit + VS16 + combining keycap;🔟 是独立码位
 * U+1F51F),也认裸数字 `"1"`;VS16 被某些客户端剥落的 `1\u20E3` 一并接受。
 * 未知 key 返回 unknown —— 噪音策略由调用方定(本桥:静默)。
 */

/** 肯定侧:执行 / `y`。与 hermes 审批语义(✅ approve)同方向。 */
export const REACTION_APPROVE = "✅";
/** 否定侧:忽略 / `n`。 */
export const REACTION_REJECT = "❌";

/** 解析后的 reaction 语义。digit.index 为 1 基(select 选项序号,1..10)。 */
export type ReactionKey =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "digit"; index: number }
  | { kind: "unknown" };

/** 键帽数字 1..9 的规范键帽形(digit + VS16 + U+20E3)。 */
function keycap(index: number): string {
  return `${index}\uFE0F\u20E3`;
}

/** TEN 的键帽没有组合序列,Unicode 用独立码位 U+1F51F。 */
const KEYCAP_TEN = "🔟";

/**
 * 种表情侧的生成器(票03 select 种键帽数字用):1..10 → 键帽 emoji。
 * 越界是编程错误,早暴露(调用方在「选项 ≤ 10」的门槛内调用)。
 */
export function digitKeycap(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 10) {
    throw new RangeError(`keycap digits run 1..10, got ${index}`);
  }
  return index === 10 ? KEYCAP_TEN : keycap(index);
}

/**
 * 原始 reaction key → 语义。精确匹配(reaction key 来自事件 content,
 * 不做 trim/归一化 —— 客户端发什么就是什么);解析同时接受键帽形与裸数字。
 */
export function parseReactionKey(key: string): ReactionKey {
  if (key === REACTION_APPROVE) return { kind: "approve" };
  if (key === REACTION_REJECT) return { kind: "reject" };
  if (/^[1-9]$/.test(key)) return { kind: "digit", index: Number(key) };
  if (key === "10") return { kind: "digit", index: 10 };
  if (key === KEYCAP_TEN) return { kind: "digit", index: 10 };
  // 键帽形,含 VS16 被剥落的变体:`${d}\uFE0F\u20E3` 与 `${d}\u20E3`
  if (/^[1-9]\uFE0F?\u20E3$/.test(key)) return { kind: "digit", index: Number(key[0]) };
  return { kind: "unknown" };
}
