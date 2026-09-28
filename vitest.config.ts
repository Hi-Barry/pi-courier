import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 全局 setLocale("zh"):存量测试的中文断言以 zh 基准表为锚,
    // 文案迁移语义 = 同一文案逐字进表,断言值不变(issue #83)。
    setupFiles: ["./tests/setup.ts"],
  },
});
