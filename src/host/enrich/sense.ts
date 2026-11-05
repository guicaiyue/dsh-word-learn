// enrich/sense.mjs —— 义项分析：提示词 + 质量闸门。
//
// 从 ai-enrich.mjs 拆出来的（2026-11-05，原文件超 CODE_BUDGET）。
// word_meta 是**词级**的；补记卡问的是「这句话里它是哪个义项」，那是**义项级**的问题，
// 需要另一套材料与更严的闸门（模型最爱在这里编义项、编例句、编词源）。
// 与词级分析共用 llm.mjs 的调用层，但提示词、归一化、失败降级全部独立。
import type { ResolvedAiModel } from '../models.js'
import { AnalysisError, runModel } from './llm.js'
import { contains, shuffle, splitTranslation } from './text.js'

/** 义项分析的输入。 */
export interface SenseInput {
  word?: unknown
  translation?: unknown
  sentence?: unknown
  definition?: unknown
}

/** 模型原始输出里本模块读取的字段（外部未类型化输入）。 */
interface SenseParsed {
  sense_here?: unknown
  likely_assumed?: unknown
  why_confusable?: unknown
  contrast?: unknown
  confidence?: unknown
  personal_example?: unknown
  cloze?: unknown
  other_sense?: { sentence?: unknown; gloss?: unknown } | null
  etymology_note?: unknown
}

/** 归一化后的义项材料（sense_meta.json 的结构 + 质量标记）。 */
export interface SenseMetaResult {
  sense_here: string
  likely_assumed: string | undefined
  why_confusable: string
  contrast: string
  options: Array<{ text: string; correct: boolean }>
  personal_example: string
  cloze: string
  other_sense: { sentence: string; gloss: string } | null
  etymology_note: string
  confidence: string
  degraded: string[]
  analyzedAt: number
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

function buildSensePrompt({ word, translation, sentence, definition }: SenseInput): string {
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
export async function analyzeSense(
  ctx: unknown,
  { word, translation, sentence, definition }: SenseInput,
  selection?: ResolvedAiModel | null,
): Promise<SenseMetaResult> {
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
export function normalizeSenseMeta(
  parsed: SenseParsed | null | undefined,
  { word, translation }: { word?: unknown; translation?: unknown } = {},
): SenseMetaResult | null {
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
  const degraded: string[] = []
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
  const wrongs: string[] = []
  const pushWrong = (value: unknown): void => {
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
function hasWordForm(sentence: unknown, word: unknown): boolean {
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
function blankOutWord(sentence: string, word: string): string {
  if (!word) return ''
  const i = String(sentence).toLowerCase().indexOf(String(word).toLowerCase())
  if (i < 0) return ''
  return sentence.slice(0, i) + '______' + sentence.slice(i + String(word).length)
}

/** 去掉词性前缀：n. / v. / a. / [计] 这类。 */
function stripPos(s: unknown): string {
  let t = String(s || '').trim()
  const dot = t.indexOf('.')
  if (dot > 0 && dot <= 2 && /^[a-z]+$/.test(t.slice(0, dot))) t = t.slice(dot + 1).trim()
  const close = t.indexOf(']')
  if (t.startsWith('[') && close > 0) t = t.slice(close + 1).trim()
  return t.trim()
}

/** 把 ECDICT 的多行释义拆成一个个义项原子（"n. 解析, 决心, 决议" → 解析/决心/决议）。 */
function senseAtoms(translation: unknown): string[] {
  const out: string[] = []
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
