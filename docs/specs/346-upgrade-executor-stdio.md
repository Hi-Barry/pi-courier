# Spec #346:升级执行器统一——CLI 消费 runUpgrade(stdio 执行风格)

> 来源:架构评审 2026-11-16 卡1(Strong,首推)。评审证据:cli.ts:458 注释自证"对齐节奏是注释义务";三个月 #320/#326/#331 三个 spec 全打这条链。

## Problem Statement

`pi-courier update`(CLI)与桥内 /update 共用 `buildUpgradePlan` 的步骤构造,但**执行策略平行两套**:重试循环、看门狗暂停、超时判定各写一份。一致性靠共享常量(`STALL_TIMEOUT_MS`)+ 注释维持——每改一次升级策略,维护者必须人肉同步两处;"对齐节奏"是注释义务,不是编译事实。修 bug 的成本证明这份知识需要单点。

## Solution

CLI 的升级执行段改调 `runUpgrade`,**执行风格作参数**:`stdio: "pipe" | "inherit"`。
- `pipe`(默认,桥):现状不变——输出进滚动尾部、无进展看门狗、卡死重试。
- `inherit`(CLI):直通终端(stdio inherit)、不挂无进展看门狗(读不到输出流)、单次硬超时,超时被杀视为 stall 可重试——与现 CLI 行为逐条对齐。

重试/暂停/校验策略单点化;CLI 保留服务停启与 Windows 重启编排(编排属 CLI 职责,不属执行策略)。

## User Stories

1. As a CLI 用户, I want `pi-courier update` 的重试/超时节奏与桥内 /update 完全一致, so that 任一侧的策略修复自动生效另一侧
2. As a CLI 用户, I want 升级时继续在终端实时看到 npm 输出, so that 长时间安装不像是卡死
3. As a CLI 用户, I want 可重试步骤(npm install)在无进展被杀后自动重试(≤3 次、单次 10 分钟), so that 偶发代理抖动不致升级失败
4. As a CLI 用户, I want 失败时看到明确的失败命令、退出码或超时原因, so that 能判断下一步(重试/换镜像/手动)
5. As a CLI 用户, I want 升级窗口内 Windows 看门狗任务被暂停并在结束(含失败)时恢复, so that 半替换包目录不触发「无法找到脚本文件」
6. As a CLI 用户, I want 代理配置继续注入升级子进程 env, so that 代理环境下升级照常出网
7. As a CLI 用户, I want 步完成里程碑照旧打印(与房间回执同键), so that 进度可见性不回退
8. As a 桥用户, I want 桥内 /update 行为完全不变, so that 升级链路重构零回归
9. As a 维护者, I want 重试节奏成为编译事实而非注释义务, so that 未来策略改动只改一处
10. As a 维护者, I want Windows 看门狗暂停/恢复只有一份实现, so that schtasks 语义修复一次生效两边
11. As a 维护者/脚本, I want CLI 退出码保真(失败步骤的退出码), so that 自动化脚本可判升级成败
12. As a 测试者, I want inherit 模式从 runUpgrade 公共接口测(注入假 spawn/假计时器), so that 测试不进实现内部

## Implementation Decisions

- **不新增缝**:扩展既有 `UpgradeDeps`——`stdio?: "pipe" | "inherit"`(默认 `pipe`)。pipe 分支行为逐字节不变(既有用例零改动=零回归证据)。
- **inherit 模式语义**(= 现 CLI 行为逐条对齐):spawn 用 stdio inherit;不挂 stall 计时器;可重试步骤单次尝试上限 = `STALL_TIMEOUT_MS`,不可重试 = `step.timeoutMs ?? UPGRADE_TIMEOUT_MS`;超时被 SIGKILL 杀 → 失败标记 `stalled` → 可重试步骤自动重试(与 pipe 模式 stall 语义同一字段);真实 spawn 错误/非零退出不重试。
- **UpgradeOutcome 失败分支扩展**:`code?: number`(已知退出码)、`failedCommand?: string`(`cmd args` 串)。桥侧忽略;CLI 用于保真退出码与本地化失败行。
- **CLI `cmdUpdate` 改 async**,执行段调 `await runUpgrade({ projectDir, stdio: "inherit", envOverrides: 代理增量, onProgress })`;onProgress 映射:step-start → `$ cmd args`、stall-retry → `cmd.update.progress.retry`、step-done → `cmd.update.progress.done`(键不变,与房间回执同源)。
- **CLI 失败文案**:原生库缺失 → `cli.update.nativeMissing`(语义本地可推导:outcome 失败且 native 校验不过);其余 → `cli.update.cmdFailed`(failedCommand + code);code 未知(超时)→ 直接打 `outcome.message`(技术行含"timed out"比"unknown"更明确)。`cli.update.watchdogSkip` 键删除——暂停/恢复走 `defaultWatchdogControl` 共享实现(logger.warn)。
- **CLI 保留自身编排**:停服务 → 升级 → (win32 重启判定/心跳探测) → 启服务;npm/git 预告文案不变。
- **i18n 双表同步**:删 `cli.update.watchdogSkip`(zh 为键集基准)。
- **头注释同步**:upgrade.ts"两边差异只在执行方式"段落改为"执行方式 = stdio 风格参数";cli.ts 对齐节奏注释(#326 story 9)删除——义务消失。

## Testing Decisions

- 好测试只测 `runUpgrade` 公共接口行为;先行样本:`tests/update-upgrade.test.ts` 的假 spawn + 假计时器 harness。
- 新增(inherit 模式):超时 → stalled → 可重试步骤第二次尝试成功;不可重试步骤超时一次即失败;非零退出 → `code` 进 outcome;spawn 抛错 → `failedCommand`/message 正确;onProgress 事件序在 inherit 下照发;失败路径看门狗 resume 照走。
- pipe 模式既有用例全数保持不变。
- CLI 薄壳不单测(历史惯例:cli.ts 加载即跑 main,不可 import 测);由部署实测(发版流程)覆盖。

## Out of Scope

- `updater.ts` 的 Windows 重启判定/心跳探测(桥侧编排,另一职责)
- UpdateOrchestrator 的 generation 协议(评审卡7,单独处理)
- progress 事件形状变化
- 桥内 /update 的任何行为变化

## Further Notes

- 删除测试:删掉 CLI 平行执行段,复杂度会在 runUpgrade 重现吗?不会——runUpgrade 已有;删的是"第二份实现"本身。
- 真机约束(2026-11-10):看门狗动作脚本在包目录内,升级窗口必须暂停——该语义在共享实现中保持。
