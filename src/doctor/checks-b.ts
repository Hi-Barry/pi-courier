/**
 * doctor B 组检查:pi 解析链(spec #337 票 #339)。
 *
 *  - B1:配置 cliPath 存在性;失效 ❌ 且明说「配置里的 pi 路径失效」
 *       (用户故事 6),不是含糊的「启动失败」。可修复(--fix 删除该项,
 *       备份先于删除,桥回退自动发现)。
 *  - B2:pi CLI 自动发现解析链(which pi → 托管布局 → node_modules),
 *       PiRpc.resolveCliPath 同源,不新造解析链。配置了 cliPath 时桥不走
 *       自动发现 → 本项 ⏭️(不适用)。
 *  - B3:pi 版本对 Node 引擎门(assertPiEngineSupported 语义)。
 *  - B4:Node 版本对 pi-courier package.json engines(>=22.19.0)。
 *
 * 检查函数契约:只对「能确定答案」的情形返回结果;helper 动态 import 失败
 * 等无法确定的情形抛错 → runDoctor 的 guardCheck 降级 ⏭️。
 */

import * as fs from "node:fs";
import { t } from "../i18n/index.js";
import { backupRequired, diffLines, type FixOutcome } from "./fix.js";
import type { DoctorCheckEntry, DoctorContext } from "./types.js";

/** 与 pi-courier package.json engines 的 >=x.y.z 底线比较(B4 纯决策;
 *  底线解析复用 pi-rpc 的 minNodeVersionOf)。 */
export function nodeSatisfiesEngine(
  running: [number, number, number],
  floor: [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (running[i] !== floor[i]) return running[i]! > floor[i]!;
  }
  return true;
}

/** 本进程 Node 的 "vX.Y.Z" → [x,y,z](解析失败返回 undefined,B4 降级)。 */
function runningNodeTriple(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

import * as path from "node:path";
// ── node 内置模块(静态依赖红线允许)───────────────────────────────────────
import { fileURLToPath } from "node:url";

/** pi-courier 自身 package.json 的 engines.node(包根 = 本文件编译位置上两级:
 *  src/doctor/ → 仓库根;dist/doctor/ → 仓库根,编译后同构)。 */
function ownEnginesNode(): string | undefined {
  try {
    const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
      engines?: { node?: string };
    };
    return pkg.engines?.node;
  } catch {
    return undefined;
  }
}

/**
 * B 组检查项(#339):B1 cliPath 存在性(可修复)/ B2 自动发现 / B3 pi 引擎门
 * / B4 Node 对 pi-courier engines。
 */
export function checkGroupB(ctx: DoctorContext): DoctorCheckEntry[] {
  const configured = ctx.config?.cliPath;

  const b1: DoctorCheckEntry = {
    id: "B1",
    group: "B",
    run: async () => {
      if (!configured) {
        return { id: "B1", group: "B", severity: "skip", summary: t("doctor.b1.notConfigured") };
      }
      if (fs.existsSync(configured)) {
        return { id: "B1", group: "B", severity: "ok", summary: t("doctor.b1.ok"), detail: configured };
      }
      return {
        id: "B1",
        group: "B",
        severity: "fail",
        summary: t("doctor.b1.stale", { path: configured }),
        nextStep: "pi-courier doctor --fix",
      };
    },
  };

  const b2: DoctorCheckEntry = {
    id: "B2",
    group: "B",
    run: async () => {
      if (configured) {
        return { id: "B2", group: "B", severity: "skip", summary: t("doctor.b2.skipConfigured"), detail: configured };
      }
      // 桥同源解析链(which pi → 托管布局 → node_modules);找不到会抛错
      // → guardCheck 降级?不 —— 「确认坏了」(机器上没有任何 pi)应报 ❌,
      // 只有「查不出来」才是 ⏭️,这里把解析失败按 ❌ 分类。
      const { PiRpc } = await import("../rpc/pi-rpc.js");
      let entry: string;
      try {
        entry = await PiRpc.resolveCliPath();
      } catch (err) {
        return {
          id: "B2",
          group: "B",
          severity: "fail",
          summary: t("doctor.b2.missing"),
          detail: err instanceof Error ? err.message : String(err),
          nextStep: "npm install -g @earendil-works/pi-coding-agent  # 或设置 PI_CLI_PATH",
        };
      }
      if (!fs.existsSync(entry)) {
        return { id: "B2", group: "B", severity: "fail", summary: t("doctor.b2.dead"), detail: entry };
      }
      return { id: "B2", group: "B", severity: "ok", summary: t("doctor.b2.ok"), detail: entry };
    },
  };

  const b3: DoctorCheckEntry = {
    id: "B3",
    group: "B",
    run: async () => {
      const { piPackageEngines, assertPiEngineSupported } = await import("../rpc/pi-rpc.js");
      // 生效入口与桥 doStart 同形:配置优先(存在才认),否则自动发现。
      let entry: string | undefined;
      if (configured && fs.existsSync(configured)) entry = configured;
      else if (!configured) {
        const { PiRpc } = await import("../rpc/pi-rpc.js");
        entry = await PiRpc.resolveCliPath();
      }
      if (!entry || !fs.existsSync(entry)) {
        return { id: "B3", group: "B", severity: "skip", summary: t("doctor.b3.noEntry") };
      }
      const pkg = piPackageEngines(entry);
      if (!pkg) {
        return { id: "B3", group: "B", severity: "ok", summary: t("doctor.b3.notPi"), detail: entry };
      }
      try {
        assertPiEngineSupported(entry);
      } catch (err) {
        return {
          id: "B3",
          group: "B",
          severity: "fail",
          summary: t("doctor.b3.gate", { version: pkg.version }),
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        id: "B3",
        group: "B",
        severity: "ok",
        summary: t("doctor.b3.ok"),
        detail: t("doctor.b3.detail", { version: pkg.version, engines: pkg.enginesNode ?? "-" }),
      };
    },
  };

  const b4: DoctorCheckEntry = {
    id: "B4",
    group: "B",
    run: async () => {
      const { minNodeVersionOf } = await import("../rpc/pi-rpc.js");
      const range = ownEnginesNode();
      const floor = range ? minNodeVersionOf(range) : undefined;
      const running = runningNodeTriple(process.version);
      if (!floor || !running) {
        // 底线或运行版本解析不了(engines 形态不认识/非 vX.Y.Z)→ 无法确认
        return {
          id: "B4",
          group: "B",
          severity: "skip",
          summary: t("doctor.b4.unparsable", { range: range ?? "-" }),
        };
      }
      if (!nodeSatisfiesEngine(running, floor)) {
        return {
          id: "B4",
          group: "B",
          severity: "fail",
          summary: t("doctor.b4.old", {
            running: `v${running.join(".")}`,
            required: `>=${floor.join(".")}`,
          }),
          nextStep: "nvm install 22 && nvm alias default 22",
        };
      }
      return {
        id: "B4",
        group: "B",
        severity: "ok",
        summary: t("doctor.b4.ok"),
        detail: t("doctor.b4.detail", {
          running: `v${running.join(".")}`,
          required: `>=${floor.join(".")}`,
        }),
      };
    },
  };

  return [b1, b2, b3, b4];
}

/**
 * B1 的安全幂等修复:删除失效 cliPath(备份先于删除;幂等 —— 目标不存在、
 * 路径已变有效或 cliPath 已被移除时 changed=false 不再动文件)。配置改写
 * 走 saveConfig(config.js 同源原子写),diff 基于两侧规范序列化。
 */
export async function staleCliPathFix(ctx: DoctorContext) {
  const configPath = ctx.deps.layout.configPath;
  if (!fs.existsSync(configPath)) {
    return undefined; // 配置不存在(对应检查项不可修复档,另有 ❌ 报告)
  }
  return {
    checkId: "B1",
    summary: t("doctor.fix.removeStaleCliPath"),
    run: async (): Promise<FixOutcome> => {
      // 幂等重入:文件/键消失、或路径已变有效 → 不动
      let current: string | undefined;
      try {
        current = fs.readFileSync(configPath, "utf-8");
      } catch {
        return { changed: false };
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(current) as Record<string, unknown>;
      } catch {
        throw new Error(t("doctor.fix.configUnparsable", { path: configPath }));
      }
      const target = parsed.cliPath;
      if (typeof target !== "string") return { changed: false };
      if (fs.existsSync(target)) return { changed: false }; // 竞态:路径复活了,保留
      // 备份先于删除(顺序敏感契约仅此一类;备份失败放弃修复)
      const backupNote = backupRequired(ctx.deps.layout);
      const before = JSON.stringify(parsed, null, 2);
      delete parsed.cliPath;
      const { saveConfig } = await import("../config.js");
      saveConfig(parsed as Parameters<typeof saveConfig>[0]);
      return {
        changed: true,
        notes: [backupNote],
        diff: diffLines(before, JSON.stringify(parsed, null, 2)),
      };
    },
  };
}
