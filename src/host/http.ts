// http.mjs —— 入参读值与钳制的唯一归口（query 参数 + JSON body 数值）。
//
// 为什么单独立一个模块：同一句
//   `Math.min(max, Math.max(min, Number(url.searchParams.get('x')) || fallback))`
// 在 index.js 里手写过 6 遍，每遍的上下限还不一样（列表 200/500、标注 1/5000、
// 看板 14 天、回顾 5 条……）。重复手写的代价不是"难看"，而是**改一处忘一处**：
// 负 limit 在 SQLite 里等于不设上限（会全表导出），以前只能靠每个路由各自记得夹住。
//
// 约定（见 CONVENTIONS.md §3.6）：
//   - 所有数字型 query 参数必须经 `intParam` 读取，禁止在 handler 里裸写 Number(...)；
//   - JSON body 的数字字段（handler 里和 handler 下游接收 payload 的业务函数里都一样）
//     必须经 `clampInt`，它是 intParam 的"值"版本，语义与上下限规则完全一致；
//   - fallback 兜的是"缺省 / 空串 / 非数字 / 0"，与旧写法 `Number(x) || fallback` 等价；
//   - 钳制在读取时完成，调用方拿到的就是安全值。
//
// 为什么不放在 lib/routes/shared.mjs：那是"路由层的响应出口"，业务模块（如 lib/r5.mjs）
// 要用同一个钳制口，但不能为了一个纯函数反向依赖 routes 层。所以归口留在 http.mjs
// （零依赖、纯函数），routes/shared.mjs 只做再导出，handler 的 import 不用改。

/** query 参数既可能是 URL，也可能直接是它的 searchParams。 */
export type ParamSource = URL | URLSearchParams

/** `intParam` / `clampInt` 的钳制选项。 */
export interface ParamBounds {
  fallback?: number
  min?: number
  max?: number
}

/** `intParam` 的选项：在钳制之外多一个"是否取整"（分页类参数需要）。 */
export interface IntParamOptions extends ParamBounds {
  floor?: boolean
}

/**
 * 读一个数字型 query 参数，并夹到 [min, max]。
 *
 * @param {URL|URLSearchParams} source 路由里的 `new URL(req.url, 'http://x')`，或它的 searchParams
 * @param {string} name 参数名
 * @param {{fallback?: number, min?: number, max?: number, floor?: boolean}} [options]
 *   fallback：缺失/非法时的默认值；floor：是否取整（分页类参数需要）
 * @returns {number}
 */
export function intParam(source: ParamSource, name: string, options: IntParamOptions = {}): number {
  const params = source instanceof URL ? source.searchParams : source
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
 * 钳制一个**值**（典型来源是 JSON body 字段），语义与 `intParam` 完全一致。
 *
 * query 参数有 `intParam` 这个唯一入口；POST body 以前是裸写
 * `Number(payload.x) || 0`，既重复又没有上下限。这里收成同一个口子：
 *   - `fallback` 兜的是「缺省 / 空串 / 非数字 / 0」，与 `Number(x) || fallback` 等价；
 *   - `min` / `max` 可选，只给有明确语义边界的字段；业务校验（如 rating 必须 1-4）
 *     仍留在 handler 里 —— 钳制和"合不合法"是两件事，钳成合法值会掩盖客户端 bug。
 *   - 不取整：`floor` 只属于分页类参数，那是 `intParam` 的事。
 *
 * 注意：**当时间戳用**的注入字段（如 `payload.now`）不要套它。那种字段的正确语义是
 * "非法就回落 Date.now()"，而 clampInt 会把 `±Infinity`（JSON 的 `1e400` 能解析出来）
 * 夹成安全整数边界，反而造出一个假的"现在"。
 *
 * @param {unknown} value 原始值（可能是字符串/数字/undefined/null）
 * @param {{fallback?: number, min?: number, max?: number}} [options]
 * @returns {number}
 */
export function clampInt(value: unknown, { fallback = 0, min, max }: ParamBounds = {}): number {
  const raw = Number(value) || fallback
  const low = min === undefined ? Number.MIN_SAFE_INTEGER : min
  const high = max === undefined ? Number.MAX_SAFE_INTEGER : max
  return Math.min(high, Math.max(low, raw))
}

/**
 * 读一个字符串型 query 参数；缺失或空串回落 fallback。
 *
 * @param {URL|URLSearchParams} source URL 或 URLSearchParams
 * @param {string} name 参数名
 * @param {string} [fallback=''] 默认值
 * @returns {string}
 */
export function strParam(source: ParamSource, name: string, fallback = ''): string {
  const params = source instanceof URL ? source.searchParams : source
  const value = params.get(name)
  return value === null || value === '' ? fallback : value
}
