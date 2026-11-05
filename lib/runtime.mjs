// runtime.mjs —— 进程内单例。
//
// 为什么单独拆出来：`lib/index.js` 原来同时管路由、栅栏、响应出口和这几个
// 单例，导致「谁都能改、谁都不敢动」。词典与用户库是进程级状态，路由模块只消费
// 它们，不拥有它们。
//
// 阶段 2 起前端全部并入 bundle，这里不再有 assets 的 mtime 加载器。
import { Dictionary } from './dict.mjs'
import { Store } from './host/store.js'

// 进程内单例：词典与用户库都要复用（打开 SQLite 有成本）
export const dict = new Dictionary()
export const store = new Store()
