# Spec #348:doctor 检查↔修复注册表收口——fix 挂 entry、id 单点

> 来源:架构评审 2026-11-16 卡8(Worth exploring)。趁 #337 刚落地、fix 动作只有 6 个时收最便宜。

## Problem Statement

一个检查 id(如 "C3")的权威性分散在三个文件:`CheckGroup` 与 `ALL_GROUPS` 双列组字母、`collectFixActions` 用裸字符串门槛关联修复(`failing.has("B1")`、`resultOf(report, "C3")?.severity === "warn"`)、修复工厂内部再硬编码同一批 checkId。C3 的 severity 从 warn 改成 fail,修复门槛**静默失配**(修复悄悄不再触发),编译器不报。加一组新检查要动 4-5 处。

## Solution

- **fix 挂进检查项**:`DoctorCheckEntry` 加可选 `fix` 字段——`{ on: "fail" | "warn"; make(ctx) => 动作体 }`,触发档位与检查产出在同一处声明;`collectFixActions` 从 entries 派生(签名 `(ctx, report)` 不变,shell/测试零改动),`checkId` 统一改写为 `entry.id`(工厂字面量不再是权威)。
- **组字母单点**:`types.ts` 导出 `CHECK_GROUPS` 常量数组,`CheckGroup` 类型从数组派生;`run.ts` 的 `ALL_GROUPS` 改用。
- **组内 id 收口**:B/C/D/H 四组文件顶部 `ID` 常量表(`as const`),文件内 id 字面量全部换常量引用;id 拼错变编译错误。

## User Stories

1. As a 维护者, I want 修复动作与触发档位声明在检查项同一处, so that severity 改档时修复门槛不可能静默失配
2. As a 维护者, I want checkId 以 entry.id 为唯一权威, so that 工厂写错 checkId 不可能
3. As a 维护者, I want 组字母只在一处列全, so that 加组不漏改
4. As a 维护者, I want 组内 id 拼错变编译错误, so that 报告 id/修复关联/--only 锚点不漂移
5. As a doctor 用户, I want --fix 行为逐字节不变, so that 收口零行为回归

## Implementation Decisions

- `DoctorCheckEntry.fix?: { on: "fail" | "warn"; make: (ctx) => Promise<FixActionBody | undefined> | FixActionBody | undefined }`;`FixActionBody = { summary; run }`(fix.ts 新类型,FixAction 保留 checkId 供执行器/薄壳)。
- 修复工厂(fixes-cd.ts 五个 + checks-b 的 staleCliPathFix)改返回 `FixActionBody`,不再自带 checkId;`mkdirOrChmodDirFix` 参数从 `"D1"|"D2"` 改为 `target: "stateDir" | "dataDir"`(dir 选择语义,与 id 解耦)。
- `collectFixActions` 重写:遍历 entries → 有 fix → 报告中该 id 结果 severity === fix.on → make → `{ checkId: entry.id, ...body }`。async/同步 make 统一 await。
- checks.ts 不再 import 修复工厂(改由 checks-b/c/d 自行 import fixes-cd/staleCliPathFix);依赖方向 doctor 目录内静态 import,不碰红线。
- types.ts 的 FixAction 类型引用用 **type-only import**(fix.ts 反向 import types.ts 的 toMessage——type-only 编译期擦除,不构成运行时循环,依赖红线指运行时静态依赖)。
- B1 fix:`on: "fail"`(现 failing.has("B1") 语义);C3/D1/D2/D3/D4/D5:`on: "warn"`。
- shell.ts / 4 个 doctor 测试文件的 `collectFixActions(ctx, report)` 调用签名不变。

## Testing Decisions

- 既有 doctor 测试(doctor-fix/doctor-config-state/doctor-install-disk-pi/doctor-network-service/doctor)全数保持通过——它们经 collectFixActions 公共接口测,直接覆盖派生路径。
- 新增:①fix 派生的门槛语义(报告 warn 触发 / fail 触发 / 不触发);②checkId 恒等于 entry.id(工厂字面量失配也无法漂移);③D1/D2 按 target 选目录。
- 先行样本:tests/doctor-fix.test.ts 的 harness。

## Out of Scope

- A/E/F/G 组的组内 id 字面量收口(不在评审证据内,后续需要时再收)
- --only / id 解析等新功能
- 任何报告文案或退出码行为变化

## Further Notes

- 加新检查触点:新 checks-x.ts + checks.ts 一行注册 + types.ts 组字母数组 + i18n 双表(原 4-5 处)。
