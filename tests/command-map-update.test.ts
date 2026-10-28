import { describe, expect, it, vi } from "vitest";
import { handleSlashCommand, type SlashCommandContext } from "../src/rpc/command-map.js";
import type { PiRpc } from "../src/rpc/pi-rpc.js";

/**
 * /update 命令层接线验收(桥自更新 spec §4/§5.3/§11.7):case "/update" 是
 * 编排器 handleCommand 的薄委托 —— 未装配回 unavailable 不落回 pi、装配后
 * 按本消息预绑定 IO(adminRoom/allRpcs/audit)透传。状态机分支在
 * tests/update-orchestrator.test.ts,router 侧 adminRoom 映射归 router 级测试。
 */

const fakeRpc = {
  // 命令层不触碰 rpc 方法;若有任何路径落回 pi(默认分支 prompt),这里的
  // 缺失方法会当场炸出 generic catch —— 比静默通过更显眼。
  prompt: vi.fn(),
} as unknown as PiRpc;

function makeCtx(overrides: Partial<SlashCommandContext> = {}) {
  const replies: string[] = [];
  const audits: Array<{ event: string; detail?: string }> = [];
  const ctx: SlashCommandContext = {
    rpc: fakeRpc,
    reply: async (text) => {
      replies.push(text);
    },
    allRpcs: () => [],
    audit: (event, detail) => {
      audits.push({ event, detail });
    },
    ...overrides,
  };
  return { ctx, replies, audits };
}

describe("case /update · 命令层接线(§4/§11.7)", () => {
  it("未装配 → unavailable 回执 + handled=true,不落回 pi(§11.7 防线)", async () => {
    const { ctx, replies } = makeCtx(); // 无 updater 插槽
    const handled = await handleSlashCommand("/update", ctx);
    expect(handled).toBe(true);
    expect(replies).toEqual(["ℹ️ /update 未装配(当前部署不支持)。"]);
    expect(vi.mocked(fakeRpc.prompt)).not.toHaveBeenCalled(); // 落回即把命令文本喂给模型
  });

  it("装配 → 委托 updater.handle,args 原样、IO 按本消息预绑定", async () => {
    const handle = vi.fn().mockResolvedValue(true);
    const { ctx, audits } = makeCtx({ updater: { handle }, adminRoom: true });
    const handled = await handleSlashCommand("/update force", ctx);
    expect(handled).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
    const [args, io] = handle.mock.calls[0]!;
    expect(args).toBe("force");
    expect(io.adminRoom).toBe(true);
    expect(io.reply).toBe(ctx.reply); // 同一缝:异步回执发往发起房间(§11.9)
    expect(io.audit).toBe(ctx.audit);
    expect(io.allRpcs()).toEqual([]); // ctx.allRpcs 透传
    expect(audits).toEqual([]); // 命令层自身不落审计:发起审计由 registry 位在 router 缝落账
  });

  it("adminRoom 缺省 → false(非管理房语义,由编排器守卫拒绝)", async () => {
    const handle = vi.fn().mockResolvedValue(true);
    const { ctx } = makeCtx({ updater: { handle } }); // 未给 adminRoom
    await handleSlashCommand("/update", ctx);
    expect(handle.mock.calls[0]![1].adminRoom).toBe(false);
  });

  it("allRpcs 缺席 → fallback 只含默认 rpc(单实例退化)", async () => {
    const handle = vi.fn().mockResolvedValue(true);
    const ctx: SlashCommandContext = {
      rpc: fakeRpc,
      reply: async () => {},
      updater: { handle },
    };
    await handleSlashCommand("/update check", ctx);
    const rpcs = handle.mock.calls[0]![1].allRpcs();
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toBe(fakeRpc);
  });

  it("命令名大小写不敏感:/Update 与 /UPDATE 同样进 case(分发键统一小写)", async () => {
    for (const text of ["/Update force", "/UPDATE"]) {
      const handle = vi.fn().mockResolvedValue(true);
      const { ctx } = makeCtx({ updater: { handle }, adminRoom: true });
      await handleSlashCommand(text, ctx);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle.mock.calls[0]![0]).toBe(text.slice("/update".length).trim() || "");
    }
  });

  it("handle 上抛(占位释放契约的异常路径)→ generic catch 接手回执,不静默吞掉", async () => {
    const handle = vi.fn().mockRejectedValue(new Error("probe exploded"));
    const { ctx, replies } = makeCtx({ updater: { handle }, adminRoom: true });
    const handled = await handleSlashCommand("/update", ctx);
    expect(handled).toBe(true);
    expect(replies).toEqual(["❌ 命令执行失败: probe exploded"]);
    expect(vi.mocked(fakeRpc.prompt)).not.toHaveBeenCalled();
  });
});
