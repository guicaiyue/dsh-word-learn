// service.mjs —— 从 cordis 上下文里取一个服务。
//
// 为什么不能只写 `ctx.llm`：本机 DSH（0.2.1-rc.x / cordis 4）里，属性访问只对
// **本 fiber 显式 inject 过的服务**放行；没 inject 的会抛
// `cannot get property "llm" without inject`。插件是在 `root.inject(['webServer'])`
// 的回调里拿到的 ctx，只 inject 了 webServer，所以 `ctx.llm` 一律抛错。
// `ctx.get(name)` 走另一条查找（isolate key → fiber store 链），不受 inject 限制。
//
// 这条曾经是个真 bug：ai-enrich.mjs 早先只试 `ctx[name]` / `ctx.root[name]`，
// 抛错被 catch 吞成 null，于是 `llm` 永远是 null —— AI 分析在发起请求前就返回，
// 界面上只能看到"AI 分析失败，可能是模型不可用"，换哪个模型都一样。
//
// 两道路都试：先 `ctx.get`（现行做法），再退回属性访问（单测里的假 ctx、
// 或者以后 cordis 又把属性访问放宽）。

/**
 * 取服务；拿不到返回 null，从不抛错。
 *
 * @param {object} ctx - 插件上下文（或任何带 get 的对象）
 * @param {string} name - 服务名，如 'llm'、'agentDefaultModel'
 * @returns {object|null}
 */
export function getService(ctx, name) {
  if (!ctx) return null
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet) return viaGet
  } catch {
    /* 服务缺失时 ctx.get 可能抛错，忽略并继续尝试属性访问 */
  }
  try {
    return ctx[name] || (ctx.root && ctx.root[name]) || null
  } catch {
    return null
  }
}
