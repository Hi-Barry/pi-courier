# pi-courier Docker 部署说明

在 VPS 上用 Docker 部署 pi-courier(Matrix → pi 桥接服务)。

## 目录结构

```
pi-courier/            # 本目录(deploy/docker 的上一级)
├── Dockerfile
├── docker-compose.yml
├── data/              # 自动创建:容器 ~/.pi(配置/会话/加密存储)
└── projects/          # 可选:映射宿主机项目目录
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
# 获取项目文件(任选其一)
git clone https://github.com/Hi-Barry/pi-courier.git && cd pi-courier/deploy/docker
# 或手动上传 Dockerfile + docker-compose.yml
```

### 2. 构建并启动

```bash
# 如果 VPS 需要代理访问外网(GitHub 下载 21MB E2EE 库),先导出:
# export HTTPS_PROXY=http://<host>:<port>
# export HTTP_PROXY=http://<host>:<port>

docker compose up -d --build
docker ps                # 确认 pi-courier 容器 running
docker logs pi-courier   # 查看启动日志
```

### 3. 首次配置(向导)

```bash
# 容器运行后,进入交互向导(和本机一样,逐步输入)
docker exec -it pi-courier pi-courier setup
```

向导写入容器内 `/root/.pi/pi-courier.json`(宿主 `./data/pi-courier.json`)。

> 也可以不用向导:直接在宿主 `./data/` 下创建 `pi-courier.json` 和 `agent/` 目录(对应容器 `/root/.pi/`),格式见项目 README FAQ。

### 4. 使用

- 给 bot 发消息 → 查看验证码: `docker logs pi-courier` → 回复验证码配对
- 查看日志: `docker logs -f pi-courier`(或 `docker exec pi-courier pi-courier logs --level debug`)
- 重启: `docker compose restart`
- 停止: `docker compose down`(数据保留在 ./data)

### 5. 升级

```bash
# 方式 A:容器内自更新(npm 全局方式)
docker exec pi-courier pi-courier update

# 方式 B:重建镜像
git pull && docker compose build --no-cache && docker compose up -d
```

### 6. 映射宿主机项目目录(可选)

让 pi 在容器里直接操作宿主机上的代码:

1. compose 里取消注释 `- ./projects:/root/Projects`
2. 配置 `workdir` 指向容器内路径:

```bash
docker exec -it pi-courier pi-courier setup   # workdir 填 /root/Projects/<你的项目>
# 或直接改 ./data/pi-courier.json 的 workdir 后 docker compose restart
```

宿主机代码放 `./projects/<你的项目>`,pi 的工作目录就是 `/root/Projects/<你的项目>`。

## 常见问题

| 问题 | 解决 |
|---|---|
| 构建很慢 / 卡在下载 | 构建期网络问题,设 `export HTTPS_PROXY` 再 build |
| `M_BAD_JSON: device_id does not match` | 重登录过,删 `./data/msg-bridge-matrix-crypto` 重启 |
| 加密房间解不开新消息 | bot 无交叉签名,改用非加密房间 |
| 会话重启丢失 | 0.1.1+ 自动 `--continue`,确认 `./data` 卷没被删 |
| 想用新配置 | 改 `./data/pi-courier.json` → `docker compose restart` |
