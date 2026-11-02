/**
 * The config permission self-check is POSIX-only (evaluation 2026-10-13):
 * libuv reports only 0666/0444 for regular files on Windows, so an over-wide
 * 0644 config would warn on every single start there. On win32 the whole
 * check is skipped; on Linux the warning still fires (control case).
 *
 * Isolation: vi.resetModules + doMock('os') pin homedir into a temp dir, and
 * resolveLayout is pinned to a POSIX-shaped layout — process.platform is
 * flipped via defineProperty (configurable on Node 24) to drive the
 * permission-check gate inside loadConfig, but the layout must NOT follow the
 * flip: win32 branches also switch to path.win32 separators, which a POSIX
 * test filesystem can never materialize. The thing under test here is the
 * platform gate, not the layout (paths.test.ts owns that matrix).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("loadConfig permission self-check vs platform", () => {
  let tmpDir: string;
  let platformDescriptor: PropertyDescriptor;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-configwin-"));
    vi.resetModules();
    platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Mock homedir → tmpDir and pin a POSIX-shaped layout, import config
   *  fresh, hand back loadConfig. */
  async function importConfig() {
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });
    vi.doMock("../src/paths.js", async () => {
      const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
      return {
        ...actual,
        resolveLayout: (input: Parameters<typeof actual.resolveLayout>[0]) =>
          actual.resolveLayout({ ...input, platform: "linux" }),
      };
    });
    const mod = await import("../src/config");
    return { loadConfig: mod.loadConfig };
  }

  /** POSIX-shaped config dir (matches the pinned linux layout). */
  function configDir(): string {
    return join(tmpDir, ".config", "pi-courier");
  }

  /** Write a valid config with 0644 (over-wide by the 0600 contract). */
  function writeLooseConfig(): void {
    mkdirSync(configDir(), { recursive: true });
    const configPath = join(configDir(), "pi-courier.json");
    writeFileSync(configPath, JSON.stringify({ workdir: "/tmp/work" }));
    chmodSync(configPath, 0o644);
  }

  it("win32: skips the check — an over-wide config warns nothing", async () => {
    writeLooseConfig();
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadConfig } = await importConfig();

    const cfg = loadConfig();

    expect(cfg.workdir).toBe("/tmp/work");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("linux (control): the same config still triggers the 0600 warning", async () => {
    // Also skipped on real Windows: flipping process.platform cannot make
    // libuv report POSIX modes there, so chmod 0644 would never warn.
    writeLooseConfig();
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadConfig } = await importConfig();

    loadConfig();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("Should be 0600");
  });
});
