# AGENTS.md

## 项目

pi-courier —— 通过 Matrix 远程使用 [pi coding agent](https://pi.dev)(基于 RPC 协议)。

- npm:`pi-courier`(公开);GitHub:`Hi-Barry/pi-courier`(公开,MIT)
- 源码入口:`src/standalone.ts`(运行时)、`src/cli.ts`(CLI)、`src/rpc/`(RPC 客户端层)、`src/setup.ts`(配置向导)
- 构建:`npm run build`(clean + tsc)| 测试:`npm run test` | lint:`npm run lint` | typecheck:`npm run typecheck`(主配置 + tsconfig.test.json 双配置)
- 发布流程:`npm version patch` → git push --tags → `npm publish`

## 核心规则

**任何更新内容(代码、文档、配置、发布、踩坑、决策)都必须增量写入 `docs/DEVLOG.md`**,保持开发日志与项目同步,便于日后回顾。

- DEVLOG.md 是**私人文档,已被 .gitignore 忽略,不要推送、不要发布**
- 每次改动完成后,在 DEVLOG.md 相应章节追加一行记录(版本、改动内容、原因);新版本发布时更新"版本演进"表和"当前状态"
- 新增踩坑时,追加到"踩坑全记录"对应主题下
- 未决事项变化时,更新"未决事项 / TODO"节

## 文档约定

- 公开文档(README.md / README.zh-CN.md / docs/DEVELOPMENT.md)必须与实测一致,中英双语同步
- `docs/DEVLOG.md` 是完整开发日志,公开文档是面向用户的精简版
