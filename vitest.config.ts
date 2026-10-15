import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  test: {
    // dist 显式排除(issue #188):CI 步骤是 build → test,dist 里若混入
    // 编译后的 *.test.js 会被 vitest 收集,同一用例双跑、计数虚高。
    // tsconfig exclude 已从源头拦住编译,这里是双保险。
    exclude: [...defaultExclude, "**/dist/**"],
    // 全局 setLocale("zh"):存量测试的中文断言以 zh 基准表为锚,
    // 文案迁移语义 = 同一文案逐字进表,断言值不变(issue #83)。
    setupFiles: ["./tests/setup.ts"],
  },
});
