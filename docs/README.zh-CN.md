# pi-remote

通过 Matrix、Telegram、WhatsApp、Slack、Discord 等即时通讯工具,**远程操控 [pi coding agent](https://pi.dev)**。

与传统的 pi 扩展模式不同,本项目通过 [RPC 协议](https://pi.dev/docs/latest/rpc)驱动 pi,因此 **messenger 里可以直接执行 slash 命令**(`/new`、`/compact`、`/model`、`/skill:name`、提示词模板、扩展命令)—— 这是扩展模式做不到的,因为 pi 的 `sendUserMessage()` 刻意跳过了命令解析。

```
Messenger ──> pi-remote(独立进程)──> pi --mode rpc(内置依赖,JSONL stdio)
Messenger <── 回复 <────────────── <── agent 事件流(stdout)
```

## 特性

- 📱 多 messenger 支持:Matrix、Telegram、WhatsApp、Slack、Discord
- 🔐 6 位验证码认证,传输层命名空间防冒充
- 🎛️ slash 命令全支持:`/new`、`/compact`、`/model`、`/thinking`、`/bash`、`/reload` 等
- 🧩 技能与提示词模板透传:`/skill:名称`、`/模板名` 直接生效
- 💾 会话持久化:pi 会话存磁盘,重启自动恢复
- 🔄 `/reload` 重启 pi 进程:装新插件、改配置后一条命令生效,会话无损
- ⚙️ 自带 pi:pi 作为项目依赖内置,RPC 客户端与子进程版本永远一致

## 快速开始

```bash
# 1. 获取代码(或 git clone 你的仓库)
npm install        # 不要加 --ignore-scripts(Matrix E2EE 原生库需要 postinstall)
npm run build

# 2. 配置 pi 的模型 provider(见 docs/DEPLOYMENT.md §3.3)
#    ~/.pi/agent/models.json  模型元数据
#    ~/.pi/agent/auth.json    API key
#    ~/.pi/agent/settings.json 默认 provider 与模型

# 3. 配置 messenger(见 docs/DEPLOYMENT.md §3.4)
#    ~/.pi/msg-bridge.json    Matrix homeserver + access token 等

# 4. 启动
node dist/standalone.js --workdir /path/to/project [--session-dir /path] [--debug]
```

## 升级 pi(零代码改动)

```bash
npm update @earendil-works/pi-coding-agent @earendil-works/pi-ai
npm run build
sudo systemctl restart pi-msg-bridge
```

- 小版本(`0.83.x`)自动跟上;大版本改 `package.json` 中版本号即可
- 客户端与子进程版本必然一致,不会协议不匹配
- 仅当 pi 的 RPC 协议发生破坏性变更时才需要改代码(协议为文档化稳定接口)

## 命令一览(DM 中直接发送)

**Pi 命令(映射到 RPC)**

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

**Bridge 管理命令**:`/trusted`、`/revoke <userId>`、`/channels`、`/enable <chatId> <mode>`、`/disable <chatId>`、`/toggletools`

**透传**:以 `/` 开头的其他内容直接交给 pi 执行 —— 扩展命令、`/skill:名称`、提示词模板由 pi 展开;普通文本是正常对话。

## systemd 部署(开机自启)

```bash
sudo cp deploy/pi-msg-bridge.service /etc/systemd/system/
# 按需修改 User / WorkingDirectory / Environment
sudo systemctl daemon-reload
sudo systemctl enable --now pi-msg-bridge
```

常用命令:`sudo systemctl status pi-msg-bridge`、`sudo journalctl -u pi-msg-bridge -f`、`sudo systemctl restart pi-msg-bridge`。

## 使用提示

- **Element 客户端**:`/` 开头的消息会被客户端当作命令拦截,要发送字面文本用 `//` 转义(如 `//compact` 会发送 `/compact`)
- **E2EE 房间**:建议在 Element 中验证一次 bot 设备;不验证也能收发新消息,但历史消息无法解密
- **群聊**:需先 `/enable <roomId> all` 启用;DM 无需配置
- **代理环境**:设置 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量(systemd 的 Environment 或 EnvironmentFile)

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 日志大量 `Decryption error` | 历史消息重放,无密钥 | 正常,不影响新消息 |
| `model: unknown` | provider 未配置 | 检查 `~/.pi/agent/{models,auth,settings}.json` |
| `pi RPC did not become ready` | pi 启动失败 | 手动跑 `pi --mode rpc` 看报错 |
| `Cannot locate the pi CLI` | 本地依赖缺失 | `npm install` 或设 `PI_CLI_PATH` |
| `no transports configured` | bridge 未配置 | 检查 `~/.pi/msg-bridge.json` 或 `PI_*` 环境变量 |

## 完整文档

- [docs/DEPLOYMENT.md](DEPLOYMENT.md) — 详细部署与使用指南
- 上游 messenger bridge 项目:[tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge)

## License

MIT
