# Spec #344:状态脚注与 /model 回执带厂商前缀

> issue: https://github.com/Hi-Barry/pi-courier/issues/344

## 问题陈述(Problem Statement)

回复末尾的状态脚注只显示模型名,例如 `🤖 DeepSeek V4.1 Flash 1017·high`。同名或相近名的模型可能来自不同 provider(自建网关、官方 API、聚合平台),只有模型名时用户无法判断当前实际走的是哪个厂商。`/model` 切换成功后的回执同样只显示模型 id(`✅ 已切换模型: glm-5.3`),把用户刚输入或选中的 provider 丢掉了。

## 解决方案(Solution)

1. 状态脚注的模型段改为 `provider/name·thinking`,例如 `🤖 zai/GLM-5.3·high`。
2. `/model` 切换回执改为 `provider/id`,例如 `✅ 已切换模型: zai/glm-5.3`。

两处都与仓库既有的 `provider/...` 展示口径一致(`/status`、`/cyclemodel`、`/models` 列表、项目欢迎语)。

## 用户故事(User Stories)

1. 作为 Matrix 里的桥用户,我希望任务完成后的状态脚注带上 provider,这样我能确认回复来自哪个厂商。
2. 作为切换模型的用户,我希望 `/model provider/model` 的回执保留 provider,这样我能核对实际生效的配置。
3. 作为使用自建 provider 的用户,我希望脚注显示 provider id(如 `new-provider-2`),因为同一个模型名可能挂在多个网关下。
4. 作为维护者,我希望展示口径与 `/status`、`/cyclemodel` 一致,不新增第二套格式。
5. 作为取数降级的用户,我希望上游缺 provider 时脚注仍只显示模型名,不出现孤零零的 `/`。
6. 作为只提供模型 id 的旧会话,我希望脚注仍能正常显示 id,行为不倒退。

## 实现决策(Implementation Decisions)

- 状态脚注的模型标签在现有 `name || id` 回落之上再加一层:provider 存在时拼成 `provider/name`(name 缺失用 id),provider 缺失时保持原样。思考等级仍以 `·level` 直连,不额外加分隔符。
- `/model` 切换回执不再优先使用 `setModel` 返回的裸 id,而是拼 `provider/id`;返回对象缺字段时回落到命令参数里的 `applied.provider` / `applied.id`(保持对测试替身与上游字段缺失的容错)。
- 不改 `/model` 的解析、`setModel` 调用、i18n 键与文案模板;只改传入模板的值。
- 不改 `/status`、`/cyclemodel`、`/models`、项目欢迎语——它们已经带 provider。
- 不改 `StatusFooterInfo.model` 的类型与 `appendStatusFooter` 的拼接形状(仍是三段 ` · ` 行)。

## 测试决策(Testing Decisions)

- 只测外部行为:给定 `getState` 返回的模型形状,`collectStatusFooter` 产出的模型段字符串。
- `tests/status-footer.test.ts`:happy path 的假模型补上 provider,断言 `provider/name·high`;保留无 provider 的用例,断言仍为 `name·high`(降级钉)。
- `/model` 回执:在现有命令测试里补断言,确认回执含 `provider/id`。若没有现成的 `/model` 成功路径用例,新增一个最小 router 用例,用带状态化模型的 fake rpc 驱动。
- 回归命令按 package.json 原样:`npm test`、`npm run typecheck`、`npm run lint`。

## 不做(Out of Scope)

- 不引入 provider 展示名查询(上游 `getProviderDisplayName` 不在 RPC 面上);显示 provider id。
- 不改模型名本身、不做名称截断或折行策略。
- 不改任何命令行为、配置格式或 i18n 双表。
