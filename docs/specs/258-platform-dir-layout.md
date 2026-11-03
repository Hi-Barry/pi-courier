# Spec:#258 跨平台目录重组:配置/数据/状态按平台惯例分离与启动自动迁移

- **状态**:定稿待实现
- **日期**:2026-11-02
- **分支**:`feat/platform-dir-layout`(从 develop 切出),PR 目标 `develop`
- **GitHub**:Hi-Barry/pi-courier#258(标签 ready-for-agent)

---

## Problem Statement

pi-courier 在磁盘上的东西目前全部挤在一个平台无关的 `~/.pi` 筐里(Matrix 存储、E2EE 密钥、心跳/审计/台账、附件、锁文件),另有两条更糟的:运行日志被计划任务命令行重定向到家目录根(`~/pi-courier-run.log`,和 `.ssh`、`Desktop` 混放),看门狗脚本则无处安放(上次事故处置时临时提议放盘符根目录)。用户找文件要靠记忆,不符合任何一边的平台惯例,难以按"配置/数据/状态"分类备份与清理。

附带一个同窗内必须根治的部署隐患(2026-11-01 真机事故,证据链已闭环):Windows 计划任务未显式设置执行时长上限,任务计划程序按默认 **72 小时强杀**常驻进程——桥于 10-29 12:05 登录启动,11-01 12:05:12 整被杀(心跳停摆与最后一行日志秒级吻合,无崩溃记录,机器未重启);强杀退出码属"成功"级,任务自身的失败重启接不住,而看门狗任务尚未安装,进程躺了约 34 小时直至人工发现。

## Solution

1. **布局三分**:路径解析集中为一个纯函数模块,按平台产出三个根目录:
   - 配置目录:Windows 保持 `~\.pi`(pi CLI 共用的家,本就是"配置放 ~\.***app"惯例);Linux 走 XDG `~/.config/pi-courier`。
   - 数据目录:Windows `%APPDATA%\pi-courier`;Linux `~/.local/share/pi-courier`。收 Matrix 存储、E2EE 密钥、附件。
   - 状态目录:Windows 在数据目录下 `state\`;Linux XDG `~/.local/state/pi-courier`。收心跳、审计、台账、快照、锁、运行日志(`logs\run.log`,不再落家目录根)。
   - **应用程序本体不动**:npm 全局包位置是 npm 自己的惯例,强行搬会脱离 npm update/uninstall 管理体系。
2. **启动自动迁移**:新版本首次启动时检测旧位置文件,逐项原子搬入新家并输出迁移清单日志;新旧并存以新家为准(旧文件仅警告);幂等(重启多次不重复搬、不出错);**永不触碰 `~/.pi/agent`(pi CLI 自己的家)**。零手工,无人值守机器平滑升级。
3. **配套适配**:看门狗三件套默认路径指向新布局、注册方式改 PowerShell(根治用户名带空格的引号转义坑);systemd 单元与 docker(挂载拆分、entrypoint 引导路径)同步;运行日志随任务重注册改道 `logs\run.log`。
4. **部署配套(非代码,运维票)**:重注册 Windows 计划任务——执行时长上限设为永不超时 + 失败自动重启(1 分钟 × 3 次)+ 新日志路径;安装 `pi-courier-watchdog` 每分钟看门狗任务。
5. **发版与验证门禁**:本地测试/lint 全绿且本机手动启动完成迁移演练后,才发 npm 小版本(1.3.0 → 1.4.0);发版后在远程 Windows(192.168.1.101,当前 1.3.0)用 `/update` 热更新链路实测自升级 + 目录迁移 + E2EE 会话完好。

## User Stories

1. As a 部署运维者, I want 应用产生的数据集中在一个平台惯例目录, so that 找任何文件不用翻家目录和 `.pi` 猜位置。
2. As a 部署运维者, I want 升级后无需手工搬文件旧数据自动出现在新家, so that 无人值守机器也能平滑升级。
3. As a Matrix 用户, I want 目录迁移后 E2EE 会话照常可用, so that 不需要重新做设备验证。
4. As a 部署运维者, I want 运行日志不再落在家目录根, so that 家目录整洁且日志有固定去处。
5. As a Linux 部署者, I want 配置/数据/状态按 XDG 目录分离, so that 备份与清理可以按类别进行。
6. As a 部署运维者, I want 迁移过程输出"搬了什么、从哪到哪"的清单日志, so that 出问题可追溯。
7. As a 维护者, I want 路径解析集中在唯一一个纯函数模块, so that 平台分支与目录变更不再散落全局硬编码。
8. As a 部署运维者, I want 看门狗脚本默认路径指向新布局, so that 安装时不用手工传旧路径参数。
9. As a docker 部署者, I want 容器挂载点与新布局对齐, so that 容器内外路径心智一致。
10. As a 维护者, I want 迁移幂等, so that 异常中断后下次启动自然续上、不重复搬不出错。
11. As a 部署运维者, I want 新旧位置并存时以新家为准且只警告不搬, so that 两套数据不会来回打架。
12. As a pi CLI 用户, I want `~/.pi/agent`(pi 自己的家:凭据、会话、bin)完全不受影响, so that pi 命令行照常使用。
13. As a 部署运维者, I want Windows 计划任务去掉 72 小时强杀并带失败自动重启, so that 常驻进程不再被任务计划程序定时杀死。
14. As a 管理房观察者, I want 看门狗装好后进程意外死亡 1 分钟内被拉起并收到 Matrix 告警, so that 服务离线时间以分钟计。
15. As a 发版者, I want 小版本(1.3.0 → 1.4.0)经 `/update` 热更新实测可靠, so that 以后远程升级都走免登录通道。

## Implementation Decisions

1. **布局解析纯函数**:输入 `{ platform, homedir, env }` 产出 `{ configDir, dataDir, stateDir }` 派生路径(日志目录、锁文件等从 stateDir 派生)。组合根解析一次并注入,各模块不再各自取 homedir。平台分支:win32 → 配置 `~/.pi`、数据/状态 `%APPDATA%\pi-courier`;linux → 配置 `~/.config/pi-courier`、数据 `~/.local/share/pi-courier`、状态 `~/.local/state/pi-courier`;darwin → 按 macOS 惯例(Application Support/应用支持),只保证解析正确不做真机验收。
2. **文件归属映射**:Matrix 存储文件、crypto 目录、附件目录 → 数据目录;心跳、审计台账、队列快照、看门狗告警时间戳、单实例锁、运行日志 → 状态目录;`pi-courier.json` → 配置目录。新家目录已带应用名,子项叶子名去掉 `pi-courier-` 前缀。
3. **迁移模块**:进程启动早期、拿单实例锁之前执行。锁文件**不迁移**——旧锁仅做陈旧判断后删除,新锁在新位置重建(避免"锁搬家要先拿锁"的鸡生蛋)。同卷用 rename(原子),跨卷回退 copy+delete。逐项输出迁移清单日志;幂等;新旧并存信新家。提供依赖注入缝(移动操作、路径)供测试。
4. **相对路径基准不变**:配置文件里的相对路径仍相对配置目录解析,存量配置零破坏。
5. **pi 生态不动**:`~/.pi/agent`(pi CLI 凭据/会话/bin)与 RPC 会话目录默认值保持原位。
6. **看门狗三件套**:默认路径改新布局(参数仍可覆盖);安装文档与注册命令改 PowerShell `Register-ScheduledTask`,废弃 schtasks 拼引号方案。
7. **systemd/docker**:单元文件适配新布局;docker compose 挂载从整卷 `~/.pi` 拆为配置/数据/状态 + 保留 pi agent 的 `/root/.pi/agent`;entrypoint 首启引导路径同步。
8. **版本**:1.3.0 → 1.4.0(minor)。
9. **部署配套(运维,非代码)**:Windows 计划任务重注册(执行时长 PT0S + 失败重启 1 分钟 × 3 + 日志重定向新位置);安装看门狗每分钟任务。经远程 MCP 在 192.168.1.101 上执行。

## Testing Decisions

- 只测外部行为:布局解析按平台矩阵(win32/linux/darwin + env 覆盖)断言输出路径;迁移用临时目录真实文件测——首次迁移、幂等、新旧并存、`~/.pi/agent` 不动、锁文件删除语义。
- 受影响模块(锁、Matrix 客户端装配、心跳/状态写入、组合根)随注入缝更新后现有测试全绿为先行动作(改别人代码前先跑现有测试确认没坏)。
- 先行参考:进程韧性专项的注入缝 + fake deps 测试模式。
- 手动验收:本机 Linux 冷启动迁移演练(全绿后才发版);远程 Windows 用 `/update` 实测热更新 + 自动迁移 + E2EE 完好。

## Out of Scope

- 日志轮转与清理策略(当前规模未到);npm 全局包本体位置(npm 的地盘);Windows Local/Roaming 再细分;macOS 真机验收;部署文档全面重写(只更新受影响小节);Windows 计划任务以外的系统级部署变更。

## Further Notes

- **2026-11-01 事故证据链**(写入 spec 备查):心跳 ts 停在 04:05:03 UTC、日志末行 04:05:13 UTC(排程的自动拉起未及执行)、任务上次启动 10-29 12:05:12 与死亡时刻相隔恰好 72:00:00、任务 XML 无执行时长上限字段、`[crash]` 零条、机器未重启。结论:任务计划程序默认 72h 上限强杀,网络断连(ESOCKETTIMEDOUT)只是日志过客。
- **`/update` 与迁移的交互**:热更新只换磁盘代码,新版代码在下次进程重启生效,目录迁移随该次启动自动执行;计划任务重注册与看门狗安装是 `/update` 验证之后的 MCP 手工步骤。
- **分支与 PR**:`feat/platform-dir-layout`(从 develop 切出),PR 目标 `develop`;本地 docs/specs 同步落稿。
