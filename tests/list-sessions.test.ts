import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { listSessions } from "../src/rpc/command-map.js";

describe("listSessions(递归扫描)", () => {
  let base: string;

  beforeAll(() => {
    base = mkdtempSync(join(osTmpdir(), "pi-listsessions-"));
    // 根层一份 + 工作目录子目录两份(pi 的 <base>/<workdir-slug>/<file>.jsonl 布局)
    writeFileSync(join(base, "root.jsonl"), "{}\n");
    const sub = join(base, "--tmp-my-workdir--");
    mkdirSync(sub);
    writeFileSync(join(sub, "old.jsonl"), "{}\n");
    writeFileSync(join(sub, "new.jsonl"), "{}\n");
    // mtime 排序:new.jsonl 最新
    const t = Date.now() / 1000;
    utimesSync(join(sub, "old.jsonl"), t - 100, t - 100);
    utimesSync(join(base, "root.jsonl"), t - 50, t - 50);
    // 非 jsonl 干扰项
    writeFileSync(join(base, "noise.txt"), "x");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("递归找到子目录里的会话文件,并按 mtime 新的在前", () => {
    const sessions = listSessions(base);
    const files = sessions.map((s) => s.file);
    expect(files).toEqual(["new.jsonl", "root.jsonl", "old.jsonl"]);
    expect(sessions[0].path).toContain("--tmp-my-workdir--");
  });

  it("file 字段保持纯文件名(不含子目录)", () => {
    const sessions = listSessions(base);
    for (const s of sessions) expect(s.file).not.toContain("/");
  });

  it("目录不存在时返回空数组", () => {
    expect(listSessions(join(base, "definitely-missing"))).toEqual([]);
  });
});
