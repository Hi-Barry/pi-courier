# Spec:/update 热更新命令族 —— 任务不中断的桥自更新

- **状态**:定稿待实现(历经六轮独立评审共 19 条意见全部修订落纸;第六轮 3 条由编排者按评审员给定的修法直接修订并自查,用户终审拍板进实现)
- **日期**:2026-10-27
- **分支**:`feat/hot-update-command`(从 develop 切出),PR 目标 `develop`
- **与项目 spec 约定的关系**:`docs/agents/issue-tracker.md` 约定 spec 存 GitHub issue(标题 `[Spec] <主题>`);本文是本地可实施版,定稿后可按该模板同步开 issue,子票按 `票 N(issue #M)` 拆分。

---

## 1. 背景与问题陈述

pi-courier 是 Matrix ↔ pi coding agent 的桥接服务(systemd 常驻)。现状 `pi-courier update` 是**停机更新**:`src/cli.ts:325-403`(`cmdUpdate`)先 `systemctl --user stop` 再升级再 start——正在跑的 pi 任务会被杀。

目标:新增 Matrix 管理房 `/update` 命令族,把"换磁盘代码"(桥进程代码已在内存,npm 升级窗口任务照跑)与"重启进程"(挑全空闲时刻,秒级窗口)拆成两步,实现任务不中断的更新。

## 2. 目标

1. 管理房 `/update` 命令族:`check` / 无参(编排)/ `force` / `cancel`,仅管理房 + 信任用户可用。
2. 更新期间桥照常服务:忙时等待 → 桥内换血(npm 升级窗口)→ 全空闲时秒级重启。
3. 回执闭环:`pending-update.json` 落盘,新进程启动时向管理房发"更新完成 vX→vY"。
4. 全程审计(发起/取消/完成)+ 并发保护(更新进行中再发即拒)。

## 3. 非目标(明确不做)

- **自动定时检查新版**(后续票)。
- **CLI `pi-courier update` 的改造**(`src/cli.ts` 的 `cmdUpdate` 保持现状;桥侧不 import `cli.ts`——它在模块加载即跑 `main()`,`src/npm-runtime.ts:11` 注释明文"Kept free of cli.ts imports")。
- **`develop → master` 发版**(须用户拍板)。
- **等待期间消息管道的任何改动**:等待期新消息照常进 followUp 队列(现有机制,勿动)。
- **pi 子进程(pi coding agent 本体)的更新**:只更新桥自身。

## 4. 命令族语法

| 命令 | 语义 | 忙时行为 |
|---|---|---|
| `/update check` | 只查版本不动手 | 随时可发(只读) |
| `/update` | 有新版则编排更新 | 忙则预告 + 等待 |
| `/update force` | 跳过忙时等待,直接编排 | 不等待(但安装后仍须等全空闲才重启,见 5.5) |
| `/update cancel` | 取消进行中的等待 | — |

**参数铁律**:一律不接受版本号 / URL / 本地路径 / git ref。唯一来源锁死为 npm registry 的 `latest` 标签;带任何其他多余参数直接拒绝(`cmd.update.rejectedArgs`)。这是安全防线:防信任账号被盗后借命令装恶意包。

**入口与权限**(全部在桥侧,不透传 pi):

- 命令分发:`src/rpc/command-map.ts` 的 `handleSlashCommand` switch(`src/rpc/command-map.ts:603` 起)新增 `case "/update"`。命令名已统一小写分发(`src/rpc/command-map.ts:599`),`/Update` 等大小写变体天然覆盖。
- 访客拦截:`src/command-registry.ts:38-80` 的 `COMMAND_REGISTRY` 登记后,`src/auth/guest-policy.ts:35` 的查表裁决(`commandPolicy(name)?.guest === "blocked"`)自动在 `authorizationGate`(`src/rpc/message-router.ts:899-908`)硬拦访客并落 `guest.denied` 审计。
- **管理房约束**(registry 的 guest 位管不到,命令层自判):`SlashCommandContext` 新增 `adminRoom?: boolean`,由 router 的 slashCommands 阶段按 login 先例(`src/rpc/message-router.ts:1036-1041`)计算:`ctx.multiProject ? ctx.isManagementRoom : !ctx.msg.isGroupChat`。**不能直接传 `ctx.isManagementRoom`**:它在 `managementAdoption` 阶段赋值为 `ctx.multiProject && managementRoomId(store.get()) === ctx.msg.chatId`(`src/rpc/message-router.ts:993`),而 `multiProject` 是可选字段、默认 false(`src/types.ts:114`)——单工程部署(恰是 systemd 常驻单实例的主场景)下恒 false,照传会让 /update 成为死路且文案指路一个不存在的管理房。单工程语义照 login 的既定口径:单工程没有管理房,**DM 即管理房**(同处注释原文 "Single-project mode has no management room: a DM counts as one");单工程群聊与多工程非管理房 → `cmd.update.notManagementRoom`。异步回执(预告/进度/升级与重启各回执)一律发往**发起时捕获的原房间 chatId**,不以 `managementRoomId` 为发起守卫(见 §11.9)。
- 能力插槽:`SlashCommandContext` 新增 `updater?` 插槽(注入形态参照 `ctx.recap`,`src/rpc/command-map.ts:64-68`;Absence = 未装配,回 `cmd.update.unavailable`,**不落回 pi**——落回会把命令文本喂给模型)。

## 5. 编排状态机(全部在桥进程内)

```
                 ┌────────────────────────────────────────────────┐
                 │ idle ──/update(check/无参/force)───────────────│──→(见下)
                 └────────────────────────────────────────────────┘
   (命令处理同步段固定顺序:①子命令分派(check/cancel)→②同步守卫链(root/管理房/参数)→③编排分支 CAS 占位 idle→checking,占位失败即 inProgress 拒绝;全部零 await——§5.3/§5.7)
 /update check ──→ 查版本 ──→ 回"已是最新"或"有新版",状态不变
 /update 无参   ──→ 查版本 ─┬─ 无新版/检查失败 → 回执,回 idle
                            ├─ 有新版且全空闲 ──────────→ installing
                            └─ 有新版且忙(非 force;在跑 N>0 或 unreachable U>0)
                                            ──→ waiting(预告 + 可附 unreachableNote)
 /update force  ──→ 同上,忙也直接 → installing(不等待)
 waiting ─┬─ 全空闲 → installing
          ├─ 30 分钟超时 → 回执"已取消(可 force 重试)" + audit update.cancel → idle
          └─ /update cancel → 回执 + audit update.cancel → idle
          (期间每 5 分钟向发起房间报进度)
 installing ─┬─ npm/git 升级失败 → 回执错误,旧版继续运行 → idle
             └─ 成功 → 回执"代码已上磁盘" → restart-pending(第二段空闲确认)
 restart-pending ─┬─ 全空闲 → 写 pending-update.json → systemctl --user restart
                  ├─ 超时 / cancel → 写 pending-update.json + 回执"请手动 restart" → idle
                  └─(同款 30 分钟上限与 5 分钟进度;文件写好 = 手动重启后照样闭环回执)
 新进程启动 → consumePendingUpdate → 校验 → audit update.done → 管理房"更新完成 vX→vY" → 删文件
```

### 5.1 root 拒执行

`process.getuid?.() === 0` 时拒绝(`cmd.update.rootDenied`,提示改用手动停机更新)。防 npm postinstall 提权。Windows 无 `getuid` → `getuid?.()` 为 `undefined`,自然放行。**check 不受此限**(只读查询无害)。

### 5.2 版本检查(纯函数 + fetch)

- fetch:`https://registry.npmjs.org/pi-courier/latest`(npm dist-tag 端点,响应 JSON 含 `version` 字符串)。用 **undici 的 fetch**(`package.json:62` 已有依赖 `undici ^8.12.2`;经 `src/proxy.ts:151-154` 换装后的同一 undici 实现,出网代理自动生效)。请求带 10 秒超时(`AbortSignal.timeout(10_000)`)。
- 当前版本:`readBridgeVersion()`(`src/version.ts:12-22`,每次现读磁盘 `package.json`——npm 升级后返回新版本,编排器须在 `installing` 开始时自行记住 `from`,不得升级后重读)。
- 纯函数 `parseLatestVersion(body: unknown): string | undefined`:取 `version` 字段,必须匹配 `/^\d+\.\d+\.\d+$/` 才返回(防注入:该值后面要拼进回执文案)。校验失败 = 检查失败。
- 纯函数 `isNewerVersion(candidate, current): boolean`:按 major/minor/patch 数字比较(不引第三方 semver 依赖);candidate ≤ current → 无新版。**前置守卫:两参都必须已通过 `/^\d+\.\d+\.\d+$/` 校验**(比较按数字三段展开,不存在 NaN 路径)。
- 失败分支:网络失败 / 超时 / JSON 解析失败 / registry `version` 字段校验失败 / **当前版本不可得**(`readBridgeVersion()` 返回 `undefined`——`src/version.ts:12-22` 对任何读盘/解析失败 catch 后返回 `undefined`,须在 fetch 前先取并判空)→ `cmd.update.check.failed`(detail 带原因),不编排。

### 5.3 忙闲判定与等待(waiting)

- **全实例忙闲原语**:`src/rpc/command-map.ts:362-372` 的 `waitForAgentIdle` 是单实例轮询原语(`//interrupt` 依赖它,`src/rpc/command-map.ts:791`;其轮询而非订阅的竞态理由见 354-361 行注释——**必须保持轮询,不改成事件订阅**)。新增同款全实例变体 `waitForAllAgentsIdle(rpcs, options)`:每 tick 对每个 rpc 经 `rpc.requireClient().getState()` 取 `isStreaming`(PiRpc 自身无 `getState()` 包装,先例 `src/rpc/command-map.ts:280,322`;`requireClient()` 在未连接时**同步抛** `"pi RPC not connected"`,`src/rpc/pi-rpc.ts:666-674`),150ms 间隔与现有一致,全部实例**确认**空闲才返回。**单实例查询抛错的失败分支**(默认进程未连接(启动早期 / pi 进程崩溃后),或项目进程 `restart()` 的 stop→start 窗口——**lazy 未启动的项目进程不在内**:`allRpcs()` 的注释明文 "Not-yet-started projects are absent by design"(`src/rpc/project-manager.ts:118-124`),未启动的根本不在返回值里、计不进 unreachable):该实例计入 `unreachable`,**该 tick 不视为全空闲**——安全优先,确认不了空闲就不重启,宁多等不误杀任务;「查不动的实例单独记账、不混入判定」的口径先例见 `restartIdleRpcs` 的 catch→skipped(`src/rpc/command-map.ts:288-290`)。`options.onTick?({ streaming, unreachable })` 供预告与进度回报(unreachable > 0 时附 `cmd.update.unreachableNote`);`options.shouldAbort?: () => boolean` 供 cancel;`timeoutMs` 超时抛类型化错误,detail 带最终 `streaming`/`unreachable` 计数(便于区分「任务真没跑完」与「实例挂了导致的假等待」)。单实例 `waitForAgentIdle` **保持不动**(`//interrupt` 的语义与既有验收不破坏)。
- 实例全集:`ctx.allRpcs()`(`src/rpc/command-map.ts:71`,router 侧接线为 `projectManager.allRpcs()`,`src/rpc/message-router.ts:1094`)——默认进程 + 全部项目进程。
- 发起时对全集做一次同款探测(单实例 try/catch,`streaming`/`unreachable` 两本账):N = streaming 数,U = unreachable 数。**三分支,不许落空**:
  - N > 0 且非 force → 向**发起房间**(发起时捕获的 chatId,§11.9;下同)预告 `cmd.update.busyWaiting`(含 N、30 分钟上限、"期间消息照常排队";U > 0 追加 `cmd.update.unreachableNote`)→ 进入 waiting;
  - **N = 0 且 U > 0 且非 force → 同样进入 waiting**(预告用专用键 `cmd.update.waitingUnreachableOnly`——主句直说「无法确认实例空闲」,不用 busyWaiting 渲染出「0 个任务在跑,全部完成后自动开始更新」的自相矛盾文案):查不动的实例不是**可确认的**空闲——否则「默认进程未连接 / 项目进程 restart stop→start 窗口」会被直接卷进安装+重启,违背本节「确认不了空闲就不重启,宁多等不误杀」;
  - N = 0 且 U = 0(真全空闲)→ 直接 installing;force 恒跳过等待直接 installing(换血无害,重启另有 §5.5 的 restart-pending 空闲确认兜底——那里 U > 0 照旧不算空闲)。
- **handler 返回契约与同步段固定顺序**:`case "/update"` 的同步段按固定顺序执行,**全部零 await**:①**参数分派**——识别 check / cancel / 无参 / force 子命令,分派先于占位(check 只读不占位;cancel 在任何态都须可处理——若占位先行,waiting/checking 态的 cancel 会撞「占位失败 → inProgress」被误杀,取消功能整体失效);②**同步守卫链**——root 拒绝(§5.1,check 豁免)、管理房约束(§4)、参数合法性(§4 参数铁律),全部先于占位:这些分支同步 return,若占位先行而守卫拒绝不复位,状态机永久卡 checking(防线 7 反向锁死直至重启进程);先于占位则拒绝路径根本未占位、零残留,拒绝后 /update 可立即再次发起;③**编排分支(无参/force)执行同步 CAS 占位**(`idle → checking`,失败 = 已有编排 → `cmd.update.inProgress` 拒绝)。占位先于一切 await:管道对并发斜杠命令无串行化(每条消息独立 `await handleSlashCommand`,`src/rpc/message-router.ts:1089`),而探测与 check 的 fetch 都有 await 窗口(check 最长 10s)——若占位晚于首个 await,同窗口内的第二条 `/update`(含 force)会照常通过守卫并启动第二套编排,双后台循环竞写同一单例状态机、双 npm spawn 竞争全局安装,击穿防线 7。此后才允许探测/check 的 await;check 结束或不编排 → 占位释放回 `idle`。
- 占位后的返回时机:同步段(分派/守卫/占位)与预告回执完成后**立即返回 `true`**。理由:router 的 slashCommands 阶段同步 `await handleSlashCommand`(`src/rpc/message-router.ts:1089`),登记表审计在其 resolve 之后才落账(`src/rpc/message-router.ts:1137-1141`),失败回执走其 generic catch(`src/rpc/message-router.ts:1143-1150`)——若 await 整个编排,该条消息的调用栈会挂住最长约 60 分钟(waiting 30min + installing 数分钟 + restart-pending 30min):发起审计迟到落账、失败回执错走迟到的 generic catch、force 直进 installing 时 npm 窗口内该消息无回执。因此等待/安装/重启等待循环由编排器**后台驱动**(`void` 挂起,不 await 进 handleSlashCommand 调用栈),后续回执经预绑定的发起房间缝异步发送;后台循环的自身异常由编排器捕获并经发起房间回执(如 `cmd.update.npmFailed`),**不外抛**进命令调用栈。
- **占位释放契约**:从 CAS 占位到状态进入 waiting/installing(或 check 结束回 idle)之间的一切 await(全实例探测、check fetch、预告回执发送)必须包在 try 内,**任何异常先同步复位 idle 再上抛**(让 generic catch 接手该条消息的回执)——漏 finally 即状态机永久卡在 checking/waiting,此后所有 /update 永久 inProgress(防线 7 反向锁死,直至重启进程)。**同步守卫拒绝路径无释放负担**:root/管理房/参数守卫先于占位(handler 返回契约②),拒绝时从未占位,零残留。后台循环一经启动,释放责任移交后台循环(其自身异常自捕,见上条)。
- 等待参数:`UPDATE_WAIT_TIMEOUT_MS = 30 * 60_000`,`UPDATE_WAIT_PROGRESS_MS = 5 * 60_000`(常量可注入,测试用短值)。
- 进度:每满 5 分钟 → 发起房间 `cmd.update.waitProgress`(当前在跑数 + 已等分钟数)。
- 失败分支:
  - **超时**:回执 `cmd.update.waitTimeout`(提示可用 `/update force` 重试)+ audit `update.cancel`(actor 记原发起人,detail 注明 `wait timeout`)→ idle。
  - **`/update cancel`**:回执 `cmd.update.cancelled` + audit `update.cancel` → idle。无进行中更新时 cancel → `cmd.update.noPending`。

### 5.4 桥内换血(installing)

新模块 `src/update/upgrade.ts` 执行升级,**异步 spawn**(桥不能阻塞事件循环——`cli.ts` 用 `spawnSync` 是 CLI 语境,桥内必须 `spawn` + promise 包装):

- **安装方式检测**(与 `src/cli.ts:327` 同款判定,在新模块自持):`installedViaNpm = !fs.existsSync(path.join(projDir, ".git"))`。
- **npm 路径**:`node <npm-cli.js> install -g pi-courier@latest --foreground-scripts`,复用 `resolveNpmCli(process.execPath)`(`src/npm-runtime.ts:27-37`;解析失败回落裸 `npm`,与 `src/cli.ts:319-323` 的 `npmCommand` 同款);E2EE 原生库已存在时追加 `--ignore-scripts`(与 `src/cli.ts:355-361` 的 `e2eNativeBinaryExists` 同款判定,新模块自持,注释交叉引用 `cli.ts` 对应实现——两处语义须同步演进)。
- **git 路径**(git clone 安装):`git pull` → `npm install` → `npm run build`,逐步执行,cwd 为项目根(与 `src/cli.ts:373-377` 同款)。
- 窗口几分钟,桥照常服务;期间 `/update`(含 force)→ `cmd.update.inProgress` 拒绝;`/update check` 照常放行。
- **挂死兜底**:`UPGRADE_TIMEOUT_MS = 30 * 60_000`(与忙闲等待上限同量级,可注入)——升级命令无内置超时(`git pull` 无超时、npm 锁等待可无限挂),挂起即 installing 永久占用、/update 族永久 inProgress;超时 → kill 子进程 → 按下方失败分支处理。
- 失败分支:spawn 出错 / 非零退出 / **超时被 kill** → 发起房间 `cmd.update.npmFailed`(含 stderr 摘要),**旧版继续运行、桥绝不自杀**(安全失败),状态回 idle。
- 成功 → 发起房间 `cmd.update.installed`(from → to,"当前进程仍跑旧版")→ 进入 `restart-pending`(第二段空闲确认)。

### 5.5 空闲重启(restart-pending → restart)

- 升级成功后进入 **`restart-pending`**(状态机第五态,序列 idle→checking→waiting→installing 之后):再验全实例空闲(npm 窗口期间可能有新任务进来),复用 5.3 同一等待原语与参数,但预告/进度用**本态专用键** `cmd.update.restartWait` / `cmd.update.restartProgress`——换血已完成、只剩等空闲重启,busyWaiting「全部完成后自动开始**更新**」与 waitProgress「**更新**等待中」在本态语义错位;超时回执本态本就是 manualRestartHint 而非 waitTimeout(见下)。本态的 cancel 语义不同,见 5.7。
- 全空闲 → 顺序执行(**顺序即契约**):
  1. **先写** `~/.pi/pi-courier-state/pending-update.json`(`{ from, to, startedAt }`;目录 `src/standalone.ts:317-322` 已 0700)。**写入必须可感知成功**:`PendingUpdateStore.write()` 不走 `JsonStateFile.save` 的吞错契约(`src/state/json-file.ts:68-92` catch → logger.warn 永不抛——那是状态文件「磁盘是备份」的降级语义),自持可抛的原子写(tmp + rename,0600/0700,形态同 JsonStateFile 但失败上抛;或写后 `read()` 回读校验)。**写失败 → 放弃自动重启**:降级回执 `cmd.update.manualRestart` + 状态回 idle(代码已在磁盘,手动重启加载新版,仅丢完成回执)——照旧触发重启会让回执静默丢失,恰是本顺序要防的事故。**先于重启触发**——文件没落盘就被重启,回执就丢了。
  2. **await 回执落定**:向发起房间发送 `cmd.update.restarting` 并等 Promise resolve。必须先于步骤 3:detached spawn 立即返回后,`systemctl` 的 stop 可在本进程完成 Matrix 发送(网络往返)之前 SIGTERM 掉桥进程——先发后杀不钉死,回执闭环里最关键的一条会间歇性丢失且测试不可复现。
  3. **触发重启(Linux 且单元 active 才走)**:`serviceManagementSupported(process.platform)`(`src/systemd-hint.ts:21-23`,仅判平台)**加** `systemctl --user is-active pi-courier` 前置探测(异步 spawn + promise,`stdout.trim() === "active"`,CLI 先例 `src/cli.ts:334-341` 的 wasActive 门)→ 两者都满足才 `spawn("systemctl", ["--user", "restart", "pi-courier"], { detached: true, stdio: "ignore" }).unref()`(必须 detached + unref:重启会杀死本进程,spawn 须脱离父进程存活)。**只判平台不判 active 会误伤非单元部署**:桥以手动 `node dist/standalone.js` 运行(或单元存在但被 disable)时,restart 会把单元拉起,新实例撞 PID 锁立即退出(`src/standalone.ts:92-95` + `src/lock.ts:83` fail-closed),留下 failed/重启风暴的单元而旧版进程继续服务,与命令承诺相反。
  4. 非 Linux / 无 systemd / **单元非 active / is-active 探测失败**(如 systemctl 不存在,安全默认)→ 回执 `cmd.update.manualRestart`("代码已更新到磁盘,本桥未由活动的 systemd 单元管理(或平台无 systemd),请手动 pi-courier restart 生效",降级不报错)。
- 失败分支:
  - `restart-pending` 超时 / 被 cancel:**文件照写**(用户之后任何一次重启——自动或手动——都会触发完成回执闭环),回执 `cmd.update.manualRestartHint`(代码已上磁盘,请空闲后手动 restart)+ audit `update.cancel` → idle。**不回滚**:换血已完成,取消的只是"自动重启"这半步。此处写失败不阻断任何事(该路径本就不自动重启),manualRestartHint 照发、闭环静默缺失仅 warn 留痕。
  - `systemctl` spawn 出错 / 非零退出:文件已写,回执 `cmd.update.restartFailed`(手动 `pi-courier restart` 即可,重启后回执闭环)→ 状态复位 idle(进程还活着)。

### 5.6 回执闭环(新进程启动消费)

新文件 `src/update/pending-update.ts`,**consume-once 先例**照 `src/rpc/queue-snapshots.ts:57-66,100-129`(`loadValid` 过滤畸形 → 消费 → `clear()`):

- `PendingUpdateStore`:**读侧**经 `JsonStateFile<PendingUpdateEntry | null>`(fallback `null` = 无待处理更新)取 shape guard;**写侧**不用 `JsonStateFile.save`(fire-and-forget 永不抛,`src/state/json-file.ts:68-92`)——见 §5.5 步骤 1 的可感知写契约。`read()` 校验条目 shape(`from`/`to` 均过 `/^\d+\.\d+\.\d+$/`,`startedAt` 为数字;畸形 = 视作无更新并 warn)。
- `consumePendingUpdate(store, consumer)`:启动期调用一次。有有效条目 → `consumer.send(managementRoomId(store.get()), text)`(best-effort,失败仅 warn)**无论成败都销账**(consume-once 契约:错过一条通知好过永远重试,与 `queue-snapshots.ts:61-66` 同理由)→ 落 audit `update.done`(actor `"system"`,chatId = 投递目标或空串)→ `store.clear()`。**单工程语义**:此时 `managementRoomId` 为 `undefined`(§11.9——收养只在多工程发生),且新进程没有"发起房间"上下文、单工程房间绑定是运行时 DM 不可猜(与 queue-snapshots 只覆盖项目房的保守路线同一理由)→ **跳过发送,审计照落、照旧销账、warn 留痕**;完成回执对单工程的替代面是重启前的 `cmd.update.restarting`(发起房间,§5.5 步骤 2)与日志。
- 回执文案:磁盘实际版本 `readBridgeVersion()` 为准——`cmd.update.done`("更新完成 vX→vY");实际版本 ≠ 条目 `to` 时追加 `cmd.update.doneVersionMismatch`(可能未生效,请检查)。
- 消费点:`src/standalone.ts` 启动消费区,`consumeQueueSnapshots`(`src/standalone.ts:467-478`)之后、同样以 `matrix?.isConnected` 为前置(连不上留待下次成功启动,与队列快照同契约)。

### 5.7 并发保护与 cancel 分态语义

- 编排器进程内单例状态:`idle | checking | waiting | installing | restart-pending`(五态)。占位是编排分支(无参/force)在**同步守卫链之后、一切 await 之前**的**同步 CAS**(`idle → checking`,JS 单线程下同步比较-交换原子;子命令分派与同步守卫先于占位,§5.3 handler 返回契约):占位失败 = 已有编排,含 check 窗口内的并发第二条 → `cmd.update.inProgress` 拒绝;`waiting`/`installing`/`restart-pending` 期间再发 `/update`(含 force)同拒。force 只跳过忙时等待,**不是重入许可**。
- check 随时可发(只读,自身不占位、不 CAS)。cancel **分派先于占位**(§5.3 handler 返回契约①——waiting/checking 态的 cancel 不经过 CAS,不被 inProgress 误杀),按当前态分派,**判定与置位必须同步完成于一切 await 之前**(同步读态 → 同步置位 → 之后才 await 回执/写文件;实现规约:回执后置禁止,或状态转移前重验当前态/代次):若先 await 取消回执再置 idle,await 窗口内后台轮询恰好转 installing 并启动 npm 升级,迟到置位会把状态机打回 idle,第二条 /update 随即通过 CAS 启动第二套编排(双 npm spawn,击穿防线 7):
  - `checking` → `cmd.update.noPending`(check 还没结论、无等待可取消;check 结束即释放占位);
  - `waiting`(换血前)→ 取消等待,回 idle,audit `update.cancel`;
  - `installing`(换血窗口)→ 拒绝(`cmd.update.inProgress`)——代码换血不可中断、无回滚路径,状态不变;
  - `restart-pending`(已换血)→ 放弃自动重启但**不回滚**:写 `pending-update.json` + 回执 `cmd.update.manualRestartHint` → idle,audit `update.cancel`(与 §5.5 失败分支同一出口);
  - `idle` → `cmd.update.noPending`。

## 6. 安全防线(汇总)

| # | 防线 | 落点 |
|---|---|---|
| 1 | 唯一来源锁死 npm `latest`,版本号/URL/路径/git ref 一律拒绝 | 命令层参数校验(§4) |
| 2 | root 拒执行(npm postinstall 提权风险) | §5.1,`process.getuid?.()` |
| 3 | 版本字符串 `x.y.z` 格式校验后才拼入文案(防注入) | §5.2 `parseLatestVersion` |
| 4 | 访客 blocked(registry 登记 → guest-policy 查表硬拦 + `guest.denied` 审计) | `src/command-registry.ts` + `src/auth/guest-policy.ts:35` |
| 5 | 仅管理房可用(命令层判定) | §4 |
| 6 | 升级失败旧版继续、桥绝不自杀 | §5.4 |
| 7 | 更新进行中拒绝重入 | §5.7 |

## 7. 审计

- `AUDIT_EVENTS`(`src/audit/audit-log.ts:34-50`)新增:`update: "update"`、`updateCancel: "update.cancel"`、`updateDone: "update.done"`。
- **发起**:`COMMAND_REGISTRY` 条目 `{ name: "/update", guest: "blocked", auditEvent: "update" }`(`src/command-registry.ts:51` `/reload` 同款)→ router 的登记表审计缝(`src/rpc/message-router.ts:1137-1141`)对每次 handled 的 `/update` 族调用自动落账(actor = 发起人)。
- **取消**:命令层经 `ctx.audit` 缝(`src/rpc/command-map.ts:59`,router 侧接线 `auditTrail`,`src/rpc/message-router.ts:337-339`)落 `update.cancel`。
- **完成**:启动消费时 `AuditLog.append`(`src/audit/audit-log.ts:79`)落 `update.done`(actor `"system"`)。
- 词汇表一致性:`tests/guest-policy.test.ts:61-72` 已钉「registry 的 auditEvent ∈ AUDIT_EVENTS 值集」,新增事件后自动覆盖 `/update` 条目。

## 8. 涉及文件清单与改动要点

| 文件 | 改动 |
|---|---|
| `src/command-registry.ts` | `COMMAND_REGISTRY` 加 `{ name: "/update", guest: "blocked", auditEvent: "update" }`(生命周期分组,`/reload` 旁) |
| `src/audit/audit-log.ts` | `AUDIT_EVENTS` 加 `update` / `updateCancel` / `updateDone` 三常量 |
| `src/rpc/command-map.ts` | ① 新增导出 `waitForAllAgentsIdle`(全实例轮询原语,含单实例 `requireClient()` 抛错→unreachable 分支;单实例版不动);② `SlashCommandContext` 加 `adminRoom?: boolean` 与 `updater?` 插槽(发起/取消/查询忙闲的最小接口);③ `handleSlashCommand` 加 `case "/update"`(**同步段固定顺序:①子命令分派(check/cancel)→②同步守卫链(root/管理房/参数)→③编排分支 CAS 占位,全部零 await**;预告后立即返回 true,等待/安装/重启由编排器后台驱动,不 await 进命令调用栈;文案经 i18n,§5.3) |
| `src/update/updater.ts`(新) | `UpdateOrchestrator`:状态机(idle/checking/waiting/installing/restart-pending,占位为同步 CAS)、registry fetch 与 `parseLatestVersion` / `isNewerVersion` 纯函数、等待循环(30min 上限 / 5min 进度 / cancel 分态)、并发拒绝;依赖全部构造注入,可测:spawn、fetch、时钟、回执、审计、**`getuid`**(root 判定 = `process.getuid?.()` 的注入缝,§10 用例 7 依赖)、**`platform`**(systemd 判定 = `serviceManagementSupported` 的入参) |
| `src/update/upgrade.ts`(新) | 桥侧升级执行:安装方式检测、npm/git 命令构造(异步 spawn)、`--ignore-scripts` 捷径;注释交叉引用 `src/cli.ts` 同款逻辑 |
| `src/update/pending-update.ts`(新) | `PendingUpdateStore` + `consumePendingUpdate`(queue-snapshots 同款 consume-once) |
| `src/rpc/message-router.ts` | slashCommands 注入 `adminRoom: ctx.multiProject ? ctx.isManagementRoom : !ctx.msg.isGroupChat`(login 先例,`src/rpc/message-router.ts:1036-1041`)、按本消息预绑定的**发起房间 chatId**(reminders 先例,`src/rpc/message-router.ts:1110-1123`)与 `updater` 插槽(透传 deps) |
| `src/standalone.ts` | 组合根:构造 `PendingUpdateStore` 与 `UpdateOrchestrator` 注入 router;启动消费区加 `consumePendingUpdate` |
| `src/i18n/zh.ts` / `en.ts` | `cmd.update.*` 键族(§9);`cmd.help.group.bridge` 追加 `/update` 一行 |
| `tests/guest-policy.test.ts` | blocked 快照加 `/update`;词汇表钉加 `commandPolicy("/update")?.auditEvent === AUDIT_EVENTS.update` |
| `tests/update-orchestrator.test.ts`(新) | 状态机全分支(§10 用例 1-8 的编排器半边;房间约束只测 adminRoom=true/false 布尔守卫) |
| `tests/router-update.test.ts`(新,仿既有 `tests/router-*.test.ts` 的假 transport 形态) | router 接线断言:multiProject/DM/群聊 → `adminRoom` 的映射与守卫链(§10 用例 2 的路由半边) |
| `tests/pending-update.test.ts`(新) | consume-once 与格式校验(§10 用例 9;含单工程无管理房时的跳过+销账语义);写侧可感知契约:write 失败上抛(不用 JsonStateFile 的吞错 save,§5.5 步骤 1) |
| `tests/router-audit.test.ts` 或 orchestrator 测试 | 审计落盘断言(§10 用例 11) |

## 9. i18n 键清单(中英;zh 为键集基准,en 以 `Record<MessageKey, string>` 对齐,`src/i18n/en.ts:8`)

| 键 | zh | en |
|---|---|---|
| `cmd.update.unavailable` | `ℹ️ /update 未装配(当前部署不支持)。` | `ℹ️ /update is not available in this deployment.` |
| `cmd.update.notManagementRoom` | `❌ /update 仅可在管理房使用。` | `❌ /update can only be used in the management room.` |
| `cmd.update.rootDenied` | `❌ 桥正以 root 运行,/update 拒绝执行(npm 脚本提权风险)。请改用停机更新:pi-courier update。` | `❌ The bridge is running as root; /update refuses to proceed (npm script privilege risk). Use the stop-the-world update instead: pi-courier update.` |
| `cmd.update.rejectedArgs` | `❌ /update 不接受版本号、URL 或路径等参数(唯一来源:npm 的 latest 标签)。可用:/update、/update check、/update force、/update cancel。` | `❌ /update takes no version, URL or path arguments (single source: npm's latest tag). Valid: /update, /update check, /update force, /update cancel.` |
| `cmd.update.check.upToDate` | `✅ 已是最新版本(v{version})。` | `✅ Already up to date (v{version}).` |
| `cmd.update.check.hasNew` | `🆕 发现新版本:v{from} → v{to}。发送 /update 开始更新(任务不中断)。` | `🆕 New version available: v{from} → v{to}. Send /update to start (running tasks are not interrupted).` |
| `cmd.update.check.failed` | `❌ 版本检查失败:{message}` | `❌ Version check failed: {message}` |
| `cmd.update.started` | `🚀 开始更新:v{from} → v{to}(升级期间任务照常服务,完成后自动重启)。` | `🚀 Update started: v{from} → v{to} (tasks keep running during the upgrade; an idle restart follows).` |
| `cmd.update.busyWaiting` | `⏳ {count} 个任务在跑,全部完成后自动开始更新(超 {minutes} 分钟未空闲则取消;期间新消息照常排队)。` | `⏳ {count} task(s) running; the update starts automatically once idle (cancelled after {minutes} min; queued messages keep flowing).` |
| `cmd.update.unreachableNote` | `(另有 {count} 个实例暂不可查询——pi 重启窗口,同样等待其就绪。)` | `({count} instance(s) not queryable right now — pi restart window; waiting for them too.)` |
| `cmd.update.waitProgress` | `⏳ 更新等待中:{count} 个任务仍在跑(已等 {minutes} 分钟)。` | `⏳ Still waiting for the update: {count} task(s) running ({minutes} min elapsed).` |
| `cmd.update.waitingUnreachableOnly` | `⏳ 暂无法确认全部实例空闲({count} 个实例查询失败或正处重启窗口),就绪后自动开始更新(超 {minutes} 分钟未确认则取消;期间新消息照常排队)。` | `⏳ Cannot confirm all instances idle right now ({count} instance(s) failed to query or are in a restart window); the update starts automatically once they are (cancelled after {minutes} min; queued messages keep flowing).` |
| `cmd.update.restartWait` | `🔄 新代码已上磁盘,等待全部任务空闲后自动重启(超 {minutes} 分钟未空闲则取消,可随时手动 pi-courier restart)。` | `🔄 New code is on disk; the service restarts automatically once all tasks are idle (cancelled after {minutes} min — pi-courier restart works manually anytime).` |
| `cmd.update.restartProgress` | `🔄 重启等待中:{count} 个任务仍在跑(已等 {minutes} 分钟)。` | `🔄 Waiting to restart: {count} task(s) running ({minutes} min elapsed).` |
| `cmd.update.waitTimeout` | `⏰ 等待空闲超时({minutes} 分钟),本次更新已取消。任务结束后可用 /update force 重试。` | `⏰ Gave up waiting for idle after {minutes} min — update cancelled. Retry with /update force once tasks finish.` |
| `cmd.update.cancelled` | `🛑 已取消更新等待。` | `🛑 Update wait cancelled.` |
| `cmd.update.noPending` | `ℹ️ 当前没有进行中的更新。` | `ℹ️ No update in progress.` |
| `cmd.update.inProgress` | `⏳ 更新已在进行中,请等待完成(等待期可 /update cancel)。` | `⏳ An update is already in progress (use /update cancel to cancel the wait).` |
| `cmd.update.npmFailed` | `❌ 升级失败:{message}\n旧版继续运行,桥未受影响。` | `❌ Upgrade failed: {message}\nThe old version keeps running; the bridge is unaffected.` |
| `cmd.update.installed` | `📦 新代码已写入磁盘:v{from} → v{to}(当前进程仍跑旧版)。` | `📦 New code is on disk: v{from} → v{to} (this process still runs the old version).` |
| `cmd.update.restarting` | `🔄 全部任务已空闲,正在重启服务以加载新版本…` | `🔄 All tasks idle — restarting the service to load the new version…` |
| `cmd.update.restartFailed` | `⚠️ 自动重启失败({message}):新代码已在磁盘,请手动执行 pi-courier restart。` | `⚠️ Automatic restart failed ({message}): the new code is on disk — run pi-courier restart manually.` |
| `cmd.update.manualRestart` | `ℹ️ 新代码已写入磁盘(v{from} → v{to})。本桥未由活动的 systemd 单元管理(或平台无 systemd),请手动执行 pi-courier restart 生效。` | `ℹ️ New code is on disk (v{from} → v{to}). This bridge is not managed by an active systemd unit (or no systemd) — run pi-courier restart manually to apply.` |
| `cmd.update.manualRestartHint` | `⚠️ 新代码已写入磁盘(v{from} → v{to}),但任务未空闲/等待已取消。空闲后请手动执行 pi-courier restart(重启后仍会收到完成回执)。` | `⚠️ New code is on disk (v{from} → v{to}) but tasks never went idle / the wait was cancelled. Run pi-courier restart when idle (the completion notice still arrives after the restart).` |
| `cmd.update.done` | `✅ 更新完成:v{from} → v{to}。` | `✅ Update complete: v{from} → v{to}.` |
| `cmd.update.doneVersionMismatch` | `⚠️ 磁盘实际版本(v{actual})与预期(v{to})不一致,更新可能未生效,请检查。` | `⚠️ On-disk version (v{actual}) differs from the expected v{to} — the update may not have applied.` |

测试断言以 zh 表为锚(项目铁律)。

## 10. 测试决策与验收用例

模式:vitest + 假 client / 依赖注入(参照 `tests/wait-for-agent-idle.test.ts` 的 `vi.fn()` 假 client、`tests/pi-rpc-drain.test.ts`)。编排器测试注入:registry fetch 缝、spawn 缝、时钟/定时器(`vi.useFakeTimers` 或注入 delay)、**发起房间回执缝**(断言回执发往发起时捕获的 chatId,§11.9)、audit 缝;全实例空闲原语测试注入假 `getState`。

验收矩阵(设计书 11 条,每条 ≥1 用例):

| # | 场景 | 用例要点 | 测试文件 |
|---|---|---|---|
| 1 | `/update check` 无新版 | latest ≤ 磁盘 → `check.upToDate`;registry 校验失败 → `check.failed` | update-orchestrator |
| 2 | 有新版且全空闲 | 直接进 installing → 回执 started/installed/restarting;`adminRoom=false` → `notManagementRoom`(编排器只测布尔守卫)。**路由半边**归 router 级测试:多工程非管理房拒、**单工程 DM 放行、单工程群聊拒**(login 先例,§4) | update-orchestrator + router-update |
| 3 | 忙 → 预告 + 等待、任务结束后自动继续 | 首个 getState 报 streaming → busyWaiting;翻转 idle 后自动进 installing;**单实例 getState 抛错(默认进程未连接/项目进程 restart 窗口)→ 计入 unreachable、不视为空闲、预告/进度附 `unreachableNote`,恢复后继续**;**发起时 N=0 且 U>0(默认进程未连接/项目进程 restart 窗口;lazy 未启动的项目进程不在 allRpcs() 里、构造不出该场景,§5.3)→ 同样进 waiting 而非直接 installing,预告用 `waitingUnreachableOnly`(非 busyWaiting,§9)**;形态:**handler 先 resolve(true),fake timer 推进后台循环**;等待期新消息进 followUp 的现有机制不在本 PR 触碰(既有 router 测试已覆盖) | update-orchestrator |
| 4 | 等待超时 | fake timer 推进过 30min → waitTimeout + audit `update.cancel` + 状态回 idle;形态同用例 3(handler 先 resolve,超时回执由后台循环发出,不经命令调用栈/generic catch,§5.3 返回契约) | update-orchestrator |
| 5 | `/update cancel` | waiting 中 cancel → cancelled + audit;无进行中 → noPending;checking 中 cancel → noPending(无等待可取消);installing 中 cancel → 拒绝(inProgress,不可取消换血);**restart-pending 中 cancel → 写 pending-update.json + manualRestartHint(不回滚,§5.7)**;**cancel 原子性:handler 返回时状态已置 idle(同步置位先于回执 await),此时再发 /update 走正常发起而非 inProgress(§5.7)** | update-orchestrator |
| 5b | 并发守卫(补,防同步段竞态) | 第一条 /update 占位后停在探测/fetch 的 await 窗口内,第二条 /update 与 /update force 均 → inProgress、不启动第二套编排(断言仅一次 fetch/spawn 发起);check 并发放行;**cancel 分派先于 CAS:waiting 中取消等待成功、checking 中 noPending(不被 inProgress 误杀,§5.3 顺序①/§5.7)**;**同步守卫拒绝(root/管理房/非法参数)后无占位残留,后续 /update 可正常发起(§5.3 顺序②先于占位)**;**占位释放:占位段内探测/fetch/预告发送抛错 → 同步复位 idle,后续 /update 可正常发起(不锁死 inProgress,§5.3 占位释放契约)** | update-orchestrator |
| 6 | npm 升级失败 | spawn 非零退出 → npmFailed、回 idle、进程不退出(桥照常应答后续 check);**升级命令挂死 → 30min 超时 kill 子进程 → 同失败分支(§5.4 挂死兜底)**;**升级成功但 pending-update.json 写入失败 → 放弃自动重启、manualRestart、idle(§5.5 步骤 1 可感知写契约)** | update-orchestrator |
| 7 | root → 拒执行 | 注入 `getuid: () => 0`(注入缝见 §8 updater 行)→ rootDenied,不发起任何 fetch/spawn;对照组 `getuid: () => 1000` 与 `getuid: undefined`(Windows)放行 | update-orchestrator |
| 8 | 非法参数 | `/update 1.2.3` / `/update https://…` / `/update main` → rejectedArgs,不触网;**拒绝后 /update 可再次发起(同步守卫先于 CAS,无占位残留)** | update-orchestrator |
| 9 | pending-update.json 的 consume-once 与格式校验 | 合法条目 → 发送 + audit + 删文件;畸形(from 含换行/缺字段)→ 视作无更新;发送失败仍销账 | pending-update |
| 10 | 访客发 /update → blocked | `guestCommandVerdict("/update")` 命中(guest-policy 快照 + 单断言);访客回执/审计走既有 authorizationGate 路径(router 集成已有覆盖) | guest-policy(+router 既有) |
| 11 | 审计事件落盘 | 发起(update)/取消(update.cancel)/完成(update.done)各断言一次 `audit.append` 调用参数 | update-orchestrator / router-audit |

**门禁**:三项全绿才算完,以原始退出码为准(管道别吃退出码):
`npm run typecheck`(`package.json:26`,tsc --noEmit × 2)、`npm test`(`package.json:27`,vitest run)、`npm run lint`(`package.json:28`,biome check src/)。

## 11. 实现注意事项(坑)

1. **`readBridgeVersion` 是现读磁盘**(`src/version.ts:12-22`):npm 升级成功后它返回新版本。回执与状态机里的 `from` 必须在 installing 开始时捕获,不得事后重读。
2. **桥内 spawn 必须异步**:照搬 `cli.ts` 的 `spawnSync` 会冻结事件循环、杀掉桥的全部服务能力。
3. **重启 spawn 必须 `detached: true` + `.unref()`**:systemctl restart 会杀死本进程,不脱离父进程句柄可能在 kill 到来前抛 EBUSY/中断。
4. **先写文件再触发重启**(§5.5 顺序):反过来会在回执文件落盘前杀死进程,闭环丢失。
5. **`waitForAgentIdle` 保持轮询**:上游 `RpcClient.waitForIdle` 只订阅未来事件、不查当前状态,abort 先于订阅 settle 时必假超时(`src/rpc/command-map.ts:354-361` 注释,2026-10-11 真机复现)。全实例变体继承同一决策。
6. **不 import `cli.ts`**(§3):模块加载即跑 `main()`;共享逻辑靠"注释交叉引用"而非代码共享,除非评审同意把纯 helper 上移到 `src/npm-runtime.ts`。
7. **`/update` 未装配时不落回 pi**(`src/rpc/command-map.ts:608` 的 recap 先例是 `return false` 落回 pi——/update 不学它,回 `unavailable` 文案):落回会把命令文本喂给模型。
8. **`undici` fetch 走代理**:必须用 undici 的实现而非 Node 内置 fetch,才能吃到 `src/proxy.ts:151-154` 的全局调度器换装(`installGlobalProxyDispatcher`:setGlobalDispatcher + install)。
9. **异步回执目标 = 发起时捕获的原房间 chatId**:router 的 slashCommands 阶段把 `ctx.msg.chatId` 预绑进编排器插槽(reminders 按消息预绑定的同款先例,`src/rpc/message-router.ts:1110-1123`),预告/进度/升级与重启各回执一律发往该房间——多工程下它就是管理房,单工程下是 DM,两种部署都有稳定目标。**不以 `managementRoomId` 作发起守卫**:单工程下它恒为 `undefined`(管理房收养只发生在多工程路径,门是 `ctx.multiProject`,`src/rpc/message-router.ts:983-991`;读取器 `managementRooms?.[0]`,`src/config.ts:316-318`,写侧 `adoptManagementRoom` 仅被多工程路径调用)——照守卫实现会把主场景(单工程 systemd 常驻)拒成死路;而多工程下 `adminRoom === true` 已蕴含 `managementRoomId` 非空,二次检查是死代码。`managementRoomId` 的读取缝仅供 §5.6 的启动消费投递。
10. **`requireClient()` 未连接时同步抛**(`src/rpc/pi-rpc.ts:666-674`):遍历 `allRpcs()` 的每一轮轮询都必须对单实例 try/catch(计入 unreachable,§5.3),不能让一个处于 stop→start 窗口的实例炸掉整轮等待;`allRpcs()` 恒含默认进程、另含已启动项目进程(`src/rpc/project-manager.ts:120-124`)。

## 12. Further Notes

- 后续票(本 PR 外):自动定时检查新版(可复用本 spec 的 registry 检查纯函数)。
- systemd 单元名固定 `pi-courier`(`src/cli.ts:36` 的 `SERVICE_NAME`;单元由 `pi-courier enable` 安装,`src/cli.ts:119-150`)。
- `pending-update.json` 与既有状态文件同目录:`~/.pi/pi-courier-state/`(`CONFIG_DIR = ~/.pi`,`src/config.ts:10`;目录 0700,`src/standalone.ts:317-322`)。
