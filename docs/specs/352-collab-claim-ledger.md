# Spec #352:collab 认领簿记域入口——ClaimLedger 收口 + 信箱/登记簿归位

> 来源:架构评审 2026-11-16 卡3(Strong)。spec #299 仍在活跃期,现在收最便宜。

## Problem Statement

理解一次认领要在 6 个文件之间跳:`pendingClaims`/`claimRejectedKeys`/`unknownNotifiedRooms` 三个簿记是 config 上的裸数组,写侧纪律(「落盘前重读防并发」「上限收敛」「按对象身份过滤防吞并发新增」)全部靠注释维持,读写散在 router 的 unknownRoomGate 与 pmctl-controller 两处;`collab/` 目录名下只剩 git 探测,而协作的两个核心小模块(信箱 RoomMailbox、bot 登记簿 BotRegistry)住在 `rpc/`。

## Solution

- **`collab/claim-ledger.ts`**:认领簿记的唯一属主。读侧 `claims/hasPendingClaim/isRejectedFor/hasNoticed`,写侧 `recordClaimCard/recordNotice/rejectClaimAt/removeClaimForRoom`;「落盘前重读」「上限(pendingClaims 50、键/房 200)」「按对象身份过滤」全部内化,调用方只调 API。
- **归位**:`src/rpc/mailbox.ts` → `src/collab/mailbox.ts`;`src/rpc/bot-registry.ts` → `src/collab/bot-registry.ts`(纯移动,内部相对导入随之调整)。
- **config 形状不变**:`types.ts` 的 collab 段与 `PendingClaim` 保持原样(落盘向后兼容)。

## User Stories

1. As a 维护者, I want 认领簿记的读写纪律(并发重读/上限/身份过滤)只有一个属主, so that 认领流 bug 验证从跨 6 文件收敛到一个模块
2. As a 维护者, I want 信箱与 bot 登记簿住进 collab/, so that 协作域的概念有单一住处
3. As a 部署者, I want config 落盘形状不变, so that 升级零迁移
4. As a pmctl 用户, I want /pmctl claim 的确认/拒绝行为逐字节不变, so that 收口零回归
5. As a guest 房用户, I want 陌生房提示/认领卡的去重语义不变, so that 不重复刷屏也不死锁

## Implementation Decisions

- `ClaimLedger` 构造注入 `ConfigStore`(type-only import,不引运行时依赖);不加新缝——store 既是既有缝。
- router unknownRoomGate:簿记读写全部换 ledger 调用;`unknownNoManagementWarned`(内存 Set,提示送达前不标记)是日志去重关注点,留在 router。
- pmctl-controller:删私有 `updatePendingClaims`/`pendingClaims`,确认/拒绝走 ledger;拒绝从「两次 update」合并为「一次 update」(终态等价,写原子性更好)。
- **顺带修(同类问题,评审审计意图的漏网)**:router 的 pendingClaims 追加此前无上限(任务2 审计整改只给 pmctl 写路径加了 50 上限)——ledger 统一 50 上限,消灭批量拉房膨胀配置文件的残余面。
- 信箱/登记簿纯移动:导出名、行为、测试全不变。

## Testing Decisions

- 既有 tests/pmctl-controller.test.ts、tests/router-collab-gate.test.ts、tests/mailbox.test.ts 全数保持通过(它们钉住了全部可见行为)。
- 新增 tests/claim-ledger.test.ts:上限收敛(50/200)、并发重读(update 间插入写不丢)、拒绝身份语义、reject 索引越界。

## Out of Scope

- 信箱 drain→refund 消费协议的位置(prompt 阶段编排属 router 职责)
- claimRejectedKeys 的键格式变更
- ProjectManager/BotRegistry 消费面收窄(评审卡6,单独处理)
