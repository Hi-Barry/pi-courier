import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { appendStatusFooter, collectStatusFooter, formatContextWindow } from "../src/rpc/status-footer";

/**
 * 回复末尾状态脚注(status-footer):窗口刻度三档、拼接形状(空行+---+三段
 * ' · ' 行)、出站渲染(<hr> 而非 setext <h2>)与取数容错(逐段降级为 '?')
 * 逐项直测。mock rpc 全部 duck-type —— collectStatusFooter 对缺方法的
 * TypeError 必须吞掉,这也是它"永不抛"契约的一部分。
 */

describe("formatContextWindow", () => {
  it("renders millions with one decimal", () => {
    expect(formatContextWindow(1_000_000)).toBe("1.0M");
  });

  it("renders thousands as an integer k", () => {
    expect(formatContextWindow(200_000)).toBe("200k");
  });

  it("passes sub-k windows through unchanged", () => {
    expect(formatContextWindow(999)).toBe("999");
  });
});

describe("appendStatusFooter", () => {
  it("joins body, --- divider and a three-segment footer line", () => {
    const out = appendStatusFooter("done", { cwd: "/w", context: "12.3%/1.0M", model: "GLM-5.3·high" });
    const [body, footer] = out.split("\n\n---\n\n");
    expect(body).toBe("done");
    expect(footer.split(" · ")).toEqual(["📂 /w", "📜 12.3%/1.0M", "🤖 GLM-5.3·high"]);
  });

  it("shows ? for missing segments, separators unchanged", () => {
    expect(appendStatusFooter("done", { cwd: null, context: null, model: null })).toBe(
      "done\n\n---\n\n📂 ? · 📜 ? · 🤖 ?"
    );
  });

  it("renders as <hr>, never a setext <h2>, through the outbound MarkdownIt", () => {
    const md = new MarkdownIt({ html: false, breaks: true });
    const html = md.render(appendStatusFooter("done", { cwd: "/w", context: "1.0M", model: "m" }));
    expect(html).toContain("<hr>");
    expect(html).not.toContain("<h2>");
  });

  it("closes an unclosed code fence before the divider so the footer renders outside it", () => {
    const out = appendStatusFooter("看这段:\n```bash\nls -la", { cwd: "/w", context: "1.0M", model: "m" });
    expect(out).toBe("看这段:\n```bash\nls -la\n```\n\n---\n\n📂 /w · 📜 1.0M · 🤖 m");
    const md = new MarkdownIt({ html: false, breaks: true });
    const html = md.render(out);
    expect(html).toContain("<hr>");
    expect(html).toContain("📂 /w");
  });

  it("closes a tilde fence with its own marker (chars must match to close)", () => {
    expect(appendStatusFooter("x\n~~~\ncode", { cwd: "/w", context: "1.0M", model: "m" })).toBe(
      "x\n~~~\ncode\n~~~\n\n---\n\n📂 /w · 📜 1.0M · 🤖 m"
    );
  });

  it("leaves balanced fences untouched", () => {
    const out = appendStatusFooter("a\n```js\ncode\n```\ndone", { cwd: "/w", context: "1.0M", model: "m" });
    expect(out.startsWith("a\n```js\ncode\n```\ndone\n\n---\n\n📂 /w")).toBe(true);
  });
});

describe("collectStatusFooter", () => {
  it("collects cwd, context and model segments (happy path)", async () => {
    const rpc = {
      cwd: "/tmp/w",
      requireClient: () => ({
        getState: () => Promise.resolve({ model: { name: "GLM", id: "x" }, thinkingLevel: "high" }),
        getSessionStats: () =>
          Promise.resolve({ contextUsage: { tokens: 123_000, contextWindow: 1_000_000, percent: 12.3 } }),
      }),
    } as unknown as PiRpc;
    await expect(collectStatusFooter(rpc)).resolves.toEqual({
      cwd: "/tmp/w",
      context: "12.3%/1.0M",
      model: "GLM·high",
    });
  });

  it("a getState failure degrades only the model segment", async () => {
    const rpc = {
      cwd: "/tmp/w",
      requireClient: () => ({
        getState: () => Promise.reject(new Error("boom")),
        getSessionStats: () =>
          Promise.resolve({ contextUsage: { tokens: 1, contextWindow: 200_000, percent: 0.5 } }),
      }),
    } as unknown as PiRpc;
    await expect(collectStatusFooter(rpc)).resolves.toEqual({ cwd: "/tmp/w", context: "0.5%/200k", model: null });
  });

  it("missing contextUsage degrades only the context segment (thinking shown when present)", async () => {
    const rpc = {
      cwd: "/tmp/w",
      requireClient: () => ({
        getState: () => Promise.resolve({ model: { id: "m" }, thinkingLevel: "high" }),
        getSessionStats: () => Promise.resolve({}),
      }),
    } as unknown as PiRpc;
    await expect(collectStatusFooter(rpc)).resolves.toEqual({ cwd: "/tmp/w", context: null, model: "m·high" });
  });

  it("percent=null (manual compaction) still shows the window", async () => {
    const rpc = {
      requireClient: () => ({
        getState: () => Promise.resolve({ model: { id: "m" } }),
        getSessionStats: () =>
          Promise.resolve({ contextUsage: { tokens: null, contextWindow: 1_000_000, percent: null } }),
      }),
    } as unknown as PiRpc;
    await expect(collectStatusFooter(rpc)).resolves.toEqual({ cwd: null, context: "?/1.0M", model: "m" });
  });

  it("a rpc without requireClient yields all-null segments and never throws", async () => {
    const rpc = {} as unknown as PiRpc;
    await expect(collectStatusFooter(rpc)).resolves.toEqual({ cwd: null, context: null, model: null });
  });
});
