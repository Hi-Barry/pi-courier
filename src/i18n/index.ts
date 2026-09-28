/**
 * i18n core (issue #83) — process-wide locale + the `t()` message lookup.
 *
 * 设计红线:
 *  • 本模块不 import src/ 任何其他文件(零循环依赖);零第三方运行时依赖。
 *  • 全局单例风格与 logger.ts 一致:启动时(setup 向导 / standalone / cli)
 *    setLocale 一次,此后所有文案读取走 t()。语言运行中不热切换,与
 *    multiProject 同语义(重启生效)。
 *  • zh.ts 是基准表(定义 MessageKey);en.ts 以 Record<MessageKey, string>
 *    对齐 —— 两表漂移在 typecheck 阶段即失败。
 *  • 测试隔离:tests/setup.ts 全局 setLocale("zh") 以对齐存量中文断言。
 */
import en from "./en.js";
import zh, { type MessageKey } from "./zh.js";

export type { MessageKey } from "./zh.js";

export type Locale = "zh" | "en";

let current: Locale = "en";

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** `undefined`/`null` are allowed and render as "undefined"/"null" — identical
 *  to what a plain template string printed before the i18n migration
 *  (spawnSync's exit code is `number | null`, e.g.). */
export type MsgParams = Record<string, string | number | null | undefined>;

/**
 * Look up a message in the active locale's table. `{name}` placeholders are
 * replaced from `params`; a missing param leaves the placeholder as-is
 * (fail-visible beats silently empty). Keys are compile-time checked
 * (`MessageKey`): a typo'd key fails typecheck, so there is no unknown-key
 * runtime fallback path by design.
 */
export function t(key: MessageKey, params?: MsgParams): string {
  const template: string = current === "zh" ? (zh[key] as string) : en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match
  );
}
