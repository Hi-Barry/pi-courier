/**
 * doctor G 组检查:磁盘水位(spec #337 票 #341)。
 *
 * 与运行时同源:阈值取 config.ts 的 diskHardMb/diskSoftMb(ResourceGuard 的
 * 同一解释函数),读数与运行时同款取 effectiveWorkdir 所在盘
 * (standalone 组合根 readDiskFreeBytes = diskFreeBytes(workdir))。
 * 分档:低于硬阈值 ❌(运行时会硬退)/ 软硬之间 ⚠️(逼近)/ 其余 ✅;
 * 读数不可用 ⏭️(判不了,不误报)。
 */

import { t } from "../i18n/index.js";
import type { DoctorCheckEntry, DoctorContext } from "./types.js";

const MB = 1024 * 1024;

export function checkGroupG(ctx: DoctorContext): DoctorCheckEntry[] {
  return [
    {
      id: "G1",
      group: "G",
      run: async () => {
        // 阈值同源(config.ts 解释函数);helper 崩 → ⏭️
        let hardMb: number;
        let softMb: number;
        try {
          const { diskHardMb, diskSoftMb } = await import("../config.js");
          hardMb = diskHardMb(ctx.config ?? {});
          softMb = diskSoftMb(ctx.config ?? {});
        } catch (err) {
          return {
            id: "G1",
            group: "G",
            severity: "skip",
            summary: t("doctor.degraded", { reason: err instanceof Error ? err.message : String(err) }),
          };
        }
        // 读数与运行时同源:workdir 所在盘(effectiveWorkdir 解释函数;再崩 → ⏭️)
        let workdir: string;
        try {
          const { effectiveWorkdir } = await import("../config.js");
          workdir = effectiveWorkdir(ctx.config ?? {});
        } catch (err) {
          return {
            id: "G1",
            group: "G",
            severity: "skip",
            summary: t("doctor.degraded", { reason: err instanceof Error ? err.message : String(err) }),
          };
        }
        const free = ctx.deps.diskFreeBytes(workdir);
        if (free === undefined) {
          return { id: "G1", group: "G", severity: "skip", summary: t("doctor.g.unreadable", { path: workdir }) };
        }
        const freeMb = Math.round(free / MB);
        if (freeMb < hardMb) {
          return {
            id: "G1",
            group: "G",
            severity: "fail",
            summary: t("doctor.g.belowHard", { free: freeMb, threshold: hardMb }),
            detail: workdir,
            nextStep: t("doctor.g.next"),
          };
        }
        if (freeMb < softMb) {
          return {
            id: "G1",
            group: "G",
            severity: "warn",
            summary: t("doctor.g.nearSoft", { free: freeMb, threshold: softMb, hard: hardMb }),
            detail: workdir,
          };
        }
        return {
          id: "G1",
          group: "G",
          severity: "ok",
          summary: t("doctor.g.ok", { free: freeMb, threshold: softMb }),
          detail: workdir,
        };
      },
    },
  ];
}
