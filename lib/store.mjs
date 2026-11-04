// store.mjs —— 用户数据存储（生词本、遇见记录、复习日志）。
//
// 与词典分开：词典是只读的共享资源（data/ecdict.db，可重新生成），
// 用户数据是**不可再生**的，放 $DSH_HOME 下，跟其它 DSH 插件数据一致。
//
// P1 只用到 words / contexts / encounters 三张表。
// cards（FSRS 排期）与 review_log 建好结构但 P2 才写入 —— 这样 P1 升级到 P2
// 不需要做数据迁移。
//
// 设计取舍：
//   - **入口不筛选**：用户说"感觉全是生词，但又好像没那么生词"，
//     所以任何查过的词都能入册，靠 k_* 画像和词频分级去区分，
//     而不是一开始就拒收。分级是"提示"，不是"门槛"。
//   - **seen_count / seen_at 分离**：次数和最近时间都要，用来算"多久没见"。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ensureCards, dayStart } from './schedule.mjs'

const require = createRequire(import.meta.url)

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'dsh-word-learn')
const DB_FILE = path.join(DATA_DIR, 'user.db')

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 生词本：一个词一行
CREATE TABLE IF NOT EXISTS words (
  id            INTEGER PRIMARY KEY,
  word          TEXT NOT NULL UNIQUE,   -- 原形，小写
  phonetic      TEXT,
  translation   TEXT,
  pos           TEXT,
  tag           TEXT,
  frq           INTEGER DEFAULT 0,
  bnc           INTEGER DEFAULT 0,
  collins       INTEGER DEFAULT 0,
  freq_tier     TEXT,                   -- 入册时的词频档位，用于分级展示
  -- 五维能力画像（0-5）。只影响"出什么题"和"是否毕业"，不单独排期。
  k_recognize   INTEGER DEFAULT 0,      -- 认得
  k_meaning     INTEGER DEFAULT 0,      -- 意思
  k_write       INTEGER DEFAULT 0,      -- 能写
  k_listen      INTEGER DEFAULT 0,      -- 能听
  k_pronounce   INTEGER DEFAULT 0,      -- 能读准
  known_senses  TEXT DEFAULT '[]',      -- 已知义项 JSON 数组
  note          TEXT DEFAULT '',        -- 用户自己的笔记
  starred       INTEGER DEFAULT 0,      -- 手动收藏
  graduated     INTEGER DEFAULT 0,      -- 1 = 五维全满，永久不再出现
  seen_count    INTEGER DEFAULT 0,      -- 累计遇见次数
  created_at    INTEGER NOT NULL,
  seen_at       INTEGER                 -- 最近一次遇见
);
CREATE INDEX IF NOT EXISTS idx_words_seen ON words(seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_words_tier ON words(freq_tier);

-- 遇见它的原句与出处（用户的语境资产）
CREATE TABLE IF NOT EXISTS contexts (
  id         INTEGER PRIMARY KEY,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sentence   TEXT NOT NULL,
  source     TEXT DEFAULT '',           -- 来自哪个界面/会话
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctx_word ON contexts(word_id, created_at DESC);

-- 排期线：一个词最多两条（receptive / productive）。P2 起写入。
--
-- ⚠️ learning_steps 是**调度状态的一部分，不是装饰**：
-- 它是"当前在第几个学习步"。丢掉它卡片会永远卡在 Learning 状态，
-- 永远毕业不到 Review，而且**不报错**（所有间隔恒为 0 天）。
-- 详见 lib/schedule.mjs 顶部注释里的实测对照。
CREATE TABLE IF NOT EXISTS cards (
  id             INTEGER PRIMARY KEY,
  word_id        INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  track          TEXT NOT NULL,          -- 'receptive' | 'productive'
  due            INTEGER,
  stability      REAL,
  difficulty     REAL,
  elapsed_days   INTEGER DEFAULT 0,
  scheduled_days INTEGER DEFAULT 0,
  reps           INTEGER DEFAULT 0,
  lapses         INTEGER DEFAULT 0,
  state          INTEGER DEFAULT 0,      -- 0新 1学习中 2复习中 3重学中
  learning_steps INTEGER DEFAULT 0,      -- 见上方警告：不能省
  last_review    INTEGER,
  leech_count    INTEGER DEFAULT 0,
  suspended      INTEGER DEFAULT 0,      -- 1 = leech 挂起，不再进队列
  UNIQUE(word_id, track)
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);

-- 每次交互。P1 只记 view 类弱信号，P2 起记答题。
CREATE TABLE IF NOT EXISTS review_log (
  id         INTEGER PRIMARY KEY,
  card_id    INTEGER,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  rating     INTEGER,                    -- 1=Again 2=Hard 3=Good 4=Easy
  kind       TEXT NOT NULL,              -- 题型
  evidence   TEXT DEFAULT '',            -- view|hover|expand|answer
  elapsed_ms INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_word ON review_log(word_id, created_at DESC);

-- 插件设置（键值对）。目前只存 AI 分析模型的选择。
-- 为什么放这里而不是插件 config：模型要在设置页里随时改，改完立刻生效，
-- 而 config 只能改 cordis.patch.yml 再重启；用户数据本来就是随插件走的。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 义项级学习材料（P1）。一个词可以有多条，按句子的语境义项区分。
-- 为什么单独一张表：word_meta 是词级的（词根/记忆法），回答不了
-- "这句话里是哪个义项"；补记卡需要的正是后者。
CREATE TABLE IF NOT EXISTS sense_meta (
  id         INTEGER PRIMARY KEY,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_key  TEXT NOT NULL,
  json       TEXT NOT NULL,
  model      TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(word_id, sense_key)
);
CREATE INDEX IF NOT EXISTS idx_sense_word ON sense_meta(word_id, created_at DESC);

-- 补记事件（回忆/对照/拼写/复现）。只用于选内容和算指标，不参与 FSRS 排期。
CREATE TABLE IF NOT EXISTS repair_log (
  id         INTEGER PRIMARY KEY,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  card_id    INTEGER,
  stage      TEXT NOT NULL,       -- pick|reveal|spell|session_end|tomorrow
  ok         INTEGER,             -- 0/1；pick 阶段为猜对/猜错
  guess      TEXT DEFAULT '',     -- 他选了什么
  elapsed_ms INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repair_word ON repair_log(word_id, created_at DESC);

-- 补记债：每按一次「忘了」开一笔，R3+R4 都成功才清。
-- 用"债"而不是扣分：忘记不定罪，跳过才要补。
CREATE TABLE IF NOT EXISTS repair_debt (
  word_id    INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
  card_id    INTEGER,
  track      TEXT NOT NULL,
  opened_at  INTEGER NOT NULL,
  cleared_at INTEGER,
  tries      INTEGER DEFAULT 0
);
`

/**
 * 把老库补齐到当前 schema。
 *
 * 为什么必须有：`CREATE TABLE IF NOT EXISTS` 对**已存在**的表什么都不做，
 * 所以给 cards 加列不会自动生效。我本地那个库是 P1 建的（没有
 * learning_steps / suspended），不迁移的话排期会静默失效 ——
 * 正是 schedule.mjs 里警告的那个"所有间隔恒为 0 天"的故障。
 *
 * 用 PRAGMA table_info 逐列检查，缺什么补什么；已经是对的库走一遍
 * 只是几条查询，代价可忽略。
 */
function migrate(db) {
  const cols = (table) => {
    try {
      return db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => r.name)
    } catch (err) {
      return []
    }
  }

  const cardCols = cols('cards')
  if (cardCols.length) {
    for (const [name, decl] of [
      ['learning_steps', 'INTEGER DEFAULT 0'],
      ['suspended', 'INTEGER DEFAULT 0'],
      ['leech_count', 'INTEGER DEFAULT 0'],
      ['elapsed_days', 'INTEGER DEFAULT 0'],
      ['scheduled_days', 'INTEGER DEFAULT 0'],
      ['stability', 'REAL'],
      ['difficulty', 'REAL'],
      ['last_review', 'INTEGER'],
    ]) {
      if (cardCols.includes(name)) continue
      try {
        db.exec(`ALTER TABLE cards ADD COLUMN ${name} ${decl}`)
      } catch (err) {
        /* 并发或已存在，忽略 */
      }
    }
  }

  const wordCols = cols('words')
  if (wordCols.length) {
    for (const [name, decl] of [
      ['known_senses', "TEXT DEFAULT '[]'"],
      ['note', "TEXT DEFAULT ''"],
      ['graduated', 'INTEGER DEFAULT 0'],
      ['lemma', 'TEXT'],
      ['freq_tier', 'TEXT'],
      ['word_meta', "TEXT DEFAULT ''"],
    ]) {
      if (wordCols.includes(name)) continue
      try {
        db.exec(`ALTER TABLE words ADD COLUMN ${name} ${decl}`)
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  // 补建缺失的排期卡。
  //
  // P1 的词是在 ensureCards 存在之前入册的，所以老库里的词**一张卡都没有**
  // —— 表现为学习页"已开始学习 0"，而词明明在库里。
  // 这里给所有没卡的词补上，让升级后立刻能排期。
  try {
    const orphans = db
      .prepare('SELECT id FROM words WHERE id NOT IN (SELECT DISTINCT word_id FROM cards)')
      .all()
    for (const row of orphans) ensureCards(db, row.id, Date.now())
  } catch (err) {
    /* 表结构异常时跳过，不影响打开 */
  }
}

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
      this.db.exec(SCHEMA)
      migrate(this.db)
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

  /**
   * 把一个词加进生词本，或更新它的遇见记录。
   *
   * 语义是"我在这里遇见了它"：
   *   - 第一次遇见 -> 插入，seen_count = 1
   *   - 再次遇见   -> seen_count + 1，刷新 seen_at，并**补全之前缺的字段**
   *     （早期可能没有音标/释义，后来补上了不该丢）
   *
   * 返回 { word_id, isNew, seenCount }
   */
  touch(info, sentence) {
    if (!this.open()) return { word_id: 0, isNew: false, seenCount: 0, error: this.error }
    const now = Date.now()
    const word = String(info.word || '').toLowerCase()
    if (!word) return { word_id: 0, isNew: false, seenCount: 0, error: '空词' }

    const existing = this.db.prepare('SELECT id, seen_count FROM words WHERE word = ?').get(word)

    let wordId
    let isNew = false
    if (existing) {
      wordId = existing.id
      this.db
        .prepare(
          `UPDATE words SET seen_count = seen_count + 1, seen_at = ?,
             phonetic = COALESCE(NULLIF(?, ''), phonetic),
             translation = COALESCE(NULLIF(?, ''), translation)
           WHERE id = ?`,
        )
        .run(now, info.phonetic || '', sensesToText(info.senses), wordId)
    } else {
      isNew = true
      const result = this.db
        .prepare(
          `INSERT INTO words (word, phonetic, translation, pos, tag, frq, bnc, collins,
                              freq_tier, seen_count, created_at, seen_at)
           VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          word,
          info.phonetic || '',
          sensesToText(info.senses),
          info.pos || '',
          (info.tags || []).map((t) => t.key).join(' '),
          info.frequency?.rank || 0,
          info.frequency?.rank || 0,
          info.collins || 0,
          info.frequency?.tier || 'unknown',
          now,
          now,
        )
      wordId = Number(result.lastInsertRowid)
    }

    // 记原句（同一句不重复记）
    const text = String(sentence || '').trim()
    if (text) {
      const dup = this.db
        .prepare('SELECT id FROM contexts WHERE word_id = ? AND sentence = ?')
        .get(wordId, text)
      if (!dup) {
        this.db
          .prepare('INSERT INTO contexts (word_id, sentence, source, created_at) VALUES (?,?,?,?)')
          .run(wordId, text, 'chat', now)
      }
    }

    // 弱信号：看过就算一次接触
    this.db
      .prepare('INSERT INTO review_log (word_id, kind, evidence, created_at) VALUES (?,?,?,?)')
      .run(wordId, 'recognize', 'view', now)

    // 建两条排期线。
    //
    // 为什么查词时就建：查过 = 第一次接触（receptive 线开始排期），
    // 而 productive 线建好但**不排期**（reps=0，不进复习队列），
    // 等用户真的写对过才开始。这样"今天该复习什么"不会因为
    // 只查过一次就冒出来，但将来要用时结构已经在了。
    ensureCards(this.db, wordId, now)

    const count = this.db.prepare('SELECT seen_count FROM words WHERE id = ?').get(wordId)
    return { word_id: wordId, isNew, seenCount: count ? count.seen_count : 1 }
  }

  /** 取一个词的完整档案（含原句）。 */
  get(word) {
    if (!this.open()) return null
    const row = this.db
      .prepare('SELECT * FROM words WHERE word = ?')
      .get(String(word || '').toLowerCase())
    if (!row) return null
    return this.#hydrate(row)
  }

  getById(id) {
    if (!this.open()) return null
    const row = this.db.prepare('SELECT * FROM words WHERE id = ?').get(id)
    return row ? this.#hydrate(row) : null
  }

  #hydrate(row) {
    const contexts = this.db
      .prepare(
        'SELECT sentence, source, created_at FROM contexts WHERE word_id = ? ORDER BY created_at DESC LIMIT 20',
      )
      .all(row.id)
    let knownSenses
    try {
      knownSenses = JSON.parse(row.known_senses || '[]')
    } catch (err) {
      knownSenses = []
    }
    let wordMeta
    try {
      wordMeta = row.word_meta ? JSON.parse(row.word_meta) : null
    } catch (err) {
      wordMeta = null
    }
    return {
      id: row.id,
      word: row.word,
      phonetic: row.phonetic || '',
      translation: row.translation || '',
      pos: row.pos || '',
      tag: row.tag || '',
      freqTier: row.freq_tier || 'unknown',
      collins: row.collins || 0,
      starred: !!row.starred,
      graduated: !!row.graduated,
      note: row.note || '',
      seenCount: row.seen_count || 0,
      createdAt: row.created_at,
      seenAt: row.seen_at,
      knownSenses,
      wordMeta,
      ability: {
        recognize: row.k_recognize || 0,
        meaning: row.k_meaning || 0,
        write: row.k_write || 0,
        listen: row.k_listen || 0,
        pronounce: row.k_pronounce || 0,
      },
      contexts: contexts.map((c) => ({
        sentence: c.sentence,
        source: c.source,
        createdAt: c.created_at,
      })),
    }
  }

  /** 生词本列表。 */
  list({ limit = 200, offset = 0, tier = '', starredOnly = false, order = 'recent' } = {}) {
    if (!this.open()) return { items: [], total: 0, error: this.error }
    const where = []
    const params = []
    if (tier) {
      where.push('freq_tier = ?')
      params.push(tier)
    }
    if (starredOnly) where.push('starred = 1')
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const orderBy =
      order === 'alpha' ? 'word ASC' : order === 'freq' ? 'frq ASC' : 'seen_at DESC NULLS LAST'

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM words ${clause}`).get(...params).n
    const rows = this.db
      .prepare(`SELECT * FROM words ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
    return { items: rows.map((r) => this.#hydrate(r)), total }
  }

  /** 按档位统计，用于复习页的分级展示。 */
  stats() {
    if (!this.open()) return { ok: false, error: this.error }
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM words').get().n
    const byTier = this.db
      .prepare('SELECT freq_tier AS tier, COUNT(*) AS n FROM words GROUP BY freq_tier')
      .all()
    const contexts = this.db.prepare('SELECT COUNT(*) AS n FROM contexts').get().n
    const starred = this.db.prepare('SELECT COUNT(*) AS n FROM words WHERE starred = 1').get().n
    return {
      ok: true,
      total,
      starred,
      contexts,
      byTier: Object.fromEntries(byTier.map((r) => [r.tier, r.n])),
      dbPath: DB_FILE,
    }
  }

  /**
   * 学习页看板的全部聚合数据。
   *
   * 一次查询返回整个页面要的东西：今日/明日待复习、进度、报表、
   * 分档分布、能力画像分布、最近活动。
   *
   * 为什么集中在这里而不是前端拼：这些数字必须**口径一致**。
   * 比如"今日待复习"和"进度里的已学"如果各算各的，页面上就会
   * 出现自相矛盾的数字，而用户只会觉得"这插件在骗我"。
   */
  dashboard({ now = Date.now(), forecastDays = 14 } = {}) {
    if (!this.open()) return { ok: false, error: this.error }
    const db = this.db

    // ── 词条总量与分档
    const total = db.prepare('SELECT COUNT(*) AS n FROM words').get().n
    const graduated = db.prepare('SELECT COUNT(*) AS n FROM words WHERE graduated = 1').get().n
    const starred = db.prepare('SELECT COUNT(*) AS n FROM words WHERE starred = 1').get().n
    const byTier = db
      .prepare(
        'SELECT freq_tier AS tier, COUNT(*) AS n FROM words GROUP BY freq_tier ORDER BY n DESC',
      )
      .all()

    // ── 排期状态
    const cardAgg = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN reps = 0 THEN 1 ELSE 0 END) AS fresh,
           SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) AS suspended,
           SUM(CASE WHEN state = 1 THEN 1 ELSE 0 END) AS learning,
           SUM(CASE WHEN state = 2 THEN 1 ELSE 0 END) AS review,
           SUM(CASE WHEN state = 3 THEN 1 ELSE 0 END) AS relearning
         FROM cards`,
      )
      .get()

    const todayEnd = dayStart(1, now)
    const todayStart = dayStart(0, now)

    // 已开始学习的**词**数（不是卡片数）。
    //
    // 为什么单独查：一个词有两条线（receptive / productive），
    // 所以 `cards` 里是 2 行。直接拿"reps>0 的卡片数"当进度分子，
    // 除以"词数"就会超过 100%（实测出现过 135%）—— 单位不一致。
    // 进度必须两边都按**词**算。
    const startedWords = db
      .prepare(
        `SELECT COUNT(DISTINCT c.word_id) AS n FROM cards c
          WHERE c.reps > 0`,
      )
      .get().n

    // 今日待复习：已经学过（reps>0）且已到期。
    //
    // 按**词**去重：两条线同一天到期时，队列一轮只出一次（见 schedule.dueQueue），
    // 这里数卡片会让"今日待复习"比实际要多一倍。
    const dueToday = db
      .prepare(
        `SELECT COUNT(DISTINCT c.word_id) AS n FROM cards c JOIN words w ON w.id = c.word_id
          WHERE c.suspended = 0 AND w.graduated = 0 AND c.reps > 0 AND c.due < ?`,
      )
      .get(todayEnd).n

    // 今日已复习：今天答过几次
    const reviewedToday = db
      .prepare(
        'SELECT COUNT(*) AS n FROM review_log WHERE evidence = ? AND created_at >= ? AND created_at < ?',
      )
      .get('answer', todayStart, todayEnd).n

    // 明日到期（严格落在明天这一天内），同样按词去重
    const dueTomorrow = db
      .prepare(
        `SELECT COUNT(DISTINCT c.word_id) AS n FROM cards c JOIN words w ON w.id = c.word_id
          WHERE c.suspended = 0 AND w.graduated = 0 AND c.reps > 0
            AND c.due >= ? AND c.due < ?`,
      )
      .get(todayEnd, dayStart(2, now)).n

    // 未来 N 天预测曲线
    const forecast = []
    for (let i = 0; i < forecastDays; i++) {
      const from = dayStart(i, now)
      const to = dayStart(i + 1, now)
      const n = db
        .prepare(
          `SELECT COUNT(*) AS n FROM cards c JOIN words w ON w.id = c.word_id
            WHERE c.suspended = 0 AND w.graduated = 0 AND c.reps > 0
              AND c.due >= ? AND c.due < ?`,
        )
        .get(from, to).n
      forecast.push({ day: i, date: from, count: n })
    }

    // ── 能力画像分布（五维各自 0-5 的直方图）
    const ability = {}
    for (const [key, col] of Object.entries({
      recognize: 'k_recognize',
      meaning: 'k_meaning',
      write: 'k_write',
      listen: 'k_listen',
      pronounce: 'k_pronounce',
    })) {
      const rows = db.prepare(`SELECT ${col} AS v, COUNT(*) AS n FROM words GROUP BY ${col}`).all()
      const buckets = [0, 0, 0, 0, 0, 0]
      for (const r of rows) buckets[Math.max(0, Math.min(5, r.v || 0))] += r.n
      ability[key] = buckets
    }

    // ── 近 14 天每天复习量（报表条形图）
    const activity = []
    for (let i = 13; i >= 0; i--) {
      const from = dayStart(-i, now)
      const to = dayStart(-i + 1, now)
      const n = db
        .prepare(
          'SELECT COUNT(*) AS n FROM review_log WHERE evidence = ? AND created_at >= ? AND created_at < ?',
        )
        .get('answer', from, to).n
      activity.push({ day: -i, date: from, count: n })
    }

    // ── 正确率（报表）
    const ratingRows = db
      .prepare(
        'SELECT rating AS r, COUNT(*) AS n FROM review_log WHERE evidence = ? AND rating IS NOT NULL GROUP BY rating',
      )
      .all('answer')
    const ratingTotal = ratingRows.reduce((s, r) => s + r.n, 0)
    const ratingDist = { 1: 0, 2: 0, 3: 0, 4: 0 }
    for (const r of ratingRows) ratingDist[r.r] = r.n
    // 正确率口径：Good/Easy 算对，Again/Hard 算没记住。
    // 这是**我自己定的口径**，不是 FSRS 的官方指标 —— 界面上要写清楚。
    const correct = (ratingDist[3] || 0) + (ratingDist[4] || 0)

    // ── 最难的词（lapses 最多）
    const hardest = db
      .prepare(
        `SELECT w.word, w.translation, w.freq_tier, c.lapses, c.track, c.suspended
           FROM cards c JOIN words w ON w.id = c.word_id
          WHERE c.lapses > 0
          ORDER BY c.lapses DESC LIMIT 10`,
      )
      .all()

    // ── 最近加入的词
    const recent = db
      .prepare(
        'SELECT word, translation, freq_tier, seen_at, seen_count FROM words ORDER BY seen_at DESC LIMIT 10',
      )
      .all()

    // ── 首次使用时间（算"学了多久"）
    const first = db.prepare('SELECT MIN(created_at) AS t FROM words').get().t

    return {
      ok: true,
      generatedAt: now,
      words: { total, graduated, starred, byTier },
      cards: {
        total: cardAgg.total || 0,
        fresh: cardAgg.fresh || 0,
        suspended: cardAgg.suspended || 0,
        learning: cardAgg.learning || 0,
        review: cardAgg.review || 0,
        relearning: cardAgg.relearning || 0,
        started: startedWords, // ← 词数口径，与 words.total 同单位（不能拿卡片数当分子）
      },
      queue: { dueToday, dueTomorrow, reviewedToday },
      forecast,
      activity,
      ability,
      accuracy: {
        total: ratingTotal,
        correct,
        rate: ratingTotal ? correct / ratingTotal : 0,
        dist: ratingDist,
      },
      hardest,
      recent,
      since: first || null,
      dbPath: DB_FILE,
    }
  }

  /** 改画像 / 收藏 / 笔记。P2 起答题会调用它。 */
  update(word, patch = {}) {
    if (!this.open()) return false
    const row = this.db
      .prepare('SELECT id FROM words WHERE word = ?')
      .get(String(word).toLowerCase())
    if (!row) return false
    const sets = []
    const params = []
    const abilityMap = {
      recognize: 'k_recognize',
      meaning: 'k_meaning',
      write: 'k_write',
      listen: 'k_listen',
      pronounce: 'k_pronounce',
    }
    for (const [key, column] of Object.entries(abilityMap)) {
      if (typeof patch.ability?.[key] === 'number') {
        sets.push(`${column} = ?`)
        params.push(Math.max(0, Math.min(5, Math.round(patch.ability[key]))))
      }
    }
    if (typeof patch.starred === 'boolean') {
      sets.push('starred = ?')
      params.push(patch.starred ? 1 : 0)
    }
    if (typeof patch.note === 'string') {
      sets.push('note = ?')
      params.push(patch.note)
    }
    if (typeof patch.graduated === 'boolean') {
      sets.push('graduated = ?')
      params.push(patch.graduated ? 1 : 0)
    }
    if (Array.isArray(patch.knownSenses)) {
      sets.push('known_senses = ?')
      params.push(JSON.stringify(patch.knownSenses))
    }
    if (patch.wordMeta && typeof patch.wordMeta === 'object') {
      sets.push('word_meta = ?')
      params.push(JSON.stringify(patch.wordMeta))
    }
    if (!sets.length) return false
    params.push(row.id)
    this.db.prepare(`UPDATE words SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return true
  }

  /**
   * 写入 AI 分析的元数据。
   *
   * word_meta JSON 结构：
   * {
   *   roots: [{ part: "re-", type: "prefix", meaning: "再次" }, ...],
   *   synonyms: ["similar", "alike"],
   *   distractors: ["故意写错的释义1", "另一个干扰项"],
   *   mnemonic: "记忆方法/场景描述",
   *   confusables: ["容易混淆的词"],
   *   analyzedAt: 1730000000000
   * }
   */
  setMeta(word, meta) {
    if (!this.open()) return false
    const row = this.db
      .prepare('SELECT id FROM words WHERE word = ?')
      .get(String(word).toLowerCase())
    if (!row) return false
    this.db.prepare('UPDATE words SET word_meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id)
    return true
  }

  /** 取一个词的 AI 元数据（解析后的对象，或 null）。 */
  getMeta(word) {
    if (!this.open()) return null
    const row = this.db
      .prepare('SELECT word_meta FROM words WHERE word = ?')
      .get(String(word).toLowerCase())
    if (!row || !row.word_meta) return null
    try {
      return JSON.parse(row.word_meta)
    } catch {
      return null
    }
  }

  /** 批量取 word_meta（复习队列预热用）。返回 { word: meta } 映射。 */
  getMetaBatch(words) {
    if (!this.open() || !words.length) return {}
    const out = {}
    // SQLite 绑定变量有上限，分批
    const batch = 50
    for (let i = 0; i < words.length; i += batch) {
      const slice = words.slice(i, i + batch)
      const placeholders = slice.map(() => '?').join(',')
      const rows = this.db
        .prepare(`SELECT word, word_meta FROM words WHERE word IN (${placeholders})`)
        .all(...slice.map((w) => String(w).toLowerCase()))
      for (const r of rows) {
        if (!r.word_meta) continue
        try {
          out[r.word] = JSON.parse(r.word_meta)
        } catch {
          /* skip */
        }
      }
    }
    return out
  }

  // ---------------------------------------------------------------- 义项材料

  /**
   * 存一条义项分析。同一个词的不同语境义项各存一条；
   * 同一义项重跑就覆盖（模型/提示词升级后可以重算）。
   */
  setSenseMeta(word, meta) {
    if (!this.open()) return false
    const row = this.db
      .prepare('SELECT id FROM words WHERE word = ?')
      .get(String(word).toLowerCase())
    if (!row) return false
    const key = String(meta.sense_here || '').slice(0, 80)
    if (!key) return false
    this.db
      .prepare(
        `INSERT INTO sense_meta (word_id, sense_key, json, model, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(word_id, sense_key) DO UPDATE SET
           json = excluded.json, model = excluded.model, created_at = excluded.created_at`,
      )
      .run(row.id, key, JSON.stringify(meta), meta.model || '', Date.now())
    return true
  }

  /** 取这个词最近一次义项分析（解析后的对象，或 null）。 */
  getSenseMeta(word) {
    if (!this.open()) return null
    const row = this.db
      .prepare(
        `SELECT sm.json FROM sense_meta sm JOIN words w ON w.id = sm.word_id
          WHERE w.word = ? ORDER BY sm.created_at DESC LIMIT 1`,
      )
      .get(String(word).toLowerCase())
    if (!row || !row.json) return null
    try {
      return JSON.parse(row.json)
    } catch {
      return null
    }
  }

  /** 最近一次遇见这个词的句子（补记卡的提取线索）。 */
  latestSentence(word) {
    if (!this.open()) return ''
    const row = this.db
      .prepare(
        `SELECT c.sentence FROM contexts c JOIN words w ON w.id = c.word_id
          WHERE w.word = ? ORDER BY c.created_at DESC LIMIT 1`,
      )
      .get(String(word).toLowerCase())
    return (row && row.sentence) || ''
  }

  // ---------------------------------------------------------------- 补记

  /** 记一次补记事件。失败不应该影响学习流程，所以吞掉异常。 */
  logRepair({ wordId, cardId, stage, ok, guess, elapsedMs }) {
    if (!this.open() || !wordId) return false
    try {
      this.db
        .prepare(
          `INSERT INTO repair_log (word_id, card_id, stage, ok, guess, elapsed_ms, created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          wordId,
          cardId || null,
          String(stage || ''),
          ok == null ? null : ok ? 1 : 0,
          String(guess || '').slice(0, 120),
          Math.max(0, Number(elapsedMs) || 0),
          Date.now(),
        )
      return true
    } catch {
      return false
    }
  }

  /** 按「忘了」时开一笔债。同一个词重复忘，重置 opened_at、tries 归零。 */
  openRepairDebt(cardId) {
    if (!this.open()) return false
    const row = this.db.prepare('SELECT word_id, track FROM cards WHERE id = ?').get(Number(cardId))
    if (!row) return false
    this.db
      .prepare(
        `INSERT INTO repair_debt (word_id, card_id, track, opened_at, cleared_at, tries)
         VALUES (?,?,?,?,NULL,0)
         ON CONFLICT(word_id) DO UPDATE SET
           card_id = excluded.card_id, track = excluded.track,
           opened_at = excluded.opened_at, cleared_at = NULL, tries = 0`,
      )
      .run(row.word_id, Number(cardId), row.track, Date.now())
    return true
  }

  /** 清债（R4 也过了才算）。 */
  clearRepairDebt(wordId) {
    if (!this.open()) return false
    this.db
      .prepare('UPDATE repair_debt SET cleared_at = ? WHERE word_id = ? AND cleared_at IS NULL')
      .run(Date.now(), Number(wordId))
    return true
  }

  /** 取一笔债（给前端显示「今日补记 x/y」）。 */
  getRepairDebt(wordId) {
    if (!this.open()) return null
    const row = this.db.prepare('SELECT * FROM repair_debt WHERE word_id = ?').get(Number(wordId))
    return row || null
  }

  /** 今日未清的债（会话末补记用）。 */
  openRepairDebts(limit = 20) {
    if (!this.open()) return []
    return this.db
      .prepare(
        `SELECT d.*, w.word, w.phonetic, w.translation,
                (SELECT ctx.sentence FROM contexts ctx WHERE ctx.word_id = d.word_id
                  ORDER BY ctx.created_at DESC LIMIT 1) AS sentence
           FROM repair_debt d JOIN words w ON w.id = d.word_id
          WHERE d.cleared_at IS NULL
          ORDER BY d.opened_at ASC LIMIT ?`,
      )
      .all(Math.max(1, Number(limit) || 20))
  }

  /**
   * 随机取其他词的释义（用于选择题干扰项兜底）。
   * 排除指定词本身，每条取第一行释义。
   */
  randomTranslations(excludeWord, count = 6) {
    if (!this.open()) return []
    const rows = this.db
      .prepare(
        `SELECT translation FROM words
          WHERE word != ? AND translation != '' AND translation IS NOT NULL
          ORDER BY RANDOM() LIMIT ?`,
      )
      .all(String(excludeWord).toLowerCase(), count)
    return rows
      .map((r) => {
        const first = String(r.translation || '')
          .split('\n')[0]
          .trim()
        return first
      })
      .filter(Boolean)
  }

  /** 移除一个词（连同它的原句与日志）。 */
  remove(word) {
    if (!this.open()) return false
    const row = this.db
      .prepare('SELECT id FROM words WHERE word = ?')
      .get(String(word).toLowerCase())
    if (!row) return false
    this.db.prepare('DELETE FROM words WHERE id = ?').run(row.id)
    return true
  }

  /**
   * 读一个插件设置。不存在（或库没打开）返回 null，不抛错。
   */
  getSetting(key) {
    if (!this.open()) return null
    try {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key))
      return row ? row.value : null
    } catch (err) {
      return null
    }
  }

  /** 写一个插件设置（覆盖同名旧值）。返回是否写成功。 */
  setSetting(key, value) {
    if (!this.open()) return false
    try {
      this.db
        .prepare(
          'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .run(String(key), String(value), Date.now())
      return true
    } catch (err) {
      return false
    }
  }

  /** 删除一个插件设置（回到默认行为）。 */
  deleteSetting(key) {
    if (!this.open()) return false
    try {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(String(key))
      return true
    } catch (err) {
      return false
    }
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

/** 把 senses 数组压成一行文本存库（展示时再拆）。 */
function sensesToText(senses) {
  if (!Array.isArray(senses)) return ''
  return senses
    .map((s) => (s.pos ? `${s.pos} ${s.text}` : s.domain ? `[${s.domain}] ${s.text}` : s.text))
    .join('\n')
}

export { DB_FILE as USER_DB_FILE, DATA_DIR as USER_DATA_DIR }
