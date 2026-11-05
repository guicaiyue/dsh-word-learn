// store/words.mjs —— 生词本、原句、AI 元数据、义项材料与补记线索的读写。
//
// 从 lib/store.mjs 拆出来的第一等职责：words / contexts / sense_meta 的查询与写入。
// 所有函数都接收 Store 实例（而不是裸 db 句柄），因为「先 open() 再取 store.db」
// 是用户库原语的一部分，拆开后不能两边各判一次打开状态。
//
// SQL 仍然只写在这里（CONVENTIONS §6.2）：路由 / 排期模块不要新增表级写入。
import type { DatabaseSync } from 'node:sqlite'

import { ensureCards } from '../schedule.js'

/** 用户库原语的最小能力：先 open() 再取 db（words/review/settings 各自描述一次，避免类型环）。 */
export interface StoreLike {
  open(): boolean
  db?: DatabaseSync | null
  error?: string
}

/** touch 的入参：查词结果（字段都可缺，进来后逐项兜底）。 */
export interface WordInfo {
  word?: string
  phonetic?: string
  pos?: string
  tags?: Array<{ key?: string }>
  senses?: unknown
  frequency?: { rank?: number; tier?: string } | null
  collins?: number
}

/** touch 的结果。 */
export interface TouchResult {
  word_id: number
  isNew: boolean
  seenCount: number
  error?: string
}

/** 五维能力画像。 */
export interface WordAbility {
  recognize: number
  meaning: number
  write: number
  listen: number
  pronounce: number
}

/** 一条原句。 */
export interface WordContext {
  sentence: string
  source: string
  createdAt: number
}

/** AI 分析的词级元数据（word_meta JSON 的结构）。 */
export interface WordMeta {
  roots?: Array<{ part?: string; type?: string; meaning?: string }>
  synonyms?: string[]
  distractors?: string[]
  mnemonic?: string
  confusables?: string[]
  analyzedAt?: number
  [key: string]: unknown
}

/** 义项级学习材料（sense_meta.json 的结构）。 */
export interface SenseMeta {
  sense_here?: string
  sense_key?: string
  model?: string
  personal_example?: string
  other_sense?: { sentence?: string; gloss?: string } | null
  gloss?: string
  [key: string]: unknown
}

/** 对外的词档案（hydrate 的产物）。 */
export interface WordRecord {
  id: number
  word: string
  phonetic: string
  translation: string
  pos: string
  tag: string
  freqTier: string
  collins: number
  starred: boolean
  graduated: boolean
  note: string
  seenCount: number
  createdAt: number
  seenAt: number | null
  knownSenses: unknown
  wordMeta: unknown
  ability: WordAbility
  contexts: WordContext[]
}

/** 生词本列表的参数。 */
export interface WordListOptions {
  limit?: number
  offset?: number
  tier?: string
  starredOnly?: boolean
  order?: string
}

/** 生词本列表的结果。 */
export interface WordListResult {
  items: WordRecord[]
  total: number
  error?: string
}

/** 改画像/收藏/笔记的补丁（值类型由 update 内部逐个判定）。 */
export interface WordPatch {
  ability?: Record<string, number>
  starred?: unknown
  note?: unknown
  graduated?: unknown
  knownSenses?: unknown
  wordMeta?: unknown
}

/** words 表整行（hydrate 用到的列）。 */
interface WordRow {
  id: number
  word: string
  phonetic: string | null
  translation: string | null
  pos: string | null
  tag: string | null
  freq_tier: string | null
  collins: number | null
  starred: number | null
  graduated: number | null
  note: string | null
  seen_count: number | null
  created_at: number
  seen_at: number | null
  known_senses: string | null
  word_meta: string | null
  k_recognize: number | null
  k_meaning: number | null
  k_write: number | null
  k_listen: number | null
  k_pronounce: number | null
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
export function touch(store: StoreLike, info: WordInfo, sentence: unknown): TouchResult {
  if (!store.open()) return { word_id: 0, isNew: false, seenCount: 0, error: store.error }
  const db = store.db!
  const now = Date.now()
  const word = String(info.word || '').toLowerCase()
  if (!word) return { word_id: 0, isNew: false, seenCount: 0, error: '空词' }

  const existing = db
    .prepare('SELECT id, seen_count FROM words WHERE word = ?')
    .get(word) as unknown as { id: number; seen_count: number } | undefined

  let wordId: number
  let isNew = false
  if (existing) {
    wordId = existing.id
    db.prepare(
      `UPDATE words SET seen_count = seen_count + 1, seen_at = ?,
         phonetic = COALESCE(NULLIF(?, ''), phonetic),
         translation = COALESCE(NULLIF(?, ''), translation)
       WHERE id = ?`,
    ).run(now, info.phonetic || '', sensesToText(info.senses), wordId)
  } else {
    isNew = true
    const result = db
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
    const dup = db
      .prepare('SELECT id FROM contexts WHERE word_id = ? AND sentence = ?')
      .get(wordId, text)
    if (!dup) {
      db.prepare(
        'INSERT INTO contexts (word_id, sentence, source, created_at) VALUES (?,?,?,?)',
      ).run(wordId, text, 'chat', now)
    }
  }

  // 弱信号：看过就算一次接触
  db.prepare('INSERT INTO review_log (word_id, kind, evidence, created_at) VALUES (?,?,?,?)').run(
    wordId,
    'recognize',
    'view',
    now,
  )

  // 建两条排期线。
  //
  // 为什么查词时就建：查过 = 第一次接触（receptive 线开始排期），
  // 而 productive 线建好但**不排期**（reps=0，不进复习队列），
  // 等用户真的写对过才开始。这样"今天该复习什么"不会因为
  // 只查过一次就冒出来，但将来要用时结构已经在了。
  ensureCards(db, wordId, now)

  const count = db.prepare('SELECT seen_count FROM words WHERE id = ?').get(wordId) as unknown as
    { seen_count: number } | undefined
  return { word_id: wordId, isNew, seenCount: count ? count.seen_count : 1 }
}

/** 取一个词的完整档案（含原句）。 */
export function get(store: StoreLike, word: unknown): WordRecord | null {
  if (!store.open()) return null
  const db = store.db!
  const row = db
    .prepare('SELECT * FROM words WHERE word = ?')
    .get(String(word || '').toLowerCase()) as unknown as WordRow | undefined
  if (!row) return null
  return hydrate(db, row)
}

export function getById(store: StoreLike, id: number): WordRecord | null {
  if (!store.open()) return null
  const db = store.db!
  const row = db.prepare('SELECT * FROM words WHERE id = ?').get(id) as unknown as
    WordRow | undefined
  return row ? hydrate(db, row) : null
}

/** 把 words 表的原始行拼成对外的词档案（原句、JSON 字段、五维画像）。 */
function hydrate(db: DatabaseSync, row: WordRow): WordRecord {
  const contexts = db
    .prepare(
      'SELECT sentence, source, created_at FROM contexts WHERE word_id = ? ORDER BY created_at DESC LIMIT 20',
    )
    .all(row.id) as Array<{ sentence: string; source: string; created_at: number }>
  let knownSenses: unknown
  try {
    knownSenses = JSON.parse(row.known_senses || '[]')
  } catch (err) {
    knownSenses = []
  }
  let wordMeta: unknown
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
export function list(
  store: StoreLike,
  {
    limit = 200,
    offset = 0,
    tier = '',
    starredOnly = false,
    order = 'recent',
  }: WordListOptions = {},
): WordListResult {
  if (!store.open()) return { items: [], total: 0, error: store.error }
  const db = store.db!
  const where: string[] = []
  const params: Array<string | number> = []
  if (tier) {
    where.push('freq_tier = ?')
    params.push(tier)
  }
  if (starredOnly) where.push('starred = 1')
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const orderBy =
    order === 'alpha' ? 'word ASC' : order === 'freq' ? 'frq ASC' : 'seen_at DESC NULLS LAST'

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM words ${clause}`).get(...params) as { n: number }
  ).n
  const rows = db
    .prepare(`SELECT * FROM words ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as WordRow[]
  return { items: rows.map((r) => hydrate(db, r)), total }
}

/** 改画像 / 收藏 / 笔记。P2 起答题会调用它。 */
export function update(store: StoreLike, word: unknown, patch: WordPatch = {}): boolean {
  if (!store.open()) return false
  const db = store.db!
  const row = db
    .prepare('SELECT id FROM words WHERE word = ?')
    .get(String(word).toLowerCase()) as unknown as { id: number } | undefined
  if (!row) return false
  const sets: string[] = []
  const params: Array<string | number> = []
  const abilityMap: Record<string, string> = {
    recognize: 'k_recognize',
    meaning: 'k_meaning',
    write: 'k_write',
    listen: 'k_listen',
    pronounce: 'k_pronounce',
  }
  for (const [key, column] of Object.entries(abilityMap)) {
    if (typeof patch.ability?.[key] === 'number') {
      sets.push(`${column} = ?`)
      params.push(Math.max(0, Math.min(5, Math.round(patch.ability![key]))))
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
  db.prepare(`UPDATE words SET ${sets.join(', ')} WHERE id = ?`).run(...params)
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
export function setMeta(store: StoreLike, word: unknown, meta: unknown): boolean {
  if (!store.open()) return false
  const db = store.db!
  const row = db
    .prepare('SELECT id FROM words WHERE word = ?')
    .get(String(word).toLowerCase()) as unknown as { id: number } | undefined
  if (!row) return false
  db.prepare('UPDATE words SET word_meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id)
  return true
}

/** 取一个词的 AI 元数据（解析后的对象，或 null）。 */
export function getMeta(store: StoreLike, word: unknown): WordMeta | null {
  if (!store.open()) return null
  const db = store.db!
  const row = db
    .prepare('SELECT word_meta FROM words WHERE word = ?')
    .get(String(word).toLowerCase()) as unknown as { word_meta: string | null } | undefined
  if (!row || !row.word_meta) return null
  try {
    return JSON.parse(row.word_meta)
  } catch {
    return null
  }
}

/** 批量取 word_meta（复习队列预热用）。返回 { word: meta } 映射。 */
export function getMetaBatch(store: StoreLike, words: unknown[]): Record<string, unknown> {
  if (!store.open() || !words.length) return {}
  const db = store.db!
  const out: Record<string, unknown> = {}
  // SQLite 绑定变量有上限，分批
  const batch = 50
  for (let i = 0; i < words.length; i += batch) {
    const slice = words.slice(i, i + batch)
    const placeholders = slice.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT word, word_meta FROM words WHERE word IN (${placeholders})`)
      .all(...slice.map((w) => String(w).toLowerCase())) as Array<{
      word: string
      word_meta: string | null
    }>
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
export function setSenseMeta(store: StoreLike, word: unknown, meta: SenseMeta): boolean {
  if (!store.open()) return false
  const db = store.db!
  const row = db
    .prepare('SELECT id FROM words WHERE word = ?')
    .get(String(word).toLowerCase()) as unknown as { id: number } | undefined
  if (!row) return false
  const key = String(meta.sense_here || '').slice(0, 80)
  if (!key) return false
  db.prepare(
    `INSERT INTO sense_meta (word_id, sense_key, json, model, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(word_id, sense_key) DO UPDATE SET
       json = excluded.json, model = excluded.model, created_at = excluded.created_at`,
  ).run(row.id, key, JSON.stringify(meta), meta.model || '', Date.now())
  return true
}

/** 取这个词最近一次义项分析（解析后的对象，或 null）。 */
export function getSenseMeta(store: StoreLike, word: unknown): SenseMeta | null {
  if (!store.open()) return null
  const db = store.db!
  const row = db
    .prepare(
      `SELECT sm.json FROM sense_meta sm JOIN words w ON w.id = sm.word_id
        WHERE w.word = ? ORDER BY sm.created_at DESC LIMIT 1`,
    )
    .get(String(word).toLowerCase()) as unknown as { json: string | null } | undefined
  if (!row || !row.json) return null
  try {
    return JSON.parse(row.json)
  } catch {
    return null
  }
}

/** 最近一次遇见这个词的句子（补记卡的提取线索）。 */
export function latestSentence(store: StoreLike, word: unknown): string {
  if (!store.open()) return ''
  const db = store.db!
  const row = db
    .prepare(
      `SELECT c.sentence FROM contexts c JOIN words w ON w.id = c.word_id
        WHERE w.word = ? ORDER BY c.created_at DESC LIMIT 1`,
    )
    .get(String(word).toLowerCase()) as unknown as { sentence: string | null } | undefined
  return (row && row.sentence) || ''
}

/**
 * 随机取其他词的释义（用于选择题干扰项兜底）。
 * 排除指定词本身，每条取第一行释义。
 */
export function randomTranslations(store: StoreLike, excludeWord: unknown, count = 6): string[] {
  if (!store.open()) return []
  const db = store.db!
  const rows = db
    .prepare(
      `SELECT translation FROM words
        WHERE word != ? AND translation != '' AND translation IS NOT NULL
        ORDER BY RANDOM() LIMIT ?`,
    )
    .all(String(excludeWord).toLowerCase(), count) as Array<{ translation: string | null }>
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
export function remove(store: StoreLike, word: unknown): boolean {
  if (!store.open()) return false
  const db = store.db!
  const row = db
    .prepare('SELECT id FROM words WHERE word = ?')
    .get(String(word).toLowerCase()) as unknown as { id: number } | undefined
  if (!row) return false
  db.prepare('DELETE FROM words WHERE id = ?').run(row.id)
  return true
}

/** 把 senses 数组压成一行文本存库（展示时再拆）。 */
function sensesToText(senses: unknown): string {
  if (!Array.isArray(senses)) return ''
  return senses
    .map((s) => (s.pos ? `${s.pos} ${s.text}` : s.domain ? `[${s.domain}] ${s.text}` : s.text))
    .join('\n')
}
