# pi-courier

[English](README.md) | [简体中文](README.zh-CN.md)

通过 **Matrix** 远程使用 [pi coding agent](https://pi.dev)。在聊天里发消息,pi 回复 —— 而且 slash 命令、技能、提示词模板**全部可用**,和终端里一模一样。

与 pi 经典的扩展模式不同,pi-courier 通过 [RPC 协议](https://pi.dev/docs/latest/rpc)驱动 pi,这是命令能在聊天里生效的原因:扩展模式做不到,因为 pi 的 `sendUserMessage()` 刻意跳过了命令解析。

## 1. 是什么

pi-courier 是一个把 Matrix 桥接到本机 pi 的轻量独立服务:

```
Matrix bot ←→ pi-courier ←→ pi --mode rpc(系统安装)
```

- **你和 Matrix bot 账号对话**;消息通过 RPC 协议转发给 pi
- **命令全支持**:`/new`、`/compact`、`/model`、`/thinking`、`/skill:名称`、提示词模板、扩展命令
- **聊天原生操控**:pi 运行中可 steer / 排队 / 打断;扩展提问在房间里直接答;登录 provider 不用离开 Matrix
- **不捆绑 pi** —— pi 独立安装、独立升级
- **会话持久化**到 `~/.pi/agent/sessions`,重启自动恢复
- **一条命令的 CLI**:配置向导、开机自启(Linux=systemd,Windows=任务计划程序)、自动更新

## 2. 怎么装

### 前置条件

| 组件 | 要求 |
|---|---|
| Node.js | >= 22.19(实测 24.x 与 26.x) |
| pi | >= 0.83,**全局安装** |

先装 pi —— pi-courier 连接的是它:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

用 nvm 的话,每个新终端先 `source ~/.nvm/nvm.sh`,确保 `pi` 和 `node` 在 PATH 里。

> **⚠️ Node 版本**:pi 1.0 起硬性要求 **Node ≥ 22.19**——更老的 Node 下 pi CLI 一启动就崩(缺 `fs.globSync`,报 `SyntaxError`)。pi-courier 自 1.0.0 起声明同样的下限(`engines` 为 `>=22.19`)。如果必须留在 Node 20/21,请继续用 1.0 之前的 pi(如 `npm install -g @earendil-works/pi-coding-agent@0.83.0`)搭配 pi-courier 0.7.x。

### 方式 A:普通用户 —— 一条命令

```bash
npm install -g pi-courier
```

完事。验证:`pi-courier help`。

> **⚠️ npm ≥ 11 开了 install-scripts 门禁的机器**:如果安装时出现 `npm warn install-scripts … not yet covered by allowScripts`,说明 npm 静默跳过了全部安装脚本——包括 pi-courier 下载并做 sha256 校验 E2EE 原生库的 postinstall。带白名单装一次:
>
> ```bash
> npm install -g --allow-scripts=pi-courier,@matrix-org/matrix-sdk-crypto-nodejs pi-courier
> ```
>
> (2026-10-14 在一台开了门禁的 npm 11.19 真机实测;这份白名单正是 npm 警告里自己建议的参数。)

> **⚠️ 不要用 `pi install`**:pi.dev 的包页面会显示 `pi install npm:pi-courier`。那条命令是把 pi-courier 装成 **pi 的扩展**(只在 pi 里注册一个 `/pi-courier` 用法提示),**不会**生成 `pi-courier` 命令,`pi-courier -v` 会报"命令不存在"。pi-courier 本体是独立服务,必须用 `npm install -g pi-courier` 安装。已经跑过 `pi install` 的话,用 `pi remove npm:pi-courier` 清掉即可。

### 方式 B:开发人员 —— 源码构建

```bash
git clone https://github.com/Hi-Barry/pi-courier.git
cd pi-courier
npm install
npm run build
npm link          # 让 `pi-courier` 命令全局可用
```

**不要用 `--ignore-scripts`**:Matrix E2EE 库的 postinstall 会下载原生二进制,`pi-courier` 自己的 postinstall 也会自检并**自动补下**缺失的原生二进制(0.1.38 起副本缓存到本地并做 sha256 校验,后续更新免重下,校验不符的库会被拒绝加载)。一个例外:npm >= 11 开了 install-scripts 门禁的机器(见方式 A 的警告)会**静默跳过两者**——安装时请带上方式 A 的 `--allow-scripts` 白名单。若仍报 `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-*'`(任意平台后缀),再手动补:

```bash
cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs
node download-lib.js
cd ../..
```

下载很慢(20-60 kB/s)?这个二进制来自 GitHub Releases,**不走 npm 代理** —— 先 `export https_proxy=... http_proxy=...` 再装。(这两个变量只管**安装期**下载;桥**运行期**的代理是另一套配置 —— 见下一节。)

## 出网代理(运行期)

机器能直连外网的话,本节可整段跳过。1.1.0 起,桥可以把**运行期**流量走一条 HTTP 代理 —— 一处配置覆盖全部三条出网腿:

- **Matrix 收发** —— bot 与 homeserver 之间的连接;
- **pi 的 LLM 请求** —— 生效代理自动注入 pi 子进程环境,pi 内部的模型调用无需另行配置;
- **配置向导的登录** —— `pi-courier setup` 在发出第一个请求前套用同一份配置,token 登录也能走代理。

(**安装期**的下载 —— `npm install` 本身、postinstall 拉取的 E2EE 原生库 —— 是另一码事:由[怎么装](#2-怎么装)与[常见问题](#4-常见问题)里的说明覆盖,不受本节配置影响。)

### 两种配法:配置文件优先

**第一种:配置文件**(推荐,全局一份):在 `~/.pi/pi-courier.json` 里加 `proxy`(一条 URL)和可选的 `noProxy`(豁免列表):

```json
{
  "proxy": "http://192.0.2.10:10809",
  "noProxy": ["192.168.1.0/24", ".internal"]
}
```

**第二种:环境变量**:配置文件没写 `proxy` 时,桥回落认标准的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`。大小写都认;同时设了多个时,小写优先于大写、HTTPS 先于 HTTP 检查。

两者都在时**配置文件赢** —— shell 里遗留的变量盖不掉你写进配置的值。配置和环境变量里都没有代理时,桥与旧版行为完全一致(直连)。

### 向导也会问这一步(可选)

1.1.0 起,`pi-courier setup` 多了可选的出网代理一步(在向导收尾处、多工程问题 —— 多工程模式下还有空间问题 —— 之后、写配置之前;回车跳过)。已有生效代理(配置或环境变量)时,向导在第一个问题之前先报一行,并把它作为默认值 —— 回车即沿用。这一行固定以英文显示(它打在向导第一问 —— 语言选择 —— 之前,向导语言还来不及生效):

```
🌐 outbound proxy: http://192.0.2.10:10809 (source: config; edit ~/.pi/pi-courier.json and restart to change)
```

什么都没配时的提问长这样(真实向导输出):

```
出网代理 URL(可选,http/https;回车跳过): 
代理豁免列表(可选,逗号分隔的主机/域名/IP 段,回车跳过): 
```

向导收尾的清单里总会有一行交代结果(跳过时是 `   出网代理: 未配置(直连)`):

```
   出网代理: http://192.0.2.10:10809 (豁免 192.168.1.0/24, .internal)
```

### 规则与限制

- **仅支持 `http://` 与 `https://` 代理(1.1.0)**。其余 —— 尤其是 `socks5://` —— 无论来自配置还是环境变量,启动即拒,双语报错会点名代理值与出处。服务日志(语言读配置)长这样(实测输出):

  ```
  [bridge] fatal: Error: ❌ 代理 "socks5://192.0.2.10:1080"(来源: config.proxy)当前版本不支持 —— 仅支持 http/https 代理,请改用 http:// 或 https:// 开头的地址
  ```

  `pi-courier setup` 入口同样拦截,同义错误以英文打印(带 `[pi-courier] fatal:` 前缀)。

- **代理变更重启生效。** 代理在启动时解析一次(非法代理当场被拦);改完配置或环境变量后执行 `pi-courier restart`(前台 `run` 就是 Ctrl+C 再起)。代理生效期间,服务日志会有一行注明生效代理与来源(`config` 或 `env`)。
- **`noProxy` 语义**:豁免列表原样透传给底层 HTTP 栈(环境变量形态为逗号分隔的 `NO_PROXY`)—— 桥自己不做匹配,主机/域名后缀/IP 段怎么豁免由底层库说了算。**一个行为要知道**:`proxy` 来自配置文件而 `noProxy` **没填**时,继承来的 `NO_PROXY` 环境变量会被压制 —— 配置说了算,不填就意味着**无豁免**(显式写 `"noProxy": []` 同义)。想保留豁免,把它们列进配置。(只有 `noProxy`、哪里都没有代理时不生效。)
- **认证代理**:URL 里内嵌凭据(`http://user:pass@192.0.2.10:3128`)由底层 HTTP 栈处理,没有单独的录入界面。
- **Windows**:以上全部同样适用 —— 配置文件一样,`HTTP_PROXY` 风格的环境变量也一样(Windows 惯例是大写;两种大小写都认)。

### systemd 服务:shell export 传不进去

你在交互 shell 里 `export` 的代理,systemd 服务拿不到。两个办法:写配置文件(哪里都好使),或用 unit 自带的环境文件 `~/.config/pi-bridge.env`(user unit 已配置 `EnvironmentFile` 加载它,文件不存在也不报错;系统级模板对应 `/etc/pi-bridge.env`)。在里面写一行 `HTTP_PROXY=http://192.0.2.10:10809`,桥启动时照环境变量认 —— 配置文件仍然优先。

## 3. 怎么用

### 第 0 步 —— 确认 pi 能对话(一次性)

pi 需要在 `~/.pi/agent/` 里配好 LLM provider(`models.json`、`auth.json`、`settings.json`)。最快的检查方式:跑 `pi`,随便发条消息,能回复就行。不能回复就先配好(参考 pi 官方文档;注意 `settings.json` 的字段名是 `defaultProvider` / `defaultModel`)。

### 第 1 步 —— 运行配置向导

```bash
pi-courier setup
```

向导会逐步询问,照着输入(方括号里是默认值,直接回车接受)——以下为真实向导输出(中文环境):

```
=== pi-courier 配置向导 ===
语言? [zh] (en/zh):                                              ← 机器人消息语言;回车沿用系统检测的默认值(会写入配置)
将写入 ~/.pi/pi-courier.json(权限 600;已有配置作为默认值,直接回车沿用)

Matrix homeserver URL (如 https://matrix.example.com):                          ← 你的 homeserver 地址
获取 token 方式 [1=用户名密码登录, 2=粘贴已有 token] (1):                        ← 回车 = 用户名密码登录
bot 用户名 (如 test2):                                                          ← bot 账号的用户名
bot 密码:                                                                       ← 输入时不回显
✅ 登录成功,账号: @***:***(设备 PICOURIERCM4KYDGY)
信任用户(管理员)MXID [默认 @***:***]:                                           ← 回车只信任 bot 自己;建议填你自己的账号,如 @barry:***
信任房间 ID(可选,回车跳过;多个逗号分隔,如 !abc:server 或 !abc:server:trusted-only):   ← 群聊才需要;只用私聊回车跳过
启用 E2EE 加密? [y/N]:                                                          ← y/n(非加密房间选 y 也没问题)
pi 工作目录 [默认 /home/你/Projects]:                                           ← 回车用默认
附件保存目录 [默认 /home/你/.pi/pi-courier-attachments]:                        ← 聊天里发的图片/文件落盘处
单个附件大小上限 MB [默认 10]:                                                  ← 超限附件会被明确拒绝
实例名/机器名(默认 debian;多台部署用来区分,将显示在管理房间名):                ← 回车用主机名
启用多工程模式? [y/N](多工程=管理房间+项目房间隔离,可用 /pmctl;默认 N=单工程,一个 bot 对应一个 pi):   ← 回车=单工程(空间组织仅多工程时询问)

✅ 配置已写入 ~/.pi/pi-courier.json
   账号: @***:***
   信任用户: @***:***
   E2EE: 开启
   工作目录: /home/你/Projects
   附件目录: /home/你/.pi/pi-courier-attachments(上限 10 MB)
   实例名: debian(用于多台部署区分,显示在管理房间名)
   多工程: 关闭(单工程)
   设备 ID: PICOURIERCM4KYDGY(固定,重跑 setup 复用;想换设备就删掉此字段)
   信任房间: 无(群聊默认不回应;可后续用 /enable 添加)

下一步: pi-courier enable(开机自启)或 pi-courier run(前台运行)
```

向导会验证 token 并写入 `~/.pi/pi-courier.json`。1.1.0 起向导会多问一题可选的出网代理(上方的真实记录早于该步骤;回车跳过即可)—— 见[出网代理](#出网代理运行期)。不想用向导的话,手动创建这个文件也行 —— 格式见[常见问题](#4-常见问题)。

### 第 2 步 —— 启动

```bash
pi-courier enable     # 安装 systemd 服务:开机自启 + 立即启动(Linux;Windows 见下方 Windows 章节)
```

想先快速前台测试:`pi-courier run`(Ctrl+C 停止)。

启动成功长这样(启动横幅固定英文,与消息语言无关):

```
✅ Matrix connected as @test3:... (2 rooms, E2EE enabled)
✅ pi RPC connected (model: deepseek-v4-flash, session: 019f...)
🚀 pi-courier ready. Waiting for messages...
```

### 第 3 步 —— 在 Matrix 里使用

**首次接触(一次性配对):**

1. 用你的账号**给 bot 发私聊消息**(随便发什么都行)
2. 此时你还不是 trusted user(比如 setup 时信任用户回车用了默认的 bot 自己),bridge 会在日志里打印验证码(`pi-courier logs` 或 `journalctl --user -u pi-courier -f`):

```
[2026-08-06T02:38:34.833Z] [INFO] 🔐 Challenge code for @barry: 529311
```

3. **在聊天里回复这串数字**(只发数字),日志确认配对成功:

```
[2026-08-06T02:38:44.487Z] [INFO] [auth:info] ✅ barry authenticated
```

配对成功后立刻可以正常对话:

```
[2026-08-06T02:38:55.685Z] [INFO] 📥 [matrix] @barry: 你好,收到请回复!
[2026-08-06T02:38:57.884Z] [INFO] [agent] 回复 @barry: 你好!收到,我在线。...
```

你就成为 trusted user(第一个 trusted 用户自动成为管理员)。多工程模式下,信任用户还会被自动邀请进管理房间,并在 bot 托管的所有房间自动获得管理员权限——见[多工程房间](#多工程房间项目隔离)。不在 `auth.trustedUsers` 里的用户都会走一次这个流程;预信任用户完全跳过。

**之后**正常对话,或发命令:

| 命令 | 作用 |
|---|---|
| `/new` `/clear` | 新会话 |
| `/compact [说明]` | 压缩上下文 |
| `/model` / `/model <provider/id>` | 查看 / 切换模型 |
| `/models` | 列出模型 |
| `/thinking [级别]` | 查看 / 设置思考级别 |
| `/session` `/cost` | 会话统计与费用 |
| `/status` | 当前模型与状态 |
| `/name <名字>` | 会话命名 |
| `/export [路径]` | 导出会话 HTML |
| `/bash <命令>` | 执行 shell 命令 |
| `! <命令>` / `!! <命令>` | shell 快捷执行,同 TUI 的 `!`/`!!`:`!` 的结果写入上下文(模型看得见),`!!` 不写入(只给人看)。感叹号 + 空格 + 命令,全角(`！`/`！！`)半角均可;不带空格(`!git`)则是普通消息 |
| `/bashstop` | 列出在跑的 bash 命令(`!`/`!!`/`/bash` 通用)并全部中止;各命令随后回帖已捕获的输出 |
| `/stop` | 立即停止所有任务,与 TUI 的 Esc 完全一致:同时**清空排队消息**并列出被清掉的内容(别名 `/abort`;pi 低于 0.84.4 时队列保留 —— 回复中会注明) |
| `/queue [文本]` | 查看队列 / 排队一条消息到运行中的任务之后(Alt+Enter 语义) |
| `/interrupt <文本>` | 打断运行中的任务并发送新指令 —— 一条消息完成两件事 |
| `/last` | 复述 agent 最近一次回复 |
| `/cyclemodel` / `/cyclethinking` | 轮换到下一个模型 / 思考级别 |
| `/sessions` / `/switch <序号>` | 列出最近会话 / 切换(流式中拒绝) |
| `/autocompact on\|off` / `/autoretry on\|off` | 自动压缩 / 自动重试开关(写入 pi 全局设置 —— 本机全部 pi 进程生效,重启后仍有效) |
| `/login` / `/logout <provider>` / `/auth` | provider 登录管理(仅管理员 + 管理房间) |
| `/mcp <子命令>` | MCP 服务器管理:list / add / remove / login / logout(仅管理员 + 管理房间) |
| `/reload` | 重启 pi(装完扩展/配置后);`/reload all` 重启本实例全部空闲 pi 进程 |
| `/help` | 完整帮助 |

**bridge 管理命令**:`/trusted`、`/revoke <userId>`、`/channels`、`/enable [chatId] <模式>`、`/disable <chatId>`、`/toggletools`

**其他任何 `/` 开头的内容**都直接透传给 pi —— 扩展命令、`/skill:名称`、提示词模板由 pi 展开。普通文本就是正常对话。

### pi 运行中:steer / 排队 / 打断

0.1.39 起发送语义与 pi 的 TUI 对齐。普通文本消息始终以 steering 语义发送(≈ TUI 的 Enter):pi 空闲 → 立即执行;pi 运行中 → 注入当前运行的任务。

- `/queue <文本>` — TUI 的 Alt+Enter:pi 运行中时排队,任务跑完自动执行;空闲时退化为立即执行
- `/queue` — 查看当前 steering / followUp 队列(条数 + 内容,并与 pi 上报的待处理条数交叉核对)
- `/interrupt <文本>` — 空闲:直接执行;运行中:打断当前任务并发送新指令
- `/stop` — 立即停止所有任务,同 TUI 的 Esc:排队消息一并清空

**队列何去何从,提前说明**:0.3.8 起 `/stop` 与 `/interrupt` 对齐 TUI 的 Esc —— 先**清空队列**再中止,回复中逐条列出被清掉的消息,不会有消息悄悄消失。pi 低于 0.84.4(无 `clear_queue` RPC)时保持旧有行为:队列保留并在**下一轮**生效,回复会显式注明(`⚠️ 队列中仍有 N 条消息将在下一轮生效`)。0.5.0 起连**非自愿**丢失也可见:子进程重启(/reload、崩溃拉起)时若队列非空,bot 主动发 `⚠️ 子进程重启,队列中 N 条消息未执行` 逐条清单——自己 `/stop` 清掉的不告警。服务级重启(systemd/机器重启)同样覆盖,限**多工程模式的项目房**:队列快照落盘 `~/.pi/pi-courier-state/queue-snapshots.json`,下次启动逐项目房补发 `⚠️ 服务重启,队列中 N 条消息未执行`,发完即清(被 `/reload` 报过的队列绝不二次误报;单工程默认进程不在覆盖范围——它绑定的是运行时私聊)。

### 工具循环聚合:一张「工作中」的卡片持续刷新

agent 跑长任务时,工具循环的**中间回合不再逐条刷屏**:首回合发一张「工作中」卡片,**卡里只有工具调用行**,之后的每个中间回合对**同一张卡就地编辑刷新**(Matrix 消息编辑,MSC2676;Element X / Element Web / FluffyChat 均就地渲染)—— 进度一眼可见,手机通知不再被中间轮轰炸。模型夹在工具调用之间的**旁白文本不进卡**:它独立成一条普通消息,当前工具卡就此定稿,后续工具调用开新卡继续刷新。**终答回合**照旧是独立新消息(挂状态脚注),重要结论的通知不会被编辑吞掉。用不支持编辑的旧客户端?你看到的是带 `* ` 前缀的全文 fallback,内容一点不少。卡片内容逼近单条消息上限(4000 字符)时自动**定稿旧卡、开新卡继续**(任意时刻只有最新一张卡会被刷新);编辑失败自动**退回逐条发消息**的旧行为,内容绝不丢。`/toggletools` 隐藏工具行(hideToolCalls)时聚合整体旁路,与旧版逐字节一致。

**部署提示(Synapse 限速)**:聚合会让 bot 的发帖频率显著升高(一次 N 轮工具循环 ≈ N 次编辑)。Synapse 默认按账号限速 `rc_message`(0.2 条/秒,突发 10)—— 被限速的最坏表现是**编辑延迟到达**:卡片刷新变慢,但编辑总会收敛到最终态,内容不丢(真不支持编辑时还有自动降级兜底)。自建 homeserver 可二选一豁免 —— 全局调高 `homeserver.yaml`:

```yaml
rc_message:
  per_second: 0.5
  burst_count: 15
```

或只给 bot 账号豁免(Admin API,两项设 0 = 不限;移除豁免对同路径发 `DELETE`):

```
POST /_synapse/admin/v1/users/<bot账号>/override_ratelimit
Authorization: Bearer <管理员 access_token>

{ "messages_per_second": 0, "burst_count": 0 }
```

**想退回旧版逐条模式?** 手动加 `aggregateToolTurns: false`(不在 setup 向导里),然后 `pi-courier restart` —— 行为与旧版逐字节一致:

```json
{ "aggregateToolTurns": false }
```

### 会话交接卡:/recap

`/recap` 让当前会话给自己写摘要 —— 目标、干完的事、未尽事项,不超过 5 个要点 —— 以 `📋 交接卡` 发回本房间,`/new` 从此不再是失忆开关。会话没聊出什么(完成对话不足两轮)或还有任务在跑时,`/recap` 会如实拒绝(它绝不和在跑任务抢 steering 语义)。多工程模式下卡片还会抄送管理房间,沉淀为 `📋 <项目名> 交接卡(项目干活日志)` —— 一条"这项目最近在干嘛"的时间线。

想让 `/new`(和 `/clear`)清会话**之前**自动出卡?手工加 `recap.onNew: true`(不在 setup 向导里),然后 `pi-courier restart`。**默认关** —— 每张卡都是一次真实模型调用(几百 token);生成失败绝不阻塞 `/new`,交接卡是锦上添花,不是依赖项。

### 扩展提问直接在房间回答

扩展经 RPC 发起 confirm / select / input / editor 交互时,bot 会把问题发成一条聊天消息 —— 你的下一条普通回复就是答案:

- confirm → 回复 `y` / `n`(`yes` / `no` 也可以);select → 回复序号;input / editor → 直接打字
- 发送"取消"或 `cancel` 即可放弃 —— 两种写法在任何语言下都认
- 多个问题悬置时最老的先答;`/` 开头的消息仍走命令通道
- 扩展通知按级别分档:warning / error 进房间,info 只留日志

悬置问题超过 `extensionUiTimeoutMinutes` 分钟(默认 10)即自动按取消处理 —— 房间收到通知,扩展收到取消应答。该字段**不进** setup 向导:手动加进 `~/.pi/pi-courier.json`,然后 `pi-courier restart` 生效:

```json
{ "extensionUiTimeoutMinutes": 10 }
```

bash 回帖(`!` / `!!` / `/bash`)发帖前会截断输出:上限 `bashOutputLimit` 字符(默认 30000)。配置值超过 65536 按 65536 钳制 —— 64KB 是 Matrix 单事件大小上限,再长的回帖也会被 homeserver 拒。该字段同样**不进** setup 向导:

```json
{ "bashOutputLimit": 50000 }
```

### 自定义头像(空间 / bot / 项目房间)

不喜欢抽到的内置头像?给任意目标配一张自己的图,重启生效(该组字段**不进** setup 向导):

```json
{
  "spaceAvatar": "~/pix/space-face.png",
  "botAvatar": "faces/agent.png",
  "projects": {
    "!roomId:server": { "name": "我的项目", "workdir": "~/Projects/app", "avatar": "/abs/path/room.png" }
  }
}
```

- 路径支持 `~` 展开;相对路径相对 `~/.pi/` 解析;格式按扩展名识别(png / jpg / jpeg / webp / gif)。
- **配置即期望状态**:配置后每次启动校验——图片内容或房间当前头像与最近一次上传不符时,自动重新上传覆盖(改图后重启即生效);没配的照旧「只补缺不覆盖」。
- 文件缺失、扩展名不支持或上传失败:启动日志 warn 一次,本次回落内置图池逻辑,房间不会没有头像。
- 项目房间配了 `projects[].avatar`(以房间 ID 为键)后,`/pmctl rename` 改名仍用你的自定义图;没配的按新名字重新从内置图池选图(同空间自动错开已占用的图,不会撞图)。

### 机器人语言:中英双语(zh / en)

全部机器人消息 —— 命令回复、配对提示、扩展提问、管理房使用说明 —— 从 0.3.0 起默认英文,改一处配置即可切换成中文:

```json
{ "language": "zh" }
```

语言解析链(命中即停):

1. 环境变量 `PI_LANGUAGE=en|zh` —— 容器/极简部署里最稳
2. `~/.pi/pi-courier.json` 的 `"language": "zh" | "en"`(setup 向导首问并写入)
3. 服务的系统 locale:Linux/macOS 上为 `LC_ALL` > `LC_MESSAGES` > `LANG`(`zh*` → 中文);Windows 不设置这些变量,改读系统区域设置 —— 中文 Windows 即中文。启动日志会打一行说明语言从哪来
4. 最终回落英文

注意:

- 语言修改重启生效(与 `multiProject` 同语义)
- **从 0.2.x 升级、想保持中文?** 配置里加一次 `"language": "zh"`(或重跑 `pi-courier setup`)即可;系统 locale 为 `zh_CN` 的 0.2.x 部署升级后零操作保持中文;无论哪种语言,取消关键词永远双语(`取消` 和 `cancel` 都认)
- 中文表是简体;`zh_TW` / `zh_HK` locale 同样给简体
- Windows 读的是"区域格式"设置(控制面板「区域」里定义的那个);显示语言与区域格式不一致的混合配置可能指向错误语言,此时请显式指定 `PI_LANGUAGE`(或配置 `language`)
- 已建好的房间保持原有名称与使用说明 —— 切语言不会追溯改名

### 模型调用失败时

某一轮调用失败(用量耗尽、认证过期、provider 不可达……)会通知房间:`❌ 本轮失败: <原因>`。自动重试全程可见 —— 每次重试发 `⚠️ 调用失败,正在重试 n/N`,重试耗尽后发最终错误。用户主动 `/stop` 不会触发错误通知。

### 模型降级链:连续失败自动切备用

一家 provider 抽风不该把任务卡死在一个坏模型上。在 `pi-courier.json` 里配一条链(重启生效):

```json
"modelFallbacks": ["zai/glm-5.3", "deepseek/deepseek-v4-flash"]
```

当**同一个 pi 进程连续 2 轮彻底失败**(那时 pi 自己的 auto-retry 早已耗尽),桥会自动切到链上下一条,并在房间明说:`⚠️ 连续 2 轮失败,已自动切换模型: <旧> → <新>。provider 恢复后发 /model <旧> 可切回` —— 同时审计日志记一行 `model.fallback`。规则:

- 任何一轮成功即清零计数;下一次连败沿链**向后**推进,绝不回头。
- 链走完只发**一次** `❌ … 降级链已走完` 提示,之后照常报错 —— **不循环**,提示也不重复轰炸。
- **不做自动切回**:provider 恢复后自己发 `/model <旧>` 切回(回执里写明了)。
- 项目房可用 `projects[].fallbacks` 配自己的链,**项目链优先于全局链**(见下方"每项目预设")。
- 不配置 = 行为与旧版逐字节一致。格式坏掉的条目启动时警告并跳过。

### 聊天里登录 provider:`/login`

不用开终端也能(重新)登录 provider:

- `/login` — 列出可登录的 provider(标注 oauth / api_key 能力,已认证的带 ✅ 标记)
- `/login <provider> [oauth|api_key]` — 在房间里交互式登录,任意时刻发送"取消"或 `cancel` 可中止。**OAuth**:点开链接在任意浏览器完成授权,把重定向 URL 粘贴回房间。**API key**:直接粘贴。⚠️ 粘贴的内容会留在房间历史 —— 在意的话事后删除该消息。
- `/logout <provider>` — 删除已存凭据(运行中的 pi 进程仍持有内存里的旧凭据;空闲后执行 `/reload all` 生效)
- `/auth` — 查看已认证的 provider

权限:仅管理员 + 仅管理房间(单工程模式 = 与 bot 的私聊)。登录成功后**空闲的** pi 进程自动重启以加载新凭据;忙碌的会提示稍后 `/reload`。凭据直写 pi 的标准凭据文件(`~/.pi/agent/auth.json`),与本机全部 pi 进程共享 —— pi-courier 自身既不保存也不显示密钥。

### 聊天里管理 MCP 服务器:`/mcp`

MCP(Model Context Protocol)服务器是给 AI 外接工具的插线板。pi 1.0 起 MCP 配置完全归 pi 管,`/mcp` 把 `pi mcp` 命令族原样搬进聊天 —— 不用 SSH 到桥主机,就能查看状态、增删服务器、完成 OAuth 登录:

| 命令 | 作用 |
|---|---|
| `/mcp`(即 `/mcp list`) | 一张状态卡列出全部服务器:连接状态 / 传输方式 / 工具数 / 作用域;需要登录的附 `/mcp login` 提示,空列表附添加指引。探测较慢时先回一条「检查中」 |
| `/mcp add <名字> --url <地址>` | 添加远程 HTTP 服务器(可重复传 `--header`) |
| `/mcp add <名字> <命令> [参数…]` | 添加本地 stdio 服务器;`--env` / `--header` / `--cwd` / `--description` / `--exposure` 按 pi CLI 语义透传 |
| `/mcp remove <名字>` | 删除服务器;对同名 `/mcp add` 即替换,不用先删后加 |
| `/mcp login <名字> [--timeout 秒]` | OAuth 登录:bot 把授权链接发进房间,浏览器点开授权即可(默认 300 秒,桥侧硬上限 600 秒) |
| `/mcp logout <名字>` | 清除该服务器的 OAuth 凭证(换账号 / 撤销授权) |
| `/mcp help` | 子命令用法 |

命令按 shell 风格引号分词,`--` 之后的参数原样透传;参数缺失或选项打错收到的是用法回执,不会被当成对话喂给模型。

**权限与安全**:仅管理员 + 管理房间可用(单工程模式 = 与 bot 的私聊),访客一律硬拦;添加 / 删除 / 登录 / 登出四种动作进审计日志(`list` 只读不记)。`--env` / `--header` 的**值**在任何回执里都不回显(只回显键名)—— 密钥不会留在聊天记录里。

**改动何时生效**(回执里都会写明):

- **登录 / 登出:即刻生效** —— 运行中的 pi 会话下一回合自动用上,无需 `/reload`;
- **添加 / 删除:需 `/reload` 生效**;多工程部署发 `/reload all` 重启全部空闲 pi 进程。

**OAuth 回跳限制(远程部署必读)**:pi 的 OAuth 回跳绑定**桥主机**本机(`127.0.0.1`)。`/mcp login` 会把授权链接发进房间,但**打开链接的浏览器必须能访问到桥主机上的回跳地址** —— 桥部署在服务器、你用手机点链接时,手机浏览器到不了服务器的 `127.0.0.1`,授权页会一直转圈直到超时。两条解法任选其一:

```bash
# 在你本地电脑开一条 SSH 隧道,把桥主机上的回跳端口转到本地同名端口
ssh -L <端口>:127.0.0.1:<端口> <用户>@<桥主机>
```

或按你的网络方案让桥主机的该端口对你的浏览器可达(防火墙放行等)。登录回执里也会带上这条提示。

**v1 只管全局配置**:`/mcp` 的所有改动都落在全局 `~/.pi/agent/mcp.json`,对本机全部 pi 进程(所有项目)生效。项目级 `.pi/mcp.json` 暂不支持:项目级配置受 pi 的项目信任门约束,无界面的 RPC 模式下未信任项目会被**静默拒绝**,聊天侧无法完成信任确认;全局配置天然覆盖所有项目,项目级支持留作后续扩展。

**版本要求**:pi ≥ 1.0(旧版 pi 没有 `pi mcp` 子命令,`/mcp` 会回执提示升级,不会神秘报错)。

### 引用更早的消息

在房间里回复(reply)一条更早的**用户**消息(比如你自己之前发的长指令)再发新指令:被引用原文的单行摘录(约 200 字)会自动拼进 prompt 前缀,并标注来源(`「引用自 @用户 的历史消息:…」`)—— agent 分得清第三方内容与实时指令,指代("这个""上面那个")也照样能懂。摘录缓存是每房间独立的内存缓存(最近 50 条);bot 自己的回复不入缓存,未命中的引用(太旧、或重启之前的消息)静默忽略 —— 消息照常发出,只是没有前缀。

### 发送图片和文件给 agent

在 Element 里**直接粘贴/发送文件**即可 —— bot 先保存,再由 agent 查看:

1. 粘贴图片(或发文件)→ bot 回执 `📎 附件已保存: <绝对路径>`,**不会**惊动 agent;
2. 随后发一条文字说明 → 路径自动拼进 prompt,agent 用 `read` 工具查看(与 pi TUI 的 `@路径` 工作流一致),结合图和说明开始干活。注入头部自带来源标注(`用户 @user 在房间 <room> 发来附件`)—— agent 永远知道这是谁发的文件。

支持类型:`m.image` / `m.file` / `m.audio` / `m.video` / 贴纸。图片由 pi 读取后交给视觉模型(其 read 管线自带缩放,发送前压大图,见 pi 源码);音频/视频无法直接喂给模型,但 agent 可以用 bash/ffmpeg 自行处理。限制与细节:

- **单个附件上限 10 MB**(可配 `attachments.maxMb`,setup 向导可改);超限/下载失败会回执原因,**不静默**
- 附件统一存到 `~/.pi/pi-courier-attachments/<房间>/`(可配 `attachments.directory`),**不进项目工作区**,不会弄脏 `git status`
- 待处理附件按"房间+发送者"记账:`/pmctl`、`/login` 等命令不消耗清单;**重启后清单清空**(回执里有路径,可手动引用)
- 加密房间(E2EE)同样支持,附件自动解密
- 位置消息等不支持的类型会收到礼貌提示;模型本身不支持视觉时,pi 会告知看不了图 —— 这是模型能力,与桥无关

> **群聊**:**成员数 >2 的房间默认静默** —— bot 被拉进群时会发一条一次性提示,之后不回应任何消息,直到启用。**启用方式(无需房间 ID)**:直接在群里发 `/enable <all|mentions|trusted-only>`(信任用户,默认 trusted-only);或在 DM 里发 `/enable <房间ID> <模式>`。**2 人房间(你 + bot)自动回应**。房间 ID 形如 `!xxx:服务器`(日志可见)。

### 访客档:能对话,不给钥匙

把 bot 分享给同事不必连管理员权限一起交出去。在 `auth.guestUsers` 里手工列访客(MXID,与 `trustedUsers` 同款 `matrix:@user:server` 形式;重启生效),他们即获得中间一档:

- **访客可以**:在 DM 和全员启用的群里聊天、发附件、用只读命令(`/help` `/status` `/cost` `/models` `/queue` …);
- **访客不能**碰危险面 —— 桥在**任何东西执行之前**就拦下,礼貌回执 `🚫 此命令需要信任用户权限:<命令>`:shell 执行(`!` `!!` `/bash` `/bashstop`)、项目管理(`/pmctl*`)、认证(`/login` `/logout` `/auth`)、生命周期(`/reload` `/stop` `/interrupt` `/enable` `/disable` `/switch` `/multiproject`)、信任名单(`/trusted` `/revoke` `/toggletools`)、主动外发(`/remind`)与会话镜像(`/attach` `/detach`);
- 每次拦截都进审计日志(见下节);权限边界在桥、不靠模型自觉 —— 但也如实声明边界:访客的**对话**仍可驱动 agent 自己的工具(pi 无按会话的工具开关,那是上游领地);
- 房间模式语义优先:`trusted-only` 群照样把访客挡在门外;访客也**永不触发配对码** —— 名单内直接聊。

### 审计日志:敏感动作留痕

每个敏感动作都会向 `~/.pi/pi-courier-state/audit.jsonl`(0600,只追加)追加一行 JSON:谁、何时、在哪个房间、干了什么 —— 配对成败、`/trusted` 与 `/revoke`、bash 执行(`!` `!!` `/bash`)、`/pmctl rm`、`/login` 家族、`/reload`、队列清理、离线积压批量执行,以及每一次访客拦截。文件 10MB 轮转(保留两份旧档);文件不可写时服务照常跑但向管理房间告警 —— 审计故障可见,但绝不放大成可用性故障。第二层加固:附件与引用进 prompt 时自带来源标注(见上文两节),第三方内容以数据身份进上下文,不冒充指令。

### 单工程 / 多工程模式

**默认是单工程(简单模式)**:一个 bot 账号对应一个 pi,所有房间直接连默认工作目录(`workdir`),**没有**管理房间 / 项目房间概念,`/pmctl` 也不可用 —— 适合只想和 bot 直接聊天的用户。

**需要隔离多个项目时开启多工程**:

- setup 里"启用多工程模式?"选 `y`
- 或之后在聊天里发 `/multiproject on`,再用 `pi-courier restart` 重启生效

> **离线收件箱**(0.5.0 起):bot 离线/重启窗口里收到的消息**不再丢失**——重启后按房间汇总征询(「离线期间收到 N 条」+ 逐条列表),回复**「执行」**按序处理、**「忽略」**丢弃(10 分钟内有效,超时视为忽略)。默认即此行为;配置 `inbox.mode: "auto"` 改为告知后自动执行,`"off"` 恢复旧版「直接丢弃」。未信任发送者的积压照常走门控,不会变成越权旁路。

`/multiproject`(信任用户可发):`on` 开启 / `off` 关闭(都需重启生效);不带参数显示当前状态。多工程模式下才有下面的管理房间/项目房间机制。

### 多工程房间(项目隔离)

同一个 bot 账号可以服务多个项目 —— 每个项目一个私有房间(房间名=`项目名(实例名)`),有独立的 pi 进程、工作目录和会话历史。

- **管理房间**:开启**空间组织**时(全新多工程配置默认开启),bot 在启动时**自行创建**管理房间 —— 位于私有空间 `π <实例名>` 内,并邀请全部信任用户,无需先给 bot 发 DM;后续经验证码加入的信任用户也会被自动邀请进管理房间(每人只邀一次,失败由下次启动自愈重试)。空间关闭(或创建失败)时沿用经典行为:bot **第一次成功受理(授权通过)的、非项目的私有/2 人房间**固化为管理房间(自动改名 `项目管理(<实例名>)` 并发送使用说明,房间 ID 写入 `config.managementRooms`)。两种路径下管理房间都是"管理台"(`/pmctl` 仅在此可用),且房间 ID 之后保持稳定。
- **空间组织(Element)**:纯展示层收纳 —— 私有空间 `π <实例名>` 收集 bot 创建的所有房间(管理房间 + `/pmctl new` 的项目房间),不再散落在房间列表里;空间本身不参与授权判定——谁能发命令、谁有什么房间权限,由下面的权限模型决定。`/pmctl rm` 删除项目时同步把房间移出空间。开关在 `setup`(`启用空间组织?`,全新配置默认开、已有配置保持现状);空间在下次启动时懒创建,失败仅警告并回退无空间行为、下次启动自动重试。后续通过验证码成为信任用户的用户会被自动邀请进空间(每人只邀请一次)。还叫旧名字 `pi-courier · <实例名>` 的空间会被下次启动自愈改成短名(手动改过名的空间不动)。
- **头像(三套素材,每套 24 图,主色沿色环散开)**:bot 自动为它托管的一切配上内置头像——而且每种实体一套,一眼就能分辨:**空间**用**风景**套(极光雪山、海岛、云海浮岛、光环行星、星系…),**项目房间**用**建筑**套(姜饼小屋、中式湖亭、五重塔、公主城堡、神社、太空舱…),**管理房间**用建筑套专属的金顶城堡,**bot 账号自己**(agent 的脸,显示在成员列表和它发的每条消息旁)用**动物**套(狐狸、兔子、熊猫、独角兽、小龙…)。每套 24 张、图图不同主体、主色沿色环散开:同套内按实例名/项目名哈希取图(同名永远同一张),同空间的项目房自动错开已占用的图(不会出现两个房间头像一模一样),不同实例之间也基本不会撞色撞图。存量房间下次启动自动补齐,手动设置过的头像绝不被覆盖——除非某套素材整体换风格,那一次该套管辖的范围会在下次启动统一刷成新图,且各套独立迁移、互不牵连(此后你手动设置的头像恢复"绝不被覆盖")。不满意抽中的图?见上方「自定义头像」,把任意目标换成你自己的图;或替换 `assets/avatars/` 下的同名 PNG,无需改代码。
- **权限模型(信任即管理员)**:信任用户在 bot 托管的所有房间——空间、管理房间、全部项目房间——自动拥有**管理员权限**(PL 100)——无论信任来自 setup 还是验证码、是否已加入该房间(后加入者进房时权限已就位)。`/revoke <userId>` 撤销信任时,该用户在全部托管房间的管理员权限**同步收回**(降回普通级别),降权失败由下次启动自愈兜底。零配置,升级后的首次启动自动补齐存量房间;旧版本(≤0.1.36)由旧特例(项目房间创建者提权)成为管理员的用户不在降权簿记内——`/revoke` 仍会即时对其降权,仅当那次即时降权也失败时才需在客户端手动降一次。
- **创建项目**(在管理房间发):
  ```
  /pmctl new <项目名> [路径]
  ```
  **路径可选**:缺省为项目根目录下的同名目录(`newapp` → `~/Projects/newapp`);也可用相对路径(基于项目根目录)或绝对路径。bot 创建以项目命名的私有房间、邀请发送者进房、把映射写入 `pi-courier.json`(`projects` 字段)并回复确认。项目对话在新房间进行 —— 上下文和 bash 工作目录完全隔离。
- **项目管理命令**(`/pmctl`,**仅在管理房间可用**;项目房间只能对话):
  ```
  /pmctl list                 项目列表
  /pmctl show <名称|房间ID>    项目详情
  /pmctl rm <名称|房间ID>      删除项目(停进程+解除映射,房间保留)
  /pmctl mv <名称> <新路径>    迁移工作目录(会话重新开始)
  /pmctl rename <名称> <新名>  重命名(同步改房间名)
  ```
  旧命令别名仍可用:`/newproject`、`/projects`。
- **手动配置**也可以:直接编辑 `pi-courier.json` 加 `projects` 映射(配置在启动时装载一次 —— 手动编辑后需重启服务生效):
  ```json
  "projects": {
    "!房间ID:服务器": {
      "workdir": "/home/你/Projects/api",
      "model": "deepseek/deepseek-v4-flash",
      "thinkingLevel": "high",
      "fallbacks": ["zai/glm-5.3"]
    }
  }
  ```
- **每项目预设**(0.7.0 起;`model` / `thinkingLevel` / `fallbacks`,全部可选):每个项目记住自己的默认模型与思考级别 —— A 项目用便宜快模型,B 项目用强推理模型,换项目干活零重设。进程在每次启动**和每次 `/reload`** 后应用一次(房间一行 `📋 项目预设已应用: …`)。预设是**开机默认,不是锁定**:之后手动 `/model`、`/thinking` 照常生效,直到下一次重启回到预设。应用失败绝不阻塞进程 —— 一行警告,然后手动设置兜底。思考级别取值:`off minimal low medium high xhigh max`;`model` 与 `/model` 参数同语法 `provider/id`(裸 id 按可用模型列表解析)。`fallbacks` 是该项目的降级链(见上方"模型降级链")—— 项目链优先于全局链。`/pmctl show` 会展示项目预设。
- 每个项目房间的 pi 进程按需懒启动(约 300MB/项目),会话存于 `<workdir>/.pi-session`,重启后各项目会话独立恢复。

### TUI ↔ Matrix 会话镜像(双端同步)

人在终端干活,bot 把一切同步到 Matrix。在房间里发:

```
/attach
```

bot 会回复一条可直接复制的终端命令,例如 `pi --session <会话ID>`(部署用了自定义会话目录时带 `--session-dir`)。在终端跑它附加同一会话,两端即保持同步:

- **TUI → Matrix(实时镜像)**:TUI 里你发的每条消息、agent 的每条回复都实时转发进房间——你的消息带 `🖥 **TUI·用户**` 前缀、agent 回复带 `🤖 **TUI·助手**` 前缀(消息都由 bot 账号发出,角色前缀是唯一区分);工具调用过程不转发,只同步对话文本。
- **Matrix → TUI(继承上下文)**:附加打开的就是同一个会话文件,TUI 启动即带着 Matrix 侧聊过的全部历史。
- **回到 Matrix(自动接力)**:TUI 干完活,直接回房间发消息——bot 会在空闲时先重载会话文件再作答,agent 的上下文自动包含 TUI 里发生的一切;进行中的任务与排队消息绝不会被重载打断。
- **TUI 侧 `/new`**:TUI 里开的新会话照常镜像,但房间会收到一条提示——Matrix 侧仍在原会话,两边上下文互不相通(不同的会话文件)。要让 Matrix 跟上:`/sessions` 后 `/switch <序号>`,或重新 `/attach` 获取新会话的命令;Matrix 侧 `/new` 之后同理,TUI 里重新 `/attach`。
- **分叉提示**:TUI 进程不会自动重读会话文件,Matrix 侧回复后你在 TUI 里续写,就会从旧节点接枝——bot 会提示一次并说明如何拉平(在 TUI 里 `/resume` 重进本会话即可接上 Matrix 侧的内容)。自动接力**不会**因此中断:它继续跟随会话文件里的最新分支。

`/detach` 关闭该房间的镜像。镜像按房间隔离、跟随房间自己的进程:项目房间镜像本项目的会话目录;走共享默认进程的房间镜像其会话目录并按工作目录过滤,其他项目的终端会话不会串进来。

### 服务管理

```bash
pi-courier status              # 状态 + 最近日志(可加项目名:pi-courier status <项目>)
pi-courier logs                # 跟踪日志(INFO 及以上)
pi-courier logs ai-api         # 多工程:只看该项目的打标日志
pi-courier logs ai-api www --level debug   # 多项目 + 全量细节
pi-courier logs --level debug  # 跟踪全部日志(含思考、流式增量)
pi-courier logs --level error  # 只看错误
pi-courier run --level debug   # 前台运行,全量显示
pi-courier restart             # 重启
pi-courier stop                # 停止
pi-courier start               # 启动
pi-courier disable             # 卸载服务
pi-courier update              # 更新 pi-courier 自身
pi-courier -v                  # 显示当前版本(--version/version 亦可)
```

日志级别:`debug < info < warn < error`。服务会把全部内容写入日志;`logs` 默认显示 INFO 及以上,`--level debug` 显示完整会话回放(用户消息、思考、工具调用、回复)。多工程模式下,项目相关日志行带有 `[项目名]` 标签,`logs <项目名>` 即可只看该工程(大小写不敏感;项目名 = `/pmctl` 的名称,未命名时为工作目录的目录名)。过滤经 `journalctl --grep` 实现,要求 journald 支持 PCRE2(Debian/Ubuntu 标准支持)。完整对话始终保存在 pi 的会话文件(`~/.pi/agent/sessions/`)。

**升级 pi** 是独立的事 —— pi-courier 始终通过 `which pi` 连接系统 pi:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi-courier restart
```

pi.dev 托管安装(`~/.pi/agent`)同样支持:pi-courier 会把 `bin/pi` 包装脚本自动解析到当前版本的真实 JS 入口,pi 升级后无需改配置(0.3.1 起)。

## Windows

自 1.0.0 起正式支持,并已于 2026-10-14 在真实 Windows Server 2025 机器上端到端验收:安装(原生库下载 + sha256 校验 + 加载)、配置向导、Matrix 连接、`!`/`!!` bash、单实例锁、多工程房间与空间组织、任务计划程序自启、Ctrl+C 干净退出。除下文明确列出的限制外,行为与 Linux 一致。

**系统要求**:

- Node.js >= 22.19(与 pi 1.x 的硬性下限一致)
- **Git for Windows** —— `!` / `!!` 命令由它自带的 bash 执行;没装的话会得到一条可读的报错
- pi,全局安装 —— 发现方式见下

E2EE 加密原生库对 `win32-x64-msvc` / `win32-ia32-msvc` / `win32-arm64-msvc` 提供预编译产物,安装时下载并做 sha256 校验(x64 已真机验证:`.node` 落在 `~/.cache/pi-courier/native-crypto/`,经 N-API 正常加载)。

**安装与运行**:

```powershell
npm install -g pi-courier
pi-courier setup
pi-courier run
```

npm >= 11 开了 install-scripts 门禁的机器(会出现 `npm warn install-scripts` 警告)会静默跳过 postinstall——包括原生库自检;带白名单装一次:

```powershell
npm install -g --allow-scripts=pi-courier,@matrix-org/matrix-sdk-crypto-nodejs pi-courier
```

验证:`pi-courier -v`。npm 装到 `%APPDATA%\npm` 的 `.cmd` / `.ps1` 垫片照常可用。

- **pi 自动发现**:npm 全局安装的 `@earendil-works/pi-coding-agent` 会从 pi-courier 自身的安装树自动解析命中;pi.dev `install.ps1` 装在 `~/.pi/agent` 的同样自动识别。只有特殊布局才需要把 `PI_CLI_PATH` 指到 pi 包目录里的 `dist/cli.js`——**不要**指 `pi.cmd` / `pi.ps1` 垫片。
- **`!` / `!!` bash 命令走 Git for Windows 的 bash** —— POSIX 路径(`/c/Users/...`)、退出码、报错信息都与 Linux 一致地透传。
- **`pi-courier update` 在 Windows 上可用**:它通过 npm 的 `npm-cli.js` 入口启动 npm,并跳过 systemd 的停启编排。
- **任务计划程序自启**(无需管理员,每次登录触发)——真机验证过的配方:

  ```powershell
  $action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c pi-courier run >> %USERPROFILE%\pi-courier-run.log 2>&1'
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName 'pi-courier' -Action $action -Trigger $trigger
  Start-ScheduledTask -TaskName 'pi-courier'   # 立即启动;此后每次登录自动拉起
  ```

  想要真正无控制台窗口的后台服务,可用 [NSSM](https://nssm.cc/) 包一层;或者干脆保持前台会话。
- **Ctrl+C / Ctrl+Break(SIGBREAK)干净退出** —— pi RPC 停止、Matrix 断开、单实例锁释放。
- **单实例锁**行为一致:崩溃残留的锁会被下次启动自动接管,无论从控制台还是任务计划程序启动。
- 配置文件权限检查(0600)在 Windows 上跳过:系统无法表达 POSIX 权限位,继续检查只会每次启动误报。

**已知限制**:服务管理子命令(`enable` / `start` / `stop` / `restart` / `status` / `logs` / `disable`)仅支持 Linux(systemd),在其他平台会直接报错退出;`pi-courier logs` 的过滤依赖 journald(Linux)。配置、会话、附件与状态数据与 Linux 相同,都在 `%USERPROFILE%\.pi\` 下。

## 4. 常见问题

**Q: `npm install` 卡住 / 只有 20-60 kB/s?**
A: 21 MB 的 E2EE 原生库从 GitHub Releases 下载,不走 npm 代理。先 `export https_proxy=... http_proxy=...`(写进 `~/.bashrc` 永久生效)再装。

**Q: 报 `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-…'`(任意平台后缀)?**
A: 原生二进制没下载——postinstall 被拦。npm ≥ 11 开了 install-scripts 门禁的机器上这是**静默**的;带白名单重装一次 `npm install -g --allow-scripts=pi-courier,@matrix-org/matrix-sdk-crypto-nodejs pi-courier`。源码方式则手动补:`cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs && node download-lib.js`。

**Q: `npm install -g pi-courier` 报 EEXIST?**
A: 之前 `npm link` 过,bin 冲突。`npm unlink -g pi-courier && rm -f $(npm prefix -g)/bin/pi-courier && npm install -g pi-courier`。

**Q: 装完了,但 `pi-courier: command not found`?**
A: 多半是用了 pi.dev 包页面给的 `pi install npm:pi-courier`。那条命令是把 pi-courier 装成 pi 扩展(pi 里多一个 `/pi-courier` 用法提示),不是装 CLI。用 `npm install -g pi-courier` 装 CLI,顺手可用 `pi remove npm:pi-courier` 清掉误装的扩展。

**Q: systemd 服务反复重启?**
A: 几乎都是 Node 版本不匹配 —— pi 子进程在系统 node v20 上崩溃(报 `webidl.util.markAsUncloneable is not a function`)。加载 nvm 后重新 `pi-courier enable`(0.1.2+ 会自动写入正确的 PATH)。全机统一一个 Node 版本。

**Q: 启动显示 `model: unknown`?**
A: pi 的 provider 没配。检查 `~/.pi/agent/`:`models.json` + `auth.json` + `settings.json`(字段名是 `defaultProvider` / `defaultModel`)。

**Q: 日志大量 `Decryption error`?**
A: 历史消息无法解密(新设备没有旧密钥)。**正常**,新消息不受影响。

**Q: 加密房间:发消息没回复 / 新消息解不开?**
A: bot 的新设备没拿到房间密钥。bot 账号没有交叉签名,最可靠的解法是**用非加密房间**(新建房间时不勾选加密,把 bot 拉进来)—— 配置 `encryption: true` 也照常处理非加密房间。

**Q: 报 `M_BAD_JSON: Provided device_id in device_keys does not match...`?**
A: 本地加密存储与 token 的设备身份不一致(换过 token / 粘贴了别的设备的 token)。**0.1.20 起用密码登录走固定 device_id,重跑 setup 不再出现此问题**。仍遇到时:删除加密存储重启 `rm -rf ~/.pi/pi-courier-matrix-crypto && pi-courier restart`(每次重跑 setup / 换 token 都顺手删一次)。

**Q: 报 `One time key signed_curve25519:... already exists`(M_UNKNOWN)?**
A: token 在服务器上已绑定旧设备,但本地与服务器的 OTK 记账错位 —— **删本地 crypto store 无效**(device ID 由服务器按 token 指定,删了重建还是同一个)。**必须换 token**:重跑 `pi-courier setup`,在"保留现有 token?"处输 `n` 重新获取(或直接密码登录),新 token = 新设备 = 服务器干净。换 token 后如遇 device 残留问题再配合删 crypto store。

**Q: 第一次发消息要 6 位验证码?**
A: 这是挑战认证 —— 把验证码回复给 bot 即成为 trusted user。

**Q: 消息完全没有回复?**
A: 按顺序排查:(1) `pi-courier status` —— Matrix 连上了吗?有 Decryption error 吗(加密房间)?(2) pi RPC 连上了吗?(3) 模型调用本身 —— 用 curl 直接测 provider 端点。

**Q: `pi RPC did not become ready`?**
A: pi 启动失败。手动跑 `node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc` 看真实报错。常见原因:Node 版本不匹配、provider 配置错误、无法访问 provider。

**Q: 重启后对话上下文丢了?**
A: 0.1.1 起 bridge 会给 pi 传 `--continue`,按 workdir 恢复最近会话。升级并重启即可;`/new` 开新会话,下次重启恢复新会话。

**Q: Element(网页客户端)拦截 `/` 开头的消息?**
A: 用 `//` 转义发送字面文本(如 `//compact` 会发出 `/compact`)。

**Q: `~/.pi/pi-courier.json` 里到底有什么?**
A: 向导生成的配置,示例:

```json
{
  "matrix": { "homeserverUrl": "https://matrix.example.com", "accessToken": "syt_...", "encryption": true },
  "auth": { "trustedUsers": ["matrix:@你:matrix.example.com"], "adminUserId": "matrix:@你:matrix.example.com" },
  "workdir": "/home/你/Projects",
  "multiProject": true,
  "space": { "enabled": true },
  "autoConnect": true,
  "debug": true
}
```

环境变量替代(优先级:环境变量 > 配置文件 > 向导):

| 变量 | 对应字段 |
|---|---|
| `PI_MATRIX_HOMESERVER` + `PI_MATRIX_ACCESS_TOKEN` | matrix.homeserverUrl / accessToken(两者同时设置才生效) |
| `PI_MATRIX_ENCRYPTION` | matrix.encryption(`true`/`false`) |
| `PI_MATRIX_TRUSTED_USERS` | auth.trustedUsers(逗号分隔 MXID,如 `@barry:matrix.example.com`) |
| `PI_WORKDIR` | workdir |
| `PI_LOG_LEVEL` | logLevel(debug/info/warn/error) |

LLM key 也可用环境变量:auth.json 里写 `"key": "${PI_LLM_API_KEY}"`,pi 启动时从环境变量读取(Docker 部署的模板已默认如此)。

## 5. 协议与声明

MIT License —— 见 [LICENSE](LICENSE)。

**上游来源**:本项目改造自 [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge)(MIT)。Matrix 传输层与挑战码认证来自上游;基于 RPC 的独立架构、slash 命令映射、CLI、配置向导与文档为本项目新增。

pi-courier 是 [pi](https://pi.dev) 的独立伴侣应用,与 Earendil Inc. 无隶属关系。
