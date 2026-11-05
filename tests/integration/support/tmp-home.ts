// tests/integration/support/tmp-home.ts —— 集成测试的 DSH_HOME 隔离。
//
// 为什么必须是第一步：`lib/host/store/schema.js` 在 **import 那一刻**就把
// `process.env.DSH_HOME` 换算成 `DATA_DIR` / `DB_FILE`（见 src/host/store/schema.ts），
// 之后改环境变量不再生效。所以调用顺序永远是：
//
//   1. createTempHome()   ← 本文件
//   2. await import('../../../lib/host/store.js') 等宿主模块
//
// 反了就可能在真实 `~/.dsh/dsh-word-learn/user.db` 上跑测试 —— 那份库不可再生。
// 迁移自 scripts/test-*.mjs 里的 `mkdtempSync` + 手写清理；额外补了 canary 断言。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface TempHome {
  /** 临时 DSH_HOME 的绝对路径（已写进 process.env.DSH_HOME）。 */
  home: string
  /** 还原 env 并尽力删除临时目录；Windows 句柄未释放时留给系统清理。 */
  cleanup(): void
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * canary 断言：临时用户库必须落在临时 home 下，绝不能是真实 ~/.dsh。
 *
 * 这是「一条断言换掉一次不可再生数据事故」的那条断言：一旦某次重构把
 * import 顺序弄反，测试会在建库前就红，而不是把真实词库改写一遍。
 */
export function assertIsolatedHome(home: string): void {
  const userDb = path.resolve(home, 'dsh-word-learn', 'user.db')
  const realDsh = path.resolve(os.homedir(), '.dsh')

  if (!isInside(userDb, home)) {
    throw new Error(`canary：用户库不在临时 DSH_HOME 下：${userDb}（home=${home}）`)
  }
  if (isInside(userDb, realDsh)) {
    throw new Error(`canary：用户库落在真实 ~/.dsh 下，拒绝继续：${userDb}`)
  }
  const envHome = process.env.DSH_HOME
  if (!envHome || path.resolve(envHome) !== path.resolve(home)) {
    throw new Error(`canary：process.env.DSH_HOME 未指向临时目录（实际 ${envHome}）`)
  }
}

/** 造临时 DSH_HOME 并写进 process.env；返回句柄，测试结束必须 cleanup()。 */
export function createTempHome(prefix = 'dwl-int-'): TempHome {
  const previous = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  process.env.DSH_HOME = home
  try {
    assertIsolatedHome(home)
  } catch (err) {
    // canary 失败时也要把 env 还原，避免污染同 worker 里后面的测试。
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    throw err
  }
  return {
    home,
    cleanup() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        /* Windows 偶发句柄未释放：临时目录交给系统清理，不影响断言结果 */
      }
    },
  }
}
