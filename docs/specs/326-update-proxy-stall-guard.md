# Spec #326:升级链路代理卡死防护

> issue: https://github.com/Hi-Barry/pi-courier/issues/326

## 问题陈述(Problem Statement)

桥部署在代理出网的内网机器上时,`/update` 升级可能**卡死 30 分钟**才被兜底超时杀掉(2026-11-11 真机复现:v1.7.1→v1.7.2)。根因链:

1. npm 的 `fetch-timeout` 只约束「请求建立」阶段;当代理完成 CONNECT 握手后**响应体挂起**(连接活着但一个字节都不来),npm 不会中止该请求——真机实测挂了 28 分钟,零报错零重试。
2. 升级子进程的 stdout 在 piped 模式下只随「事件」输出:npm 默认 loglevel(noticel)下整个安装期间几乎静默,调用方无从区分「在慢慢下载」还是「彻底卡死」。
3. 卡住期间房间里只有一句「升级开始」,用户只能干等;失败回执虽然能出来(1.7.1 已修),但中间 30 分钟是黑箱。
4. 附带竞态:看门狗计划任务的动作脚本在包目录内(`deploy/windows/`),npm 重装替换包目录的瞬间,看门狗若正好触发会报「无法找到脚本文件」。

## 解决方案(Solution)

给升级链路(桥内 `runUpgrade` 与 CLI `pi-courier update` 共用)加四层防护:

1. **无进度看门狗(核心)**:子进程 stdout/stderr 任何输出都刷新「最后活动时间」;静默超过 10 分钟视为卡死,taskkill 杀树后**自动重试**该步骤(npm 缓存让重试从断点附近继续),最多 3 次尝试;30 分钟绝对上限不变。
2. **显式 npm 网络参数**:npm install 步骤固定带 `--loglevel=http`(让每个请求完成时输出一行,提供稳定进度信号)+ `--fetch-timeout=180000 --fetch-retries=3`(能自愈的卡顿在 npm 层就重试)。
3. **进度回执**:每步开始/完成/卡死重试都向房间发一条简短回执(升级期间房间里不再是黑箱);CLI 场景打印到终端。
4. **升级期间暂停看门狗**:第一步开始前禁用 `pi-courier-watchdog` 计划任务,升级收尾(finally)恢复;best-effort,失败只记日志不影响升级。

另附运维选项(仅文档,零代码):代理环境下可在目标机 `npm config set registry https://registry.npmmirror.com` 直连国内镜像绕开代理(npm 子进程自动继承用户 .npmrc);注意镜像同步 latest 有约 10 分钟延迟。

## 用户故事(User Stories)

1. 作为代理内网的桥用户,我希望升级在 npm 卡死时 10 分钟内被自动发现并杀掉重试,而不是干等 30 分钟。
2. 作为桥用户,我希望卡死重试是自动的(npm 缓存续传),一次 `/update` 就能成功,不用我手动再跑一遍。
3. 作为桥用户,我希望升级期间房间里能看到「第几步/共几步」的进度回执,知道系统活着。
4. 作为桥用户,我希望卡死重试也有回执(「代理卡住已重试 1/2」),知道发生过什么。
5. 作为桥用户,我希望失败回执指明卡死的命令、第几次尝试、npm 最后说了什么,方便我决策(如换镜像)。
6. 作为 Windows 桥用户,我希望升级期间看门狗暂停值守,升级完成后自动恢复,不再出现「无法找到脚本文件」弹窗或半成品重启。
7. 作为 Windows 桥用户,我希望升级失败时看门狗也一定被恢复(finally 语义),不会留下永远瘫痪的守护。
8. 作为桥用户,我希望升级期间桥照常收发消息(进度回执本身就是证明)。
9. 作为 CLI 用户(`pi-courier update`),我希望与桥内升级享有同样的卡死防护与网络参数,两条路径不分化。
10. 作为维护者,我希望重试有硬上限(3 次)且受 30 分钟绝对上限约束,升级永远不会无限循环。
11. 作为维护者,我希望只有「卡死被杀」触发重试,真实的 npm 报错(非零退出)不重试——避免掩盖真错误。
12. 作为维护者,我希望进度信号来自子进程输出活动本身,不依赖解析 npm 日志文件格式(npm 升级后格式会变)。
13. 作为运维,我希望文档写明代理环境下的 npmmirror 直连备选方案及其 latest 同步延迟注意点。
14. 作为维护者,我希望代理 env 继承行为不变(已由 1.7.1 的 proxyChildEnv 保证),本次不重复造轮子。

## 实现决策(Implementation Decisions)

- **卡死判定**:`runStep` 内维护 lastActivity,stdout/stderr 任意 chunk 到达即刷新;静默超过 `stallTimeoutMs`(默认 10 分钟,可注入)→ 置 `stalled` 标记并 killTree。与既有 `timeoutMs`(30 分钟绝对上限)并存,两者任一触发都杀树,失败详情区分「无进展」与「总超时」。
- **进度信号**:不读 npm 调试日志文件(格式不稳定且路径平台相关),只消费已接管的 stdout/stderr 流——为此 npm install 步骤固定加 `--loglevel=http`,每个请求完成输出一行,天然是心跳。git pull / build / ensure 步骤同样受活动看门狗保护,无需额外参数。
- **重试语义**:`UpgradeStep` 增加 `retriable?: boolean`;仅 npm install 步骤标记可重试(git pull 同样安全但收益低,不标记)。仅当失败原因含 `stalled` 才重试,普通非零退出立即失败。`maxAttempts` 默认 3(注入可调),超出后按原失败路径返回。
- **进度回执钩子**:`UpgradeDeps` 增加 `onProgress?`,事件形状 `{kind:"step-start"|"step-done"|"stall-retry", stepIndex, totalSteps, cmd, attempt}`;桥侧由 orchestrator 防抖直发 Matrix 房间(每步一条,量级 ≤4 条/次),CLI 侧打印。`UpdateOrchestratorDeps.upgrade` 签名放宽为接受可选 hooks 参数,旧接线零破坏。
- **看门狗暂停**:`UpgradeDeps` 增加 `watchdogControl?: { pause(): Promise<void>; resume(): Promise<void> }`;默认实现仅 win32 提供──`schtasks /Change /TN pi-courier-watchdog /DISABLE|/ENABLE`(参数构造抽成纯函数便于 CI 测试);任务不存在/权限不足时记 warn 继续,pause 在第一步 spawn 前、resume 在 finally。非 win32 与未注入时为无操作。
- **i18n**:新增进度/重试/看门狗相关文案,zh/en 双表同步(以 zh 为锚),复用既有 `update.*` 命名空间。
- **代理 env**:维持 `proxyChildEnv` 现状,不改。

## 测试决策(Testing Decisions)

- 只测外部行为:假子进程「静默挂死」+ fake timers 推进 → 断言按 `stallTimeoutMs` 杀树、重试、第二次成功则整体 ok;重试耗尽返回含「无进展/重试」字样的失败信息。复用 `tests/update-upgrade.test.ts` 的 fake-child harness(makeFakeChild/closeCurrent),该 harness 已覆盖 stdout 洪水/超时/树杀等场景,是本 spec 的直接先例。
- `buildUpgradePlan` 断言 npm install 步骤含 `--loglevel=http`、`--fetch-timeout`、`--fetch-retries` 且 retriable=true;ensure 步骤不带这些参数。
- `onProgress` 用 spy 断言事件序列(step-start → step-done → stall-retry → …)与 attempt 递增。
- `watchdogControl` 用 spy 断言 pause 先于第一步、resume 在失败路径也执行;`schtasksArgs(platform, action)` 纯函数表驱动(win32×2 + 非 win32×2)。
- i18n 双表键集测试沿用现有约定。
- 不做真实网络/真实 npm 的集成测试;真机验收由用户在代理内网机上跑 `/update` 完成。

## 不做(Out of Scope)

- 不改 npm 自身行为,不在产品内自研下载器替代 npm。
- 不自动切换/写用户 registry 配置(npmmirror 只进文档,由运维手动决定)。
- 不把看门狗脚本迁出包目录(部署形态变更,风险大于收益,另行评估)。
- 不动忙闲等待窗口、pendingUpdate 状态机与双版本 check 文案(1.7.1 已修,本次只叠加防护)。

## 备注(Further Notes)

- 根因证据链见 #320 及 2026-11-10/11 真机诊断:代理 CONNECT 成功后响应体挂起 28 分钟,npm fetch-timeout 全程未触发;手动修复时 `--fetch-timeout=180000` 下同一代理 84 秒完成下载并成功装完 321 包,证明「显式超时 + 自动重试」配方有效。
- 真机手动修复全程(停看门狗→停桥→补装→缓存恢复 .node→重启→心跳 1.7.2)已验证,本 spec 是把该配方产品化进升级链路。
