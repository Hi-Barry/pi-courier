#!/usr/bin/env bash
# pi-courier 看门狗 —— POSIX 壳(spec #247 票06)。
#
# 判定逻辑全在 watchdog-core.mjs(零桥代码依赖);本壳只做参数解析与调用。
# `systemctl --user restart` 天然先 stop 后 start,「已死」与「僵死(PID 仍
# 存活)」两形态都不需要额外的杀旧步骤,故不传 --kill-command。
#
# 换算关系:--stale-seconds 默认 180 = 6 × 30 秒心跳间隔(桥侧 config
# resilience.heartbeatIntervalSeconds 默认 30)。桥改心跳间隔时,这里的
# STALE_SECONDS(或安装处覆盖)同步调整;README 与 watchdog-core.mjs 文件
# 头注释互指。
#
# 安装(cron 或 systemd timer,每分钟触发;与 deploy/pi-courier.user.service
# 同风格):
#
#   方式一(crontab -e):
#     * * * * * /opt/pi-courier/deploy/watchdog/watchdog-posix.sh >> ~/.local/state/pi-courier/watchdog.log 2>&1
#
#   方式二(systemd timer,~/.config/systemd/user/pi-courier-watchdog.service):
#     [Unit]
#     Description=pi-courier watchdog (stale/dead detection + restart + Matrix alert)
#
#     [Service]
#     Type=oneshot
#     ExecStart=%h/Projects/pi-courier/deploy/watchdog/watchdog-posix.sh
#
#   (~/.config/systemd/user/pi-courier-watchdog.timer:)
#     [Unit]
#     Description=Run pi-courier watchdog every minute
#
#     [Timer]
#     OnCalendar=*-*-* *:*:00
#     Persistent=false
#
#     [Install]
#     WantedBy=timers.target
#
#   systemctl --user daemon-reload && systemctl --user enable --now pi-courier-watchdog.timer
#
# 可覆盖的环境变量/参数:
#   PI_COURIER_SERVICE   systemd 服务名(默认 pi-pi-courier,与 user unit 一致)
#   PI_COURIER_HEARTBEAT 心跳文件路径(默认 ${XDG_STATE_HOME:-~/.local/state}/pi-courier/heartbeat.json,
#                        spec #258 新布局状态根;旧路径可显式传参覆盖)
#   PI_COURIER_ALERT     自定义告警命令模板(含 {message} 占位;{message} 由
#                        判定核心按宿主 shell 安全引用)。默认调同目录
#                        matrix-alert.mjs;置 off / 空串关闭告警
#   --stale-seconds <n>  过期秒覆盖(命令行参数优先于默认 180)
#   --heartbeat-interval-seconds <n>
#                        心跳间隔秒覆盖(默认 30;PID 消失后的宽限期 = 2 × 该值。
#                        桥改 resilience.heartbeatIntervalSeconds 时同步传入)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="${PI_COURIER_SERVICE:-pi-pi-courier}"
# XDG 语义:未设置或空串一律按缺省 ~/.local/state 处理(spec #258 新布局,
# 与 src/paths.ts 的 linux 分支一致;旧布局用 PI_COURIER_HEARTBEAT / --heartbeat 覆盖)
HEARTBEAT="${PI_COURIER_HEARTBEAT:-${XDG_STATE_HOME:-$HOME/.local/state}/pi-courier/heartbeat.json}"
STALE_SECONDS="180"
HEARTBEAT_INTERVAL_SECONDS="30"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --stale-seconds)
      STALE_SECONDS="$2"
      shift 2
      ;;
    --heartbeat-interval-seconds)
      HEARTBEAT_INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --heartbeat)
      HEARTBEAT="$2"
      shift 2
      ;;
    --service)
      SERVICE="$2"
      shift 2
      ;;
    *)
      echo "[watchdog] unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "${PI_COURIER_ALERT+x}" ]; then
  # 未设置:走内置轻量告警脚本
  ALERT_COMMAND="node \"$SCRIPT_DIR/matrix-alert.mjs\" --message {message}"
elif [ -z "$PI_COURIER_ALERT" ] || [ "$PI_COURIER_ALERT" = "off" ]; then
  ALERT_COMMAND=""
else
  # 自定义命令模板(含 {message} 占位);核心负责加引号
  ALERT_COMMAND="$PI_COURIER_ALERT"
fi

ALERT_ARGS=()
if [ -n "$ALERT_COMMAND" ]; then
  ALERT_ARGS=(--alert-command "$ALERT_COMMAND")
fi

exec node "$SCRIPT_DIR/watchdog-core.mjs" \
  --heartbeat "$HEARTBEAT" \
  --stale-seconds "$STALE_SECONDS" \
  --heartbeat-interval-seconds "$HEARTBEAT_INTERVAL_SECONDS" \
  --restart-command "systemctl --user restart $SERVICE" \
  "${ALERT_ARGS[@]}"
