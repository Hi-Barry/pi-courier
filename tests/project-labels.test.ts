import { describe, expect, it } from "vitest";
import { projectLabelOf, validateProjectLabel } from "../src/project-labels";

describe("validateProjectLabel 判定边界(审计工程批 票21)", () => {
  it("astral 字符按感知字符计数,NFKC 归一后视为同标签", () => {
    // 30 个 emoji = 30 个感知字符(旧实现按 UTF-16 记 60)
    const emoji = "🍵".repeat(30);
    expect(validateProjectLabel(emoji, [])).toBeNull();
    // NFKC:全角 A 与半角 A、组合重音与预合成 é 视为冲突(NFKC 不折 ß/ss)
    expect(validateProjectLabel("Ａpp", ["App"])).toContain("App");
    expect(validateProjectLabel("cafe\u0301", ["caf\u00e9"])).toContain("caf\u00e9");
  });
});

describe("projectLabelOf", () => {
  it("prefers an explicit name", () => {
    expect(projectLabelOf({ name: "ai-api", workdir: "/home/u/Projects/whatever" })).toBe("ai-api");
  });

  it("falls back to the workdir basename when no name", () => {
    expect(projectLabelOf({ workdir: "/home/u/Projects/myapp" })).toBe("myapp");
    expect(projectLabelOf({ name: "   ", workdir: "/srv/tools/www" })).toBe("www");
  });

  it("tolerates odd workdirs (trailing slash, root)", () => {
    expect(projectLabelOf({ workdir: "/home/u/Projects/app/" })).toBe("app");
    expect(projectLabelOf({ workdir: "/" })).toBe("/");
  });
});

describe("validateProjectLabel", () => {
  it("accepts ordinary names", () => {
    expect(validateProjectLabel("ai-api", [])).toBeNull();
    expect(validateProjectLabel("中文项目", [])).toBeNull();
  });

  it("rejects empty/whitespace-only names", () => {
    expect(validateProjectLabel("", [])).toContain("不能为空");
    expect(validateProjectLabel("   ", [])).toContain("不能为空");
  });

  it("rejects brackets and whitespace (they would break the log format)", () => {
    expect(validateProjectLabel("a]b", [])).toContain("方括号");
    expect(validateProjectLabel("a[b", [])).toContain("方括号");
    expect(validateProjectLabel("a b", [])).toContain("空白");
    expect(validateProjectLabel("a\tb", [])).toContain("空白");
  });

  it("rejects names longer than 30 characters", () => {
    expect(validateProjectLabel("x".repeat(30), [])).toBeNull();
    expect(validateProjectLabel("x".repeat(31), [])).toContain("30");
  });

  it("rejects case-insensitive collisions with existing labels", () => {
    expect(validateProjectLabel("myapp", ["MyApp", "other"])).toContain("MyApp");
    expect(validateProjectLabel("free", ["MyApp"])).toBeNull();
  });
});
