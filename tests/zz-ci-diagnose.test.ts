/** 临时诊断(CI 专用,查完即删):打印 builtin mock 的实际行为。 */
import { describe, it, vi } from "vitest";

describe("ci-diagnose", () => {
  it("prints module mock behavior", async () => {
    vi.resetModules();
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, homedir: () => "/tmp/DIAG-HOME" };
    });
    const osMod = await import("os");
    const nodeOsMod = await import("node:os");
    console.log("DIAG node=", process.version, "HOME=", process.env.HOME);
    console.log("DIAG import('os').homedir() =", osMod.homedir());
    console.log("DIAG import('node:os').homedir() =", nodeOsMod.homedir());
    console.log("DIAG same module object =", osMod === nodeOsMod);
    const cfg = await import("../src/config");
    console.log("DIAG runtimeLayout().configPath =", cfg.runtimeLayout().configPath);
    const cfgAgain = await import("../src/config");
    console.log("DIAG config module identity stable =", cfg === cfgAgain);
  });
});
