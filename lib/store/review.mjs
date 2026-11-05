// store/review.mjs —— 看板聚合、分档统计、补记日志与补记债。
//
// 从 lib/store.mjs 拆出来的第二等职责：review_log / repair_log / repair_debt
// 的写入与聚合读取。注意这里**不算 FSRS**：排期计算在 lib/schedule.mjs，
// 本文件只读卡片与日志的既有状态并把口径统一在一处。
import { dayStart } from '../host/schedule.js'
import { DB_FILE } from './schema.mjs'

/** 按档位统计，用于复习页的分级展示。 */
export function stats(store) {
  if (!store.open()) return { ok: false, error: store.error }
  const db = store.db
  const total = db.prepare('SELECT COUNT(*) AS n FROM words').get().n
  const byTier = db
    .prepare('SELECT freq_tier AS tier, COUNT(*) AS n FROM words GROUP BY freq_tier')
    .all()
  const contexts = db.prepare('SELECT COUNT(*) AS n FROM contexts').get().n
  const starred = db.prepare('SELECT COUNT(*) AS n FROM words WHERE starred = 1').get().n
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
export function dashboard(store, { now = Date.now(), forecastDays = 14 } = {}) {
  if (!store.open()) return { ok: false, error: store.error }
  const db = store.db

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

// ---------------------------------------------------------------- 补记

/** 记一次补记事件。失败不应该影响学习流程，所以吞掉异常。 */
export function logRepair(store, { wordId, cardId, stage, ok, guess, elapsedMs }) {
  if (!store.open() || !wordId) return false
  try {
    store.db
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
export function openRepairDebt(store, cardId) {
  if (!store.open()) return false
  const db = store.db
  const row = db.prepare('SELECT word_id, track FROM cards WHERE id = ?').get(Number(cardId))
  if (!row) return false
  db.prepare(
    `INSERT INTO repair_debt (word_id, card_id, track, opened_at, cleared_at, tries)
     VALUES (?,?,?,?,NULL,0)
     ON CONFLICT(word_id) DO UPDATE SET
       card_id = excluded.card_id, track = excluded.track,
       opened_at = excluded.opened_at, cleared_at = NULL, tries = 0`,
  ).run(row.word_id, Number(cardId), row.track, Date.now())
  return true
}

/** 清债（R4 也过了才算）。 */
export function clearRepairDebt(store, wordId) {
  if (!store.open()) return false
  store.db
    .prepare('UPDATE repair_debt SET cleared_at = ? WHERE word_id = ? AND cleared_at IS NULL')
    .run(Date.now(), Number(wordId))
  return true
}

/** 取一笔债（给前端显示「今日补记 x/y」）。 */
export function getRepairDebt(store, wordId) {
  if (!store.open()) return null
  const row = store.db.prepare('SELECT * FROM repair_debt WHERE word_id = ?').get(Number(wordId))
  return row || null
}

/** 今日未清的债（会话末补记用）。 */
export function openRepairDebts(store, limit = 20) {
  if (!store.open()) return []
  return store.db
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
