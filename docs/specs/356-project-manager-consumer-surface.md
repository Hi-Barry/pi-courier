# Spec #356:ProjectManager 消费面收窄——意图方法 + 测试假件全形状单点

> 来源:架构评审 2026-11-16 卡6(Worth exploring)。

## Problem Statement

router 对 ProjectManager 的新能力以可选方法接入(`projectMap?.()`、`modeForRoom?.()`),正确性依赖"哪个测试假件记得造哪个方法"——helpers 假件 7 方法、collab-gate 手搓 11 方法,各自 `as unknown as ProjectManager` 过编译,漏方法 = 运行时炸或静默走错分支;类型系统不再保证能力存在(浅化方向:消费面随特性涨,实现多为一行读 store)。`roomToolCallsMode` 一行同时读四个模块的内部视图,其中 `projectMap()` 直读只为取 `showToolCalls` 字段。

## Solution

1. **读侧意图方法**:ProjectManager 新增 `showToolCallsForRoom(roomId): "auto" | "on" | "off"`(缺省 "auto");router 的 `roomToolCallsMode` 改用它,`projectMap` 直读退役。
2. **可选链退役**:router 对 ProjectManager 的 `?.`(projectMap/modeForRoom 共 3 处)全部改直接调用——类方法真实存在,防御性可选链只在掩盖假件形状缺陷。
3. **假件单点**:helpers.ts 导出 `makeProjectManagerStub(rpc, overrides)`——router 消费面 10 方法 + isMultiProject + pmctl 面注册方法的全形状假件;router fixture 与 collab-gate 改用;新测试禁止手搓局部假件。

## User Stories

1. As a 测试作者, I want 全形状假件单点, so that 不再猜"新阶段会调哪些方法",漏方法从运行时炸变成假件定义处一目了然
2. As a 维护者, I want router 对 ProjectManager 的可选链退役, so that 类型系统重新接管消费面(方法缺失=编译错)
3. As a 维护者, I want 房间工具流设置走意图方法, so that projectMap 的调用方不再依赖其返回形状
4. As a 桥用户, I want 房间工具流判定行为逐字节不变, so that 收口零回归

## Implementation Decisions

- `showToolCallsForRoom` 实现为一行读 store(与原直读等价);不加缓存不加缝。
- **guest 判定另立 `isGuestRoom(roomId): boolean`(直读条目 mode,不带 multiProject 门)**:评审发现 modeForRoom 的单项目门会让「单项目 + 残留 guest 条目」的工具流判定从 off 漂移为按聚合条件 on(原 projectMap 直读无此门)——恢复直读语义,仍以意图方法表达(评审硬伤 1 的决议)。
- **假件转换范围扩大(评审决议补记)**:可选链退役后,手搓假件缺方法从静默变响亮失败(TypeError)——error-visibility/extension-ui/login/projects/queue-lost 五个文件超出原定「不动」清单,按验收口径转 stub;helpers 注释计数修正为「9 方法 + isMultiProject getter + pmctl 面」。
- stub 类型仍 `as unknown as ProjectManager`(类无法被 Partial 字面量精确满足);形状集中在 helpers 单点,`as unknown as` 从 N 个文件收敛到 1 个。
- collab-gate 的 opts 定制(isMultiProject 等)经 overrides 传入。
- 其余 8 个手搓假件的测试文件**不动**(各自假件按需裁剪,行为已被全量测试钉住);禁令只对新增代码生效。

## Testing Decisions

- 全量既有测试零改动通过(假件替换后行为等价的主证据)。
- 不新增测试(本单元无新行为;showToolCallsForRoom 的一行读由既有 router 工具流测试覆盖)。

## Out of Scope

- RoomOps 能力探测(`getProjectMeta?.` 等)收口——单生产 adapter 的假设性缝,文件头自述"第二 transport 出现才是多平台缝毕业之时"
- `roomToolCallsMode` 联合判定搬到 ProjectManager(需要注入 BotRegistry+store+出站缝三依赖,得不偿失;判定已是单点函数)
- ProjectManager 实现内部重构
