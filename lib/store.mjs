// store.mjs —— 用户数据存储的**门面**（生词本、遇见记录、复习日志、设置）。
//
// 用户数据是**不可再生**的，放 $DSH_HOME 下，跟其它 DSH 插件数据一致。
// 原先 859 代码行全挤在这个文件里（超 CODE_BUDGET），现在按职责拆成 lib/store/：
//
//   lib/store/schema.mjs   —— 库路径、SCHEMA（DDL/索引）、migrate()：库长什么样
//   lib/store/words.mjs    —— 生词本 / 原句 / AI 元数据 / 义项材料 / 补记线索
//   lib/store/review.mjs   —— 看板聚合、分档统计、补记日志与补记债
//   lib/store/settings.mjs —— 插件设置键值对
//
// 本文件只保留两件事：
//   1. 用户库的生命周期（打开 / 失败退避重试 / 关闭）；
//   2. Store 类的公开方法名与签名——每个方法都是薄委托，行为与拆分前逐行等价。
//
// 公开契约不变：其他模块 `import { Store } from './store.mjs'`、
// `store.db` 直查、`USER_DB_FILE` / `USER_DATA_DIR` 都照旧可用。
//
// 设计取舍（原样保留）：
//   - **入口不筛选**：任何查过的词都能入册，靠 k_* 画像和词频分级去区分，
//     分级是"提示"，不是"门槛"。
//   - **seen_count / seen_at 分离**：次数和最近时间都要，用来算"多久没见"。
//
// schema 变更规则见 CONVENTIONS §6.3：改 SCHEMA 只对新库生效，
// 老库必须同步改 migrate() 的增量步骤；SQL 仍归口在这里（§6.2）。
import fs from 'node:fs'
import { createRequire } from 'node:module'

import { DATA_DIR, DB_FILE, INDEXES, SCHEMA, migrate } from './store/schema.mjs'
import * as review from './store/review.mjs'
import * as settings from './store/settings.mjs'
import * as words from './store/words.mjs'

const require = createRequire(import.meta.url)

// 打开失败后的重试退避窗口
const RETRY_MS = 10_000

export class Store {
  constructor() {
    this.db = null
    this.error = ''
    // 最近一次 open 失败的时间：失败后按 RETRY_MS 退避重试，不做永久熔断。
    this.errorAt = 0
  }

  /**
   * 打开用户库。
   *
   * 关键：失败**不能**变成永久熔断。旧实现一次 SQLITE_BUSY / 迁移异常就把 this.error
   * 钉死，此后整个生命周期所有读写都 500，用户只能重启宿主 —— 表现为"插件突然全坏了"。
   * 现在失败后按 RETRY_MS 退避重试，成功即清 error。
   */
  open() {
    if (this.db) return true
    if (this.error && Date.now() - (this.errorAt || 0) < RETRY_MS) return false
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const { DatabaseSync } = require('node:sqlite')
      this.db = new DatabaseSync(DB_FILE)
      // 顺序不能换：老库缺列时先建索引会直接抛错，migrate 就没机会补列。
      this.db.exec(SCHEMA)
      migrate(this.db)
      this.db.exec(INDEXES)
      return true
    } catch (err) {
      this.error = `打不开用户数据库：${(err && err.message) || err}`
      this.errorAt = Date.now()
      try {
        console.warn('[dsh-word-learn]', this.error)
      } catch (e) {}
      return false
    }
  }

  // ---------------------------------------------------------------- 生词本

  touch(info, sentence) {
    return words.touch(this, info, sentence)
  }

  get(word) {
    return words.get(this, word)
  }

  getById(id) {
    return words.getById(this, id)
  }

  list(options) {
    return words.list(this, options)
  }

  update(word, patch) {
    return words.update(this, word, patch)
  }

  setMeta(word, meta) {
    return words.setMeta(this, word, meta)
  }

  getMeta(word) {
    return words.getMeta(this, word)
  }

  getMetaBatch(words_) {
    return words.getMetaBatch(this, words_)
  }

  // ---------------------------------------------------------------- 义项材料

  setSenseMeta(word, meta) {
    return words.setSenseMeta(this, word, meta)
  }

  getSenseMeta(word) {
    return words.getSenseMeta(this, word)
  }

  latestSentence(word) {
    return words.latestSentence(this, word)
  }

  randomTranslations(excludeWord, count) {
    return words.randomTranslations(this, excludeWord, count)
  }

  remove(word) {
    return words.remove(this, word)
  }

  // ---------------------------------------------------------------- 统计与看板

  stats() {
    return review.stats(this)
  }

  dashboard(options) {
    return review.dashboard(this, options)
  }

  // ---------------------------------------------------------------- 补记

  logRepair(entry) {
    return review.logRepair(this, entry)
  }

  openRepairDebt(cardId) {
    return review.openRepairDebt(this, cardId)
  }

  clearRepairDebt(wordId) {
    return review.clearRepairDebt(this, wordId)
  }

  getRepairDebt(wordId) {
    return review.getRepairDebt(this, wordId)
  }

  openRepairDebts(limit) {
    return review.openRepairDebts(this, limit)
  }

  // ---------------------------------------------------------------- 设置

  getSetting(key) {
    return settings.getSetting(this, key)
  }

  setSetting(key, value) {
    return settings.setSetting(this, key, value)
  }

  deleteSetting(key) {
    return settings.deleteSetting(this, key)
  }

  close() {
    if (this.db) {
      try {
        this.db.close()
      } catch (err) {
        /* 忽略 */
      }
      this.db = null
    }
    // 关闭後清掉熔断状态：下次使用会重新尝试打开（插件热重载时也会走这里）。
    this.error = ''
    this.errorAt = 0
  }
}

export { DATA_DIR as USER_DATA_DIR, DB_FILE as USER_DB_FILE }
