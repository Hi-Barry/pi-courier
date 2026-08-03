import { describe, expect, it } from "vitest";
import { isEnabled, parseLogLevel, setLogLevel } from "../src/logger.js";

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
    setLogLevel("info");
    expect(isEnabled("info")).toBe(true);
    expect(isEnabled("warn")).toBe(true);
    expect(isEnabled("error")).toBe(true);
    expect(isEnabled("debug")).toBe(false);

    setLogLevel("debug");
    expect(isEnabled("debug")).toBe(true);

    setLogLevel("warn");
    expect(isEnabled("info")).toBe(false);
    expect(isEnabled("warn")).toBe(true);

    setLogLevel("info"); // reset for other tests
  });
});
