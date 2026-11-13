# Spec #337:doctor 子命令:本地体检与安全修复

> issue: https://github.com/Hi-Barry/pi-courier/issues/337
>
> 设计共识底稿:docs/specs/337-doctor-consensus.md(grilling 三轮问答收敛稿,v1 已经用户逐条确认;原件曾只在 /tmp,评审后已留档入仓)。底稿与仓库现实冲突时以仓库现实为准并在规格中注明差异(核对记录见备注)。

## 问题陈述(Problem Statement)

pi-courier 是常驻桥,坏法大多不在代码而在机器现场:升级 pi 后配置里残留指向已卸载旧版的 `cliPath`、配置文件权限过松、workdir 被误删、单实例锁/manual-stop 标记/pending-update 残留卡住状态、磁盘逼近 ResourceGuard 硬阈值、systemd unit 里钉的 node 路径已漂移。这些状态下桥要么起不来、要么悄悄降级,用户只能在 Matrix 房间里看到一句报错,甚至毫无症状。今天排障全靠手动逐项查(读配置、`which pi`、查权限、翻日志),没有一条命令能同时回答三个问题:**这台机器上的 pi-courier 现在健康吗?哪里坏了?哪些我可以安全地让它自己修?**

脚本/CI 侧同样缺程序化入口:在一台新机器部署完想做环境验收,只能人肉过清单,没有机器可读报告,也没有可编程的退出码。

真实事故(本 spec 的验收锚点):配置里残留指向已卸载旧版 pi 的 `cliPath`,实际 pi 已换成新版,桥解析 CLI 失败或行为异常,现场极难归因——用户面对的既不是"配置坏了"也不是"pi 坏了",而是两者之间的一次失配。

## 解决方案(Solution)

`pi-courier doctor`:一条**确定性的本地体检命令**,不调模型、不碰网络之外的世界。8 组检查覆盖安装完整性、pi 解析链、pi-courier 配置、状态目录、网络、服务、磁盘与 pi 侧只读文件;默认只报告。TTY 下报告末尾汇总问一次"是否修复以上 N 项安全项?";`--fix` 不问直接修"安全幂等档"(修完打印 diff);`--json` 出机器可读报告(同样脱敏);`--offline` 跳过全部网络检查。退出码 0/1/2 可直接进脚本与 CI。修复走三档边界:安全幂等档自动修、提示档只给下一步命令、禁区档(登录/重装/trustedUsers/pi 侧凭据)永不自动。doctor 不拿单实例锁、不启停服务;只有 `--fix` 会写配置。

## 用户故事(User Stories)

**普通用户**

1. 作为普通用户,我想一条 `pi-courier doctor` 就知道这台机器上的桥现在健康与否,不用翻文档逐项手查。
2. 作为普通用户,我想每条检查结果都带人话说明和下一步命令,而不是一个我看不懂的代号。
3. 作为普通用户,我想 doctor 默认只报告不改动,看完报告再决定要不要修,不怕它动我的机器。
4. 作为普通用户,我想在 TTY 下 doctor 汇总问一次"修复以上 N 项安全项?",确认一次就把安全项全修好,不用逐项按 y。
5. 作为普通用户,我想 `--fix` 修完把每处改动打印出来(改前/改后),我核对后心里有数。
6. 作为普通用户,我想配置里残留失效 `cliPath` 时 doctor 明确报 ❌ 并说"配置里的 pi 路径失效",而不是一句含糊的"启动失败"。
7. 作为普通用户,我想 `--fix` 删除失效 `cliPath` 前一定先备份配置,修坏了能自己找回原文件。
8. 作为普通用户,我想 `cliPath` 被删后桥回退到自动发现(`which pi`→托管布局),重新对接到当前实际安装的 pi。
9. 作为普通用户,我想权限过松(配置非 0600、自管目录非 0700)时 doctor 报出来,`--fix` 直接收紧。
10. 作为普通用户,我想 workdir 缺失时 doctor 只告诉我"目录缺失,请创建或跑 setup",不擅自在我磁盘上创建目录。
11. 作为普通用户,我想陈旧单实例锁、manual-stop 残留标记、pending-update 残留被报出来并可 `--fix` 清掉,服务不被残留物卡死。
12. 作为普通用户,我想网络不通时 doctor 明确区分"确认坏了"和"查不出来(超时跳过)",不把网络慢误报成配置坏。
13. 作为普通用户,我想报告里出现的 token/key 最多露前 4 位,终端截图或粘贴报告不会泄露凭据。
14. 作为普通用户,我想 doctor 永不重新登录 Matrix、永不重装 pi/Node、永不碰 pi 的 auth/settings/models——修不了的它只告诉我怎么修。
15. 作为旧布局时代的存量用户,我想旧布局残留被 doctor 指出来并给我迁移指引,而不是被悄悄忽略。

**脚本/CI 用户**

16. 作为脚本/CI 用户,我想 `--json` 拿到机器可读报告(逐项 id/严重度/说明/下一步),用 jq 就能断言。
17. 作为脚本/CI 用户,我想退出码可编程:0=全健康或已修好,1=仍有 ❌,2=doctor 自身崩溃;只有 ⚠️ 时退出码也是 0,CI 不把风险项当失败。
18. 作为脚本/CI 用户,我想非 TTY 环境下 doctor 永不交互提问、永不挂起等输入。
19. 作为脚本/CI 用户,我想每项网络检查 5 秒上限、超时标 ⏭️ 继续其余检查,本地检查项整体秒级完成。
20. 作为脚本/CI 用户,我想 `--offline` 一键跳过全部网络检查,离线机器上也能跑验收。

**Windows 用户**

21. 作为 Windows 用户,我想 doctor 照常检查安装完整性、配置、状态目录、磁盘与 pi 侧文件,而不是整条命令说"平台不支持"。
22. 作为 Windows 用户,我想 systemd/服务组在 Windows 上标 ⏭️ 跳过并说明原因,不被误报成 ❌。
23. 作为 Windows 用户,我想路径检查跟随 Windows 布局分支(configDir/dataDir/stateDir 的 win32 根),不拿 POSIX 路径硬套。
24. 作为 Windows 用户,我想 `--fix` 的安全项在我的平台上行为一致(权限收紧落到等价语义或如实标 ⏭️),且不引入平台专属依赖。

**多项目部署**

25. 作为多项目部署的运维,我想 doctor 检查配置里全部项目的 workdir 存在性与可写性,一个坏项目不掩盖其他项目的结果。
26. 作为多项目部署的运维,我想 sessionDir 配置存在且可写被检查,会话落盘失败提前暴露。
27. 作为部署验收者,我想在一台新机器上 `doctor --json` 全绿再接管服务,部署清单有一条命令可依。

**维护者**

28. 作为维护者,我想检查与修复的全部逻辑收敛在一个可注入 deps 的模块里,CLI 只做薄壳(解析 flags→拼真实 deps→调用),交互 IO 留在壳上。
29. 作为维护者,我想全代码库只为 doctor 新增唯一一个测试缝(DoctorDeps),其余检查复用既有 helper 与缝,不造第二份解析链。
30. 作为维护者,我想报告渲染与退出码派生是纯函数,golden 断言人话与 JSON 两种形态,文案改动立刻被测试捕获。
31. 作为维护者,我想 doctor 的静态依赖只有 node 内置模块与 i18n,既有 helper 全部动态 import + try/catch,任何一个 helper 加载失败只把相关项降级为 ⏭️,doctor 自己绝不崩(退出码 2 只留给真崩溃)。
32. 作为维护者,我想新增文案走 zh 表(键集基准)并同步 en 表,测试以 zh 为锚,与全仓 i18n 约定一致。
33. 作为维护者,我想真实事故回归钉:cliPath 指向已卸载旧版 pi 的用例先红后绿,`--fix` 后重新解析到当前入口、退出码 0。
34. 作为维护者,我想 F 组服务检查只读查询当前用户 systemd unit、对比 unit 声明的 node 与当前 `process.execPath`,不一致只给 ⚠️,绝不顺手改 unit 或重启服务。
35. 作为维护者,我想 doctor 不拿单实例锁、不启停服务,体检动作本身对运行中的桥零干扰。

## 实现决策(Implementation Decisions)

### 命令面与接线

- 子命令 `doctor`,三个开关:`--fix`(不问,直接修安全项)、`--json`(机器可读报告)、`--offline`(跳过全部网络检查)。v1 不做 `--explain`/`--deep`/`--only`。
- 接线进 CLI 的子命令分发(现 `src/cli.ts` 的 `switch (cmd)`,非 setup 子命令照走全链语言解析)。
- CLI 入口是薄壳:解析 flags → 拼真实 DoctorDeps → 调 doctor 核心。TTY 的"汇总问一次"确认放在薄壳层(报告返回后、修复入口调用前),核心保持纯逻辑、可全量注入测试。

### 检查清单(8 组)

| 组 | 检查项 | 严重度 | `--fix` |
|---|---|---|---|
| A 安装完整性 | 关键运行时文件存在(dist 入口、package.json、scripts、deploy 模板);peer 包可解析(@earendil-works/pi-ai、@earendil-works/pi-coding-agent >=0.83);`readBridgeVersion` 可读到非空版本且与包根 package.json 的 version 一致;crypto 原生库存在(`nativeBindingExists`) | ❌/⚠️ | 否 |
| B pi 解析链 | 配置 `cliPath` 指向的文件是否存在;`which pi`→托管布局能否解析到真实 JS 入口(`PiRpc.resolveCliPath` 同源);pi 版本对 Node 引擎门(`assertPiEngineSupported` 语义);Node 版本对 pi-courier package.json engines(>=22.19.0) | ❌ | **是**(仅"失效 cliPath":备份后删除该项,回退自动发现) |
| C pi-courier 配置 | 文件存在/可读/JSON 合法(`loadConfig` 同源);关键字段类型(homeserver、trustedUsers、workdir、sessionDir 等);0600/0700 权限;workdir 存在且可写(含多项目全部 projects);proxy scheme 合法(`resolveProxySettings` 同源);sessionDir 可写 | ❌/⚠️ | 仅权限(chmod);**workdir 缺失只报告不创建** |
| D 状态与目录 | 自管目录(stateDir/dataDir)存在与权限;陈旧单实例锁(`lockIsStale`);manual-stop 残留标记;pending-update 残留;旧布局残留 | ⚠️/❌ | 是(建目录、清锁/标记/残留);旧布局只报告 |
| E 网络(`--offline` 跳过) | Matrix whoami;homeserver 可达;代理可达 | ⚠️/❌(每项 5 秒超时,超时算 ⏭️) | 否 |
| F 服务(仅 Linux) | systemd unit 存在/启用;unit 声明的 node/PATH 与当前 `process.execPath` 对比;服务是否 active | ⚠️ | 否(只报告) |
| G 磁盘 | 剩余空间对 ResourceGuard 硬阈值(与运行时同源 `diskHardMb`) | ❌/⚠️ | 否 |
| H pi 侧(只读静态) | `getAgentDir()` 解析;settings/auth/models JSON 合法、可读;至少一个凭据或默认模型 | ❌/⚠️ | 否(禁区) |

### 严重度与退出码契约

- 状态符号:✅ 健康 / ⚠️ 能跑但有风险或降级 / ❌ 桥无法正常启动或核心功能不可用 / ⏭️ 无法确认或主动跳过。
- 退出码:`0` 全部健康或已全部修好;`1` 仍有 ❌(**只有 ❌ 让退出码变 1,只有 ⚠️ 退出码也是 0**);`2` doctor 自身崩溃。
- 每项带稳定 id(组字母 + 序号,如 `B1`),人话报告与 `--json` 都用它;id 为未来 `--only` 等扩展预留锚点。

### 修复三档

- **安全幂等档(`--fix` 自动做,全部幂等、重复执行无二次伤害)**:删除失效 `cliPath`(配置先备份、修完打印 diff)、创建缺失自管目录、权限收紧 0600/0700(POSIX chmod;Windows 落到等价属性语义,无等价语义时如实标 ⏭️)、清陈旧锁/manual-stop/pending-update 残留。
- **提示档(只报告 + 给下一步命令)**:workdir 缺失(绝不代建)、systemd unit 漂移、服务未启用、旧布局残留。
- **禁区档(`--fix` 永不碰)**:Matrix 重新登录、重装 pi/Node、改 trustedUsers、删 session/数据、碰 pi 的 auth/settings/models。
- 只有 `--fix` 会写配置;doctor 任何模式下不拿单实例锁、不启停服务。
- 配置缺失时报 ❌ 并提示先跑 `pi-courier setup`,不可修复。

### 输出契约

- TTY 人话报告:按组列出,状态符号 + 每项 id、说明、下一步;报告头带 pi-courier 版本号(`readBridgeVersion`,版本号只进报告头,以及未来解释层的输入)。
- 敏感信息一律打码(token/key 最多露前 4 位),`--json` 同样脱敏。
- TTY 交互:报告末尾汇总一次"修复以上 N 项安全项?[Y/n]",不逐项问;`--fix` 不问;非 TTY 永不交互。
- 本地检查秒级;网络检查每项 5 秒上限、超时算 ⏭️;`--offline` 一键跳过整组。

### 唯一新测试缝:DoctorDeps

- 全代码库为 doctor 新增的**唯一新缝**是注入对象 `DoctorDeps`,字段:`platform`、`layout`(布局解析结果)、`homedir`、`env`(环境变量)、`execFile`(进程执行:systemctl 等只读查询)、`fetch`(网络检查)、`diskFreeBytes`(磁盘检查)、`now`(时钟)。CLI 薄壳拼真实实现,测试注入 fake。
- 对底稿的一处显式化(非偏离):底稿注入清单为"layout/homedir/env、execFile、fetch、diskFreeBytes、now";平台判定按仓库先例显式纳入 deps(`UpdateOrchestratorDeps` 注入 `platform`、`windowsRestartCommand(platform, …)` 首参),否则 win32 分支在任意 CI runner 无法测。
- **其余全部复用既有缝,不新造解析链**:`PiRpc.resolveCliPath`(pi 解析链)、`loadConfig`(配置读取)、`nativeBindingExists`(crypto 原生库)、`resolveProxySettings`(proxy scheme 校验)、`lockIsStale`(陈旧锁)、`assertPiEngineSupported`(pi 引擎门)、`readBridgeVersion`(版本)、ResourceGuard 的磁盘硬阈值(`diskHardMb` 同源)。注入缝先例:mcp-cli 的 `resolveCliPath` 缝、legacy-migration 的 `isLockStale` 缝、`UpdateOrchestratorDeps`。

### 工程约束

- doctor 模块的静态依赖只有 node 内置模块 + i18n;上面列举的既有 helper 全部**动态 import + try/catch**,加载失败把相关检查项降级 ⏭️(说明"无法确认"),绝不向上抛;退出码 2 只留给 doctor 自身未捕获的崩溃。
- 报告渲染(checkResults → 人话 / JSON)与退出码派生是纯函数,golden 断言。
- 文案走 `src/i18n/zh.ts`(键集基准)+ `en.ts` 同步,测试以 zh 表为锚(AGENTS.md 双表要求)。
- 平台:Linux 全量 8 组;Windows 跳过 F 组标 ⏭️,其余照查;不引入平台专属依赖。
- 文件完整性深度(Q9 共识):关键路径清单 + 版本一致 + `nativeBindingExists`,**不做哈希清单**。
- TTY 交互形态(Q11 共识):汇总一次确认 + 修完打印 diff,不逐项问。
- 服务环境对比(Q13 共识):Linux 读当前用户 systemd unit,比较 unit 声明的 node 路径与当前 `process.execPath`(及 PATH 声明),不一致或未启用给 ⚠️,只读查询(`systemctl cat/is-active/is-enabled` 经注入 `execFile`),绝不写 unit、不启停服务。
- H 组只读禁区:pi 侧检查全部只读静态,`--fix` 永不写入 pi 侧文件。

## 测试决策(Testing Decisions)

- **只测外部行为**:测试经 `DoctorDeps` 注入临时目录布局(mkdtemp)+ fake `fetch`/`execFile` + 真实 fs,断言报告内容与退出码;不窥内部调用顺序,顺序敏感的契约只保留"备份先于删除"一类。
- **主用例(验收锚点,先红后绿)**:构造残留失效 `cliPath`(指向不存在路径)的配置 + pi 实际已安装的布局。当前仓库无 doctor 代码,用例天然红;实现后:doctor 报 ❌ 且明确说"配置里的 pi 路径失效"→ `doctor --fix` 备份配置、删除该项、重新解析到当前入口 → 再跑 doctor 退出 0。
- **渲染 golden**:健康布局全 ✅ 的人话报告与 JSON、含 ⚠️/❌/⏭️ 混合的报告,各自 golden 断言;脱敏断言(报告与 JSON 均不出现完整 token)。
- **退出码派生表驱动**:全 ✅→0;仅 ⚠️→0;含 ❌→1;渲染抛异常→2。纯函数直接断言。
- **修复项逐项用例**:失效 cliPath(备份存在 + diff 打印 + 项消失)、自管目录创建、权限收紧(POSIX 断言 mode;win32 分支表驱动等价语义/⏭️)、陈旧锁/manual-stop 标记/pending-update 残留清理;提示档与禁区项断言 `--fix` 不触碰(workdir 不被创建、pi 侧文件内容不变)。
- **交互契约**:非 TTY(`--json` 或管道)下不出现提问、正常退出;`--fix` 不出现提问;TTY 提问在薄壳层,以薄测试或人工验收覆盖。
- **网络检查**:fake fetch(立即成功/立即失败/永不 resolve),断言 5 秒超时判 ⏭️ 不判 ❌;`--offline` 下 fetch 一次都不被调。
- **平台**:`platform: "win32"` 全量跑一遍,F 组标 ⏭️、其余照查(表驱动先例:config-win32、pi-rpc-cliresolve-win32 测试)。
- **降级**:模拟既有 helper 动态 import 抛错,断言相关项 ⏭️、退出码仍按剩余 ❌ 派生,doctor 不崩。
- **i18n**:新增键进 zh/en 双表,既有键集对齐测试自动覆盖;新增文案断言以 zh 表为锚。
- **先例**:harness 结构参照 tests/update-orchestrator.test.ts 的 deps 注入 makeHarness;临时目录布局与锁缝参照 tests/legacy-migration.test.ts。
- **命令**:先 `npx vitest run tests/doctor.test.ts`(或拆分后的 doctor*.test.ts)看主用例红;实现后该组全绿;再跑仓库原样门禁 `npm test`、`npm run typecheck`、`npm run lint`。

## 不做(Out of Scope)

- Matrix 内 `/doctor` 命令(v1 只做 CLI;聊天侧入口后续另立 spec)。
- `--explain`(pi 解释层把报告翻译成人话)、`--deep`(真调模型验凭据)、`--only <组>`(id 设计为其预留锚点)。
- 全量哈希清单(文件完整性只做清单存在性 + 版本一致 + native binding)。
- 自动重装 pi/Node、重新登录 Matrix、改 trustedUsers、删 session/数据、碰 pi 的 auth/settings/models——禁区档永不自动,`--fix` 也不碰。
- 服务启停/enable/disable(doctor 只读查询;启停走既有服务族命令)。
- workdir 自动创建(只报告 + 提示下一步)。
- LLM 参与检查或修复的任何环节;模型只在未来 `--explain` 出现,且只消费报告、不执行动作。
- Windows 上的服务族对等实现(现有 CLI 平台门禁不变)。

## 备注(Further Notes)

- 设计来源:grilling 三轮问答收敛稿(`/tmp/pi-courier-doctor-consensus.md`,v1 已经用户逐条确认),本 spec 是其仓库化落地;Q9/Q11/Q13 共识分别落进实现决策(文件完整性深度 / TTY 交互形态 / 服务环境对比)。
- **与仓库现实的核对记录(2026-11-13,撰写本 spec 时逐项跑过)**:底稿列举的既有 helper 全部存在——`PiRpc.resolveCliPath`(src/rpc/pi-rpc.ts:312)、`assertPiEngineSupported`(src/rpc/pi-rpc.ts:233)、`nativeBindingExists`(src/npm-runtime.ts:74)、`resolveProxySettings`(src/proxy.ts)、`loadConfig`(src/config.ts)、`lockIsStale`(src/lock.ts:68)、`readBridgeVersion`(src/version.ts:12)、ResourceGuard 硬阈值字段(src/resilience/resource-guard.ts:46,运行时实参 `diskHardMb(config)` 见 src/standalone.ts:241);pi 侧 `getAgentDir` 由 pi-coding-agent 导出(dist/config.d.ts:89);peer 包为 `@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent >=0.83`(package.json);engines 为 `node >=22.19.0`;src/ 下当前无任何 doctor 代码;仓库标签 ready-for-agent 存在。差异两处,均已按仓库现实落进正文:①底稿 A 组写"readBridgeVersion 与 package.json 一致",而 `readBridgeVersion` 本身就以包根 package.json 为唯一来源(src/version.ts:12-18)——落地为"可读到非空版本且等于包根 package.json 的 version 字段",dist 缺失/错位(半更新)时该项即 ❌,检查语义不变;②平台判定显式纳入 DoctorDeps(先例 UpdateOrchestratorDeps),见实现决策。
- 退出码与 CI 的关系:只有 ❌ 让退出码变 1 是有意为之——⚠️ 表示"能跑但有风险",CI 上不应挡合并;需要更严门槛的部署用 `--json` 自行断言 ⚠️ 项。
- 关联:#258(平台目录布局——doctor 的 layout 缝同源)、#247(进程韧性——manual-stop/锁/心跳残留的来源)、#320/#326(升级链——pending-update 残留的来源)、#331(Windows 自动重启——schtasks/execFile 注入先例)。
- 修订流程:后续修订用 `gh issue edit` 更新本 issue,不重复建号。
