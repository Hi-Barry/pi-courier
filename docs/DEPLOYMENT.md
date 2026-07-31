# pi-remote 部署与使用指南

本文档描述 **standalone 模式**(bridge 作为独立进程,通过 RPC 协议驱动 pi)的完整部署与使用流程。
此模式与传统的 pi 扩展模式(interactive TUI 内 `/msg-bridge` 管理)不同:它可以让你**通过任意 messenger 直接执行 pi 的 slash 命令**(`/new`、`/compact`、`/model`、`/skill:name` 等)。

> 原理:pi 的扩展 API `sendUserMessage()` 刻意跳过命令解析(skip command handling),
> 所以扩展模式下 slash 命令永远无法执行;而 RPC 模式的 `prompt` 命令默认会解析并执行
> 扩展命令、技能(`/skill:name`)和提示词模板,内置命令(`/compact`、`/model` 等)则有
> 对应的专属 RPC 命令。bridge 负责把 messenger 消息翻译成 RPC 调用,并把 agent 事件流
> 转发回 messenger。

---

## 1. 架构

```
┌─────────────┐   Matrix / Telegram / WhatsApp / Slack / Discord
│ 你的客户端   │◄──────────────┐
└─────────────┘               │
        │                     │
        ▼                     │
┌──────────────────────────────────────┐
│ bridge 进程 (dist/standalone.js)      │
│  - 各 messenger transport(收/发)      │
│  - ChallengeAuth(6 位码认证)          │
│  - slash 命令映射 → RPC 命令           │
│  - agent 事件流 → 回复                │
└───────────────┬──────────────────────┘
                │ JSONL over stdio
                ▼
┌──────────────────────────────────────┐
│ pi --mode rpc (子进程)                │
│  - 会话持久化到 ~/.pi/agent/sessions  │
│  - 模型/provider 读 ~/.pi/agent/      │
│  - 扩展/技能/提示词模板照常加载        │
└──────────────────────────────────────┘
```

- bridge 负责 spawn 并管理 `pi --mode rpc` 子进程;pi 崩溃后 bridge 可重启它(当前版本需重启 bridge)
- 会话是持久的:重启后自动恢复同一会话
- systemd 只需托管 bridge 一个服务

---

## 2. 环境要求

| 组件 | 要求 |
|---|---|
| Node.js | >= 20(实测 24.x 正常) |
| pi | >= 0.83(`@earendil-works/pi-coding-agent`,npm 全局安装) |
| npm | 随 Node.js |
| 网络 | 访问 homeserver + LLM provider 端点(必要时配代理,见 §7) |

---

## 3. 部署步骤

### 3.1 获取代码并构建(自带 pi)

**pi 已作为项目依赖内置**(`@earendil-works/pi-coding-agent`),无需全局安装。
bridge 的 RPC 客户端与 spawn 的 pi 子进程始终使用同一版本。

```bash
git clone https://github.com/tintinweb/pi-remote.git
cd pi-remote
npm install                 # 不要加 --ignore-scripts:matrix-bot-sdk 的 E2EE
                            # 原生库依赖 postinstall 下载
npm run build               # 产出 dist/standalone.js
```

> 注意:`@matrix-org/matrix-sdk-crypto-nodejs` 的原生二进制由 postinstall 下载;
> 若被 npm 的 allow-scripts 拦截,手动执行:
> `cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs && node download-lib.js`

### 3.2 升级 pi(同步升级,零代码改动)

pi 升级时只需更新依赖版本并重启,不需要改任何代码:

```bash
npm update @earendil-works/pi-coding-agent @earendil-works/pi-ai
npm run build
sudo systemctl restart pi-msg-bridge
```

- 小版本(`0.83.x`)自动跟上:`^0.83.0` 范围
- 大版本(如 `0.84`):改 `package.json` 中两个 `@earendil-works/*` 的版本号后重复上面三步
- 升级后 `pi-remote` 的 RPC 客户端与子进程版本必然一致,不会出现协议不匹配
- 仅在 pi 的 RPC 协议发生破坏性变更时才需要改代码(协议为文档化稳定接口,目前从未破坏性变更)

### 3.3 配置 pi 的 provider(LLM 模型)

pi 的配置目录:`~/.pi/agent/`

**a) models.json** — 模型元数据(可从 models.dev 提取,也可只写你用的 provider):

```json
{
  "providers": {
    "opencode-go": {
      "name": "OpenCode Go",
      "api": "https://opencode.ai/zen/go/v1",
      "models": {
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash",
          "api": "openai-completions",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 },
          "contextWindow": 1000000,
          "maxTokens": 384000
        }
      }
    }
  }
}
```

> 简便做法:models.dev 已有 opencode-go 等大量 provider 条目,
> 直接抓取 `https://models.dev/api.json` 提取对应 provider 写入即可。

**b) auth.json** — API key(权限 600):

```json
{
  "opencode-go": { "type": "api_key", "key": "sk-你的密钥" }
}
```

**c) settings.json** — 默认 provider 与模型:

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4-flash"
}
```

验证:`pi --mode rpc` 启动后 `get_state` 应显示对应模型(或直接跑 bridge 看日志)。

### 3.4 配置 messenger(Matrix 示例)

bridge 配置:`~/.pi/msg-bridge.json`(权限 600):

```json
{
  "matrix": {
    "homeserverUrl": "https://matrix.example.com",
    "accessToken": "syt_...",
    "encryption": true
  },
  "auth": {
    "trustedUsers": ["matrix:@yourname:matrix.example.com"],
    "adminUserId": "matrix:@yourname:matrix.example.com"
  },
  "autoConnect": true,
  "debug": true
}
```

- `accessToken`:登录 bot 账号获取(`POST /_matrix/client/v3/login` 或 Element 设置页)
- `trustedUsers` 格式:`<transport>:<userId>`,matrix 的 userId 是完整 MXID
- 环境变量替代:`PI_MATRIX_HOMESERVER` / `PI_MATRIX_ACCESS_TOKEN`(以及 `PI_TELEGRAM_TOKEN`、`PI_SLACK_BOT_TOKEN` 等,见 README)

### 3.5 启动

```bash
node dist/standalone.js --workdir /path/to/project [--session-dir /path/to/sessions] [--debug]
```

| 参数 | 说明 |
|---|---|
| `--workdir <dir>` | pi 的工作目录(bash 工具、项目上下文都基于它) |
| `--pi-cli <path>` | 显式指定 pi 的 cli.js(默认 `PI_CLI_PATH` → 本地 node_modules → `which pi`) |
| `--session-dir <dir>` | 会话存储目录(默认 `~/.pi/agent/sessions`) |
| `--debug` | 详细日志 |

启动成功后日志类似:

```
✅ Matrix connected as @test2:matrix.purplelin.com (2 rooms, E2EE enabled)
✅ transports connected: matrix=up
✅ pi RPC connected (model: deepseek-v4-flash, session: 019fb7e2-...)
🚀 msg-bridge standalone ready. Waiting for messages...
```

---

## 4. systemd 部署(开机自启)

仓库内已提供 `deploy/pi-msg-bridge.service` 模板:

```bash
sudo cp deploy/pi-msg-bridge.service /etc/systemd/system/
# 按需修改 User / WorkingDirectory / Environment
sudo systemctl daemon-reload
sudo systemctl enable --now pi-msg-bridge
```

常用管理命令:

```bash
sudo systemctl status pi-msg-bridge      # 状态
sudo journalctl -u pi-msg-bridge -f      # 日志
sudo systemctl restart pi-msg-bridge     # 重启(会话持久,无损)
```

---

## 5. 使用说明

### 5.1 首次使用:认证

1. 用你的账号给 bot 账号发第一条 DM
2. bridge 终端打印 6 位验证码(或由管理员转发给你)
3. 把验证码发回给 bot → 成为 trusted user
4. 第一个 trusted user 自动成为 admin

### 5.2 命令总览(DM 中直接发送)

**Bridge 管理命令**(由 bridge 处理):

| 命令 | 说明 |
|---|---|
| `/trusted` | 列出信任用户 |
| `/revoke <userId>` | 撤销信任 |
| `/channels` | 列出频道 |
| `/enable <chatId> <mode>` | 启用频道(mode: all / mentions / trusted-only) |
| `/disable <chatId>` | 禁用频道 |
| `/toggletools` | 切换工具调用可见性 |

**Pi 命令**(映射到 RPC):

| 命令 | 说明 |
|---|---|
| `/new` `/clear` | 新会话 |
| `/compact [说明]` | 压缩上下文 |
| `/model` | 列出模型并显示当前 |
| `/model <provider/id>` | 切换模型 |
| `/models` | 列出可用模型 |
| `/thinking [level]` | 查看/设置思考级别 |
| `/session` `/cost` | 会话统计与费用 |
| `/status` | 当前模型与状态 |
| `/name <名字>` | 会话命名 |
| `/export [路径]` | 导出会话 HTML |
| `/bash <命令>` | 执行 shell 命令(写入上下文) |
| `/abort` | 中止当前操作 |
| `/reload` | 重启 pi 进程(装新插件/改配置后使用,会话持久无损) |
| `/help` | 完整帮助 |

**透传**(直接发给 pi 执行):`/skill:名称`、提示词模板、任何扩展命令(如 `/msg-bridge` 旧命令)。普通文本 = 正常对话。

### 5.3 Matrix 客户端注意

- Element 等客户端会把 `/` 开头的消息当作**客户端命令**拦截(如 `/help`、`/msg`、`/join`)。要发送字面 `/` 开头的文本,用 `//` 转义(`//compact` → 发送 `/compact`)
- 群聊模式需先 `/enable <roomId> all` 启用;DM 不需要
- E2EE 房间:新 bot 设备建议在 Element 中验证一次(不验证也能收新消息,但历史消息无法解密)

---

## 6. 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 日志大量 `Decryption error` / `Can't find the room key` | 历史消息重放,无密钥 | 正常,启动后自动过滤,不影响新消息 |
| `model: unknown` | provider 未配置 | 检查 `~/.pi/agent/{models,auth,settings}.json` |
| `pi RPC did not become ready` | pi 启动失败 | 手动跑 `pi --mode rpc` 看报错;检查 `pi` 是否在 PATH |
| `Cannot locate the pi CLI` | pi 未安装 | `npm i -g @earendil-works/pi-coding-agent` 或设 `PI_CLI_PATH` |
| `no transports configured` | bridge 配置为空 | 检查 `~/.pi/msg-bridge.json` 或 `PI_*` 环境变量 |
| Matrix 连接失败 | homeserver/token 错误 | 用 curl 直接测 `/_matrix/client/v3/account/whoami` |
| 消息无回复 | 模型调用失败 | 开 `--debug` 看日志;curl 直接测 provider 端点 |
| 无法解密加密房间消息 | 设备未验证 | 在 Element 中验证 bot 设备(或换非加密房间) |

---

## 7. 代理环境

LLM provider 或 homeserver 需要代理时:

- bridge 自身:设置 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量(systemd unit 的 Environment 或 EnvironmentFile)
- pi 子进程继承 bridge 的环境变量;pi 也支持 settings.json 的 `httpProxy` 字段
- 注意:部分 provider 端点(如 opencode.ai)走代理时需确认代理支持对应协议

---

## 8. 开发与测试

```bash
npm run build        # 编译 TypeScript
npm run typecheck    # 类型检查
npm run test         # 单元测试(vitest)
npm run lint         # biome lint
```

本地集成验证(无需真实 messenger):

```bash
node dist/standalone.js --workdir /path/to/project   # 配好 transports 后直接跑
```

也可以用临时脚本 + mock transport 验证消息路由(`src/rpc/message-router.ts` 已按可测试性设计)。

---

## 9. 代码结构(standalone 相关)

```
src/
├── standalone.ts            # 独立进程入口:参数解析、transports 初始化、生命周期
├── rpc/
│   ├── pi-rpc.ts            # RpcClient 封装:CLI 探测、握手、prompt→steer 兜底、命令缓存
│   ├── command-map.ts       # slash 命令 → RPC 命令映射表
│   └── message-router.ts    # 核心接线:消息入站 / 事件出站、pending 会话跟踪
├── transports/              # 各 messenger 实现(复用原扩展模式代码)
├── auth/challenge-auth.ts   # 6 位码认证 + 管理命令(复用)
└── formatting.ts            # 消息格式化/分块(复用)
```
