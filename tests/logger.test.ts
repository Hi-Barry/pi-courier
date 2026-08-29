import { describe, expect, it } from "vitest";
import { createLogger, parseLogLevel } from "../src/logger.js";

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
