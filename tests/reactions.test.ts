/**
 * 表情语义映射(spec #267 票02,#269)的纯函数直测:✅/❌ 审批键、键帽数字
 * 1️⃣…🔟 与裸数字双形态、未知 key。这是两条确认流共用的唯一映射点——
 * 换表情符号或加新映射只动 reactions.ts 一处,测试以字面量为锚。
 */
import { describe, expect, it } from "vitest";
import {
  REACTION_APPROVE,
  REACTION_REJECT,
  digitKeycap,
  parseReactionKey,
} from "../src/rpc/reactions";

describe("reaction key semantics (spec #267 票02)", () => {
  it("✅ maps to approve and ❌ maps to reject", () => {
    expect(parseReactionKey("✅")).toEqual({ kind: "approve" });
    expect(parseReactionKey("❌")).toEqual({ kind: "reject" });
    expect(REACTION_APPROVE).toBe("✅");
    expect(REACTION_REJECT).toBe("❌");
  });

  it("keycap digits 1️⃣…9️⃣ map to digit 1..9 (digit + VS16 + U+20E3)", () => {
    expect(parseReactionKey("1\uFE0F\u20E3")).toEqual({ kind: "digit", index: 1 });
    expect(parseReactionKey("9\uFE0F\u20E3")).toEqual({ kind: "digit", index: 9 });
    expect(parseReactionKey("5\uFE0F\u20E3")).toEqual({ kind: "digit", index: 5 });
  });

  it("🔟 (U+1F51F) maps to digit 10", () => {
    expect(parseReactionKey("\u{1F51F}")).toEqual({ kind: "digit", index: 10 });
    expect(parseReactionKey("🔟")).toEqual({ kind: "digit", index: 10 });
  });

  it("bare digits are the second accepted form (\"1\"…\"9\", \"10\")", () => {
    expect(parseReactionKey("1")).toEqual({ kind: "digit", index: 1 });
    expect(parseReactionKey("9")).toEqual({ kind: "digit", index: 9 });
    expect(parseReactionKey("10")).toEqual({ kind: "digit", index: 10 });
  });

  it("keycap without VS16 still parses (some clients strip variation selectors)", () => {
    expect(parseReactionKey("1\u20E3")).toEqual({ kind: "digit", index: 1 });
  });

  it("unknown keys return unknown: \"0\", other emoji, whitespace, empty", () => {
    expect(parseReactionKey("0")).toEqual({ kind: "unknown" });
    expect(parseReactionKey("10\uFE0F\u20E3")).toEqual({ kind: "unknown" }); // 键帽 10 不存在(🔟 才是)
    expect(parseReactionKey("👍")).toEqual({ kind: "unknown" });
    expect(parseReactionKey("")).toEqual({ kind: "unknown" });
    expect(parseReactionKey(" ✅")).toEqual({ kind: "unknown" }); // 不 trim:reaction key 是精确匹配
    expect(parseReactionKey("11")).toEqual({ kind: "unknown" });
  });

  it("digitKeycap is the planting-side inverse: 1..10 round-trip", () => {
    for (let i = 1; i <= 10; i += 1) {
      expect(parseReactionKey(digitKeycap(i))).toEqual({ kind: "digit", index: i });
    }
    expect(digitKeycap(1)).toBe("1\uFE0F\u20E3");
    expect(digitKeycap(10)).toBe("🔟");
    expect(() => digitKeycap(0)).toThrow();
    expect(() => digitKeycap(11)).toThrow();
  });
});
