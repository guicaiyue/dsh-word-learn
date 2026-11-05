/* dsh-word-learn —— 标注层的纯文本函数（构建源码，ESM）。
 *
 * 原先在注入脚本 assets/annotate.js 的「第一部分：纯函数（无 DOM，可单测）」。
 * 拆出来只为一件事：这些函数不碰 DOM，单测（tests/features/annotate.test.mjs）可以直接
 * import，不需要搭 DOM 桩，也不需要先注入脚本。
 *
 * 约束：纯函数 —— 只吃字符串/数字、返回结构；不读 document/window、不发请求。
 */
import { CONFIG } from './config.js'

function isUpperCode(code) {
  return code >= 65 && code <= 90
}
function isLowerCode(code) {
  return code >= 97 && code <= 122
}
function isLetterCode(code) {
  return isUpperCode(code) || isLowerCode(code)
}
function isDigitCode(code) {
  return code >= 48 && code <= 57
}

// 撇号：' (39) 与 ’ (8217)。不用正则/转义，直接比码点。
const APOSTROPHE_1 = 39
const APOSTROPHE_2 = 8217

/**
 * 把一段纯文本切成"英文 token"。
 *
 * 为什么手写扫描而不是正则 split：这个项目里正则字面量的反斜杠已经出过事故
 * （工具把 \n 写成 \\n），而这里只是"字母 + 撇号"的连续段，手写更稳、可控。
 * 撇号只在后面还跟字母时才并进 token（don't / model's 不拆）。
 */
// 非 ASCII 的"字母"：拉丁扩展（résumé、naïve）、希腊/西里尔、组合音标等。
// 用来识别"这个词只是某个非 ASCII 单词被切出来的一截"。
// CJK（>= 0x4E00）不算：中文紧贴英文（这是model）是常见排版，不能因此跳过英文词。
// 标点/空白也不算：不换行空格、软连字符、— – “ ” 等邻接不能把正常英文词判成残片。
function isNonAsciiLetter(code) {
  if (code <= 127) return false
  if (code === 160 || code === 173) return false // NBSP / soft hyphen
  if (code >= 0x2000 && code <= 0x206f) return false // 通用标点（含 — – “ ” ‘ ’）
  if (code >= 0x2e00 && code <= 0x2e7f) return false // 补充标点
  return code < 0x2e80
}

// 撇号归一化：U+2019 与 U+02BC 统一成 ASCII 单引号，保证 "don't" 能命中词表。
export function normalizeApostrophes(text) {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    out += code === 8217 || code === 700 ? String.fromCharCode(39) : text.charAt(i)
  }
  return out
}

export function tokenize(text) {
  const out = []
  const n = text.length
  let i = 0
  while (i < n) {
    const code = text.charCodeAt(i)
    if (!isLetterCode(code)) {
      i += 1
      continue
    }
    let j = i + 1
    let camel = false
    while (j < n) {
      const c = text.charCodeAt(j)
      if (isLetterCode(c)) {
        if (isUpperCode(c) && isLowerCode(text.charCodeAt(j - 1))) camel = true
        j += 1
        continue
      }
      if (c === APOSTROPHE_1 || c === APOSTROPHE_2) {
        const next = j + 1 < n ? text.charCodeAt(j + 1) : 0
        if (isLetterCode(next)) {
          j += 1
          continue
        }
      }
      break
    }
    const before = i > 0 ? text.charCodeAt(i - 1) : 0
    const after = j < n ? text.charCodeAt(j) : 0
    out.push({
      start: i,
      end: j,
      raw: text.slice(i, j),
      camel: camel,
      foreign: isNonAsciiLetter(before) || isNonAsciiLetter(after),
    })
    i = j
  }
  return out
}

/**
 * 一个 token 可能的原形候选（用于匹配"有卡片"的词）。
 *
 * v1 只做规则化词形还原：复数/过去式/进行时/所有格/副词。
 * 为什么敢做：候选只是"拿去查词表"，查不到就没有任何副作用；
 * 而漏掉 charged/charges 会让标注覆盖率明显变差。
 */
export function lemmaCandidates(lower) {
  // 弯撇号先归一化：don’t 与 don't 必须命中同一张词表。
  const normalized = normalizeApostrophes(String(lower || ''))
  const out = [normalized]
  let word = normalized
  // 所有格：model's -> model
  if (word.length > 2) {
    const tail2 = word.slice(-2)
    if (tail2 === "'s" || tail2 === String.fromCharCode(8217) + 's') {
      word = word.slice(0, -2)
      out.push(word)
    }
  }
  if (word.length > 2) {
    const last = word.charAt(word.length - 1)
    if (last === 's') {
      out.push(word.slice(0, -1))
      if (word.length > 3 && word.slice(-2) === 'es') out.push(word.slice(0, -2))
      if (word.length > 3 && word.slice(-3) === 'ies') out.push(word.slice(0, -3) + 'y')
    }
    if (word.slice(-2) === 'ed') {
      out.push(word.slice(0, -2))
      out.push(word.slice(0, -1))
      const doubled = word.slice(0, -2)
      if (
        doubled.length > 1 &&
        doubled.charAt(doubled.length - 1) === doubled.charAt(doubled.length - 2)
      ) {
        out.push(doubled.slice(0, -1))
      }
    }
    if (word.slice(-3) === 'ing') {
      out.push(word.slice(0, -3))
      const stem = word.slice(0, -3)
      if (stem.length > 1 && stem.charAt(stem.length - 1) === stem.charAt(stem.length - 2)) {
        out.push(stem.slice(0, -1))
      }
      out.push(word.slice(0, -3) + 'e')
    }
    if (word.slice(-2) === 'ly') out.push(word.slice(0, -2))
    if (word.slice(-2) === 'er') out.push(word.slice(0, -2))
    if (word.slice(-3) === 'est') out.push(word.slice(0, -3))
  }
  // 去重 + 长度门槛
  const seen = {}
  const deduped = []
  for (let i = 0; i < out.length; i += 1) {
    const cand = out[i]
    if (!cand || cand.length < CONFIG.MIN_WORD_LEN || cand.length > CONFIG.MAX_WORD_LEN) continue
    if (seen[cand]) continue
    seen[cand] = 1
    deduped.push(cand)
  }
  return deduped
}

// token 两侧的"标识符邻接字符"：这些字符紧贴 token 时说明它在一个
// 路径/URL/标识符/版本号里，不是自然语言单词。
const GLUE_BEFORE = [47, 92, 95, 64, 35, 36, 37, 38, 61, 43, 60, 62, 126, 94, 58]
function isGlueCode(code) {
  if (isDigitCode(code)) return true
  return GLUE_BEFORE.indexOf(code) >= 0
}

/**
 * token 是否像"自然语言里的一个词"（不是代码/路径/URL 的一部分）。
 *
 * 这里只做"邻接字符 + 形状"判断，不做词典判断：真正的门槛是"在用户的卡片词表里"。
 * 规则逐条对应已知噪音来源：
 *   - src/lib/index.js → index 前后是 / 和 .，跳过
 *   - https://api.example.com → 前后是 : / .，跳过
 *   - config_path → 下划线邻接，跳过
 *   - getElementById → 驼峰，跳过
 *   - API / HTTP → 全大写，跳过
 *   - v24.13.0 → 数字邻接，跳过
 *   - v24 / 3D → 数字邻接，跳过
 */
export function isPlainWord(text, token) {
  const raw = token.raw
  if (raw.length < CONFIG.MIN_WORD_LEN || raw.length > CONFIG.MAX_WORD_LEN) return false
  if (token.camel) return false
  // 残缺词：紧邻非 ASCII 字母（résumé 里被切出的 "sum"），绝不能当英文单词标。
  if (token.foreign) return false
  // 全大写（长度 >= 2）多半是缩写
  const letters = raw.replace(/[^A-Za-z]/g, '')
  if (letters.length >= 2 && letters === letters.toUpperCase()) return false
  const n = text.length
  const before = token.start > 0 ? text.charCodeAt(token.start - 1) : 0
  const after = token.end < n ? text.charCodeAt(token.end) : 0
  if (before && isGlueCode(before)) return false
  if (after && isGlueCode(after)) return false
  // 句点邻接：word. 后面跟空白是句号（允许）；后面跟字母是文件名（跳过）。
  if (after === 46) {
    const nextCode = token.end + 1 < n ? text.charCodeAt(token.end + 1) : 0
    if (isLetterCode(nextCode) || isDigitCode(nextCode)) return false
  }
  if (before === 46) {
    const prevCode = token.start - 2 >= 0 ? text.charCodeAt(token.start - 2) : 0
    if (isLetterCode(prevCode) || isDigitCode(prevCode)) return false
  }
  // 连字符邻接：dsh-word-learn 里的 word/learn 跳过。
  // 代价是 well-known 这类复合词也会跳过 —— 保守方向正确（宁可少标）。
  if (before === 45 || after === 45) return false
  return true
}

/**
 * 在 text 里找出所有"命中词表"的词。
 * @param {string} text
 * @param {Set<string>} wordSet 小写原形集合
 * @returns {Array<{start:number,end:number,raw:string,lemma:string}>}
 */
export function matchText(text, wordSet) {
  const out = []
  if (!text || !wordSet || !wordSet.size) return out
  const tokens = tokenize(text)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!isPlainWord(text, token)) continue
    const cands = lemmaCandidates(token.raw.toLowerCase())
    for (let j = 0; j < cands.length; j += 1) {
      if (wordSet.has(cands[j])) {
        out.push({ start: token.start, end: token.end, raw: token.raw, lemma: cands[j] })
        break
      }
    }
  }
  return out
}

/** 轻量文本指纹：用来判断"这个块的内容有没有变过"。 */
export function hashText(text) {
  let h = 5381
  const n = text.length
  // 只采样前 4000 字符 + 长度，足够发现"内容变了"，又不会在长块上卡住。
  const limit = n > 4000 ? 4000 : n
  for (let i = 0; i < limit; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return String(h) + ':' + String(n)
}

/**
 * 从一段文本里截"包含 [start,end) 的那句话"。
 * 句末标点：中英问号/叹号/句号/换行。句点要排除小数与缩写（. 后跟字母/数字就不算断句）。
 */
export function sentenceAround(text, start, end) {
  const n = text.length
  let left = start
  while (left > 0) {
    const c = text.charCodeAt(left - 1)
    if (c === 10 || c === 13) break
    if (c === 33 || c === 63 || c === 12290 || c === 65281 || c === 65311) break
    if (c === 46) {
      // 小数（3.5）不断句；其余句点（word. Next）断。
      const prev = left - 2 >= 0 ? text.charCodeAt(left - 2) : 0
      const afterDot = left < n ? text.charCodeAt(left) : 0
      if (!(isDigitCode(prev) && isDigitCode(afterDot))) break
    }
    left -= 1
  }
  let right = end
  while (right < n) {
    const d = text.charCodeAt(right)
    if (d === 10 || d === 13) break
    if (d === 33 || d === 63 || d === 12290 || d === 65281 || d === 65311) {
      right += 1
      break
    }
    if (d === 46) {
      const before = right - 1 >= 0 ? text.charCodeAt(right - 1) : 0
      const next = right + 1 < n ? text.charCodeAt(right + 1) : 0
      if (!(isDigitCode(before) && isDigitCode(next))) {
        right += 1
        break
      }
    }
    right += 1
  }
  let out = text.slice(left, right).trim()
  if (out.length > 400) out = out.slice(0, 400)
  return out
}
