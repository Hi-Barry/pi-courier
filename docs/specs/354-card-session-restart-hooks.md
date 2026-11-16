# Spec #354:卡片机件沉到编辑缝下——两台卡片机迁入 card-session + 重启钩子键控收口

> 来源:架构评审 2026-11-16 卡2(Strong)+卡4(Worth exploring),合并执行(卡4 的 WeakMap 合并依附卡2,分开做会碰同一批代码两次)。

## Problem Statement

工具循环活卡与工作流进度卡是同一 Matrix 编辑缝(`editReply`/`sendLiveCard`)上的两台状态机:机件同构(代次捕获、在途写回作废、降级标志、重启失效)却复制两份摊在 router 闭包——代次捕获/清卡入口/懒订阅守卫逐字同构(活卡 bug 曾连续三条 spec #235/#242/#248 回炉,修复面 = router 两段 + 测试)。「重启懒订阅 + WeakSet 去重」样板自我复制 6 处(router 三张 WeakSet + RpcTransientState/RecapLedger/ExtensionQuestions 各自手搓),样板靠注释引用上一个实例自我复制(spec #335 的 fallbackRestartWatched 是最新复制体)。

## Solution

- **`rpc/restart-hooks.ts`**:`RpcRestartHooks` 键控 once 注册表——`once(rpc, key, hook)` 同键幂等、该 rpc 首见任一键时挂一次重启订阅,触发时广播该 rpc 全部钩子。router 三张 WeakSet(liveCard/workflow/fallback)收敛于此。
- **`rpc/card-session.ts`**:`CardGeneration` 代次机件单点(捕获/作废/递增) + 两台卡片机整体迁入:
  - `ToolTurnCards`——工具循环活卡全机件(状态 WeakMap、代次、FIFO 出站链、降级直发策略、溢出滚动、开卡失败不留状态不变量);
  - `WorkflowProgressCards`——工作流进度卡全机件(按 runId 多卡账本、代次、节流、降级放大重试策略、终态 finalized、旧 run 中断编辑)。
- router 只剩编排:轮次边界清卡、turn_end 段落派发喂卡、entry_appended 喂工作流快照。

## User Stories

1. As a 维护者, I want 活卡机件的 bug 修复面缩到一个模块, so that 代次竞态/在途写回类缺陷不再跨 router 两段修
2. As a 维护者, I want 新卡片特性继承现成的失效语义, so that 只登记重启钩子即可,不再抄 WeakSet 样板
3. As a 维护者, I want 两台机器的策略差异显式(各自的类), so that 不被硬捏成一个参数化巨类
4. As a 桥用户, I want 卡片行为逐字节不变, so that 重构零回归
5. As a 测试者, I want 重启钩子注册表可单测, so that once 幂等/广播语义有直接证据

## Implementation Decisions

- **不硬捏**:两台机器的出站策略差异是本质的(FIFO 出站链+降级逐条直发 vs fire-and-forget+放大间隔重试;单卡 vs 按 runId 多卡;节流/终态/中断编辑仅工作流有)。统一的是机件(代次、重启失效、缝调用),策略以两个类表达。
- `ToolTurnCards`/`WorkflowProgressCards` 构造注入缝与开关:seam(editReply/sendLiveCard,可缺席=机器整体禁用)、sendReply(仅工具卡降级直发用)、splitMessage(直接 import formatting)、isEnabled()/throttleMs()(router 以 store 闭包注入,现读现判)、targetFor(rpc)(绑定解析,router 注入)、restart(RpcRestartHooks)。工作流模块直接 import workflow/adapter、workflow/render、workflow/types(既有深模块)。
- router 删除:liveCards/liveCardGenerations/bumpLiveCardGeneration/clearLiveCard/liveCardChains/enqueueLiveCardTurn/liveCardTurn/liveCardRestartWatched/workflowRestartWatched/workflowLedgers/workflowGenerations/bumpWorkflowGeneration/workflowLastIr/workflowLastStatus/handleWorkflowProgress 及两个 WeakSet;`liveCardAggregation`(roomToolCallsMode 的 kill-switch 判定)留在 router(读 deps+store,非卡片机件)。
- fallback 的重启钩子(1871-1874)换 `restartHooks.once(rpc, "fallback-streak", …)`。
- RpcTransientState/RecapLedger/ExtensionQuestions 的自持订阅**不动**(它们已是自包含深模块,收编反而破坏其零依赖形状)。
- 键控 once 的键:工具卡 "tool-turn-card"、工作流卡 "workflow-card"、降级链 "fallback-streak"。

## Testing Decisions

- 既有 tests/router-livecard.test.ts、workflow 卡片系列测试全数保持通过——它们经 handleEvent 公共入口驱动,是行为逐字节不变的主证据。
- 新增 tests/restart-hooks.test.ts:once 同键幂等(钩子不重复入列)、不同键各自入列、订阅触发时该 rpc 全部钩子按登记序广播、跨 rpc 互不串。
- 门禁三件套(typecheck/test/lint)全绿。

## Out of Scope

- RpcTransientState/RecapLedger/ExtensionQuestions 的订阅收编(自包含深模块,不外借)
- 卡片策略行为变化(节流值、降级语义、滚动口径)
- 按房间的 typing 续期(lastTypingRenewalAt)——与卡片机无关
