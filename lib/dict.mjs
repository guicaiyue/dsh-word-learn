// dict.mjs —— 本地词典查询层。
//
// 数据来自 ECDICT（MIT），已由 scripts/build_dict.py 精简成 data/ecdict.db。
// 这一层只做"查一个词，返回它是什么"，不做任何学习/排期逻辑。
//
// 设计要点：
//   1. **变形回退**：划词划到的常是 perceived / children / better，
//      直接查原形查不到，必须走 forms 表反查 lemma。
//   2. **分级而非过滤**：用户说"感觉全是生词，但又好像没那么生词"，
//      所以入口不做筛选，但要给出"这词对你算不算生词"的判断依据
//      （词频 + 考试标签 + 柯林斯星级），由上层决定怎么用。
//   3. **惰性打开**：数据库只在第一次查询时打开，避免插件加载就占住文件句柄。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// node:sqlite 是内置模块；用 createRequire 同步取到，因为 lookup() 要同步返回。
const require = createRequire(import.meta.url)

const HERE = path.dirname(fileURLToPath(import.meta.url))

// data/ 与 lib/ 是兄弟目录；link 安装与铺平安装都要能找到
const DB_CANDIDATES = [
  path.join(HERE, '..', 'data', 'ecdict.db'),
  path.join(HERE, 'data', 'ecdict.db'),
]

// ECDICT 的 exchange 字段键 -> 中文名
// p=过去式 d=过去分词 i=现在分词 3=三单 r=比较级 t=最高级 s=复数
const EXCHANGE_LABELS = {
  p: '过去式',
  d: '过去分词',
  i: '现在分词',
  3: '第三人称单数',
  r: '比较级',
  t: '最高级',
  s: '复数',
}

// 考试标签 -> 展示名
const TAG_LABELS = {
  zk: '中考',
  gk: '高考',
  cet4: '四级',
  cet6: '六级',
  ky: '考研',
  ielts: '雅思',
  toefl: '托福',
  gre: 'GRE',
}

/**
 * 词频分级：把 bnc/frq 两个语料库排名合成一个"常见程度"。
 *
 * 为什么要合成而不是取其一：两个语料库覆盖面不同，单独看会有偏差
 * （有的词在 BNC 高、在当代语料库低）。取两者中较好的排名更稳健。
 *
 * 分档依据（不是精确科学，是给用户一个直觉）：
 *   前 1000    —— 几乎不可能是生词
 *   前 3000    —— 高中毕业水平
 *   前 8000    —— 四级/六级
 *   前 20000   —— 雅思/托福/GRE 区间
 *   更靠后      —— 专业或低频词
 */
export function frequencyTier(bnc, frq) {
  const ranks = [bnc, frq].filter((n) => Number.isFinite(n) && n > 0)
  if (!ranks.length) return { tier: 'unknown', rank: 0, label: '词频未知' }
  const rank = Math.min(...ranks)
  let tier, label
  if (rank <= 1000) {
    tier = 'top1k'
    label = '最高频 1000 词'
  } else if (rank <= 3000) {
    tier = 'top3k'
    label = '高频 3000 词内'
  } else if (rank <= 8000) {
    tier = 'top8k'
    label = '常见 8000 词内'
  } else if (rank <= 20000) {
    tier = 'top20k'
    label = '进阶 20000 词内'
  } else {
    tier = 'rare'
    label = '低频 / 专业词'
  }
  return { tier, rank, label }
}

/** 解析 exchange 字段，返回 [{key, label, value}]。 */
function parseExchange(raw) {
  if (!raw) return []
  const out = []
  for (const part of String(raw).split('/')) {
    const index = part.indexOf(':')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!value || key === '0' || key === '1') continue
    const label = EXCHANGE_LABELS[key]
    if (!label) continue
    out.push({ key, label, value })
  }
  return out
}

/** 把 ECDICT 的释义文本整理成结构化条目。 */
function parseTranslation(raw) {
  if (!raw) return []
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // 形如 "n. 解析, 决心" 或 "[计] 图形分辨率"
      const m = /^([a-z]+\.)\s*(.+)$/i.exec(line)
      if (m) return { pos: m[1], text: m[2] }
      const bracket = /^\[([^\]]+)\]\s*(.+)$/.exec(line)
      if (bracket) return { pos: '', domain: bracket[1], text: bracket[2] }
      return { pos: '', text: line }
    })
}

export class Dictionary {
  constructor() {
    this.db = null
    this.dbPath = ''
    this.error = ''
  }

  /** 惰性打开数据库。返回是否可用。 */
  open() {
    if (this.db) return true
    if (this.error) return false

    let target = ''
    for (const candidate of DB_CANDIDATES) {
      try {
        if (fs.existsSync(candidate)) {
          target = candidate
          break
        }
      } catch (err) {
        /* 试下一个 */
      }
    }
    if (!target) {
      this.error = `找不到词典数据库。请先运行 scripts/build_dict.py 生成 data/ecdict.db`
      return false
    }

    try {
      // node:sqlite 是 Node 22+ 的实验特性，用动态 import 以便优雅降级
      const { DatabaseSync } = require('node:sqlite')
      this.db = new DatabaseSync(target, { readOnly: true })
      this.dbPath = target
      return true
    } catch (err) {
      this.error = `打不开词典数据库：${(err && err.message) || err}`
      return false
    }
  }

  /** 精确查一个词（不做变形回退）。 */
  #lookupExact(word) {
    return this.db
      .prepare(
        `SELECT word, lemma, phonetic, translation, definition, pos, collins, oxford,
                tag, bnc, frq, exchange, audio
           FROM dict WHERE word = ?`,
      )
      .get(word)
  }

  /** 用变形表反查原形。 */
  #lookupLemma(form) {
    const row = this.db.prepare(`SELECT word FROM forms WHERE form = ?`).get(form)
    return row ? row.word : ''
  }

  /**
   * 查词。返回 null 表示词典里没有。
   *
   * **关于变形回退**（这一步比看上去重要）：
   * ECDICT 把很多变形词**单独立条**，但它们自己的词频字段往往是错的。
   * 实测 `children`：它自己 bnc=23840（判成"低频"），而原形 `child` bnc=114（最高频）。
   * `better` 自己 bnc=704，原形 `good` bnc=73。
   *
   * 直接返回精确匹配，就会把 children / better / running 这类**最常见不过的词**
   * 判成"生词"——正好撞上用户"感觉全是生词"的抱怨。
   *
   * 所以规则是：**只要命中的条目带 lemma（说明它本身是变形），就改用原形词条**，
   * 词频、标签、星级全部继承原形；它自己的释义仍放在 `asForm` 里备查。
   */
  lookup(query) {
    if (!this.open()) return null
    const raw = String(query || '')
      .trim()
      .toLowerCase()
    if (!raw) return null

    let row = this.#lookupExact(raw)
    let matchedBy = 'exact'
    let asForm = null

    // 情形一：命中的条目自己声明了原形（children -> 0:child）
    if (row && row.lemma) {
      const base = this.#lookupExact(row.lemma)
      if (base) {
        asForm = {
          word: row.word,
          phonetic: row.phonetic || '',
          senses: parseTranslation(row.translation),
        }
        row = base
        matchedBy = 'lemma'
      }
    }

    // 情形二：没命中 —— 走 forms 表反查（perceived -> perceive）
    if (!row) {
      const lemma = this.#lookupLemma(raw)
      if (lemma) {
        const base = this.#lookupExact(lemma)
        if (base) {
          row = base
          matchedBy = 'form'
        }
      }
    }

    if (!row) return null

    const tags = String(row.tag || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => ({ key: t, label: TAG_LABELS[t] || t.toUpperCase() }))

    const frequency = frequencyTier(Number(row.bnc) || 0, Number(row.frq) || 0)

    return {
      word: row.word,
      query: raw,
      matchedBy,
      asForm,
      phonetic: row.phonetic || '',
      senses: parseTranslation(row.translation),
      definition: String(row.definition || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      forms: parseExchange(row.exchange),
      tags,
      frequency,
      collins: Number(row.collins) || 0,
      oxford: Number(row.oxford) || 0,
      pos: String(row.pos || ''),
      audio: row.audio || '',
    }
  }

  /**
   * 词频是否"够常见，大概率不是生词"。
   * 这是给用户的判断依据，不是自动过滤——用户明确说入口不要筛。
   */
  isLikelyKnown(info) {
    if (!info) return false
    const { tier } = info.frequency
    if (tier === 'top1k') return true
    // 高频 + 有柯林斯星级 = 基本是熟词
    if (tier === 'top3k' && info.collins >= 3) return true
    return false
  }

  stats() {
    if (!this.open()) return { ok: false, error: this.error }
    const words = this.db.prepare('SELECT COUNT(*) AS n FROM dict').get().n
    const forms = this.db.prepare('SELECT COUNT(*) AS n FROM forms').get().n
    return { ok: true, words, forms, path: this.dbPath }
  }

  close() {
    if (this.db) {
      try {
        this.db.close()
      } catch (err) {
        /* 关闭失败不影响退出 */
      }
      this.db = null
    }
  }
}

export { TAG_LABELS, EXCHANGE_LABELS }
