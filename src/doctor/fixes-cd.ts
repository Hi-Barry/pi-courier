/**
 * doctor C/D 组的安全幂等修复动作(spec #337 票 #340,复用票 #339 的修复
 * 执行器)。只有 collectFixActions 的报告门槛会放行这些动作;全部自证幂等:
 *
 *  - chmodConfigFix(C3):配置 0600 收紧 —— 备份先于 chmod(复用票 2 的
 *    备份→改→diff 顺序契约),打印 mode 改前/改后;
 *  - mkdirOrChmodDirFix(D1/D2):创建缺失自管目录(mkdir 0700)或收紧权限
 *    (chmod 0700);
 *  - removeStaleLockFix(D3):删陈旧锁 —— 只删 lockIsStale 判定过的,活锁
 *    永不触碰;锁已不在/已变活 → changed=false;
 *  - clearManualStopFix(D4):清 watchdog-paused 残留标记;
 *  - clearPendingUpdateFix(D5):清 pending-update.json 残留(运行痕迹,
 *    非 session/数据 —— 禁区档永不触碰后者)。
 *
 * 提示档(workdir/sessionDir 缺失、旧布局残留)与不可修复档(配置缺失)在
 * 本文件里没有对应动作 —— 「不存在的动作」就是提示档/禁区档的硬边界。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n/index.js";
import { backupRequired, diffLines, type FixAction, type FixOutcome } from "./fix.js";
import type { DoctorContext } from "./types.js";

/** C3:配置 0600 收紧(备份先于 chmod,mode diff)。 */
export function chmodConfigFix(ctx: DoctorContext): FixAction {
  const configPath = ctx.deps.layout.configPath;
  return {
    checkId: "C3",
    summary: t("doctor.fix.chmodConfig"),
    run: async (): Promise<FixOutcome> => {
      if (!fs.existsSync(configPath)) return { changed: false };
      const before = fs.statSync(configPath).mode & 0o777;
      if ((before & 0o077) === 0) return { changed: false }; // 已收紧,幂等
      // 备份先于改写(权限也是配置状态的一部分;字节原样入备份)
      const backupNote = backupRequired(ctx.deps.layout);
      fs.chmodSync(configPath, 0o600);
      const after = fs.statSync(configPath).mode & 0o777;
      return {
        changed: true,
        notes: [backupNote],
        diff: diffLines(`${before.toString(8)}\n`, `${after.toString(8)}\n`),
      };
    },
  };
}

/** D1/D2:自管目录 —— 缺失则建(0700),存在但过松则收紧(0700)。 */
export function mkdirOrChmodDirFix(ctx: DoctorContext, checkId: "D1" | "D2"): FixAction {
  const dir = checkId === "D1" ? ctx.deps.layout.stateDir : ctx.deps.layout.dataDir;
  return {
    checkId,
    summary: t("doctor.fix.selfManagedDir", { dir }),
    run: async (): Promise<FixOutcome> => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return { changed: true, diff: `+ ${dir} (0700)` };
      }
      const before = fs.statSync(dir).mode & 0o777;
      if ((before & 0o077) === 0) return { changed: false };
      fs.chmodSync(dir, 0o700);
      return { changed: true, diff: diffLines(`${before.toString(8)}\n`, `700\n`) };
    },
  };
}

/** D3:删陈旧锁。只在 lockIsStale 仍判定陈旧时 unlink(活锁/已消失不动)。 */
export async function removeStaleLockFix(ctx: DoctorContext): Promise<FixAction | undefined> {
  const lockPath = ctx.deps.layout.lockPath;
  if (!fs.existsSync(lockPath)) return undefined;
  return {
    checkId: "D3",
    summary: t("doctor.fix.removeStaleLock", { path: lockPath }),
    run: async (): Promise<FixOutcome> => {
      if (!fs.existsSync(lockPath)) return { changed: false };
      const { lockIsStale } = await import("../lock.js");
      if (!lockIsStale(lockPath)) {
        // 竞态:锁被新实例接管/变为活锁 —— 绝不偷活锁
        return { changed: false, notes: [t("doctor.fix.lockNowLive")] };
      }
      fs.unlinkSync(lockPath);
      return { changed: true, diff: `- ${lockPath}` };
    },
  };
}

/** D4:清 manual-stop 残留标记(manualStopMarkerPath 同源)。 */
export function clearManualStopFix(ctx: DoctorContext): FixAction {
  const marker = path.join(ctx.deps.layout.stateDir, "watchdog-paused");
  return {
    checkId: "D4",
    summary: t("doctor.fix.clearManualStop", { path: marker }),
    run: async (): Promise<FixOutcome> => {
      if (!fs.existsSync(marker)) return { changed: false };
      fs.unlinkSync(marker);
      return { changed: true, diff: `- ${marker}` };
    },
  };
}

/** D5:清 pending-update.json 残留(路径与组合根同源:stateDir/pending-update.json)。 */
export function clearPendingUpdateFix(ctx: DoctorContext): FixAction {
  const pendingPath = path.join(ctx.deps.layout.stateDir, "pending-update.json");
  return {
    checkId: "D5",
    summary: t("doctor.fix.clearPendingUpdate", { path: pendingPath }),
    run: async (): Promise<FixOutcome> => {
      if (!fs.existsSync(pendingPath)) return { changed: false };
      fs.unlinkSync(pendingPath);
      return { changed: true, diff: `- ${pendingPath}` };
    },
  };
}
