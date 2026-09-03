import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, parseLogLevel, suppressLogLines } from "../src/logger.js";

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
