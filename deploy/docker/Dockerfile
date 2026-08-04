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
#  - 首次配置(LLM 三件套 + Matrix)见同目录 README.md,务必先配 LLM

FROM node:24-slim

# 构建期代理(可选,仅当 VPS 需要代理访问外网时)
ARG HTTPS_PROXY=
ARG HTTP_PROXY=
ENV https_proxy=${HTTPS_PROXY} \
    http_proxy=${HTTP_PROXY}

# 系统依赖:
#  - git:pi 的 bash 工具 / `pi install` 需要(slim 基础镜像没有)
#  - ca-certificates:HTTPS 证书(下载/校验需要)
#  - curl:排查网络问题用(可选)
# (apt 请求也走上面的代理 ENV,受限网络下可代理)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# 安装 pi 与 pi-courier(pi 先装,pi-courier 的 peer 依赖即满足)
RUN npm install -g @earendil-works/pi-coding-agent pi-courier \
    && pi --version \
    && pi-courier help >/dev/null 2>&1 \
    && echo "node $(node --version), pi and pi-courier installed OK"

# 数据卷:配置 + 会话 + 加密存储(全部在容器内 ~/.pi)
VOLUME ["/root/.pi"]

# 进程存活检查:pid 1 即 pi-courier run 主进程(kill -0 无需额外工具)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD kill -0 1 || exit 1

# 前台运行(容器主进程;Ctrl+C/SIGTERM 优雅关闭)
CMD ["pi-courier", "run"]
