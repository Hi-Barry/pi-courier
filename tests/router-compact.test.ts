/**
 * /compact 两段式命令层(spec #218 票 #219):立即「压缩中」回执 + 结果
 * 按 CompactOutcome 三态出文案;Already compacted 人话化。PiRpc 双源等待
 * 的时序细节在 pi-rpc-compact.test.ts,这里只测命令层的外部行为 —— 回复
 * 什么文案、顺序如何。
 */
import { describe, expect, it, vi } from "vitest";
import { makeMsg, makeRouterFixture } from "./helpers";

async function sendCompact(text = "/compact") {
  const fx = makeRouterFixture();
  await fx.router.handleIncoming(makeMsg({ text }));
  return fx;
}

describe("/compact 两段式(票 #219)", () => {
  it("完整结果:先「压缩中」回执,后结果卡(tokens + 摘要)", async () => {
    const fx = await sendCompact();
    expect(fx.sendReply).toHaveBeenCalledTimes(2);
    expect(fx.sendReply.mock.calls[0]?.[2]).toContain("压缩中");
    const final = fx.sendReply.mock.calls[1]?.[2] as string;
    expect(final).toContain("已压缩");
    expect(final).toContain("1234");
    expect(final).toContain("压缩摘要");
  });

  it("result 缺失(旧版对端降级):简版成功文案", async () => {
    const fx = makeRouterFixture();
    (fx.rpc.compact as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", result: undefined });
    await fx.router.handleIncoming(makeMsg({ text: "/compact" }));
    expect(fx.sendReply).toHaveBeenCalledTimes(2);
    expect(fx.sendReply.mock.calls[1]?.[2]).toBe("✅ 已压缩");
  });

  it("Already compacted → 人话提示,不再是 ❌ 报错", async () => {
    const fx = makeRouterFixture();
    (fx.rpc.compact as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "failed",
      message: "Compaction failed: Already compacted",
    });
    await fx.router.handleIncoming(makeMsg({ text: "/compact" }));
    const final = fx.sendReply.mock.calls[1]?.[2] as string;
    expect(final).toContain("刚压缩过");
    expect(final).not.toContain("❌");
  });

  it("真实失败:剥掉 Compaction failed: 前缀后按通用错误透传", async () => {
    const fx = makeRouterFixture();
    (fx.rpc.compact as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "failed",
      message: "Compaction failed: model exploded",
    });
    await fx.router.handleIncoming(makeMsg({ text: "/compact" }));
    const final = fx.sendReply.mock.calls[1]?.[2] as string;
    expect(final).toContain("model exploded");
    expect(final).not.toContain("Compaction failed:");
  });

  it("中断(重启/兜底超时):中断提示文案", async () => {
    const fx = makeRouterFixture();
    (fx.rpc.compact as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "interrupted", reason: "restarted" });
    await fx.router.handleIncoming(makeMsg({ text: "/compact" }));
    expect(fx.sendReply.mock.calls[1]?.[2]).toContain("压缩中断");
  });

  it("customInstructions 透传:/compact 精简一点", async () => {
    const fx = await sendCompact("/compact 精简一点");
    expect(fx.rpc.compact).toHaveBeenCalledWith("精简一点");
  });
});
