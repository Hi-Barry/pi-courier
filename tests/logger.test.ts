import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, parseLogLevel, suppressLogLines } from "../src/logger.js";
import { captureConsole } from "./helpers";

describe("logger levels", () => {
  it("parses level strings", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("INFO")).toBe("info");
    expect(parseLogLevel("warning")).toBe("warn");
    expect(parseLogLevel("err")).toBe("error");
    expect(parseLogLevel("verbose")).toBeUndefined();
    expect(parseLogLevel("")).toBeUndefined();
  });

  it("enables levels at or above the threshold", () => {
    const log = createLogger("info");
    expect(log.isEnabled("info")).toBe(true);
    expect(log.isEnabled("warn")).toBe(true);
    expect(log.isEnabled("error")).toBe(true);
    expect(log.isEnabled("debug")).toBe(false);

    log.setLogLevel("debug");
    expect(log.isEnabled("debug")).toBe(true);

    log.setLogLevel("warn");
    expect(log.isEnabled("info")).toBe(false);
    expect(log.isEnabled("warn")).toBe(true);
  });

  it("instances do not share threshold state", () => {
    const a = createLogger("info");
    const b = createLogger("info");
    a.setLogLevel("debug");
    expect(b.getLogLevel()).toBe("info");
    expect(b.isEnabled("debug")).toBe(false);
  });
});

describe("project labels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders `[ts] [LEVEL] [label] message` through a tagged view", () => {
    const lines = captureConsole();
    const log = createLogger("info");
    log.withLabel("ai-api").info("hello");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] \[ai-api\] hello$/);
  });

  it("keeps untagged output byte-identical to the level-only format", () => {
    const lines = captureConsole();
    createLogger("info").info("plain");
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] plain$/);
    createLogger("info").withLabel("   ").info("blank label = untagged");
    expect(lines[1]).toMatch(/\[INFO\] blank label = untagged$/);
    expect(lines[1]).not.toMatch(/\[ \]/);
  });

  it("derives one label at a time — re-deriving replaces it", () => {
    const lines = captureConsole();
    const log = createLogger("info");
    log.withLabel("a").withLabel("b").info("x");
    expect(lines[0]).toContain("[INFO] [b] x");
    expect(lines[0]).not.toContain("[a]");
  });

  it("reads the parent's live threshold and level changes", () => {
    const lines = captureConsole();
    const log = createLogger("info");
    const view = log.withLabel("ai-api");
    view.debug("hidden");
    expect(lines).toHaveLength(0);
    log.setLogLevel("debug");
    view.debug("shown now");
    expect(lines[0]).toContain("[DEBUG] [ai-api] shown now");
  });
});

describe("single-line rendering (newline sanitisation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flattens newlines in string args to ⏎ so one call is one physical line", () => {
    const lines = captureConsole();
    createLogger("info").info("line1\nline2\r\nline3");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("line1⏎line2⏎line3");
    expect(lines[0]).not.toContain("\n");
  });

  it("keeps serialized objects single-line (JSON escaping, no raw newlines)", () => {
    const lines = captureConsole();
    createLogger("info").info({ msg: "a\nb" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/\n/);
  });

  it("leaves single-line messages untouched", () => {
    const lines = captureConsole();
    createLogger("info").info("no newlines here");
    expect(lines[0]).toContain("no newlines here");
    expect(lines[0].split("⏎")).toHaveLength(1);
  });
});

describe("suppressLogLines (sync-noise window)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops matching lines at every level while the window is open", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("debug");
    const close = suppressLogLines("Decryption error", "M_NOT_FOUND");

    log.error("sync replay: Decryption error for !room:x");
    log.warn("M_NOT_FOUND on /event/xyz");
    log.info("Decryption error (replayed history)");
    log.debug("Decryption error detail");

    expect(err).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();

    close();
    log.error("Decryption error now visible");
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toContain("Decryption error now visible");
  });

  it("keeps non-matching lines visible while the window is open", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const close = suppressLogLines("Decryption error", "M_NOT_FOUND");
    const log = createLogger("info");

    log.error("real failure: M_UNKNOWN");

    expect(err).toHaveBeenCalledTimes(1);
    close();
  });

  it("matches before the 2000-char truncation — long noise lines cannot escape", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const close = suppressLogLines("Decryption error");
    const log = createLogger("info");
    const filler = "x".repeat(2500);

    log.error(`${filler} Decryption error at the tail`);
    expect(err).not.toHaveBeenCalled();

    close();
  });
});
