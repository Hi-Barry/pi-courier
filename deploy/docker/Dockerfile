# pi-courier — Matrix → pi 桥接服务
#
# 构建: docker build -t pi-courier .
# 运行: docker compose up -d --build(见 docker-compose.yml)
#
# 说明:
#  - 基于 node:24(避开 Node 20 与 pi 的 undici 不兼容问题)
#  - 全局安装 pi(peer 依赖)+ pi-courier
#  - 构建期间 npm 会从 GitHub Releases 下载 E2EE 原生库(约 21MB),
#    如果 VPS 网络受限,用 --build-arg HTTPS_PROXY/HTTP_PROXY 传代理

FROM node:24-slim

# 构建期代理(可选,仅当 VPS 需要代理访问外网时)
ARG HTTPS_PROXY=
ARG HTTP_PROXY=
ENV https_proxy=${HTTPS_PROXY} \
    http_proxy=${HTTP_PROXY}

# 安装 pi 与 pi-courier
RUN npm install -g @earendil-works/pi-coding-agent pi-courier \
    && pi --version \
    && pi-courier help >/dev/null 2>&1 \
    && echo "node $(node --version), pi and pi-courier installed OK"

# 数据卷:配置 + 会话 + 加密存储(全部在容器内 ~/.pi)
VOLUME ["/root/.pi"]

# 进程存活检查(pi-courier run 前台运行)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD pgrep -f "dist/standalone.js" >/dev/null || exit 1

# 前台运行(容器主进程;Ctrl+C/SIGTERM 优雅关闭)
CMD ["pi-courier", "run"]
