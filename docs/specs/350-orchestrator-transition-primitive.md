# Spec #350:UpdateOrchestrator 状态转移原语——transition/isStale,守卫写一次

> 来源:架构评审 2026-11-16 卡7(Worth exploring)。

## Problem Statement

`generation` 并发协议(「后台循环闭包捕获进入时代次,每次转移 +1,迟到置位自废」)是 UpdateOrchestrator 接口的一部分,却不在任何类型签名里——只活在注释和使用惯例中。守卫(`generation !== myGen || state !== …`)散布 10 处、转移+代次推进手写 20+ 处;每个新后台循环都要记得带守卫,漏一处 = 双编排窗口(§5.7 注释自述曾漏)。

## Solution

两个极小私有原语(不引入状态机库):
- `transition(next: UpdateState): void` —— `state = next` 与 `generation += 1` 一次写就,两者不可再分离;
- `isStale(myGen: number, expected: UpdateState): boolean` —— 迟到守卫判定写一次,10 处 `this.generation !== myGen || this.state !== X` 全部换用。

全部机械替换,行为逐字节不变。既有全量测试(update-orchestrator 等)做安全网,不新增行为测试(协议的可见行为已被既有测试钉住;对私有方法直测=测实现内部,违背本仓测试原则)。

## User Stories

1. As a 维护者, I want 「转移必推进代次」由原语保证, so that 新后台循环不可能漏带代次推进
2. As a 维护者, I want 迟到守卫写一次, so that 双编排窗口类 bug 的验证点从 10 处收敛到 1 处
3. As a 桥用户, I want /update 行为逐字节不变, so that 重构零回归

## Implementation Decisions

- `transition`/`isStale` 均为 `UpdateOrchestrator` 私有方法,公共接口(deps 14 缝、handleCommand 契约、§5.3 同步段顺序)零变化。
- 替换范围:守卫 11 处(含 waitIdleWithProgress 的 onTick/shouldAbort)→ `isStale`;「置态 + 推进代次」成对出现处 → `transition`。
- **例外(不推进代次,保持原样)共 7 处**:
  - waiting 入口 —— 同一编排的延续,CAS 已捕获 myGen,再推进会自废刚启动的后台等待;
  - restartNow / restartWindowsViaTask 触发成功的终点位 ×2 —— 触发成功 = 进程即将被杀,无需自废任何闭包;
  - handleCommand 占位后的失败复位 ×4(from 缺失 / fetch 抛错 / latest 缺失 / 非新版;评审整改补记)—— 原代码只置 idle 不 bump。实现将其收编进 `transition`(多一次 bump):语义上「离开编排即自废」更一致,且这 4 处为同步路径、无存活的 myGen 闭包,generation 只用于 isStale 相等比较、从不外露 —— 多 bump 不可观察(62 用例全绿佐证)。评审决议:回写 spec 补记理由,不改代码。
- 头注释(249-254 行)同步改写,指向原语。

## Testing Decisions

- 既有 tests/update-orchestrator.test.ts 全数保持通过(它经 handleCommand 公共接口驱动,已钉住 cancel 仲裁、迟到回执自废、双编排窗口防线)。
- 不新增对私有原语的直测。

## Out of Scope

- deps 14 缝宽接口收窄(另行评估)
- 任何回执文案/退出码/审计行为变化
