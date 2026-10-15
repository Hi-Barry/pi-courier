# AGENTS.md

## 项目

pi-courier —— 通过 Matrix 远程使用 [pi coding agent](https://pi.dev)(基于 RPC 协议)。

- npm:`pi-courier`(公开);GitHub:`Hi-Barry/pi-courier`(公开,MIT)
- 源码入口:`src/standalone.ts`(运行时)、`src/cli.ts`(CLI)、`src/rpc/`(RPC 客户端层)、`src/setup.ts`(配置向导)
- 构建:`npm run build`(clean + tsc)| 测试:`npm run test` | lint:`npm run lint` | typecheck:`npm run typecheck`(主配置 + tsconfig.test.json 双配置)
- 发布流程:develop 测试验收通过 → 合回 master → `npm version` → git push --tags → `npm publish` → 大版本发版补建锚点分支(见下方分支纪律)

## 分支纪律(硬约束,2026-10-14 起)

> 任何 Git 操作不得违反本节;与上文冲突时以此为准。

- **冻结分支**:`master` 与大版本锚点分支(如 `1.0.0`)不许直接提交或推送;master 只在发版时被合入。
- **集成分支 `develop`**:一切日常提交与 PR 合并只进 `develop`(从 master 最新提交分出);开 PR 的 base 一律选 `develop`,不许直接开向 master。
- **发版才回 master**:`develop` 上的内容经测试验收、决定发版时,才把 `develop` 合回 `master` 并打 tag、发 npm。注意:PR 合进 develop 不会自动关 issue(`Fixes #N` 只对默认分支生效),发版合回 master 时才收口关票。
- **大版本锚点**:每次 x.y.0 形态发版(minor/major,如 1.1.0、1.2.0、2.0.0)在发版提交上建同名锚点分支,永久保留;patch 版本(如 1.0.1)不建锚点。

## 核心规则

**任何更新内容(代码、文档、配置、发布、踩坑、决策)都必须增量写入 `docs/DEVLOG.md`**,保持开发日志与项目同步,便于日后回顾。

- DEVLOG.md 是**私人文档,已被 .gitignore 忽略,不要推送、不要发布**
- 每次改动完成后,在 DEVLOG.md 相应章节追加一行记录(版本、改动内容、原因);新版本发布时更新"版本演进"表和"当前状态"
- 新增踩坑时,追加到"踩坑全记录"对应主题下
- 未决事项变化时,更新"未决事项 / TODO"节

## 文档约定

- 公开文档(README.md / README.zh-CN.md / docs/DEVELOPMENT.md)必须与实测一致,中英双语同步
- `docs/DEVLOG.md` 是完整开发日志,公开文档是面向用户的精简版
