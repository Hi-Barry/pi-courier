/**
 * 布局解析纯函数直测(spec #258 票01 / issue #259):平台矩阵下 configDir /
 * dataDir / stateDir 与派生路径的冻结表。输入全注入(platform/homedir/env),
 * 全程不读真实 HOME 与真实环境变量。
 */
import { describe, expect, it } from "vitest";
import { resolveLayout } from "../src/paths.js";

describe("resolveLayout (linux)", () => {
  it("缺省时落到 XDG 三件套", () => {
    const layout = resolveLayout({ platform: "linux", homedir: "/home/u", env: {} });
    expect(layout.configDir).toBe("/home/u/.config/pi-courier");
    expect(layout.dataDir).toBe("/home/u/.local/share/pi-courier");
    expect(layout.stateDir).toBe("/home/u/.local/state/pi-courier");
  });

  it("三个 XDG 变量各自生效、互不牵连", () => {
    const config = resolveLayout({
      platform: "linux",
      homedir: "/home/u",
      env: { XDG_CONFIG_HOME: "/xdg/config" },
    });
    expect(config.configDir).toBe("/xdg/config/pi-courier");
    expect(config.dataDir).toBe("/home/u/.local/share/pi-courier");
    expect(config.stateDir).toBe("/home/u/.local/state/pi-courier");

    const data = resolveLayout({
      platform: "linux",
      homedir: "/home/u",
      env: { XDG_DATA_HOME: "/xdg/data" },
    });
    expect(data.configDir).toBe("/home/u/.config/pi-courier");
    expect(data.dataDir).toBe("/xdg/data/pi-courier");

    const state = resolveLayout({
      platform: "linux",
      homedir: "/home/u",
      env: { XDG_STATE_HOME: "/xdg/state" },
    });
    expect(state.stateDir).toBe("/xdg/state/pi-courier");
    expect(state.configDir).toBe("/home/u/.config/pi-courier");
    expect(state.dataDir).toBe("/home/u/.local/share/pi-courier");
  });

  it("XDG 变量为空串按缺省处理(XDG base-dir 规范语义)", () => {
    const layout = resolveLayout({
      platform: "linux",
      homedir: "/home/u",
      env: { XDG_CONFIG_HOME: "", XDG_DATA_HOME: "", XDG_STATE_HOME: "" },
    });
    expect(layout.configDir).toBe("/home/u/.config/pi-courier");
    expect(layout.dataDir).toBe("/home/u/.local/share/pi-courier");
    expect(layout.stateDir).toBe("/home/u/.local/state/pi-courier");
  });
});

describe("resolveLayout (win32)", () => {
  it("config 落 ~/.pi,data 落 %APPDATA%\\pi-courier,state 是 data 下的 state", () => {
    const layout = resolveLayout({
      platform: "win32",
      homedir: "C:\\Users\\u",
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
    });
    expect(layout.configDir).toBe("C:\\Users\\u\\.pi");
    expect(layout.dataDir).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier");
    expect(layout.stateDir).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state");
  });

  it("APPDATA 缺失或空串时回退 ~/AppData/Roaming/pi-courier", () => {
    const missing = resolveLayout({ platform: "win32", homedir: "C:\\Users\\u", env: {} });
    expect(missing.dataDir).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier");
    expect(missing.stateDir).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state");

    const empty = resolveLayout({
      platform: "win32",
      homedir: "C:\\Users\\u",
      env: { APPDATA: "" },
    });
    expect(empty.dataDir).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier");
  });

  it("win32 分支不吃 XDG 变量(平台分支互不渗透)", () => {
    const layout = resolveLayout({
      platform: "win32",
      homedir: "C:\\Users\\u",
      env: {
        APPDATA: "C:\\Users\\u\\AppData\\Roaming",
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_DATA_HOME: "/xdg/data",
        XDG_STATE_HOME: "/xdg/state",
      },
    });
    expect(layout.configDir).toBe("C:\\Users\\u\\.pi");
    expect(layout.dataDir).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier");
  });
});

describe("resolveLayout (darwin)", () => {
  it("data 落 Application Support,config 沿 ~/.config 惯例,state 是 data 下的 state", () => {
    const layout = resolveLayout({ platform: "darwin", homedir: "/Users/u", env: {} });
    expect(layout.dataDir).toBe("/Users/u/Library/Application Support/pi-courier");
    expect(layout.configDir).toBe("/Users/u/.config/pi-courier");
    expect(layout.stateDir).toBe("/Users/u/Library/Application Support/pi-courier/state");
  });

  it("darwin 分支不吃 XDG 变量(平台分支互不渗透)", () => {
    const layout = resolveLayout({
      platform: "darwin",
      homedir: "/Users/u",
      env: { XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data", XDG_STATE_HOME: "/xdg/state" },
    });
    expect(layout.dataDir).toBe("/Users/u/Library/Application Support/pi-courier");
    expect(layout.configDir).toBe("/Users/u/.config/pi-courier");
    expect(layout.stateDir).toBe("/Users/u/Library/Application Support/pi-courier/state");
  });
});

describe("resolveLayout — 派生路径(冻结表叶子)", () => {
  it("linux 缺省布局下的全量派生表", () => {
    const layout = resolveLayout({ platform: "linux", homedir: "/home/u", env: {} });
    expect(layout.configPath).toBe("/home/u/.config/pi-courier/pi-courier.json");
    // RPC 会话目录刻意留在 configDir(原样不动,票03 也不换线)。
    expect(layout.agentSessionsDir).toBe("/home/u/.config/pi-courier/agent/sessions");
    expect(layout.matrixStorePath).toBe("/home/u/.local/share/pi-courier/matrix-store.json");
    expect(layout.matrixCryptoDir).toBe("/home/u/.local/share/pi-courier/matrix-crypto");
    expect(layout.attachmentsDir).toBe("/home/u/.local/share/pi-courier/attachments");
    expect(layout.lockPath).toBe("/home/u/.local/state/pi-courier/pi-courier.lock");
    expect(layout.heartbeatPath).toBe("/home/u/.local/state/pi-courier/heartbeat.json");
    expect(layout.auditLogPath).toBe("/home/u/.local/state/pi-courier/audit.jsonl");
    expect(layout.eventLedgerPath).toBe("/home/u/.local/state/pi-courier/event-ledger.jsonl");
    expect(layout.queueSnapshotsPath).toBe("/home/u/.local/state/pi-courier/queue-snapshots.json");
    expect(layout.watchdogAlertStampPath).toBe(
      "/home/u/.local/state/pi-courier/watchdog-alert-stamp",
    );
    expect(layout.stateLogsDir).toBe("/home/u/.local/state/pi-courier/logs");
    expect(layout.runLogPath).toBe("/home/u/.local/state/pi-courier/logs/run.log");
  });

  it("win32 布局下的全量派生表(分隔符与根随平台)", () => {
    const layout = resolveLayout({
      platform: "win32",
      homedir: "C:\\Users\\u",
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
    });
    expect(layout.configPath).toBe("C:\\Users\\u\\.pi\\pi-courier.json");
    expect(layout.matrixStorePath).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\matrix-store.json");
    expect(layout.matrixCryptoDir).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\matrix-crypto");
    expect(layout.attachmentsDir).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\attachments");
    expect(layout.lockPath).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state\\pi-courier.lock");
    expect(layout.heartbeatPath).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state\\heartbeat.json");
    expect(layout.auditLogPath).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state\\audit.jsonl");
    expect(layout.eventLedgerPath).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state\\event-ledger.jsonl");
    expect(layout.queueSnapshotsPath).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state\\queue-snapshots.json");
    expect(layout.watchdogAlertStampPath).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state\\watchdog-alert-stamp");
    expect(layout.stateLogsDir).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state\\logs");
    expect(layout.runLogPath).toBe("C:\\Users\\u\\AppData\\Roaming\\pi-courier\\state\\logs\\run.log");
  });

  it("darwin 派生表抽检(叶子形状与 win32 同构)", () => {
    const layout = resolveLayout({ platform: "darwin", homedir: "/Users/u", env: {} });
    expect(layout.configPath).toBe("/Users/u/.config/pi-courier/pi-courier.json");
    expect(layout.lockPath).toBe(
      "/Users/u/Library/Application Support/pi-courier/state/pi-courier.lock",
    );
    expect(layout.runLogPath).toBe(
      "/Users/u/Library/Application Support/pi-courier/state/logs/run.log",
    );
  });

  it("XDG 覆盖传导到派生路径(单一来源:派生只认解析后的根)", () => {
    const layout = resolveLayout({
      platform: "linux",
      homedir: "/home/u",
      env: { XDG_DATA_HOME: "/xdg/data", XDG_STATE_HOME: "/xdg/state" },
    });
    expect(layout.matrixStorePath).toBe("/xdg/data/pi-courier/matrix-store.json");
    expect(layout.lockPath).toBe("/xdg/state/pi-courier/pi-courier.lock");
    expect(layout.runLogPath).toBe("/xdg/state/pi-courier/logs/run.log");
  });
});
