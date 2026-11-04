// enrich.mjs —— 外部增强层：英文例句、同义词、音标。
//
// 数据源：dictionaryapi.dev（免费、无需 key、无需注册）。
//
// 三条硬约束（都是踩过的坑）：
//   1. **不能挡住主流程**：外部接口随时可能挂，查词必须能在没有网络时正常出结果。
//      所以这里全部包 try/catch，失败就返回空，由前端降级。
//   2. **要有缓存**：同一个词反复查会反复打外部接口，既慢又不礼貌。
//      缓存放内存（进程内），并设上限防止无限增长。
//   3. **要有超时**：不设超时的话一个卡住的请求会拖住整个查词响应。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const API_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en'
const TIMEOUT_MS = 6000
const CACHE_MAX = 500

// 磁盘缓存：跨进程重启也能命中，避免每次启动都重新拉
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CACHE_DIR = path.join(DSH_HOME, 'dsh-word-learn', 'cache')

const memory = new Map()

function cacheKey(word) {
  return String(word || '').toLowerCase()
}

function readDiskCache(word) {
  try {
    const file = path.join(CACHE_DIR, `${cacheKey(word).replace(/[^a-z0-9-]/g, '_')}.json`)
    if (!fs.existsSync(file)) return null
    // 30 天过期：词义基本不变，但别让缓存永久占着
    const stat = fs.statSync(file)
    if (Date.now() - stat.mtimeMs > 30 * 24 * 3600 * 1000) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return null
  }
}

function writeDiskCache(word, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const file = path.join(CACHE_DIR, `${cacheKey(word).replace(/[^a-z0-9-]/g, '_')}.json`)
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
  } catch (err) {
    /* 缓存写失败不影响功能 */
  }
}

/** 带超时的 fetch。 */
async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'dsh-word-learn/0.1' },
    })
    if (!res.ok) return null
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 dictionaryapi.dev 的返回里抽出我们要的东西。
 *
 * 该接口返回的是"一个词的全部词性条目"，结构很深。这里只取：
 *   - 音标
 *   - 例句（每个词性取前 2 条，带释义，够用就好）
 *   - 同义词（去重取前 8 个）
 */
function extract(entries) {
  if (!Array.isArray(entries) || !entries.length) return null

  const phonetics = []
  const examples = []
  const synonyms = new Set()

  for (const entry of entries) {
    for (const p of entry.phonetics || []) {
      if (p.text) phonetics.push(p.text)
    }

    for (const meaning of entry.meanings || []) {
      const pos = meaning.partOfSpeech || ''
      for (const def of meaning.definitions || []) {
        for (const s of def.synonyms || []) {
          if (s && s !== entry.word) synonyms.add(s)
        }
        if (def.example && examples.length < 8) {
          examples.push({ pos, text: def.example, definition: def.definition || '' })
        }
      }
      for (const s of meaning.synonyms || []) {
        if (s && s !== entry.word) synonyms.add(s)
      }
    }
  }

  // 去重音标
  const uniquePhonetics = [...new Set(phonetics)]

  return {
    phonetic: uniquePhonetics[0] || '',
    phonetics: uniquePhonetics.slice(0, 3),
    examples: examples.slice(0, 6),
    synonyms: [...synonyms].slice(0, 8),
  }
}

/**
 * 取一个词的例句与同义词。**永远不抛异常**——失败返回空结构。
 * `{ ok, examples, synonyms, cached, error }`
 */
export async function enrich(word) {
  const key = cacheKey(word)
  if (!key) return { ok: false, examples: [], synonyms: [], error: '空词' }

  if (memory.has(key)) {
    return { ...memory.get(key), cached: 'memory' }
  }

  const disk = readDiskCache(key)
  if (disk) {
    memory.set(key, disk)
    if (memory.size > CACHE_MAX) memory.delete(memory.keys().next().value)
    return { ...disk, cached: 'disk' }
  }

  try {
    const entries = await fetchJson(`${API_BASE}/${encodeURIComponent(key)}`)
    const data = extract(entries)
    if (!data) {
      // 词典里没有这个词（专有名词、拼写错误等）——记住"没有"，别反复问
      const empty = { ok: false, examples: [], synonyms: [], error: '外部词典无此词' }
      writeDiskCache(key, empty)
      memory.set(key, empty)
      return empty
    }
    const result = { ok: true, ...data }
    writeDiskCache(key, result)
    memory.set(key, result)
    if (memory.size > CACHE_MAX) memory.delete(memory.keys().next().value)
    return result
  } catch (err) {
    const message =
      err && err.name === 'AbortError' ? '请求超时' : (err && err.message) || String(err)
    return { ok: false, examples: [], synonyms: [], error: message }
  }
}

/** 批量预热（可选，用于复习页）。并发限制在 3，别把接口打爆。 */
export async function enrichMany(words) {
  const out = {}
  const queue = [...new Set(words.map(cacheKey).filter(Boolean))]
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const word = queue.shift()
      out[word] = await enrich(word)
    }
  })
  await Promise.all(workers)
  return out
}

export { CACHE_DIR as ENRICH_CACHE_DIR }
