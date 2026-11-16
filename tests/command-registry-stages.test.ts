/**
 * 命令登记表 ↔ 管线归属契约测试(#358,评审卡5 第一步):
 *  - registry 的 stage 标注必须是真实管线里的阶段名(防标注漂移);
 *  - 六个 preAuth 命令族阶段在表中都有条目覆盖(族接管的锚点存在);
 *  - slashCommands 域条目与 command-map 的 case 域对齐(抽查)。
 * 表是唯一声明点:加命令先登记(stage 在此声明),本测试保证声明不落空。
 */
import { describe, expect, it } from "vitest";
import { COMMAND_REGISTRY, type CommandPipelineStage } from "../src/command-registry.js";
import { makeRouterFixture, makeFakeRpc } from "./helpers.js";

/** 真实管线阶段名(经 fixture 取 router.pipeline() 视图)。 */
const pipelineStages = (() => {
  const fx = makeRouterFixture({ rpc: makeFakeRpc() });
  return new Set(fx.router.pipeline().map((s) => s.name));
})();

describe("COMMAND_REGISTRY · stage 管线归属(#358)", () => {
  it("每个 stage 标注都是真实管线里的阶段名", () => {
    for (const entry of COMMAND_REGISTRY) {
      if (entry.stage !== undefined) {
        expect(pipelineStages, `${entry.name} → "${entry.stage}" 不在管线中`).toContain(entry.stage);
      }
    }
  });

  it("六个 preAuth 命令族阶段在表中都有条目覆盖(族接管的锚点)", () => {
    const stages = new Set(COMMAND_REGISTRY.map((e) => e.stage));
    for (const stage of ["pmctl", "login", "adminCommands", "groupEnable", "roomToolsToggle", "multiproject"] as const satisfies readonly CommandPipelineStage[]) {
      expect(stages.has(stage), `阶段 "${stage}" 在登记表中无条目`).toBe(true);
    }
  });

  it("slashCommands 域条目与 command-map 的 case 域对齐(抽查)", () => {
    // 抽查五条会话命令:它们的执行路径在 command-map 的 case(经 slashCommands
    // 阶段),不在任何 preAuth 族——标注漂移即测试红。
    const slashTagged = (name: string): boolean =>
      COMMAND_REGISTRY.find((e) => e.name === name)?.stage === "slashCommands";
    for (const cmd of ["/bash", "/update", "/mcp", "/model", "/reload"]) {
      expect(slashTagged(cmd), `${cmd} 应标注 slashCommands`).toBe(true);
    }
    // 反向抽查:管理面命令不得标成 slashCommands
    const adminTagged = (name: string): boolean =>
      COMMAND_REGISTRY.find((e) => e.name === name)?.stage === "adminCommands";
    for (const cmd of ["/trusted", "/revoke", "/disable"]) {
      expect(adminTagged(cmd), `${cmd} 应标注 adminCommands`).toBe(true);
    }
  });

  it("每条登记条目都带 stage 标注(表是唯一声明点,不留未归属条目)", () => {
    const untagged = COMMAND_REGISTRY.filter((e) => e.stage === undefined).map((e) => e.name);
    expect(untagged).toEqual([]);
  });
});
