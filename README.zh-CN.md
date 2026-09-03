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

**不要用 `--ignore-scripts`**:Matrix E2EE 库的 postinstall 会下载原生二进制。npm >= 11 的 `allow-scripts` 默认可能拦截该依赖的 postinstall;`pi-courier` 自己的 postinstall 会自检并**自动补下**缺失的原生二进制(首次安装多下载一次)。若仍报 `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'`(比如自检被跳过),再手动补:

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
信任房间 ID(可选,回车跳过;多个逗号分隔,如 !abc:server 或 !abc:server:mentions):   ← 群聊用;默认模式 trusted-only;可跳过,之后用 /enable 添加
启用 E2EE 加密? [y/N]:                                  ← y/n(非加密房间选 y 也没问题)
pi 工作目录 [默认 /home/你/Projects]:                    ← 回车或输入其他目录
实例名/机器名 [默认 debian]:                             ← 多台部署用来区分;将显示在管理房间名
启用多工程模式? [y/N]:                                   ← 默认 N=单工程(一个 bot 对应一个 pi);y=多工程(管理房间+项目房间)
启用空间组织? [Y/n]:                                     ← 仅多工程时询问;全新配置默认 Y —— bot 创建的房间统一收纳进一个 Element 空间(见下文)

✅ 配置已写入 ~/.pi/pi-courier.json
   账号: @test3:...
   信任用户: @barry:...
   E2EE: 开启
   工作目录: /home/你/Projects
   实例名: debian(多台部署区分,显示在管理房间名)
   多工程: 关闭(单工程)
   设备 ID: PICOURIERXXXXXXXX(固定,重跑 setup 复用)
   信任房间: !abc:server (trusted-only) 或无(群聊默认不回应)
```

> **群聊**:**成员数 >2 的房间默认静默** —— bot 被拉进群时会发一条一次性提示,之后不回应任何消息,直到启用。**启用方式(无需房间 ID)**:直接在群里发 `/enable <all|mentions|trusted-only>`(信任用户,默认 trusted-only);或在 DM 里发 `/enable <房间ID> <模式>`。**2 人房间(你 + bot)自动回应**。房间 ID 形如 `!xxx:服务器`(日志可见)。

### 单工程 / 多工程模式

**默认是单工程(简单模式)**:一个 bot 账号对应一个 pi,所有房间直接连默认工作目录(`workdir`),**没有**管理房间 / 项目房间概念,`/pmctl` 也不可用 —— 适合只想"bot 直接聊天"的用户。

**需要多项目时开启多工程**:
- setup 里"启用多工程模式?"选 `y`,或
- 之后在聊天里发 `/multiproject on` 再 `pi-courier restart` 生效

`/multiproject`(信任用户可发):`on` 开启 / `off` 关闭(都需重启生效);不带参数显示当前状态。多工程模式下才有下面的管理房间/项目房间机制。

### 多项目房间(项目隔离)

同一个 bot 账号可以服务多个项目 —— 每个项目一个私有房间(房间名=项目名),有独立的 pi 进程、工作目录和会话历史。

- **管理房间**:开启**空间组织**时(全新多工程配置默认开启),bot 在启动时**自行创建**管理房间 —— 位于私有空间 `pi-courier · <实例名>` 内,并邀请全部信任用户,无需先给 bot 发 DM。空间关闭(或创建失败)时沿用经典行为:bot **第一次成功受理(授权通过)的、非项目的私有/2 人房间**固化为管理房间(自动改名 `项目管理(<实例名>)` 并发送使用说明,房间 ID 写入 `config.managementRooms`)。两种路径下管理房间都是"管理台"(`/pmctl` 仅在此可用),且房间 ID 之后保持稳定。
- **空间组织(Element)**:纯展示层收纳 —— 私有空间 `pi-courier · <实例名>` 收集 bot 创建的所有房间(管理房间 + `/pmctl new` 的项目房间),不再散落在房间列表里。**不影响信任模型与房间权限**;`/pmctl rm` 删除项目时同步把房间移出空间。开关在 `setup`(`启用空间组织?`,全新配置默认开、已有配置保持现状);空间在下次启动时懒创建,失败仅警告并回退无空间行为、下次启动自动重试。后续通过验证码成为信任用户的用户会被自动邀请进空间(每人只邀请一次)。
- **创建项目**(在管理房间发):
  ```
  /pmctl new <项目名> [路径]
  ```
  **路径可选**:缺省为工程根下同名目录(`newapp` → `~/Projects/newapp`);也可用相对路径(基于工程根)或绝对路径。bot 创建以项目命名的私有房间、邀请发送者进入、把映射写入 `pi-courier.json`(`projects` 字段)并回复确认。项目对话在新房间进行 —— 上下文和 bash 工作目录完全隔离。
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
    "!房间ID:服务器": { "workdir": "/home/你/Projects/myapp" }
  }
  ```
- 每个项目房间按需 lazy 启动自己的 pi 进程(约 300MB/项目),session 存于 `<workdir>/.pi-session`,重启后各项目会话独立恢复。

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

**bridge 管理命令**:`/trusted`、`/revoke <userId>`、`/channels`、`/enable [chatId] <模式>`、`/disable <chatId>`、`/toggletools`

**其他任何 `/` 开头的内容**都直接透传给 pi —— 扩展命令、`/skill:名称`、提示词模板由 pi 展开。普通文本就是正常对话。

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
