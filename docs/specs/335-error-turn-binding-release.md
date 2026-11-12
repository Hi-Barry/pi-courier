# Spec #335:错误轮不释放默认回复绑定

> issue: https://github.com/Hi-Barry/pi-courier/issues/335

## 问题陈述(Problem Statement)

真机 2026-11-11:默认进程的某个 Matrix 会话里,用户 09:31 发了一条消息;模型服务返回 429 限流(stopReason=error);pi 自动重试 1/15…6/15 后恢复,继续工具调用,09:38 生成最终回答并写进 pi 会话文件;但房间一直没有收到任何回复。直到用户 10:25 重新发问,10:26 才收到(新的)回答。同机另一个项目会话不受影响——项目房绑定是 pinned。

根因链(已读码复核):

- `src/rpc/message-router.ts:1929-1944` 的 turn_end 处理先算 `isErrorTurn = message.stopReason === "error"`,错误回复本身照常派发(`buildTurnReply` 注入 `router.turn.failed`,文案见 `src/i18n/zh.ts:382`)。
- 终答派发之后进入释放判定 `src/rpc/message-router.ts:2059-2062`:`!turn.pendingTools && binding && !binding.pinned` 且 steering/followUp 队列为空时 `bindings.delete(rpc)`。429 错误轮没有工具调用 → `pendingTools=false` → 默认(未固定)绑定被立即删除。
- 上游时序是关键:`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` 的 `_runAgentPrompt`(:1344)先 `await this.agent.prompt(messages)`(:1354,低层循环在这期间发 turn_end),prompt 返回后才进 `_handlePostAgentRun`(:1356 调用、:1379 定义),其中 `_prepareRetry`(:1390 调用、:2990 定义)才发 `auto_retry_start`(:3003)。也就是说,桥处理错误 turn_end 时 auto_retry_start 还没到,桥不可能用「重试中」标志提前判断。
- 绑定被删后,`auto_retry_start`(:2082)与 `auto_retry_end`(:2099)的 `target` 为 undefined,重试进度回执与「重试耗尽」回执静默丢失;重试恢复后的每个 turn_end 都在 `:1931-1933` 的 no-target 分支 return(只有 debug 日志,INFO 级不可见);09:38 的终答因此被丢弃。10:25 的新消息经 `bindReplyTarget`(:1834,定义见 :359-361)重新绑定,才恢复投递。
- **第二层影响(复核发现,必须一并决定)**:绑定保留后,同一条提示词的后续重试 turn_end 不再在 `:1931` 提前返回,会走到 `:1941` 的 `runFallback`。降级链阈值是 2(`src/rpc/model-switch.ts:70`),其契约注明计数轮是「pi 的 auto-retry 已耗尽或未开」的彻底失败轮(`model-switch.ts:68-69`)。不设防护的话,一次 15 次的 429 重试风暴会在第 2 个 attempt 就中途 `setModel`、发切换回执,并可能把整条降级链烧完——把「pi 正在自己重试」误当成「彻底失败」。现有 `tests/router-fallback.test.ts:51-58` 的 `failRound` 每轮都先 `handleIncoming`,抓不到这个回归。

## 解决方案(Solution)

两部分,缺一不可:

1. **释放条件加「非错误轮」**:错误轮不释放默认绑定,成功轮照旧释放,pinned 与队列非空例外原样保留。这样错误轮之后的重试进度回执、重试轮 turn_end、最终回答都能找到原房间;终态错误(重试耗尽)之后绑定也保留——耗尽回执本来就该发到原房间,而错误轮之后不会再出现属于旧聊天的迟到事件。下一条用户消息到达时重新绑定,旧绑定被覆盖。
2. **降级链侧加重试防护**:`auto_retry_start` 到 `auto_retry_end` 之间的错误轮是重试 attempt,不推进连败计数;只有提示词级的彻底失败才累计阈值(与 `model-switch.ts:68-69` 的文档契约一致)。**同一条提示词内**的 429 重试风暴不切换模型;连续失败的第二条提示词仍按其首个错误轮计数(详见实现决策与代价);重试成功照常清零;重试关闭或不可重试时与 #121 原语义完全一致。

## 用户故事(User Stories)

1. 作为默认进程的 Matrix 用户,我希望 429/限流恢复后的最终回答仍送达发起提问的房间,不用我重新发问来"催"出来。
2. 作为默认进程的用户,我希望重试进度(1/N…)与「重试耗尽」回执也送达房间,而不是因为绑定被删而静默消失。
3. 作为使用降级链的用户,我希望同一条提示词内的自动重试 attempt 不会推进连败、不会在重试中途切换模型或烧完整条链;只有提示词级的彻底失败才累计阈值。
4. 作为默认进程的用户,我希望错误轮本身的失败提示照常收到(行为不变)。
5. 作为项目房用户,我希望 pinned 绑定的释放行为零变化:项目房的回复与回执永远回自己的房间。
6. 作为运行中插话的用户,我希望「队列非空不释放」的既有保护零变化,折叠消息的回复继续送达。
7. 作为桥用户,我希望内容为空的轮次(无文本、无工具)继续保留绑定,后续 turn 的回复不丢。
8. 作为维护者,我希望成功轮仍然释放绑定,迟到的无关事件不会误发到旧聊天(回归钉)。
9. 作为维护者,我希望修复只动「错误轮是否释放」与「重试 attempt 是否计连败」两处,不引入定时器或第二套重试状态机。

## 实现决策(Implementation Decisions)

- **单点释放条件**:`src/rpc/message-router.ts:2059` 的判定加入 `!isErrorTurn`(复用 `:1939` 已算出的值,不重复解析消息)。条件变为:非中间工具轮、非错误轮、绑定存在且未 pinned、队列为空 → 才删除。
- **不引入「重试中」标志来决定释放**:上游时序(`agent-session.js:1354/1356/1390`)决定错误 turn_end 早于 auto_retry_start,桥在处理错误轮时先验地不可能知道要重试;而且不可重试的错误(重试关闭、非可重试错误)根本没有重试事件,标志会永久漏。释放侧唯一可靠的判据是「本轮是错误轮」。
- **重试 attempt 不推进连败(本次第二个明确决定)**:在 `FallbackStreak`(`src/rpc/model-switch.ts:76`)里按 rpc 记录「重试进行中」标记;`recordFailure`(`:81`)在标记期间直接返回 false(不计数、不触发切换)。`auto_retry_start` 处理时无条件 `beginRetry(rpc)`(不依赖 target,重试状态属于进程而非房间);`auto_retry_end` 处理时无条件 `endRetry(rpc)`。
- **防护的时序事实(正常路径)**:成功重试也会发 `auto_retry_end success=true`——上游在成功 assistant 消息持久化时发出(`agent-session.js:759-769`);重试取消走 `_finishCancelledRetry` 的 `success=false`(`agent-session.js:2974-2985`)。这两条正常路径都会 `endRetry(rpc)` 清标记。
- **标记必须能被重启/异常失效(复核发现)**:`auto_retry_end` 不是一定到——/reload 或 pi 子进程崩溃后拉起会复用同一个 `PiRpc` 实例并触发 `onRestarted`(`src/rpc/pi-rpc.ts:506-530`;被杀进程不会补发 auto_retry_end,`drainInFlight` 的 10s 上限也不覆盖整段 agent run,见 `pi-rpc.ts:630-635`),prompt/continue 抛异常逃出 `_runAgentPrompt` 时也只有 finally 的 `agent_settled`(`agent-session.js:1369-1376`)。标记按 rpc 对象驻留(`model-switch.ts:76-102`),不失效就会让该进程的降级链永久静默。因此:
  - `endRetry(rpc)`:只清「重试进行中」标记,保留 runs —— 在 `auto_retry_end` 与 `agent_settled` 事件上调用(后者是每次 run 结束的兜底,含异常路径;router 的 `handleEvent` 已收到该事件并记日志,定义 `:2171`、case `:2179`,在事件链里接 `endRetry` 即可,不新增订阅)。**不可在 agent_settled 清 runs**,否则跨提示词的连败永远凑不到阈值。
  - 把现有 `clear(rpc)` 扩为「清标记 + 清 runs」:它本来就只在非 error 轮调用(`:1942`),语义正好是「无失败状态残留」,同时给标记加第三道保险。
  - 重启时调用同一个 `clear(rpc)` 做全量归零,挂在 `rpc.onRestarted` 上(每 rpc 注册一次,WeakSet 守卫,先例 `liveCardRestartWatched` `:573-576`),对齐 `model-switch.ts:72` 的「重启归零」注释,同时覆盖 /reload 与崩溃拉起。
- **不要用 agent_start 清标记**:上游在每次 `agent.continue()` 开头都会重新发 `agent_start`(bundle chunk 的 run loop:`prompt` 与 `continue` 两个入口都 `emit({type:"agent_start"})`),而重试正是走 continue;用 agent_start 清标记会把防护当场解除。
- **首轮仍计数(并接受它的后果)**:每条提示词的首个错误轮早于 auto_retry_start 到达(时序见问题陈述),桥无法预知是否会有重试,所以它照常计 1;若重试随后成功,成功轮走既有 `clear` 清零,瞬时错误不会跨提示词累积;只有提示词级彻底失败才会在下一提示词失败时凑到阈值。**由此,连续失败的第二条提示词会在其首个错误轮(auto_retry_start 尚未到达)凑到阈值并切换;若它随后进入重试,模型仍可能在风暴中途被切换**——这是 #121 的既有近似,接受并写入代价,不要宣称「任何风暴都不切换」。
- **pinned 项目房的同一修正**:防护在 `FallbackStreak` 内,对项目房同样生效——它们的重试 attempt 此前会推进连败,现在不再推进,与 `model-switch.ts:68-69` 的文档意图一致;pinned 的**绑定释放**行为本身不变。这是有意为之的行为变化,必须由测试钉住(见测试决策)。
- **终态错误也保留绑定**:`auto_retry_end success=false` 的「重试耗尽」回执依赖 `target`(`:2099-2108`),这正是错误可见性(issue #52)的契约——当前默认绑定在耗尽前就被删,这条回执一直是静默丢的,本次一并恢复。错误轮之后不会再有属于旧聊天的新事件(重试已耗尽),保留不引入陈旧投递。
- **重新绑定点不变,但注释必须同步修订**:`bindReplyTarget` 仍在收到消息时执行(`:1834`);`RoomBinding` 的接口与「跟随最新提问者」契约不变。但两处注释在修复后会与实现相反,必须一并改:`src/rpc/message-router.ts:209-220` 的「the shared default rpc's binding releases after one」与释放块注释 `:2048-2057` 的「A completed conversational turn releases unpinned bindings」,改为「成功轮释放;错误轮保留以承接重试回执与终答,直到下一条消息重新绑定」。这是交付的一部分,不是可选清理。
- **明确不变的边界**(全部原样,不得顺手改):
  - pinned 项目绑定永不释放(`!binding.pinned` 保留);
  - steering/followUp 队列非空不释放(2026-10-11 真机事故的防护,`:2059-2062` 内层 `queued === 0` 保留);
  - `turn.fullText === null` 时提前 return、保留绑定(`:1967` 保留);
  - `turn.pendingTools` 的中间工具轮不释放(条件首项保留);
  - fallback 的阈值(2)、链推进、耗尽只提示一次、切换/切换失败/耗尽回执文案全部不变;变的只有「哪些轮计入连败」——重试 attempt 不再计入(见上),提示词级错误轮仍计入;
  - `auto_retry_start` / `auto_retry_end` 的回执逻辑与文案不动(`:2082-2108`);
  - 错误回复本身照发(错误轮仍走 `buildTurnReply` 的失败行);
  - 错误轮绕过活卡聚合(`:1984` 的 `!isErrorTurn`)不动;`hideToolCalls` 口径不动。
- **接受的代价**:①终态错误后若用户不再发言,绑定会驻留到该进程收到下一条任意消息(含其他 DM);窗口内共享进程若有后台事件(如 extension_error、工作流进度),会落到最后提问的房间而不是被丢弃——与 pinned、队列非空例外同性质的取舍。②连续失败的第二条提示词会在其首个错误轮(重试开始前)计数并可能触发 `setModel`;若它随后进入重试,模型在风暴中途被切换——这是 #121 的既有近似,本次不消除。

## 测试决策(Testing Decisions)

- **主用例(必须先红后绿)**:在 `tests/error-visibility.test.ts` 复用现有 `makeFixtures`(`makeMsg` + `makeRouterFixture`,见 `tests/helpers.ts:38/122`)。序列:一条入站消息绑定默认进程 → 错误 turn_end(无文本、`stopReason: "error"`)→ 断言失败回复送达 → 再发一次成功 turn_end(带文本,模拟重试恢复后的终答)→ 断言终答送达同一房间。当前代码第二个 turn_end 走 no-target debug 分支,用例红;修复后绿。
- **错误可见性链路**:错误轮之后依次发 `auto_retry_start`、`auto_retry_end success=false`,断言两条回执都送达原房间;沿用 `tests/error-visibility.test.ts:137-199` 已有的文案锚与断言风格。这是本修复顺带恢复的 #52 契约,必须显式钉住,不能只测终答。
- **fallback 防护单测**:在 `tests/model-switch.test.ts` 新增 `FallbackStreak` 用例(该文件目前只覆盖 `setModelByRef`/`nextFallbackTarget`,见 :14/:60):`recordFailure` → false;`beginRetry`;`recordFailure` ×3 全 false(阈值 2 不被触发);`endRetry`;再次 `recordFailure` → true。直接钉「重试 attempt 不推进连败」。
- **防护失效路径(标记不能永久卡死)**:同文件单测:`beginRetry` → `clear` → `recordFailure` 立即照常计数(runs 与标记都已清);`beginRetry` → `endRetry` → `recordFailure` 照常计数(只清标记、runs 保留)。路由级再补一条:用可收集 `onRestarted` 钩子的 mock rpc(先例 `tests/router-queue-lost.test.ts:27-31`、`tests/recap.test.ts:30-37`)驱动 `failRound` → `auto_retry_start` → 一个被跳过的失败轮 → 手动触发收集到的重启钩子 → 两个失败轮,断言第二个触发 `setModel`(证明标记与 runs 都被清、计数恢复);另发 `agent_settled` 用例:首个错误轮(runs=1)→ `auto_retry_start` → 被跳过的失败轮 → `agent_settled` → 再一个失败轮,断言阈值 2 触发切换(若 agent_settled 误清 runs,这条会红)。
- **fallback 路由回归**:`tests/router-fallback.test.ts` 新增一个不先 `handleIncoming` 的失败轮驱动(与现有 `failRound` 并列):`failRound()`(提示词级第 1 次失败)→ `auto_retry_start` → 连续 2~3 个错误 turn_end(中间无新入站消息)→ 断言 `setModel` 未被调用、房间无切换/耗尽回执 → `auto_retry_end success=false` → 仍无切换 → 再来一条新入站消息并失败 → `setModel` 恰好调用一次(提示词级第 2 次彻底失败)。同一驱动再加一个 pinned 绑定(项目房)用例,断言重试 attempt 同样不推进。注意:该用例对默认房在当前代码上是「假绿」(第 2 轮起被 no-target 丢弃),对 pinned 房是真红(现状会在第 2 个 attempt 切换);它是防护的钉子,主红绿仍是上面的终答用例。
- **回归钉(成功轮仍释放)**:绑定一次 → 成功 turn_end → 再发一个没有新入站消息的 turn_end,断言成功回答只送达一次(第二次因无 target 被丢弃)。既有 `tests/router-projects.test.ts:439` 已用 extension_error 钉成功轮释放与 pinned 对照,保持原样;新增用例改用 turn_end 补钉同一语义。
- **必须同步修改的既有用例**:`tests/error-visibility.test.ts:89` 的标题和注释(:102)钉的正是「错误轮释放默认绑定」这一 bug 行为,修复后必红;改为「错误轮保留默认绑定」的断言(失败行送达 + 后续事件仍送达)。只改该用例的预期,不放宽同文件其他断言。
- **空内容边界的路由证据更正**:路由级保护在 `tests/router-livecard.test.ts:150-171`(aborted 空轮之后不新入站,下一个工具中间轮仍能路由到原房间);`tests/router-projects.test.ts:179` 只是 `buildTurnReply` 的纯单测(标题虽写 binding must be kept,并不覆盖路由),:514 是日志测试——二者不再被当作该边界的路由证据。
- **既有测试零改动**:`tests/router-fallback.test.ts` 的 `failRound`/`okRound` 回合驱动(每轮先 `handleIncoming` 重新绑定)不受影响——修复后失败轮保留绑定,但下一轮入站消息会把同一 target 重新绑定;且这些用例从不发 auto_retry 事件,防护标记不生效,连败计数与回执断言全部照旧。`tests/router-projects.test.ts:439`(成功轮释放 + pinned)与 `:468`(队列非空不释放)保持绿。
- **命令**:先 `npx vitest run tests/error-visibility.test.ts` 看主用例红;修复后 `npx vitest run tests/error-visibility.test.ts tests/router-fallback.test.ts tests/router-projects.test.ts tests/router-livecard.test.ts tests/model-switch.test.ts` 全绿;再跑仓库原样门禁 `npm test`、`npm run typecheck`、`npm run lint`。
- 不做真机 Matrix 集成测试:事件时序由单测按生产顺序驱动(错误 turn_end → auto_retry_start → 重试轮 turn_end → auto_retry_end)即可稳定复现。

## 不做(Out of Scope)

- 不做基于定时器/延时的重试状态判断:上游时序不允许先验判断(见实现决策);释放侧只认「错误轮」,计连败侧只认 auto_retry 起止事件,外加 run 结束(agent_settled)与重启(onRestarted)的失效兜底。
- 不改 fallback 的阈值、链推进、回执文案与 i18n 双表;重试 attempt 计数的防护属于本 spec(见实现决策),不另立需求。
- 不改共享进程模型(每 DM 一个进程的内存代价已在 spec #3 否决);跨聊天迟到事件属于该模型的既有协议限制。
- 不改释放条件的其他成分(pinned/队列/pendingTools/fullText)。
- 不处理「错误轮之后、下一条消息之前」后台事件的路由精度(见实现决策的代价说明),也不追求「提示词首个错误轮是否会被重试救回」的精确判定(见实现决策的首轮计数说明)。
- 跳过 to-tickets:改动仍集中(一个释放条件、`FallbackStreak` 的一处防护、对应测试;两个产品文件),属于 AGENTS.md 允许的小任务豁免;理由记录于此,不再拆票。

## 备注(Further Notes)

- 真机证据链(2026-11-11):09:31 消息 → 429 → 自动重试 1/15…6/15 → 09:38 终答写入 pi 会话文件 → 房间无消息 → 10:25 重新发问 → 10:26 收到新回答;同机项目房(pinned)全程不受影响。日志层面丢失点只有 `turn_end dropped: no replyTarget bound` 的 debug 行,INFO 级看不到,现场很难归因,这也是此前一直没被发现的原因。
- 复核记录(2026-11-12 第一轮):保留绑定会让同一提示词的重试轮进入 `runFallback`(`message-router.ts:1941`),阈值 2 意味着 429 风暴会在第 2 个 attempt 中途切换模型并可能烧完整条降级链;现网 pinned 项目房已经存在这一行为(本次防护顺带修正)。现有 `router-fallback` 用例每轮先 `handleIncoming`,覆盖不到无入站的重试序列,故新增专用驱动。
- 复核记录(2026-11-12 第二轮):重试标记必须有失效路径——/reload 或崩溃拉起复用同一 `PiRpc` 实例(`pi-rpc.ts:506-530`)且被杀进程不会补发 auto_retry_end,prompt/continue 异常逃出 `_runAgentPrompt` 时也只有 finally 的 `agent_settled`(`agent-session.js:1369-1376`)。因此 `agent_settled` 只清标记、`onRestarted` 走 `clear` 做全量归零(对齐 `model-switch.ts:72`「重启归零」),两者各配测试。原稿「429 风暴期间模型保持不变」绝对化,已收窄为「同一条提示词内」;连续失败的第二条提示词在首个错误轮触发切换属 #121 既有近似,已写入代价。
- 上游依赖:本次修法依据 `pi-coding-agent` 的 `_runAgentPrompt` / `_handlePostAgentRun` / `_prepareRetry` 顺序,以及 `auto_retry_end success=true` 在成功 assistant 消息持久化时发出(`agent-session.js:759-769`)、`agent_start` 在每次 `continue` 重发。若上游将来调整这些时序,本规则仍成立(错误轮不释放、重试 attempt 不计数都是更保守的规则),但可重新评估是否能用精确状态收窄保留窗口。
- 关联:#52(错误与重试进房间)、#121(连败计数与降级链)、2026-10-11 队列事故(队列非空不释放)。
- 修订流程:后续修订用 `gh issue edit` 更新本 issue,不重复建号。