# AGENTS.md

## 项目

pi-courier —— 通过 Matrix 远程使用 [pi coding agent](https://pi.dev)(基于 RPC 协议)。

- npm:`pi-courier`(公开);GitHub:`Hi-Barry/pi-courier`(公开,MIT)
- 源码入口:`src/standalone.ts`(运行时)、`src/cli.ts`(CLI)、`src/rpc/`(RPC 客户端层)、`src/setup.ts`(配置向导)
- 构建:`npm run build`(clean + tsc)| 测试:`npm run test` | lint:`npm run lint` | typecheck:`npm run typecheck`(主配置 + tsconfig.test.json 双配置)
- 发布流程:文档同步(见"文档约定")→ `npm version patch` → git push --tags → `npm publish`

## 核心规则

**任何更新内容(代码、文档、配置、发布、踩坑、决策)都必须增量写入 `docs/DEVLOG.md`**,保持开发日志与项目同步,便于日后回顾。

- DEVLOG.md 是**私人文档,已被 .gitignore 忽略,不要推送、不要发布**
- 每次改动完成后,在 DEVLOG.md 相应章节追加一行记录(版本、改动内容、原因);新版本发布时更新"版本演进"表和"当前状态"
- 新增踩坑时,追加到"踩坑全记录"对应主题下
- 未决事项变化时,更新"未决事项 / TODO"节

## 文档约定

**每次更新或发版,相关文档必须跟着一起更新,不许只改代码不动文档;文档滞后视为本次改动没有完成。**

- 公开文档(README.md / README.zh-CN.md / docs/DEVELOPMENT.md)必须与实测一致,中英双语同步
- `docs/DEVLOG.md` 是完整开发日志,公开文档是面向用户的精简版
- 动手改代码前,先搜一遍文档里有没有提到本次要动的东西,提到了就连着一起改:
  - `README.md` / `README.zh-CN.md`:功能、命令、配置、默认值、示例等用户可见的变化,中英两份同步改
  - `docs/DEVELOPMENT.md`:架构、协议、设计决策、新版本特性,补进对应章节(目录和版本相关段落一并对齐)
  - `docs/DEVLOG.md`:按"核心规则"无条件追加记录
  - `docs/agents/issue-tracker.md`:票状态变化时同步
- 发版前最后一道检查:上述文档和"版本演进"等版本锚点再对一遍,确认没有漏更,才推 tag、publish
