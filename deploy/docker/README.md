# pi-courier Docker 部署说明

在 VPS 上用 Docker 部署 pi-courier(Matrix → pi 桥接服务)。

## 目录结构

```
deploy/docker/
├── Dockerfile            # 镜像构建(装 pi + pi-courier + 默认配置模板)
├── docker-compose.yml    # 编排(四卷:pi 的家 + 桥配置/数据/状态,见下)
├── entrypoint.sh         # 首次启动:自动把默认配置模板拷入 agent 目录
├── defaults/             # 模板源(构建进镜像 /opt/pi-courier/defaults/)
│   └── agent/
│       ├── models.json   # 完整模型数据(24 模型,开箱即用)
│       ├── auth.json     # API key 占位(也可用 pi TUI 配置)
│       └── settings.json # 默认 provider + 模型
└── data/                 # 运行时数据(自动创建;含 key/token,已 gitignore)
    ├── agent/            # pi 的家:凭据/模型/会话(首次启动自动从模板填充)
    ├── config/           # 桥配置根:pi-courier.json(setup 向导写入)
    ├── lib/              # 桥数据根:Matrix 存储/加密库/附件(删了要重新配对)
    └── state/            # 桥状态根:心跳/审计/台账/快照/锁/日志
```

容器内挂载点与宿主侧目录一一对应(旧布局(≤1.3.0)用户的 `./data` 整卷平铺
文件,首启由桥自动搬进 config/lib/state,见[从旧布局升级](#从旧布局升级)):

| 宿主侧 | 容器内 | 内容 |
|---|---|---|
| `./data` | `/root/.pi` | pi CLI 的家:agent/ 凭据、模型、会话(全平台恒 `~/.pi`,不随三根分离迁移) |
| `./data/config` | `/root/.config/pi-courier` | 桥配置根:`pi-courier.json` |
| `./data/lib` | `/root/.local/share/pi-courier` | 桥数据根:`matrix-store.json`、`matrix-crypto/`、`attachments/` |
| `./data/state` | `/root/.local/state/pi-courier` | 桥状态根:心跳/审计/台账/快照/锁/`logs/` |

## 部署步骤(实测流程)

### 1. 准备

```bash
# VPS 上安装 Docker + Compose 插件(若未安装)
# Debian/Ubuntu:
curl -fsSL https://get.docker.com | sh
sudo apt-get install -y docker-compose-plugin
```

```bash
# 获取项目文件
git clone https://github.com/Hi-Barry/pi-courier.git && cd pi-courier/deploy/docker
```

### 2. 构建

```bash
# 如果 VPS 需要代理访问外网(GitHub 下载 21MB E2EE 库),构建时传入:
# docker compose build --build-arg HTTPS_PROXY=http://<host>:<port> --build-arg HTTP_PROXY=http://<host>:<port>
#
# 注意:构建期代理凭据不会写进最终镜像(逐 RUN 内联)。运行期容器需要代理时,
# 在 docker-compose.yml 的 environment 里给容器传 https_proxy/http_proxy。

docker compose build
```

### 3. 启动容器

```bash
docker compose up -d
```

首次启动 entrypoint 会自动把 LLM 配置模板拷入 `./data/agent/`(models.json / auth.json / settings.json)。此时容器处于"等待配置"状态,日志会提示(属正常):

```
[pi-courier] first run: seeding /root/.pi/agent/auth.json from template
[WARN] ⚠️ 未配置 Matrix 连接(缺少 homeserver 或 access token)。
[WARN]    请运行 `pi-courier setup` 完成配置,然后重启服务。
[WARN]    等待配置中… (Ctrl+C / SIGTERM 退出)
```

> **也可以完全跳过 4-5 步**:用环境变量一键配置(见文末"环境变量一键部署"),`up -d` 后直接就是就绪状态。

### 4. 配置 LLM 模型(pi TUI,推荐)

```bash
docker exec -it pi-courier bash
pi          # 进入 pi 交互界面
/login      # 登录/配置 provider(填 API key)
/model      # 选择模型(如 deepseek-v4-flash)
exit        # 退出
```

> 也可以不用 TUI:直接编辑宿主 `./data/agent/auth.json`(把占位的 `sk-你的key` 换成真实 key),settings.json 里确认默认模型。entrypoint 已把模板拷好,只需填 key。

### 5. 配置 Matrix

```bash
docker exec -it pi-courier bash
pi-courier setup    # 交互向导:服务器地址 → token(密码登录或粘贴)→ 信任用户 → E2EE → workdir
exit
```

- **信任用户**:可以直接回车默认(bot 自己),之后第一个给你发消息的人通过验证码自动配对(见第 7 步)
- 向导写入容器内 `/root/.config/pi-courier/pi-courier.json`(宿主 `./data/config/pi-courier.json`)

### 6. 重启生效 + 查看日志

```bash
docker compose restart
docker logs -f pi-courier
```

看到如下输出即部署成功:

```
✅ Matrix connected as @dockerpicourier1:matrix.purplelin.com (0 rooms, E2EE enabled)
✅ transports connected: matrix=up
✅ pi RPC connected (model: deepseek-v4-flash, session: 019f...)
🚀 pi-courier ready. Waiting for messages...
```

### 7. 首次配对(6 位验证码)

如果 setup 时信任用户用了默认(bot 自己),用你的账号给 bot 发第一条消息,日志会打印验证码:

```
[INFO] 🔐 Challenge code for @barry: 529311
```

**在 Matrix 客户端把这 6 位数字回复给 bot**,配对成功:

```
[INFO] [auth:info] ✅ barry authenticated
```

之后就能正常对话了:

```
[INFO] 📥 [matrix] @barry: 你好,收到请回复!
[INFO] [agent] 回复 @barry: 你好!收到,我在线。...
```

### 8. 使用

- 查看日志: `docker logs -f pi-courier`(或 `docker exec pi-courier pi-courier logs --level debug`)
- 重启: `docker compose restart`
- 停止: `docker compose down`(数据保留在 ./data)
- **GitHub CLI(gh)**:镜像内置。交互登录:`docker exec -it pi-courier bash` → `gh auth login`(device flow);或注入 token(compose environment 加 `GH_TOKEN: ghp_xxx`,适合自动化)

### 9. 升级

```bash
# 方式 A:容器内自更新(npm 全局方式)
docker exec pi-courier pi-courier update

# 方式 B:重建镜像(Dockerfile 里 PI_COURIER_VERSION 已更新到新版时)
git pull && docker compose build && docker compose up -d

# 注意:升级 pi-courier 后,确保 Dockerfile 顶部的
# ARG PI_COURIER_VERSION 已是新版本号 —— 该值变了 npm 层缓存自动失效;
# 若确认 Dockerfile 没动但想强制装最新版,用:
# docker compose build --no-cache
```

### 从旧布局升级

旧布局(≤ 1.3.0,实际存量即 1.3.0)的 compose 只挂一卷 `./data:/root/.pi`,
配置/数据/状态全平铺在该卷根(`pi-courier.json`、`pi-courier-matrix-*`、
`pi-courier-state/` 等)。新布局把桥的三根拆成独立卷,两种升级方式二选一:

**方式一(推荐,零手动搬动):继续用旧整卷,首启自动迁移**

直接换用新 compose 文件并重建容器(`docker compose up -d`)。`./data` 仍挂在
`/root/.pi`,桥首启自带的旧布局迁移器会把旧平铺文件自动搬进三个新卷:

- `pi-courier.json` → `./data/config/pi-courier.json`
- `pi-courier-matrix-store.json` → `./data/lib/matrix-store.json`
- `pi-courier-matrix-crypto/` → `./data/lib/matrix-crypto/`
- `pi-courier-attachments/` → `./data/lib/attachments/`
- `pi-courier-state/` 的五个叶子(心跳/审计/台账/快照/告警戳) → `./data/state/`

迁移是移动不是复制:正常迁移后旧平铺文件从 `./data` 根消失,只剩 `agent/`。
若某项目标位置已有新文件(新旧并存,比如手动搬过一半),桥信新家、旧文件原样
保留并警告一次;单项失败只警告不卡启动,下次启动自动重试。pi 的会话
(`./data/agent/`)原地不动。

**方式二:手动拆卷(想立刻得到干净布局时)**

```bash
cd deploy/docker
mkdir -p data/config data/lib data/state
mv data/pi-courier.json data/config/
mv data/pi-courier-matrix-store.json data/lib/matrix-store.json
mv data/pi-courier-matrix-crypto data/lib/matrix-crypto
mv data/pi-courier-attachments data/lib/attachments
mv data/pi-courier-state/* data/state/
rm -f data/pi-courier.lock
```

然后换新 compose 文件 `docker compose up -d`。注意叶子名去掉了 `pi-courier-`
前缀(如 `pi-courier-matrix-store.json` → `matrix-store.json`),搬错名字等同
没搬 —— 桥会把旧文件再迁一遍并警告新旧并存。

### 10. 映射宿主机项目目录(可选)

让 pi 在容器里直接操作宿主机上的代码:

1. compose 里取消注释 `- ./projects:/root/Projects`
2. 配置 `workdir` 指向容器内路径(`pi-courier setup` 的 workdir 填 `/root/Projects/<你的项目>`)
3. 宿主机代码放 `./projects/<你的项目>`,pi 的工作目录就是 `/root/Projects/<你的项目>`。

## 环境变量一键部署(推荐)

不碰 TUI、不 exec setup —— 所有配置走环境变量,`up -d` 后直接就绪。

### 1. 创建 .env(复制模板填真实值)

```bash
cp .env.example .env
nano .env     # 填:PI_MATRIX_HOMESERVER / PI_MATRIX_ACCESS_TOKEN / PI_LLM_API_KEY 等
```

> `.env` 含敏感信息(token/key),已被 gitignore,不要提交。

### 2. 启动即就绪

```bash
docker compose up -d
docker logs -f pi-courier
# 直接看到:✅ Matrix connected + ✅ pi RPC connected (model: ...) + 🚀 ready
```

### 支持的变量

| 变量 | 作用 | 必填 |
|---|---|---|
| `PI_MATRIX_HOMESERVER` | Matrix 服务器地址 | ✅(与 token 成对) |
| `PI_MATRIX_ACCESS_TOKEN` | Matrix bot token | ✅ |
| `PI_MATRIX_TRUSTED_USERS` | 预信任用户(逗号分隔 MXID,如 `@barry:matrix.purplelin.com`);不设则走验证码配对 | 可选 |
| `PI_MATRIX_ENCRYPTION` | E2EE 开关(`true`/`false`,默认 true) | 可选 |
| `PI_WORKDIR` | 工作目录(容器内路径,默认 /root/Projects) | 可选 |
| `PI_LLM_API_KEY` | LLM API key(auth.json 模板引用此变量) | ✅ |
| `PI_DEFAULT_PROVIDER` / `PI_DEFAULT_MODEL` | 默认 provider/模型(entrypoint 写入 settings.json) | 可选 |
| `PI_LOG_LEVEL` | 日志级别(debug/info/warn/error) | 可选 |
| `GH_TOKEN` | GitHub CLI token | 可选 |

**优先级**:环境变量 > 配置文件 > 交互向导。env 未设置时走原有流程(setup 向导),完全兼容。

## 常见问题

| 问题 | 解决 |
|---|---|
| 构建很慢 / 卡在下载 | 构建期网络问题,设 `export HTTPS_PROXY` 再 build |
| 启动显示 `model: unknown` | `./data/agent/auth.json` 没填 key,或用 pi TUI `/login` 配置 |
| 发消息没有回复 | 按顺序查:`docker logs` 看 Matrix 连接、pi RPC 连接、模型是否 unknown |
| 发消息后日志只有 `Challenge code`,没有回复 | 这是首次配对 —— 把 6 位验证码回复给 bot |
| `M_BAD_JSON: device_id does not match` | 重登录过,删 `./data/lib/matrix-crypto` 重启 |
| `One time key ... already exists`(M_UNKNOWN) | token 绑定旧设备且服务器 OTK 记账错位,删 store 无效 → **换 token**(setup 时"保留现有 token?"输 n 重新获取) |
| 加密房间解不开新消息 | bot 无交叉签名,改用非加密房间 |
| 会话重启丢失 | 0.1.1+ 自动 `--continue`,确认 `./data`(pi 会话)与 `./data/lib` 卷没被删 |
| 想用新配置 | 改 `./data/config/pi-courier.json` → `docker compose restart` |
| workdir 文件丢失(容器重建后) | 未映射 projects 卷;取消注释 `- ./projects:/root/Projects` |
