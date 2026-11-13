# `pi-courier doctor` 设计共识（v1，已经用户逐条确认）

> 本文件是 grilling 三轮问答的收敛稿，是规格与实现的唯一设计依据；若与仓库现实冲突，以仓库现实为准并在规格中注明差异。

## 1. 定位

一个**确定性的本地体检命令**：检查 pi-courier 的运行环境、配置、文件完整性，默认只报告，`--fix` 只修"安全幂等档"。模型不参与检查与修复；版本号只进报告头（以及未来解释层的输入）。

## 2. 命令与参数

```
pi-courier doctor            # 只读检查，TTY 下汇总问一次是否修复
pi-courier doctor --fix      # 不问，直接修安全项
pi-courier doctor --json     # 机器可读报告
pi-courier doctor --offline  # 跳过所有网络检查
```

v1 不做：`--explain`、`--deep`、`--only`、Matrix `/doctor`。

## 3. 检查清单（8 组）

| 组 | 检查项 | 严重度 | `--fix` |
|---|---|---|---|
| A 安装完整性 | 关键运行时文件（dist 入口、package.json、scripts、deploy 模板）；peer 包可解析；`readBridgeVersion` 与 package.json 一致；crypto 原生库存在 | ❌/⚠️ | 否 |
| B pi 解析链 | 配置 `cliPath` 指向的文件是否存在；`which pi`→托管布局能否解析到真实 JS 入口；pi 版本对 Node 引擎门；Node 版本对 package.json engines | ❌ | **是**（仅"失效 cliPath"：备份后删除该项，回退自动发现） |
| C pi-courier 配置 | 文件存在/可读/JSON 合法；关键字段类型（homeserver、trustedUsers、workdir 等）；0600/0700 权限；workdir 存在且可写；proxy scheme 合法；sessionDir 可写 | ❌/⚠️ | 仅权限（chmod）；**workdir 缺失只报告不创建** |
| D 状态与目录 | 自管目录存在/权限；陈旧单实例锁；manual-stop 残留标记；pending-update 残留；旧布局残留 | ⚠️/❌ | 是（建目录、清锁/标记/残留），旧布局只报告 |
| E 网络（`--offline` 跳过） | Matrix whoami；homeserver 可达；代理可达 | ⚠️/❌（5s 超时，超时算 ⏭️） | 否 |
| F 服务（仅 Linux） | systemd unit 存在/启用；unit 声明的 node/PATH 与当前 `process.execPath` 对比；服务是否 active | ⚠️ | 否（只报告） |
| G 磁盘 | 剩余空间对 ResourceGuard 硬阈值 | ❌/⚠️ | 否 |
| H pi 侧（只读静态） | `getAgentDir()` 解析；settings/auth/models JSON 合法、可读；至少一个凭据或默认模型（具体判定规则进 spec） | ❌/⚠️ | 否（禁区） |

严重度定义：❌ = 桥无法正常启动或核心功能不可用；⚠️ = 能跑但有风险/降级；⏭️ = 无法确认或主动跳过。**只有 ❌ 让退出码变 1，只有 ⚠️ 退出码也是 0。**

## 4. 修复边界

- **安全幂等档（`--fix` 自动做）**：删除失效 `cliPath`（配置先备份、修完打印 diff）、创建自管目录、chmod 收紧 0600/0700、清陈旧锁/manual-stop/pending-update 残留。
- **提示档（只报告 + 给下一步命令）**：workdir 缺失、systemd unit 漂移、服务未启用、旧布局残留。
- **禁区档（永不自动，`--fix` 也不碰）**：Matrix 重新登录、重装 pi/Node、改 trustedUsers、删 session/数据、碰 pi 的 auth/settings/models。

## 5. 输出与退出码

- 状态：✅ / ⚠️ / ❌ / ⏭️，按组列出；每项带 id、说明、下一步。
- 敏感信息一律打码（token/key 最多露前 4 位），`--json` 同样脱敏。
- TTY：报告末尾汇总一次"修复以上 N 项安全项？[Y/n]"，不逐项问；`--fix` 不问；非 TTY 永不交互。
- 退出码：`0` 全部健康或已全部修好；`1` 仍有 ❌；`2` doctor 自身崩了。
- 本地检查秒级；网络检查每项 5 秒上限，`--offline` 一键跳过。
- doctor **不拿单实例锁、不启停服务**；只有 `--fix` 会写配置。
- 配置缺失时报 ❌ 并提示先跑 `pi-courier setup`，不可修复。

## 6. 工程约束

- 静态依赖只留 node 内置模块 + i18n；现有 helper（`PiRpc.resolveCliPath`、`loadConfig`、`nativeBindingExists`、`resolveProxySettings`、`lockIsStale`、`assertPiEngineSupported` 等）全部动态 import + try/catch，加载失败降级为 ⏭️，绝不让 doctor 自己崩。
- **唯一新测试缝：`DoctorDeps` 注入对象**（layout/homedir/env、execFile、fetch、diskFreeBytes、now），CLI 入口是薄壳（解析 flags → 拼真实 deps → 调 runDoctor）；其余全部复用既有缝。
- 报告渲染与退出码派生是纯函数（checkResults → 人话 / JSON），golden 断言。
- 文案走 `src/i18n/zh.ts`（键集基准）+ `en.ts` 同步；测试以 zh 表为锚。
- 平台：Linux 全量；Windows 跳过 F 组标 ⏭️，其余照查；不引入平台专属依赖。
- 文件完整性深度（Q9 共识）：关键路径清单 + `readBridgeVersion` 与 package.json 一致 + `nativeBindingExists`，**不做哈希清单**。
- TTY 交互形态（Q11 共识）：汇总一次确认 + 修完打印 diff，不逐项问。
- 服务环境对比（Q13 共识）：Linux 读当前用户 systemd unit，比较 unit 声明的 node 路径与当前 `process.execPath`，不一致或未启用给 ⚠️，只读查询。

## 7. 明确不做（v1）

Matrix `/doctor`、`--explain`（pi 解释层）、`--deep`（真调模型验凭据）、全量哈希清单、自动重装/重新登录、服务启停、LLM 参与检查或修复。

## 8. 验收锚点

拿真实事故做回归：配置里残留指向已卸载旧版 pi（如 0.87.1）的 `cliPath`、实际 pi 已是新版（如 1.5.2）。`doctor` 必须报 ❌ 并明确说"配置里的 pi 路径失效"；`doctor --fix` 备份后删掉该项、重新解析到当前入口、退出码 0。健康机器全绿退出 0。
