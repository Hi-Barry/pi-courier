# Spec #331:Windows 升级自动重启

> issue: https://github.com/Hi-Barry/pi-courier/issues/331

## 问题陈述(Problem Statement)

Windows 上 `/update` 装完新代码后,桥不会自动重启加载新版本,只能收到一条"请手动执行 pi-courier restart"的提示——而 `pi-courier restart` 在 Windows 上根本不可用(服务族命令是 Linux 专用)。用户要自己想办法重启计划任务或重启电脑,自动升级断在最后一环(真机 2026-11-11 用户质询:"每次升级都要手动去重启,那做这个自动升级有什么用?")。Linux 上这一环是全自动的(systemctl restart → 完成回执闭环),Windows 用户享受不到。

## 解决方案(Solution)

1.7.4 给升级链路补上 Windows 的自动重启:安装校验通过后,桥发完回执,由一个**桥进程树之外**的隐藏 vbs(restart-hidden.vbs,随包发布)执行看门狗同款三步——`taskkill /F` 精确杀心跳 pid(不能用 /T:重启手自己是桥的子进程会被连坐;真机实证 `schtasks /end` 杀不死 node)→ `schtasks /change /enable`(兜底被禁用的任务)→ `/end` → `/run`;新进程起来后读 pending-update.json 发「更新完成」回执,闭环完成。计划任务不存在(非任务计划部署)时回落手动提示,且提示语按平台说人话。CLI `pi-courier update` 在 Windows 装完后同样拉起新版本。

## 用户故事(User Stories)

1. 作为 Windows 桥用户,我希望 `/update` 装完后桥自动重启加载新版本,并收到「更新完成」回执,全程不需要任何手动步骤。
2. 作为 Windows 桥用户,我希望重启指令由桥外的进程执行,升级期间收到的回执不因桥死亡而丢失。
3. 作为 Windows 桥用户,我希望自动重启失败时(计划任务不存在/被禁用)收到说人话的提示:告诉我重启"pi-courier 计划任务"或重启电脑,而不是一句 Linux 命令。
4. 作为 CLI 用户,我希望 `pi-courier update` 在 Windows 装完后也自动拉起新版本桥,两条升级路径体验一致。
5. 作为桥用户,我希望重启前完成回执凭据(pending-update.json)已落盘、回执已发出——重启后收到「更新完成」,不丢闭环。
6. 作为桥用户,我希望旧进程先被 taskkill 杀干净再启动新实例,不再出现"新实例被单实例锁挡死、桥悄悄死掉"的事故。
7. 作为维护者,我希望 Windows 重启顺序沿用已验证的三步但避开连坐陷阱(taskkill /F 不带 /T → schtasks /change /enable → /end → /run),不发明第二套重启语义。
8. 作为维护者,我希望任务名探测失败时安全回落,绝不把"计划任务不存在"的部署搞挂。
9. 作为维护者,我希望命令行参数构造保持纯函数(schtasksArgs 先例),win32 分支在任意 CI runner 可测。
10. 作为运维,我希望 README 的 Windows 章节如实更新:升级现在是全自动闭环,并写明计划任务部署是自动重启的前提。
11. 作为桥用户,我希望 Linux 行为零变化(systemd 路径原样)。
12. 作为桥用户,我希望升级窗口期收到的「正在重启服务」回执保留(它告诉我桥即将消失几秒)。

## 实现决策(Implementation Decisions)

- **重启执行者必须树外**:新增 `deploy/windows/restart-hidden.vbs`(随包发布,与 run-hidden.vbs 同套路,ASCII-only——WSH 读系统 ANSI 代码页的既有教训)。参数:计划任务名(默认 `pi-courier`)。内部:等 3 秒(让桥发完回执、spawn 返回)→ 读心跳拿 pid → `taskkill /F /PID <pid>`(**不带 /T**:重启手自己是桥 spawn 的子进程,/T 会连坐杀掉它)→ `schtasks /change /enable`(兜底被禁用的任务)→ `/end` → `/run`;心跳缺/进程已死则直接从 /change 继续。/end 单独杀不死 node 是 2026-11-11 真机实证,taskkill 必须在前。
- **编排器接线**:restartNow 的降级判定改为平台感知——win32 且计划任务存在(默认探测:`schtasks /query /tn`,10 秒兜底,失败=不存在)→ 走自动重启:照旧先写 pending-update.json → 发「正在重启服务」回执 → detached spawn `wscript.exe //nologo <包根>\deploy\windows\restart-hidden.vbs <task>`(unref,与 systemctl detached 同契约)→ 状态回 idle(新进程靠 pending-update.json 闭环)。任务不存在或探测失败 → 回落手动提示。Linux 分支行为逐字节不变。
- **任务名**:常量 `pi-courier`(deploy 安装器创建的默认名,与看门狗 -TaskName 默认一致);探测失败自然回落,不新增配置项(自定义任务名的部署走手动提示,后续有需求再立配置)。
- **提示语修正**:新增 Windows 专用回落文案——「未能自动重启(计划任务不存在或未运行):请手动重启 pi-courier 计划任务,或重启电脑生效」;现有 manualRestart 文案仅 Linux 使用。zh/en 双表同步,zh 为锚。
- **CLI 同步**:`pi-courier update` 在 win32 完成"安装+校验"后,同样探测计划任务,存在则调同一 vbs 拉起新版桥(打印里程碑),不存在则打印 Windows 版手动提示。CLI 与桥共用同一构造(任务名常量、vbs 路径 join、探测),不各写一份。
- **纯函数缝**:vbs 命令行与 schtasks 参数构造抽纯函数(与 taskkillArgs/schtasksArgs 同款),win32 分支任意 CI 可测。

## 测试决策(Testing Decisions)

- 只测外部行为:编排器测试注入 `platform:"win32"` + `scheduledTaskProbe` + `triggerRestart` spy,断言:任务存在 → pending 落盘 → 「正在重启」回执 → trigger 被调(且参数指向 restart-hidden.vbs);探测失败 → 手动回执(Windows 文案,不出现 "pi-courier restart" 字样)+ trigger 不被调;Linux 用例原样保留(行为不变的回归钉)。复用 tests/update-orchestrator.test.ts 既有 harness。
- 纯函数表驱动:vbs 命令行/schtasks 参数(win32×N + 非 win32×2),先例 taskkillArgs/schtasksArgs 测试。
- vbs 本体不做单测(部署产物,与 run-hidden.vbs 同地位),以真机验收为准:发布后用户在远程 Windows 发 `/update`,预期零手动步骤收到「更新完成」回执。
- 门禁四连 + CI ubuntu/windows 双绿;不做真实 schtasks 的集成测试。

## 不做(Out of Scope)

- 不实现 Windows 服务族(enable/start/stop/restart CLI 子命令仍是 Linux 专用;本 spec 只修提示语与自动重启)。
- 不支持自定义计划任务名的配置项(探测失败回落手动提示;有真实需求再立票)。
- 不动 NSSM/S4U 等替代部署形态。
- 不改看门狗脚本本身(它的三步配方已被证实可用,重启 vbs 复刻同一顺序)。
- Linux systemd 重启路径零改动。

## 备注(Further Notes)

- 真机证据链(2026-11-11 远程 Windows):`schtasks /end` 返回"已成功终止"但 node(PID 19728)存活、心跳继续跳动、锁文件未释放、`schtasks /run` 起的新实例被单实例锁立即挡死(日志零痕迹);`taskkill /T /F /PID 19728` 从 MCP shell(树外)杀掉整棵树后 /run 才成功;但桥自己 spawn 的重启手必须去掉 /T 否则连坐。该证据直接决定重启配方与票的验收标准。
- 引导悖论说明:本次(1.7.3→1.7.4)的升级仍由 1.7.3 的旧代码执行,装完后依旧走手动提示——自动重启从 1.7.4 起的升级开始生效(1.7.4→未来)。真机验收时需要一次手动重启过渡,此后闭环。
