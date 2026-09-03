/**
 * Shared test helpers — deliberately not *.test.ts so vitest ignores it.
 */
import { vi } from "vitest";

/** Capture every console line (log + error) into one ordered buffer. */
export function captureConsole(): string[] {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return lines;
}
