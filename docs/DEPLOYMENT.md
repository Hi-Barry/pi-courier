# pi-remote 部署与使用指南

本文档所有命令与配置均经过实测(pi 0.83 + deepseek-v4-flash + Matrix E2EE 房间)。
照着做即可部署成功。

---

## 1. 架构

```
┌─────────────┐   Matrix / Telegram / WhatsApp / Slack / Discord
│ 你的客户端   │◄──────────────┐
└─────────────┘               │
        │                     │
        ▼                     │
┌──────────────────────────────────────┐
│ pi-remote (dist/standalone.js)        │
│  - messenger 收发 + 认证              │
│  - slash 命令 → RPC 命令              │
│  - agent 事件流 → 回复                │
└───────────────┬──────────────────────┘
                │ JSONL over stdio
                ▼
┌──────────────────────────────────────┐
│ pi --mode rpc(项目内置依赖,子进程)    │
│  - 会话持久化 ~/.pi/agent/sessions    │
│  - 模型配置 ~/.pi/agent/              │
└──────────────────────────────────────┘
```

- pi 作为项目依赖内置(`@earendil-works/pi-coding-agent`),**无需全局安装**;RPC 客户端与 pi 子进程版本永远一致
- 会话持久:重启自动恢复

---

## 2. 环境要求

| 组件 | 要求 | 检查命令 |
|---|---|---|
| Node.js | **>= 20**(实测 24.x) | `node --version` |
| npm | 随 Node.js | `npm --version` |
| pi | **>= 0.83,全局安装**(项目不内置) | `pi --version` |
| 网络 | 能访问 homeserver 与 LLM provider 端点 | — |

**先装 pi**(bridge 是 pi 的伴侣程序,通过 RPC 协议连接系统安装的 pi):

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

> 使用 nvm 的注意:每次新终端先 `source ~/.nvm/nvm.sh`(或按你的 nvm 初始化方式),
> 并确认 `pi` 在 PATH 中(`which pi`)。

---

## 3. 部署步骤

### 3.1 获取代码

```bash
git clone https://github.com/Hi-Barry/pi-remote.git
cd pi-remote
```

### 3.2 安装依赖并构建

```bash
npm install
npm run build
```

**重要:不要加 `--ignore-scripts`**。Matrix 的 E2EE 加密库(`@matrix-org/matrix-sdk-crypto-nodejs`)
的原生二进制由 postinstall 脚本下载。若你的 npm 配置了 allow-scripts 拦截导致安装后报
`Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'`,手动补下载:

```bash
cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs
node download-lib.js
cd ../..
```

构建成功标志:出现 `dist/standalone.js`。

> bridge 通过 `which pi` 定位系统安装的 pi;也可用 `PI_CLI_PATH` 环境变量显式指定。
> pi 由系统独立管理、独立升级,bridge 不重复打包。

### 3.3 配置 pi 的 LLM provider

配置目录:`~/.pi/agent/`(不存在则创建,权限 700)。

**a) models.json — 模型元数据**

推荐直接从 models.dev 提取(保证字段完整正确),以 opencode-go 为例:

```bash
curl -s https://models.dev/api.json -o /tmp/modelsdev.json
python3 -c "
import json, os
md = json.load(open('/tmp/modelsdev.json'))   # 顶层直接是 provider 字典
out = {'providers': {'opencode-go': md['opencode-go']}}
json.dump(out, open(os.path.expanduser('~/.pi/agent/models.json'), 'w'), indent=2)
"
```

(models.dev 上其他 provider 同理:把 `opencode-go` 换成对应 id,如 `openai`、`anthropic`。)

也可以手写,结构如下(**字段名必须与 models.dev 一致**):

```json
{
  "providers": {
    "opencode-go": {
      "id": "opencode-go",
      "env": ["OPENCODE_API_KEY"],
      "npm": "@ai-sdk/openai-compatible",
      "api": "https://opencode.ai/zen/go/v1",
      "name": "OpenCode Go",
      "models": {
        "deepseek-v4-flash": {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "reasoning": true,
          "tool_call": true,
          "modalities": { "input": ["text"], "output": ["text"] },
          "limit": { "context": 1000000, "output": 384000 },
          "cost": { "input": 0.14, "output": 0.28, "cache_read": 0.0028 }
        }
      }
    }
  }
}
```

> 关键:`providers` 下的 key 是 provider id;模型对象里 `limit.context`(不是 `contextWindow`)、
> `cost.cache_read`(不是 `cacheRead`)。不确定时用提取命令,别手写。

**b) auth.json — API key**

```json
{
  "opencode-go": { "type": "api_key", "key": "sk-你的密钥" }
}
```

权限:`chmod 600 ~/.pi/agent/auth.json`

**c) settings.json — 默认 provider 与模型**

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4-flash"
}
```

> 字段名是 `defaultProvider` / `defaultModel`(不是 `provider` / `model`)。
> 若想用其他模型,`defaultModel` 填 models.json 里模型的 `id`。

验证配置(在 pi-remote 项目目录内执行):

```bash
node --input-type=module -e "
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const c = new RpcClient({ cliPath: path.join(path.dirname(entry), 'cli.js') });
await c.start();
console.log('可用模型数:', (await c.getAvailableModels()).length);
console.log('当前模型:', (await c.getState()).model?.id);
await c.stop();
"
```

能列出模型数并显示当前模型即配置正确。

### 3.4 配置 messenger(Matrix 为例)

**方式一(推荐):首次运行配置向导**

```bash
node dist/standalone.js --setup
```

按提示依次输入:平台 → homeserver URL → token(用户名密码登录或粘贴已有 token)→
信任用户 MXID → 是否启用 E2EE。向导会验证 token 并自动写入 `~/.pi/msg-bridge.json`。

**方式二:手动编辑 `~/.pi/msg-bridge.json`**(权限 600):

```json
{
  "matrix": {
    "homeserverUrl": "https://你的homeserver",
    "accessToken": "syt_你的token",
    "encryption": true
  },
  "auth": {
    "trustedUsers": ["matrix:@你的账号:你的homeserver域名"],
    "adminUserId": "matrix:@你的账号:你的homeserver域名"
  },
  "autoConnect": true,
  "debug": true
}
```

- `accessToken` 获取:POST 登录或 Element 设置页:

  ```bash
  curl -s -X POST "https://你的homeserver/_matrix/client/v3/login" \
    -H "Content-Type: application/json" \
    -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"bot账号"},"password":"bot密码"}'
  ```

  返回 JSON 中的 `access_token` 即为 token(形如 `syt_...`)。

- `trustedUsers` / `adminUserId` 格式:`<transport>:<完整userId>`,Matrix 的 userId 是完整 MXID(如 `@barry:matrix.example.com`)
- `encryption: true` 用于加密房间;普通房间保持 true 也可用
- 环境变量替代:`PI_MATRIX_HOMESERVER` / `PI_MATRIX_ACCESS_TOKEN`(其他平台见 README)

> 其他平台配置(Telegram / WhatsApp / Slack / Discord)格式相同,对应字段见
> 上游项目 README:`telegram.token`、`slack.botToken`+`appToken`、`discord.token`、`whatsapp.authPath`。

### 3.5 启动

```bash
node dist/standalone.js --workdir /path/to/project [--session-dir /path/to/sessions] [--debug]
```

| 参数 | 说明 |
|---|---|
| `--workdir <dir>` | pi 的工作目录(必填,bash 工具、项目上下文都基于它) |
| `--setup` | 首次运行配置向导(交互式生成 `~/.pi/msg-bridge.json`) |
| `--pi-cli <path>` | 指定 pi 的 cli.js(默认自动:`which pi` → 本地 node_modules → `PI_CLI_PATH`) |
| `--session-dir <dir>` | 会话目录(默认 `~/.pi/agent/sessions`) |
| `--debug` | 详细日志 |

**启动成功的标志日志:**

```
✅ Matrix connected as @bot:你的homeserver (2 rooms, E2EE enabled)
✅ transports connected: matrix=up
✅ pi RPC connected (model: deepseek-v4-flash, session: 019f...)
🚀 msg-bridge standalone ready. Waiting for messages...
```

看到 `model: deepseek-v4-flash`(你的模型)即 provider 配置成功。

---

## 4. systemd 部署(开机自启)

### 方式一:用户级 systemd(推荐,无需 sudo)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/pi-msg-bridge.user.service ~/.config/systemd/user/pi-msg-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now pi-msg-bridge
```

按需修改 `~/.config/systemd/user/pi-msg-bridge.service` 中的 `WorkingDirectory`(项目目录)
和 `ExecStart` 的 `--workdir`(pi 的工作目录)。

彻底无人值守(注销后继续运行),执行一次:

```bash
sudo loginctl enable-linger $USER
```

常用命令:

```bash
systemctl --user status pi-msg-bridge          # 状态
journalctl --user -u pi-msg-bridge -f          # 实时日志
systemctl --user restart pi-msg-bridge         # 重启(会话持久,无损)
```

### 方式二:系统级 systemd(需要 sudo)

```bash
sudo cp deploy/pi-msg-bridge.service /etc/systemd/system/
sudo systemctl edit --full pi-msg-bridge
```

模板关键内容与修改点:

```ini
[Service]
User=hermes                # ← 改成你的用户名
WorkingDirectory=/home/hermes/Projects/pi-remote   # ← 改成 pi-remote 的绝对路径
Environment=NVM_DIR=/home/hermes/.nvm   # ← 用 nvm 则保留,系统 node 则删掉这行
# 如果不用 nvm,把 ExecStart 改成: node dist/standalone.js --workdir /你的项目目录
EnvironmentFile=-/etc/pi-bridge.env     # ← 可选:PI_MATRIX_* 等环境变量文件
ExecStart=/bin/bash -lc 'source "$NVM_DIR/nvm.sh" && exec node dist/standalone.js --workdir /home/hermes/Projects'
Restart=on-failure
RestartSec=5
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pi-msg-bridge
```

常用命令:

```bash
sudo systemctl status pi-msg-bridge       # 状态
sudo journalctl -u pi-msg-bridge -f       # 实时日志
sudo systemctl restart pi-msg-bridge      # 重启(会话持久,无损)
```

---

## 5. 使用说明

### 5.1 首次使用:认证

1. 你的账号给 bot 账号发第一条 DM
2. bridge 终端(或 `journalctl -u pi-msg-bridge -f`)会打印 6 位验证码
3. 把验证码发回给 bot → 成为 trusted user(第一个 trusted 用户自动成为 admin)

> 已预先在 `msg-bridge.json` 的 `trustedUsers` 里写好的账号跳过此步骤。

### 5.2 命令(DM 中直接发送)

**Pi 命令(映射到 RPC):**

| 命令 | 说明 |
|---|---|
| `/new` `/clear` | 新会话 |
| `/compact [说明]` | 压缩上下文 |
| `/model` | 列出可用模型并显示当前 |
| `/model <provider/id>` | 切换模型,如 `/model opencode-go/deepseek-v4-flash` |
| `/models` | 列出可用模型 |
| `/thinking [level]` | 查看/设置思考级别 |
| `/session` `/cost` | 会话统计与费用 |
| `/status` | 当前模型与状态 |
| `/name <名字>` | 会话命名 |
| `/export [路径]` | 导出会话 HTML |
| `/bash <命令>` | 执行 shell 命令(写入上下文) |
| `/abort` | 中止当前操作 |
| `/reload` | 重启 pi 进程(装插件/改配置后使用) |
| `/help` | 完整帮助 |

**Bridge 管理命令:** `/trusted`、`/revoke <userId>`、`/channels`、`/enable <chatId> <mode>`、`/disable <chatId>`、`/toggletools`

**透传:** 其他 `/` 开头的命令直接交给 pi(扩展命令、`/skill:名称`、提示词模板由 pi 展开);普通文本 = 正常对话。

### 5.3 升级 pi(独立升级,零代码改动)

pi 由系统独立管理,bridge 不打包 pi。升级 pi 只需全局更新,bridge 无需任何改动:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi --version
sudo systemctl restart pi-msg-bridge
```

- bridge 通过 `which pi` 始终连接系统最新版 pi
- 大版本升级时,npm 的 peer 依赖检查会提示 bridge 是否兼容
- 仅当 pi 的 RPC 协议破坏性变更时才需要改代码(协议为文档化稳定接口,从未破坏性变更)

---

## 6. 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `git clone` 404 | 仓库地址错误 | 用 `https://github.com/Hi-Barry/pi-remote.git` |
| `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'` | E2EE 原生库没下载 | 执行 §3.2 的手动下载命令 |
| 启动报 `model: unknown` | provider 未配置 | 检查 §3.3 三件套;`settings.json` 字段名是 `defaultProvider`/`defaultModel` |
| `getAvailableModels` 为空 | models.json 格式/字段错 | 用 §3.3 的提取命令重新生成 |
| 日志大量 `Decryption error` | 历史消息重放,无密钥 | 正常,不影响新消息 |
| 加密房间收不到新消息 | bot 设备未验证 | 在 Element 中验证 bot 设备(或换非加密房间) |
| `pi RPC did not become ready` | pi 启动失败 | 手动 `node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc` 看报错 |
| `no transports configured` | bridge 配置为空 | 检查 `~/.pi/msg-bridge.json` 或 `PI_*` 环境变量 |
| Matrix 连接失败 | homeserver/token 错误 | `curl -H "Authorization: Bearer <token>" https://homeserver/_matrix/client/v3/account/whoami` |
| 消息无回复 | 模型调用失败 | `--debug` 看日志;curl 直接测 provider 端点 |

---

## 7. 代理环境

LLM provider 或 homeserver 需要代理时:

- 终端运行:先 `export HTTP_PROXY=http://... HTTPS_PROXY=http://...` 再启动
- systemd:在 `EnvironmentFile`(如 `/etc/pi-bridge.env`)里写:

```
HTTP_PROXY=http://你的代理
HTTPS_PROXY=http://你的代理
```

---

## 8. 开发与测试

```bash
npm run build        # 编译
npm run typecheck    # 类型检查
npm run test         # 单元测试(vitest)
npm run lint         # biome lint
```

代码结构:

```
src/
├── standalone.ts            # 独立进程入口
├── rpc/
│   ├── pi-rpc.ts            # RPC 客户端封装(CLI 探测、握手、prompt→steer 兜底)
│   ├── command-map.ts       # slash 命令 → RPC 命令映射
│   └── message-router.ts    # 消息路由:入站消息 / 出站事件
├── transports/              # Matrix/Telegram/WhatsApp/Slack/Discord
├── auth/challenge-auth.ts   # 6 位码认证 + 管理命令
└── formatting.ts            # 消息格式化/分块
```
