// r5.mjs —— P2：R5 次日回访（义项判别）+ 义项地图。
//
// ─────────────────────────────────────────────────────────────
// 为什么单独一层，而不是塞进 store.mjs / index.js
// ─────────────────────────────────────────────────────────────
// ① store.mjs 是「表结构 + 原语」，它不该知道「昨天回访」这种产品规则；
//    index.js 是路由层，路由应该薄。R5 怎么选词、怎么配同义/异义、判分后
//    怎么动债，全收在这一个文件里 —— 以后要把回访改成 3 天后，只动这里。
// ② 这两件事都是「只读推导 + 只写补记表」，独立成模块才能用临时 DSH_HOME
//    单测（scripts/test-r5.mjs），不用起宿主。
//
// ─────────────────────────────────────────────────────────────
// 三条硬约束（DESIGN.md §10，改代码前先读）
// ─────────────────────────────────────────────────────────────
// 1. **不调用 applyGrade、不动 cards 表**：评级只评「第一次无提示提取」。
//    R5 答对/答错都不改 FSRS 状态，否则调度器会把「次日认出来了」当成
//    「当时就记得」，把间隔拉长。
// 2. **不写 review_log**：那是唯一的真值信号，补记事件只进 repair_log。
// 3. **材料不全就跳过**：没有 sense_meta、没有异义句、没有可用原句的词
//    直接不出题。学习页宁可没有回访，也不能弹一道没法判断的题。
//
// ─────────────────────────────────────────────────────────────
// 「昨天」怎么算
// ─────────────────────────────────────────────────────────────
// 复用 lib/schedule.mjs 的 dayStart()：本地时区第 n 天零点。
// **不要用 UTC 零点**（用户在东八区，UTC 零点 = 本地早上 8 点换日），
// 也不要自己算 86400000 的倍数 —— 跨夏令时/时区一改就错。
// 「昨天」= [dayStart(-1, now), dayStart(0, now))。
//
// ─────────────────────────────────────────────────────────────
// R5 什么时候停（2026-11-05 修掉的自我续期 bug）
// ─────────────────────────────────────────────────────────────
// 旧实现的候选条件是「昨天 repair_log 任意 stage 有记录」。R5 自己写的就是
// stage='tomorrow' —— 于是一个词只要进过一次回访，昨天那条 tomorrow 又会让
// 它今天再进候选，答对清债也不会停，每天必出题。
//
// 现在候选分两类证据：
//   A. 「昨天真的补记过」：stage IN ('pick','spell','session_end') → 明天回访一次。
//   B. 「昨天开过债 / 昨天回访过」：只有**还没结束**才继续追：
//        · 仍有今天零点之前开的未清债（今天新开的债不算，那是今天主队列的账），或
//        · 最近一次回访没答对（ok<>1，包括只看没答的 NULL）。
//
// 终止条件 = **债已清 且 最近一次回访答对**。
// 补充：今天已经回访过的词今天不再问（否则刷新会无限重复）；
//       今天主队列新开的债不影响今天的回访，明天它自然变成「昨天开的债」。
//
// ─────────────────────────────────────────────────────────────
// 出题规则（同义 / 异义各占一半）
// ─────────────────────────────────────────────────────────────
// R5 要问的是义项分辨，不是「这句什么意思」：
//   · same = true ：s1 = 原句，s2 = sense_meta.personal_example（同一义项）
//   · same = false：s1 = 原句，s2 = sense_meta.other_sense.sentence（另一义项）
// 若答案恒为「不同」，用户闭着眼点「不是」就能全对，题就废了。所以奇数题时
// 同义多一题（ceil），且**出题前先打散词序**，避免前几个词永远是同义。
//
// s1 优先取「sense_meta 生成之前最近的一条可用原句」：sense_here 属于生成
// 材料那一刻的原句，之后同词在新语境出现时，最新原句可能已经是另一个义项。
// 可用 = 非空且不是「只有单词本身」（P1 前划词卡片把选中文本当原句的老记录）。
// 整词都没有可用原句就**跳过**，不用 personal_example 顶替 s1 —— 否则
// same=true 时会变成「同一句话和自己比」，题目自相矛盾。

import { dayStart } from './schedule.mjs'

/** R5 在 repair_log 里的阶段标记。与 store.mjs 的注释一致。 */
export const RECAP_STAGE = 'tomorrow'

/** 补记事件里允许的两个答案取值。 */
export const RECAP_GUESS = { same: 'same', diff: 'diff' }

/** 默认一次回访几道题。设计稿是 3–5 道（design/forgot-repair-loop.md §6）。 */
const DEFAULT_LIMIT = 5

/** 上限：再多就不是「回访」而是加练了，会推高放弃率。 */
const MAX_LIMIT = 20

// ---------------------------------------------------------------- 小工具

/** 只留字母的小写形式，用来判断「这句话是不是只有单词本身」。 */
function letters(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
}

/** 是不是纯数字串（senseMap 允许直接传 word_id 做调试）。 */
function isDigits(s) {
  if (!s) return false
  for (const ch of s) {
    if (ch < '0' || ch > '9') return false
  }
  return true
}

/**
 * 这句话能不能当 R5 的 s1（原句）。
 *
 * 拒绝三种：空串、只有标点、整句等于单词本身（老版划词卡把选中文本当原句）。
 * 返回规范化后的原句；不可用返回空串。
 */
function usableSentence(sentence, word) {
  const s = String(sentence || '').trim()
  if (!s) return ''
  const bare = letters(s)
  if (!bare) return ''
  const w = letters(word)
  if (w && bare === w) return ''
  return s
}

/** 解析 sense_meta.json。坏 JSON 当没有材料，不抛。 */
function readSenseJson(raw) {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : null
  } catch (err) {
    return null
  }
}

/** Fisher–Yates。只用于打散题意，不影响「同/异义各半」的配额。 */
function shuffle(list) {
  const arr = list.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

/** 取这个词的首选卡（拿不到债务卡时的兜底）。receptive 优先，与 ensureCards 一致。 */
function firstCardId(db, wordId) {
  const row = db
    .prepare(
      `SELECT id FROM cards WHERE word_id = ?
        ORDER BY CASE track WHEN 'receptive' THEN 0 ELSE 1 END, id
        LIMIT 1`,
    )
    .get(Number(wordId))
  return row ? Number(row.id) : 0
}

// ---------------------------------------------------------------- 选词

/**
 * 候选词：昨天有过「补记」证据，或者昨天那笔回访还该继续，且今天还没回访过。
 *
 * 证据与终止条件见文件头「R5 什么时候停」那一节。这里逐条对应：
 *   ① stage IN ('pick','spell','session_end') 落在昨天
 *      → 直接进候选（昨天真走了一遍补记，值得次日再看一眼）；
 *   ② 昨天开过债，或昨天回访过 → 只有「还有未清债（今天零点前开的）」
 *      或「最近一次回访没答对」才继续；债已清 + 最近一次答对 = 终止；
 *   ③ 今天已经有 stage='tomorrow' 的日志 → 今天不再追问。
 *
 * 「今天零点前开的未清债」这个上界很关键：今天主队列刚 Again 开的债是今天的账，
 * 明天它才会变成「昨天开的债」，不能拿它当今天的回访理由。
 */
const CANDIDATE_SQL = `
SELECT w.id AS wordId, w.word AS word,
       d.card_id AS debtCardId,
       d.opened_at AS openedAt,
       (SELECT c.id FROM cards c WHERE c.word_id = w.id
         ORDER BY CASE c.track WHEN 'receptive' THEN 0 ELSE 1 END, c.id
         LIMIT 1) AS anyCardId
  FROM words w
  LEFT JOIN repair_debt d ON d.word_id = w.id
 WHERE (
         -- ① 昨天真的补记过
         EXISTS (
              SELECT 1 FROM repair_log r
               WHERE r.word_id = w.id
                 AND r.stage IN ('pick', 'spell', 'session_end')
                 AND r.created_at >= ? AND r.created_at < ?
            )
         -- ② 昨天开过债 / 昨天回访过：只在「还没结束」时继续
         OR (
              (
                (d.opened_at IS NOT NULL AND d.opened_at >= ? AND d.opened_at < ?)
                OR EXISTS (
                     SELECT 1 FROM repair_log t
                      WHERE t.word_id = w.id AND t.stage = 'tomorrow'
                        AND t.created_at >= ? AND t.created_at < ?
                   )
              )
              AND (
                -- 仍有今天零点之前开的未清债
                (d.opened_at IS NOT NULL AND d.cleared_at IS NULL AND d.opened_at < ?)
                -- 或者最近一次回访没答对（NULL = 只看没答，也算没结束）
                OR COALESCE((
                     SELECT t2.ok FROM repair_log t2
                      WHERE t2.word_id = w.id AND t2.stage = 'tomorrow'
                      ORDER BY t2.created_at DESC, t2.id DESC LIMIT 1
                   ), -1) <> 1
              )
            )
       )
   -- ③ 今天已经回访过，今天不再追问
   AND NOT EXISTS (
         SELECT 1 FROM repair_log td
          WHERE td.word_id = w.id
            AND td.stage = 'tomorrow'
            AND td.created_at >= ?
       )
 ORDER BY COALESCE(d.opened_at, 0) DESC, w.id
 LIMIT ?`

/**
 * 取一个词最近一次义项材料 + 一条可用原句。
 *
 * 返回 null 表示这个词凑不出 R5 的题。
 */
function buildMaterial(db, row) {
  // 最近一次义项材料就是 /repair 用的那份（store.getSenseMeta 同口径）
  const senseRow = db
    .prepare(
      `SELECT json, created_at AS createdAt FROM sense_meta WHERE word_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(row.wordId)
  const sense = readSenseJson(senseRow && senseRow.json)
  if (!sense) return null

  const personal = String(sense.personal_example || '').trim()
  const other =
    sense.other_sense && typeof sense.other_sense === 'object' ? sense.other_sense : null
  const otherSentence = String((other && other.sentence) || '').trim()
  // 两个义项各要一句才配得出「同义/异义」；缺一个就跳过（约束 3）
  if (!personal || !otherSentence) return null

  /** 在若干条 context 里挑第一条可用的（最新的在前）。 */
  const firstUsable = (rows) => {
    for (const ctx of rows) {
      const usable = usableSentence(ctx.sentence, row.word)
      if (usable) return usable
    }
    return ''
  }

  let s1 = ''
  // ① 优先：材料生成之前最近的一条原句（见文件头注释）
  if (Number(senseRow.createdAt)) {
    s1 = firstUsable(
      db
        .prepare(
          `SELECT sentence FROM contexts WHERE word_id = ? AND created_at <= ?
            ORDER BY created_at DESC, id DESC LIMIT 8`,
        )
        .all(row.wordId, Number(senseRow.createdAt)),
    )
  }
  // ② 兜底：材料比所有原句都早（比如先分析了、之后才存句子），退回最新可用
  if (!s1) {
    s1 = firstUsable(
      db
        .prepare(
          `SELECT sentence FROM contexts WHERE word_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 8`,
        )
        .all(row.wordId),
    )
  }
  if (!s1) return null

  // 债务卡优先：答错时要把债重新开在「同一张卡」上，track 才不会漂移。
  const cardId = Number(row.debtCardId) || Number(row.anyCardId) || 0
  if (!cardId) return null

  return {
    wordId: Number(row.wordId),
    cardId,
    word: String(row.word || ''),
    s1,
    personal,
    other: otherSentence,
    senseHere: String(sense.sense_here || '').trim(),
    otherGloss: String(other.gloss || '').trim(),
  }
}

// ---------------------------------------------------------------- 对外接口

/**
 * 生成「昨日回访」的判别题。
 *
 * @param {object} store  lib/store.mjs 的 Store 实例
 * @param {object} [opts]
 * @param {number} [opts.limit=5]  最多几题。缺省用 5；给了数字才 floor 并夹到 1–20
 * @param {number} [opts.now]      测试注入用的时间戳；默认 Date.now()
 * @returns {{ trials: Array<{wordId:number, cardId:number, word:string,
 *   s1:string, s2:string, same:boolean, senseHere:string, otherGloss:string}> }}
 *
 * 失败一律返回 { trials: [] } —— 回访拿不到题就静默进主队列，绝不让学习页报错。
 */
export function buildRecap(store, opts = {}) {
  const empty = { trials: [] }
  try {
    if (!store || !store.open()) return empty
    const db = store.db
    if (!db) return empty

    // 参数解析：缺省单独判断，不要用 `|| 默认值`（那会把 0 也当缺省）
    const rawLimit = Number(opts.limit)
    const want = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)))
      : DEFAULT_LIMIT
    const rawNow = Number(opts.now)
    const now = Number.isFinite(rawNow) && rawNow > 0 ? rawNow : Date.now()

    const yFrom = dayStart(-1, now)
    const yTo = dayStart(0, now)
    const todayFrom = yTo

    // 多取一些候选：中间会有「没有义项材料 / 没有原句」被筛掉。
    const candidates = db
      .prepare(CANDIDATE_SQL)
      .all(yFrom, yTo, yFrom, yTo, yFrom, yTo, todayFrom, todayFrom, Math.max(want * 4, 20))

    // 材料筛选是逐词查询（N+1），取够 want*2 就早停：回访要快，
    // 没必要为了 5 道题把昨天所有候选词的 sense_meta/contexts 全读一遍。
    const pool = []
    for (const row of candidates) {
      const material = buildMaterial(db, row)
      if (material) pool.push(material)
      if (pool.length >= want * 2) break
    }
    if (!pool.length) return empty

    const total = Math.min(want, pool.length)
    // 先打散词序再切配额：否则「前一半同义、后一半异义」会跟词的顺序绑定
    const picked = shuffle(pool).slice(0, total)
    // 奇数题时同义多一题：宁可多问「同一个意思」，也别让答案恒为「不是」
    const sameCount = Math.ceil(total / 2)

    const trials = picked.map((material, index) => {
      const same = index < sameCount
      return {
        wordId: material.wordId,
        cardId: material.cardId,
        word: material.word,
        s1: material.s1,
        s2: same ? material.personal : material.other,
        same,
        senseHere: material.senseHere,
        otherGloss: material.otherGloss,
      }
    })

    // 出题顺序打散：配额固定，但同义题不能一题接一题地连着出现。
    return { trials: shuffle(trials) }
  } catch (err) {
    // 只读推导失败就当没有回访（约束 3）
    return empty
  }
}

/**
 * 收一次 R5 的答案。
 *
 * 语义：
 *   · 只写 repair_log(stage='tomorrow')，不碰 review_log / cards；
 *   · 答对 → 清「昨天及更早开的」债（今天主队列刚开的债不动）；
 *   · 答错 → 重新开债（openRepairDebt），今天不再追问，明天再回访。
 *
 * 两个工程约束（2026-11-05 补）：
 *   ① **擦除边界**：清债用直接 SQL 带上 opened_at < 今天零点的上界。不能调
 *      store.clearRepairDebt —— 它无条件清，会把「今天主队列刚 Again 开的债」
 *      静默销掉，等于替用户把今天的遗忘涂掉。
 *   ② **幂等 + 事务**：同一个词+卡+当天只写一条 tomorrow 日志；重复提交
 *      （双击/重试）只更新那一条，不再动债（否则 opened_at/tries 会被刷新）。
 *      logRepair + 债变更包在 BEGIN IMMEDIATE / COMMIT 里，中途失败整体回滚。
 *
 * @param {object} store
 * @param {object} payload
 * @param {number} payload.wordId      必填
 * @param {number} [payload.cardId]    缺省按 wordId 找首选卡
 * @param {boolean} payload.ok         是否答对；undefined/null 表示只看过没答（不改编债）
 * @param {'same'|'diff'|'different'} [payload.guess] 他选了什么
 * @param {number} [payload.elapsedMs]
 * @param {number} [payload.now]       测试注入用的时间戳；默认 Date.now()
 * @returns {{ logged:boolean, cleared:boolean, opened:boolean, duplicate:boolean }}
 */
export function submitRecap(store, payload = {}) {
  const fail = { logged: false, cleared: false, opened: false, duplicate: false }
  try {
    if (!store || !store.open()) return fail
    const db = store.db
    if (!db) return fail

    const wordId = Number(payload.wordId) || 0
    if (!wordId) return fail

    const rawGuess = String(payload.guess || '').toLowerCase()
    const guess =
      rawGuess === 'same'
        ? RECAP_GUESS.same
        : rawGuess === 'diff' || rawGuess === 'different'
          ? RECAP_GUESS.diff
          : ''

    const answered = payload.ok !== undefined && payload.ok !== null
    const correct = answered && !!payload.ok

    const rawNow = Number(payload.now)
    const now = Number.isFinite(rawNow) && rawNow > 0 ? rawNow : Date.now()
    const todayFrom = dayStart(0, now)

    let cardId = Number(payload.cardId) || 0
    if (!cardId) cardId = firstCardId(db, wordId)
    const cardKey = cardId || 0

    // 幂等键：wordId + cardId（NULL 当 0）+ 今天。只认今天，跨天是新的一次回访。
    const existing = db
      .prepare(
        `SELECT id FROM repair_log
          WHERE word_id = ? AND stage = ? AND created_at >= ?
            AND IFNULL(card_id, 0) = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(wordId, RECAP_STAGE, todayFrom, cardKey)

    let logged = false
    let cleared = false
    let opened = false
    const duplicate = false

    db.exec('BEGIN IMMEDIATE')
    try {
      // —— 重试路径：只把答案刷新到已有那条上，债保持第一次处理后的状态。
      //    这样双击不会多一行日志，也不会把债务的 opened_at/tries 再刷一遍。
      if (existing) {
        db.prepare(
          `UPDATE repair_log SET ok = ?, guess = ?, elapsed_ms = ?, created_at = ? WHERE id = ?`,
        ).run(
          answered ? (correct ? 1 : 0) : null,
          guess,
          Math.max(0, Number(payload.elapsedMs) || 0),
          now,
          existing.id,
        )
        db.exec('COMMIT')
        return { logged: true, cleared: false, opened: false, duplicate: true }
      }

      // —— 首答路径
      logged = !!store.logRepair({
        wordId,
        cardId: cardId || null,
        stage: RECAP_STAGE,
        ok: answered ? correct : null,
        guess,
        elapsedMs: payload.elapsedMs,
      })
      // 日志没写进去就什么都不做：先落日志再动债，避免「债清了但没有记录」
      if (!logged) {
        db.exec('ROLLBACK')
        return fail
      }

      if (answered) {
        if (correct) {
          // 直接 SQL：带 opened_at 上界，只清今天零点之前开的债。
          const info = db
            .prepare(
              `UPDATE repair_debt SET cleared_at = ?
                WHERE word_id = ? AND cleared_at IS NULL AND opened_at < ?`,
            )
            .run(now, wordId, todayFrom)
          cleared = Number(info.changes) > 0
        } else if (cardId) {
          opened = !!store.openRepairDebt(cardId)
        }
      }

      db.exec('COMMIT')
      return { logged, cleared, opened, duplicate }
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackErr) {
        /* 事务已经结束就忽略 */
      }
      return fail
    }
  } catch (err) {
    return fail
  }
}

/**
 * 义项地图：这个词见过的义项 + 每个义项的状态。
 *
 * 状态来自 repair_log 的 pick 阶段（「这句里是哪个义项」四选一）：
 *   seen  —— 见过这个义项（有材料，但没有判别记录）
 *   right —— 最近一次判别答对了
 *   wrong —— 最近一次判别答错了
 *
 * 归属规则：pick 的成败归给「created_at <= pick.created_at 的最新一条材料」。
 * 为什么不是无条件归给最新材料：pick 之后可能又生成了新材料（别的语境），
 * 把旧判别算到新义项上是张冠李戴。
 * pick.ok 为 NULL（只看了没答）不算答错，归 seen。
 *
 * ⚠️ repair_log 没有 sense_key 列（不能改 schema），所以只能按时间就近归属，
 * 这是近似口径，别当成精确的义项级统计。
 *
 * @param {object} store
 * @param {string|number} word  单词（小写不敏感；传数字当 word_id 用）
 * @returns {Array<{senseKey:string, gloss:string, status:'seen'|'right'|'wrong'}>}
 */
export function senseMap(store, word) {
  try {
    if (!store || !store.open()) return []
    const db = store.db
    if (!db) return []

    const raw = String(word == null ? '' : word).trim()
    if (!raw) return []

    // 允许直接传 word_id（前端只会传单词，这里给调试/测试留个口子）
    const wordRow = isDigits(raw)
      ? db.prepare('SELECT id, word FROM words WHERE id = ?').get(Number(raw))
      : db.prepare('SELECT id, word FROM words WHERE word = ?').get(raw.toLowerCase())
    if (!wordRow) return []

    const rows = db
      .prepare(
        `SELECT sense_key AS senseKey, json AS json, created_at AS createdAt
           FROM sense_meta WHERE word_id = ?
          ORDER BY created_at DESC, id DESC`,
      )
      .all(wordRow.id)
    if (!rows.length) return []

    // 最近一次义项判别（同一义项多次就取最近一次）
    const pick = db
      .prepare(
        `SELECT ok, created_at AS createdAt FROM repair_log
          WHERE word_id = ? AND stage = 'pick'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(wordRow.id)

    // 按时间就近归属（见函数头注释）
    let pickKey = ''
    let pickStatus = 'seen'
    if (pick) {
      const owner = rows.find((row) => Number(row.createdAt) <= Number(pick.createdAt))
      if (owner) {
        pickKey = String(owner.senseKey || '')
        // NULL 只代表「看了没答」，不能算答错
        pickStatus =
          pick.ok === null || pick.ok === undefined ? 'seen' : pick.ok ? 'right' : 'wrong'
      }
    }

    const out = []
    const seen = new Set()
    for (const row of rows) {
      const key = String(row.senseKey || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      const json = readSenseJson(row.json) || {}
      const gloss = String(json.sense_here || key).trim()
      out.push({
        senseKey: key,
        gloss,
        status: key === pickKey ? pickStatus : 'seen',
      })
    }
    return out
  } catch (err) {
    return []
  }
}
