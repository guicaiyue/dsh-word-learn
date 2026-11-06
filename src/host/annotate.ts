// annotate.mjs —— P3 正文标注的「目标词表」。
//
// 标注层是纯前端 DOM 功能，但它要知道"哪些词用户正在学"。这个文件只做一件事：
// 从用户库（$DSH_HOME/dsh-word-learn/user.db）里取出**有卡片、没毕业、没挂起**的词，
// 连同"首义"和"最近一次义项分析"一起返回。挂路由是 index.js 的事。
//
// 设计取舍（为什么不是「全库生词」）：
//   - 生词本里的词分两种状态：查过但没进排期（卡片 reps=0）、真正在学。
//     全库都标会把每段英文变成虚线地毯 —— 标注的价值是"复现正在学的词"，
//     不是"高亮所有不认识的词"。
//   - 所以这里 INNER JOIN cards：没有卡片就不标。卡片被 leech 挂起
//     （suspended=1）或词已毕业（graduated=1）也不标 —— 这两个状态出现时
//     用户已经不需要在正文里被提醒了。
//
// 契约（Lead 按这个挂 GET /dsh-word-learn/annotate/words）：
//   annotateWordList(store, { limit = 2000, minSeen = 0 })
//     -> { ok: true,  words: [{ w, t, s, c }], rev, total, truncated }
//     -> { ok: false, error }        // 查询失败：不带 words，前端必须保留旧词表
//   w = 小写原形词
//   t = 首义（translation 的第一段；没有则 ''）
//   s = 该词最近一次 sense_meta.sense_here（没有则 ''；前端回退到 t）
//   c = 代表卡片 id（优先 receptive 线；没有卡片 0，但本函数不会返回这类词）
//   rev = 词表内容版本号（任意字符串）。前端用它判断"要不要重拉 + 重标"，
//         所以**任何会改变标注内容或词集的写入**都必须让它变：
//         词集 / translation / phonetic / graduated / seen_count /
//         卡片 suspended / 评分状态 / 义项 JSON。
//   total = 命中过滤条件的词总数（不受 limit 影响）；truncated = total > words.length
//          （前端可选提示"只标了最近 N 个在学词"）。
//
// 为什么 s 只有一个值：sense_meta 是按 sense_key（义项文本）存的，没有反过来
// 记"哪句话对应哪条"。v1 取最近一条并在悬停卡上标明是"最近义项"；
// v2 可以给 sense_meta 补 sentence 列做句子级匹配（见 design 文档演进路线）。

import type { DatabaseSync } from 'node:sqlite'

/** 查询失败时返回的结构：不带 words（前端据此保留旧词表）。 */
export interface AnnotateFailure {
  ok: false
  error: string
}

/** 标注词表里的一行：w=原形词 t=首义 s=最近义项 c=代表卡片 id。 */
export interface AnnotateWord {
  w: string
  t: string
  s: string
  c: number
}

/** 取「在学」词表成功的结果。 */
export interface AnnotateOk {
  ok: true
  words: AnnotateWord[]
  rev: string
  total: number
  truncated: boolean
}

export type AnnotateResult = AnnotateOk | AnnotateFailure

/** 只读用户库用到的最小能力（store.ts 的 Store 满足它）。 */
export interface AnnotateStoreLike {
  open(): boolean
  db?: DatabaseSync | null
  error?: string
}

/** annotateWordList 的可选参数（用户输入的原始值，进来后再归一并钳制）。 */
export interface AnnotateOptions {
  limit?: unknown
  minSeen?: unknown
}

/** words 表的内容投影行（rev 用）。 */
interface WordRevRow {
  n: number
  wlen: number
  tlen: number
  plen: number
  grad: number
  seenCnt: number
  seen: number
  lastId: number
}

/** cards 表的内容投影行（rev 用）。 */
interface CardRevRow {
  n: number
  susp: number
  reps: number
  lapses: number
  state: number
  reviewed: number
  lastId: number
}

/** sense_meta 表的内容投影行（rev 用）。 */
interface SenseRevRow {
  n: number
  created: number
  jlen: number
}

/** 词表查询的行。 */
interface PickRow {
  wid: number
  word: string | null
  translation: string | null
  card_id: number | null
}

/** 最近义项查询的行。 */
interface SenseRow {
  wid: number
  json: string | null
}

const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 5000

// 只按换行切：`v. 收费；充电` 是同一个义项里的多个释义，不该被切掉。
// 用码点而不是正则：这个项目里正则字面量的转义已经出过事故，能不用反斜杠就不用。
const SENSE_SEPS = [10, 13]

/**
 * 取 translation 的第一段作为「首义」。
 *
 * translation 的入库形态是 `n. 收费；指控\nv. 充电`（sensesToText 的产物），
 * 第一行通常就是最常用的义项。这里只截断，不改写：前端要展示的是词典原文。
 */
function firstSense(translation: unknown): string {
  const text = String(translation || '')
  let end = text.length
  for (let i = 0; i < text.length; i += 1) {
    if (SENSE_SEPS.indexOf(text.charCodeAt(i)) >= 0) {
      end = i
      break
    }
  }
  return text.slice(0, end).trim()
}

/** sense_meta.json 里取 sense_here；坏 JSON / 空值都静默降级成 ''。 */
function senseHereOf(json: unknown): string {
  if (!json) return ''
  try {
    const obj = JSON.parse(String(json))
    if (!obj || typeof obj !== 'object') return ''
    const sense = obj.sense_here
    if (typeof sense === 'string') return sense.trim().slice(0, 120)
    return ''
  } catch (err) {
    return ''
  }
}

/**
 * limit 归一化：缺省 2000；其余先 Number → NaN 走缺省，
 * 再 floor → clamp(1, 5000)。负数夹到 1、Infinity 夹到 5000（旧实现两者都会落回缺省）。
 */
function normalizeLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT
  const n = Number(raw)
  if (Number.isNaN(n)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT)
}

/**
 * 词表版本号（内容投影）。
 *
 * 为什么不用 mtime：user.db 是 WAL 模式，读操作也会改 -wal 文件，
 * 拿文件时间当版本会每几秒变一次，前端会疯狂重标。
 *
 * 旧实现只投影了 count/max(id)/max(seen_at)/max(created_at)，漏掉三类会改变
 * 标注内容的写入（审查报告 2026-11-04 第 3 节）：
 *   - words.translation：touch() 补全释义时只有"该词恰好是 max(seen_at)"rev 才变，
 *     其它词补释义 rev 不变 → 悬停卡长期显示旧义项；
 *   - words.graduated / seen_count：UPDATE 不碰 seen_at；
 *   - cards.suspended / reps / state：非评分路径改挂起时 last_review 不变。
 * 现在改成内容投影：长度和 + 计数 + 求和 + 最大值。这些都是 O(表大小) 的廉价聚合，
 * 31 词/62 卡片/1 义项时开销可以忽略；5000 词量级也仍是一条 SQL。
 *
 * 已知边界：translation 改成长度相同的另一段文字不会改 rev（SQLite 没有内置 hash）。
 * 这种改写在本项目里不存在（释义要么补全变长、要么整段替换变长度）。
 */
function revisionOf(db: DatabaseSync): string {
  const w = db
    .prepare(
      `SELECT COUNT(*) AS n,
              IFNULL(SUM(IFNULL(LENGTH(word), 0)), 0) AS wlen,
              IFNULL(SUM(IFNULL(LENGTH(translation), 0)), 0) AS tlen,
              IFNULL(SUM(IFNULL(LENGTH(phonetic), 0)), 0) AS plen,
              IFNULL(SUM(IFNULL(graduated, 0)), 0) AS grad,
              IFNULL(SUM(IFNULL(seen_count, 0)), 0) AS seenCnt,
              IFNULL(MAX(seen_at), 0) AS seen,
              IFNULL(MAX(id), 0) AS lastId
         FROM words`,
    )
    .get() as unknown as WordRevRow
  const c = db
    .prepare(
      `SELECT COUNT(*) AS n,
              IFNULL(SUM(IFNULL(suspended, 0)), 0) AS susp,
              IFNULL(SUM(IFNULL(reps, 0)), 0) AS reps,
              IFNULL(SUM(IFNULL(lapses, 0)), 0) AS lapses,
              IFNULL(SUM(IFNULL(state, 0)), 0) AS state,
              IFNULL(MAX(last_review), 0) AS reviewed,
              IFNULL(MAX(id), 0) AS lastId
         FROM cards`,
    )
    .get() as unknown as CardRevRow
  const s = db
    .prepare(
      `SELECT COUNT(*) AS n,
              IFNULL(MAX(created_at), 0) AS created,
              IFNULL(SUM(IFNULL(LENGTH(json), 0)), 0) AS jlen
         FROM sense_meta`,
    )
    .get() as unknown as SenseRevRow
  return [
    w.n,
    w.wlen,
    w.tlen,
    w.plen,
    w.grad,
    w.seenCnt,
    w.seen,
    w.lastId,
    c.n,
    c.susp,
    c.reps,
    c.lapses,
    c.state,
    c.reviewed,
    c.lastId,
    s.n,
    s.created,
    s.jlen,
  ].join('.')
}

const PICK_SQL = `SELECT w.id            AS wid,
                         w.word          AS word,
                         w.translation   AS translation,
                         MIN(c.id)       AS card_id
                    FROM words w
                    JOIN cards c ON c.word_id = w.id
                   WHERE IFNULL(w.graduated, 0) = 0
                     AND IFNULL(c.suspended, 0) = 0
                     AND IFNULL(w.seen_count, 0) >= ?
                   GROUP BY w.id
                   ORDER BY w.created_at DESC, w.id DESC
                   LIMIT ?`

/**
 * 取「在学」词表。
 *
 * @param store Store 实例（store.ts）。只读，不写库。
 * @param {object} [opts]
 * @param {number} [opts.limit=2000] 词表上限；正文标注不需要全库，2000 条约 200KB JSON。
 * @param {number} [opts.minSeen=0]   可选：只取见过 >= N 次的词（v2 灰度用）。
 * @returns {{ok:true, words:Array<{w:string,t:string,s:string,c:number}>, rev:string, total:number, truncated:boolean}
 *          | {ok:false, error:string}}
 */
export function annotateWordList(
  store: AnnotateStoreLike | null | undefined,
  opts: AnnotateOptions = {},
): AnnotateResult {
  if (!store || typeof store.open !== 'function') {
    return { ok: false, error: '用户库不可用' }
  }
  let opened: boolean
  try {
    opened = store.open()
  } catch (err: any) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
  if (!opened) return { ok: false, error: store.error || '用户库打不开' }
  const db = store.db
  if (!db) return { ok: false, error: '用户库未连接' }

  const limit = normalizeLimit(opts.limit)
  const minSeen = Math.max(0, Number(opts.minSeen) || 0)

  try {
    const rev = revisionOf(db)
    // 过滤后的总词数：LIMIT 之前算，供前端提示"只标了最近 N 个"。
    const total = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT w.id
               FROM words w
               JOIN cards c ON c.word_id = w.id
              WHERE IFNULL(w.graduated, 0) = 0
                AND IFNULL(c.suspended, 0) = 0
                AND IFNULL(w.seen_count, 0) >= ?
              GROUP BY w.id
           )`,
        )
        .get(minSeen)!.n,
    )

    // 一个词最多两条卡片（receptive / productive）。每组取 MIN(id) 作为代表卡片：
    // 不用窗口函数，避免老 SQLite 兼容问题。排序：最近加入的词优先。
    const rows = db.prepare(PICK_SQL).all(minSeen, limit) as unknown as PickRow[]

    if (!rows.length) {
      return { ok: true, words: [], rev, total, truncated: false }
    }

    // 最近义项：只对选中的词取，每词一条（created_at DESC, id DESC 决定同毫秒多行），
    // 不再扫全库 sense_meta、也不对每行 JSON.parse（审查报告第 3 条）。
    // 相关子查询按 idx_sense_word(word_id, created_at DESC) 走，等于每词一次索引查找。
    const placeholders = rows.map(() => '?').join(',')
    const senseRows = db
      .prepare(
        `SELECT sm.word_id AS wid, sm.json AS json
           FROM sense_meta sm
          WHERE sm.word_id IN (${placeholders})
            AND sm.id = (
                  SELECT sm2.id
                    FROM sense_meta sm2
                   WHERE sm2.word_id = sm.word_id
                   ORDER BY sm2.created_at DESC, sm2.id DESC
                   LIMIT 1
                )`,
      )
      .all(...rows.map((row) => row.wid)) as unknown as SenseRow[]
    const senseByWord = new Map<number, string>()
    for (const row of senseRows) {
      const sense = senseHereOf(row.json)
      if (sense) senseByWord.set(row.wid, sense)
    }

    const words = rows.map((row) => ({
      w: String(row.word || '').toLowerCase(),
      t: firstSense(row.translation),
      s: senseByWord.get(row.wid) || '',
      c: Number(row.card_id) || 0,
    }))
    return { ok: true, words, rev, total, truncated: total > words.length }
  } catch (err: any) {
    // 查询失败不能伪装成"空词表"：空表会让前端清空整页标注。
    // 返回 ok:false（不带 words），前端据此保留旧词表与已有标注、只重试。
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

export default { annotateWordList }
