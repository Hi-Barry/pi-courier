/**
 * Windows 路径守卫直测(issue #190):保留名/非法字符/长路径三类拒因与
 * 大小写折叠比较。纯函数,全平台可跑。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PATH_LENGTH,
  unquotedWin32DrivePath,
  win32PathProblem,
  win32SamePath,
} from "../src/win32-path.js";

describe("win32PathProblem", () => {
  it("accepts ordinary paths (drive, UNC, trailing separators)", () => {
    expect(win32PathProblem("C:\\Users\\admin\\Projects\\myapp")).toBeNull();
    expect(win32PathProblem("\\\\server\\share\\projects\\app")).toBeNull();
    expect(win32PathProblem("C:\\Projects\\")).toBeNull();
  });

  it("rejects DOS reserved device names, with or without an extension", () => {
    expect(win32PathProblem("C:\\Projects\\con")).toEqual({ kind: "reserved", component: "con" });
    expect(win32PathProblem("C:\\Projects\\NUL.txt")).toEqual({ kind: "reserved", component: "NUL.txt" });
    expect(win32PathProblem("C:\\Projects\\com1")).toEqual({ kind: "reserved", component: "com1" });
    expect(win32PathProblem("C:\\Projects\\LPT9\\x")).toEqual({ kind: "reserved", component: "LPT9" });
  });

  it("does not treat lookalikes as reserved", () => {
    expect(win32PathProblem("C:\\Projects\\console")).toBeNull();
    expect(win32PathProblem("C:\\Projects\\com10")).toBeNull();
    expect(win32PathProblem("C:\\Projects\\null")).toBeNull();
  });

  it("rejects NTFS-illegal characters but exempts the drive colon", () => {
    expect(win32PathProblem("C:\\Projects\\a?b")).toEqual({ kind: "illegalChars", component: "a?b" });
    expect(win32PathProblem("C:\\Projects\\a:b")).toEqual({ kind: "illegalChars", component: "a:b" });
    expect(win32PathProblem("C:\\Projects\\a|b")).toEqual({ kind: "illegalChars", component: "a|b" });
    expect(win32PathProblem("C:\\Projects\\a*b")).toEqual({ kind: "illegalChars", component: "a*b" });
    expect(win32PathProblem("C:\\Projects\\a\"b")).toEqual({ kind: "illegalChars", component: "a\"b" });
    // drive designator survives
    expect(win32PathProblem("C:\\ok")).toBeNull();
  });

  it("rejects paths beyond the classic 260 limit", () => {
    const long = `C:\\${"a".repeat(MAX_PATH_LENGTH)}`;
    expect(win32PathProblem(long)).toEqual({ kind: "tooLong", length: long.length });
    const justFit = `C:\\${"a".repeat(MAX_PATH_LENGTH - 4)}`;
    expect(win32PathProblem(justFit)).toBeNull();
  });

  it("checks length before components (longest failure wins)", () => {
    const longReserved = `C:\\${"x".repeat(MAX_PATH_LENGTH)}\\con`;
    expect(win32PathProblem(longReserved)?.kind).toBe("tooLong");
  });
});

describe("win32SamePath", () => {
  it("folds case and NFKC like the label/room-name comparisons", () => {
    expect(win32SamePath("C:\\Projects\\Foo", "c:\\projects\\foo")).toBe(true);
    expect(win32SamePath("C:\\Projects\\Foo", "C:\\Projects\\bar")).toBe(false);
  });
});

describe("unquotedWin32DrivePath — 未加引号盘符反斜杠路径信号(spec #256)", () => {
  it("命中:引号外的 X:\\ 形式", () => {
    expect(unquotedWin32DrivePath("dir d:\\share\\Projects")).toBe(true);
    expect(unquotedWin32DrivePath("type C:\\Windows\\win.ini")).toBe(true);
    expect(unquotedWin32DrivePath("ls D:/share && dir e:\\tmp")).toBe(true);
  });

  it("不命中:正斜杠形式本就能正常工作", () => {
    expect(unquotedWin32DrivePath("dir d:/share/Projects")).toBe(false);
  });

  it("不命中:单引号内是字面量,路径原样到达", () => {
    expect(unquotedWin32DrivePath("dir 'd:\\share\\Projects'")).toBe(false);
  });

  it("不命中:双引号内反斜杠保留,路径能正常工作", () => {
    expect(unquotedWin32DrivePath('dir "d:\\share\\Projects"')).toBe(false);
  });

  it("不命中:引号外的转义反斜杠(d:\\\\share 到达时完好)", () => {
    expect(unquotedWin32DrivePath("dir d:\\\\share\\\\Projects")).toBe(false);
  });

  it("不命中:双引号内的转义序列(\"...\\\" 之后回到引号外才算)", () => {
    expect(unquotedWin32DrivePath('echo "d:\\x" && dir e:\\y')).toBe(true);
    expect(unquotedWin32DrivePath('echo "a\\"b" dir e:\\y')).toBe(true);
  });

  it("不命中:无盘符反斜杠的普通命令", () => {
    expect(unquotedWin32DrivePath("git status")).toBe(false);
    expect(unquotedWin32DrivePath("ls -la /d/share")).toBe(false);
    expect(unquotedWin32DrivePath("echo a:b")).toBe(false);
  });
});
