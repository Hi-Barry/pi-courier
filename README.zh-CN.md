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
- **不捆绑 pi** —— pi 独立安装、独立升级
- **会话持久化**到 `~/.pi/agent/sessions`,重启自动恢复
- **一条命令的 CLI**:配置向导、systemd 开机自启、自动更新

## 2. 怎么装

### 前置条件

| 组件 | 要求 |
|---|---|
| Node.js | >= 20(实测 24.x) |
| pi | >= 0.83,**全局安装** |

先装 pi —— pi-courier 连接的是它:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

用 nvm 的话,每个新终端先 `source ~/.nvm/nvm.sh`,确保 `pi` 和 `node` 在 PATH 里。

### 方式 A:普通用户 —— 一条命令

```bash
npm install -g pi-courier
```

完事。验证:`pi-courier help`。

### 方式 B:开发人员 —— 源码构建

```bash
git clone https://github.com/Hi-Barry/pi-courier.git
cd pi-courier
npm install
npm run build
npm link          # 让 `pi-courier` 命令全局可用
```

**不要用 `--ignore-scripts`**:Matrix E2EE 库的 postinstall 会下载原生二进制。如果被 npm 拦截,报 `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'` 时手动补:

```bash
cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs
node download-lib.js
cd ../..
```

下载很慢(20-60 kB/s)?这个二进制来自 GitHub Releases,**不走 npm 代理** —— 先 `export https_proxy=... http_proxy=...` 再装。

## 3. 怎么用

### 第 0 步 —— 确认 pi 能对话(一次性)

pi 需要在 `~/.pi/agent/` 里配好 LLM provider(`models.json`、`auth.json`、`settings.json`)。最快的检查方式:跑 `pi`,随便发条消息,能回复就行。不能回复就先配好(参考 pi 官方文档;注意 `settings.json` 的字段名是 `defaultProvider` / `defaultModel`)。

### 第 1 步 —— 运行配置向导

```bash
pi-courier setup
```

向导会逐步询问,照着输入(方括号里是默认值,直接回车接受):

```
=== pi-courier 首次配置向导 ===
将生成 ~/.pi/pi-courier.json(权限 600)

Matrix homeserver URL (如 https://matrix.example.com):   ← 输入,如 https://matrix.example.com
获取 token 方式 [1=用户名密码登录, 2=粘贴已有 token] (1):  ← 1 或 2(回车默认 1)
  [方式 1] bot 用户名 (如 test2):                        ← bot 账号名,如 test3
           bot 密码:                                     ← 密码(不回显)
  [方式 2] 粘贴 access token (syt_...):                  ← 已有 token
✅ 登录成功,账号: @test3:matrix.example.com
信任用户(管理员)MXID [默认 @test3:matrix.example.com]:   ← 直接回车 = 只有 bot 自己可信;建议填你的账号,如 @barry:matrix.example.com
启用 E2EE 加密? [y/N]:                                  ← y/n(非加密房间选 y 也没问题)
pi 工作目录 [默认 /home/你/Projects]:                    ← 回车或输入其他目录

✅ 配置已写入 ~/.pi/pi-courier.json
   账号: @test3:...
   信任用户: @barry:...
   E2EE: 开启
   工作目录: /home/你/Projects
```

向导会验证 token 并写入 `~/.pi/pi-courier.json`。不想用向导的话,手动创建这个文件也行 —— 格式见[常见问题](#4-常见问题)。

### 第 2 步 —— 启动

```bash
pi-courier enable     # 安装 systemd 服务:开机自启 + 立即启动
```

想先快速前台测试:`pi-courier run`(Ctrl+C 停止)。

启动成功长这样:

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

你就成为 trusted user(第一个 trusted 用户自动成为管理员)。不在 `auth.trustedUsers` 里的用户都会走一次这个流程;预信任用户完全跳过。

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
| `/stop` | 立即停止所有任务(≈ TUI 的 Esc;别名 `/abort`) |
| `/reload` | 重启 pi(装完扩展/配置后) |
| `/help` | 完整帮助 |

**bridge 管理命令**:`/trusted`、`/revoke <userId>`、`/channels`、`/enable <chatId> <mode>`、`/disable <chatId>`、`/toggletools`

**其他任何 `/` 开头的内容**都直接透传给 pi —— 扩展命令、`/skill:名称`、提示词模板由 pi 展开。普通文本就是正常对话。

**群聊**:先给 bot 发 `/enable <roomId> all` 启用该房间。

### 服务管理

```bash
pi-courier status              # 状态 + 最近日志
pi-courier logs                # 跟踪日志(INFO 及以上)
pi-courier logs --level debug  # 跟踪全部日志(含思考、流式增量)
pi-courier logs --level error  # 只看错误
pi-courier run --level debug   # 前台运行,全量显示
pi-courier restart             # 重启
pi-courier stop                # 停止
pi-courier start               # 启动
pi-courier disable             # 卸载服务
pi-courier update              # 更新 pi-courier 自身
```

日志级别:`debug < info < warn < error`。服务会把全部内容写入日志;`logs` 默认显示 INFO 及以上,`--level debug` 显示完整会话回放(用户消息、思考、工具调用、回复)。完整对话始终保存在 pi 的会话文件(`~/.pi/agent/sessions/`)。

**升级 pi** 是独立的事 —— pi-courier 始终通过 `which pi` 连接系统 pi:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi-courier restart
```

## 4. 常见问题

**Q: `npm install` 卡住 / 只有 20-60 kB/s?**
A: 21MB 的 E2EE 原生库从 GitHub Releases 下载,不走 npm 代理。先 `export https_proxy=... http_proxy=...`(写进 `~/.bashrc` 永久生效)再装。

**Q: 报 `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'`?**
A: 原生二进制没下载(postinstall 被拦)。手动补:`cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs && node download-lib.js`。

**Q: `npm install -g pi-courier` 报 EEXIST?**
A: 之前 `npm link` 过,bin 冲突。`npm unlink -g pi-courier && rm -f $(npm prefix -g)/bin/pi-courier && npm install -g pi-courier`。

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
