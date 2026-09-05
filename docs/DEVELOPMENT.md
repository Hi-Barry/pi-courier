# pi-courier 开发全记录

> 从"Matrix 里发不出 `/` 命令"的一个疑问,到一个可发布的 npm 包。
> 本文记录 pi-courier 从调研、设计、开发、部署到发布的全过程,以及过程中踩过的每一个坑。

---

## 目录

1. [项目缘起](#1-项目缘起)
2. [调研:为什么 `/` 命令发不出去](#2-调研为什么-命令发不出去)
3. [方案选型:扩展模式还是 RPC 模式](#3-方案选型扩展模式还是-rpc-模式)
4. [阶段一:RPC 可行性验证](#4-阶段一rpc-可行性验证)
5. [阶段二:standalone 独立进程](#5-阶段二standalone-独立进程)
6. [阶段三:Matrix 端到端打通](#6-阶段三matrix-端到端打通)
7. [阶段四:模型 Provider 配置](#7-阶段四模型-provider-配置)
8. [阶段五:从 fork 到独立项目](#8-阶段五从-fork-到独立项目)
9. [阶段六:一键 CLI](#9-阶段六一键-cli)
10. [阶段七:发布到 npm](#10-阶段七发布到-npm)
11. [阶段八:从单工程到多工程、再到空间组织](#11-阶段八从单工程到多工程再到空间组织)
12. [踩坑全记录](#12-踩坑全记录)
13. [技术架构](#13-技术架构)
14. [关键设计决策](#14-关键设计决策)
15. [版本演进](#15-版本演进)
16. [经验与反思](#16-经验与反思)
17. [未来展望](#17-未来展望)

---

## 1. 项目缘起

一切的起点,是用户的一个困惑:

> "我在使用 pi-messenger-bridge 通过 Matrix 使用 pi coding agent,但是发现一些限制,比如 / 命令无法发送,你帮我研究一下。"

**pi**(原名 pi-coding-agent)是一个终端原生的 AI 编程助手,支持丰富的 slash 命令(`/new`、`/compact`、`/model`、`/skill:xxx`、提示词模板等)。它原本的生态里有一个叫 **pi-messenger-bridge** 的项目,可以把 pi 接入 Matrix、Telegram、WhatsApp、Slack、Discord 等即时通讯工具,让用户在聊天软件里操控 pi。

这个桥接方式看起来很美,但用户在使用中遇到了一个根本性的限制:**`/` 开头的命令在 Matrix 里发不出去**。这意味着:
- 不能 `/new` 开新会话
- 不能 `/compact` 压缩上下文
- 不能切换模型
- 不能调用技能(`/skill:xxx`)
- 提示词模板完全无法使用

用户能做的只有"发普通文本对话"这一件事。这大大削弱了远程操控 pi 的价值 —— 相当于把一台功能完整的编程助手,降级成了一个聊天机器人。

我们的任务:**搞清楚为什么,然后解决它**。

---

## 2. 调研:为什么 `/` 命令发不出去

第一阶段的调研,花了大量精力在"追根溯源"上。结论是:**这个问题不是单一原因,而是三层拦截叠加的结果**。

### 2.1 第一层:Element 客户端的命令拦截

Element(Matrix 的主流客户端,用户用的网页版)本身会把 `/` 开头的消息当作**客户端命令**处理:

- 已知命令(`/join`、`/msg`、`/me` 等)直接在客户端本地执行,根本不会发送到服务器
- 未知命令会弹出 "Unknown Command... Send as message?" 确认框,需要用户额外确认才能当作普通消息发出

这意味着用户在输入框里敲 `/new`,Element 先拦一道。这个行为是客户端层面的,任何人都无法从桥接侧绕过 —— 唯一的手段是 `//` 转义(输入 `//new` 才会发送字面文本 `/new`)。

### 2.2 第二层:bridge 自己的命令拦截

pi-messenger-bridge 的 Matrix transport(`src/transports/matrix.ts` L269)自己维护了一套管理命令(`/help`、`/enable`、`/disable`、`/channels`、`/trusted` 等),DM 里所有 `/` 开头的消息**先经过 `handleAdminCommand` 处理**。即使消息绕过了 Element 的拦截,到了 bridge 这里还会被它的命令处理器截胡。

### 2.3 第三层(根本限制):pi 的命令解析机制

这是最深层、也是最致命的一层。我们翻遍了 pi 的源码(`packages/coding-agent/src/`),找到了实锤:

**`sendUserMessage()` 显式关闭了命令处理。**

```ts
// agent-session.ts L1472 附近
// sendUserMessage 的注释原文:
// "Use prompt() with expandPromptTemplates: false to skip command handling
//  and template expansion"
```

pi 的命令解析(`/` 开头的扩展命令、技能、模板展开)只在 `prompt()` 方法里发生,而且默认开启(`expandPromptTemplates: true`)。但 bridge 用的 `sendUserMessage()` 是给**扩展注入消息**用的,刻意跳过了命令处理 —— 因为扩展注入的消息应该被当作普通内容喂给 LLM,而不是当作控制指令。

而 slash 命令的解析代码,只存在于**交互模式的 TUI 编辑器提交路径**(`interactive-mode.ts` L2715 起)。也就是说,命令解析和 TUI 编辑器是强耦合的。

再查扩展 API(`extensions/types.ts` L1193),`ExtensionAPI` 只暴露了 `registerCommand` / `sendMessage` / `sendUserMessage`,**没有任何"执行命令"的接口**。扩展可以注册新命令,但没有办法触发一个已有的内置命令。

### 2.4 调研结论

三层拦截,层层叠叠:

```
用户输入 /new
  → Element 客户端:本地命令 / 未知命令确认框(可 // 转义绕过)
    → bridge handleAdminCommand:管理命令拦截(绕不过)
      → pi sendUserMessage:expandPromptTemplates=false,命令不解析(根本限制)
```

前两层还有绕过的空间,第三层是硬限制 —— bridge 的接入方式决定了 `/` 命令永远到不了 pi 的命令解析器。

**结论:pi-messenger-bridge 的"扩展模式"架构,在命令支持上是一条死路。** 除非换一种接入方式。

---

## 3. 方案选型:扩展模式还是 RPC 模式

调研进入第二阶段:寻找替代接入方式。

### 3.1 pi 的两种外部接入方式

pi 提供了两种进程外接入途径:

1. **扩展模式(extension mode)**:把 bridge 作为 pi 的扩展加载进 pi 进程,通过 `ExtensionAPI` 交互。pi-messenger-bridge 用的就是这种方式。
2. **RPC 模式(rpc mode)**:pi 以独立进程运行(`pi --mode rpc`),通过 stdio 上的 JSONL 协议通信。pi 官方文档明确定义了这套协议。

### 3.2 RPC 协议的关键发现

我们抓取了 pi 官方的 RPC 文档(`https://pi.dev/docs/latest/rpc`),并核对了源码(`rpc-types.ts` L20-73 的命令联合类型),发现了决定性的差异:

- RPC 的 `prompt` 命令调用 `session.prompt(...)` 时,**不传** `expandPromptTemplates` → 默认 `true`
- 也就是说,**RPC 模式下 `/` 开头的消息会走完整的命令解析**:
  - 扩展命令(`/mycommand`)→ 执行
  - 技能(`/skill:xxx`)→ 展开
  - 提示词模板(`/template`)→ 展开
  - 未知命令 → 当作普通文本(不会报错)

这正是扩展模式给不了的能力。RPC 模式的 `prompt` 和 TUI 里的输入框行为一致 —— **发什么执行什么**。

### 3.3 决策:改用 RPC 模式

方案对比:

| 维度 | 扩展模式(现状) | RPC 模式(方案) |
|---|---|---|
| `/` 命令 | 不支持(硬限制) | 完整支持 |
| 进程模型 | 寄生在 pi 进程里 | 独立进程,桥与 pi 分离 |
| 崩溃隔离 | bridge 崩溃拖垮 pi | 互不影响 |
| 重启 | 随 pi 重启 | 独立重启 |
| 会话持久化 | 依赖 pi 内部 | 会话文件在磁盘,可恢复 |

结论没有悬念:**用 RPC 模式重写 bridge 的核心接入层**。这同时带来一个架构上的升级 —— bridge 从"pi 的寄生扩展"变成"pi 的伴侣进程",这也是后来独立成项目的伏笔。

---

## 4. 阶段一:RPC 可行性验证

大方向定了,先做最小验证,避免在错误的地基上盖楼。

### 4.1 环境准备

本机当时没有安装 pi。通过 nvm 激活 Node v24.18.1 后,执行:

```bash
npm install -g @earendil-works/pi-coding-agent
```

pi 0.83.0 就绪。

### 4.2 冒烟测试

写了一个最小冒烟脚本:`spawn pi --mode rpc`,然后发 `get_state` / `get_commands` 请求。结果:

- 协议握手正常,JSONL 请求响应闭环
- `get_commands` 返回了完整的命令列表 —— **包括扩展命令**

冒烟通过。RPC 模式能连、能对话、能执行命令。地基是稳的。

### 4.3 官方 RpcClient

调研中确认:pi 官方提供了现成的 `RpcClient` 类(JSONL 协议封装、事件订阅、进程管理),从 `@earendil-works/pi-coding-agent` 导出。直接用官方客户端,而不是自研协议层 —— 省掉大量协议细节的维护成本,也避免协议实现错误。

---

## 5. 阶段二:standalone 独立进程

### 5.1 代码架构

在 pi-messenger-bridge 的 fork 基础上,新增了三个核心模块:

**`src/rpc/pi-rpc.ts`**(366 行)—— PiRpc 封装
- pi CLI 探测:`PI_CLI_PATH` 环境变量 → `which pi` → 本地 node_modules,三级回退
- 冷启动握手重试:pi 进程起来需要时间,封装了就绪等待
- 发送语义恒定显式(0.1.39 起):每条 `prompt` 都携带 `streamingBehavior` —— steer = Enter 语义 / followUp = Alt+Enter 排队,空闲会话自动忽略该参数,一条消息覆盖两种状态;参数经上游私有 `send` 下发(公开 `prompt()` 不暴露它),不再依赖报错文案降级
- `get_commands` 60 秒缓存:避免频繁查询命令列表
- 监听器队列:修复了"先注册事件监听、后启动连接"会抛错的问题

**`src/rpc/command-map.ts`** —— 命令映射表(纯 pi 命令;/pmctl 家族已移入 PmctlController)
- `/new` `/clear` → `new_session`
- `/compact [说明]` → `compact`
- `/model [name]` → `set_model` / `get_available_models`
- `/models` → `get_available_models`
- `/thinking [level]` → `set_thinking_level`
- `/session` `/cost` → `get_session_stats`
- `/status` → `get_state`
- `/name <名字>` → `set_session_name`
- `/export [路径]` → `export_html`
- `/bash <命令>` → `bash`
- `/stop`(别名 `/abort`)→ `abort`
- `/queue [文本]` → 队列查看 / 排队;`/interrupt <指令>` → 打断并重发(spec #51)
- `/last` `/cyclemodel` `/cyclethinking` `/sessions`+`/switch` `/autocompact` `/autoretry` → 小命令批(spec #51)
- `/reload` → 重启 pi 进程(后加);`/reload all` → 本实例全部空闲进程(spec #51)
- `/login` `/logout` `/auth` → 无头登录,门禁在 router(spec #51)
- 其余 `/xxx` → 透传给 pi 的 `prompt`,由 pi 展开命令/技能/模板

**`src/rpc/pmctl-controller.ts`** —— /pmctl 家族(门禁 + new/list/show/rm/mv/rename;rm 60 秒确认状态为实例字段)
- 门禁顺序:单工程开关 → 管理房间校验 → Matrix 能力
- 邀请目标由 router 以 transport 原生 MXID 传入(控制器不做前缀剥离)

**`src/rpc/message-router.ts`** —— 核心接线
- 认证 → bridge 管理命令 → /pmctl 家族 → 登录管理(/login 家族)→ RPC 映射命令 → 应答捕获 → 透传 prompt(命中回复引用时摘录前缀一并下发),七级路由(spec #51 增加后两级)
- agent 事件流(`message_end` / `turn_end` / `agent_start`…)→ 回发到 Matrix;extension_ui 提问/应答、auto_retry 与错误回发、steering/followUp 队列镜像也在事件路径上(spec #51)
- 回复按 RoomBinding 路由:每个 pi 进程绑定自己的回复目标(项目房间钉住、共享默认进程随最近一次 DM 提示刷新,完整对话轮结束后释放)——不存在进程级单槽
- typing 指示:`agent_start` / `turn_start` 触发 Matrix 输入中状态

**`src/space.ts`** —— Element 空间组织视图(纯展示层)
- 启动期 ensure:懒创建私有空间 `pi-courier · <实例名>` + 空间内 bot 自建管理房间,幂等锚点为 config 的 `space.roomId` / `managementRooms[0]`
- 任何失败降级为无空间行为(警告 + 下次启动重试);空间链接(m.space.child)每次启动幂等重挂
- `inviteUserToSpaceOnce`:fire-once 邀请(space.invitedUsers 记账,拒绝者含内;失败不记账由自愈重试),router 的 spaceInvite 效应与此处自愈共用

**`src/transports/matrix.ts`** —— Matrix Transport(只做消息 I/O,spec #22 后不再内嵌其他职责)
- connect/disconnect、`sendMessage`(markdown → Matrix HTML)、typing、事件分发
- 群/DM 判定与入群 enable 提示消费 `matrix-utils.ts` 纯函数;成员计数经缓存(不逐条消息打 API)
- SDK 内部日志经 `logger.ts` 门面(初始同步期用 `suppressLogLines` 窗口滤掉两类已知良性错误)

**`src/transports/matrix-rooms.ts`** —— Matrix RoomOps 适配器(spec #22 从 matrix.ts 拆出)
- `MatrixRoomOps implements RoomOps`:createRoom/createSpace、空间挂链/摘链(m.space.child + m.room.parent)、邀请/改名/权力等级/退房、`encryptionAvailable`
- 经注入访问器(getClient/getBotUserId/onLeftRoom)触达 live client,不反向持有 transport;组合根(standalone)把 `matrix.roomOps` 交给 /pmctl 与 space ensure

**`src/transports/matrix-utils.ts`** —— Matrix 纯函数(无 SDK/网络依赖,直测)
- markdown 渲染(`formatForMatrix`)、事件过滤(`shouldSkipEvent`)、提及解析(`wasBotMentioned`/`stripBotMention`)、群/DM 判定(`isGroupChatRoom`)与入群提示谓词(`shouldPostJoinHint`)

**`src/logger.ts`** —— 分级日志门面(spec #34 后支持项目标签)
- 输出 `[ISO时间] [LEVEL] [标签] 消息`;`withLabel()` 派生视图打项目标签(视图动态读父阈值);字符串参数换行净化为 `⏎`,一次调用恒一条物理行(打标行不会被续行破坏)
- 无标签行与历史逐字节一致(单工程模式零变化)

**`src/project-labels.ts`** —— 项目标签单点解析与校验(spec #34)
- `projectLabelOf`:name ?? 工作目录 basename;`validateProjectLabel`:禁方括号/空白、≤30、大小写不敏感查重(日志格式与过滤正确性的地基)
- 消费方:/pmctl new·rename 校验、日志打标、`logs <项目>` 匹配 —— 三处共用一条规则

**`src/log-filter.ts`** —— journalctl argv 纯构造器(spec #34)
- 级别档位与项目标签编译为锚定 `--grep`(`--case=0` 大小写不敏感、正则转义、多项目 OR);未知项目报错列可用
- 背景:journald 不解析 stdout 自定义字段(实测 systemd 257),`-p` priority 在 `StandardOutput=inherit` 下恒 6(`--level warn` 因此从未生效)——改为行内锚定 grep 一并修复

**`src/quote-cache.ts`** —— 回复引用环形缓存(spec #51 票5)
- 每房间 50 条 FIFO(重见即刷新)、摘录单行 200 字上限,纯内存零 I/O
- 只记用户消息(bot 自身消息在事件过滤即被跳过),未命中静默无前缀 —— 引用是尽力而为的上下文,不是承诺

**`src/auth/headless-login.ts`** —— 无头登录(spec #51 票4)
- 上游 `AuthInteraction` → 聊天往返翻译(纯函数直测):prompt 变房间提问、notify(auth_url/device_code/progress)变展示行、「取消」= abort signal 中止(prompt reject 即上游的异常退出取消路径)
- 凭据经注入的 ModelRuntime 直写 pi 标准 auth.json(文件锁合并写),courier 不经手密钥;成功后复用 command-map 的 `restartIdleRpcs` 重启空闲进程、提示忙碌进程稍后 /reload

**`src/management-room.ts`** —— 管理房间文案单点组装(房间名 + 使用指南),DM 采纳与空间自建两条入口共用,杜绝文案漂移

**`src/standalone.ts`** —— 独立入口
- 单实例锁(lock.ts)
- 信号优雅关闭(SIGTERM/SIGINT)
- 初始化 transports → 空间 ensure(幂等/降级)→ 启动 RPC → 挂接事件

### 5.2 适配 0.83.0 的坑

开发和 pi 源码(develop 分支)对照时,发现发布版 0.83.0 与 develop 有几处差异:

- `RpcClient` 没有 `getAvailableThinkingLevels`(develop 才有)→ 改用 `getState().thinkingLevel` + 硬编码级别列表
- `CompactionResult` 只有 `summary`/`tokensBefore`,没有 `estimatedTokensAfter`
- `extension_error` 事件不在类型联合里 → 监听器做宽类型断言

这些都是"源码最新,发布版落后"的典型差异,靠实测兜底。

### 5.3 测试体系

- 单元测试:上游 129 个测试全过(迁移自 fork)
- 冒烟测试:`/tmp/test-pi-rpc.mjs` —— PiRpc + command-map 全链路
- 集成测试:`/tmp/test-router.mjs` —— mock transport + 真 RPC:
  - `/status` 回复 ✓
  - 未知命令报错 ✓
  - 普通文本进 prompt ✓
  - `turn_end` 回发 ✓
  - 工具调用轮次保留 pending、最终轮清空 ✓
  - typing 指示 ✓

---

## 6. 阶段三:Matrix 端到端打通

代码层面跑通后,进入真实环境联调。这一步暴露了大量"纸上谈兵看不到"的问题。

### 6.1 E2EE 原生库

`npm install --ignore-scripts`(为了跳过有风险的 postinstall)导致 matrix-sdk-crypto-nodejs 的原生二进制没下载。启动时报:

```
Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'
```

修复:手动执行下载脚本:

```bash
cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs
node download-lib.js
```

这个 21MB 的下载,后来在部署机上又成了大坑(见踩坑记录)。

### 6.2 第一个运行时 bug

首次启动 standalone,报错"在 `rpc.start()` 之前调用 `rpc.onEvent()`"。

原因:PiRpc 内部的事件监听器注册与连接启动顺序耦合。修复:PiRpc 内部维护监听器队列,`start()` 后自动挂载,`stop()` 时清空。

### 6.3 E2EE 设备与解密

接入的是加密房间(megolm)。启动后日志刷屏:

```
[ERROR] Decryption error ... Can't find the room key to decrypt the event
```

这是**历史消息解密失败** —— 新设备没有旧消息的密钥,正常现象,不影响新消息。

当时做了一个重要验证:**bot 新设备未经任何"设备验证",barry 发来的新消息能否解密?** 实测:**能**。加密 DM 房间中新设备无需显式验证即可收发新消息(密钥通过消息流自动共享)。

### 6.4 全链路打通

从 barry 账号发 `/status`,bot 回复:

```
⚙️ 模型: unknown / 流式中: 否
```

消息全链路打通(Matrix → bridge → pi RPC → 回复)。虽然模型还是 unknown(provider 还没配),但**核心架构验证完成**:slash 命令真的能从 Matrix 发到 pi 并执行了。最初的诉求实现了。

---

## 7. 阶段四:模型 Provider 配置

### 7.1 问题

`/status` 显示 `model: unknown` —— pi 没有任何可用的 LLM provider。用户提供了一枚 API key(openai 兼容的 zen 端点)。

### 7.2 三件套配置

pi 的模型配置分散在 `~/.pi/agent/` 下三个文件:

**`models.json`** —— 模型元数据。pi 与 models.dev 的数据合并。从 models.dev 提取:

```bash
curl -s https://models.dev/api.json -o /tmp/modelsdev.json
python3 -c "
import json, os
md = json.load(open('/tmp/modelsdev.json'))
out = {'providers': {'opencode-go': md['opencode-go']}}
json.dump(out, open(os.path.expanduser('~/.pi/agent/models.json'), 'w'), indent=2)
"
```

**`auth.json`** —— API key(权限 600):

```json
{ "opencode-go": { "type": "api_key", "key": "sk-..." } }
```

**`settings.json`** —— 默认 provider 与模型:

```json
{ "defaultProvider": "opencode-go", "defaultModel": "deepseek-v4-flash" }
```

### 7.3 字段名陷阱

配置过程中连续踩了两个字段名坑:

1. 先写了 `"model": ...` → 不生效。正确字段是 `defaultModel`。
2. 写了 `"provider"` → 不生效。正确字段是 `defaultProvider`。

这两个字段名直到查源码(`settings-manager.ts`)才确认。这是典型的"文档和实现不一致"案例 —— 只能靠源码兜底。

### 7.4 验证

用 curl 直接测 provider 端点,API key 有效(HTTP 200,deepseek-v4-flash 正常响应)。重启 bridge 后 `/status` 显示 `model: deepseek-v4-flash`。**从这一步起,bridge 具备了完整的对话能力。**

---

## 8. 阶段五:从 fork 到独立项目

### 8.1 用户的新需求

> "可以将这个做成一个全新的项目独立运行吗?当 pi coding agent 升级时我们也可以同步升级?不用改代码就可以直接使用?"

这提出了一个架构层面的问题:当时项目是 pi-messenger-bridge 的 fork,pi-coding-agent 是 peerDependency(版本跟着环境走),存在"客户端代码和子进程版本不一致"的隐患。

### 8.2 独立项目方案

新建 `~/Projects/pi-courier`:

- 只保留 standalone 需要的代码(砍掉扩展模式专属的 `src/index.ts`、`src/ui/`)
- **pi-coding-agent 从 peerDependencies 移到 dependencies**(锁 `^0.83`)
- CLI 探测改为**本地 node_modules 优先**(`import.meta.resolve` 推导 `dist/cli.js`)→ spawn 的 pi 和 RpcClient 永远是同一版本
- 升级流程 = 改依赖版本 + 重启,零代码改动

### 8.3 架构再反转:pi 独立

用户在部署测试后提出了新的架构想法:

> "我们不要将 pi 集成进去,可以独立部署,相当于一个 pi 的插件来运行,只要系统先安装了 pi,配置好 LLM 后再安装我们的项目"

这是 pi 生态的标准做法 —— bridge 作为 pi 的"伴侣程序",pi 由系统独立安装、独立升级。改动:

- `pi-coding-agent` / `pi-ai` 从 dependencies 移回 **peerDependencies**(>= 0.83)
- CLI 探测优先级反过来:**`which pi`(系统)优先** → 本地 node_modules 兜底
- pi 升级 = `npm i -g @earendil-works/pi-coding-agent@latest`,bridge 不用动

**"不要反客为主"** —— 这是用户原话:我们只是插件,pi 的更新交给 pi 自己。

### 8.4 首次运行配置向导

为了"第一次运行时配置参数",新增 `--setup` 交互式向导:

- 平台选择 → homeserver URL → token(密码登录或粘贴)→ 信任用户 → E2EE → 工作目录
- 自动验证 token(whoami)并写入 `~/.pi/msg-bridge.json`

向导的输入层踩了个大坑:`readline.question` 在管道输入模式下会丢行(监听器动态注册,预缓冲数据错过)。最终实现双模式:TTY 交互逐行 + 管道模式预读全部行。后来还发现配置完成后进程不退出(readline 持有 stdin 监听器),加了 `close()` 释放。

---

## 9. 阶段六:一键 CLI

### 9.1 用户反馈部署繁琐

> "整个流程真的非常繁琐,用户输入指令非常多,能不能一个指令就搞定"

当时部署流程:clone → npm install → build → 写三个配置文件 → 写 msg-bridge.json → 手动 systemd…… 用户希望:

```
指令+setup 配置
指令+run 运行
指令+enable 配置服务开机运行
指令+start 开始运行服务
指令+stop 停止运行
```

### 9.2 命令设计

实现了一个统一的 CLI(`src/cli.ts`,bin 名 `pi-courier`):

```
pi-courier setup      首次运行配置向导
pi-courier run        前台运行(--workdir 可覆盖)
pi-courier enable     安装用户级 systemd 服务 + 开机自启 + 启动
pi-courier start      启动服务
pi-courier stop       停止服务
pi-courier restart    重启服务
pi-courier status     服务状态 + 最近日志(可加项目名过滤)
pi-courier logs       跟踪日志(可加项目名过滤:logs <项目...> [--level <lvl>])
pi-courier disable    卸载服务(停止 + 取消自启 + 删 unit)
pi-courier update     更新本项目(自动走 npm)
```

关键设计:
- **workdir 持久化**:setup 时把工作目录写进配置,`run`/`enable` 都不用再传参
- **`enable` 自动生成 systemd unit**:用绝对 node 路径 + 配置的 workdir,不用手动写
- **废弃旧参数**:除 `--workdir` 外全废弃(旧参数给出引导提示)
- **过滤 DeprecationWarning**:传输层依赖的 `util._extend` 警告混入向导输出,入口处过滤

### 9.3 部署流程的简化

从最初的 8+ 步,简化为:

```
npm install -g pi-courier
→ pi-courier setup
→ pi-courier enable
→ 完成
```

日常维护全部一条命令:`start` / `stop` / `restart` / `status` / `logs` / `update`。

---

## 10. 阶段七:发布到 npm

### 10.1 包名争夺战

用户希望 `npm install -g` 一键安装。检查发现:

- `pi-courier`:**已被占用**(且是个废弃包,description 写着 "Deprecated - Please use @wherever-dev/pi instead",没有 bin)
- `pi-bridge`:被占用
- `pi-msg-bridge`:可用

方案:scoped 包 **`pi-courier`**(账号名 scope,免费,命令名 `pi-courier` 不受影响)。

### 10.2 两个发布坑

**坑 1:scope 不存在。** 最初定的 `@hi-barry/pi-courier`(GitHub 登录名),发布报:

```
404 Scope not found
```

因为 npm 账号是 `barryfan2045`,scope 必须与账号名一致(或自己注册的组织)。改名 `pi-courier` 后成功。

**坑 2:2FA。** 用户账号开了两步验证,普通 token 发布被拒:

```
403 Two-factor authentication or granular access token with bypass 2fa enabled is required
```

需要生成 **Granular Access Token 并勾选 "Bypass 2FA for publishing"**。

**坑 3:发布后读取延迟。** PUT 200 发布成功,但 `npm view` 404 —— 新 scope 首次发布,读取端点传播延迟(搜索索引先可见)。等待后恢复。

### 10.3 发布配置

- `files`: 只发 `dist/`、`deploy/`、两个 README(不泄漏源码)
- `prepare: npm run build`:发布前自动构建
- `publishConfig.access: public`
- `update` 命令自动检测安装来源:npm 装的就 `npm i -g pi-courier@latest`,git clone 的就 pull+build

### 10.4 发布后的问题

**EEXIST**:用户机器上之前 `npm link` 过,全局 bin 已有 `pi-courier` 链接,`npm install -g` 冲突。解决:先 `npm unlink -g pi-courier` + 删 bin 文件再装。

---

## 11. 阶段八:从单工程到多工程、再到空间组织(0.1.17–0.1.37)

0.1.16 之后,项目进入**功能迭代与架构收敛**阶段。这一阶段从"补体验细节"开始,逐步长出多工程模式、统一工程管理(`/pmctl`)和 Element 空间组织三大能力,最后以一次大规模架构重构(spec #11)收官。

### 11.1 体验细节打磨(0.1.17–0.1.21)

发布后陆续收到真实的体验问题,逐一修补:

**0.1.17 静默密码与 E2EE 报错提示** —— setup 里密码输入 `readline` 静默(回显与事件丢失),且 Matrix E2EE 相关报错全是英文裸错。加上星号回显提示与友好的 E2EE 错误提示文案。

**0.1.18 E2EE 二进制重复下载** —— 每次 `npm update` / 重装都重新下载 21MB 的原生库。改为:二进制已存在则跳过下载(检测到目标文件存在直接复用)。这是"升级代价"里最实际的痛点之一。

**0.1.19 密码星号回显** —— 修复密码输入时无任何反馈的问题,每个字符以 `*` 回显。

**0.1.20 固定设备 ID** —— 这是 E2EE 坑的一个根治。此前每次重跑 setup 都会生成新的 device_id,导致上一节 §12.3 的 `M_BAD_JSON device_keys 不匹配` 问题反复发作。改为 **password 登录使用固定 device ID**(形如 `PICOURIERXXXXXXXX`),重跑 setup 复用同一设备 → 不再触发该坑。README FAQ 里"重跑 setup 要删 crypto store"的提醒也随之弱化。

**0.1.21 `/abort` 改名 `/stop`** —— 语义更清晰(对应 TUI 的 Esc),保留 `/abort` 作为别名。

### 11.2 `/reload` 与信任房间(0.1.22–0.1.23)

**0.1.22 修复 `/reload` 静默失败** —— `/reload`(重启 pi 进程)此前失败时没有反馈,用户以为成功其实没重载。补上成功/失败反馈与生命周期错误处理。

**0.1.23 setup 增加信任房间步骤** —— 此前只能在配置文件里手写群聊房间 ID。故在向导里新增"信任房间 ID"一步(可选,逗号分隔多个),配合 `trusted-only` 默认策略,群聊接入不再需要手动改配置。

### 11.3 多工程模式(0.1.24–0.1.26)

这是从"一个 bot 对一个 pi"到"一个 bot 管多个项目"的能力跃迁。

**0.1.24 多工程房间 + `/pmctl`** —— 核心铺垫:
- 引入**工程房间**(project room):每个 `/pmctl new` 出来的工程对应一个独立房间 + 独立 pi 子进程(懒启动,不常驻)
- **`/pmctl` 统一工程管理命令**(仅管理房间可用):`new` / `list` / `show` / `rm` / `mv` / `rename`
- `new` 路径可选,默认 `<工程根>/<name>`;`new/mv` 接受相对工程根的路径
- `/enable` 支持在群聊内部直接启用(无需房间 ID),未启用多人群聊一次性入群提示
- 修复:工程房间不 branding、project rpc 懒启动、`/pmctl` 在首条 DM 也能用(管理房间判定改为 room-ID 驱动,而非成员关系推导)

**0.1.25 管理房间收敛** —— 管理房间从"admin 的 DM"改为"**bot 成功授权消息的第一个房间**(非工程、≤2 人)",重命名为 `项目管理(<实例名>)`、发送使用指南、room ID 持久化到 `config.managementRooms`。增加实例名(机器名)以区分多机部署。

**0.1.26 单/多工程开关** —— 新增 `/multiproject on|off`(trusted 用户,重启生效)。**默认单工程模式**(一个 bot ↔ 一个 pi,无管理/工程房间,`/pmctl` 不可用),保持简单;需要时再开多工程。setup 里也加了"启用多工程模式?"一步。

### 11.4 markdown 渲染与杂项(0.1.27–0.1.32)

**0.1.27 提升 readline 监听器上限** —— setup 里动态注册多条监听器触发 `MaxListenersExceededWarning`,提升上限消除告警。

**0.1.28 markdown-it 渲染回复** —— pi 回复里的 markdown 用 markdown-it 渲染,聊天里代码块、加粗等正常展示(此前是纯文本)。

**0.1.29 工程房间命名** —— 名称带实例名:`<工程>(<实例>)`,多机部署下同工程名不混淆。

**0.1.30 `/pmctl new` 提升创建者为管理员** —— 建工程时把发起人设为该工程房间的 admin,方便其直接管理。

**0.1.31–0.1.32 CLI `-v/--version`** —— 显示安装版本,并在 usage / README / 头注释里统一呈现(31 实现,32 补齐文档)。

### 11.5 架构重构:spec #11(0.1.33)

一次大规模 prefactor(由 spec #11 的 #4–#15 多张票驱动),目标是把"能跑"变成"能长住":

| 票 | 内容 |
|---|---|
| #4 | 入口与依赖减负:砍掉多余的抽象层与入口 |
| #5 | 授权策略收敛进 router:群聊 `/enable` 复活、DM `/help` 归一(单一 `handleIncoming` 管道) |
| #6 | Transport / RoomOps 接口拆分:删 TransportManager、统一"不可用"语义 |
| #7 | ConfigStore 单一写者:热路径零读盘、测试去真实目录化 |
| #8 | RoomBinding 回复路由:按进程绑定回信目标,删除进程级单槽 |
| #9 | `/pmctl` 升格 PmctlController:依赖注入,命令映射退回"纯 pi 命令" |
| #10 | 认证拆分:纯策略引擎 + effect 返回式 admin 处理(依赖通过注入) |
| #12 | tests 纳入 typecheck 门禁 |
| #13 | workdir 首启决策抽模块,走 ConfigStore 单一写路径 |
| #14 | namespacedId 收敛 + `node:` 导入前缀 |
| #15 | 文档同步 |

### 11.6 空间组织:spec #16(0.1.33)

Element 空间的纯组织视图,五张票收官:

| 票 | 内容 |
|---|---|
| #1 | 空间懒创建 + bot 自建管理房间:启动期 ensure 私有空间 `pi-courier · <实例名>`,幂等锚点为 `config.space.roomId` / `managementRooms[0]`;失败降级无空间行为 |
| #2 | setup 空间启用提示:新配置默认开,已有配置保持现状 |
| #3 | 工程房间挂入空间 + `/pmctl rm` 先摘链再退房 |
| #4 | challenge 通过自动邀请进空间:fire-once + 自愈 |
| #5 | 文档同步(中英 README + DEVELOPMENT.md) |

空间特性与 §14 的"空间=纯组织视图"设计决策一致:只做展示层收纳,不承载任何授权判定。

### 11.7 Matrix 深化:spec #22(0.1.33 后,未发版)

matrix.ts 三职责拆分的收官票系,接口与消费路径零改动:

| 票 | 内容 |
|---|---|
| #23 | 消息过滤策略纯化:群/DM 判定(`isGroupChatRoom`)与入群 enable 提示谓词(`shouldPostJoinHint`)抽进 matrix-utils 纯函数,`> 2` 阈值收敛为单一实现 |
| #24 | RoomOps 适配器独立:房间能力 11 个方法迁入 `matrix-rooms.ts`(`MatrixRoomOps`),MatrixProvider 组合之,只剩消息 I/O(405 行 → 三票合计约 320 行) |
| #25 | 日志统一走 `logger.ts` 门面:删 `console.*` 与 SDK `RichConsoleLogger` 直用;同步期两类良性错误(Decryption error / M_NOT_FOUND)改为门面内的 `suppressLogLines` 过滤窗口 |
| #30 | 文档同步(本节 + §5.1 模块清单)+ 全量门禁收官 |

### 11.8 spec #22 的日志行为差异说明

票 #25 有两处有意可见性变化(其余为语义等价迁移):SDK trace/debug 在默认 info 阈值下静默(原 RichConsoleLogger 全打,`--level debug` 仍可见);同步噪音过滤从"仅 error 级 + 两个 SDK 模块门控"放宽为"窗口期内任意模块/级别的子串匹配"——门面不认识 SDK 模块名,窗口受 `client.start()` 作用域约束、finally 保证关闭(旧实现在 start() 失败后会永久遗留过滤 logger)。

### 11.9 日志按项目区分:spec #34(0.1.36)

多工程模式所有日志曾混在一条 journald 流里无法区分归属。方案实测后定为**行内标签 + 锚定 grep**:每条项目相关日志渲染 `[时间] [LEVEL] [项目] 消息`(📥 收信、📤 回信、全部 [agent] 事件、项目进程生命周期),`pi-courier logs <项目...>` 编译为 `journalctl --grep '\[(档位)\] \[(转义标签…)\]' --case=0`。未走结构化字段路线的原因见 §5.1 log-filter 条目(实测:journald 不解析 stdout 自定义字段;native socket 收益不抵成本)。

行为说明(有意变化):① `--level warn/error` 过去因 `-p` 失效恒返回空,现在真正过滤(行内档位锚定);② `logs --level debug` 过去同样恒空,现在显示全部(不传 grep);③ 单工程模式逐字节不变;④ `/pmctl list/show` 对未命名项目显示工作目录名(原先显示 roomId);⑤ 项目名新增格式约束(禁 `[]`/空白/超长/大小写撞名);⑥ 含换行的消息日志改为单行渲染(`⏎` 连接)。过滤依赖 journald PCRE2(Debian/Ubuntu 标准支持),缺失时 `logs`/`status` 会报错而非静默放宽。

### 11.10 权限模型:信任即管理员:spec #41(0.1.37)

setup 把信任用户拉进空间和管理房间后,他们在 Matrix 客户端里其实是 PL 0 的平民——改房间名/话题、邀请人全部灰着;而挑战码用户只被邀进空间,进不了 invite 制的管理房间,`/pmctl` 对他们等于不存在。spec #41 用一句话规则统一两条权限轴:**托管房间内,信任用户 = 管理员(PL 100)**——与信任来源(setup/验证码)、加入途径、当前成员资格无关(非成员照写,后加入者进房时权限已就位)。

实现收敛为一条幂等路径:每房间读一次 `m.room.power_levels`,仅对低于目标的信任用户写 100;新建房间后立即执行;启动时对全部托管房间(空间 + 管理房间 + 项目房间,由现有配置推导,零新增配置)自愈补存量,空间模式与降级模式一视同仁。`/pmctl new` 旧的"发起人设 100"特例删除,统一走该路径。RoomOps 适配器新增读权方法,SDK 触达不出适配器(spec #22 架构约束延续)。

对称闭环:**撤销信任时同步降权**。提权名单持久化在 `powerElevatedUsers`——仅记录实际从低提到 100 的用户,旧特例时代的管理员故意不入簿记(这构成文档里的存量包袱)。`/revoke` 即时对被撤用户全房间降回 0(含 legacy 用户,无论是否在簿记);启动自愈对名单中已不受信者兜底降权,全部成功才移出名单。铁律:自愈只以名单为降权依据,名单之外的高权用户(外部房间既有管理员、bot 自身)永不被降。

| 票 | 内容 |
|---|---|
| #42 | 统一补权 + 启动自愈:RoomOps 读权方法、`elevateTrustedUsersInRoom`/`healTrustedPowerLevels`、删 `/pmctl new` 特例、提权簿记 |
| #43 | 管理房间可达性:邀请扩为空间+管理房间(仅空间模式,降级认养 DM 不拉人),挑战效果链 + 启动自愈补邀 |
| #44 | 撤销降权闭环:`powerDemote` 效果、全房间降 0、自愈兜底、名单铁律 |
| #45 | 文档同步 + 全量门禁 + 发版 0.1.37(本节) |

与 §14 决策 9 的关系:空间本身仍是组织视图,但"信任模型与房间权限零改动"的表述自 0.1.37 起作废——信任即管理员成为正式权限模型(决策 13)。

### 11.11 远程会话控制:spec #51(0.1.39 起)

此前 RPC 层的"发消息"只有一种形态:流式中发消息自动降级是实现细节,用户表达不了"排队"与"打断"的意图;模型调用失败在房间里静默;extension_ui 的确认框/选择/输入在 RPC 模式下直接丢失;provider 登录必须开终端。spec #51 用五张票把这批远程会话控制一次补齐:

| 票 | 内容 |
|---|---|
| #52 | 错误可见性:turn 以 stopReason "error" 结束必回 `❌ 本轮失败: <原因>`(此前 text=null 路径会静默吞掉失败轮并永久占住未钉绑定);auto_retry_start/end 回发 `⚠️ 调用失败,正在重试 n/N` 与耗尽终错,成功重试不打扰;主动 /stop 中止不误报 |
| #53 | 发送语义对齐 pi TUI:prompt 恒带 streamingBehavior(steer = Enter:空闲即执行、运行中注入当前运行;/queue = followUp:排队不打断,空闲退化直发);`/queue` 无参查看队列(条数+内容,与上游 pendingMessageCount 交叉核对);`/interrupt` 一条消息完成打断+重发(空闲直接执行);RPC 无 clear_queue、abort 不清队列 —— /stop 与 /interrupt 回复显式回显"⚠️ 队列中仍有 N 条消息将在下一轮生效" |
| #54 | extension_ui 交互:confirm/select/input/editor 提问发进绑定房间、下一条普通消息即答案(confirm→y/n、select→序号、input/editor→直接打字;「取消」精确匹配放弃);FIFO 最老优先、"/"开头仍走命令通道;notify 分档(warning/error 进房间,info 留日志,TUI 专属展示方法忽略);`extensionUiTimeoutMinutes`(默认 10 分钟,不进向导)兜底超时代答取消 |
| #55 | 无头登录:`/login` 列可登录 provider(oauth/api_key 能力+已认证标记)、`/login <provider> [oauth|api_key]` 交互式登录(OAuth 开链接任意浏览器授权后把重定向 URL 粘回房间;API key 聊天直贴,提示会留房间历史)、`/logout`、`/auth`;门禁仅管理员+管理房间(单工程 = DM);凭据经独立 ModelRuntime 直写 pi 标准 auth.json,成功后空闲进程自动重启、忙碌提示稍后 /reload |
| #56 | 小命令批 + 回复引用:`/last`(复述最近回复)、`/cyclemodel`、`/cyclethinking`、`/sessions`+`/switch <序号>`(流式中拒绝)、`/autocompact on|off`、`/autoretry on|off`(后两者写 pi 全局设置并持久化:本机全部 pi 进程生效、重启仍有效);Matrix reply 引用命中时摘录前缀(≈200 字)拼进 prompt,未命中静默忽略 |
| #57 | 文档同步(本节 + 双语 README) |

局限如实写进文档(双语 README 的"pi 运行中:steer / 排队 / 打断"节):**队列不清空** —— abort 后 steering/followUp 队列原样保留,打断前已排队的消息在下一轮生效,靠回复中的显式警示兜底而非假装没发生;**密钥留房间历史** —— API key 登录直贴聊天,提示用后删消息;**autocompact/autoretry 全局生效** —— 写 pi 全局设置,一个项目房间切换影响本机全部项目。

两个实现坑值得记(细节在代码注释):上游 `RpcClient.prompt()` 不暴露 streamingBehavior,经私有 `send` 直发;`extension_ui_response` 若走通用 `send()` 会被改写成 `req_N` 的请求 id,pi 按收不到的 id 丢弃应答、对话框永久悬挂 —— 应答改为直写子进程 stdin 的严格 JSONL 行。房间应答捕获的优先级是登录流程 > extension_ui 悬置提问(票面要求);登录流程任意时刻「取消」可中止,两次提示之间的消息(如 OAuth 轮询期的闲聊)不会被吞,房间保持可用。

---

## 12. 踩坑全记录

这一章把开发过程中遇到的所有坑按主题归档。**每一个坑都是真实遇到、真实解决的**,README 的 FAQ 就是从这里提炼的。

### 12.1 网络与代理(坑最多的一类)

这台部署机的网络环境特殊:外网必须走代理。

| 坑 | 现象 | 解决 |
|---|---|---|
| npm registry 直连超时 | `npm install` 无限转圈 | `npm config set proxy/http-proxy` |
| **GitHub Releases 下载不走 npm 代理** | matrix-sdk-crypto-nodejs 21MB 二进制只有 16-64 kB/s | `export https_proxy` 环境变量(npm 子进程继承) |
| npm 支持 socks5 | 用户问能否用 socks | 实测支持,`npm config set proxy socks5://...` 或 `socks5h://` |
| 代理配置两套体系 | npm 的 proxy 配置 vs 环境变量 | registry 走 npm 配置,GitHub 下载走环境变量,两个都要配 |

**核心教训:一套代理配置覆盖不了所有流量。** npm 的 `proxy` 配置只作用于 npm 自身的 HTTP 客户端;postinstall 脚本里的 node fetch 走的是环境变量。两套必须分别配。

### 12.2 Node 版本混用(最隐蔽的坑)

systemd 服务反复重启,日志显示:

```
TypeError: webidl.util.markAsUncloneable is not a function
```

排查链条:
1. 第一次:unit 的 `ExecStart` 写死了**系统 node v20**(enable 时终端没加载 nvm,`process.execPath` 解析到 `/usr/bin/node`)
2. 修复后 unit 用 v24 跑 bridge,但 **pi 子进程还是 v20** —— bridge 内部 `spawn("node")` 走 PATH,systemd 默认 PATH 里第一个 node 是系统的 v20
3. 最终修复:unit 加 `Environment=PATH=<nvm bin 优先>`,pi 子进程才能找到 v24

**教训**:Node 版本混用(nvm v24 + 系统 v20)会造成跨进程的诡异问题。解决之道不是修一处,而是**全机统一版本**。

### 12.3 E2EE 相关

| 坑 | 现象 | 解决 |
|---|---|---|
| 原生库缺失 | `Cannot find module @matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu` | 手动跑 `download-lib.js` |
| 历史消息解密失败 | 日志刷 `Decryption error` | 正常现象,新设备无旧密钥 |
| **加密房间新消息也解不开** | barry 发消息 bot 无响应 | bot 无交叉签名,用户验证不可用;最终方案:用非加密房间 |
| **device_id 不匹配** | `M_BAD_JSON: Provided device_id in device_keys does not match` | 重登录后删 `~/.pi/msg-bridge-matrix-crypto` |

**device_id 坑的机理**:重新登录会获得新的设备身份,但 crypto store(SQLite)里还存着旧设备的 device_id。上传 device_keys 时身份对不上 → 连接失败。**每次重跑 setup / 换 token 都要删一次 crypto store。**

**加密房间的结论**:bot 账号没有交叉签名,Element 里"用户验证不可用";实测即使取消"仅向已验证设备共享密钥"也拿不到密钥。**最可靠的方案就是非加密房间** —— 配置 `encryption: true` 不影响普通房间。

**crypto 原生库缓存与校验(0.1.38 起)**:postinstall 自检把下载成功的 `.node` 副本缓存到 `~/.cache/pi-courier/native-crypto/<crypto 包版本>/`(目录 0700/文件 0600,临时文件+原子重命名),更新重装后 node_modules 缺失时优先从缓存恢复,不再重复 21MB 下载;下载与恢复均对 `scripts/crypto-native-hashes.json` 清单做 sha256 校验——清单命中不符即删除产物拒绝加载(E2EE 降级),未录入版本走 TOFU 并告警提醒补录。**维护仪式:上游 `@matrix-org/matrix-sdk-crypto-nodejs` 升版时,从其官方 release 下载各平台库、`sha256sum` 录入清单并走 PR 评审。**

### 12.4 npm link / 安装

| 坑 | 现象 | 解决 |
|---|---|---|
| link 在 build 前 | `pi-courier` 命令找不到 | build 后重新 link |
| EEXIST | `npm install -g` 报文件已存在 | `npm unlink -g` + 删 bin |
| allow-scripts 拦截 | 原生库 postinstall 被跳 | 手动下载或 approve |

### 12.5 pi 会话相关

| 坑 | 现象 | 解决 |
|---|---|---|
| 重启丢会话 | 每次启动都是新 session id | 给 pi 传 `--continue`(0.1.1) |
| 空会话不落盘 | 无消息的会话文件不写盘 | 正常行为,真实使用不受影响 |

**`--continue` 的验证过程值得一提**:第一次测试失败(两次启动 session id 不同),排查后发现是**测试脚本没发消息**,空会话根本不落盘。补上一条真实 prompt 后,重启验证通过 —— session id 完全一致。测试要模拟真实使用,这个教训很典型。

### 12.6 其他

| 坑 | 现象 | 解决 |
|---|---|---|
| readline 管道丢行 | 向导管道输入时第二个问题后挂起 | 双模式输入:TTY 逐行 + 管道预读 |
| 向导不退出 | 配置写完光标闪烁 | 释放 stdin 监听器 |
| workdir 不存在 | spawn ENOENT | `mkdir -p` 自动创建 |
| DeprecationWarning 混入 | 向导输出被警告打断 | 入口过滤 `util._extend` |
| 空目录 spawn | `--workdir` 不存在时 spawn 报 ENOENT | PiRpc.start() 自动 mkdir |

---

## 13. 技术架构

### 13.1 运行时架构

```
┌──────────────┐    Matrix
│  你的客户端   │◄───────────────────────────────────────┐
└──────┬───────┘                                        │
       │ 消息                                            │ 回复
       ▼                                                │
┌──────────────────┐    RPC 协议(stdio JSONL)    ┌──────┴───────┐
│  pi-courier       │ ──────────────────────────► │ pi --mode rpc│
│  (bridge 进程)   │ ◄────────────────────────── │ (系统安装)    │
└──────────────────┘     事件流(agent 事件)      └──────────────┘
```

- pi-courier 负责:messenger 接入、认证、命令映射、事件回发、进程管理
- pi 负责:LLM 对话、工具调用、会话管理、技能/模板展开
- 两者通过 stdio 上的 JSONL(RPC 协议)通信

### 13.2 消息路由

```
Matrix 消息(transport 只做纯 I/O,不做授权判定)
  → 群聊 /enable(授权计算先行、授权生效在后 —— 未启用房间的消息正是靠本步骤在生效前启用房间;all 仅管理员)
    → 认证检查(trusted / challenge)
      → bridge 管理命令(/trusted /revoke /channels /enable <chatId> /disable /toggletools)
        → /pmctl 家族(PmctlController:门禁 + new/list/show/rm/mv/rename;空间启用时 new 挂链、rm 先摘链再退房)
          → 登录管理(/login /logout /auth —— 仅管理员 + 管理房间,单工程模式 DM 即管理房间)
            → RPC 映射命令(/new /compact /model /queue /interrupt ...;DM /help 也在这里,统一输出 pi 命令 + bridge 命令)
              → 应答捕获(非 / 消息:登录流程优先于 extension_ui 悬置提问;「取消」一律中止)
                → 透传 prompt(命中回复引用时摘录前缀一并下发;/skill:xxx /template 普通文本)
```

策略(认证、挑战码、群 /enable)只存在于 router 的 `handleIncoming` 管道一份,管理命令判定在 `src/auth/admin-commands.ts`(纯输入输出,effects 由 router 落盘——`persistAuth` 写 auth 快照、`hideToolCalls` 写开关、`spaceInvite` 触发空间 fire-once 邀请);transport 侧不做任何授权判定(否则未启用房间的消息到不了 `/enable`,该功能在真实链路上不可达)。注意:/enable 步骤在「授权生效」之前执行,但位于「授权计算」之后——两者缺一不可。/pmctl 的门禁与动作集中在 PmctlController,邀请目标由 router 以 transport 原生 MXID 传入。

### 13.3 回复机制

- 对话类回复:监听 agent 事件流的 `turn_end`,按来源进程的 RoomBinding 回信(`message_end` 仅记录日志)
- 同一默认进程内跨 DM 的对话归属是协议限制(pi 的 RPC 无 chat 概念):绑定跟随最近一次提示;项目房间进程独占、天然钉住
- 命令类回复(统计/模型列表):直接等 RPC 响应
- 发送语义(0.1.39 起):prompt 恒带 `streamingBehavior` —— 普通文本 = steer(空闲即执行、运行中注入当前运行),`/queue` = followUp(排队不打断);`/interrupt` = abort → waitForIdle → prompt
- 错误可见性(#52):turn 以 stopReason "error" 结束必回失败行(哪怕模型无正文);auto_retry_start 与失败收场的 auto_retry_end 回发房间,成功重试不打扰
- extension_ui(#54):提问进绑定房间 FIFO 排队,下一条普通消息即答案;notify 仅 warning/error 进房间
- 回复引用(#56):Matrix reply 命中环形缓存时,摘录前缀拼进 prompt 前缀,帮助 agent 理解指代

### 13.4 会话模型

- pi 会话按 workdir 分目录存储在 `~/.pi/agent/sessions/`
- bridge 启动时传 `--continue`,恢复该 workdir 下最近会话
- `/new` 开新会话,下次重启恢复新会话
- `/reload` 重启 pi 进程,会话无损(文件在磁盘)
- 多工程模式下,每个工程房间绑定一个独立 pi 进程(懒启动),会话按各工程 workdir 隔离,互不影响

---

## 14. 关键设计决策

1. **RPC 模式而非扩展模式**:命令能力是硬需求,扩展模式在架构上无法满足。
2. **用官方 RpcClient**:不重复造轮子,协议细节交给官方维护。
3. **独立项目**:脱离 fork 的束缚,自有版本节奏。
4. **pi 独立安装(peerDependencies)**:bridge 是伴侣程序,不捆绑 pi。"不要反客为主"。
5. **`--continue` 恢复会话**:重启不等于失忆,上下文在磁盘。
6. **一键 CLI + 配置持久化**:部署复杂度收敛到 setup/enable 两条命令。
7. **systemd 用户级服务**:无需 sudo,绝对路径 + PATH 显式控制,避免环境漂移。
8. **scoped npm 包**:包名冲突用账号 scope 解决,命令名不受影响。
9. **空间 = 纯组织视图**:Element 空间只做展示层收纳,不承载任何授权判定(不加 restricted room);任何失败降级为无空间行为。(0.1.37 修订:房间权限本身不再"零改动",见决策 13;空间本身仍不参与授权判定。)
10. **单工程默认、多工程可选**:保持"一个 bot 对一个 pi"的默认简单模型,复杂多工程能力按需开启(`/multiproject`),不把复杂度强加给普通用户。
11. **每个工程一个独立 pi 进程**:工程间进程隔离、会话独立、互不干扰;懒启动按需拉起,避免多工程常驻资源浪费。
12. **固定设备 ID**:password 登录用稳定 device_id,把"重跑 setup 就触发 E2EE 设备坑"这类可预见问题从根上消除,而不是靠 FAQ 让用户手动删 crypto store。
13. **信任即管理员(0.1.37)**:托管房间内信任用户 = 管理员(PL 100),Matrix 权限轴与命令信任轴合一条规则——不引入第三种档位、不加配置项;撤销信任对称降权,以提权名单簿记为降权依据,名单之外的高权用户永不动。
14. **发送语义镜像 TUI(0.1.39)**:聊天里 Enter / Alt+Enter / Esc 都有对应物 —— 普通文本 = steer、`/queue` = followUp、`/stop`·`/interrupt` = abort;协议没给的能力(clear_queue)不假装给了,队列局限随命令回复显式告知。
15. **凭据不过手(0.1.39)**:无头登录的凭据经独立 ModelRuntime 直写 pi 标准 auth.json,courier 不保存、不回显密钥;房间只是录入通道,密钥留房间历史的风险如实提示。

---

## 15. 版本演进

| 版本 | 内容 |
|---|---|
| 0.1.0 | 首个 npm 发布;独立项目、setup 向导、CLI 雏形 |
| 0.1.1 | `--continue` 会话恢复;workdir 自动创建 |
| 0.1.2 | systemd unit 带 PATH(修复 pi 子进程 node 版本不匹配) |
| 0.1.3 | `pi-courier restart` 命令 |
| 0.1.4 | `pi-courier disable` 命令(完全卸载) |
| 0.1.5 | README 全面 FAQ 化 |
| 0.1.6 | 注册为 pi 包(pi.dev/packages 目录,`pi install` 可装) |
| 0.2.0 | **改名 pi-courier + 专精 Matrix**:移除 Telegram/WhatsApp/Slack/Discord 四个 transport,依赖从 596MB 降至仅 matrix-bot-sdk;npm 包名改为 unscoped `pi-courier`,命令名 `pi-courier`;旧包 `@barryfan2045/pi-remote` 标记 deprecated |
| 0.1.13 | 无配置时等待而非退出(systemd/docker 不再 crash 循环) |
| 0.1.14 | 容器 PID 复用锁接管;Docker 多阶段构建瘦身 + bin 符号链接重建 |
| 0.1.15 | 加密存储目录改名 pi-courier-matrix-crypto;Docker 版本号进 Dockerfile |
| 0.1.16 | **环境变量一键部署**:Matrix 配置全 env 化(PI_MATRIX_TRUSTED_USERS/ENCRYPTION/WORKDIR/LOG_LEVEL);LLM key 走 pi 原生 `${ENV}` 模板(PI_LLM_API_KEY);settings env 由 entrypoint 渲染;compose + .env.example |
| 0.1.17 | setup 静默密码 + 友好 E2EE 错误提示 |
| 0.1.18 | E2EE 21MB 二进制已存在则跳过重复下载(升级提速) |
| 0.1.19 | 密码输入星号回显 |
| 0.1.20 | **固定设备 ID**:password 登录稳定 device_id,根治重跑 setup 触发 E2EE 坑 |
| 0.1.21 | `/abort` 改名 `/stop`(语义更清晰,保留别名) |
| 0.1.22 | 修复 `/reload` 静默失败,补成功/失败反馈 |
| 0.1.23 | setup 增加信任房间步骤;群聊接入不再依赖手改配置 |
| 0.1.24 | **多工程房间 + `/pmctl`**:独立工程房间/独立 pi 进程;统一工程管理命令 new/list/show/rm/mv/rename;`/enable` 群内直启 |
| 0.1.25 | 管理房间收敛:bot 成功授权消息的首个房间 + 实例名;room ID 持久化 |
| 0.1.26 | **单/多工程开关** `/multiproject`;默认单工程,setup 可选多工程 |
| 0.1.27 | setup 提升 readline 监听器上限(消除 MaxListenersExceededWarning) |
| 0.1.28 | markdown-it 渲染回复(代码块/加粗正常展示) |
| 0.1.29 | 工程房间命名带实例名 `<工程>(<实例>)` |
| 0.1.30 | `/pmctl new` 将发起人设为该工程房间 admin |
| 0.1.31 | CLI `-v/--version` 显示安装版本 |
| 0.1.32 | README/usage/头注释统一呈现 `-v/--version` |
| 0.1.33 | **架构重构(spec #11)+ 空间组织(spec #16)**:授权单管道、Transport/RoomOps 拆分、ConfigStore 单写者、RoomBinding 回复路由、PmctlController、纯策略认证;Element 空间懒创建 + bot 自建管理房间、工程房间挂空间、challenge 自动邀请进空间,失败降级无空间行为 |
| 0.1.34 | **spec #22 Matrix 深化**(见 11.7–11.8):matrix.ts 三职责拆分——RoomOps 适配器独立、消息过滤纯化、SDK 日志统一走 logger 门面 |
| 0.1.35 | hotfix:postinstall 自检补下 crypto 原生库(npm 11 allow-scripts 兼容) |
| 0.1.36 | **日志按项目区分(spec #34)**:多工程日志行带 `[项目]` 标签,`logs <项目...> [--level]`/`status [项目]` 经锚定 grep 过滤;`--level` 修复(journalctl -p 在 inherit 管道下从未生效,改为行内档位过滤);含方括号/空白/超长/撞名的项目名被 /pmctl 拒绝 |
| 0.1.37 | **信任即管理员(spec #41)**:信任用户在全部托管房间自动 PL 100(幂等补权+启动自愈,零新增配置),邀请扩为空间+管理房间(修挑战码用户进不了管理房间的缺口),/revoke 同步全房间降权(名单簿记兜底,名单外高权用户永不动) |
| 0.1.38 | **crypto 原生库缓存 + sha256 校验(spec #47)**:更新免重下(缓存 `~/.cache/pi-courier/native-crypto/`),下载与恢复验哈希,防代理侧篡改与 release 替换 |

GitHub 仓库:[github.com/Hi-Barry/pi-courier](https://github.com/Hi-Barry/pi-courier)(公开)
npm 包:[pi-courier](https://www.npmjs.com/package/pi-courier)
---

## 16. 经验与反思

### 16.1 技术层面

1. **源码是最后的真相**:pi 的 `sendUserMessage` 限制、`defaultProvider` 字段名、`--continue` 参数,都是靠读源码确认的。文档会过时,源码不会。
2. **代理是双轨的**:npm 的 proxy 配置和环境变量是两个世界。遇到下载慢,先分清走的是哪条路。
3. **Node 版本统一是底线**:nvm 和系统 node 混用,会在最隐蔽的地方出最诡异的问题。
4. **测试要模拟真实使用**:空会话不落盘导致 --continue 测试假失败,补上真实消息才暴露真相。
5. **发布流程要演练**:scope 存在性、2FA、同步延迟,这些"发布手册"里的小字,全是实际拦路的坑。
6. **治本优于给 FAQ 打补丁**:E2EE 设备坑最初靠"重跑 setup 就删一次 crypto store"的 FAQ 缓解;固定设备 ID 一出,这个坑从根上消失。能消除诱因时,别只教用户绕路。
7. **默认简单、按需复杂**:单工程默认、多工程可选、空间纯展示,都是同一个原则 —— 把复杂度藏到开关后面,让绝大多数用户走最省心的路径。

### 16.2 流程层面

1. **小步走,每步验证**:整个项目按"调研 → 冒烟 → 骨架 → 联调 → 独立 → 简化 → 发布"推进,每阶段都有可验证的产出(测试、冒烟脚本、真实消息)。
2. **先讨论后实现**:项目后期用户明确了"问题未达成一致前不得动手"的规则。回头看不只是沟通礼仪 —— 架构反转(内置 pi → pi 独立)如果闷头做完再返工,成本会大得多。
3. **文档跟着真实走**:FAQ 里每一条都是真实踩过的坑。文档不是写给"理想环境"看的,是写给"真实环境"看的。

---

## 17. 未来展望

- **上游演进**:matrix-sdk-crypto-nodejs 未来若改用每平台 optionalDependencies 包(esbuild 模式),21MB 下载坑自动消失,我们零成本受益。
- **更多平台**:0.2.0 起专注 Matrix,transports 层已精简;若未来需要 Telegram/WhatsApp/Slack/Discord,可从上游 pi-messenger-bridge 重新引入对应 transport。
- **E2EE 深度支持**:加密房间目前建议非加密房间绕行;若未来需要,可探索 bot 交叉签名方案。
- **部署形态**:当前覆盖 npm 包 + systemd 用户级服务 + Docker env 一键部署;未来可考虑 compose 多实例、K8s 化等编排场景。
- **多工程生态**:工程房间目前由 `/pmctl` 手工管理;未来可探索与仓库/环境感知联动(如按 git remote 自动映射工程)。

---

*文档完成于项目闭环之际。全文以真实开发记录为据,所有命令均经实测。*
