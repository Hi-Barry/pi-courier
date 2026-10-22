import { describe, expect, it } from "vitest";
import { buildProjectWelcome } from "../src/project-welcome";

/** Pure copy-assembly tests for the project-welcome card (spec #208 票2).
 *  The version/model degradation matrix is the interesting logic; the wiring
 *  (who calls the builder with what) lives in tests/pmctl-controller.test.ts. */
describe("buildProjectWelcome", () => {
  const full = {
    projectName: "myapp",
    piVersion: "1.0.0",
    courierVersion: "1.1.0",
    model: "opencode-go/deepseek-v4.1-flash",
  };

  it("greets, states the dual-version identity and the real model, points at /help", () => {
    const text = buildProjectWelcome(full);
    expect(text).toContain("myapp 已上线");
    // 批准稿逐字:zh 排版里 · 紧贴全角括号(复审回炉钉死,不许代码写死分隔符)
    expect(text).toContain("pi coding agent（v1.0.0）· pi-courier（v1.1.0）");
    expect(text).toContain("`opencode-go/deepseek-v4.1-flash`");
    expect(text).toContain("/help");
  });

  it("omits the model line when the model is unknown", () => {
    const text = buildProjectWelcome({ ...full, model: undefined });
    expect(text).not.toContain("当前模型");
    expect(text).toContain("pi coding agent（v1.0.0）");
  });

  it("omits version segments that are unavailable", () => {
    const modelOnly = buildProjectWelcome({ projectName: "x", model: "p/m" });
    expect(modelOnly).not.toContain("pi coding agent（v");
    expect(modelOnly).toContain("`p/m`");

    const bare = buildProjectWelcome({ projectName: "x" });
    expect(bare).not.toContain("当前模型");
    expect(bare).not.toContain("pi coding agent（v");
  });

  it("缺谁省谁:pi 版本单缺,只省 pi 的版本段,courier 版本与名字都保留(票 #210 评审回炉)", () => {
    const text = buildProjectWelcome({ projectName: "x", courierVersion: "1.1.0", model: "p/m" });
    expect(text).toContain("pi-courier（v1.1.0）");
    // pi 的版本号丢了,但"底层是 pi coding agent"这个名字段必须还在
    expect(text).toContain("pi coding agent ·");
    expect(text).not.toContain("pi coding agent（v");
    // 不渲染空括号、不悬空分隔符
    expect(text).not.toContain("（v）");
    expect(text).not.toContain("· ·");
    expect(text).toContain("`p/m`");
  });

  it("缺谁省谁:courier 版本单缺,只省 courier 的版本段,pi 版本保留(票 #210 评审回炉)", () => {
    const text = buildProjectWelcome({ projectName: "x", piVersion: "1.0.0", model: "p/m" });
    expect(text).toContain("pi coding agent（v1.0.0）");
    expect(text).toContain("· pi-courier");
    expect(text).not.toContain("pi-courier（v");
    expect(text).not.toContain("（v）");
    expect(text).not.toContain("· ·");
    expect(text).toContain("`p/m`");
  });

  it("lists the high-frequency capabilities with real usage", () => {
    const text = buildProjectWelcome(full);
    // 命令示例与真实行为一致:`!` 后须空格;/remind 真实时间写法。
    expect(text).toContain("`! ls`");
    expect(text).toContain("`!! ls`");
    expect(text).toContain("/remind 30m");
    expect(text).toContain("/stop");
    expect(text).toContain("/recap");
    expect(text).toContain("试一试");
  });
});
