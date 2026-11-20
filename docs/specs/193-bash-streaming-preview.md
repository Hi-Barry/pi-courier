# Spec #193:bash 快捷执行流式输出回帖

> issue: https://github.com/Hi-Barry/pi-courier/issues/193

## 问题陈述(Problem Statement)

`!`/`!!` 快捷执行的 shell 命令在跑动期间,房间里只有一条「⏳ 正在执行」回帖,之后无论跑多久都没有动静——输出要等命令彻底结束才以第二条消息回帖。长构建、长测试这类分钟级命令,用户在 Matrix 里全程失明,与 pi TUI 的实时滚动观感差距很大。

上游机制已经具备:`bash` RPC 请求的 id 会被透传进 `executeBash`,执行期间每个输出块都以 `{ type: "bash_execution_update", id, delta }` 事件推到事件流——桥有 id 可关联在跑请求,只差消费。

## 解决方案(Solution)

`!`/`!!` 发出的 bash 命令执行期间,桥按 id 关联上游 `bash_execution_update` 增量,把输出**流式编辑进那条「正在执行」消息**(Matrix `m.replace` 编辑 + 节流);命令结束后该消息**就地变形为最终回帖**(与今天 `formatBashReply` 逐字节同格式),替代「完成才回帖」的第二条消息。任何编辑失败都降级为新消息回帖——结果永不丢。TUI 观感,一条消息从头跟到尾。

## 用户故事(User Stories)

1. 作为跑长命令的用户,我希望命令输出实时滚动进房间消息,这样不用等结束才知道卡在哪。
2. 作为 `!` 用户,我希望完成后原消息直接变成完整结果(命令 + 输出 + 退出码),房间不被第二条消息刷屏。
3. 作为 `!!` 用户,我希望流式预览同样工作,且带上「未写入上下文」标注,语义不混淆。
4. 作为 E2EE 房间用户,我希望流式编辑照常可用——编辑与普通消息走同一发送通道,加密层自动处理。
5. 作为非 Matrix 部署(活卡编辑缝未注入)的用户,我希望行为与现状逐字节一致,两条消息路径不回归。
6. 作为配置了 `bashOutputLimit` 的用户,我希望预览同样受该钳制,编辑事件不超 64KB 上限。
7. 作为用 `/bashstop` 中止命令的用户,我希望中止后原消息变形为「已中止 + 已捕获输出」,与今天的中止回帖格式一致。
8. 作为遇到 bash 超时的用户,我希望弃权后原消息变形为超时文案(含已等待分钟数),不留一条永远转圈的「正在执行」。
9. 作为 pi 进程重启波及在跑命令的用户,我希望错误文案落在原消息位置,一眼看清哪条命令死了。
10. 作为跑秒级快命令的用户,我希望收不到中间编辑时结果直接一次变形——不多花任何消息与编辑。
11. 作为跑旧版上游(事件不带关联 id)的用户,我希望流式静默不生效、最终回帖照旧送达,不因流式引入新故障面。
12. 作为维护者,我希望编辑节流与活卡聚合共用同一配置口径(`workflowCardThrottleMs`),不新增第二套限速参数。

## 实现决策(Implementation Decisions)

- **唯一新缝——`PiRpc.bash()` 增加可选 `onUpdate(delta)` 回调**:自管应答通道(`bashViaOwnChannel`)的事件 listener 本就按 `bridge_bash_N` 过滤 response,同一 listener 顺带过滤 `type === "bash_execution_update" && id === 自管id` 的事件并把 `delta` 转发给回调。关联 id 不外泄,调用方零拼装。事件不带 id 或 id 不匹配(旧上游、agent 自己的 bash 工具调用)一律不转发。
- **启用条件沿用活卡双注入门**:router 的 `sendLiveCard` + `editReply` 双双注入才启用流式(即 Matrix 部署);任一缺失 → 走现状逐字节的两条消息路径(`router.bang.inProgress` 即时回帖 + 完成后 `formatBashReply` 新消息)。
- **开卡文本不变**:活卡首帧就是现有 `router.bang.inProgress` 文案;后续编辑在该头下追加代码块。预览代码块保**尾部**(对齐 TUI 观感),按 `bashOutputLimit` 钳制;空输出时代码块内为「无输出」占位(复用现有文案)。
- **编辑节流沿用 card-session 的 skip 模式**:距上次编辑不足 `workflowCardThrottleMs`(默认 3s,同一配置函数)跳过本次编辑,后续增量自然补上;终态立即编辑不节流。零新增配置项、零新增 i18n 键。
- **终态变形格式与今天逐字节一致**:成功/中止 → `formatBashReply(...)`;超时 → `bashTimeoutText`;其他错误 → `cmd.bash.error`。`editReply` 失败 → `sendReply` 新消息兜底(结果永不丢,对齐活卡终态降级语义)。
- **审计与记账不变**:进出审计(`bashExec`)与 `bashTracker` 销账时机(`finally`)一律不动。
- **`/bash` 斜杠命令不接入**:它是等待式(处理完才回),本期只动 `!`/`!!`。

## 测试决策(Testing Decisions)

- **纯函数先行**:预览格式化函数与 `formatBashReply` 同居 command-map(单一格式化出口),直接测字符串产出——尾部钳制边界(limit 恰好/超一字符)、空输出占位、`!!` 标注。
- **router 行为测试**沿用 fixture 假件先例(`tests/router-workflow-progress.test.ts` 的 `sendLiveCard`/`editReply` 假件 + `tests/router-bang-bash.test.ts` 的 bang 场景):开卡文本、增量到编辑的传导、节流窗口内跳过、终态变形内容、`editReply` 失败降级 `sendReply`、缝未注入走旧两条消息路径(回归钉)。
- **PiRpc 层**:onUpdate 只收 id 匹配的 delta——旧上游无 id 不转发(钉)。
- 回归门禁按 package.json 原样跑:`npm run typecheck`、`npm run lint`、`npm test`、`npm run build`。

## 不做(Out of Scope)

- `/bash` 斜杠命令的流式回帖(等待式语义,另行决策)。
- agent 会话内自己调 bash 工具的 `tool_execution_update` 流式(router 只记日志,不属快捷执行面)。
- 预览的 ANSI 颜色/控制字符处理(上游 delta 之外的渲染归 Matrix 客户端)。
- 多条并发 `!` 命令的展示合并——每条命令独立一张卡,天然并发安全。

## 进一步说明(Further Notes)

- 上游侧链条已核实(pi-coding-agent 当前版本):RPC `bash` 分支把请求 id 传入 `executeBash` → 每个输出块 `_emit({ type: "bash_execution_update", id: options?.id, delta })`;桥事件流经 `onEvent` 全量可达。
- 64KB 事件上限:预览受 `bashOutputLimit`(默认 30000 字符,硬顶 64KB)钳制,与最终回帖同一钳制来源。
