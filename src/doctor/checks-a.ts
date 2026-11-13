/**
 * doctor A 组检查:安装完整性(spec #337 票 #341)。
 *
 *  - A1:关键运行时文件存在(dist 入口、package.json、scripts、deploy 模板);
 *  - A2:peer 包可解析(@earendil-works/pi-ai、@earendil-works/pi-coding-agent
 *       >=0.83)—— createRequire 从包根解析(npm 11 浅层/提升布局通吃,
 *       与 nativeBindingExists 同一解析思路);
 *  - A3:readBridgeVersion 可读到非空版本且等于包根 package.json 的 version
 *       (dist 缺失/错位即半更新,该项 ❌);
 *  - A4:crypto 原生库存在(nativeBindingExists 同源)。
 *
 * 包根参数化:installChecksForRoot(root, versionReadout) 是纯函数参数化
 * (先例 checks-b 的 nodeSatisfiesEngine),不是新测试缝 —— 唯一新测试缝仍是
 * DoctorDeps。❌ 分档(缺文件/半更新/peer 缺失/binding 缺失)需要临时包根才
 * 能在测试落地;检查入口(root 由 import.meta.url 推导,与 version.ts 同构)。
 * 文件完整性深度按 spec Q9:关键路径清单 + 版本一致 + native binding,
 * 不做哈希清单。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "../i18n/index.js";
import { nodeSatisfiesEngine, parseVersionTriple } from "./checks-b.js";
import type { CheckResult, DoctorCheckEntry, DoctorContext } from "./types.js";

/** 包根(本模块编译位置上两级:src/doctor/ → 仓库根;dist/doctor/ → 仓库根)。 */
export function packageRootOf(): string {
  return fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
}

/** 包根 package.json 的 version(读不到/坏 → undefined)。 */
function packageVersionOf(root: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
      version?: string;
    };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** A3 纯决策:readBridgeVersion 读数 vs 包根 package.json version。
 *  unavailable=true 表示 version helper 加载失败(⏭️ 无法确认),区别于
 *  读到了空/错位(❌ 半更新)。 */
export function versionConsistency(
  readout: string | undefined,
  pkgVersion: string | undefined,
  unavailable = false,
): CheckResult {
  const id = "A3";
  if (unavailable) {
    return { id, group: "A", severity: "skip", summary: t("doctor.degraded", { reason: t("doctor.a3.helperDown") }) };
  }
  if (!readout || !pkgVersion) {
    // dist 错位/包根 package.json 缺失(半更新特征):无法确认自身版本
    return {
      id,
      group: "A",
      severity: "fail",
      summary: t("doctor.a3.missing"),
      nextStep: "pi-courier update",
    };
  }
  if (readout !== pkgVersion) {
    return {
      id,
      group: "A",
      severity: "fail",
      summary: t("doctor.a3.mismatch", { readout, pkgVersion }),
      nextStep: "pi-courier update",
    };
  }
  return { id, group: "A", severity: "ok", summary: t("doctor.a3.ok"), detail: readout };
}

/** A 组核心(fs + createRequire,包根参数化;A4 的 binding 检查由调用方注入)。 */
export async function installChecksForRoot(
  root: string,
  versionReadout: string | undefined,
  nativeBindingExistsImpl?: (packageRoot: string) => boolean,
  versionUnavailable = false,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // A1:关键运行时文件
  let mainEntry = "dist/standalone.js";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
      main?: string;
    };
    if (typeof pkg.main === "string" && pkg.main !== "") mainEntry = pkg.main;
  } catch {
    // package.json 读不到 → 本身就是缺失项
  }
  const required: Array<{ rel: string; kind: "file" | "dir" }> = [
    { rel: mainEntry, kind: "file" },
    { rel: "package.json", kind: "file" },
    { rel: "scripts", kind: "dir" },
    { rel: "deploy", kind: "dir" },
  ];
  const missing: string[] = [];
  for (const { rel, kind } of required) {
    const full = path.join(root, ...rel.split("/"));
    const exists =
      kind === "file"
        ? fs.existsSync(full) && fs.statSync(full).isFile()
        : fs.existsSync(full) && fs.statSync(full).isDirectory();
    if (!exists) missing.push(rel);
  }
  results.push(
    missing.length === 0
      ? { id: "A1", group: "A", severity: "ok", summary: t("doctor.a1.ok") }
      : {
          id: "A1",
          group: "A",
          severity: "fail",
          summary: t("doctor.a1.missing", { count: missing.length }),
          detail: missing.join("\n"),
          nextStep: "pi-courier update",
        },
  );

  // A2:peer 包可解析(@earendil-works/pi-ai、pi-coding-agent >=0.83)。
  // peer 是 ESM-only(exports 只给 import 条件),createRequire 解析不了 ——
  // 真实包根走 import.meta.resolve(从本模块解析,npm 11 浅层与提升布局通吃,
  // pi-rpc 同款);参数化根(测试临时树)退化为直接 node_modules 路径检查。
  const peerProblems: string[] = [];
  let peerVersion: string | undefined;
  const isRealRoot = root === packageRootOf();
  /** 从包根解析一个 peer 的 package.json 所在目录;解析不到返回 undefined。
   *  真实包根走 import.meta.resolve(ESM-only peer,createRequire 解析不了)
   *  并从解析出的入口上溯 package.json(piPackageEngines 同款走法);参数化根
   *  (测试临时树)退化为直接 node_modules 路径检查(npm 11 浅层布局)。 */
  const resolvePeerDir = (name: string): string | undefined => {
    const readPkgName = (dir: string): string | undefined => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as {
          name?: string;
        };
        return pkg.name;
      } catch {
        return undefined;
      }
    };
    if (isRealRoot) {
      try {
        const entry = fileURLToPath((import.meta as { resolve(id: string): string }).resolve(name));
        let dir = path.dirname(entry);
        for (let depth = 0; depth < 6; depth++) {
          if (readPkgName(dir) === name) return dir;
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        return undefined;
      } catch {
        return undefined;
      }
    }
    const direct = path.join(root, "node_modules", ...name.split("/"));
    return readPkgName(direct) === name ? direct : undefined;
  };
  try {
    const piAi = resolvePeerDir("@earendil-works/pi-ai");
    if (!piAi) peerProblems.push("@earendil-works/pi-ai");
    const agentDir = resolvePeerDir("@earendil-works/pi-coding-agent");
    if (!agentDir) {
      peerProblems.push("@earendil-works/pi-coding-agent");
    } else {
      try {
        const agentPkg = JSON.parse(fs.readFileSync(path.join(agentDir, "package.json"), "utf-8")) as {
          version?: string;
        };
        peerVersion = typeof agentPkg.version === "string" ? agentPkg.version : undefined;
        const triple = peerVersion ? parseVersionTriple(peerVersion) : undefined;
        // engines 语义(spec):>=0.83;0.83.0 → [0,83,0] 即达线
        if (!triple || !nodeSatisfiesEngine(triple, [0, 83, 0])) {
          peerProblems.push(`@earendil-works/pi-coding-agent ${peerVersion ?? "?"} (<0.83)`);
        }
      } catch {
        peerProblems.push("@earendil-works/pi-coding-agent");
      }
    }
  } catch {
    peerProblems.push(t("doctor.a2.rootUnresolvable", { root }));
  }
  results.push(
    peerProblems.length === 0
      ? {
          id: "A2",
          group: "A",
          severity: "ok",
          summary: t("doctor.a2.ok"),
          detail: t("doctor.a2.detail", { version: peerVersion ?? "?" }),
        }
      : {
          id: "A2",
          group: "A",
          severity: "fail",
          summary: t("doctor.a2.missing", { count: peerProblems.length }),
          detail: peerProblems.join("\n"),
          nextStep: "npm install -g pi-courier",
        },
  );

  // A3:版本一致(readBridgeVersion 读数 vs 包根 package.json)
  results.push(versionConsistency(versionReadout, packageVersionOf(root), versionUnavailable));

  // A4:crypto 原生库(nativeBindingExists 同源;实现经参数注入或动态 import)
  let binding: boolean | undefined;
  if (nativeBindingExistsImpl) {
    binding = nativeBindingExistsImpl(root);
  } else {
    try {
      const { nativeBindingExists } = await import("../npm-runtime.js");
      binding = nativeBindingExists(root);
    } catch {
      binding = undefined; // helper 崩 → ⏭️
    }
  }
  results.push(
    binding === undefined
      ? { id: "A4", group: "A", severity: "skip", summary: t("doctor.a4.skip") }
      : binding
        ? { id: "A4", group: "A", severity: "ok", summary: t("doctor.a4.ok") }
        : {
            id: "A4",
            group: "A",
            severity: "fail",
            summary: t("doctor.a4.missing"),
            nextStep: "npm install -g pi-courier",
          },
  );

  return results;
}

/** A 组检查项(包根 = 运行中的 pi-courier 安装)。version helper 崩溃与
 *  npm-runtime 崩溃各自折成 A3/A4 的 ⏭️,A1/A2(fs + createRequire)照查。 */
export function checkGroupA(_ctx: DoctorContext): DoctorCheckEntry[] {
  return [
    {
      id: "A1",
      group: "A",
      run: async () => {
        const root = packageRootOf();
        let readout: string | undefined;
        let unavailable = false;
        try {
          const { readBridgeVersion } = await import("../version.js");
          readout = readBridgeVersion?.() ?? undefined;
        } catch {
          unavailable = true; // helper 加载失败 → A3 ⏭️(不是半更新 ❌)
        }
        return installChecksForRoot(root, readout, undefined, unavailable);
      },
    },
  ];
}
