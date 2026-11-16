# Spec #358:斜杠命令统一登记点第一步——registry 标注管线归属 + pmctl/login 族 handler 入住 dispatch

> 来源:架构评审 2026-11-16 卡5(Worth exploring),按族渐进("不必一步到位,pmctl/login 族先走")。

## Problem Statement

一条斜杠命令的一生摊在 4 个文件 6 个角色上:归属裁决散在管线各阶段的局部正则(adminCommands/groupEnable/roomToolsToggle/multiproject/pmctl/login 六族各自认词),分层规则只活在 command-map 头注释;加一个命令的作者必须知道"落哪扇门、插哪一档、要不要登记"。命令词解析在 router 内重复 8 处。删除测试:registry(纯数据策略位)有硬价值(删了 guest/审计清单会各自复制——历史上真实发生过),缺的是**管线归属的单一声明点**。

## Solution(第一步,按族渐进)

1. **`CommandPolicy.stage?`**:管线归属声明(值 = 管线阶段名),全部条目标注——`/pmctl`+`/newproject`+`/projects`→"pmctl"、`/login`+`/logout`+`/auth`→"login"、`/toggletools`→"roomToolsToggle"、`/multiproject`→"multiproject"、`/enable`→"groupEnable"、认证/信任面(/trusted /revoke)→"adminCommands"、其余会话命令(/bash /new /clear /compact /model 等)→"slashCommands"。
2. **契约测试**:①每个 stage 值 ∈ router.pipeline() 阶段名(经 makeRouterFixture 取真实管线);②六个命令族阶段在表中都有条目覆盖;③slashCommands 域条目与 command-map 的 case 域抽查对齐(防标注漂移)。
3. **pmctl/login 族 handler 迁入 `rpc/command-dispatch.ts`**:两族 stage body(审计+门禁+分派)整体迁出,router 阶段壳变薄调用;审计 helper(normalizeDetailLine/redactLoginDetail)随之归位。第一族示范,handle 全量收编留给后续族迁移。
4. **头注释**:command-registry 补"加新命令三步"(登记 name/guest/audit/stage → dispatch/阶段写处理器 → i18n 双表)。

## User Stories

1. As a 命令作者, I want 每条命令的管线归属在登记表里查得到, so that 不再读六个阶段的正则猜门
2. As a 维护者, I want stage 标注与真实管线有契约测试钉住, so that 标注漂移=测试红
3. As a 维护者, I want pmctl/login 的命令逻辑有住址(dispatch), so that router 阶段壳只管编排
4. As a 桥用户, I want 命令行为逐字节不变, so that 渐进迁移零回归

## Implementation Decisions

- registry 保持**零 import 纯数据**(红线不动):stage 是字符串字面量字段,类型为封闭联合(引用管线阶段名)。
- command-dispatch.ts 注入 {pmctl, auth, sendReply, auditTrail, multiProject?}(login 的 roomAllowed 判定需 ctx 语义——注入判别闭包而非散数据);normalizeDetailLine/redactLoginDetail 迁入(实现决议反转,补评落实:两者定义在 dispatch 并导出,router 的 slashCommands 审计接线反向 import dispatch —— 避免 router→dispatch 后再从 router 导出的反向依赖)。
- 管线 21 阶段结构、顺序、preAuth 语义零变化;阶段名不变(pipeline() 视图测试零改动)。
- /bash 实际走 slashCommands 的 command-map case(非 adminCommands),标注以真实执行路径为准(逐一核对六族正则与 command-map case 后落笔)。

## Testing Decisions

- 既有全量测试零改动通过(行为等价主证据)。
- 新增 tests/command-registry-stages.test.ts 契约测试(stage 合法性/族覆盖)。
- pmctl/login 既有测试(pmctl-controller/router-login 等)经公共入口驱动,零改动。

## Out of Scope

- 其余四族(admin/groupEnable/roomToolsToggle/multiproject)的 handler 迁移(后续族)
- 命令词解析 ×8 的归一(随族迁移逐步做)
- SlashCommandContext 14 槽的瘦身
- stage 与阶段正则的自动一致性校验(正则仍在阶段内;族迁移时再换查表)
