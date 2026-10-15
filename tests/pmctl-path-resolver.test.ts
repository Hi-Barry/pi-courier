/**
 * resolveProjectPath 路径解析直测(issue #188 收编):原驻 src/rpc/ 使
 * 主 tsconfig 的 include:["src/**"] 把它编译进 dist 随包发布 —— 移入
 * tests/ 后 dist 恢复无测试产物;src/**\/*.test.ts 同步加进构建 exclude 防再犯。
 */
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { PmctlController } from "../src/rpc/pmctl-controller.js";
import type { ProjectManager } from "../src/rpc/project-manager.js";

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
