# Spec:/mcp 指令族 —— 在 Matrix 聊天内配置与管理 MCP 服务器

- **状态**:规格定稿,待实施
- **日期**:2026-10-28
- **对应 issue**:Hi-Barry/pi-courier#246「/mcp 指令族:在 Matrix 聊天内配置与管理 MCP 服务器(spec)」;本文为规格入库版,正文以该 issue 规格原文为底,章节沿用 `docs/agents/issue-tracker.md` 约定的 to-spec 模板节名。
- **分支**:`feat/mcp-command-family`(从 develop 切出),PR 目标 `develop`

---

## Problem Statement(问题陈述)

pi 1.0 起 MCP(Model Context Protocol,给 AI 外接工具的插线板)配置完全归 pi 管:写进 `~/.pi/agent/mcp.json`(全局)或项目 `.pi/mcp.json`,由 `pi mcp add/list/remove/login/logout` 命令族管理。pi-courier 的 pi 子进程不带任何禁用开关,这些配置会自动继承——但**管理的入口只在桥主机的终端里**:部署者想加一个 MCP 服务器,得 SSH 到服务器敲 `pi mcp add` 或手改 JSON,再重启服务。聊天里没有任何等价入口;直接让模型代跑配置命令又有访客与安全边界问题(配置文件=任意命令执行面)。

## Solution(方案)

桥新增 `/mcp` 指令族,与 pi CLI 一一对应:`/mcp list`、`/mcp add`、`/mcp remove`、`/mcp login`、`/mcp logout`、`/mcp help`。桥把聊天消息解析成对 `pi mcp` CLI 的调用,把结果回译成聊天卡片。整族仅管理房可用、访客硬拦、敏感动作审计。配置落在 pi 的**全局** mcp.json,对所有项目进程生效;增删后 `/reload`(`/reload all`)生效,登录凭证运行中会话下一回合自动生效。

**集成路径(核心决策):外调 pi CLI,不自写配置读写。** `pi mcp` 的文档串明示"Agent 经 bash 驱动它是设计意图";CLI 面稳定,schema 校验/OAuth 流程全归 pi,pi 独立升级零漂移。不走 import pi 内部模块(非稳定公开面)、不走自写 mcp.json(重复 schema、随版本漂移)。

## User Stories(用户故事)

1. As a 管理房管理员, I want 在聊天里发 `/mcp` 就看到全部 MCP 服务器的状态卡(连接状态/传输方式/工具数/作用域), so that 不用 SSH 到桥主机就能确认哪些服务器活着、哪些要登录。
2. As a 管理房管理员, I want 用 `/mcp add <名> --url <地址>` 添加远程 HTTP 服务器, so that 几秒钟内完成以前要 SSH 才能做的事。
3. As a 管理房管理员, I want 用 `/mcp add <名> <命令> [参数...]` 添加本地 stdio 服务器(支持 `--env`、`--header`、`--cwd`、`--description`、`--exposure`), so that 聊天侧能力与终端 CLI 对齐。
4. As a 管理房管理员, I want 对需要 OAuth 的服务器发 `/mcp login <名>` 并在聊天里收到登录链接, so that 浏览器点一下授权就完成登录,全程不离手机。
5. As a 管理房管理员, I want 登录回执明确说明"浏览器必须能访问到桥主机的回跳地址"并给出 SSH 隧道示例, so that 远程部署下登录失败时知道原因和解法,而不是干等超时。
6. As a 管理房管理员, I want 登录成功回执告诉我凭证即刻生效(运行中会话下一回合自动用上,无需 /reload), so that 不做多余的重启动作。
7. As a 管理房管理员, I want `/mcp logout <名>` 一条命令清除 OAuth 凭证, so that 换账号/撤销授权不用上服务器翻文件。
8. As a 管理房管理员, I want `/mcp remove <名>` 删除服务器且回执提示"发 /reload 生效(多项目用 /reload all)", so that 清楚知道改动何时落地。
9. As a 管理房管理员, I want 重复 `/mcp add` 同名服务器收到"已替换"回执, so that 更新配置不用先删后加。
10. As a 管理房管理员, I want 参数缺失、未知选项时收到用法回执而不是命令被喂给模型, so that 打错字不产生模型幻觉回复。
11. As a 管理房管理员, I want 同一时刻只允许一个登录流程,并发发起收到明确拒绝, so that 不会出现两个回跳监听互相踩踏。
12. As a 管理房管理员, I want 登录超过时限(默认 300s、硬上限 600s)收到超时回执且状态归位, so that 流程可重试、桥不留悬挂状态。
13. As a 多项目部署者, I want `/mcp` 管理的是全局 mcp.json、对所有项目进程生效, so that 一处配置处处可用,且明确知道 v1 不碰项目级配置。
14. As a 访客, I want 发 `/mcp` 任何子命令被礼貌硬拦, so that 我清楚这不在我的权限内,系统也不会被我改动。
15. As a 部署者, I want 增/删/登录/登出四种敏感动作进审计日志(事件、服务器名、房间), so that 配置变更有据可查;`list` 这种只读操作不落账。
16. As a 安全敏感的部署者, I want 任何回执都不回显 `--env`/`--header` 的值(只回显键名), so that 密钥不会永久留在聊天记录里。
17. As a 部署者, I want pi 版本过旧(无 `pi mcp` 子命令)时收到"pi 需升级(≥1.0)"的明确回执, so that 升级路径清晰而不是神秘报错。
18. As a 管理房管理员, I want `/mcp list` 探测服务器较慢时先收到"检查中"回执, so that 等待有反馈,不以为桥死了。
19. As a 维护者, I want 全部行为测试通过注入的假执行缝完成,不依赖真实 pi、不真的连外部 MCP 服务器, so that 测试快且稳。
20. As a 部署者, I want 双语 README 有完整的 `/mcp` 用法与回跳限制说明, so that 中英文用户照抄都能跑通。

## Implementation Decisions(实现决策)

### 模块布局(与 update 域同构,新增文件都在 `src/mcp/`)

> **先例出处注**:本节及全文反复引用的「update 域」先例(`src/update/updater.ts`、`src/update/upgrade.ts`、`case "/update"` 的 `ctx.updater`、`command-map-update.test.ts`、`router-update.test.ts`)存在于**未合并分支 `feat/hot-update-command`(commit c0de2a0)**,本分支基线 `develop` 上**没有**这些文件/接线。同构声明仅指明设计出处,对照时请切到该分支;`src/mcp/` 的代码不依赖它。

- **`mcp-cli.ts`**:pi CLI 执行缝。最小 spawn 形状接口(可注入假件,参考 `feat/hot-update-command` 分支 `src/update/upgrade.ts` 的 spawn 缝;基线无此文件);pi 二进制定位复用既有解析链(`config.cliPath`/`PI_CLI_PATH` → `which pi` → node_modules 回退,见 `PiRpc.resolveCliPath`;组合根把 `config.cliPath` 作为解析头段传入,与桥子进程同源),以「node + 解析出的 cli.js + mcp 子命令」方式 spawn(绕开 pi.dev 托管安装的 shell 包装器);类型化助手 `listServers`(`--json` 解析)/`addServer`/`removeServer`/`logoutServer`(短命令,统一 120s 超时上限)与 `startLogin`(长命令,逐行上抛 stdout,`--timeout` 桥侧硬上限 600s)。list 成败按 JSON 内容判定,不用退出码(pi 对任一启用服务器未连接即退出非零,直接用会把部分失败误报成全失败)。
- **`mcp-formatters.ts`**:纯函数三件 —— ①聊天文本 → argv 分词器(shell 风格引号分词,`--` 之后原文透传);②`list --json` 输出 → 聊天状态卡(name/state/tools/exposure/scope/transport,错误截断,needs-auth 附 `/mcp login` 提示,空列表附添加指引;全部文案经 i18n 双表);③登录 stdout 行解析器(识别「in your browser:」授权 URL 行、Already signed in 行、Signed in to MCP server 成功行)。
- **`mcp-login-flow.ts`**:登录编排器。单飞状态机 idle→urlSent→waiting→done/failed/expired + 代次栅栏防陈旧写回(参考 `feat/hot-update-command` 分支 `src/update/updater.ts` 的代次仲裁;基线无此文件);授权 URL 行即时经回调上抛(由命令层转发聊天,附回跳限制与 SSH 隧道提示);进程退出 → 成功/失败回执数据;超时硬上限 600s;并发发起拒绝并回报「已有登录进行中」。

### 决策明细

- **外调 pi CLI**:桥 spawn `node <pi dist/cli.js> mcp <子命令>`(经 node 跑 JS 入口,绕开 pi.dev 托管安装的 shell 包装器不可直接执行的问题)。pi 二进制定位复用桥现有的解析链(config.cliPath/PI_CLI_PATH → which pi → node_modules 回退),单一来源不另造。
- **v1 只管全局 mcp.json**:项目级 `.pi/mcp.json` 在 RPC 模式下受项目信任门约束(无界面时未信任项目被静默拒绝),聊天侧无法完成信任确认,故不做;全局配置天然覆盖所有项目进程。项目级支持留作扩展点。
- **子命令映射**(聊天分词 → pi argv,shell 风格引号分词、`--` 后原文透传):
  - `/mcp` 与 `/mcp list` → `pi mcp list --json`,按 JSON 结构渲染卡片(name/state/tools/exposure/scope/transport,错误截断);**按 JSON 内容判定成败而非退出码**(pi 对"任一启用服务器未连接"即退出非零,直接用会把部分失败误报成全失败)。
  - `/mcp add <名> (--url <地址> | <命令> [参数...])` → `pi mcp add`,透传 `--env`(可重复)/`--header`(可重复)/`--cwd`/`--description`/`--exposure`;不提供 `--local`(v1 全局)。
  - `/mcp remove <名>` → `pi mcp remove`;`/mcp logout <名>` → `pi mcp logout`。
  - `/mcp login <名> [--timeout N]` → `pi mcp login <名> --timeout N`(桥硬上限 600s)。
- **登录编排**(与 update 域同构的编排器):单飞状态机(idle → 已发链接 → 等回跳 → 完成/失败/过期)+ 代次栅栏防陈旧写回;解析 pi stdout 的授权 URL 行即时转发聊天(非 TTY spawn 下 chalk 自动关色、pi 只等浏览器回跳或超时,无交互粘贴分支);完成回执区分"已登录"与"本已登录";超时/失败回执带 stderr 尾部。
- **生效语义进回执文案**:登录凭证运行中会话下一回合自动生效(pi 设计,无需 reload);add/remove 需 `/reload`(多项目 `/reload all`)。
- **权限**:整族登记进命令登记表(guest: blocked,**登记表条目不挂 auditEvent**——审计按子命令真实语义在命令层落账);处理链内 admin 房守卫与 `/update` 同款(复用 router 按消息预绑定的 adminRoom 口径:多项目看管理房,单项目 DM 即管理房)。`/mcp` 未装配/失败一律自身回执,**绝不落回 pi**(落回会把命令文本喂给模型)。
- **审计**:命令层按子命令真实语义经 router 的 audit 缝上报 `mcp.add` / `mcp.remove` / `mcp.login` / `mcp.logout`(带服务器名;`--env` 值不落账)。`list` 只读不审计。
- **回执安全**:所有回执不回显 `--env`/`--header` 的值,只回显键名。
- **版本门与超时**:spawn 报"unknown mcp command"或 pi 缺失 → unavailable 文案位(提示 pi ≥ 1.0);短命令(add/remove/logout/list)统一超时上限(120s),list 先发"检查中"回执再出结果卡。
- **i18n**:新增 `cmd.mcp.*` 键,中文表为键集基准、英文表对齐;`/help` 的桥增强组下新增【MCP 服务器】小节;双语 README 补命令表与回跳限制说明。
- **接线(照抄 update 域的接线模式,先例见上方出处注)**:command-map 增加 `case "/mcp"` 委派编排槽 `ctx.mcp`(照 `feat/hot-update-command` 分支 `case "/update"` 的 `ctx.updater` 模式:未装配回 unavailable、绝不落回 pi);standalone 组合根装配(pi 定位传入 `config.cliPath` 头段),router 传 adminRoom/audit 槽位。

## Testing Decisions(测试决策)

- 好测试只测外部行为:给定聊天输入与(假的)pi CLI 输出,断言聊天回执与审计落账;不测 spawn 细节本身。
- **唯一新缝:`pi mcp` 执行缝**(spawn 形状的最小接口,与 update 域既有 spawn 缝同构,先例分支见上方出处注),所有行为测试注入假件;真实 pi 与外部服务器不进测试。
- 纯函数直测:聊天文本分词器(→ argv)、`list --json` → 卡片格式化器、登录 stdout 行解析器(用钉住的 fixture 串,容忍 pi 文案漂移时降级为原文透传)。
- 命令层测试(先例:`feat/hot-update-command` 分支的 command-map-update.test.ts;基线无此文件):守卫链顺序、未装配回执、子命令分派、回执文案、审计上报、env 值不回显。
- 路由/权限测试(先例:guest-policy 快照;update 域的 router-update.test.ts 同样只在 `feat/hot-update-command` 分支):访客硬拦、admin 房映射、命令登记表条目。
- i18n:中英双表键集对齐(既有测试),文案以 zh 表为锚。
- 质量门:`npm test`、`npm run typecheck`、`npm run lint` 三项原样全绿后再宣称完成(以原始退出码为准,管道别吃退出码)。

## Out of Scope(范围外)

- 项目级 `.pi/mcp.json` 的聊天侧管理(信任门在 RPC 模式无法在聊天内完成;全局配置已覆盖所有项目;留扩展点)。
- `/mcp enable|disable` 与逐工具 exposure 覆盖(pi CLI 未暴露这两个操作,pi config 是 TUI)。
- 多服务器并发登录(单飞已覆盖真实使用;并发编排复杂度不成比例)。
- MCP 资源/资源模板浏览(卡片只带计数)。
- OAuth 回跳的网络打通(SSH 隧道/公网回调端口属部署者网络方案;桥只做提示,不做端口监听配置)。

## Further Notes(补充说明)

- 前置研究依据:pi 1.0.0 的 `pi mcp` CLI(其文档串明示 agent 经 bash 驱动是设计意图)、OAuth 模块(环回回调 127.0.0.1 + PKCE + 动态客户端注册,凭证存 agent 目录 mcp-auth.json)、配置加载(全局/项目两级,项目级受信任门,RPC 无界面时未信任项目静默拒绝)、RPC 协议无任何 MCP 方法(故 CLI 外调是唯一正道)。
- OAuth 回跳绑定桥主机环回:远程浏览器不可达时需 SSH 隧道(`ssh -L <port>:127.0.0.1:<port> <桥主机>`)或让桥主机端口对用户浏览器可达;README 给出指引。
- 本 spec 与既往 spec 同规格发布:实施时 spec 文档随功能提交入库(docs/specs/)。
