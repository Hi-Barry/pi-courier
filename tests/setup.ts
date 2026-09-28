import { setLocale } from "../src/i18n/index.js";

// 存量测试的中文断言以 zh 基准表为锚 —— 文案迁移语义 = 同一文案逐字进表,
// 断言值不变(issue #83)。i18n 自身的语言切换行为在 tests/i18n.test.ts。
setLocale("zh");
