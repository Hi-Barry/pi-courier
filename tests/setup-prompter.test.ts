/**
 * createPrompter piped-mode contract (audit critical fix, stability batch
 * 票14): `ask` must wait for EOF before consuming — the old "resolve on
 * first data" raced the `end` handler and answered the FIRST question with
 * an empty string. Driven against a fake stdin, fully deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("createPrompter piped mode (audit stability batch 票14)", () => {
  let handlers: Record<string, Array<(arg?: unknown) => void>>;
  let stdoutWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    handlers = {};
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fakeStdin = {
      isTTY: false,
      setEncoding: vi.fn(),
      on: (ev: string, fn: (arg?: unknown) => void) => {
        (handlers[ev] ??= []).push(fn);
      },
      once: (ev: string, fn: (arg?: unknown) => void) => {
        (handlers[ev] ??= []).push(fn);
      },
      removeAllListeners: vi.fn(),
    };
    vi.doMock("node:process", () => ({
      stdin: fakeStdin,
      stdout: process.stdout,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function importPrompter() {
    const { createPrompter } = await import("../src/setup");
    return createPrompter();
  }

  const settle = <T>(p: Promise<T>, ms = 25): Promise<"resolved" | "pending"> =>
    Promise.race([p.then(() => "resolved" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);

  it("first ask waits for EOF and returns the first line (not an empty answer)", async () => {
    const p = await importPrompter();
    const first = p.ask("lang> ");
    expect(await settle(first)).toBe("pending"); // data hasn't arrived yet

    handlers.data!.forEach((f) => f("中文\nen\n"));
    // Old code resolved HERE — partial data, `lines` still empty → "".
    expect(await settle(first)).toBe("pending");

    handlers.end!.forEach((f) => f());
    expect(await first).toBe("中文");
    expect(await p.ask("hs> ")).toBe("en"); // second ask consumes in order, no wait
  });

  it("multi-chunk buffering assembles before EOF, then consumes line by line", async () => {
    const p = await importPrompter();
    const first = p.ask("q1> ");
    handlers.data!.forEach((f) => f("ab"));
    handlers.data!.forEach((f) => f("c\nline2\n"));
    handlers.end!.forEach((f) => f());
    expect(await first).toBe("abc");
    expect(await p.ask("q2> ")).toBe("line2");
    expect(await p.ask("q3> ")).toBe("");
  });

  it("answers are trimmed and prompts are written to stdout", async () => {
    const p = await importPrompter();
    const first = p.ask("name> ");
    handlers.data!.forEach((f) => f("  spaced  \n"));
    handlers.end!.forEach((f) => f());
    expect(await first).toBe("spaced");
    expect(stdoutWrite).toHaveBeenCalledWith("name> ");
    p.close();
    expect(handlers.data).toBeDefined(); // listeners were registered then removed
  });
});
