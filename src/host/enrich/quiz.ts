// enrich/quiz.mjs —— 选择题生成：正确项取词典义项，干扰项取 word_meta / 生词本。
//
// 从 ai-enrich.mjs 拆出来的（2026-11-05，原文件超 CODE_BUDGET）。
// 纯函数：store 只是可选依赖（拿同频段词凑干扰项），不写库、不排队。
import { shuffle, splitTranslation } from './text.js'

/** 一个选项。 */
export interface QuizOption {
  text: string
  correct: boolean
}

/** 一道选择题。 */
export interface Quiz {
  options: QuizOption[]
  correctCount: number
  totalCount: number
}

/** 生成干扰项时用到的 Store 能力。 */
interface QuizStore {
  randomTranslations(word: unknown, count?: number): string[]
}

/** word_meta 里本模块读取的部分。 */
interface QuizMeta {
  distractors?: unknown
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
export function generateQuiz(
  word: unknown,
  translation: unknown,
  meta: QuizMeta | null | undefined,
  store: QuizStore | null | undefined,
): Quiz | null {
  const senses = splitTranslation(translation)
  if (!senses.length) return null

  // 正确选项：取前 3 个义项
  const correctTexts = senses.slice(0, 3)
  const correct = correctTexts.map((text) => ({ text, correct: true }))

  // 错误选项：优先用 AI 生成的干扰项
  let distractors: QuizOption[] = []
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
