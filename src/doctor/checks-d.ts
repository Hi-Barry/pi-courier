/**
 * doctor D 组检查:状态与目录(spec #337 票 #340)。
 *
 *  - D1/D2:自管目录 stateDir/dataDir 存在与权限(0700)。缺失/过松 ⚠️
 *       (可修复:建目录/chmod 0700,安全幂等档);win32 权限 ⏭️,存在性照查。
 *  - D3:陈旧单实例锁(lockIsStale 同源,绝不偷活锁)—— 陈旧 ⚠️ 可清;
 *       活锁 ✅(桥在跑,doctor 只报告,不拿锁不启停)。
 *  - D4:manual-stop 残留标记(watchdog-paused)→ ⚠️ 可清。
 *  - D5:pending-update 残留(有效或畸形条目)→ ⚠️ 可清。
 *  - D6:旧布局残留(legacy-migration 同源映射表)→ ⚠️ 只报告 + 迁移指引
 *       (迁移交给启动迁移器,doctor 不搬数据;提示档)。
 */

import * as fs from "node:fs";
import { t } from "../i18n/index.js";
import {
  clearManualStopFix,
  clearPendingUpdateFix,
  mkdirOrChmodDirFix,
  removeStaleLockFix,
} from "./fixes-cd.js";
import type { CheckResult, DoctorCheckEntry, DoctorContext } from "./types.js";

/** D 组检查项 id 表(#348):文件内 id 字面量收口,拼错变编译错误。 */
const ID = { D1: "D1", D2: "D2", D3: "D3", D4: "D4", D5: "D5", D6: "D6" } as const;

/** POSIX 权限判松:group/other 任意位非 0 → 过松(0700 契约)。 */
function modeLoose(path: string): string | undefined {
  const mode = fs.statSync(path).mode & 0o777;
  return (mode & 0o077) !== 0 ? mode.toString(8) : undefined;
}

/** 自管目录检查(存在 + 0700)。 */
function selfManagedDirResult(
  id: string,
  dir: string,
  platform: NodeJS.Platform,
): CheckResult {
  if (!fs.existsSync(dir)) {
    return {
      id,
      group: "D",
      severity: "warn",
      summary: t("doctor.d.dirMissing", { dir }),
      nextStep: "pi-courier doctor --fix",
    };
  }
  if (platform === "win32") {
    // libuv 报不出 POSIX mode(与 C3 同理由);存在性已确认,权限 ⏭️
    return {
      id,
      group: "D",
      severity: "skip",
      summary: t("doctor.d.dirWin32Perm", { dir }),
      detail: dir,
    };
  }
  const loose = modeLoose(dir);
  if (loose !== undefined) {
    return {
      id,
      group: "D",
      severity: "warn",
      summary: t("doctor.d.dirLoose", { dir, mode: loose }),
      nextStep: "pi-courier doctor --fix",
    };
  }
  return { id, group: "D", severity: "ok", summary: t("doctor.d.dirOk"), detail: dir };
}

export function checkGroupD(ctx: DoctorContext): DoctorCheckEntry[] {
  const { layout, platform } = ctx.deps;

  const d1: DoctorCheckEntry = {
    id: ID.D1,
    group: "D",
    // D1 修复:stateDir 建目录/收紧(warn 档触发,#348 挂 entry)
    fix: { on: "warn", make: (ctx) => mkdirOrChmodDirFix(ctx, "stateDir") },
    run: async () => selfManagedDirResult(ID.D1, layout.stateDir, platform),
  };

  const d2: DoctorCheckEntry = {
    id: ID.D2,
    group: "D",
    // D2 修复:dataDir 建目录/收紧(warn 档触发,#348 挂 entry)
    fix: { on: "warn", make: (ctx) => mkdirOrChmodDirFix(ctx, "dataDir") },
    run: async () => selfManagedDirResult(ID.D2, layout.dataDir, platform),
  };

  const d3: DoctorCheckEntry = {
    id: ID.D3,
    group: "D",
    // D3 修复:删陈旧锁(warn 档触发;绝不偷活锁,#348 挂 entry)
    fix: { on: "warn", make: removeStaleLockFix },
    run: async () => {
      if (!fs.existsSync(layout.lockPath)) {
        return { id: ID.D3, group: "D", severity: "ok", summary: t("doctor.d.lockFree") };
      }
      const { lockIsStale } = await import("../lock.js");
      if (lockIsStale(layout.lockPath)) {
        return {
          id: ID.D3,
          group: "D",
          severity: "warn",
          summary: t("doctor.d.lockStale", { path: layout.lockPath }),
          nextStep: "pi-courier doctor --fix",
        };
      }
      // 活锁 = 有实例持有(桥在跑):健康态,doctor 不拿锁不偷锁
      return { id: ID.D3, group: "D", severity: "ok", summary: t("doctor.d.lockHeld"), detail: layout.lockPath };
    },
  };

  const d4: DoctorCheckEntry = {
    id: ID.D4,
    group: "D",
    // D4 修复:清 manual-stop 残留(warn 档触发,#348 挂 entry)
    fix: { on: "warn", make: clearManualStopFix },
    run: async () => {
      const { manualStopMarkerPath } = await import("../resilience/manual-stop.js");
      const marker = manualStopMarkerPath(layout.stateDir);
      if (!fs.existsSync(marker)) {
        return { id: ID.D4, group: "D", severity: "ok", summary: t("doctor.d.markerFree") };
      }
      return {
        id: ID.D4,
        group: "D",
        severity: "warn",
        summary: t("doctor.d.markerStale", { path: marker }),
        detail: t("doctor.d.markerHint"),
        nextStep: "pi-courier doctor --fix",
      };
    },
  };

  const d5: DoctorCheckEntry = {
    id: ID.D5,
    group: "D",
    // D5 修复:清 pending-update 残留(warn 档触发,#348 挂 entry)
    fix: { on: "warn", make: clearPendingUpdateFix },
    run: async () => {
      // 落盘路径与组合根同源(pendingUpdatePath,单一拼法);读侧经
      // PendingUpdateStore(JsonStateFile 吞错降级)
      const { PendingUpdateStore, pendingUpdatePath } = await import("../update/pending-update.js");
      const pendingPath = pendingUpdatePath(layout.stateDir);
      if (!fs.existsSync(pendingPath)) {
        return { id: ID.D5, group: "D", severity: "ok", summary: t("doctor.d.pendingFree") };
      }
      const entry = new PendingUpdateStore(pendingPath).read();
      if (entry) {
        return {
          id: ID.D5,
          group: "D",
          severity: "warn",
          summary: t("doctor.d.pendingStale", { from: entry.from, to: entry.to }),
          detail: pendingPath,
          nextStep: "pi-courier doctor --fix",
        };
      }
      return {
        id: ID.D5,
        group: "D",
        severity: "warn",
        summary: t("doctor.d.pendingMalformed"),
        detail: pendingPath,
        nextStep: "pi-courier doctor --fix",
      };
    },
  };

  const d6: DoctorCheckEntry = {
    id: ID.D6,
    group: "D",
    run: async () => {
      const { buildLegacyMigrationPlan } = await import("../legacy-migration.js");
      const plan = buildLegacyMigrationPlan({ platform, homedir: ctx.deps.homedir, layout });
      const remnants = plan.items.filter((item) => fs.existsSync(item.from)).map((item) => item.from);
      if (plan.legacyLockPath && fs.existsSync(plan.legacyLockPath)) {
        remnants.push(plan.legacyLockPath);
      }
      if (remnants.length === 0) {
        return { id: ID.D6, group: "D", severity: "ok", summary: t("doctor.d.legacyFree") };
      }
      return {
        id: ID.D6,
        group: "D",
        severity: "warn",
        summary: t("doctor.d.legacyRemnants", { count: remnants.length }),
        detail: remnants.join("\n"),
        nextStep: t("doctor.d.legacyNext"),
      };
    },
  };

  return [d1, d2, d3, d4, d5, d6];
}
