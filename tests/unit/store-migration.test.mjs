// @vitest-environment node
// 老库（P1 时代）能不能打开 —— 索引必须在 migrate 之后建。
//
// 这条回归守的是一次真实故障风险：SCHEMA 里 CREATE INDEX idx_words_tier ON words(freq_tier)
// 如果和建表一起执行，而老库的 words 表还没有 freq_tier 列（P1 建库时没有），
// SQLite 会抛 "no such column: freq_tier"，open() 整个失败、migrate() 根本没机会补列，
// 表现是插件每 10s 报「打不开用户数据库」、所有接口 500，只能重启宿主。
//
// 现在顺序是：建表 → migrate 补列 → 建索引。这个测试造一个缺列的 P1 老库，验证：
//   1) open() 成功；
//   2) 缺失的列被 migrate 补上；
//   3) 索引建出来了；
//   4) 老词补建了排期卡（否则学习页永远是「已开始学习 0」）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

import { DatabaseSync } from 'node:sqlite'

test('缺 freq_tier 列的 P1 老库能打开、被迁移、并建好索引', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-store-migrate-'))
  const dataDir = path.join(home, 'dsh-word-learn')
  fs.mkdirSync(dataDir, { recursive: true })
  const dbFile = path.join(dataDir, 'user.db')

  // 1. 造 P1 老库：words 没有 freq_tier / known_senses / word_meta 等后加列，
  //    cards 没有 learning_steps 等排期状态列。
  const old = new DatabaseSync(dbFile)
  old.exec(`
CREATE TABLE words (
  id INTEGER PRIMARY KEY,
  word TEXT NOT NULL UNIQUE,
  phonetic TEXT,
  translation TEXT,
  pos TEXT,
  tag TEXT,
  frq INTEGER DEFAULT 0,
  bnc INTEGER DEFAULT 0,
  collins INTEGER DEFAULT 0,
  k_recognize INTEGER DEFAULT 0,
  k_meaning INTEGER DEFAULT 0,
  k_write INTEGER DEFAULT 0,
  k_listen INTEGER DEFAULT 0,
  k_pronounce INTEGER DEFAULT 0,
  seen_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  seen_at INTEGER
);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  track TEXT NOT NULL,
  due INTEGER,
  reps INTEGER DEFAULT 0,
  lapses INTEGER DEFAULT 0,
  state INTEGER DEFAULT 0,
  UNIQUE(word_id, track)
);
CREATE TABLE review_log (
  id INTEGER PRIMARY KEY,
  card_id INTEGER,
  word_id INTEGER NOT NULL,
  rating INTEGER,
  kind TEXT NOT NULL,
  evidence TEXT DEFAULT '',
  elapsed_ms INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT INTO words (word, created_at) VALUES ('legacyword', 1700000000000);
`)
  old.close()

  // 2. 让 Store 打开的是这个临时库（schema.mjs 在 import 时读 DSH_HOME，所以先设再动态 import）。
  process.env.DSH_HOME = home
  const { Store } = await import('../../lib/host/store.js')
  const store = new Store()
  try {
    assert.equal(store.open(), true, '老库应能打开（索引若先于 migrate 执行就会在这里失败）')

    const cols = (table) =>
      store.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => r.name)
    assert.ok(cols('words').includes('freq_tier'), 'migrate 应补上 freq_tier 列')
    assert.ok(cols('cards').includes('learning_steps'), 'migrate 应补上 learning_steps 列')

    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map((r) => r.name)
    for (const name of ['idx_words_seen', 'idx_words_tier', 'idx_ctx_word', 'idx_cards_due']) {
      assert.ok(indexes.includes(name), `索引 ${name} 应建出来`)
    }

    const cards = store.db.prepare('SELECT COUNT(*) c FROM cards').get().c
    assert.equal(cards, 2, '老词应被补建 receptive + productive 两张卡')
    const word = store.get('legacyword')
    assert.equal(word.word, 'legacyword', '老词数据不应丢失')
  } finally {
    store.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
