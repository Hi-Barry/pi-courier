/**
 * 轻量 Matrix 告警脚本(spec #247 票06):直读配置直调 homeserver、网络
 * 超时受控、冷却窗口内第二条抑制、窗口过后恢复、发送失败不落戳(下轮
 * 重试)、未配置凭据静默。fetch/时钟/时间戳读写全注入。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultStampPath,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_TIMEOUT_MS,
  parseAlertArgs,
  pickAlertTarget,
  sendAlertWithCooldown,
} from "../deploy/watchdog/matrix-alert.mjs";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-alert-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CONFIG = {
  matrix: { homeserverUrl: "https://matrix.example.org", accessToken: "s3cret" },
  managementRooms: ["!mgmt:example.org"],
};

let configSeq = 0;

function writeConfig(config: unknown = CONFIG): string {
  // 唯一文件名:base() 默认值与显式注入的先后求值不能互相覆盖
  const p = path.join(dir, `pi-courier-${++configSeq}.json`);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

function okFetch(response = { ok: true, status: 200 }): typeof fetch {
  return vi.fn(async () => response as unknown as Response) as unknown as typeof fetch;
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    message: "pi-courier watchdog: restarted",
    configPath: writeConfig(),
    stampPath: path.join(dir, "stamp"),
    nowMs: 1_000_000,
    fetchImpl: okFetch(),
    ...overrides,
  } as never;
}

describe("matrix-alert 发送与冷却(spec #247 票06)", () => {
  it("首发成功:调 homeserver 房间发送 API(Bearer 凭据 + m.text),落时间戳", async () => {
    const fetchImpl = okFetch();
    const outcome = await sendAlertWithCooldown(base({ fetchImpl }));

    expect(outcome).toEqual({ sent: true, reason: "sent" });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    // encodeURIComponent 不编码「!」(MDN:unreserved 标记),「:」编码为 %3A
    expect(url).toContain("https://matrix.example.org/_matrix/client/v3/rooms/!mgmt%3Aexample.org/send/m.room.message/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(JSON.parse(String(init.body))).toMatchObject({ msgtype: "m.text", body: "pi-courier watchdog: restarted" });
    expect(fs.readFileSync(path.join(dir, "stamp"), "utf-8")).toBe("1000000");
  });

  it("网络超时受控:请求带 AbortSignal.timeout(默认 10s)", async () => {
    const fetchImpl = okFetch();
    await sendAlertWithCooldown(base({ fetchImpl }));
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });

  it("冷却窗口内第二条被抑制(不网络、不覆盖时间戳)", async () => {
    const fetchImpl = okFetch();
    const stampPath = path.join(dir, "stamp");
    const first = await sendAlertWithCooldown(base({ fetchImpl, stampPath }));
    expect(first.sent).toBe(true);

    const fetch2 = okFetch();
    const second = await sendAlertWithCooldown(base({ fetchImpl: fetch2, stampPath, nowMs: 1_000_000 + DEFAULT_COOLDOWN_MS - 1 }));
    expect(second).toEqual({ sent: false, reason: "cooldown" });
    expect(fetch2).not.toHaveBeenCalled(); // 窗口内零网络
    expect(fs.readFileSync(stampPath, "utf-8")).toBe("1000000"); // 原戳保留
  });

  it("窗口过后恢复发送(戳被更新)", async () => {
    const stampPath = path.join(dir, "stamp");
    await sendAlertWithCooldown(base({ stampPath }));
    const outcome = await sendAlertWithCooldown(base({ stampPath, nowMs: 1_000_000 + DEFAULT_COOLDOWN_MS }));
    expect(outcome.sent).toBe(true);
    expect(fs.readFileSync(stampPath, "utf-8")).toBe(String(1_000_000 + DEFAULT_COOLDOWN_MS));
  });

  it("发送失败不落戳(下一轮看门狗触发时重试)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502 }) as unknown as Response) as unknown as typeof fetch;
    const stampPath = path.join(dir, "stamp");
    const outcome = await sendAlertWithCooldown(base({ fetchImpl, stampPath }));

    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toBe("send-failed");
    expect(fs.existsSync(stampPath)).toBe(false);
  });

  it("凭据缺失/管理房未配置 → no-config 静默(安装错误,不是进程死亡)", async () => {
    const fetchImpl = okFetch();
    const noRoom = writeConfig({ matrix: CONFIG.matrix });
    const outcome = await sendAlertWithCooldown(base({ configPath: noRoom, fetchImpl }));
    expect(outcome.reason).toBe("no-config");
    expect(fetchImpl).not.toHaveBeenCalled();

    const missing = await sendAlertWithCooldown(base({ configPath: path.join(dir, "absent.json") }));
    expect(missing.reason).toBe("no-config");
  });

  it("配置里 space.roomId 兜底(managementRooms 缺省时)", () => {
    const target = pickAlertTarget({ matrix: CONFIG.matrix, space: { roomId: "!space:example.org" } });
    expect(target?.roomId).toBe("!space:example.org");
  });

  it("空消息直接拒绝(防御:壳传参失误不产生空告警)", async () => {
    const outcome = await sendAlertWithCooldown(base({ message: "  " }));
    expect(outcome.reason).toBe("empty-message");
  });
});

describe("CLI 参数解析(parseAlertArgs)", () => {
  it("message 必填;cooldown-minutes 换算毫秒;未知参数拒绝", () => {
    const opts = parseAlertArgs(["--message", "hi", "--cooldown-minutes", "15"]);
    expect(opts?.message).toBe("hi");
    expect(opts?.cooldownMs).toBe(15 * 60_000);
    expect(parseAlertArgs([])).toBeNull();
    expect(parseAlertArgs(["--bogus"])).toBeNull();
  });

  it("默认戳路径在派生状态目录(与心跳同目录)", () => {
    expect(defaultStampPath()).toContain(path.join(".pi", "pi-courier-state"));
  });
});
