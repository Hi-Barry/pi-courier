# pi-courier 看门狗 —— Windows 壳(spec #247 票07)。
#
# 判定逻辑全在 watchdog-core.mjs(零桥代码依赖,与 POSIX 壳共用同一核心);
# 本壳只做参数解析、拼接 Windows 完整重启序列的命令模板并调用核心。
#
# Windows 完整重启序列(两种判定「僵死 PID 活 / 已死」统一走同一序列,平台
# 差异决定次序不能省):
#   ① 若心跳里的 PID 仍存活 → `taskkill /F /PID <心跳PID>` 先杀旧实例:
#      单实例锁对活进程持有的锁不抢占(锁文件只在持有进程已死时才可接管),
#      不先杀则新实例报「已有实例在跑」即退,看门狗陷入「每分钟拉起→秒退」
#      死循环而僵死进程永远除不掉。(判定核心只在僵死分支执行 kill 命令;
#      已死分支自动跳过,直接进入②③。)
#   ② `schtasks /end /tn <任务名>` 终止计划任务实例:事故实录里进程死后
#      任务状态仍卡 Running,调度器默认禁止同任务并行实例,不先 end 则
#      随后的 run 被直接拒绝。end 由判定核心单独执行:对未运行的任务
#      schtasks 会返回非零(「已死」分支的常态),失败只记 stderr,绝不
#      阻断下一步 run(把 end 与 run 串成 `&&` 会让重启被永远跳过)。
#   ③ `schtasks /run /tn <任务名>` 拉起。杀完到起新之间无需等锁:旧进程
#      死透后锁文件可被新实例直接接管(既有锁语义)。
#
# 换算关系:-StaleSeconds 默认 180 = 6 × 30 秒心跳间隔(桥侧 config
# resilience.heartbeatIntervalSeconds 默认 30)。桥改心跳间隔时,这里的
# 默认值(或安装处覆盖)同步调整;README 与 watchdog-core.mjs 文件头注释互指。
#
# 安装(任务计划程序每分钟触发;与 deploy/pi-courier.user.service 同风格,
# PowerShell 一次性注册,与桥任务同用户上下文、无需管理员。用
# Register-ScheduledTask 原生参数传值;旧 schtasks /create 的 /tr 拼引号
# 写法已废弃 —— 用户名/安装路径含空格时它的多层引号转义极易翻车,本方案
# 把脚本路径用内嵌双引号包进 -Argument,一层解析、空格安全):
#
#   $action = New-ScheduledTaskAction -Execute "powershell.exe" `
#     -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\pi-courier\deploy\watchdog\watchdog-windows.ps1" -TaskName pi-courier'
#   $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
#     -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)
#   Register-ScheduledTask -TaskName "pi-courier-watchdog" -Action $action -Trigger $trigger -Force
#
#   (-RepetitionInterval + -RepetitionDuration MaxValue 是旧
#   `schtasks /sc minute /mo 1` 的等价物:每分钟触发、无限重复。)
#
# 卸载:Unregister-ScheduledTask -TaskName "pi-courier-watchdog" -Confirm:$false
#
# 前置:任务计划程序里先有桥本身的登录触发任务(任务名 -TaskName,默认
# pi-courier);告警与 POSIX 壳共用同目录 matrix-alert.mjs(读
# %USERPROFILE%\.pi\pi-courier.json 凭据,30 分钟冷却),-NoAlert 可关闭。
#
# 注意:脚本路径含空格由上面的内嵌引号方案兜住;任务名(pi-courier 与
# pi-courier-watchdog)仍请避免空格 —— 僵死分支的 schtasks /end、/run 模板
# 经 cmd 层执行,任务名不带引号。真机验收口径见 PR/票评。

param(
  # 心跳文件(桥的状态根 stateDir,spec #258 新布局;APPDATA 缺失的极端
  # 场景由 watchdog-core.mjs 的默认解析兜底回 ~/AppData/Roaming)
  [string]$HeartbeatPath = "$env:APPDATA\pi-courier\state\heartbeat.json",
  # 过期秒(默认 180 = 6 × 30s 心跳间隔,换算关系见文件头)
  [int]$StaleSeconds = 180,
  # 心跳间隔秒(默认 30;PID 消失后的宽限期 = 2 × 该值)
  [int]$HeartbeatIntervalSeconds = 30,
  # 桥自身的计划任务名(schtasks /end、/run 的目标)
  [string]$TaskName = "pi-courier",
  # 关闭告警(默认经 matrix-alert.mjs 发管理房)
  [switch]$NoAlert
)

$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$core = Join-Path $scriptDir "watchdog-core.mjs"
$alert = Join-Path $scriptDir "matrix-alert.mjs"

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Error "[watchdog] node not found on PATH — the watchdog cannot run. Install Node.js or add it to PATH."
  exit 1
}

# Windows 序列模板(占位符由判定核心替换:{pid}=心跳 PID,{message}=告警文本;
# 三条命令分开传给核心,核心按 kill → end → run 次序执行):
$killCommand = "taskkill /F /PID {pid}"
$endCommand = "schtasks /end /tn $TaskName"
$restartCommand = "schtasks /run /tn $TaskName"

$coreArgs = @(
  "--heartbeat", $HeartbeatPath,
  "--stale-seconds", "$StaleSeconds",
  "--heartbeat-interval-seconds", "$HeartbeatIntervalSeconds",
  "--kill-command", $killCommand,
  "--end-command", $endCommand,
  "--restart-command", $restartCommand
)
if (-not $NoAlert) {
  $coreArgs += @("--alert-command", "node `"$alert`" --message {message}")
}

& $nodeCommand.Source $core @coreArgs
# 退出码透传给任务计划程序(便于在任务历史里看到失败)
exit $LASTEXITCODE
