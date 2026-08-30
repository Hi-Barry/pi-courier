import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Direct tests for first-run workdir resolution. The ConfigStore is the
 *  seam: every case asserts the in-memory state and (when a write happens)
 *  the 0600 disk file. Uses the config.test isolation pattern — os.homedir
 *  mocked to a temp dir BEFORE importing config/workdir, since both compute
 *  paths from it at module load. */

describe("resolveWorkdir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-workdir-"));
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("os");
    vi.doUnmock("node:os");
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importModule() {
    const { resolveWorkdir } = await import("../src/workdir.js");
    const { ConfigStore } = await import("../src/config.js");
    return { resolveWorkdir, ConfigStore };
  }

  const configPath = () => join(tmpDir, ".pi", "pi-courier.json");

  it("silent default path: falls back to ~/Projects, persists through the store", async () => {
    const { resolveWorkdir, ConfigStore } = await importModule();
    const store = new ConfigStore();

    const workdir = await resolveWorkdir(undefined, store, async () => undefined);

    const expected = join(tmpDir, "Projects");
    expect(workdir).toBe(expected);
    // In-memory immediately — this is the bug #13 fixes (used to require a restart).
    expect(store.get().workdir).toBe(expected);
    // Persisted with secure permissions and unchanged format.
    expect(existsSync(configPath())).toBe(true);
    const stat = statSync(configPath());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath(), "utf-8")).workdir).toBe(expected);
  });

  it("cli override wins and never touches the store", async () => {
    const { resolveWorkdir, ConfigStore } = await importModule();
    const store = new ConfigStore();

    const workdir = await resolveWorkdir("/custom/dir", store, async () => {
      throw new Error("must not prompt when --workdir is given");
    });

    expect(workdir).toBe("/custom/dir");
    expect(store.get().workdir).toBeUndefined();
    expect(existsSync(configPath())).toBe(false);
  });

  it("existing config workdir short-circuits without a prompt or write", async () => {
    const { resolveWorkdir, ConfigStore } = await importModule();
    const store = new ConfigStore({ workdir: "/existing/dir" });

    const workdir = await resolveWorkdir(undefined, store, async () => {
      throw new Error("must not prompt when config provides a workdir");
    });

    expect(workdir).toBe("/existing/dir");
    expect(store.get().workdir).toBe("/existing/dir");
    expect(existsSync(configPath())).toBe(false);
  });
});
