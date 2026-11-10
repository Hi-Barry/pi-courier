## Problem Statement

Windows 部署（npm 11 全局安装）从 v1.5.0 执行 `/update` 升 v1.7.0 时，升级命令跑满 30 分钟被桥按超时强杀：

- 桥回执"开始更新"后长时间无结果；期间 `/update check` 读到磁盘已是 v1.7.0，但内存进程仍是 v1.5.0，用户被误导为"已是最新"。
- 最终报 `npm install -g pi-courier@latest --foreground-scripts timed out after 30 min`。
- 中断的安装留下半成品：crypto 原生库 `.node` 缺失，全局 `pi-courier` 命令垫片缺失；此时重启会直接崩在 crypto 加载处。
- 旧进程靠内存中的旧 DLL 继续服务，形成"磁盘新、进程旧"的危险半升级状态。

根因不是单一的"网慢"，而是三件事叠加：

1. **npm 11 全局安装是 shallow 布局**：依赖在 `prefix/node_modules/<pkg>/node_modules/...`，不在全局根 `prefix/node_modules/@matrix-org/...`。现有 E2EE 探测写死查全局根，永远找不到 `.node`，因此升级命令没有追加 `--ignore-scripts`。
2. **crypto 依赖的 postinstall 无条件下载**：`@matrix-org/matrix-sdk-crypto-nodejs` 的 `download-lib.js` 用 `override: true`，每次都去 GitHub Releases 下 ~15MB，且没有超时。
3. **桥不消费子进程 stdout**：下载器每秒往 stdout 打印进度，桥只监听 stderr；Windows 管道约 64KB，慢链路下写满后子进程阻塞，直到 30 分钟超时被 SIGKILL。代理本身已由 `applyProxySettings` 写进桥进程环境（真机启动日志有 `出网代理: http://192.168.1.1:10808 (来源: config)`），npm 子进程会继承；但下载仍可能因慢链路/代理卡顿而超时。

另外，当前"`.node` 已存在就加 `--ignore-scripts`"的捷径在 shallow 布局下语义不成立：npm 11 重装会替换整个 `pi-courier` 目录，旧 `.node` 一定会被删；即使探测命中，跳过脚本也会让新树没有原生库。

## Solution

把升级流程改成"**始终跳过安装脚本 + 装完显式恢复原生库 + 校验通过才允许重启**"：

1. npm 路径固定为：`npm install -g pi-courier@latest --ignore-scripts` → `node scripts/ensure-crypto-native.mjs` → 校验 `.node` 存在。
2. git 路径固定为：`git pull` → `npm install --ignore-scripts` → `npm run build` → `ensure` → 校验。
3. 原生库定位从"猜全局根"改为"从包自身 `createRequire` 解析"，兼容嵌套、提升、自定义 prefix。
4. 升级子进程的 stdout 必须被消费并保留尾部；失败信息同时带 stderr/stdout 摘要。
5. 每个步骤有超时；Windows 超时要杀整棵进程树。
6. `ensure` 失败或校验失败 = 升级失败：不写 pending-update、不自动重启，旧进程继续服务，并明确告诉用户"磁盘已是 vX / 进程仍是 vY"。
7. `/update check` 在 installing/restart-pending 状态不再读磁盘说"已是最新"，而是报告升级进行中/等待重启。
8. 桥与 CLI（`pi-courier update`）共用同一套顺序与失败语义；代理环境显式传给 npm/ensure 子进程（桥侧已有，CLI 侧补上）。

## User Stories

1. As a Windows 部署管理员, I want `/update` 在 30 分钟内正常完成, so that 我能无人值守升级。
2. As a Windows 部署管理员, I want 升级优先使用本地缓存的原生库, so that 慢网/断网时也能完成更新。
3. As a Windows 部署管理员, I want 升级后 `.node` 一定在位, so that 重启不会崩在 crypto 加载处。
4. As a Windows 部署管理员, I want 升级在重启前校验原生库, so that 半成品安装不会被自动重启放大成服务中断。
5. As a Windows 部署管理员, I want 升级失败时旧进程继续服务, so that bot 不因升级失败离线。
6. As a Windows 部署管理员, I want 失败回执明确写出"磁盘 vX / 进程 vY", so that 我知道现在能不能重启。
7. As a Windows 部署管理员, I want 升级中的 `/update check` 不要谎报"已是最新", so that 我不会误判升级已完成。
8. As a Windows 部署管理员, I want npm/ensure 子进程继承配置代理, so that 缓存未命中时仍能通过代理下载。
9. As a CLI 用户, I want `pi-courier update` 使用同一套安全顺序, so that CLI 路径也不会再挂 30 分钟。
10. As a 开发者, I want 原生库定位从包自身解析, so that npm 11 shallow、hoisted、自定义 prefix 都不会漏。
11. As a 开发者, I want 升级执行器消费子进程 stdout, so that 下载进度/脚本输出不会把 Windows 管道写死。
12. As a 开发者, I want 每个升级步骤有超时并能杀进程树, so that 挂死的安装不会留下孤儿进程。
13. As a 开发者, I want 原生库下载器自身也有超时, so that 卡住的 GitHub/代理连接不会无限等待。
14. As a 维护者, I want 单测覆盖 nested/hoisted 布局、stdout 洪水、代理注入、步骤顺序和失败分支, so that 这个回归不会再次出现。
15. As a 维护者, I want 发布说明写明"1.7.0 这台机器第一次要手动装 1.7.1", so that 用户不会用旧更新器再踩一次。
16. As a 用户, I want 升级窗口内 bot 照常服务, so that 正在跑的任务不中断（沿用现有等待/重启语义）。
17. As a 安全评审者, I want 更新源仍然只认 npm `latest`, so that 版本号/URL/路径注入的防线不回退。
18. As a Windows 部署管理员, I want 升级只影响桥自己的进程树, so that 机器上的其他服务不被误杀。

## Implementation Decisions

1. **升级命令（npm 路径）**：固定为 `node <npm-cli.js> install -g pi-courier@latest --ignore-scripts`。删除 `--foreground-scripts`（脚本已被跳过，没有前景输出可看）。不再根据 `.node` 是否存在决定参数。
2. **显式 ensure 步骤**：安装完成后，以包根为 cwd 执行 `node <包根>/scripts/ensure-crypto-native.mjs`。该脚本已有"缓存优先 + sha256 校验 + 失败降级"逻辑；升级执行器把它当作独立步骤，超时上限短于安装步骤（默认 10 分钟，安装/构建仍 30 分钟）。
3. **步骤后校验**：ensure 完成后，从包根解析 `@matrix-org/matrix-sdk-crypto-nodejs`，确认目录内存在 `*.node`。不存在 → `ok:false`，不进入 restart-pending。校验用纯 helper，不依赖全局 prefix。
4. **原生库定位**：新增"从包根解析"的 helper：以 `<包根>/package.json` 为基准 `createRequire`，解析 crypto 包的 `package.json`，返回包目录；`createRequire` 天然覆盖 `<包根>/node_modules`（npm 11 shallow）与祖先 `node_modules`（hoisted）。删除 `cli.ts` / `upgrade.ts` 中写死全局根的 `e2eNativeBinaryExists` 快路径；`globalNodeModulesDir` 若无其他消费者则连同测试删除，否则保留但不再用于升级判定。
5. **stdout 消费与诊断**：`runStep` 同时监听 stdout 与 stderr，各自保留滚动尾部（stderr 600 字符，stdout 2KB）。失败信息先给命令/退出码/超时原因，再附 stderr 尾部，最后附 stdout 尾部（仅在非空时）。这既消除 Windows 管道死锁，也让下一次故障能看到下载进度。
6. **超时与杀进程树**：安装/构建步骤沿用 30 分钟；ensure 步骤 10 分钟。超时后在 Windows 用 `taskkill /T /F /PID` 杀整棵树，POSIX 用 `SIGKILL`。新增可注入的 kill 缝，测试断言超时路径调用它；真实子进程接口补 `pid` 可选字段，缺失时回落 `child.kill`。
7. **ensure 脚本的下载超时**：`runNativeDownloader` 的 `execFileSync` 增加超时（10 分钟），继承调用方环境（因此桥/CLI 注入的代理对 `download-lib.js` 生效）。脚本本身保持"失败只 warn、不抛"的 postinstall 语义；升级步骤通过事后校验 `.node` 判定失败，不依赖脚本退出码。
8. **失败语义**：安装/ensure/校验任一失败 → `ok:false`；orchestrator 回 `npmFailed`，不写 `pending-update.json`、不触发 restart，状态回 idle。若失败后磁盘版本与升级前进程版本不同，追加一条"磁盘已是 vX，当前进程仍是 vY；确认依赖完整后再重启"的警示（新 i18n key），旧进程继续服务。
9. **升级中的 check**：`installing` 状态回"升级进行中：磁盘 v{disk}，当前进程 v{running}，完成后会自动重启"；`restart-pending` 状态回"代码已更新，等待空闲重启"。两个状态都不再返回"已是最新"。新增 zh/en 两个 i18n key，zh 为键集基准。
10. **代理注入**：桥侧 `standalone` 已有 `applyProxySettings(config)`，它会把代理写进桥进程环境，升级子进程继承；为了让 CLI 与未来入口也自洽，新增/复用"代理子进程环境增量"helper（语义与 `PiRpc.proxySpawnEnv` 一致：无代理 → 不传；配置代理未填 noProxy → `NO_PROXY` 置空串；env 兜底 → 不引入意外键）。组合根把增量传给 orchestrator 的 upgrade 闭包；升级执行器合并到每个子进程的 env。CLI `cmdUpdate` 在 spawn 前 `resolveProxySettings(loadConfig())` 并传同一增量。
11. **CLI 与桥同步**：`cmdUpdate` 改为同一顺序（`--ignore-scripts` → ensure → 校验）。CLI 用 `spawnSync` + `stdio: "inherit"`，不涉及 stdout 死锁；失败时不启动服务并给出人话提示。CLI 的超时/进程树杀是尽力而为（用户在场可 Ctrl+C），不额外引入异步执行器。
12. **git 路径**：`npm install` 同样加 `--ignore-scripts`，随后显式 `npm run build`（发布/源码构建不依赖 `prepare`），最后 ensure + 校验。顺序固定，任一步失败即停。
13. **不变量**：更新源仍是 npm `latest`；不接受版本号/URL/路径参数；升级窗口内桥照常服务；restart-pending 仍等全实例空闲；`pending-update.json` 只在成功进入 restart-pending 后写。
14. **失败不自动回滚**：不在本次范围内实现"失败后重装旧版本"。失败时旧进程继续运行；磁盘半升级状态由回执明确告知，用户确认 `.node` 完整后再手动重启。若未来需要原子回滚，另立 spec。

## Testing Decisions

- **只测外部行为**：命令构造、步骤顺序、子进程 env、超时行为、返回结果与回执文案；不测私有实现细节。
- **最高缝**：`runUpgrade` 的 `spawn` 缝（现有 fake child harness，`tests/update-upgrade.test.ts`）覆盖绝大多数行为；`UpdateOrchestrator` 的 `upgrade`/`probe`/`waitForIdle` 缝覆盖状态机与回执（现有 `tests/update-orchestrator.test.ts`）。
- **纯 helper 测试**：在 `tests/npm-runtime.test.ts` 用临时目录造两种布局——`<app>/node_modules/@matrix-org/...`（nested）与 `<root>/node_modules/@matrix-org/...` + `<root>/app`（hoisted），断言解析与 `.node` 校验；无 `.node` 时返回缺失。
- **升级流程测试**：
  - npm 路径：断言参数含 `--ignore-scripts`、不含 `--foreground-scripts`；第二步是 ensure，cwd=包根；env 含代理增量；校验失败返回 `ok:false`。
  - git 路径：断言顺序 `git pull` → `npm install --ignore-scripts` → `npm run build` → ensure → 校验。
  - stdout 洪水：fake child 向 stdout 推 >64KB，断言失败信息保留 stdout 尾部（或至少监听器存在且数据被消费）；不模拟真实背压，但覆盖代码路径。
  - 超时：fake timer 推进，断言注入的 killTree 被调用、返回超时失败。
- **orchestrator 测试**：
  - `installing` 状态下 `check` 返回新的"升级进行中"文案，不返回 upToDate；
  - upgrade 返回 `ok:false` 且磁盘版本 != 运行版本时，回执含 partial-state 警示；
  - ensure/校验失败不触发 restart、不写 pending-update。
- **代理测试**：`proxyChildEnv` 纯函数覆盖 config/env/none 与 noProxy 空串语义；升级 fake spawn 断言 env 合并结果。
- **ensure 脚本测试**：沿用现有注入下载器与临时缓存目录；新增下载超时选项的行为测试（注入一个抛超时错误的下载器，断言返回 `download-failed` 且不抛）。
- **真机验收**：Windows 上手动安装 1.7.1 后，跑一次受控的升级流程（同版本重装或 1.7.2 测试版），确认不触发 GitHub 下载、E2EE 正常、无 30 分钟挂死。具体验证方式在发版前与用户确认。

## Out of Scope

- 失败后自动回滚到旧版本/旧 `.node`（本次只保证不自动重启并明确告知）。
- 修改上游 `@matrix-org/matrix-sdk-crypto-nodejs` 的 `download-lib.js`。
- 改变 npm 全局安装策略（shallow/hoisted）或支持 npm < 11。
- 为 npm 全局配置写代理（只在升级子进程 env 注入）。
- Windows 计划任务/NSSM 的部署改造。
- 当前这台 Windows 的一次性恢复（已在真机执行：缓存恢复 `.node`、补回垫片、重启、E2EE 正常）。
- 发版流水线本身（PR/版本号/publish 按项目流程走）。

## Further Notes

- 真机证据（2026-11-10）：npm 11.19 全局 shallow 布局；1.7.0 树 241 个顶层依赖完整；crypto 0.4.0 目录无 `.node`；旧桥启动日志有 `出网代理: http://192.168.1.1:10808 (来源: config)`；安装 10:14:36 开始，10:15-10:16 解压完成，10:28 的 `check` 已读到 1.7.0，10:44:36 左右被杀；缓存 `.node` 15,202,816 字节，sha256 与 manifest 一致。
- 恢复过程中补垫片的 `npm install` 曾因 MCP 会话工作目录在包目录内报 EPERM；这是操作环境问题，不是代码缺陷。升级执行器不应要求调用方 CWD 在包内。
- 当前 Windows 已运行 1.7.0（PID/心跳/E2EE 均正常），但更新器仍是旧代码。**1.7.1 发布后，这台机器的第一次安装必须手动**：`npm install -g pi-courier@1.7.1 --ignore-scripts` + `node scripts\ensure-crypto-native.mjs`，再重启计划任务。装上 1.7.1 后，后续 `/update` 才会走修好的路径。真机 `/update` 的完整验证需要 1.7.2（或受控的同版本重装），发版前与用户确认。
- 本次修复的目标版本为 **1.7.1（patch）**；`develop → master` 发版动作由用户授权后执行。