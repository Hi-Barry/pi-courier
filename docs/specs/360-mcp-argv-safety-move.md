# Spec #360:/mcp 的上游 argv 镜像入籍——src/mcp/argv-safety.ts + 哨兵集中 pi-rpc COMPAT 层

> 来源:架构评审 2026-11-16 卡9(Speculative)。纯搬家无行为变化。

## Problem Statement

pi-rpc 已立"上游私有行为单一住处"的规矩(COMPAT 层,834-967:"上游重构时只查这里"),但 /mcp 的 argv 语义镜像(MCP_ADD_VALUED_FLAGS + scanMcpAddArgv + redactMcpSecrets,约 130 行)住在 command-map——这是**安全载荷**(密钥不泄漏依赖对上游解析器行为的持续镜像,连续 5 个修复工单都在加精度);上游错误哨兵分居两文件(command-map 与 pi-rpc 各持一份)。"我们对 pi 私有行为做了哪些假设"要全仓 grep。

## Solution

- **镜像迁入 `src/mcp/argv-safety.ts`**(pi CLI 执行缝的自然邻居):MCP_ADD_VALUED_FLAGS、McpAddScan、pushSecretFragments、collectValueSecrets、scanMcpAddArgv、redactMcpSecrets 整体迁移,导出 scanMcpAddArgv/redactMcpSecrets(注释与其引用的上游行号同步保留)。
- **哨兵集中 pi-rpc COMPAT 层**:`UPSTREAM_ALREADY_COMPACTED` 迁至 pi-rpc 与 `UPSTREAM_TIMEOUT_SENTINEL` 同段并导出(后者改 export);command-map 改引用。
- command-map 只留 case 分派与文案。

## User Stories

1. As a 维护者, I want 上游 argv 镜像与 COMPAT 层互相指路, so that 上游改版影响面单点审计
2. As a 维护者, I want 下一轮泄漏路径修复只动一个文件, so that 安全修复有 locality
3. As a 桥用户, I want 行为零变化, so that 纯搬家零回归

## Implementation Decisions

- 纯搬家:函数体逐字节不变;导出面按引用需要(scan/redact 两个公共名);command-map 引用改 import。
- 哨兵搬家后 pi-rpc 是"上游私有行为"的唯一住处(argv 镜像在 mcp 域但头注释互相指路)。

## Testing Decisions

- command-map-mcp.test.ts 全量既有用例零改动通过(脱敏/连写/冒号切割等安全语义全被钉住)。

## Out of Scope

- 任何脱敏规则/flag 清单变更
- (顺带)#358 spec 措辞修正两处("六个 preAuth 命令族"→"六个命令族阶段";normalizeDetailLine 归属决议反转补记)——补评可选条目落实
