import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../config.js";
import { PmctlController } from "./pmctl-controller.js";
import type { ProjectManager } from "./project-manager.js";

function makeController(workdir?: string): PmctlController {
  return new PmctlController({
    projectManager: {} as ProjectManager,
    store: new ConfigStore(workdir ? { workdir } : {}),
  });
}

// resolveProjectPath is private; exercised through the class like the runtime
// new/mv commands do — it is the single shared path resolver.
function resolve(controller: PmctlController, p: string): string {
  return (controller as unknown as { resolveProjectPath(p: string): string }).resolveProjectPath(p);
}

describe("resolveProjectPath", () => {
  it("expands ~/... against the home directory (#64)", () => {
    const c = makeController();
    expect(resolve(c, "~/Projects/abc")).toBe(path.join(os.homedir(), "Projects", "abc"));
  });

  it("expands bare ~ to the home directory", () => {
    const c = makeController();
    expect(resolve(c, "~")).toBe(os.homedir());
  });

  it("keeps absolute paths as-is", () => {
    const c = makeController();
    expect(resolve(c, "/tmp/foo")).toBe("/tmp/foo");
  });

  it("joins relative paths against the configured workdir", () => {
    const c = makeController(path.join(os.homedir(), "Projects"));
    expect(resolve(c, "abc")).toBe(path.join(os.homedir(), "Projects", "abc"));
    expect(resolve(c, "a/b")).toBe(path.join(os.homedir(), "Projects", "a", "b"));
  });

  it("defaults the relative root to ~/Projects when workdir unset", () => {
    const c = makeController();
    expect(resolve(c, "abc")).toBe(path.join(os.homedir(), "Projects", "abc"));
  });
});
