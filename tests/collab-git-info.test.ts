/**
 * collab/git-info 进程级直测(spec #299 票03/票04 的唯一新小缝):本地临时
 * 仓库,不打真网 —— probe 读 origin、clone 落地、URL 归一比较。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneRepository, probeProjectGit, repoNameFromUrl, sameRemoteUrl } from "../src/collab/git-info";

const execFileP = promisify(execFile);

describe("collab/git-info (spec #299 票03/票04)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-courier-gitinfo-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("repoNameFromUrl strips .git/trailing slashes and takes the last segment", () => {
    expect(repoNameFromUrl("https://github.com/x/y.git")).toBe("y");
    expect(repoNameFromUrl("https://github.com/x/y/")).toBe("y");
    expect(repoNameFromUrl("git@github.com:x/y.git")).toBe("y");
    expect(repoNameFromUrl("file:///tmp/repo.git")).toBe("repo");
  });

  it("sameRemoteUrl ignores .git suffix and trailing slashes", () => {
    expect(sameRemoteUrl("https://h/x/y.git", "https://h/x/y")).toBe(true);
    expect(sameRemoteUrl("https://h/x/y/", "https://h/x/y")).toBe(true);
    expect(sameRemoteUrl("https://h/x/y", "https://h/x/z")).toBe(false);
  });

  it("probeProjectGit reads the origin url; non-repo dir → undefined (URL 可后补)", async () => {
    const repoDir = join(tmp, "src");
    await execFileP("git", ["init", "-b", "main", repoDir]);
    await execFileP("git", ["-C", repoDir, "remote", "add", "origin", "https://example.com/x/y.git"]);
    const info = await probeProjectGit(repoDir);
    expect(info?.gitUrl).toBe("https://example.com/x/y.git");
    // origin/HEAD 符号引用不存在 → 默认分支可空缺
    expect(info?.defaultBranch).toBeUndefined();
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    expect(await probeProjectGit(empty)).toBeUndefined();
  });

  it("cloneRepository clones a local source (probe sees origin); existing dest / bad source reject", async () => {
    const src = join(tmp, "src");
    const bare = join(tmp, "origin.git");
    await execFileP("git", ["init", "--bare", "-b", "main", bare]);
    await execFileP("git", ["init", "-b", "main", src]);
    await execFileP("git", ["-C", src, "remote", "add", "origin", bare]);
    const dest = join(tmp, "dest");
    await cloneRepository(src, dest);
    expect(existsSync(join(dest, ".git"))).toBe(true);
    // 本地路径源:clone 后 origin 记的是源路径(测试断言以实际语义为准)
    expect((await probeProjectGit(dest))?.gitUrl).toBe(src);
    // 已存在的目标目录:git clone 语义报错(调用方 claim 流程已有存在性分支)
    await expect(cloneRepository(src, dest)).rejects.toThrow();
    await expect(cloneRepository("/nonexistent/repo.git", join(tmp, "d2"))).rejects.toThrow();
  });
});
