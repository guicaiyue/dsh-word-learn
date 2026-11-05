// schedule.mjs —— FSRS-6 排期层。
//
// 用 ts-fsrs@6.0.0（MIT，依赖 @open-spaced-repetition/srs-kit，BSD-3）。
// 它要求 Node >= 24，本机 24.13.0 满足。
//
// ─────────────────────────────────────────────────────────────
// 为什么要有这一层，而不是直接在路由里调 ts-fsrs
// ─────────────────────────────────────────────────────────────
// ① **数据库 ↔ FSRS 的字段映射只有一处**，不会两边漂移。
// ② **两条线（receptive / productive）的语义收在这里**，见 DESIGN.md §2.2。
// ③ **踩过的坑集中在这里说明**（见下面 learning_steps 的注释）。
//
// ─────────────────────────────────────────────────────────────
// ⚠️ 一个会静默毁掉整个排期的坑：learning_steps 必须存
// ─────────────────────────────────────────────────────────────
// FSRS-6 的卡片状态里有一个 `learning_steps`（在第几个学习步）。
// 它是**调度状态的一部分，不是装饰**：丢掉它，卡片会永远卡在
// state=Learning，永远毕业不到 Review。
//
// 实测（同一串 Good 评分，间隔 0/0/0/1/3 天）：
//   保留 learning_steps：d0 Learning → d1 Review(2天) → 3天 → 7天 → 20天  ✅
//   丢掉 learning_steps：d0 Learning → d1 Learning → d2 Learning → …       ❌ 卡死
//
// 而且它**不会报错**，只会让所有词的间隔永远是 0 天。
// 所以 cards 表必须有 learning_steps 列，且每次往返都要带上。

import type { DatabaseSync } from 'node:sqlite'

/** 两条排期线之一。 */
export type Track = 'receptive' | 'productive'

/** 数据库行 → FSRS 卡片时用的卡片形态：在 ts-fsrs 的 Card 之外多带 elapsed_days（本项目自用）。 */
export interface ScheduleCard {
  due: Date
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  reps: number
  lapses: number
  state: number
  learning_steps: number
  last_review?: Date | undefined
}

/** 摊平回数据库列之后的排期行（写回 cards 表用）。 */
export interface ScheduleCardRow {
  due: number
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  reps: number
  lapses: number
  state: number
  learning_steps: number
  last_review: number
}

/** rowToCard 接受的数据库行（列可能缺失/为 NULL，取值时逐项兜底）。 */
export interface CardRowLike {
  due?: number | string | Date | null
  stability?: unknown
  difficulty?: unknown
  elapsed_days?: unknown
  scheduled_days?: unknown
  reps?: unknown
  lapses?: unknown
  state?: unknown
  learning_steps?: unknown
  last_review?: number | string | Date | null
}

/** cards 表整行（SELECT * 后按需取列；SQLite 行值外部未类型化，用手写接口描述用到的列）。 */
interface CardRow extends CardRowLike {
  id: number
  word_id: number
  track: string
  lapses: number
}

/** 到期队列查询的行。 */
interface DueQueueRow {
  id: number
  word_id: number
  track: string
  word: string
  phonetic: string | null
  translation: string | null
  freq_tier: string | null
  starred: number | null
  rec_state: number | null
  rec_reps: number | null
  sentence: string | null
  due: number
  state: number
  reps: number
  lapses: number
}

/** 到期队列里的一张卡（给学习页的扁平结构）。 */
export interface DueCard {
  cardId: number
  wordId: number
  track: string
  trackLabel: string
  word: string
  phonetic: string
  translation: string
  sentence: string
  freqTier: string
  starred: boolean
  due: number
  state: number
  reps: number
  lapses: number
  isNew: boolean
  overdueDays: number
}

/** 未来若干天的到期预测点。 */
export interface ForecastPoint {
  day: number
  date: number
  count: number
}

/** 一次评分的结果；失败时 code 让路由区分 404（not_found）与 500（engine）。 */
export type GradeResult =
  | { ok: false; code?: string; error: string }
  | {
      ok: true
      card: ScheduleCardRow & { id: unknown; track: unknown; leeched: boolean }
      log: unknown
      leeched: boolean
    }

/** 一个词两条线的当前状态（学习页展开单词时用）。 */
export interface CardStateEntry {
  id: number
  track: string
  trackLabel: string
  due: number
  state: number
  stateLabel: string
  reps: number
  lapses: number
  scheduledDays: number
  stability: number
  difficulty: number
  suspended: boolean
  leechCount: number | bigint
}

/** cards 表整行（cardStates 的 SELECT *）。 */
interface CardStateRow extends CardRowLike {
  id: number
  track: string
  due: number
  state: number
  reps: number
  lapses: number
  scheduled_days: number
  stability: number
  difficulty: number
  leech_count: number | null
  suspended: number | null
}

/** 本项目用到的 ts-fsrs 能力面（v6 的 legacy FSRS 入口；只声明用到的方法）。 */
export interface FsrsEngine {
  next(card: ScheduleCard, now: Date, grade: number): { card: Partial<ScheduleCard>; log: unknown }
  retrievability(card: ScheduleCard, now: Date, before: boolean): number
}

/** 可以直接绑进 SQL 的地方 ID（外部传入的原始值先窄到这里）。 */
type SqlBindable = string | number | bigint | null

/** FSRS-6 的 21 个默认参数（与 DESIGN.md §4 一致，三源交叉验证过）。 */
export const FSRS6_DEFAULT_W: number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]

/** 两条排期线。见 DESIGN.md §2.2：五维是画像，排期只有两条。 */
export const TRACKS: Track[] = ['receptive', 'productive']

export const TRACK_LABEL: Record<string, string> = {
  receptive: '认得出',
  productive: '写得出',
}

/** 评分档位。数字与 ts-fsrs 的 Rating 一致（1-4）。 */
export const RATING: Record<string, number> = { Again: 1, Hard: 2, Good: 3, Easy: 4 }

export const RATING_LABEL: Record<number, string> = {
  1: '忘了',
  2: '勉强',
  3: '记得',
  4: '太简单',
}

/**
 * leech（顽固词）阈值。
 *
 * Anki 默认是 8 次遗忘。DESIGN.md §6 提到"放弃率没有实证，只能靠工程手段"，
 * leech 是其中一条：一个词反复忘，继续按普通节奏喂只会消耗耐心。
 * 达到阈值就挂起，让它从队列里消失，等你手动处理。
 */
export const LEECH_THRESHOLD = 8

/** 每日上限。防止积压压垮人（DESIGN.md §6 的防积压手段之一）。 */
export const DAILY_NEW_LIMIT = 20
export const DAILY_REVIEW_LIMIT = 200

const DAY_MS = 86400000

let fsrsMod: typeof import('ts-fsrs') | null = null
let fsrsInstance: FsrsEngine | null = null
let fsrsError = ''

/**
 * 载入 ts-fsrs。失败不抛，而是记下错误让上层降级 ——
 * 排期不可用时整个学习页仍应能打开看报表。
 */
async function loadFsrs(): Promise<FsrsEngine | null> {
  if (fsrsInstance) return fsrsInstance
  if (fsrsError) return null
  try {
    fsrsMod = await import('ts-fsrs')
    fsrsInstance = fsrsMod.fsrs(
      fsrsMod.generatorParameters({
        w: FSRS6_DEFAULT_W,
        // 关闭 fuzz：模糊化会让"同一天查两次得到不同 due"，
        // 调试时极难判断对错。等排期稳定后再考虑打开。
        enable_fuzz: false,
        enable_short_term: true,
        request_retention: 0.9,
        maximum_interval: 36500,
      }),
    ) as unknown as FsrsEngine // ts-fsrs 的 Card 类型比本项目严格（state 用数字承载数据库值）
    return fsrsInstance
  } catch (err: any) {
    fsrsError = `载入 ts-fsrs 失败：${(err && err.message) || err}`
    return null
  }
}

export function scheduleStatus(): { ok: boolean; error: string } {
  return { ok: !!fsrsInstance, error: fsrsError }
}

/**
 * 预热排期引擎，让 `scheduleStatus()` 给出**真实**状态。
 *
 * 为什么需要：`loadFsrs()` 是懒加载的，没人评过分时 `fsrsInstance` 还是 null，
 * 这时问 `scheduleStatus()` 会得到 `ok:false` —— 界面就会显示"排期引擎不可用"，
 * 但实际完全能用（评一次分就正常了）。那是假警报，会误导用户以为坏了。
 *
 * 看板这种"只读展示"的入口应该先调它，把状态问准。
 * 载入失败不抛异常，照常返回，让报表仍能打开。
 */
export async function warmSchedule(): Promise<{ ok: boolean; error: string }> {
  try {
    await loadFsrs()
  } catch (err) {
    /* loadFsrs 内部已记录错误，这里保持静默 */
  }
  return scheduleStatus()
}

/**
 * 本地时区的"今天零点"。
 *
 * **不能用 UTC 零点**：用户在东八区，UTC 零点等于本地早上 8 点，
 * 那会让"今日复习"在早上 8 点突然换日 —— 明显不对。
 */
export function startOfLocalDay(ts = Date.now()): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本地时区第 n 天的零点。 */
export function dayStart(n = 0, from = Date.now()): number {
  const d = new Date(startOfLocalDay(from))
  d.setDate(d.getDate() + n)
  return d.getTime()
}

/** 把数据库行变成 FSRS 要的卡片对象。**必须带上 learning_steps**。 */
export function rowToCard(row: CardRowLike, now = Date.now()): ScheduleCard {
  return {
    due: new Date(row.due || now),
    stability: Number(row.stability) || 0,
    difficulty: Number(row.difficulty) || 0,
    elapsed_days: Number(row.elapsed_days) || 0,
    scheduled_days: Number(row.scheduled_days) || 0,
    reps: Number(row.reps) || 0,
    lapses: Number(row.lapses) || 0,
    state: Number(row.state) || 0,
    learning_steps: Number(row.learning_steps) || 0,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  }
}

/** 把 FSRS 的卡片对象摊平成数据库列。 */
export function cardToRow(card: Partial<ScheduleCard>, now = Date.now()): ScheduleCardRow {
  return {
    due: card.due ? new Date(card.due).getTime() : now,
    stability: card.stability || 0,
    difficulty: card.difficulty || 0,
    elapsed_days: card.elapsed_days || 0,
    scheduled_days: card.scheduled_days || 0,
    reps: card.reps || 0,
    lapses: card.lapses || 0,
    state: card.state || 0,
    learning_steps: card.learning_steps || 0,
    last_review: card.last_review ? new Date(card.last_review).getTime() : now,
  }
}

/**
 * 给一个词建两条线的卡片（若还没有）。
 *
 * 为什么两条都要建：receptive 从"查词"就有接触（弱信号），
 * productive 只有真正写对过才启动。两条独立排期，互不影响。
 *
 * 注意：productive 卡建出来只是**结构**，它要等 receptive 稳了才进队列
 * （见 `productiveReady` 与 `dueQueue`）。早先的实现漏了这一步：两张卡
 * 同时 due，队列里同一个词紧挨着出现两次。
 */
export function ensureCards(db: DatabaseSync, wordId: SqlBindable, now = Date.now()): Track[] {
  const created: Track[] = []
  for (const track of TRACKS) {
    const existing = db
      .prepare('SELECT id FROM cards WHERE word_id = ? AND track = ?')
      .get(wordId, track)
    if (existing) continue
    db.prepare(
      `INSERT INTO cards (word_id, track, due, stability, difficulty, elapsed_days,
                          scheduled_days, reps, lapses, state, learning_steps, last_review)
       VALUES (?,?,?,0,0,0,0,0,0,0,0,NULL)`,
    ).run(wordId, track, now)
    created.push(track)
  }
  return created
}

/**
 * receptive 稳到什么程度才让 productive 上线。
 *
 * 依据 DESIGN.md §2.2：阶段一（认得出）稳定后再进阶段二（写得出）。
 * 这里用 FSRS 自己的信号而不是五维分数——五维只有用户手动改或某条线评分时
 * 才动，拿它当闸门会让 productive 几乎永远不上线。
 *
 * 条件： receptive 已进入复习态（state>=2）且至少评过 2 次。
 * 反复评"忘了/勉强"的词会一直停在 learning（state=1），正好也该继续练认。
 */
export function productiveReady(
  receptive: { state?: unknown; reps?: unknown } | null | undefined,
): boolean {
  if (!receptive) return false
  return Number(receptive.state) >= 2 && Number(receptive.reps) >= 2
}

/**
 * 取当前到期的卡片队列。
 *
 * 两条规则决定"一个词这一轮会不会出现两次"：
 *   1. **没启动的 productive 卡不进队列**——它要等 receptive 稳了才上线，
 *      否则每个新词一进生词本就有两张 due=现在 的卡，背一个词要连做两遍。
 *   2. **一个词一轮只出现一次**——两条线都到期时先做更早到期的那张
 *      （同 due 时先做认得出），另一张留到下一轮。两天内各练一次，
 *      比连着做两遍更符合间隔重复。
 *
 * 新卡受 DAILY_NEW_LIMIT 限制 —— 这是防积压的关键闸门：
 * 一天塞 200 个新词，第二天就会放弃。
 */
export function dueQueue(
  db: DatabaseSync,
  { now = Date.now(), limit = DAILY_REVIEW_LIMIT }: { now?: number; limit?: number } = {},
): DueCard[] {
  const endOfToday = dayStart(1, now)

  // 多取一些再筛：同一个词可能有两张卡，dedupe 后才会接近 limit
  const rows = db
    .prepare(
      `SELECT c.*, w.word, w.phonetic, w.translation, w.freq_tier, w.starred,
              r.state AS rec_state, r.reps AS rec_reps,
              (SELECT ctx.sentence FROM contexts ctx
                WHERE ctx.word_id = c.word_id
                ORDER BY ctx.created_at DESC LIMIT 1) AS sentence
         FROM cards c
         JOIN words w ON w.id = c.word_id
         LEFT JOIN cards r ON r.word_id = c.word_id AND r.track = 'receptive'
        WHERE c.suspended = 0 AND w.graduated = 0
          AND c.due IS NOT NULL AND c.due < ?
        ORDER BY c.due ASC, CASE WHEN c.track = 'receptive' THEN 0 ELSE 1 END
        LIMIT ?`,
    )
    .all(endOfToday, Math.max(limit * 4, 200)) as unknown as DueQueueRow[]

  const out: DueCard[] = []
  const seenWords = new Set<number>()
  for (const r of rows) {
    // 规则 1：productive 线要等 receptive 稳了才上线（DESIGN.md §2.2 的阶段二）
    if (r.track === 'productive' && !productiveReady({ state: r.rec_state, reps: r.rec_reps })) {
      continue
    }
    // 规则 2：一个词一轮只出现一次
    if (seenWords.has(r.word_id)) continue
    seenWords.add(r.word_id)

    out.push({
      cardId: r.id,
      wordId: r.word_id,
      track: r.track,
      trackLabel: TRACK_LABEL[r.track] || r.track,
      word: r.word,
      phonetic: r.phonetic || '',
      translation: r.translation || '',
      // 最近一次遇见它的原句。补记循环拿它当提取线索：
      // 编码特异性说，提取线索越接近编码时的语境，越容易想起来。
      // 没有原句（老词/手动加的词）时为空串，前端降级成"看释义拼写"。
      sentence: r.sentence || '',
      freqTier: r.freq_tier || 'unknown',
      starred: !!r.starred,
      due: r.due,
      state: r.state,
      reps: r.reps,
      lapses: r.lapses,
      // 刚解锁的 productive 卡 reps=0，但词本身可能见过很多次，别标"新词"
      isNew: Number(r.reps) === 0 && r.track === 'receptive',
      // 没启动过的卡谈不上逾期
      overdueDays:
        Number(r.reps) === 0
          ? 0
          : Math.max(0, Math.floor((startOfLocalDay(now) - startOfLocalDay(r.due)) / DAY_MS)),
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 未来若干天的到期预测。用于"今日/明日复习"和报表曲线。
 *
 * 只统计**已经排期**的卡片；新卡不算进来（新卡是"可以学"，
 * 不是"到期"，混在一起会让明天的数字虚高）。
 *
 * 按**词**去重：两条线同一天到期，用户实际只需复习一次（见 dueQueue 的规则 2），
 * 不去重的话预测曲线会虚高一倍。
 */
export function forecast(
  db: DatabaseSync,
  { days = 14, now = Date.now() }: { days?: number; now?: number } = {},
): ForecastPoint[] {
  const out: ForecastPoint[] = []
  for (let i = 0; i < days; i++) {
    const from = dayStart(i, now)
    const to = dayStart(i + 1, now)
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT c.word_id) AS n FROM cards c JOIN words w ON w.id = c.word_id
          WHERE c.suspended = 0 AND w.graduated = 0 AND c.reps > 0
            AND c.due >= ? AND c.due < ?`,
      )
      .get(from, to) as { n: number }
    out.push({ day: i, date: from, count: row.n })
  }
  return out
}

/**
 * 应用一次评分，写回排期。
 *
 * 返回 { ok, card, log, leeched, error }。
 * `log` 是 FSRS 自己算出的复习日志，直接存下来 —— 将来做参数优化
 * （逐用户拟合 w）需要它，现在不优化但数据要先攒。
 */
export async function applyGrade(
  db: DatabaseSync,
  cardId: SqlBindable,
  rating: unknown,
  { now = Date.now() }: { now?: number } = {},
): Promise<GradeResult> {
  const f = await loadFsrs()
  // `code` 让路由能区分"客户端给错了 id"（404）和"引擎真的坏了"（500）。
  // 只靠 ok:false 的话，卡不存在会被报成 500，像是服务器故障。
  if (!f) return { ok: false, code: 'engine', error: fsrsError || '排期引擎不可用' }

  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as unknown as
    CardRow | undefined
  if (!row) return { ok: false, code: 'not_found', error: '找不到这张卡' }

  const card = rowToCard(row, now)
  const grade = Math.max(1, Math.min(4, Math.round(Number(rating) || 3)))

  let result: { card: Partial<ScheduleCard>; log: unknown }
  try {
    result = f.next(card, new Date(now), grade)
  } catch (err: any) {
    return { ok: false, error: `排期计算出错：${(err && err.message) || err}` }
  }

  const next = cardToRow(result.card, now)
  const lapses = row.lapses + (grade === RATING.Again ? 1 : 0)
  const leeched = lapses >= LEECH_THRESHOLD

  db.prepare(
    `UPDATE cards SET due=?, stability=?, difficulty=?, elapsed_days=?, scheduled_days=?,
                      reps=?, lapses=?, state=?, learning_steps=?, last_review=?,
                      leech_count=?, suspended=?
     WHERE id = ?`,
  ).run(
    next.due,
    next.stability,
    next.difficulty,
    next.elapsed_days,
    next.scheduled_days,
    next.reps,
    next.lapses,
    next.state,
    next.learning_steps,
    next.last_review,
    lapses,
    leeched ? 1 : 0,
    cardId,
  )

  // 复习日志：FSRS 的 log 已经算好了间隔与难度，直接存
  const log = result.log || {}
  db.prepare(
    `INSERT INTO review_log (card_id, word_id, rating, kind, evidence, elapsed_ms, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(cardId, row.word_id, grade, row.track, 'answer', 0, now)

  // 画像联动：答对推高对应维度，答错拉低。
  // 只动"这条线对应"的维度，不碰另一条线。
  const abilityColumn = row.track === 'productive' ? 'k_write' : 'k_recognize'
  const delta = grade === RATING.Again ? -1 : grade === RATING.Easy ? 2 : 1
  db.prepare(
    `UPDATE words SET ${abilityColumn} = MAX(0, MIN(5, ${abilityColumn} + ?)) WHERE id = ?`,
  ).run(delta, row.word_id)

  // receptive 刚稳下来 → 把同一词的 productive 线排上（明天开始）。
  // 不这样做的话，那张卡还停在建卡时的旧 due，一解锁就显示"拖了 N 天"。
  // 已经在排的（reps>0）不动，避免把用户练出来的间隔重置掉。
  if (row.track === 'receptive' && productiveReady({ state: next.state, reps: next.reps })) {
    db.prepare(
      `UPDATE cards SET due = ?
        WHERE word_id = ? AND track = 'productive' AND reps = 0 AND due < ?`,
    ).run(dayStart(1, now), row.word_id, dayStart(1, now))
  }

  return {
    ok: true,
    card: { ...next, id: cardId, track: row.track, leeched },
    log,
    leeched,
  }
}

/** 一个词两条线的当前状态（学习页展开单词时用）。 */
export function cardStates(db: DatabaseSync, wordId: SqlBindable): CardStateEntry[] {
  const rows = db
    .prepare('SELECT * FROM cards WHERE word_id = ?')
    .all(wordId) as unknown as CardStateRow[]
  return rows.map((r) => ({
    id: r.id,
    track: r.track,
    trackLabel: TRACK_LABEL[r.track] || r.track,
    due: r.due,
    state: r.state,
    stateLabel: ['新卡', '学习中', '复习中', '重学中'][r.state] || '未知',
    reps: r.reps,
    lapses: r.lapses,
    scheduledDays: r.scheduled_days,
    stability: r.stability,
    difficulty: r.difficulty,
    suspended: !!r.suspended,
    leechCount: r.leech_count || 0,
  }))
}

/**
 * 每个词当前的"记住概率"（FSRS 的 retrievability）。
 * 学习页用它显示"这个词你现在还记得多牢"。
 */
export async function retrievability(
  db: DatabaseSync,
  cardId: SqlBindable,
  now = Date.now(),
): Promise<number | null> {
  const f = await loadFsrs()
  if (!f) return null
  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as unknown as
    CardRow | undefined
  if (!row || !row.stability) return null
  try {
    return f.retrievability(rowToCard(row, now), new Date(now), false)
  } catch (err) {
    return null
  }
}
