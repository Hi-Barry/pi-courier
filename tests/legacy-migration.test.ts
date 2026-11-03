/**
 * 旧布局自动迁移(spec #258 票02 / issue #260):
 *  • 计划构建器:旧→新路径对的冻结映射表(探索笔记为唯一事实来源),纯函数;
 *  • 执行器:临时目录真实文件测试(幂等/原子 rename+EXDEV 回退/锁只删不迁/
 *    永不触碰 ~/.pi/agent),fs 全程真实,只注入刻意模拟的故障缝。
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLegacyMigrationPlan, runLegacyMigration } from "../src/legacy-migration.js";
import { setLocale, t } from "../src/i18n/index.js";
import { resolveLayout } from "../src/paths.js";

describe("buildLegacyMigrationPlan — 旧→新映射冻结表", () => {
  it("linux 缺省布局:逐项对齐探索笔记的映射表", () => {
    const home = "/home/u";
    const layout = resolveLayout({ platform: "linux", homedir: home, env: {} });
    const plan = buildLegacyMigrationPlan({ platform: "linux", homedir: home, layout });

    const byLabel = new Map(plan.items.map((item) => [item.label, item]));
    // 数据资产:去 pi-courier- 前缀落 dataDir。
    expect(byLabel.get("matrix-store")).toEqual({
      label: "matrix-store",
      kind: "file",
      from: "/home/u/.pi/pi-courier-matrix-store.json",
      to: "/home/u/.local/share/pi-courier/matrix-store.json",
    });
    expect(byLabel.get("matrix-crypto")).toMatchObject({
      kind: "directory",
      from: "/home/u/.pi/pi-courier-matrix-crypto",
      to: "/home/u/.local/share/pi-courier/matrix-crypto",
    });
    expect(byLabel.get("attachments")).toMatchObject({
      kind: "directory",
      from: "/home/u/.pi/pi-courier-attachments",
      to: "/home/u/.local/share/pi-courier/attachments",
    });
    // 旧状态目录叶子平移(整目录不整体搬:叶子名与目标根各自独立解析)。
    expect(byLabel.get("heartbeat")).toMatchObject({
      kind: "file",
      from: "/home/u/.pi/pi-courier-state/heartbeat.json",
      to: "/home/u/.local/state/pi-courier/heartbeat.json",
    });
    expect(byLabel.get("audit-log")).toMatchObject({
      from: "/home/u/.pi/pi-courier-state/audit.jsonl",
      to: "/home/u/.local/state/pi-courier/audit.jsonl",
    });
    expect(byLabel.get("event-ledger")).toMatchObject({
      from: "/home/u/.pi/pi-courier-state/event-ledger.jsonl",
      to: "/home/u/.local/state/pi-courier/event-ledger.jsonl",
    });
    expect(byLabel.get("queue-snapshots")).toMatchObject({
      from: "/home/u/.pi/pi-courier-state/queue-snapshots.json",
      to: "/home/u/.local/state/pi-courier/queue-snapshots.json",
    });
    expect(byLabel.get("watchdog-alert-stamp")).toMatchObject({
      from: "/home/u/.pi/pi-courier-state/watchdog-alert-stamp",
      to: "/home/u/.local/state/pi-courier/watchdog-alert-stamp",
    });
    // Linux 配置要迁:~/.pi/pi-courier.json → configDir(名字不变)。
    expect(byLabel.get("config")).toEqual({
      label: "config",
      kind: "file",
      from: "/home/u/.pi/pi-courier.json",
      to: "/home/u/.config/pi-courier/pi-courier.json",
    });
    expect(plan.items).toHaveLength(9);
    // 锁只删不迁:进计划的 legacyLockPath 字段,不在 items 里。
    expect(plan.legacyLockPath).toBe("/home/u/.pi/pi-courier.lock");
    expect(byLabel.has("lock")).toBe(false);
  });

  it("计划里绝不出现 ~/.pi/agent 与家目录根 run.log(守卫断言)", () => {
    const home = "/home/u";
    const layout = resolveLayout({ platform: "linux", homedir: home, env: {} });
    const plan = buildLegacyMigrationPlan({ platform: "linux", homedir: home, layout });
    const froms = plan.items.map((item) => item.from);
    const tos = plan.items.map((item) => item.to);
    if (plan.legacyLockPath) froms.push(plan.legacyLockPath);
    for (const p of [...froms, ...tos]) {
      expect(p.startsWith(path.join(home, "pi-courier-run.log"))).toBe(false);
      expect(p.startsWith(path.join(home, ".pi", "agent"))).toBe(false);
    }
  });

  it("win32:配置刻意不迁(Windows 布局 configDir 仍是 ~/.pi),其余照常", () => {
    const home = "C:\\Users\\u";
    const layout = resolveLayout({
      platform: "win32",
      homedir: home,
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
    });
    const plan = buildLegacyMigrationPlan({ platform: "win32", homedir: home, layout });
    const byLabel = new Map(plan.items.map((item) => [item.label, item]));
    expect(byLabel.has("config")).toBe(false);
    expect(byLabel.get("matrix-store")?.to).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\pi-courier\\matrix-store.json",
    );
    expect(plan.items).toHaveLength(8);
    expect(plan.legacyLockPath).toBe("C:\\Users\\u\\.pi\\pi-courier.lock");
  });

  it("darwin:配置迁(新 configDir=~/.config/pi-courier ≠ ~/.pi,不迁即失联)", () => {
    const home = "/Users/u";
    const layout = resolveLayout({ platform: "darwin", homedir: home, env: {} });
    const plan = buildLegacyMigrationPlan({ platform: "darwin", homedir: home, layout });
    const byLabel = new Map(plan.items.map((item) => [item.label, item]));
    expect(byLabel.get("config")).toEqual({
      label: "config",
      kind: "file",
      from: "/Users/u/.pi/pi-courier.json",
      to: "/Users/u/.config/pi-courier/pi-courier.json",
    });
  });
});

/** 真实文件测试的临时家目录(fs.realpath 消解 /tmp 别名,macOS 友好)。 */
let home: string;
let log: string[];
let warn: string[];

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-mig-")));
  log = [];
  warn = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function makeLinuxPlan() {
  const layout = resolveLayout({ platform: "linux", homedir: home, env: {} });
  const plan = buildLegacyMigrationPlan({ platform: "linux", homedir: home, layout });
  return { layout, plan };
}

/** 播一套完整的旧布局(含 pi CLI 的 agent 家与家目录根运行日志两件守卫物)。 */
function seedLegacyLayout(): void {
  const pi = path.join(home, ".pi");
  fs.mkdirSync(path.join(pi, "pi-courier-state"), { recursive: true });
  fs.mkdirSync(path.join(pi, "pi-courier-matrix-crypto", "profiles"), { recursive: true });
  fs.mkdirSync(path.join(pi, "pi-courier-attachments"), { recursive: true });
  fs.mkdirSync(path.join(pi, "agent", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(pi, "pi-courier-matrix-store.json"), '{"rooms":1}');
  fs.writeFileSync(path.join(pi, "pi-courier-matrix-crypto", "keys.json"), '{"k":1}');
  fs.writeFileSync(path.join(pi, "pi-courier-matrix-crypto", "profiles", "p1"), "p1-body");
  fs.writeFileSync(path.join(pi, "pi-courier-attachments", "a.png"), "png-bytes");
  const stateLeaves: Record<string, string> = {
    "heartbeat.json": '{"ts":1}',
    "audit.jsonl": "audit-line-1\n",
    "event-ledger.jsonl": "ledger-line-1\n",
    "queue-snapshots.json": "[]",
    "watchdog-alert-stamp": "stamp",
  };
  for (const [name, content] of Object.entries(stateLeaves)) {
    fs.writeFileSync(path.join(pi, "pi-courier-state", name), content);
  }
  fs.writeFileSync(path.join(pi, "pi-courier.json"), '{"language":"zh"}');
  // 守卫物:迁移永远不该碰的两处。
  fs.writeFileSync(path.join(pi, "agent", "sessions", "s1.jsonl"), "session-body");
  fs.writeFileSync(path.join(home, "pi-courier-run.log"), "still-being-written");
}

describe("runLegacyMigration — 首次迁移与幂等(临时目录真实文件)", () => {
  it("首次迁移:全量搬入新家、旧件消失、清单逐项日志、两件守卫物原封不动", () => {
    seedLegacyLayout();
    const { layout, plan } = makeLinuxPlan();
    const result = runLegacyMigration({
      plan,
      log: (m) => log.push(m),
      warn: (m) => warn.push(m),
    });

    expect(result.failed).toEqual([]);
    expect(result.moved.map((m) => m.item.label).sort()).toEqual(
      [
        "matrix-store",
        "matrix-crypto",
        "attachments",
        "heartbeat",
        "audit-log",
        "event-ledger",
        "queue-snapshots",
        "watchdog-alert-stamp",
        "config",
      ].sort(),
    );
    expect(result.moved.every((m) => m.via === "rename")).toBe(true);

    // 新家内容抽验(目录嵌套也要完整体)。
    expect(fs.readFileSync(layout.matrixStorePath, "utf-8")).toBe('{"rooms":1}');
    expect(fs.readFileSync(path.join(layout.matrixCryptoDir, "profiles", "p1"), "utf-8")).toBe("p1-body");
    expect(fs.readFileSync(path.join(layout.attachmentsDir, "a.png"), "utf-8")).toBe("png-bytes");
    expect(fs.readFileSync(layout.heartbeatPath, "utf-8")).toBe('{"ts":1}');
    expect(fs.readFileSync(layout.auditLogPath, "utf-8")).toBe("audit-line-1\n");
    expect(fs.readFileSync(layout.eventLedgerPath, "utf-8")).toBe("ledger-line-1\n");
    expect(fs.readFileSync(layout.queueSnapshotsPath, "utf-8")).toBe("[]");
    expect(fs.readFileSync(layout.watchdogAlertStampPath, "utf-8")).toBe("stamp");
    expect(fs.readFileSync(layout.configPath, "utf-8")).toBe('{"language":"zh"}');

    // 旧件消失:store 整文件走人;crypto/attachments 整目录 rename 走人;
    // state 是叶子平移,旧目录壳留在原地但已空(刻意不删旧目录壳,保守不
    // 扩大删除面 —— ~/.pi 里还有 pi CLI 的家)。
    expect(fs.existsSync(path.join(home, ".pi", "pi-courier-matrix-store.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".pi", "pi-courier-matrix-crypto"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".pi", "pi-courier-attachments"))).toBe(false);
    expect(fs.readdirSync(path.join(home, ".pi", "pi-courier-state"))).toEqual([]);

    // 守卫:pi CLI 的家、家目录根运行日志、.pi 本体全都原样。
    expect(fs.readFileSync(path.join(home, ".pi", "agent", "sessions", "s1.jsonl"), "utf-8")).toBe("session-body");
    expect(fs.readFileSync(path.join(home, "pi-courier-run.log"), "utf-8")).toBe("still-being-written");
    expect(fs.existsSync(path.join(home, ".pi"))).toBe(true);

    // 清单逐项日志:9 条搬移 + 1 条汇总;搬移行含「什么、从哪、到哪」。
    expect(log).toHaveLength(10);
    const movedLine = log.find((l) => l.includes("matrix-store"));
    expect(movedLine).toBeDefined();
    expect(movedLine).toContain(path.join(home, ".pi", "pi-courier-matrix-store.json"));
    expect(movedLine).toContain(layout.matrixStorePath);
    expect(warn).toEqual([]);
  });

  it("二次启动零操作:全 skipped、零日志零警告、新家内容不变", () => {
    seedLegacyLayout();
    const { layout, plan } = makeLinuxPlan();
    runLegacyMigration({ plan });

    const second = runLegacyMigration({
      plan,
      log: (m) => log.push(m),
      warn: (m) => warn.push(m),
    });
    expect(second.moved).toEqual([]);
    expect(second.bothExisted).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(second.skipped.map((s) => s.label).sort()).toEqual(
      [
        "matrix-store",
        "matrix-crypto",
        "attachments",
        "heartbeat",
        "audit-log",
        "event-ledger",
        "queue-snapshots",
        "watchdog-alert-stamp",
        "config",
      ].sort(),
    );
    // 幂等 = 真零操作:连清单日志都不出。
    expect(log).toEqual([]);
    expect(warn).toEqual([]);
    expect(fs.readFileSync(layout.configPath, "utf-8")).toBe('{"language":"zh"}');
  });

  it("新旧并存:信新家、旧文件原样保留、每项只警告一次(不搬也不删)", () => {
    seedLegacyLayout();
    const { layout, plan } = makeLinuxPlan();
    // 先手动把两件搬一半:新家已有 heartbeat 与 matrix-store(内容不同)。
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.mkdirSync(layout.dataDir, { recursive: true });
    fs.writeFileSync(layout.heartbeatPath, '{"ts":"NEW"}');
    fs.writeFileSync(layout.matrixStorePath, '{"rooms":"NEW"}');

    const result = runLegacyMigration({
      plan,
      log: (m) => log.push(m),
      warn: (m) => warn.push(m),
    });
    expect(result.bothExisted.map((i) => i.label).sort()).toEqual(["heartbeat", "matrix-store"]);
    expect(result.moved.map((m) => m.item.label)).not.toContain("heartbeat");
    // 信新家:新内容原封不动。
    expect(fs.readFileSync(layout.heartbeatPath, "utf-8")).toBe('{"ts":"NEW"}');
    expect(fs.readFileSync(layout.matrixStorePath, "utf-8")).toBe('{"rooms":"NEW"}');
    // 旧文件保留(用户核实前不销毁唯一备份)。
    expect(fs.readFileSync(path.join(home, ".pi", "pi-courier-state", "heartbeat.json"), "utf-8")).toBe('{"ts":1}');
    expect(fs.readFileSync(path.join(home, ".pi", "pi-courier-matrix-store.json"), "utf-8")).toBe('{"rooms":1}');
    // 每项恰好一条警告,含旧路径;其余 7 项正常搬移。
    expect(warn).toHaveLength(2);
    for (const line of warn) {
      expect(line).toContain(path.join(home, ".pi"));
    }
    expect(result.moved).toHaveLength(7);
  });

  it("EXDEV 跨卷:rename 报 EXDEV 回退 copy+delete,内容完整体落地,日志标注跨卷", () => {
    seedLegacyLayout();
    const { layout, plan } = makeLinuxPlan();
    const result = runLegacyMigration({
      plan,
      rename: () => {
        const err: NodeJS.ErrnoException = new Error("invalid cross-device link");
        err.code = "EXDEV";
        throw err;
      },
      log: (m) => log.push(m),
      warn: (m) => warn.push(m),
    });
    expect(result.failed).toEqual([]);
    // 全部 9 项都经 copy 通道完成。
    expect(result.moved).toHaveLength(9);
    expect(result.moved.every((m) => m.via === "copy")).toBe(true);
    // 内容完整体:嵌套目录也复制到位,旧件已清。
    expect(fs.readFileSync(path.join(layout.matrixCryptoDir, "profiles", "p1"), "utf-8")).toBe("p1-body");
    expect(fs.existsSync(path.join(home, ".pi", "pi-courier-matrix-crypto"))).toBe(false);
    expect(fs.readFileSync(layout.configPath, "utf-8")).toBe('{"language":"zh"}');
    // 日志标注跨卷回退。
    const crossLine = log.find((l) => l.includes("matrix-store"));
    expect(crossLine).toContain("matrix-store");
    expect(crossLine).toContain(layout.matrixStorePath);
    expect(log.join("\n")).toContain("跨卷");
  });

  it("copy 成功但清旧失败:算搬移完成、旧件保留、警告;下次启动按并存信新家", () => {
    seedLegacyLayout();
    const { layout, plan } = makeLinuxPlan();
    const first = runLegacyMigration({
      plan,
      rename: () => {
        const err: NodeJS.ErrnoException = new Error("invalid cross-device link");
        err.code = "EXDEV";
        throw err;
      },
      remove: () => {
        throw new Error("EBUSY fake: old file busy");
      },
      warn: (m) => warn.push(m),
    });
    // 复制成功即算完成:新家内容在,旧件也在,警告说明原委。
    expect(first.moved.map((m) => m.via)).toEqual(["copy", "copy", "copy", "copy", "copy", "copy", "copy", "copy", "copy"]);
    expect(fs.readFileSync(layout.matrixStorePath, "utf-8")).toBe('{"rooms":1}');
    expect(fs.readFileSync(path.join(home, ".pi", "pi-courier-matrix-store.json"), "utf-8")).toBe('{"rooms":1}');
    expect(warn.join("\n")).toContain("EBUSY fake");

    // 下次启动:新旧并存信新家,新内容不被旧件覆盖,零失败。
    warn.length = 0;
    const second = runLegacyMigration({ plan, warn: (m) => warn.push(m) });
    expect(second.failed).toEqual([]);
    expect(second.bothExisted.map((i) => i.label)).toContain("matrix-store");
    expect(fs.readFileSync(layout.matrixStorePath, "utf-8")).toBe('{"rooms":1}');
  });

  it("非 EXDEV 失败:单项隔离进 failed、旧件原地未动、不触发 copy 回退", () => {
    seedLegacyLayout();
    const { layout, plan } = makeLinuxPlan();
    let copyCalls = 0;
    const result = runLegacyMigration({
      plan,
      rename: (from, to) => {
        if (from.endsWith("pi-courier-matrix-store.json")) throw new Error("EACCES fake: denied");
        fs.renameSync(from, to); // 其余项委托真实 rename(注入缝是整体替换)
      },
      copy: (from, to) => {
        copyCalls += 1;
        fs.cpSync(from, to, { recursive: true });
      },
      warn: (m) => warn.push(m),
    });
    expect(result.failed.map((f) => f.item.label)).toEqual(["matrix-store"]);
    expect(result.failed[0].error).toContain("EACCES fake");
    expect(copyCalls).toBe(0); // 非 EXDEV 不走 copy 回退
    // 旧件原地未动,新家没有半成品。
    expect(fs.readFileSync(path.join(home, ".pi", "pi-courier-matrix-store.json"), "utf-8")).toBe('{"rooms":1}');
    expect(fs.existsSync(layout.matrixStorePath)).toBe(false);
    // 其余 8 项不受牵连。
    expect(result.moved).toHaveLength(8);
    expect(fs.readFileSync(layout.configPath, "utf-8")).toBe('{"language":"zh"}');
  });
});

describe("runLegacyMigration — 旧锁只删不迁(陈旧语义)", () => {
  let layout: ReturnType<typeof resolveLayout>;
  let plan: ReturnType<typeof buildLegacyMigrationPlan>;
  /** 活锁用的长驻子进程(测试结束回收)。 */
  let liveChild: ReturnType<typeof child_process.spawn> | undefined;

  beforeEach(() => {
    ({ layout, plan } = makeLinuxPlan());
    seedLegacyLayout();
  });

  afterEach(() => {
    liveChild?.kill();
    liveChild = undefined;
  });

  function seedLock(content: string): string {
    const lockPath = path.join(home, ".pi", "pi-courier.lock");
    fs.writeFileSync(lockPath, content);
    return lockPath;
  }

  it("持有进程已死(ESRCH):删锁,记日志,新锁留给后续流程在新位置重建", () => {
    // 真死进程:spawn 一个即退子进程,返回时已被收割,其 PID 必然 ESRCH。
    const dead = child_process.spawnSync(process.execPath, ["-e", ""]);
    expect(dead.status).toBe(0);
    const lockPath = seedLock(`${dead.pid}:some-owner`);
    const result = runLegacyMigration({ plan, log: (m) => log.push(m), warn: (m) => warn.push(m) });
    expect(result.lockRemoved).toBe(true);
    expect(result.lockKept).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    // 新锁不在这里建:stateDir 下没有锁文件(由后续正常流程重建)。
    expect(fs.existsSync(layout.lockPath)).toBe(false);
    expect(log.join("\n")).toContain(lockPath);
  });

  it("锁内容损坏(无有效持有声明):视同陈旧,删", () => {
    const lockPath = seedLock("garbage-without-colon");
    const result = runLegacyMigration({ plan });
    expect(result.lockRemoved).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("持有者是自己 PID:与 acquireLock 接管语义一致,删", () => {
    const lockPath = seedLock(`${process.pid}:self`);
    const result = runLegacyMigration({ plan });
    expect(result.lockRemoved).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("活锁(真实存活进程持有):绝不偷,保留并警告", () => {
    liveChild = child_process.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const lockPath = seedLock(`${liveChild.pid}:another-instance`);
    const result = runLegacyMigration({ plan, warn: (m) => warn.push(m) });
    expect(result.lockKept).toBe(true);
    expect(result.lockRemoved).toBe(false);
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(`${liveChild.pid}:another-instance`);
    expect(warn.join("\n")).toContain(lockPath);
  });

  it("isLockStale 注入缝生效:true 删 / false 留(组合根可换判断策略)", () => {
    const lockPath = seedLock("999999:x");
    const kept = runLegacyMigration({ plan, isLockStale: () => false });
    expect(kept.lockKept).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    const removed = runLegacyMigration({ plan, isLockStale: () => true });
    expect(removed.lockRemoved).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("删锁失败:警告不抛,启动不受阻", () => {
    seedLock(`${process.pid}:self`);
    const result = runLegacyMigration({
      plan,
      remove: (target) => {
        if (target.endsWith("pi-courier.lock")) throw new Error("EACCES fake: rm denied");
        fs.rmSync(target, { recursive: true });
      },
      warn: (m) => warn.push(m),
    });
    expect(result.lockRemoved).toBe(false);
    expect(warn.join("\n")).toContain("EACCES fake");
  });
});

describe("迁移文案 — i18n 中英双表(zh 为键集基准)", () => {
  it("两张表都能渲染同一组迁移清单参数(插值不缺位)", () => {
    const params = { label: "matrix-store", from: "/old", to: "/new" };
    setLocale("zh");
    const zhLine = t("migration.moved", params);
    expect(zhLine).toContain("matrix-store");
    expect(zhLine).toContain("/old");
    expect(zhLine).toContain("/new");
    setLocale("en");
    const enLine = t("migration.moved", params);
    expect(enLine).toContain("matrix-store");
    expect(enLine).toContain("/old");
    expect(enLine).toContain("/new");
    expect(enLine).not.toBe(zhLine); // 两表各自成文,不是同一串
    setLocale("zh"); // tests/setup.ts 的全局锚是 zh,用完还原
    const summary = t("migration.summary", { moved: 9, skipped: 0, conflicts: 1, failed: 2 });
    expect(summary).toContain("9");
    expect(summary).toContain("2");
  });
});
