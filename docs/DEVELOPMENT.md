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
11. [踩坑全记录](#11-踩坑全记录)
12. [技术架构](#12-技术架构)
13. [关键设计决策](#13-关键设计决策)
14. [版本演进](#14-版本演进)
15. [经验与反思](#15-经验与反思)
16. [未来展望](#16-未来展望)

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

**`src/rpc/pi-rpc.ts`**(213 行)—— PiRpc 封装
- pi CLI 探测:`PI_CLI_PATH` 环境变量 → `which pi` → 本地 node_modules,三级回退
- 冷启动握手重试:pi 进程起来需要时间,封装了就绪等待
- 流式中发消息自动降级:`prompt` 在流式进行中会失败,自动附加 `streamingBehavior: "steer"/"followUp"`
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
- `/abort` → `abort`
- `/reload` → 重启 pi 进程(后加)
- 其余 `/xxx` → 透传给 pi 的 `prompt`,由 pi 展开命令/技能/模板

**`src/rpc/pmctl-controller.ts`** —— /pmctl 家族(门禁 + new/list/show/rm/mv/rename;rm 60 秒确认状态为实例字段)
- 门禁顺序:单工程开关 → 管理房间校验 → Matrix 能力
- 邀请目标由 router 以 transport 原生 MXID 传入(控制器不做前缀剥离)

**`src/rpc/message-router.ts`** —— 核心接线
- 认证 → bridge 管理命令 → /pmctl 家族 → RPC 映射命令 → 透传 prompt,五级路由
- agent 事件流(`message_end` / `turn_end` / `agent_start`…)→ 回发到 Matrix
- 回复按 RoomBinding 路由:每个 pi 进程绑定自己的回复目标(项目房间钉住、共享默认进程随最近一次 DM 提示刷新,完整对话轮结束后释放)——不存在进程级单槽
- typing 指示:`agent_start` / `turn_start` 触发 Matrix 输入中状态

**`src/standalone.ts`** —— 独立入口
- 单实例锁(lock.ts)
- 信号优雅关闭(SIGTERM/SIGINT)
- 初始化 transports → 启动 RPC → 挂接事件

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
pi-courier status     服务状态 + 最近日志
pi-courier logs       跟踪日志
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

## 11. 踩坑全记录

这一章把开发过程中遇到的所有坑按主题归档。**每一个坑都是真实遇到、真实解决的**,README 的 FAQ 就是从这里提炼的。

### 11.1 网络与代理(坑最多的一类)

这台部署机的网络环境特殊:外网必须走代理。

| 坑 | 现象 | 解决 |
|---|---|---|
| npm registry 直连超时 | `npm install` 无限转圈 | `npm config set proxy/http-proxy` |
| **GitHub Releases 下载不走 npm 代理** | matrix-sdk-crypto-nodejs 21MB 二进制只有 16-64 kB/s | `export https_proxy` 环境变量(npm 子进程继承) |
| npm 支持 socks5 | 用户问能否用 socks | 实测支持,`npm config set proxy socks5://...` 或 `socks5h://` |
| 代理配置两套体系 | npm 的 proxy 配置 vs 环境变量 | registry 走 npm 配置,GitHub 下载走环境变量,两个都要配 |

**核心教训:一套代理配置覆盖不了所有流量。** npm 的 `proxy` 配置只作用于 npm 自身的 HTTP 客户端;postinstall 脚本里的 node fetch 走的是环境变量。两套必须分别配。

### 11.2 Node 版本混用(最隐蔽的坑)

systemd 服务反复重启,日志显示:

```
TypeError: webidl.util.markAsUncloneable is not a function
```

排查链条:
1. 第一次:unit 的 `ExecStart` 写死了**系统 node v20**(enable 时终端没加载 nvm,`process.execPath` 解析到 `/usr/bin/node`)
2. 修复后 unit 用 v24 跑 bridge,但 **pi 子进程还是 v20** —— bridge 内部 `spawn("node")` 走 PATH,systemd 默认 PATH 里第一个 node 是系统的 v20
3. 最终修复:unit 加 `Environment=PATH=<nvm bin 优先>`,pi 子进程才能找到 v24

**教训**:Node 版本混用(nvm v24 + 系统 v20)会造成跨进程的诡异问题。解决之道不是修一处,而是**全机统一版本**。

### 11.3 E2EE 相关

| 坑 | 现象 | 解决 |
|---|---|---|
| 原生库缺失 | `Cannot find module @matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu` | 手动跑 `download-lib.js` |
| 历史消息解密失败 | 日志刷 `Decryption error` | 正常现象,新设备无旧密钥 |
| **加密房间新消息也解不开** | barry 发消息 bot 无响应 | bot 无交叉签名,用户验证不可用;最终方案:用非加密房间 |
| **device_id 不匹配** | `M_BAD_JSON: Provided device_id in device_keys does not match` | 重登录后删 `~/.pi/msg-bridge-matrix-crypto` |

**device_id 坑的机理**:重新登录会获得新的设备身份,但 crypto store(SQLite)里还存着旧设备的 device_id。上传 device_keys 时身份对不上 → 连接失败。**每次重跑 setup / 换 token 都要删一次 crypto store。**

**加密房间的结论**:bot 账号没有交叉签名,Element 里"用户验证不可用";实测即使取消"仅向已验证设备共享密钥"也拿不到密钥。**最可靠的方案就是非加密房间** —— 配置 `encryption: true` 不影响普通房间。

### 11.4 npm link / 安装

| 坑 | 现象 | 解决 |
|---|---|---|
| link 在 build 前 | `pi-courier` 命令找不到 | build 后重新 link |
| EEXIST | `npm install -g` 报文件已存在 | `npm unlink -g` + 删 bin |
| allow-scripts 拦截 | 原生库 postinstall 被跳 | 手动下载或 approve |

### 11.5 pi 会话相关

| 坑 | 现象 | 解决 |
|---|---|---|
| 重启丢会话 | 每次启动都是新 session id | 给 pi 传 `--continue`(0.1.1) |
| 空会话不落盘 | 无消息的会话文件不写盘 | 正常行为,真实使用不受影响 |

**`--continue` 的验证过程值得一提**:第一次测试失败(两次启动 session id 不同),排查后发现是**测试脚本没发消息**,空会话根本不落盘。补上一条真实 prompt 后,重启验证通过 —— session id 完全一致。测试要模拟真实使用,这个教训很典型。

### 11.6 其他

| 坑 | 现象 | 解决 |
|---|---|---|
| readline 管道丢行 | 向导管道输入时第二个问题后挂起 | 双模式输入:TTY 逐行 + 管道预读 |
| 向导不退出 | 配置写完光标闪烁 | 释放 stdin 监听器 |
| workdir 不存在 | spawn ENOENT | `mkdir -p` 自动创建 |
| DeprecationWarning 混入 | 向导输出被警告打断 | 入口过滤 `util._extend` |
| 空目录 spawn | `--workdir` 不存在时 spawn 报 ENOENT | PiRpc.start() 自动 mkdir |

---

## 12. 技术架构

### 12.1 运行时架构

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

### 12.2 消息路由

```
Matrix 消息(transport 只做纯 I/O,不做授权判定)
  → 群聊 /enable(先于认证 —— 未启用房间的消息正是靠它启用本房间;all 仅管理员)
    → 认证检查(trusted / challenge)
      → bridge 管理命令(/trusted /revoke /channels /enable <chatId> /disable /toggletools)
        → /pmctl 家族(PmctlController:门禁 + new/list/show/rm/mv/rename)
          → RPC 映射命令(/new /compact /model ...;DM /help 也在这里,统一输出 pi 命令 + bridge 命令)
            → 透传 prompt(/skill:xxx /template 普通文本)
```

策略(认证、挑战码、管理命令、群 /enable)只存在于 router 的 `handleIncoming` 管道一份;transport 侧不做任何授权判定(否则未启用房间的消息到不了 `/enable`,该功能在真实链路上不可达)。/pmctl 的门禁与动作集中在 PmctlController,邀请目标由 router 以 transport 原生 MXID 传入。

### 12.3 回复机制

- 对话类回复:监听 agent 事件流的 `turn_end`,按来源进程的 RoomBinding 回信(`message_end` 仅记录日志)
- 同一默认进程内跨 DM 的对话归属是协议限制(pi 的 RPC 无 chat 概念):绑定跟随最近一次提示;项目房间进程独占、天然钉住
- 命令类回复(统计/模型列表):直接等 RPC 响应
- 流式期间发消息:自动附加 `streamingBehavior: "steer"/"followUp"`

### 12.4 会话模型

- pi 会话按 workdir 分目录存储在 `~/.pi/agent/sessions/`
- bridge 启动时传 `--continue`,恢复该 workdir 下最近会话
- `/new` 开新会话,下次重启恢复新会话
- `/reload` 重启 pi 进程,会话无损(文件在磁盘)

---

## 13. 关键设计决策

1. **RPC 模式而非扩展模式**:命令能力是硬需求,扩展模式在架构上无法满足。
2. **用官方 RpcClient**:不重复造轮子,协议细节交给官方维护。
3. **独立项目**:脱离 fork 的束缚,自有版本节奏。
4. **pi 独立安装(peerDependencies)**:bridge 是伴侣程序,不捆绑 pi。"不要反客为主"。
5. **`--continue` 恢复会话**:重启不等于失忆,上下文在磁盘。
6. **一键 CLI + 配置持久化**:部署复杂度收敛到 setup/enable 两条命令。
7. **systemd 用户级服务**:无需 sudo,绝对路径 + PATH 显式控制,避免环境漂移。
8. **scoped npm 包**:包名冲突用账号 scope 解决,命令名不受影响。

---

## 14. 版本演进

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

GitHub 仓库:[github.com/Hi-Barry/pi-courier](https://github.com/Hi-Barry/pi-courier)(私有)
npm 包:[pi-courier](https://www.npmjs.com/package/pi-courier)
---

## 15. 经验与反思

### 15.1 技术层面

1. **源码是最后的真相**:pi 的 `sendUserMessage` 限制、`defaultProvider` 字段名、`--continue` 参数,都是靠读源码确认的。文档会过时,源码不会。
2. **代理是双轨的**:npm 的 proxy 配置和环境变量是两个世界。遇到下载慢,先分清走的是哪条路。
3. **Node 版本统一是底线**:nvm 和系统 node 混用,会在最隐蔽的地方出最诡异的问题。
4. **测试要模拟真实使用**:空会话不落盘导致 --continue 测试假失败,补上真实消息才暴露真相。
5. **发布流程要演练**:scope 存在性、2FA、同步延迟,这些"发布手册"里的小字,全是实际拦路的坑。

### 15.2 流程层面

1. **小步走,每步验证**:整个项目按"调研 → 冒烟 → 骨架 → 联调 → 独立 → 简化 → 发布"推进,每阶段都有可验证的产出(测试、冒烟脚本、真实消息)。
2. **先讨论后实现**:项目后期用户明确了"问题未达成一致前不得动手"的规则。回头看不只是沟通礼仪 —— 架构反转(内置 pi → pi 独立)如果闷头做完再返工,成本会大得多。
3. **文档跟着真实走**:FAQ 里每一条都是真实踩过的坑。文档不是写给"理想环境"看的,是写给"真实环境"看的。

---

## 16. 未来展望

- **上游演进**:matrix-sdk-crypto-nodejs 未来若改用每平台 optionalDependencies 包(esbuild 模式),21MB 下载坑自动消失,我们零成本受益。
- **更多平台**:0.2.0 起专注 Matrix,transports 层已精简;若未来需要 Telegram/WhatsApp/Slack/Discord,可从上游 pi-messenger-bridge 重新引入对应 transport。
- **E2EE 深度支持**:加密房间目前建议非加密房间绕行;若未来需要,可探索 bot 交叉签名方案。
- **更多平台打包**:当前是 npm 包 + systemd 用户级服务,可考虑容器化。

---

*文档完成于项目闭环之际。全文以真实开发记录为据,所有命令均经实测。*
