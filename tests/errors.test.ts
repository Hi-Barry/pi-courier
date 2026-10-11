import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/errors";

describe("errorMessage (audit engineering batch 票24)", () => {
  it("Error → message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("string rejection passes through", () => {
    expect(errorMessage("plain failure")).toBe("plain failure");
  });

  it("null/undefined render a readable placeholder", () => {
    expect(errorMessage(undefined)).toBe("(no error value)");
    expect(errorMessage(null)).toBe("(no error value)");
  });

  it("other primitives stringify", () => {
    expect(errorMessage(42)).toBe("42");
  });
});
