# pi-courier — Matrix → pi 桥接服务
#
# 构建: docker compose build(只构建,不运行)
# 运行: docker compose up -d(见 docker-compose.yml 与 README.md)
#
# 说明:
#  - 基于 node:24-slim(避开 Node 20 与 pi 的 undici 不兼容问题;glibc 标准
#    环境保证 agent 的 bash 工具与宿主行为一致)
#  - 多阶段构建:builder 层装依赖后丢弃(npm 缓存/构建垃圾不进最终镜像),
#    runtime 只带 node_modules + 运行时工具 → 体积约省 200-300MB
#  - defaults/ 预置 LLM 三件套模板(entrypoint 首次启动自动拷贝到 /root/.pi/agent)
#  - 构建期间 npm 会从 GitHub Releases 下载 E2EE 原生库(约 21MB),
#    网络受限时用 --build-arg HTTPS_PROXY/HTTP_PROXY 传代理

# ============================== builder ======================================
FROM node:24-slim AS builder

ARG HTTPS_PROXY=
ARG HTTP_PROXY=
ENV https_proxy=${HTTPS_PROXY} \
    http_proxy=${HTTP_PROXY}

# 仅需要 ca-certificates(npm install 走 https;git 由 runtime 层负责)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 安装 pi 与 pi-courier(pi 先装,pi-courier 的 peer 依赖即满足);
# 安装后清 npm 缓存(此层最终不会进入 runtime 镜像)
RUN npm install -g @earendil-works/pi-coding-agent pi-courier \
    && npm cache clean --force

# ============================== runtime ======================================
FROM node:24-slim

ARG HTTPS_PROXY=
ARG HTTP_PROXY=
ENV https_proxy=${HTTPS_PROXY} \
    http_proxy=${HTTP_PROXY}

# 系统依赖:
#  - git:pi 的 bash 工具 / `pi install` 需要(slim 基础镜像没有)
#  - ca-certificates:HTTPS 证书
#  - curl:排查网络问题用(可选)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# 从 builder 只带 node_modules,然后在 runtime 重建 bin 符号链接
# (docker COPY 会把符号链接解引用成普通文件,导致相对 import 解析错误,
#  所以不能直接 COPY /usr/local/bin/pi)
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /usr/local/bin/pi \
    && ln -s /usr/local/lib/node_modules/pi-courier/dist/cli.js /usr/local/bin/pi-courier

# 验证安装(失败则构建失败)
RUN pi --version \
    && pi-courier help >/dev/null 2>&1 \
    && echo "OK: node $(node --version), pi + pi-courier installed"

# 默认配置模板 + 首次启动初始化脚本
COPY defaults/ /opt/pi-courier/defaults/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 进程存活检查:pid 1 即 entrypoint exec 的 pi-courier run 主进程(kill -0 无需额外工具)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD kill -0 1 || exit 1

# entrypoint:首次启动把模板拷进 /root/.pi/agent;随后前台运行主进程
ENTRYPOINT ["/entrypoint.sh"]
CMD ["pi-courier", "run"]
