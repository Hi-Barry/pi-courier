import { describe, expect, it } from "vitest";
import { buildLogFilterArgs } from "../src/log-filter";

const labels = ["ai-api", "www", "MyApp"];
const req = (over: Partial<Parameters<typeof buildLogFilterArgs>[0]> = {}) => ({
  availableLabels: labels,
  requestedProjects: [] as string[],
  level: "info" as const,
  follow: true,
  ...over,
});

describe("buildLogFilterArgs — level (existing-behavior repair, spec #34)", () => {
  it("default info filters by anchored level lines (replaces the dead -p flag)", () => {
    const r = buildLogFilterArgs(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args).toEqual([
      "--user", "-u", "pi-courier", "-f",
      "--grep", "\\[(INFO|WARN|ERROR)\\] ", "--case=0",
    ]);
    expect(r.args).not.toContain("-p");
  });

  it("debug emits no grep at all (every level passes, matching the old intent)", () => {
    const r = buildLogFilterArgs(req({ level: "debug" }));
    if (!r.ok) throw new Error("unexpected");
    expect(r.args).not.toContain("--grep");
  });

  it("warn/error narrow the level alternation", () => {
    const w = buildLogFilterArgs(req({ level: "warn" }));
    if (!w.ok) throw new Error("unexpected");
    expect(w.args).toContain("\\[(WARN|ERROR)\\] ");
    const e = buildLogFilterArgs(req({ level: "error" }));
    if (!e.ok) throw new Error("unexpected");
    expect(e.args).toContain("\\[(ERROR)\\] ");
  });

  it("follow=false drops -f (status window), lineCount adds -n", () => {
    const r = buildLogFilterArgs(req({ follow: false, lineCount: 15 }));
    if (!r.ok) throw new Error("unexpected");
    expect(r.args).not.toContain("-f");
    expect(r.args).toContain("-n");
    expect(r.args).toContain("15");
  });

  it("rejects an unknown level (typo must not silently widen the view)", () => {
    const r = buildLogFilterArgs({ ...req(), level: "verbose" as never });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("verbose");
  });
});

describe("buildLogFilterArgs — project selection", () => {
  it("single project: level AND label in one anchored pattern", () => {
    const r = buildLogFilterArgs(req({ requestedProjects: ["ai-api"] }));
    if (!r.ok) throw new Error("unexpected");
    expect(r.args).toContain("\\[(INFO|WARN|ERROR)\\] \\[(ai-api)\\]");
  });

  it("multiple projects OR together", () => {
    const r = buildLogFilterArgs(req({ requestedProjects: ["ai-api", "www"] }));
    if (!r.ok) throw new Error("unexpected");
    expect(r.args).toContain("\\[(INFO|WARN|ERROR)\\] \\[(ai-api|www)\\]");
  });

  it("matching is case-insensitive via --case=0, not by lowercasing labels", () => {
    const r = buildLogFilterArgs(req({ requestedProjects: ["myapp"] }));
    if (!r.ok) throw new Error("unexpected");
    expect(r.args).toContain("--case=0");
    // The pattern carries the user's spelling (folded by --case 0), not the
    // stored "MyApp" — the user must not need exact case to filter.
    expect(r.args.join(" ")).toContain("(myapp)");
    expect(r.args.join(" ")).not.toContain("MyApp");
  });

  it("regex metacharacters in a label are escaped, not interpreted", () => {
    const r = buildLogFilterArgs(req({ availableLabels: ["a.b+c"], requestedProjects: ["a.b+c"] }));
    if (!r.ok) throw new Error("unexpected");
    expect(r.args).toContain("\\[(INFO|WARN|ERROR)\\] \\[(a\\.b\\+c)\\]");
  });

  it("unknown project errors with the available list", () => {
    const r = buildLogFilterArgs(req({ requestedProjects: ["nope"] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("nope");
    expect(r.message).toContain("ai-api");
    expect(r.message).toContain("www");
  });

  it("error lists EVERY unknown project (one round-trip suffices)", () => {
    const r = buildLogFilterArgs(req({ requestedProjects: ["nope", "nah"] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("nope");
    expect(r.message).toContain("nah");
  });

  it("no projects configured → the error says so instead of listing nothing", () => {
    const r = buildLogFilterArgs(req({ availableLabels: [], requestedProjects: ["x"] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("无项目");
  });
});
