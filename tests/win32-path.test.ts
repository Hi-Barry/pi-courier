/**
 * Windows 路径守卫直测(issue #190):保留名/非法字符/长路径三类拒因与
 * 大小写折叠比较。纯函数,全平台可跑。
 */
import { describe, expect, it } from "vitest";
import { MAX_PATH_LENGTH, win32PathProblem, win32SamePath } from "../src/win32-path.js";

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
