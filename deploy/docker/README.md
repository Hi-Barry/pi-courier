# pi-courier Docker 部署说明

在 VPS 上用 Docker 部署 pi-courier(Matrix → pi 桥接服务)。

## 目录结构

```
deploy/docker/
├── Dockerfile            # 镜像构建(装 pi + pi-courier + 默认配置模板)
├── docker-compose.yml    # 编排(数据卷 ./data ↔ 容器 /root/.pi)
├── entrypoint.sh         # 首次启动:自动把默认配置模板拷入数据目录
├── defaults/             # 模板源(构建进镜像 /opt/pi-courier/defaults/)
│   └── agent/
│       ├── models.json   # 完整模型数据(24 模型,开箱即用)
│       ├── auth.json     # API key 占位(唯一需要你填的文件)
│       └── settings.json # 默认 provider + 模型
└── data/                 # 运行时数据(自动创建;含 key/token,已 gitignore)
    └── agent/            # 首次启动自动从模板填充
```

## 部署步骤

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

### 2. 构建(只构建,不运行)

```bash
# 如果 VPS 需要代理访问外网(GitHub 下载 21MB E2EE 库),先导出:
# export HTTPS_PROXY=http://<host>:<port>
# export HTTP_PROXY=http://<host>:<port>

docker compose build
```

### 3. 配置(只需填 API key)

首次启动会自动把模板拷入 `./data/agent/`。先启动一次容器完成初始化,再填 key:

```bash
docker compose up -d        # 启动(entrypoint 自动初始化 ./data/agent/)
docker exec pi-courier ls /root/.pi/agent   # 确认模板已拷入
```

然后编辑宿主 `./data/agent/auth.json`,把占位的 `sk-你的key` 换成真实 API key:

```bash
# data/agent/auth.json
{ "opencode-go": { "type": "api_key", "key": "sk-真实key" } }
```

> 默认 provider 是 `opencode-go` / `deepseek-v4-flash`(settings.json)。用其他 provider 的话,改 settings.json 并确认 models.json 里有对应模型。

### 4. Matrix 配置(向导)

```bash
docker exec -it pi-courier pi-courier setup
```

按提示输入:homeserver → token(密码登录或粘贴)→ 信任用户 → E2EE → workdir。写入容器内 `/root/.pi/pi-courier.json`(宿主 `./data/pi-courier.json`)。

```bash
docker compose restart      # 让 Matrix 配置生效
docker logs pi-courier      # 应看到 ✅ Matrix connected + ✅ pi RPC connected (model: deepseek-v4-flash)
```

### 5. 使用

- 给 bot 发消息 → 查看验证码: `docker logs pi-courier` → 回复验证码配对
- 查看日志: `docker logs -f pi-courier`(或 `docker exec pi-courier pi-courier logs --level debug`)
- 重启: `docker compose restart`
- 停止: `docker compose down`(数据保留在 ./data)

### 6. 升级

```bash
# 方式 A:容器内自更新(npm 全局方式)
docker exec pi-courier pi-courier update

# 方式 B:重建镜像
git pull && docker compose build && docker compose up -d
```

### 7. 映射宿主机项目目录(可选)

让 pi 在容器里直接操作宿主机上的代码:

1. compose 里取消注释 `- ./projects:/root/Projects`
2. 配置 `workdir` 指向容器内路径(`docker exec -it pi-courier pi-courier setup` 的 workdir 填 `/root/Projects/<你的项目>`)
3. 宿主机代码放 `./projects/<你的项目>`

## 常见问题

| 问题 | 解决 |
|---|---|
| 构建很慢 / 卡在下载 | 构建期网络问题,设 `export HTTPS_PROXY` 再 build |
| 启动显示 `model: unknown` | `./data/agent/auth.json` 没填 key,或 settings.json 的模型不在 models.json |
| 发消息没有回复 | 按顺序查:`docker logs` 看 Matrix 连接、pi RPC 连接、模型是否 unknown |
| `M_BAD_JSON: device_id does not match` | 重登录过,删 `./data/msg-bridge-matrix-crypto` 重启 |
| 加密房间解不开新消息 | bot 无交叉签名,改用非加密房间 |
| 会话重启丢失 | 0.1.1+ 自动 `--continue`,确认 `./data` 卷没被删 |
| 想用新配置 | 改 `./data/pi-courier.json` → `docker compose restart` |
| workdir 文件丢失(容器重建后) | 未映射 projects 卷;取消注释 `- ./projects:/root/Projects` |
