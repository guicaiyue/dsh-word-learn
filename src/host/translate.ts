// translate.mjs —— 把"划中的一段话"翻成简体中文。
//
// 为什么划句子必须翻译：
//   用户划中一段话，通常是"这句我没读懂"。只把里面的词拆出来给他，
//   等于让他自己拼句意 —— 这不是他要的。设计文档 §3 表面 A 写的就是
//   "划中一段话 → 译文卡片 → 卡片上多一行 [拆词学习]"。
//
// 两个后端，按顺序降级：
//   1. DSH 自己的模型（ctx.llm）—— 质量最好，尤其技术英语；
//      例句：`reviews` 在间隔重复语境里是"复习"，公共接口会翻成"评论"。
//   2. MyMemory 公共接口 —— 不需要任何配置/额度，质量一般但总能给出东西。
//
// 为什么不用官方 `ctx.translator` 服务：本机 profile 没启用它
// （只有 dsh-experimental-cot-translation-bundle 提供，那个 bundle 默认禁用），
// 依赖它会变成"用户没装这个 bundle 就没有译文"。
//
// 为什么不用官方 translator 的 Bing 后端：`edge.microsoft.com/translate/auth`
// 实测 404，Bing 的 ttranslatev3 还要从页面里抓 token，很脆。

import { getService } from './host/service.js'

/** 缓存上限。划词场景里同一段话常被反复选中，缓存能省掉重复请求。 */
const CACHE_MAX = 200
/** 单次翻译的文本上限，超过就截断（划选区本身已有 20000 字符的上限）。 */
const MAX_INPUT = 6000
/** MyMemory 单次请求的 `q` 上限约 500 字符，留点余量按句切分。 */
const MYMEMORY_CHUNK = 450
/** 默认超时。划词是交互场景，超过这个时间用户已经在等了。 */
const DEFAULT_TIMEOUT_MS = 15000

const CACHE = new Map()

const SYSTEM_PROMPT = [
  '你是一个英译中的翻译器。把用户给出的英文翻译成简体中文。',
  '要求：',
  '1. 只输出译文，不要解释、不要加引号、不要复述原文。',
  '2. 技术术语按中文技术圈的习惯译法翻译（例如 latent space → 潜空间，',
  '   spaced repetition → 间隔重复，review → 复习，embedding → 嵌入）。',
  '3. 保留原文的语气和句子结构，不要意译成另一段话。',
  '4. 如果原文已经是中文，原样返回。',
].join('\n')

/** 翻译用了哪个后端 —— 让界面能如实显示"由谁翻的"。 */
export const SOURCE_LABEL = {
  llm: 'DSH 模型',
  mymemory: 'MyMemory',
}

function cacheGet(text) {
  const hit = CACHE.get(text)
  if (hit === undefined) return undefined
  // 命中就挪到末尾，维持 LRU 顺序
  CACHE.delete(text)
  CACHE.set(text, hit)
  return hit
}

function cacheSet(text, value) {
  if (CACHE.has(text)) CACHE.delete(text)
  CACHE.set(text, value)
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value)
}

/** 解析一个 service（取法见 service.mjs：服务只在 ctx.get 上）。 */
function service(ctx, name) {
  return getService(ctx, name) || undefined
}

/** 把长文本按句子边界切成若干块，每块不超过 `limit` 字符。 */
function chunkText(text, limit) {
  if (text.length <= limit) return [text]
  const parts = []
  let rest = text
  while (rest.length > limit) {
    // 优先在句末切，其次在空格切，实在没有就硬切
    let cut
    const window = rest.slice(0, limit)
    const sent = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('.\n'),
      window.lastIndexOf('; '),
    )
    if (sent > limit * 0.4) cut = sent + 1
    else {
      const space = window.lastIndexOf(' ')
      cut = space > limit * 0.4 ? space : limit
    }
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

/**
 * 用 DSH 自己的模型翻译。
 * @returns 译文，或 `null` 表示"这条路走不通"（没配模型 / 调不通），交给下一个后端。
 */
async function viaLlm(ctx, text, signal) {
  const llm = service(ctx, 'llm')
  const defaults = service(ctx, 'agentDefaultModel')
  if (!llm || typeof llm.prepareCall !== 'function' || !defaults) return null

  let selection
  try {
    selection = defaults.currentSelection()
  } catch {
    return null
  }
  if (!selection || !selection.provider || !selection.model) return null

  const call = await llm.prepareCall(
    { provider: selection.provider, model: selection.model, maxTokens: 1200 },
    signal,
    (controls) => controls,
  )
  if (!call || typeof call.stream !== 'function') return null

  // 消息用手搓的普通对象：`@deepseek-ai/dsh-llm` 在插件目录里解析不到
  // （插件是 junction 到 D 盘的独立项目），而适配器只读 role/content/source，
  // 不需要 id/seq。实测 dsh-llm-pi-ai 就是这么读的。
  const messages = [{ role: 'user', content: [{ type: 'text', text }] }]
  const options = { ...call.config, messages, system: SYSTEM_PROMPT, signal }

  let out = ''
  for await (const chunk of call.stream(options)) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
  }
  const trimmed = out.trim()
  return trimmed || null
}

/** 用 MyMemory 公共接口翻译，按块请求后拼接。 */
async function viaMyMemory(text, signal) {
  const chunks = chunkText(text, MYMEMORY_CHUNK)
  const out = []
  for (const chunk of chunks) {
    const url =
      'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(chunk) +
      '&langpair=en|zh-CN'
    const res = await fetch(url, { signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error('MyMemory HTTP ' + res.status)
    const json = await res.json()
    const translated = json && json.responseData && json.responseData.translatedText
    if (typeof translated !== 'string') throw new Error('MyMemory 返回格式异常')
    // 额度用尽时它会把这个告警当译文返回，必须识别出来
    if (/MYMEMORY WARNING|QUOTA|ALL AVAILABLE FREE TRANSLATIONS/i.test(translated)) {
      throw new Error('MyMemory 今日免费额度已用完')
    }
    out.push(translated.trim())
  }
  const joined = out.join(' ').trim()
  return joined || null
}

/**
 * 翻译一段文本。
 *
 * 永不 throw —— 失败时返回 `{ok:false, error}`，让前端画一张"翻译失败"的卡片。
 * 划词是交互路径，抛异常会把整个浮层卡死。
 *
 * @returns `{ok:true, text, source, cached}` 或 `{ok:false, error}`
 */
export async function translate(ctx, text, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, error: '没有要翻译的内容' }
  if (raw.length > MAX_INPUT) {
    return { ok: false, error: `选中的内容太长（${raw.length} 字符），请分小段选` }
  }

  const hit = cacheGet(raw)
  if (hit) return { ...hit, cached: true }

  // 总超时：任何后端卡住都不能让用户干等
  const local = new AbortController()
  const timer = setTimeout(() => local.abort(new Error('翻译超时')), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal
  const failures = []

  try {
    try {
      const viaModel = await viaLlm(ctx, raw, combined)
      if (viaModel) {
        const value = { ok: true, text: viaModel, source: 'llm' }
        cacheSet(raw, value)
        return value
      }
    } catch (err) {
      failures.push('模型：' + ((err && err.message) || String(err)))
    }

    try {
      const viaPublic = await viaMyMemory(raw, combined)
      if (viaPublic) {
        const value = { ok: true, text: viaPublic, source: 'mymemory' }
        cacheSet(raw, value)
        return value
      }
    } catch (err) {
      failures.push('MyMemory：' + ((err && err.message) || String(err)))
    }

    const error = failures.length ? '翻译失败 · ' + failures.join(' / ') : '翻译失败'
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

/** 供 dashboard / 自检报告用的状态快照。 */
export function translateStatus() {
  return { cacheSize: CACHE.size, maxInput: MAX_INPUT, sources: Object.keys(SOURCE_LABEL) }
}

/** 仅供测试：清空缓存。 */
export function clearTranslateCache() {
  CACHE.clear()
}
