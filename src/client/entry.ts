/**
 * DSH 客户端入口。
 *
 * 这里只做导出：`__ModuleLoader__.load({ id, factory })` 的壳由 tsdown 的
 * banner/footer 生成（见 tsdown.config.ts）。产物里 `exports.apply` / `exports.inject`
 * 就是 loader 要的 Cordis 插件面。
 *
 * 业务代码在 ./plugin.js —— 阶段 1 从 assets/dashboard.js 机械搬运而来，
 * 仍是「读 window.__dwl* 注入脚本」的形态；阶段 2 会改成真实 import。
 */
export { inject, apply, __test__ } from './plugin.js'
