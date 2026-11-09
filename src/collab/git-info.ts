/**
 * git-info — 项目工作目录的 git 事实探测(spec #299 票03/票04)。
 *
 * courier 是快递员,不是 git 的操作员:这里只"读"仓库的自描述信息
 * (origin 地址、默认分支),供项目房元数据落盘与客座认领 clone 使用;
 * 所有失败(非 git 仓库、无 origin、git 缺失、超时)都按 undefined 降级,
 * 绝不抛出 —— 元数据是锦上添花,不该卡住项目创建。clone 的"写"侧在票04
 * 落地,也归本目录。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;

export interface ProjectGitInfo {
  gitUrl?: string;
  defaultBranch?: string;
}

async function git(workdir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd: workdir, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

/** 读 workdir 的 origin 地址与默认分支;非 git 仓库/无 origin/任何失败 →
 *  undefined(调用方按"URL 空缺可后补"处理)。 */
export async function probeProjectGit(workdir: string): Promise<ProjectGitInfo | undefined> {
  let gitUrl: string | undefined;
  try {
    gitUrl = (await git(workdir, ["remote", "get-url", "origin"])) || undefined;
  } catch {
    return undefined; // 非 git 仓库或无 origin:URL 空缺(票03 验收口径)
  }
  let defaultBranch: string | undefined;
  try {
    // origin/HEAD 是 clone 端的符号引用;本地新建仓库可能没有 → 分支可空缺。
    defaultBranch = (await git(workdir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(
      /^origin\//,
      ""
    ) || undefined;
  } catch {
    defaultBranch = undefined;
  }
  return { gitUrl, defaultBranch };
}
