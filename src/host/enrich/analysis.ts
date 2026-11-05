// enrich/analysis.mjs —— 词级 AI 分析：提示词、解析容错、归一化成 word_meta。
//
// 从 ai-enrich.mjs 拆出来的（2026-11-05，原文件超 CODE_BUDGET）。这里只做
// 「问模型要词根/近义词/干扰项/记忆法，再把答案收拾成 word_meta」。
// 排队与落库在 queue.mjs，底层调用/重试/错误翻译在 llm.mjs。
import type { ResolvedAiModel } from '../models.js'
import { AnalysisError, extractJson, runModel } from './llm.js'

/** 模型原始输出里本模块读取的字段（外部未类型化输入）。 */
interface WordParsed {
  roots?: unknown
  synonyms?: unknown
  distractors?: unknown
  mnemonic?: unknown
  confusables?: unknown
  _provider?: unknown
  _model?: unknown
}

/** word_meta 的归一化结构（analysis 的产物；store 侧按 JSON 收口）。 */
export interface WordAnalysis {
  roots: Array<{ part: string; type: string; meaning: string } | null>
  synonyms: string[]
  distractors: string[]
  mnemonic: string
  confusables: string[]
  analyzedAt: number
  _provider: string
  _model: string
}

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
export async function analyzeWord(
  ctx: unknown,
  word: unknown,
  translation: unknown,
  definition: unknown,
  selection?: ResolvedAiModel | null,
): Promise<WordAnalysis> {
  const raw = await runModel(ctx, {
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(word, translation, definition),
    selection,
  })
  const meta = normalizeWordMeta(raw)
  if (!meta) throw new AnalysisError('模型返回的 JSON 不是可用的词义分析', 'BAD_SHAPE')
  return meta
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

function buildPrompt(word: unknown, translation: unknown, definition: unknown): string {
  const parts: string[] = [`单词：${word}`]
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
export function parseResponse(text: unknown): WordAnalysis | null {
  const parsed = extractJson(text)
  return parsed ? normalizeWordMeta(parsed) : null
}

/** 把解析出来的对象归一化成 word_meta；结构不对（不是对象）返回 null。 */
function normalizeWordMeta(parsed: WordParsed | null | undefined): WordAnalysis | null {
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

function normalizeRoot(r: unknown): { part: string; type: string; meaning: string } | null {
  if (!r || typeof r !== 'object') return null
  const root = r as { part?: unknown; type?: unknown; meaning?: unknown }
  return {
    part: String(root.part || '').slice(0, 30),
    type: ['prefix', 'root', 'suffix'].includes(root.type as string)
      ? (root.type as string)
      : 'root',
    meaning: String(root.meaning || '').slice(0, 50),
  }
}

function stringArray(arr: unknown, max: number): string[] {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim().slice(0, 80))
    .slice(0, max)
}
