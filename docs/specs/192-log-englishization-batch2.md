# Spec #192:日志英化批次2——其余文件的中文运行时日志

> issue: https://github.com/Hi-Barry/pi-courier/issues/192

## 问题陈述(Problem Statement)

0.3.4 已把 message-router 的事件日志全量英化,但服务日志整体仍中英混杂:英文用户翻服务日志时,启动提示、项目进程启停、空间/管理房创建、登录、房间品牌、pmctl 供给、扩展提问等路径的日志仍是中文硬编码。日志是排障的第一现场,中英混杂让非中文用户无法检索,也让日志分析工具难以统一口径。

issue 原文的 6 文件清单是 0.3.4 时点的快照,此后代码库又长出了 pmctl 供给、collab 登记簿、房间品牌维护等新模块——本批按**全仓扫描**的真实清单做,一次扫干净。

## 解决方案(Solution)

把 `src/` 下所有**字面中文**的运行时日志串(logger.info/warn/error/debug 与注入 log/warn 缝的字面串)统一改为字面英文,沿用 0.3.4 批次(f2b07ad)的先例:

- 只翻字面中文;i18n 驱动的日志(`t("migration.*")` 等,随 locale 变化是既有设计)不动。
- 保留 `[tag]` 前缀、emoji、模板插值、日志级别、调用点与触发条件——只换语言。
- 注释(含引用日志文案的 JSDoc)不动;回帖文案(i18n 双表)不动。

全仓扫描口径(本批验收基线):`grep -P "[\x{4e00}-\x{9fff}]"` 过滤 logger 调用行后,`src/` 应为**零命中**(i18n/ 目录与注释除外)。真实清单:17 文件、68 行。

## 用户故事(User Stories)

1. 作为英文用户,我希望服务日志全部是英文,这样我能直接搜索关键词排障。
2. 作为运维,我希望日志口径统一(不中英混杂),这样 grep/告警规则不用写两套。
3. 作为中文用户,我希望中文回帖不受影响——服务日志与 bot 说话的语言本就分离。
4. 作为维护者,我希望沿用 0.3.4 先例(字面英文、保留 tag/emoji/插值),不引入第二套日志语言机制。
5. 作为维护者,我希望 i18n 驱动的日志(migration 等)保持 locale 行为不变,不误伤既有设计。
6. 作为排障者,我希望日志级别、触发条件、错误对象插值一个不变——本批是纯文案替换。
7. 作为 CI,我希望全量门禁兜底:任何钉住中文日志的测试断言同步更新后全绿。
8. 作为后续贡献者,我希望日志英化后新代码不再有「日志该写中文还是中文」的歧义——英文是唯一口径。

## 实现决策(Implementation Decisions)

- **范围锁定为字面中文日志串**:logger.info/warn/error/debug 直调与注入缝(log/warn 参数)收到的字面串;`t()` 包裹的日志键一律不动。
- **翻译风格沿 0.3.4**:`[agent] run started` 式短句、现在时、保留既有 tag(`[space]`/`[identity]`/`[pmctl]`/`[xq]` 等)与 emoji;中文括注(如「(跳过,下次启动自动重试)」)译为等义英文括注(`(skipped, retried on next startup)`)。
- **不新增 i18n 键、不改日志调用结构、不新增配置**:纯字符串替换;模块边界、函数签名零变化。
- **不动 matrix-events.ts**:全仓扫描证实其已无中文日志(issue 清单过时,附件日志已随重构他迁)。
- **已知唯一测试同步点**:legacy-migration 的日志断言钉的是 i18n 键文案(中文 locale),不属字面串,不动;其余若有断言钉了字面中文日志,随实现同步(全量门禁兜底)。

## 测试决策(Testing Decisions)

- 本批不新增行为,测试面 = 存量回归:全量门禁按 package.json 原样跑(`npm run typecheck`/`lint`/`test`/`build`)。
- 验收用扫描口径代替新测试:logger 调用行的中文字符 grep 归零(逐文件核对,注释与 i18n/ 除外);该口径写进 PR Evidence。
- 0.3.4 先例(f2b07ad):同性质的纯文案批未加 meta 测试,本批沿用——扫描口径一次性验证,不做常驻 grep 测试。

## 不做(Out of Scope)

- i18n 驱动的日志键(`migration.*`、`startup.preset.*`、`proxy.active` 等)的语言策略——它们随 locale 是既有设计,是否「日志固定英文」另行决策。
- 回帖/卡片文案、README、docs、代码注释的语言。
- 日志结构化(tag 体系重构、级别调整、log-filter 语义)。
- 历史发行说明与 CHANGELOG 的语言。

## 进一步说明(Further Notes)

- 扫描命令(验收基线):`grep -rn "logger\.\|\.log\.\|log\.\(info\|warn\|error\|debug\)" src/ --include="*.ts" | grep -P "[\x{4e00}-\x{9fff}]" | grep -v "^src/i18n"` → 期望零行(注释行人工复核)。
- 0.3.4 先例提交:f2b07ad(message-router 日志全英化)。
