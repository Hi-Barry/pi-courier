/**
 * 旧布局自动迁移(spec #258 票02 / issue #260)。
 *
 * 为什么独立成模块:旧布局(≤1.3.0,实际存量即 1.3.0)把数据/状态全堆在
 * ~/.pi 下(带 pi-courier-前缀的叶子),票01 的三根分离布局
 * (dataDir/stateDir/configDir)要求存量用户首次升级时无感搬迁。迁移发生在
 * 「进程启动早期、拿单实例锁之前」(票03 组合根接线;评审修复后 standalone
 * 与 cli 两个组合根都接线)。
 *
 * 映射表(探索笔记为唯一事实来源,buildLegacyMigrationPlan 按平台生成):
 *  - ~/.pi/pi-courier-matrix-store.json → <dataDir>/matrix-store.json
 *  - ~/.pi/pi-courier-matrix-crypto/    → <dataDir>/matrix-crypto/
 *  - ~/.pi/pi-courier-attachments/      → <dataDir>/attachments/
 *  - ~/.pi/pi-courier-state/ 的五个叶子  → <stateDir>/ 平移
 *  - ~/.pi/pi-courier.json              → <configDir>/pi-courier.json(仅非
 *    Windows;Windows 新 configDir 仍是 ~/.pi,不动。darwin 新 configDir 是
 *    ~/.config/pi-courier ≠ ~/.pi,不迁配置即失联,故随 linux 同迁)
 *  - ~/.pi/pi-courier.lock              → 只删不迁(legacyLockPath;新锁在
 *    stateDir 按需重建,见 runLegacyMigration 的陈旧判断)
 *
 * 刻意不迁(映射表里根本没有,执行器也永不删除 ~/.pi 本身):
 *  - ~/.pi/agent/** —— pi CLI 自己的家,与本项目无关;
 *  - ~/pi-courier-run.log(家目录根)—— 运行中的任务还在写它,票07 重注册
 *    systemd 单元后才断;现在搬会撕裂正在写的日志。
 *
 * 执行语义(每项独立,互不牵连):
 *  1. 旧不存在 → 跳过零操作(幂等:二次启动全走这条,日志都不出);
 *  2. 新旧并存 → 信新家,旧文件原样保留,警告一次(不删旧件:用户尚未核实
 *     新家数据完整前删旧等于销毁唯一备份);
 *  3. 否则先建新家父目录(mkdir -p,0700,与 config.ts 同做法)再 rename
 *     (同卷原子);rename 报 EXDEV(跨设备)回退 copy —— 但先复制到与目标
 *     同目录的临时件、成功后再 rename 落位(cpSync 中途失败会留部分写入
 *     残件,若直接落在 to 上,下次启动 exists(to) 误判为「新旧并存信新家」,
 *     残件被信任而完整旧件被冷落,失败从此不可重试;sec-exdev-copy-atomic);
 *  4. 单项失败只警告并上报 failed,绝不抛 —— 迁移不许卡死启动,且失败项的
 *     旧文件原地未动、新家不留残件(EXDEV 回退经临时件,见上),数据无损,
 *     下次启动自然重试。
 *
 * 注入缝(与 resilience 系同款模式,组合根零缝直接用默认实现,测试传
 * fake/真实临时目录):移动操作 rename/copy/remove、存在判断 exists、目录
 * 创建 mkdir、锁陈旧判断 isLockStale、清单日志 log/warn。
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "./errors.js";
import { t } from "./i18n/index.js";
import { lockIsStale } from "./lock.js";
import { logger } from "./logger.js";
import type { Layout } from "./paths.js";

/** 一条旧→新迁移对(kind 只影响日志可读性;文件与目录走同一 rename/copy 路径)。 */
export interface MigrationItem {
  /** 短名(日志/清单辨识用,如 "matrix-store";非路径)。 */
  label: string;
  /** 旧路径(文件或目录;不存在则本项整体跳过)。 */
  from: string;
  /** 新路径(新家下的目标位置)。 */
  to: string;
  kind: "file" | "directory";
}

/** 旧→新迁移计划:路径对 + 旧锁(只删不迁,故独立于 items)。 */
export interface LegacyMigrationPlan {
  items: MigrationItem[];
  /** 旧单实例锁路径(如 ~/.pi/pi-courier.lock);null = 本平台无此遗留。 */
  legacyLockPath: string | null;
}

/** 计划构建输入:homedir 定旧布局,layout(票01 产物)定新家。 */
export interface LegacyMigrationPlanInput {
  platform: NodeJS.Platform;
  homedir: string;
  layout: Layout;
}

/** 旧状态目录下的五个叶子(名字不变,只换根;探索笔记冻结)。 */
const LEGACY_STATE_LEAVES: ReadonlyArray<{
  label: string;
  leaf: string;
  pick: (layout: Layout) => string;
}> = [
  { label: "heartbeat", leaf: "heartbeat.json", pick: (l) => l.heartbeatPath },
  { label: "audit-log", leaf: "audit.jsonl", pick: (l) => l.auditLogPath },
  { label: "event-ledger", leaf: "event-ledger.jsonl", pick: (l) => l.eventLedgerPath },
  { label: "queue-snapshots", leaf: "queue-snapshots.json", pick: (l) => l.queueSnapshotsPath },
  { label: "watchdog-alert-stamp", leaf: "watchdog-alert-stamp", pick: (l) => l.watchdogAlertStampPath },
];

/**
 * 按平台与票01 解析出的新布局生成旧→新映射。纯函数:不碰文件系统,旧路径
 * 只从注入的 homedir 派生 —— 测试不读真实 HOME。
 */
export function buildLegacyMigrationPlan(input: LegacyMigrationPlanInput): LegacyMigrationPlan {
  const { platform, homedir, layout } = input;
  // 分隔符跟随平台(与 paths.ts 同款):linux 上也能生成正确的 win32 计划。
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const legacyPiDir = join(homedir, ".pi");
  const legacyStateDir = join(legacyPiDir, "pi-courier-state");

  const items: MigrationItem[] = [
    {
      label: "matrix-store",
      kind: "file",
      from: join(legacyPiDir, "pi-courier-matrix-store.json"),
      to: layout.matrixStorePath,
    },
    {
      label: "matrix-crypto",
      kind: "directory",
      from: join(legacyPiDir, "pi-courier-matrix-crypto"),
      to: layout.matrixCryptoDir,
    },
    {
      label: "attachments",
      kind: "directory",
      from: join(legacyPiDir, "pi-courier-attachments"),
      to: layout.attachmentsDir,
    },
    ...LEGACY_STATE_LEAVES.map((leafDef) => ({
      label: leafDef.label,
      kind: "file" as const,
      from: join(legacyStateDir, leafDef.leaf),
      to: leafDef.pick(layout),
    })),
  ];
  // Windows 刻意不迁配置:win32 布局的 configDir 仍是 ~/.pi(票01 冻结),
  // 配置原地不动即正确;非 Windows 的新 configDir ≠ ~/.pi,不迁即失联。
  if (platform !== "win32") {
    items.push({
      label: "config",
      kind: "file",
      from: join(legacyPiDir, "pi-courier.json"),
      to: layout.configPath,
    });
  }
  return { items, legacyLockPath: join(legacyPiDir, "pi-courier.lock") };
}

/** 单项执行结果:via 记录走的是原子 rename 还是跨卷 copy 回退(排查用)。 */
export interface MovedEntry {
  item: MigrationItem;
  via: "rename" | "copy";
}

/** 迁移报告:四个桶互斥,组合根与测试据此断言;本模块只上报不决策。 */
export interface LegacyMigrationResult {
  /** 成功搬移的项(rename 或 copy 回退完成)。 */
  moved: MovedEntry[];
  /** 旧路径不存在的项(幂等跳过,零操作)。 */
  skipped: MigrationItem[];
  /** 新旧并存的项(信新家,旧文件保留,已警告)。 */
  bothExisted: MigrationItem[];
  /** 执行失败的项(旧文件原地未动,数据无损;下次启动重试)。 */
  failed: Array<{ item: MigrationItem; error: string }>;
  /** 旧锁已删(仅陈旧时)。 */
  lockRemoved: boolean;
  /** 旧锁仍有进程持有,保留未动。 */
  lockKept: boolean;
}

export interface LegacyMigrationDeps {
  /** 待执行的迁移计划(buildLegacyMigrationPlan 产出;测试可手写路径对)。 */
  plan: LegacyMigrationPlan;
  /**
   * 移动缝:默认 fs.renameSync(同卷原子);测试注入抛 EXDEV 的 fake。EXDEV
   * 回退的落位(copy→临时件后 rename 到最终目标)也复用本缝;落位是同目录
   * rename,真实世界不会有 EXDEV,fake 注入时应放行临时件路径。
   */
  rename?: (from: string, to: string) => void;
  /**
   * 跨卷回退的复制缝:默认 fs.cpSync 递归(文件与目录通吃)。调用时 to 是与
   * 最终目标同目录的临时件路径(执行器复制成功后再 rename 落位),实现方只
   * 需如实复制,不直接触碰最终目标。
   */
  copy?: (from: string, to: string) => void;
  /** 删除缝(copy 成功后清旧件、删陈旧旧锁):默认 fs.rmSync 递归。 */
  remove?: (target: string) => void;
  /** 存在判断缝:默认 fs.existsSync。 */
  exists?: (target: string) => boolean;
  /** 新家目录创建缝:默认 mkdir -p + 0700(config.ts 同做法)。 */
  mkdir?: (dir: string) => void;
  /**
   * 旧锁陈旧判断缝:返回 true 才允许删。默认 = lock.ts 的 lockIsStale(接管
   * 判断同源单点,评审修复:此前的同语义复制品已删):内容损坏(无有效持有
   * 声明)、持有者是自己 PID、持有进程确死(ESRCH)三者之一 → 陈旧;活着或
   * 探测不了(EPERM 等)→ 保留,绝不偷活锁。
   */
  isLockStale?: (lockPath: string) => boolean;
  /** 清单日志缝(逐项搬移与汇总):默认 logger.info。 */
  log?: (message: string) => void;
  /** 警告缝(新旧并存/单项失败/活锁保留):默认 logger.warn。 */
  warn?: (message: string) => void;
}

/**
 * 执行迁移计划:逐项搬移 + 旧锁清理,输出迁移清单日志。逐项独立、失败不抛
 * (返回 failed 上报),迁移不许卡死启动 —— 详见模块头注释的执行语义。
 */
export function runLegacyMigration(deps: LegacyMigrationDeps): LegacyMigrationResult {
  const exists = deps.exists ?? ((target: string) => fs.existsSync(target));
  const rename = deps.rename ?? ((from: string, to: string) => fs.renameSync(from, to));
  const copy = deps.copy ?? ((from: string, to: string) => fs.cpSync(from, to, { recursive: true }));
  const remove = deps.remove ?? ((target: string) => fs.rmSync(target, { recursive: true }));
  const mkdir =
    deps.mkdir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }));
  const isLockStale = deps.isLockStale ?? lockIsStale;
  const log = deps.log ?? ((message: string) => logger.info(message));
  const warn = deps.warn ?? ((message: string) => logger.warn(message));

  const result: LegacyMigrationResult = {
    moved: [],
    skipped: [],
    bothExisted: [],
    failed: [],
    lockRemoved: false,
    lockKept: false,
  };

  for (const item of deps.plan.items) {
    // 1. 旧的不在 → 跳过零操作(幂等主通道:二次启动全走这条,零日志)。
    if (!exists(item.from)) {
      result.skipped.push(item);
      continue;
    }
    // 2. 新旧并存 → 信新家,旧件保留只警告(删旧 = 销毁用户唯一备份)。
    if (exists(item.to)) {
      warn(t("migration.bothExist", { label: item.label, from: item.from }));
      result.bothExisted.push(item);
      continue;
    }
    // 3. 先建新家父目录再搬:rename 同卷原子;EXDEV(跨设备)回退 copy——先
    //    复制到与目标同目录的临时件,成功后再 rename 落位。cpSync 中途失败会
    //    在目的地留部分写入残件,若直接落在 item.to,下次启动 exists(to) 误判
    //    为「新旧并存信新家」,残件被信任而完整旧件被冷落,失败从此不可重试
    //    (sec-exdev-copy-atomic)。临时件与 to 同目录,落位 rename 同卷,绝不
    //    会再 EXDEV。
    try {
      mkdir(path.dirname(item.to));
      try {
        rename(item.from, item.to);
        result.moved.push({ item, via: "rename" });
        log(t("migration.moved", { label: item.label, from: item.from, to: item.to }));
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
        const tmpTo = `${item.to}.legacy-migration-tmp-${randomUUID()}`;
        try {
          copy(item.from, tmpTo);
          rename(tmpTo, item.to);
        } catch (fallbackErr) {
          // 尽力清掉临时残件:清不掉只是垃圾,不改变「to 从未落位、下次启动
          // 可干净重试」的主结论,故清理失败只追加警告,原错误照常上报 failed。
          if (exists(tmpTo)) {
            try {
              remove(tmpTo);
            } catch (cleanupErr) {
              warn(
                t("migration.tmpCleanupFailed", {
                  label: item.label,
                  tmp: tmpTo,
                  message: errorMessage(cleanupErr),
                }),
              );
            }
          }
          throw fallbackErr;
        }
        // 复制+落位成功即算搬移完成;清旧件失败不回滚(回滚反而丢已落位的
        // 新件),旧件留下,下次启动按「新旧并存信新家」自然收敛。
        try {
          remove(item.from);
        } catch (cleanupErr) {
          warn(
            t("migration.oldCleanupFailed", {
              label: item.label,
              from: item.from,
              to: item.to,
              message: errorMessage(cleanupErr),
            }),
          );
          result.moved.push({ item, via: "copy" });
          continue;
        }
        result.moved.push({ item, via: "copy" });
        log(t("migration.movedCrossVolume", { label: item.label, from: item.from, to: item.to }));
      }
    } catch (err) {
      // 4. 单项失败只警告上报:旧件原地未动,数据无损,下次启动重试。
      const message = errorMessage(err);
      warn(t("migration.itemFailed", { label: item.label, from: item.from, to: item.to, message }));
      result.failed.push({ item, error: message });
    }
  }

  // 旧锁只删不迁:新锁由后续正常流程在新位置按需重建;活锁保留并警告。
  const lockPath = deps.plan.legacyLockPath;
  if (lockPath && exists(lockPath)) {
    if (isLockStale(lockPath)) {
      try {
        remove(lockPath);
        result.lockRemoved = true;
        log(t("migration.lockRemoved", { path: lockPath }));
      } catch (err) {
        warn(t("migration.lockRemoveFailed", { path: lockPath, message: errorMessage(err) }));
      }
    } else {
      result.lockKept = true;
      warn(t("migration.lockKeptLive", { path: lockPath }));
    }
  }

  // 汇总只在「真发生了事」时输出:纯跳过的幂等启动保持零日志。
  const hadActivity =
    result.moved.length > 0 ||
    result.bothExisted.length > 0 ||
    result.failed.length > 0 ||
    result.lockRemoved ||
    result.lockKept;
  if (hadActivity) {
    log(
      t("migration.summary", {
        moved: result.moved.length,
        skipped: result.skipped.length,
        conflicts: result.bothExisted.length,
        failed: result.failed.length,
      }),
    );
  }
  return result;
}
