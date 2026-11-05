// tests/integration/support/db.ts —— 真实 node:sqlite 临时用户库。
//
// 建表不手写 SQL：DDL / 索引 / 迁移的唯一来源是宿主自己的 `lib/host/store/schema.js`
// （源码 src/host/store/schema.ts）。测试里再抄一份 CREATE TABLE 的话，schema 一改就会
// 悄悄漂移 —— 测试全绿，插件起不来。
//
// 用法（时序很重要，见 tmp-home.ts 顶部注释）：
//
//   const temp = await openTempStore('dwl-int-r5-')
//   temp.store.touch(...)   // 真实 Store，包含全部读写方法
//   temp.cleanup()
//
// 只想要裸 db（自己 prepare SQL）用 openTempDatabase()。
import fs from 'node:fs'

import type { DatabaseSync } from 'node:sqlite'

import { createTempHome } from './tmp-home.js'

export interface TempDatabase {
  home: string
  db: DatabaseSync
  dbFile: string
  cleanup(): void
}

export interface TempStore {
  home: string
  store: {
    db: DatabaseSync | null
    open(): boolean
    close?(): void
    [method: string]: unknown
  }
  cleanup(): void
}

/** 打开一个走宿主 schema/migrate 的真实临时库（不经过 Store 门面）。 */
export async function openTempDatabase(prefix = 'dwl-int-db-'): Promise<TempDatabase> {
  const temp = createTempHome(prefix)
  // createTempHome 之后才能 import：schema.js 在模块求值期读取 DSH_HOME。
  const schema = await import('../../../lib/host/store/schema.js')
  const { DatabaseSync } = await import('node:sqlite')

  fs.mkdirSync(schema.DATA_DIR, { recursive: true })
  const db = new DatabaseSync(schema.DB_FILE)
  db.exec(schema.SCHEMA)
  schema.migrate(db)
  db.exec(schema.INDEXES)

  return {
    home: temp.home,
    db,
    dbFile: schema.DB_FILE,
    cleanup() {
      try {
        db.close()
      } catch {
        /* 已经关掉/被占用都不影响清理结论 */
      }
      temp.cleanup()
    },
  }
}

/** 打开一个真实 Store（临时 DSH_HOME），失败直接抛，别让测试带病跑。 */
export async function openTempStore(prefix = 'dwl-int-store-'): Promise<TempStore> {
  const temp = createTempHome(prefix)
  const { Store } = await import('../../../lib/host/store.js')
  const store = new Store()
  if (!store.open()) {
    temp.cleanup()
    throw new Error('打不开临时用户库：' + store.error)
  }
  return {
    home: temp.home,
    store: store as TempStore['store'],
    cleanup() {
      try {
        store.close()
      } catch {
        /* 关库失败不影响断言；临时目录照删 */
      }
      temp.cleanup()
    },
  }
}
