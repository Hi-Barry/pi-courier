/**
 * restart-hidden.vbs 是部署产物(WSH/ANSI 环境,没有可运行的单测宿主),
 * 但它的三条铁律曾经致命(spec #331 评审修复):
 *  1. 顺序:等 3 秒 → taskkill /F → schtasks /change /enable → /end → /run。
 *     提前 kill 会截断「正在重启」回执;漏掉 enable,被禁用的任务 /run 静默失败。
 *  2. 绝不能用 taskkill /T:这个 wscript 本身就是桥 spawn 的子进程,
 *     /T 会把重启手一起杀掉,/run 永远执行不到 —— 桥再起不来(2026-11-11
 *     真机「/end 杀不死 node」与「树外重启手」两条事实叠加后的隐蔽陷阱)。
 *  3. ASCII-only:WSH 按系统 ANSI 代码页读 .vbs,非 ASCII 会直接报错。
 * 用纯文本守卫钉住这三点,任何改动顺序/加 /T/加中文注释都会立刻红灯。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VBS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "deploy",
  "windows",
  "restart-hidden.vbs",
);

describe("restart-hidden.vbs · 树外重启手的配方(spec #331)", () => {
  it("五步顺序完整且递增(sleep → taskkill /F → change /enable → end → run)", () => {
    const s = fs.readFileSync(VBS_PATH, "utf8");
    const tokens = [
      "WScript.Sleep",
      "taskkill /F /PID",
      "schtasks /change /enable",
      "schtasks /end /tn",
      "schtasks /run /tn",
    ];
    let at = -1;
    for (const token of tokens) {
      const i = s.indexOf(token, at + 1);
      expect(i, `missing/out-of-order: ${token}`).toBeGreaterThan(at);
      at = i;
    }
  });

  it("不含 taskkill /T(会连坐杀掉重启手自己),且全文件 ASCII-only", () => {
    const s = fs.readFileSync(VBS_PATH, "utf8");
    expect(s).not.toContain("taskkill /T");
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(s), "WSH reads ANSI: non-ASCII breaks the script").toBe(false);
  });
});
