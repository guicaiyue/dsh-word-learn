// ai-enrich.mjs —— AI 分析单词，生成学习元数据。
//
// 在用户第一次遇见一个词时（touch），后台异步调用 LLM 分析：
//   - 词根词缀拆解
//   - 近义词
//   - 干扰项（看起来像对的但其实不是这个词的意思）
//   - 记忆方法 / 关联场景
//   - 易混淆词
//
// 结果写入 words.word_meta（JSON），供复习时的选择题和记忆提示使用。
//
// 设计约束：
//   1. AI 分析是**增强**，不是前置条件。分析失败/还没跑完时，
//      复习流程降级为纯释义展示，功能不残。
//   2. 每个词只分析一次（word_meta 非空就跳过），节省 token。
//   3. 用进程内队列串行执行，避免并发打爆模型配额。
//   4. 用哪个模型由 models.mjs 决定（DSH 模型目录里用户选的那个，默认第一个），
//      不再跟随会话的默认模型。
//   5. 失败必须说清楚为什么（见 AnalysisError）：界面上的
//      "AI 分析失败，可能是模型不可用" 曾经把「拿不到 llm 服务」「JSON 没解析出来」
//      「限流」「没配 API Key」全糊成一句话，排查只能靠猜。
//
// 服务取法见 service.mjs —— 必须用 ctx.get('llm')，属性访问 ctx.llm 拿不到。

import { getService } from './service.mjs'
import { resolveAiModel } from './models.mjs'

/** 单次分析的超时。够慢模型跑完，又不至于让「重新分析」按钮一直转。 */
const ANALYSIS_TIMEOUT_MS = 45000

/** 分析失败。code 给调用方分流，message 直接给用户看。 */
export class AnalysisError extends Error {
  constructor(message, code = 'ANALYSIS_FAILED') {
    super(message)
    this.name = 'AnalysisError'
    this.code = code
  }
}

/** 模型失败码 → 人话。没列到的码直接把原始 message 给出去。 */
const FAILURE_HINTS = {
  NO_ADAPTER: '模型路由没注册（provider 名对不上）',
  MISSING_CREDENTIAL: '没有配置 API Key',
  INVALID_CREDENTIAL: 'API Key 格式不合法',
  AUTH: '认证失败（API Key 无效或过期）',
  RATE_LIMIT: '被模型服务限流',
  QUOTA: '模型额度已用完',
  ACCOUNT_QUOTA: '账户余额不足',
  CONTEXT_WINDOW_EXCEEDED: '上下文超出模型的窗口',
  TIMEOUT: '请求超时',
  TRANSPORT: '网络不通',
  INVALID_REQUEST: '请求被模型服务拒绝',
}

/** 单次生成的输出上限。1500 对带思考的模型不够——思考 token 也算在 maxTokens 里。 */
const MAX_OUTPUT_TOKENS = 4000
/** 截断/空响应时重试一次的更高上限。 */
const RETRY_OUTPUT_TOKENS = 8000
/** 这两类失败换更大预算重试一次有意义；鉴权、限流、非 JSON 重试没用。 */
const RETRYABLE = new Set(['TRUNCATED', 'EMPTY_RESPONSE'])

/**
 * 让 LLM 分析一个词并返回结构化 JSON。
 *
 * @param {object} ctx - DSH 插件上下文
 * @param {string} word - 要分析的单词（原形）
 * @param {string} translation - 词典释义（中文）
 * @param {string} definition - 英文释义
 * @param {{provider:string,model:string}} selection - 用哪个模型；
 *   省略时按 models.mjs 的规则现解析（用户自选 or 目录第一个）
 * @returns {Promise<object>} 归一化后的 word_meta
 * @throws {AnalysisError} 拿不到模型服务、模型报错、输出不是 JSON 等
 */
export async function analyzeWord(ctx, word, translation, definition, selection) {
  const raw = await runModel(ctx, {
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(word, translation, definition),
    selection,
  })
  const meta = normalizeWordMeta(raw)
  if (!meta) throw new AnalysisError('模型返回的 JSON 不是可用的词义分析', 'BAD_SHAPE')
  return meta
}

/**
 * 跑一次模型调用（含重试与超时），返回**原始 JSON 对象**。
 *
 * word_meta 与 sense_meta 共用这一层；各自的字段校验放在自己的 normalize 里。
 * 为什么分开：`parseResponse` 过去顺手把结果归一化成 word_meta，义项分析
 * 用同一套字段校验会被直接判成"不是合法 JSON"。
 */
async function runModel(ctx, { system, prompt, selection }) {
  const llm = getService(ctx, 'llm')
  if (!llm || typeof llm.prepareCall !== 'function') {
    throw new AnalysisError(
      'DSH 的模型服务不可用（插件拿不到 ctx.llm），AI 分析没法发起',
      'NO_LLM_SERVICE',
    )
  }

  const chosen = selection || (await resolveAiModel(ctx, null))
  if (!chosen || !chosen.provider || !chosen.model) {
    throw new AnalysisError('没有可用的模型：DSH 模型目录为空，会话也没有默认模型', 'NO_MODEL')
  }

  const state = { timedOut: false }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    state.timedOut = true
    controller.abort()
  }, ANALYSIS_TIMEOUT_MS)

  try {
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await runAttempt({
          llm,
          chosen,
          system,
          prompt,
          signal: controller.signal,
          maxTokens: attempt === 0 ? MAX_OUTPUT_TOKENS : RETRY_OUTPUT_TOKENS,
          state,
        })
      } catch (err) {
        lastError = err
        // 只对"被截断 / 空响应"再试一次，别的失败（鉴权、限流、坏 JSON）重试也没用
        if (!(err instanceof AnalysisError) || !RETRYABLE.has(err.code)) throw err
      }
    }
    throw lastError
  } finally {
    clearTimeout(timer)
  }
}

/** 跑一次完整的模型调用：准备 → 流式收文本 → 解析出原始 JSON。 */
async function runAttempt({ llm, chosen, system, prompt, signal, maxTokens, state }) {
  let call
  try {
    call = await llm.prepareCall(
      { provider: chosen.provider, model: chosen.model, maxTokens },
      signal,
      (controls) => controls,
    )
  } catch (err) {
    if (state.timedOut) throw timeoutError(chosen)
    throw new AnalysisError(`模型 ${label(chosen)} 调用准备失败：${reason(err)}`, 'PREPARE_FAILED')
  }
  if (!call || typeof call.stream !== 'function') {
    throw new AnalysisError(`模型 ${label(chosen)} 没有返回可用的调用句柄`, 'NO_STREAM')
  }

  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const options = {
    ...call.config,
    messages,
    system,
    signal,
  }

  let out = ''
  let finish = null
  try {
    for await (const chunk of call.stream(options)) {
      if (!chunk) continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      // 终止块：适配器把失败放在 reason 里，不读它就只剩空输出
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (err) {
    if (state.timedOut) throw timeoutError(chosen)
    throw new AnalysisError(`模型 ${label(chosen)} 调用失败：${reason(err)}`, 'STREAM_FAILED')
  }

  if (finish && finish.kind === 'error') throw failureError(finish.failure, chosen)
  if (finish && finish.kind === 'aborted') {
    if (state.timedOut) throw timeoutError(chosen)
    throw new AnalysisError(`模型 ${label(chosen)} 的调用被中止`, 'ABORTED')
  }

  const text = out.trim()
  if (!text) {
    throw new AnalysisError(`模型 ${label(chosen)} 没有返回任何内容`, 'EMPTY_RESPONSE')
  }

  const parsed = extractJson(text)
  if (!parsed) {
    const truncated = finish && finish.kind === 'max-tokens'
    throw new AnalysisError(
      (truncated
        ? `模型 ${label(chosen)} 的输出被截断（maxTokens 不够），不是完整 JSON`
        : `模型 ${label(chosen)} 返回的不是合法 JSON`) + `：${preview(text)}`,
      truncated ? 'TRUNCATED' : 'BAD_JSON',
    )
  }

  parsed._provider = chosen.provider
  parsed._model = chosen.model
  return parsed
}

function timeoutError(chosen) {
  return new AnalysisError(
    `模型 ${label(chosen)} 超过 ${Math.round(ANALYSIS_TIMEOUT_MS / 1000)} 秒没返回，已中止`,
    'TIMEOUT',
  )
}

// ---------------------------------------------------------------- 内部

function label(chosen) {
  return `${chosen.provider}/${chosen.model}`
}

function reason(err) {
  return (err && (err.message || String(err))) || '未知错误'
}

/** 把 LLM 的终止失败翻译成人话。 */
function failureError(failure, chosen) {
  const f = failure || {}
  const code = String(f.code || 'LLM_ERROR')
  const hint = FAILURE_HINTS[code] || f.message || '模型调用失败'
  const raw = f.message && f.message !== hint ? `：${f.message}` : ''
  const meta = [f.status ? 'HTTP ' + f.status : '', code].filter(Boolean).join('，')
  return new AnalysisError(`模型 ${label(chosen)} 调用失败：${hint}${raw}（${meta}）`, code)
}

/** 截断回显，用来判断模型到底吐了什么。 */
function preview(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine
}

const SYSTEM_PROMPT = [
  '你是一个英语词汇分析助手。用户给你一个英语单词及其释义，你需要分析并返回结构化 JSON。',
  '严格按以下 JSON 格式输出，不要输出任何其他内容：',
  '{',
  '  "roots": [{"part": "词根或词缀", "type": "prefix|root|suffix", "meaning": "含义"}],',
  '  "synonyms": ["近义词1", "近义词2"],',
  '  "distractors": ["看似合理但错误的中文释义1", "错误释义2", "错误释义3"],',
  '  "mnemonic": "一句话记忆方法或场景联想",',
  '  "confusables": ["容易混淆的词1", "容易混淆的词2"]',
  '}',
  '',
  '要求：',
  '1. roots：拆解词根词缀。如果是简单词（如 cat, run）可以为空数组。',
  '2. synonyms：给出 2-4 个常见近义词（英文）。',
  '3. distractors：给出 3-4 个**看起来合理但实际上不是这个词意思**的中文释义。',
  '   这些干扰项要有迷惑性——可以是近义词的意思、形近词的意思、或同一领域但不对的意思。',
  '   例如 resolution 的干扰项可以是"旋转"（像 revolution）、"共鸣"（像 resonance）。',
  '4. mnemonic：给出一个具体的记忆场景或联想方法，帮助中国学生记住这个词。',
  '   用中文写，要生动具体，不要泛泛而谈。',
  '5. confusables：容易跟它搞混的词（拼写或发音相近），1-3 个。',
  '6. 只输出 JSON，不要 markdown 代码块，不要解释文字。',
].join('\n')

function buildPrompt(word, translation, definition) {
  const parts = [`单词：${word}`]
  if (translation) parts.push(`中文释义：${translation}`)
  if (definition) parts.push(`英文释义：${definition}`)
  return parts.join('\n')
}

/**
 * 解析 LLM 返回的 JSON。容错处理：
 * - 去掉可能的 markdown 代码块包裹
 * - 模型在 JSON 前后多写了解释文字时，抠出第一个完整的 JSON 对象
 * - 字段缺失给默认值
 * - 完全解析失败返回 null
 *
 * 导出给测试用：解析是最容易在换模型后静默坏掉的一环。
 */
export function parseResponse(text) {
  const parsed = extractJson(text)
  return parsed ? normalizeWordMeta(parsed) : null
}

/** 从模型输出里抠出原始 JSON 对象（不做字段校验）。 */
export function extractJson(text) {
  if (!text) return null

  const raw = String(text).trim()

  // 1. 先按原文解析（模型听话时的快路径）
  const direct = parseJson(raw)
  if (direct) return direct

  // 2. 去掉 markdown 代码块再试
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw)
  if (fence) {
    const fromFence = parseJson(fence[1].trim())
    if (fromFence) return fromFence
  }

  // 3. 前后有解释文字：抠第一个配平的 {...}
  const embedded = extractFirstObject(raw)
  if (embedded) {
    const fromEmbedded = parseJson(embedded)
    if (fromEmbedded) return fromEmbedded
  }

  return null
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 把解析出来的对象归一化成 word_meta；结构不对（不是对象）返回 null。 */
function normalizeWordMeta(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (
    !('roots' in parsed) &&
    !('synonyms' in parsed) &&
    !('distractors' in parsed) &&
    !('mnemonic' in parsed) &&
    !('confusables' in parsed)
  ) {
    return null
  }
  return {
    roots: Array.isArray(parsed.roots) ? parsed.roots.slice(0, 10).map(normalizeRoot) : [],
    synonyms: stringArray(parsed.synonyms, 8),
    distractors: stringArray(parsed.distractors, 6),
    mnemonic: typeof parsed.mnemonic === 'string' ? parsed.mnemonic.slice(0, 500) : '',
    confusables: stringArray(parsed.confusables, 5),
    analyzedAt: Date.now(),
    // runAttempt 把「实际用哪个模型」写在原始 JSON 上；这里是重建对象，必须显式搬运，
    // 否则 dashboard 的"分析用模型"永远是空（2026-11-05 修，test-ai-model 抓到）。
    _provider: typeof parsed._provider === 'string' ? parsed._provider : '',
    _model: typeof parsed._model === 'string' ? parsed._model : '',
  }
}

/** 从任意文本里抠出第一个括号配平的 JSON 对象；跳过字符串里的括号与转义。 */
function extractFirstObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function normalizeRoot(r) {
  if (!r || typeof r !== 'object') return null
  return {
    part: String(r.part || '').slice(0, 30),
    type: ['prefix', 'root', 'suffix'].includes(r.type) ? r.type : 'root',
    meaning: String(r.meaning || '').slice(0, 50),
  }
}

function stringArray(arr, max) {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim().slice(0, 80))
    .slice(0, max)
}

// ---------------------------------------------------------------- 义项分析
//
// word_meta 是**词级**的：词根、记忆法、易混淆词。
// 补记卡要问的是「这句话里它是哪个义项」，那是**义项级**的问题，
// 需要另一套材料：本句义项、他可能误认成什么、为什么容易混、能解释多义的词源。
//
// 与 word_meta 的三个区别：
//   1. 输入多一个 sentence（原句），输出必须围绕"这一句里的义项"。
//   2. 允许失败降级：拿不到模型时前端退回自由回忆（P0 已有）。
//   3. 落库前过质量闸门 —— LLM 编例句、编词源是这里最大的风险。

const SENSE_SYSTEM_PROMPT = [
  '你在为一个中国开发者做「义项修复卡」。他只在这个词的一个义项上见过它，',
  '现在在另一个义项上卡住了。你的任务是帮他看见这个反差。',
  '严格按以下 JSON 格式输出，不要输出任何其他内容：',
  '{',
  '  "sense_here": "本句里这个词的中文义项（必须来自给定的义项列表）",',
  '  "likely_assumed": "他最可能误认成的那个义项（必须与 sense_here 不同）",',
  '  "why_confusable": "一句话说明他为什么会这么以为，必须提到技术语境或中文译法",',
  '  "contrast": "一句话的反差：你以为是 X，这句里是 Y",',
  '  "personal_example": "8-20 词的英文例句，必须包含这个词，必须是软件/工程场景，目标义项无歧义",',
  '  "cloze": "把 personal_example 里的目标词挖成 ______，其余逐字不变",',
  '  "other_sense": {"sentence": "用同一个词的另一个义项造的英文句", "gloss": "那句里它的中文意思"},',
  '  "etymology_note": "只在词源能解释这个词为什么有多义时才写，否则空字符串",',
  '  "confidence": "high 或 low"',
  '}',
  '',
  '硬约束：',
  '1. sense_here 必须逐字来自给定的义项列表，不许自己造义项。',
  '2. personal_example 与 cloze 必须对应：cloze 就是把 personal_example 里的词挖空。',
  '3. other_sense.sentence 必须用**另一个**义项，不能和本句同义。',
  '4. etymology_note 不许编造词源。不确定就留空字符串 —— 宁可没有，不可编造。',
  '5. 语气克制，不写段子，不写"老铁"这类词。有趣来自反差，不来自俏皮。',
  '6. 例句不许出现真实人名、公司名、产品名。',
  '7. 只输出 JSON，不要 markdown 代码块，不要解释文字。',
].join('\n')

function buildSensePrompt({ word, translation, sentence, definition }) {
  const parts = [`单词：${word}`]
  if (sentence) parts.push(`他遇见它的原句：${sentence}`)
  if (translation)
    parts.push(`词典义项列表（每行一个，sense_here 必须逐字取自这里）：\n${translation}`)
  if (definition) parts.push(`英文释义：${definition}`)
  parts.push('他的背景：后端/AI 开发，日常读英文技术文档与模型思维链。')
  return parts.join('\n')
}

/**
 * 分析一个词在**某一句**里的义项，产出补记卡所需的材料。
 *
 * @returns {Promise<object>} 归一化后的 sense_meta（含 quality 标记）
 * @throws {AnalysisError} 模型不可用、输出不是 JSON 等
 */
export async function analyzeSense(ctx, { word, translation, sentence, definition }, selection) {
  const raw = await runModel(ctx, {
    system: SENSE_SYSTEM_PROMPT,
    prompt: buildSensePrompt({ word, translation, sentence, definition }),
    selection,
  })
  const meta = normalizeSenseMeta(raw, { word, translation })
  if (!meta)
    throw new AnalysisError('模型返回的义项分析不可用（义项对不上或例句不合格）', 'BAD_SENSE')
  return meta
}

/**
 * 义项分析的归一化 + 质量闸门。
 *
 * 闸门按设计文档 §5.3：
 *   - sense_here 不在义项列表里 → 丢弃（模型最容易在这里造义项）
 *   - personal_example 不含目标词 → 丢弃
 *   - other_sense 与本句义项相同 → 丢弃
 *   - 例句过长 / 含专有名词 → 降级（清空例句，保留反差）
 *   - 词源非 high confidence → 清空
 *
 * 返回 null 表示不可用；返回对象时 `degraded` 列出被清掉的字段。
 */
export function normalizeSenseMeta(parsed, { word, translation } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (!('sense_here' in parsed)) return null

  const senses = splitTranslation(translation)
  const senseHere = String(parsed.sense_here || '').trim()
  if (!senseHere) return null
  // 义项必须能在词典释义里找到（允许词序差异，所以比对"包含关系"）
  if (senses.length && !senses.some((s) => contains(s, senseHere) || contains(senseHere, s))) {
    return null
  }

  const w = String(word || '').toLowerCase()
  const degraded = []
  const confidence = parsed.confidence === 'high' ? 'high' : 'low'

  let example = String(parsed.personal_example || '').trim()
  if (example) {
    const tokens = example.split(/\s+/).length
    const hasWord = w ? hasWordForm(example, w) : true
    if (!hasWord || tokens > 24) {
      degraded.push('personal_example')
      example = ''
    }
  }

  let cloze = String(parsed.cloze || '').trim()
  if (!example || !cloze || !cloze.includes('___')) {
    if (cloze) degraded.push('cloze')
    cloze = example ? blankOutWord(example, w) : ''
  }

  const other =
    parsed.other_sense && typeof parsed.other_sense === 'object' ? parsed.other_sense : null
  const otherSentence = other ? String(other.sentence || '').trim() : ''
  const otherGloss = other ? String(other.gloss || '').trim() : ''
  let otherOk = !!otherSentence
  if (otherOk && otherGloss && contains(otherGloss, senseHere)) otherOk = false
  if (otherOk && w) {
    if (!hasWordForm(otherSentence, w)) otherOk = false
  }
  if (!otherOk) degraded.push('other_sense')

  // 词源只在 high confidence 时保留：编造词源比没有词源伤害大得多
  let etymology = String(parsed.etymology_note || '')
    .trim()
    .slice(0, 300)
  if (etymology && confidence !== 'high') {
    degraded.push('etymology_note')
    etymology = ''
  }

  // 选项不让模型直接给：模型标"哪个对"经常错位。
  // 这里用它给的两个错误义项 + 词典义项原子凑 3 个，正确项就是 sense_here。
  const wrongs = []
  const pushWrong = (value) => {
    const t = String(value || '')
      .trim()
      .slice(0, 40)
    if (!t) return
    if (contains(t, senseHere) || contains(senseHere, t)) return
    if (wrongs.some((w0) => contains(w0, t) || contains(t, w0))) return
    wrongs.push(t)
  }
  pushWrong(parsed.likely_assumed)
  if (otherOk) pushWrong(otherGloss)
  for (const atom of senseAtoms(translation)) {
    if (wrongs.length >= 3) break
    pushWrong(atom)
  }
  if (wrongs.length < 3) {
    degraded.push('options')
    return null
  }
  const options = shuffle([...wrongs.slice(0, 3), senseHere]).map((text) => ({
    text,
    correct: contains(text, senseHere),
  }))
  const likely = wrongs[0]

  return {
    sense_here: senseHere,
    likely_assumed: likely,
    why_confusable: String(parsed.why_confusable || '')
      .trim()
      .slice(0, 300),
    contrast: String(parsed.contrast || '')
      .trim()
      .slice(0, 200),
    options,
    personal_example: example.slice(0, 240),
    cloze: cloze.slice(0, 240),
    other_sense: otherOk
      ? { sentence: otherSentence.slice(0, 240), gloss: otherGloss.slice(0, 80) }
      : null,
    etymology_note: etymology,
    confidence,
    degraded,
    analyzedAt: Date.now(),
  }
}

/** 句子是否包含这个词（允许 -s/-ed/-ing 这类变形）。 */
function hasWordForm(sentence, word) {
  const s = String(sentence || '').toLowerCase()
  const w = String(word || '').toLowerCase()
  if (!s || !w) return false
  const i = s.indexOf(w)
  if (i < 0) return false
  let j = i + w.length
  let extra = 0
  while (extra < 4 && j < s.length && s[j] >= 'a' && s[j] <= 'z') {
    j++
    extra++
  }
  return !(j < s.length && s[j] >= 'a' && s[j] <= 'z')
}

/** 把句子里的目标词替换成挖空标记（保留长度感的空格）。 */
function blankOutWord(sentence, word) {
  if (!word) return ''
  const i = String(sentence).toLowerCase().indexOf(String(word).toLowerCase())
  if (i < 0) return ''
  return sentence.slice(0, i) + '______' + sentence.slice(i + String(word).length)
}

/** 去掉词性前缀：n. / v. / a. / [计] 这类。 */
function stripPos(s) {
  let t = String(s || '').trim()
  const dot = t.indexOf('.')
  if (dot > 0 && dot <= 2 && /^[a-z]+$/.test(t.slice(0, dot))) t = t.slice(dot + 1).trim()
  const close = t.indexOf(']')
  if (t.startsWith('[') && close > 0) t = t.slice(close + 1).trim()
  return t.trim()
}

/** 把 ECDICT 的多行释义拆成一个个义项原子（"n. 解析, 决心, 决议" → 解析/决心/决议）。 */
function senseAtoms(translation) {
  const out = []
  for (const line of splitTranslation(translation)) {
    for (const part of String(line).split(/[,，;；]/)) {
      const s0 = stripPos(part).slice(0, 40)
      if (!s0) continue
      if (out.some((x) => contains(x, s0) || contains(s0, x))) continue
      out.push(s0)
    }
  }
  return out
}

function contains(a, b) {
  const x = String(a || '').replace(/\s+/g, '')
  const y = String(b || '').replace(/\s+/g, '')
  return !!x && !!y && x.includes(y)
}

// ---------------------------------------------------------------- 队列

const pending = []
let running = false
// 队列上限：划词卡片一多，一次能塞几十上百个词进来；不设上限会一直占内存、
// 而且插件卸载后还在后台跑（会重开 DB 句柄）。
const MAX_PENDING = 200
// 插件卸载/热重载时置 true，让正在跑的 drain 尽快收尾。
const disposed = { word: false, sense: false }

/** 插件卸载时调用：清空待办并让循环退出。 */
export function disposeQueues() {
  disposed.word = true
  disposed.sense = true
  pending.length = 0
  sensePending.length = 0
  senseFailed.clear()
}

/**
 * 把一个词加入后台分析队列。
 *
 * 不等待完成——调用方（touch）fire-and-forget。
 * 队列串行执行，一个接一个，不打爆配额。
 */
export function enqueueAnalysis(ctx, store, word, translation, definition) {
  // 已有 meta 的不重复分析
  const existing = store.getMeta(word)
  if (existing && existing.analyzedAt) return

  if (disposed.word) return
  // 去重：队列里已经有这个词就跳过
  if (pending.some((p) => p.word === word)) return
  // 满了就丢新的：既有的（更早遇见、用户更可能在看）优先，别让队列无限长
  if (pending.length >= MAX_PENDING) return

  pending.push({ ctx, store, word, translation, definition })
  drainQueue()
}

async function drainQueue() {
  if (running) return
  running = true
  try {
    while (pending.length && !disposed.word) {
      const job = pending.shift()
      try {
        // 再查一次，避免并发场景下重复分析
        const existing = job.store.getMeta(job.word)
        if (existing && existing.analyzedAt) continue

        // 模型在出队时解析：这期间用户在设置页换了模型，下一个词就用新的
        const selection = await resolveAiModel(job.ctx, job.store)
        const meta = await analyzeWord(
          job.ctx,
          job.word,
          job.translation,
          job.definition,
          selection,
        )
        if (meta) {
          job.store.setMeta(job.word, meta)
        }
      } catch (err) {
        // 单个词分析失败不影响队列其他词，但要留痕，不然只能看到"没有分析结果"
        try {
          console.warn('[dsh-word-learn] 后台 AI 分析失败 ' + job.word + '：' + reason(err))
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    running = false
  }
}

// ---------------------------------------------------------------- 义项队列
//
// 和 word_meta 的队列分开：义项分析更容易失败（要判断语境义项），
// 不能让它拖住词级分析；两者缓存也各自独立。

const sensePending = []
let senseRunning = false
// 失败后别每次「忘了」都重打一遍模型：同一个词 10 分钟内只试一次。
const senseFailed = new Map()
const SENSE_RETRY_MS = 10 * 60 * 1000

/** 把一个 (词, 原句) 加入义项分析队列。已有分析的不重复跑。 */
export function enqueueSenseAnalysis(ctx, store, { word, translation, sentence, definition }) {
  if (!sentence) return
  if (disposed.sense) return
  if (store.getSenseMeta(word)) return
  const failedAt = senseFailed.get(word) || 0
  if (failedAt && Date.now() - failedAt < SENSE_RETRY_MS) return
  if (sensePending.some((p) => p.word === word && p.sentence === sentence)) return
  if (sensePending.length >= MAX_PENDING) return
  sensePending.push({ ctx, store, word, translation, sentence, definition })
  drainSenseQueue()
}

async function drainSenseQueue() {
  if (senseRunning) return
  senseRunning = true
  try {
    while (sensePending.length && !disposed.sense) {
      const job = sensePending.shift()
      try {
        if (job.store.getSenseMeta(job.word)) continue
        const selection = await resolveAiModel(job.ctx, job.store)
        const meta = await analyzeSense(job.ctx, job, selection)
        if (meta) {
          job.store.setSenseMeta(job.word, meta)
          senseFailed.delete(job.word)
        }
      } catch (err) {
        senseFailed.set(job.word, Date.now())
        try {
          console.warn('[dsh-word-learn] 义项分析失败 ' + job.word + '：' + reason(err))
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    senseRunning = false
  }
}

// ---------------------------------------------------------------- 选择题生成

/**
 * 根据 word_meta 生成一道选择题的选项。
 *
 * 返回 { options: [{text, correct}], correctCount }
 * 选项随机打乱，correct 标记哪些是正确答案。
 *
 * 策略：
 *   - 正确选项：从词典释义里取（最多 3 个义项）
 *   - 错误选项：从 word_meta.distractors 里取
 *   - 如果 distractors 不够，从同频段的其他词的释义里凑
 *   - 总选项数 5-7 个，正确占 2-3 个
 */
export function generateQuiz(word, translation, meta, store) {
  const senses = splitTranslation(translation)
  if (!senses.length) return null

  // 正确选项：取前 3 个义项
  const correctTexts = senses.slice(0, 3)
  const correct = correctTexts.map((text) => ({ text, correct: true }))

  // 错误选项：优先用 AI 生成的干扰项
  let distractors = []
  if (meta && Array.isArray(meta.distractors)) {
    distractors = meta.distractors
      .filter((d) => !correctTexts.some((c) => c.includes(d) || d.includes(c)))
      .map((text) => ({ text, correct: false }))
  }

  // 干扰项不够时，从生词本里随机取其他词的释义
  if (distractors.length < 3 && store) {
    const others = store.randomTranslations(word, 6)
    for (const t of others) {
      if (distractors.length >= 4) break
      if (correctTexts.some((c) => c.includes(t) || t.includes(c))) continue
      if (distractors.some((d) => d.text === t)) continue
      distractors.push({ text: t, correct: false })
    }
  }

  // 确保至少有 2 个干扰项
  if (distractors.length < 2) return null

  // 取 3-4 个干扰项
  const wrongSlice = distractors.slice(0, Math.min(4, distractors.length))

  // 合并打乱
  const options = shuffle([...correct, ...wrongSlice])
  return {
    options,
    correctCount: correct.length,
    totalCount: options.length,
  }
}

/** 把 "n. 决心\nv. 解析" 这样的释义文本拆成条目。 */
function splitTranslation(text) {
  if (!text) return []
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Fisher-Yates 洗牌。 */
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
