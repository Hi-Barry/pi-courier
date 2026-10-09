/**
 * JsonStateFile (issue #114): the durable-state primitive shared by the
 * attachment ledger (#114) and the reminder store (#117). Contract under
 * test: disk is a backup that never throws and never corrupts the previous
 * state — missing/corrupt → fallback, write failure → warn, atomic tmp+rename,
 * 0600/0700 permissions, missing directories auto-created.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStateFile } from "../src/state/json-file";
import { logger } from "../src/logger";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-courier-jsonfile-"));
}

describe("JsonStateFile (issue #114)", () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const fresh = () => {
    dir = tmpDir();
    return join(dir, "state.json");
  };

  it("save then load round-trips the value", () => {
    dir = tmpDir();
    const file = join(dir, "state.json");
    const state = new JsonStateFile<Array<{ id: string }>>(file, []);
    state.save([{ id: "a" }, { id: "b" }]);
    expect(new JsonStateFile<Array<{ id: string }>>(file, []).load()).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("missing file quietly returns the fallback (first run)", () => {
    dir = tmpDir();
    const file = join(dir, "state.json");
    const fallback = { hello: "world" };
    expect(new JsonStateFile<typeof fallback>(file, fallback).load()).toEqual(fallback);
  });

  it("corrupt JSON returns the fallback and warns", () => {
    const file = fresh();
    writeFileSync(file, "{not json", "utf8");
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const fallback = { ok: true };
    expect(new JsonStateFile<typeof fallback>(file, fallback).load()).toEqual(fallback);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("corrupt");
  });

  it('a file containing literal "null" falls back instead of leaking null', () => {
    const file = fresh();
    writeFileSync(file, "null", "utf8");
    const fallback = { ok: true };
    expect(new JsonStateFile<typeof fallback>(file, fallback).load()).toEqual(fallback);
  });

  it("unreadable file (path is a directory → EISDIR) returns the fallback and warns", () => {
    dir = tmpDir();
    const file = join(dir, "state.json");
    mkdirSync(file); // a directory sitting where the file should be
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const fallback = { ok: true };
    expect(new JsonStateFile<typeof fallback>(file, fallback).load()).toEqual(fallback);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("unreadable");
  });

  it("saves are 0600 and the created directory is 0700", () => {
    const file = fresh();
    new JsonStateFile<unknown[]>(file, []).save([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    new JsonStateFile<unknown[]>(file, []).save([]);
    expect(statSync(file).mode & 0o777).toBe(0o600); // stable on re-save
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
  });

  it("missing directories are auto-created on save", () => {
    dir = tmpDir();
    const file = join(dir, "a", "b", "state.json");
    new JsonStateFile<Record<string, never>>(file, {}).save({});
    expect(existsSync(file)).toBe(true);
  });

  it("a failed save never corrupts the previous state and leaves no tmp file", () => {
    const file = fresh();
    const state = new JsonStateFile<Array<{ id: string }>>(file, []);
    state.save([{ id: "good" }]);
    // Circular reference → JSON.stringify throws before anything is written.
    const poisoned: Array<{ id: string }> = [{ id: "bad" }];
    (poisoned[0] as unknown as { self: unknown }).self = poisoned;
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    state.save(poisoned);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(new JsonStateFile<Array<{ id: string }>>(file, []).load()).toEqual([{ id: "good" }]);
  });

  it("re-saving replaces the previous value (rename overwrite)", () => {
    const file = fresh();
    const state = new JsonStateFile<Record<string, number>>(file, {});
    state.save({ n: 1 });
    state.save({ n: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ n: 2 });
  });
});
