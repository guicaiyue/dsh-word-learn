// http.mjs —— 路由层的小工具：查询参数读值与钳制。
//
// 为什么单独立一个模块：同一句
//   `Math.min(max, Math.max(min, Number(url.searchParams.get('x')) || fallback))`
// 在 index.js 里手写过 6 遍，每遍的上下限还不一样（列表 200/500、标注 1/5000、
// 看板 14 天、回顾 5 条……）。重复手写的代价不是"难看"，而是**改一处忘一处**：
// 负 limit 在 SQLite 里等于不设上限（会全表导出），以前只能靠每个路由各自记得夹住。
//
// 约定（见 CONVENTIONS.md §5 路由契约）：
//   - 所有数字型 query 参数必须经 `intParam` 读取，禁止在 handler 里裸写 Number(...)；
//   - fallback 兜的是"缺省 / 空串 / 非数字 / 0"，与旧写法 `Number(x) || fallback` 等价；
//   - 钳制在读取时完成，handler 拿到的就是安全值。

/**
 * 读一个数字型 query 参数，并夹到 [min, max]。
 *
 * @param {URL|URLSearchParams} source 路由里的 `new URL(req.url, 'http://x')`，或它的 searchParams
 * @param {string} name 参数名
 * @param {{fallback?: number, min?: number, max?: number, floor?: boolean}} [options]
 *   fallback：缺失/非法时的默认值；floor：是否取整（分页类参数需要）
 * @returns {number}
 */
export function intParam(source, name, options = {}) {
  const params = source && source.searchParams ? source.searchParams : source
  const {
    fallback = 0,
    min = Number.MIN_SAFE_INTEGER,
    max = Number.MAX_SAFE_INTEGER,
    floor = false,
  } = options
  const raw = Number(params.get(name)) || fallback
  const value = floor ? Math.floor(raw) : raw
  return Math.min(max, Math.max(min, value))
}

/**
 * 读一个字符串型 query 参数；缺失或空串回落 fallback。
 *
 * @param {URL|URLSearchParams} source URL 或 URLSearchParams
 * @param {string} name 参数名
 * @param {string} [fallback=''] 默认值
 * @returns {string}
 */
export function strParam(source, name, fallback = '') {
  const params = source && source.searchParams ? source.searchParams : source
  const value = params.get(name)
  return value === null || value === '' ? fallback : value
}
