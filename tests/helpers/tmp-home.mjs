// tests/helpers/tmp-home.mjs —— 给需要真实 user.db 的单测造隔离 DSH_HOME。
//
// 为什么不是测试文件：文件名既不以 `test-` 开头也不是 `*.test.mjs`，
// `node --test tests/` 不会把它当用例执行。
//
// 关键时序：store.mjs 在 **import 那一刻**就把 DSH_HOME 换算成库路径，
// 所以调用方必须先 `useTempHome()`，再 `await import('../../lib/store.mjs')`
// （本文件故意不 import store，避免把这个时序藏起来）。绝不碰真实用户库。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 造临时 DSH_HOME 并写进 process.env；返回句柄，测试结束必须 cleanup()。 */
export function useTempHome(prefix = 'dwl-unit-') {
  const previous = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  process.env.DSH_HOME = home
  return {
    home,
    cleanup() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        /* Windows 偶发句柄未释放：临时目录留给系统清理，断言结果不受影响 */
      }
    },
  }
}

/** 打开一个真实 Store（调用前必须已 useTempHome），失败直接抛，别让测试带病跑。 */
export async function openTempStore() {
  const { Store } = await import('../../lib/store.mjs')
  const store = new Store()
  if (!store.open()) throw new Error('打不开临时用户库：' + store.error)
  return store
}
