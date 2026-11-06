// lookup.mjs —— 「查一个词」的完整信息组装（词典 + 外部补全 + 生词本 + 警告）。
//
// 从 index.js 拆出来：它被 /lookup、/word、/translate 等多条路由共用，
// 放在路由模块里会变成循环依赖。
import type { DictInfo, DictSense, DictTag, ExchangeForm, FrequencyTier } from './dict.js'
import type { EnrichExample, EnrichResult } from './enrich.js'
import type { Store } from './store.js'
import type { TouchResult, WordAbility } from './store/words.js'
import { dict, store } from './runtime.js'
import { enrich } from './enrich.js'
import { enqueueAnalysis, enqueueSenseAnalysis } from './ai-enrich.js'

/** lookupWord 的可选参数。 */
export interface LookupOptions {
  withEnrich?: boolean
  sentence?: unknown
  save?: boolean
}

/** 成功时的完整结果。 */
export interface LookupOk {
  ok: true
  dict: {
    word: string
    query: string
    matchedBy: string
    asForm: DictInfo['asForm']
    phonetic: string
    senses: DictSense[]
    definition: string[]
    forms: ExchangeForm[]
    tags: DictTag[]
    frequency: FrequencyTier
    collins: number
    oxford: number
    likelyKnown: boolean
  }
  enrich: {
    ok: boolean
    examples: EnrichExample[]
    synonyms: string[]
    error: string
  }
  saved: {
    id: number
    seenCount: number
    starred: boolean
    ability: WordAbility
    isNew: boolean
  } | null
  warnings: string[]
}

/** 查词失败的错误码：客户端按 code 分支，不解析中文 error 文案。 */
export const LOOKUP_NOT_IN_DICT = 'NOT_IN_DICT'

/** 查词结果（词典里没有时 ok:false）。 */
export type LookupResult =
  LookupOk | { ok: false; code: typeof LOOKUP_NOT_IN_DICT; error: string; query: unknown }

/**
 * 查一个词的完整信息。
 * `withEnrich` 控制是否打外部接口（复习页批量取词时会关掉，避免慢）。
 */
export async function lookupWord(
  word: unknown,
  { withEnrich = true, sentence = '', save = true }: LookupOptions = {},
): Promise<LookupResult> {
  const info = dict.lookup(word)
  if (!info) {
    return { ok: false, code: LOOKUP_NOT_IN_DICT, error: '词典里没有这个词', query: word }
  }

  let extra: EnrichResult = { ok: false, examples: [], synonyms: [] }
  if (withEnrich) {
    extra = await enrich(info.word)
  }

  // 记进生词本（"我在这里遇见了它"）。
  // 学习页的悬浮预览传 save:false —— 鼠标扫过一串易混淆词不该把它们全塞进生词本，
  // 卡片里点「加入生词本」才会真正写库。
  const touched: Pick<TouchResult, 'isNew'> & { error?: string } = save
    ? store.touch(info, sentence)
    : { isNew: false }
  const saved = store.get(info.word)
  // 写库失败不改变"查到了这个词"，但必须让用户知道"没存进去"。
  // 旧实现把 touch 的 error 丢掉，外面只看到 ok:true + saved:null，静默丢生词本。
  const warnings: string[] = []
  if (save && touched && touched.error) {
    warnings.push(`未能写入生词本：${touched.error}`)
  } else if (save && !saved) {
    warnings.push('未能写入生词本')
  }

  return {
    ok: true,
    dict: {
      word: info.word,
      query: info.query,
      matchedBy: info.matchedBy,
      asForm: info.asForm,
      phonetic: info.phonetic || extra.phonetic || '',
      senses: info.senses,
      definition: info.definition,
      forms: info.forms,
      tags: info.tags,
      frequency: info.frequency,
      collins: info.collins,
      oxford: info.oxford,
      // 用户的判断依据，不是自动过滤
      likelyKnown: dict.isLikelyKnown(info),
    },
    enrich: {
      ok: extra.ok,
      examples: extra.examples || [],
      synonyms: extra.synonyms || [],
      error: extra.error || '',
    },
    saved: saved
      ? {
          id: saved.id,
          seenCount: saved.seenCount,
          starred: saved.starred,
          ability: saved.ability,
          isNew: touched.isNew,
        }
      : null,
    warnings,
  }
}

/** /lookup 响应发出后的收尾副作用：AI 分析入队。失败只记日志，不影响已发出的响应。 */
export function enqueueLookupFollowUps(
  ctx: unknown,
  store: Store,
  result: LookupResult,
  payload: { sentence?: unknown },
): void {
  if (!result.ok || !result.dict) return
  // 后台异步：首次遇见的词丢进 AI 分析队列（生成词根/干扰项/记忆方法）。
  // 义项材料：只有带着原句查词时才有意义。后台串行跑，不阻塞划词卡片；
  // 分析还没好的时候，补记卡退回自由回忆（P0 路径）。
  const savedRow = store.get(result.dict.word)
  enqueueSenseAnalysis(ctx, store, {
    word: result.dict.word,
    translation: (savedRow && savedRow.translation) || '',
    sentence: String(payload.sentence || '').slice(0, 2000),
  })
  enqueueAnalysis(
    ctx,
    store,
    result.dict.word,
    result.dict.senses.map((s) => (s.pos ? `${s.pos} ${s.text}` : s.text)).join('\n'),
    (result.dict.definition || []).join('\n'),
  )
}
