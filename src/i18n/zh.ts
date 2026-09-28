/**
 * 中文文案表(基准表)。
 *
 * 红线(spec issue #83):
 *  • 本表逐字保留 0.2.x 的历史文案 —— 存量中文用户体验零变化,tests/ 下
 *    的中文断言以它为锚;
 *  • MessageKey 由本表定义,en.ts 以 Record<MessageKey, string> 对齐,
 *    两表缺 key/多 key 都是编译错误;
 *  • 插值占位符 {name},由 t() 替换;文案里不要出现字面 { }(现网无此文案)。
 */
const zh = {
  // ── common ────────────────────────────────────────────────────────────
  "common.cancel": "取消",
  "common.on": "开",
  "common.off": "关",

  // ── cmd(/命令回复,command-map.ts)── 样板;票2 全量迁移 ─────────────
  "cmd.new.ok": "✅ 已开始新会话",
  "cmd.new.cancelled": "⚠️ 新会话被扩展取消",
  "cmd.generic.error": "❌ 命令执行失败: {message}",

  // ── startup(语言配置可见性;语言功能自身的一部分,破例双语)─────────
  "startup.language.system":
    "language: {locale}(检测自系统 locale;如需固定,请在 ~/.pi/pi-courier.json 配置 \"language\" 或设 PI_LANGUAGE)",
  "startup.language.default":
    "language: {locale}(默认值;如需固定,请在 ~/.pi/pi-courier.json 配置 \"language\" 或设 PI_LANGUAGE)",
} as const;

export type MessageKey = keyof typeof zh;
export default zh;
