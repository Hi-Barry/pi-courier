/**
 * doctor F 组检查:systemd 服务只读对比(spec #337 票 #342,Q13 共识)。
 *
 *  - F1:unit 存在与启用(systemctl --user cat/is-enabled)—— 缺失 ⚠️ +
 *       enable 指引;未启用 ⚠️;启用 ✅;
 *  - F2:服务 active(is-active)—— active ✅;inactive ⚠️(人工停止是
 *       有意状态,D4 已单独报标记残留,这里只报「没在跑」);
 *  - F3:unit 声明的 node 与当前 process.execPath 对比(ExecStart 首段)——
 *       不一致 ⚠️(node 升级后 unit 钉死旧路径的经典漂移);一致 ✅。
 *
 * 只读红线:全部经注入 execFile 只读查询(cat/is-enabled/is-active),绝不写
 * unit、绝不 enable/disable、绝不启停(启停走既有服务族命令,out of scope)。
 * win32(及一切非 Linux):整组 ⏭️ 带原因,不误报 ❌。
 */

import { t } from "../i18n/index.js";
import type { CheckResult, DoctorCheckEntry, DoctorContext } from "./types.js";

const SERVICE_UNIT = "pi-courier.service";

/** ExecStart= 行的首段(node 可执行路径);解析不到返回 undefined。 */
function execStartNode(unitText: string): string | undefined {
  for (const line of unitText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("ExecStart=")) continue;
    const first = trimmed.slice("ExecStart=".length).trim().split(/\s+/)[0];
    return first === "" ? undefined : first;
  }
  return undefined;
}

export function checkGroupF(ctx: DoctorContext): DoctorCheckEntry[] {
  if (ctx.deps.platform !== "linux") {
    const skip = (id: string): DoctorCheckEntry => ({
      id,
      group: "F",
      run: async (): Promise<CheckResult> => ({
        id,
        group: "F",
        severity: "skip",
        summary: t("doctor.f.notLinux"),
      }),
    });
    return [skip("F1"), skip("F2"), skip("F3")];
  }

  const query = async (
    execFile: DoctorContext["deps"]["execFile"],
    args: string[],
  ): Promise<{ stdout: string; code: number }> => {
    const out = await execFile("systemctl", ["--user", ...args]);
    return { stdout: out.stdout, code: out.code };
  };

  const f1: DoctorCheckEntry = {
    id: "F1",
    group: "F",
    run: async (): Promise<CheckResult> => {
      const cat = await query(ctx.deps.execFile, ["cat", SERVICE_UNIT]);
      if (cat.code !== 0) {
        return {
          id: "F1",
          group: "F",
          severity: "warn",
          summary: t("doctor.f.unitMissing", { unit: SERVICE_UNIT }),
          nextStep: "pi-courier enable",
        };
      }
      const enabled = await query(ctx.deps.execFile, ["is-enabled", SERVICE_UNIT]);
      if (enabled.code !== 0) {
        return {
          id: "F1",
          group: "F",
          severity: "warn",
          summary: t("doctor.f.unitDisabled", { unit: SERVICE_UNIT }),
          nextStep: "pi-courier enable",
        };
      }
      return { id: "F1", group: "F", severity: "ok", summary: t("doctor.f.unitEnabled"), detail: SERVICE_UNIT };
    },
  };

  const f2: DoctorCheckEntry = {
    id: "F2",
    group: "F",
    run: async (): Promise<CheckResult> => {
      const active = await query(ctx.deps.execFile, ["is-active", SERVICE_UNIT]);
      if (active.code === 0 && active.stdout.trim() === "active") {
        return { id: "F2", group: "F", severity: "ok", summary: t("doctor.f.active") };
      }
      return {
        id: "F2",
        group: "F",
        severity: "warn",
        summary: t("doctor.f.inactive"),
        nextStep: `pi-courier start  # 若是有意停止,忽略本项(残留标记见 D4)`,
      };
    },
  };

  const f3: DoctorCheckEntry = {
    id: "F3",
    group: "F",
    run: async (): Promise<CheckResult> => {
      const cat = await query(ctx.deps.execFile, ["cat", SERVICE_UNIT]);
      if (cat.code !== 0) {
        return { id: "F3", group: "F", severity: "skip", summary: t("doctor.f.nodeNoUnit") };
      }
      const unitNode = execStartNode(cat.stdout);
      if (!unitNode) {
        return { id: "F3", group: "F", severity: "skip", summary: t("doctor.f.nodeUnparsable") };
      }
      const current = process.execPath;
      if (unitNode !== current) {
        return {
          id: "F3",
          group: "F",
          severity: "warn",
          summary: t("doctor.f.nodeDrift"),
          detail: t("doctor.f.nodeDriftDetail", { unit: unitNode, current }),
          nextStep: "pi-courier enable",
        };
      }
      return { id: "F3", group: "F", severity: "ok", summary: t("doctor.f.nodeOk"), detail: current };
    },
  };

  return [f1, f2, f3];
}
