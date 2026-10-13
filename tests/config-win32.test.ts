/**
 * The config permission self-check is POSIX-only (evaluation 2026-10-13):
 * libuv reports only 0666/0444 for regular files on Windows, so an over-wide
 * 0644 config would warn on every single start there. On win32 the whole
 * check is skipped; on Linux the warning still fires (control case).
 *
 * Isolation follows config.test.ts: vi.resetModules + doMock('os') so the
 * module-level CONFIG_DIR resolves into a temp home, then a dynamic import;
 * process.platform is flipped via defineProperty (configurable on Node 24).
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

  /** Mock homedir → tmpDir, import config fresh, hand back loadConfig. */
  async function importConfig() {
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => tmpDir };
    });
    const mod = await import("../src/config");
    return { loadConfig: mod.loadConfig };
  }

  /** Write a valid config with 0644 (over-wide by the 0600 contract). */
  function writeLooseConfig(): void {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    const configPath = join(tmpDir, ".pi", "pi-courier.json");
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
