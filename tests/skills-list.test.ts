import { describe, expect, it } from "vitest";
import {
  formatSkillLine,
  formatSkillsList,
  type SkillCommandView,
} from "../src/rpc/command-map.js";

/** 造一条上游 RpcSlashCommand 形状的技能条目(name 自带 skill: 前缀)。 */
function skill(
  name: string,
  options: { description?: string; scope?: string } = {}
): SkillCommandView {
  return {
    name: `skill:${name}`,
    description: options.description,
    source: "skill",
    sourceInfo: { scope: options.scope },
  };
}

describe("formatSkillLine(单行格式)", () => {
  it("行首是斜杠 + name,不把 skill: 前缀拼两次", () => {
    expect(formatSkillLine(skill("ask-matt"))).toBe("/skill:ask-matt");
  });

  it("有描述时以 — 连接单行描述", () => {
    expect(formatSkillLine(skill("tdd", { description: "test driven development" }))).toBe(
      "/skill:tdd — test driven development"
    );
  });

  it("描述过长时截为 60 字符 + 省略号", () => {
    const long = "a".repeat(200);
    const line = formatSkillLine(skill("big", { description: long }));
    const rendered = line.slice("/skill:big — ".length);
    expect(line.startsWith("/skill:big — ")).toBe(true);
    expect(rendered.endsWith("…")).toBe(true);
    expect(rendered.length).toBe(61);
  });

  it("描述含换行时折叠为单行", () => {
    expect(formatSkillLine(skill("multi", { description: "one\ntwo" }))).toBe(
      "/skill:multi — one two"
    );
  });

  it("缺描述(含空串)只显名字,不带空描述段", () => {
    expect(formatSkillLine(skill("bare"))).toBe("/skill:bare");
    expect(formatSkillLine(skill("empty", { description: "" }))).toBe("/skill:empty");
    expect(formatSkillLine(skill("bare"))).not.toContain("—");
  });
});

describe("formatSkillsList(分组列表)", () => {
  it("按 用户级 → 项目级 → 其他 顺序分组,未知 scope 与上游 temporary 都落「其他」", () => {
    const text = formatSkillsList([
      skill("proj-skill", { scope: "project", description: "项目级技能" }),
      skill("user-skill", { scope: "user", description: "用户级技能" }),
      skill("temp-skill", { scope: "temporary", description: "上游 temporary" }),
      skill("weird-skill", { scope: "whatever", description: "未知枚举" }),
    ]);
    const userAt = text.indexOf("用户级:");
    const projectAt = text.indexOf("项目级:");
    const otherAt = text.indexOf("其他:");
    expect(userAt).toBeGreaterThanOrEqual(0);
    expect(projectAt).toBeGreaterThan(userAt);
    expect(otherAt).toBeGreaterThan(projectAt);
    expect(text).toContain("/skill:temp-skill — 上游 temporary");
    expect(text).toContain("/skill:weird-skill — 未知枚举");
  });

  it("缺 sourceInfo 的条目也落「其他」组(防御,不崩)", () => {
    const text = formatSkillsList([{ name: "skill:no-scope", source: "skill" }]);
    expect(text).toContain("其他:");
    expect(text).toContain("/skill:no-scope");
  });

  it("组内按技能名字母序", () => {
    const text = formatSkillsList([
      skill("zebra", { description: "z" }),
      skill("alpha", { description: "a" }),
      skill("mango", { description: "m" }),
    ]);
    const alphaAt = text.indexOf("/skill:alpha");
    const mangoAt = text.indexOf("/skill:mango");
    const zebraAt = text.indexOf("/skill:zebra");
    expect(alphaAt).toBeGreaterThanOrEqual(0);
    expect(mangoAt).toBeGreaterThan(alphaAt);
    expect(zebraAt).toBeGreaterThan(mangoAt);
  });

  it("只列技能:扩展命令与提示词模板条目被滤除", () => {
    const text = formatSkillsList([
      { name: "myext", description: "扩展命令", source: "extension", sourceInfo: { scope: "project" } },
      { name: "mytpl", description: "提示词模板", source: "prompt", sourceInfo: { scope: "project" } },
      skill("real-skill", { description: "真技能" }),
    ]);
    expect(text).toContain("/skill:real-skill — 真技能");
    expect(text).not.toContain("myext");
    expect(text).not.toContain("mytpl");
  });

  it("全量列出,不设条数上限", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      skill(`s${String(i).padStart(2, "0")}`, { description: `d${i}` })
    );
    const text = formatSkillsList(many);
    expect(text.startsWith("📚 已安装技能:")).toBe(true);
    for (const { name } of many) expect(text).toContain(`/${name}`);
  });

  it("空列表回复安装指路(用户级与项目级目录)", () => {
    const text = formatSkillsList([]);
    expect(text).toContain("~/.agents/skills/");
    expect(text).toContain("~/.pi/agent/skills/");
    expect(text).toContain("<工作目录>/.agents/skills/");
    expect(text).toContain("<工作目录>/.pi/skills/");
  });
});
