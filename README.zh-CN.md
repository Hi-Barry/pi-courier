# pi-remote

[English](README.md) | [简体中文](README.zh-CN.md)

通过 Matrix、Telegram、WhatsApp、Slack、Discord 等即时通讯工具,**远程操控 [pi coding agent](https://pi.dev)**。

与传统的 pi 扩展模式不同,本项目通过 [RPC 协议](https://pi.dev/docs/latest/rpc)驱动 pi,因此 **messenger 里可以直接执行 slash 命令**(`/new`、`/compact`、`/model`、`/skill:name`、提示词模板、扩展命令)—— 这是扩展模式做不到的,因为 pi 的 `sendUserMessage()` 刻意跳过了命令解析。

> **上游来源**:本项目改造自 [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) —— messenger 传输层(Matrix/Telegram/WhatsApp/Slack/Discord)与挑战码认证来自上游;基于 RPC 的独立架构、slash 命令映射与配置向导为本项目新增。

## 特性

- 📱 多 messenger 支持:Matrix、Telegram、WhatsApp、Slack、Discord
- 🔐 6 位验证码认证,传输层命名空间防冒充
- 🎛️ slash 命令全支持:`/new`、`/compact`、`/model`、`/thinking`、`/bash`、`/reload` 等
- 🧩 技能与提示词模板透传:`/skill:名称`、`/模板名` 直接生效
- 💾 会话持久化:pi 会话存磁盘,重启自动恢复
- 🔄 `/reload` 重启 pi 进程:装新插件、改配置后一条命令生效,会话无损
- 🔌 不打包 pi:作为 pi 的伴侣程序独立部署,通过 RPC 连接系统安装的 pi,pi 独立升级
- 🧭 首次运行配置向导:`--setup` 交互式配置 Matrix 账号与信任用户

## 架构

```
Messenger ──> pi-remote (dist/standalone.js) ──> pi --mode rpc(系统安装)
Messenger <── 回复 <────────────────────────── <── agent 事件流(stdout JSONL)
```

- pi-remote 负责 spawn 并管理 `pi --mode rpc` 子进程
- 会话持久化到 `~/.pi/agent/sessions`,重启自动恢复
- systemd 只需托管 pi-remote 一个服务

## 环境要求

| 组件 | 要求 | 检查命令 |
|---|---|---|
| Node.js | **>= 20**(实测 24.x) | `node --version` |
| pi | **>= 0.83,全局安装**(项目不打包) | `pi --version` |
| 网络 | 能访问 homeserver 与 LLM provider 端点 | — |

**先装 pi**(bridge 是 pi 的伴侣程序,通过 RPC 协议连接系统安装的 pi):

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

> 使用 nvm 的注意:每次新终端先 `source ~/.nvm/nvm.sh`(或按你的 nvm 初始化方式),并确认 `pi` 在 PATH 中(`which pi`)。

## 安装

```bash
git clone https://github.com/Hi-Barry/pi-remote.git
cd pi-remote
npm install
npm run build
```

**重要:不要加 `--ignore-scripts`**。Matrix 的 E2EE 加密库(`@matrix-org/matrix-sdk-crypto-nodejs`)的原生二进制由 postinstall 脚本下载。若你的 npm 配置了 allow-scripts 拦截导致安装后报 `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'`,手动补下载:

```bash
cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs
node download-lib.js
cd ../..
```

构建成功标志:出现 `dist/standalone.js`。

## 配置

### pi 的 LLM provider(`~/.pi/agent/`)

**a) models.json** — 模型元数据。推荐从 models.dev 提取(字段完整正确),以 opencode-go 为例:

```bash
curl -s https://models.dev/api.json -o /tmp/modelsdev.json
python3 -c "
import json, os
md = json.load(open('/tmp/modelsdev.json'))   # 顶层直接是 provider 字典
out = {'providers': {'opencode-go': md['opencode-go']}}
json.dump(out, open(os.path.expanduser('~/.pi/agent/models.json'), 'w'), indent=2)
"
```

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

> 字段名是 `defaultProvider` / `defaultModel`(不是 `provider` / `model`)。

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

### 配置 messenger(Matrix 为例)

**方式一(推荐):首次运行配置向导**

```bash
node dist/standalone.js --setup
```

按提示依次输入:平台 → homeserver URL → token(用户名密码登录或粘贴已有 token)→ 信任用户 MXID → 是否启用 E2EE。向导会验证 token 并自动写入 `~/.pi/msg-bridge.json`。

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

- `accessToken` 获取:`POST /_matrix/client/v3/login`(密码登录)或 Element 设置页
- `trustedUsers` / `adminUserId` 格式:`<transport>:<完整userId>`,Matrix 的 userId 是完整 MXID(如 `@barry:matrix.example.com`)
- `encryption: true` 用于加密房间;普通房间保持 true 也可用
- 环境变量替代:`PI_MATRIX_HOMESERVER` / `PI_MATRIX_ACCESS_TOKEN`(其他平台:`PI_TELEGRAM_TOKEN`、`PI_SLACK_BOT_TOKEN`+`PI_SLACK_APP_TOKEN`、`PI_DISCORD_TOKEN`、`PI_WHATSAPP_AUTH_PATH`)

## 使用

```bash
node dist/standalone.js --workdir /path/to/project [--session-dir /path] [--debug]
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
✅ pi RPC connected (model: deepseek-v4-flash, session: 019f...)
🚀 msg-bridge standalone ready. Waiting for messages...
```

### 命令一览(DM 中直接发送)

**Pi 命令(映射到 RPC):**

| 命令 | 说明 |
|---|---|
| `/new` `/clear` | 新会话 |
| `/compact [说明]` | 压缩上下文 |
| `/model` / `/model <provider/id>` | 查看 / 切换模型 |
| `/models` | 列出可用模型 |
| `/thinking [level]` | 查看 / 设置思考级别 |
| `/session` `/cost` | 会话统计与费用 |
| `/status` | 当前模型与状态 |
| `/name <名字>` | 会话命名 |
| `/export [路径]` | 导出会话 HTML |
| `/bash <命令>` | 执行 shell 命令(写入上下文) |
| `/abort` | 中止当前操作 |
| `/reload` | 重启 pi 进程(装插件 / 改配置后使用) |
| `/help` | 完整帮助 |

**Bridge 管理命令:** `/trusted`、`/revoke <userId>`、`/channels`、`/enable <chatId> <mode>`、`/disable <chatId>`、`/toggletools`

**透传:** 其他 `/` 开头的命令直接交给 pi(扩展命令、`/skill:名称`、提示词模板由 pi 展开);普通文本 = 正常对话。

### 首次使用:认证

1. 你的账号给 bot 账号发第一条 DM
2. bridge 终端(或 `journalctl --user -u pi-msg-bridge -f`)会打印 6 位验证码
3. 把验证码发回给 bot → 成为 trusted user(第一个 trusted 用户自动成为 admin)

已在 `msg-bridge.json` 的 `auth.trustedUsers` 里预置的账号跳过此步骤。

## systemd 部署(开机自启)

**用户级(推荐,无需 sudo):**

```bash
mkdir -p ~/.config/systemd/user
cp deploy/pi-msg-bridge.user.service ~/.config/systemd/user/pi-msg-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now pi-msg-bridge
```

按需修改 `~/.config/systemd/user/pi-msg-bridge.service` 中的 `WorkingDirectory`(项目目录)和 `ExecStart` 的 `--workdir`(pi 的工作目录)。彻底无人值守(注销后继续运行)执行一次:`sudo loginctl enable-linger $USER`。

常用命令:`systemctl --user status pi-msg-bridge`、`journalctl --user -u pi-msg-bridge -f`、`systemctl --user restart pi-msg-bridge`。

**系统级(需要 sudo):** 复制 `deploy/pi-msg-bridge.service` 到 `/etc/systemd/system/`,按注释修改三处必改项(`User`、`WorkingDirectory`、`NVM_DIR`),再 `sudo systemctl enable --now pi-msg-bridge`。

## 升级 pi

pi 由系统独立管理,升级只需全局更新,bridge 无需任何改动:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi --version
systemctl --user restart pi-msg-bridge
```

bridge 通过 `which pi` 始终连接系统最新版 pi。仅当 pi 的 RPC 协议发生破坏性变更时才需要改 bridge 代码(协议为文档化稳定接口,从未破坏性变更)。

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `git clone` 404 | 仓库地址错误 | 用 `https://github.com/Hi-Barry/pi-remote.git` |
| `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'` | E2EE 原生库没下载 | 执行安装章节的手动下载命令 |
| 启动报 `model: unknown` | provider 未配置 | 检查 `~/.pi/agent/` 三个文件 |
| `getAvailableModels` 为空 | models.json 格式错 | 用 models.dev 提取命令重新生成 |
| 日志大量 `Decryption error` | 历史消息重放,无密钥 | 正常,不影响新消息 |
| 加密房间收不到新消息 | bot 设备未验证 | 在 Element 中验证 bot 设备(或换非加密房间) |
| `pi RPC did not become ready` | pi 启动失败 | 手动 `node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc` 看报错 |
| `no transports configured` | bridge 配置为空 | 检查 `~/.pi/msg-bridge.json` 或 `PI_*` 环境变量 |
| Matrix 连接失败 | homeserver/token 错误 | `curl -H "Authorization: Bearer <token>" https://homeserver/_matrix/client/v3/account/whoami` |
| 消息无回复 | 模型调用失败 | `--debug` 看日志;curl 直接测 provider 端点 |

## 使用提示

- **Element 客户端**:`/` 开头的消息会被客户端当作命令拦截,要发送字面文本用 `//` 转义(如 `//compact` 会发送 `/compact`)
- **代理环境**:设置 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量(systemd 用 EnvironmentFile)
- **群聊**:需先 `/enable <roomId> all` 启用;DM 无需配置

## 开发

```bash
npm run build        # 编译
npm run typecheck    # 类型检查
npm run test         # 单元测试(vitest)
npm run lint         # biome lint
```

## License

MIT

上游:[tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge)(MIT)
