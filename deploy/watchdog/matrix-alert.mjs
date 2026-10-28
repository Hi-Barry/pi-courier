#!/usr/bin/env node
/**
 * pi-courier 看门狗 —— 轻量 Matrix 告警脚本(spec #247 票06)。
 *
 * 单文件、零桥代码依赖:直读 ~/.pi/pi-courier.json 的 Matrix 凭据与管理房
 * ID,直调 homeserver 的房间发送 API。「bot 死了」不再等于「告警通道也没了」。
 *
 * 自带冷却:上次告警时间戳落盘(默认 ~/.pi/pi-courier-state/watchdog-alert-stamp,
 * 与心跳同目录),默认 30 分钟窗口 —— 服务反复崩溃时收到的告警是有限几条,
 * 不是每分钟一条轰炸。窗口内第二条例行调用被静默抑制;发送失败不更新时间戳
 * (下一轮看门狗重试)。
 *
 * 独立部署产物:内嵌消息不进桥的 i18n 双表;默认英文消息(公开仓库口径),
 * 中文注释。消息文本由调用方(看门狗壳/判定核心)经 --message 传入。
 *
 * 用法:
 *   node matrix-alert.mjs --message "pi-courier watchdog: restarted"
 *   [--config ~/.pi/pi-courier.json] [--stamp ~/.pi/pi-courier-state/watchdog-alert-stamp]
 *   [--cooldown-minutes 30] [--timeout-ms 10000]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 冷却窗口默认(毫秒):30 分钟(spec #247 票06)。 */
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;
/** 发送网络超时默认(毫秒):挂起的 homeserver 请求不能拖住看门狗壳。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

export function defaultConfigPath() {
  return path.join(os.homedir(), ".pi", "pi-courier.json");
}

export function defaultStampPath() {
  return path.join(os.homedir(), ".pi", "pi-courier-state", "watchdog-alert-stamp");
}

/** 从桥配置里取发送凭据(与桥 managementRooms 派生同序:显式列表优先,
 *  space.roomId 兜底 —— 本地最小解析,不 import 桥代码)。返回 null 或
 *  { homeserverUrl, accessToken, roomId }。 */
export function pickAlertTarget(config) {
  const homeserverUrl = config?.matrix?.homeserverUrl;
  const accessToken = config?.matrix?.accessToken;
  const roomId = config?.managementRooms?.[0] ?? config?.space?.roomId;
  if (!homeserverUrl || !accessToken || !roomId) return null;
  return { homeserverUrl: homeserverUrl.replace(/\/+$/, ""), accessToken, roomId };
}

/**
 * 冷却 + 发送的唯一入口(CLI 与测试共用)。
 * opts: message(必填)、configPath、stampPath、cooldownMs(默认 30 分钟)、
 *       timeoutMs(默认 10 秒)、nowMs、fetchImpl(测试注入)、
 *       readStamp/writeStamp(测试注入临时目录)。
 * 返回 { sent, reason, detail? }:reason ∈ sent | cooldown | no-config |
 *       send-failed | empty-message。
 */
export async function sendAlertWithCooldown(opts) {
  const configPath = opts.configPath ?? defaultConfigPath();
  const stampPath = opts.stampPath ?? defaultStampPath();
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.nowMs ?? Date.now();
  const readStamp =
    opts.readStamp ??
    ((p) => {
      try {
        const ts = Number.parseInt(fs.readFileSync(p, "utf-8").trim(), 10);
        return Number.isFinite(ts) ? ts : null;
      } catch {
        return null;
      }
    });
  const writeStamp =
    opts.writeStamp ??
    ((p, ts) => {
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      fs.writeFileSync(p, String(ts), { mode: 0o600 });
    });

  if (!opts.message?.trim()) return { sent: false, reason: "empty-message" };

  // 冷却:窗口内静默抑制(不网络、不写戳)
  const last = readStamp(stampPath);
  if (last !== null && now - last < cooldownMs) {
    return { sent: false, reason: "cooldown" };
  }

  // 凭据:读不到(未部署/未配置管理房)按安装错误静默退出,不重试不刷屏
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return { sent: false, reason: "no-config", detail: `config unreadable: ${configPath}` };
  }
  const target = pickAlertTarget(config);
  if (!target) {
    return { sent: false, reason: "no-config", detail: "no matrix credentials or management room in config" };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const txnId = `watchdog${now}${Math.floor(Math.random() * 1e6)}`;
  const url = `${target.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(target.roomId)}/send/m.room.message/${txnId}`;
  try {
    const response = await fetchImpl(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${target.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ msgtype: "m.text", body: opts.message }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { sent: false, reason: "send-failed", detail: `HTTP ${response.status}` };
    }
  } catch (err) {
    // 网络失败/超时不写时间戳:下一轮看门狗触发时重试
    return { sent: false, reason: "send-failed", detail: String(err) };
  }
  writeStamp(stampPath, now);
  return { sent: true, reason: "sent" };
}

/** CLI 参数解析(导出以便测试直测)。返回 AlertOptions 或 null(非法)。 */
export function parseAlertArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--message":
        result.message = argv[++i];
        break;
      case "--config":
        result.configPath = argv[++i];
        break;
      case "--stamp":
        result.stampPath = argv[++i];
        break;
      case "--cooldown-minutes":
        result.cooldownMinutes = Number.parseInt(argv[++i] ?? "", 10);
        break;
      case "--timeout-ms":
        result.timeoutMs = Number.parseInt(argv[++i] ?? "", 10);
        break;
      default:
        process.stderr.write(`[matrix-alert] unknown argument: ${argv[i]}\n`);
        return null;
    }
  }
  if (!result.message) {
    process.stderr.write("[matrix-alert] --message is required\n");
    return null;
  }
  return {
    message: result.message,
    ...(result.configPath ? { configPath: result.configPath } : {}),
    ...(result.stampPath ? { stampPath: result.stampPath } : {}),
    ...(result.cooldownMinutes !== undefined && Number.isFinite(result.cooldownMinutes)
      ? { cooldownMs: result.cooldownMinutes * 60_000 }
      : {}),
    ...(result.timeoutMs !== undefined && Number.isFinite(result.timeoutMs) ? { timeoutMs: result.timeoutMs } : {}),
  };
}

// 直接执行:node matrix-alert.mjs --message "..."
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const opts = parseAlertArgs(process.argv.slice(2));
  if (!opts) process.exit(2);
  const outcome = await sendAlertWithCooldown(opts);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  if (!outcome.sent && outcome.reason !== "cooldown") process.exit(1);
}
