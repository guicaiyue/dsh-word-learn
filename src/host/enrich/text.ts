// enrich/text.mjs —— enrich 子模块共用的纯文本函数。
//
// 从 ai-enrich.mjs 拆出来的（2026-11-05，原文件超 CODE_BUDGET）。
// 放在最底层：analysis / sense / quiz 都能引，且这里不 import 任何业务模块，保证没有环。

export function contains(a: unknown, b: unknown): boolean {
  const x = String(a || '').replace(/\s+/g, '')
  const y = String(b || '').replace(/\s+/g, '')
  return !!x && !!y && x.includes(y)
}

/** 把 "n. 决心\nv. 解析" 这样的释义文本拆成条目。 */
export function splitTranslation(text: unknown): string[] {
  if (!text) return []
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Fisher-Yates 洗牌。 */
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
