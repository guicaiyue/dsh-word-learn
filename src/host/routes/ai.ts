// routes/ai.mjs —— AI 分析、义项材料、出题与模型选择
//
// 外部调用一律走 service.mjs / ai-enrich.mjs，失败降级成 ok:false 而不是 500。
// 模型选择复用 DSH 的模型目录（models.mjs），插件不维护自己的名单。

import { dict, store } from '../runtime.js'
import { analyzeWord, generateQuiz } from '../ai-enrich.js'
import {
  clearSavedSelection,
  listTextModels,
  publicSelection,
  resolveAiModel,
  saveSavedSelection,
  savedSelectionLost,
} from '../models.js'
import type { WordAnalysis } from '../enrich/analysis.js'
import type { WordMeta } from '../store/words.js'
import { API_ENRICH_AI, API_MODEL, API_MODELS, API_MODEL_INFO, API_QUIZ } from './paths.js'
import { fail, readJson, safeSend, sendJson, unavailable } from './shared.js'
import type { RegisterRoute, RouteContext } from './shared.js'

/**
 * @param {Function} registerRoute 带栅栏 / methods 白名单 / 500 兜底的注册器
 * @returns {Array<Function>} 卸载函数
 */
export function registerAiRoutes(
  registerRoute: RegisterRoute,
  ctx: RouteContext,
): Array<() => void> {
  const disposers: Array<() => void> = []

  // AI 分析（手动触发 / 批量补分析）

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_ENRICH_AI,
      methods: ['POST'],
      handler: async (req, res) => {
        let payload!: Record<string, unknown>
        try {
          payload = await readJson(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const word = String(payload.word || '')
          .trim()
          .toLowerCase()
        if (!word) {
          sendJson(res, 400, { ok: false, error: '缺少 word' })
          return
        }
        const force = !!payload.force
        const field = typeof payload.field === 'string' ? payload.field : ''
        const VALID_FIELDS = ['roots', 'synonyms', 'distractors', 'mnemonic', 'confusables']
        if (field && !VALID_FIELDS.includes(field)) {
          sendJson(res, 400, {
            ok: false,
            error: '无效的 field，可选：' + VALID_FIELDS.join(', '),
          })
          return
        }
        try {
          // 非强制、非单项 且已有完整结果 → 直接返回
          const existing = store.getMeta(word)
          if (!force && !field && existing && existing.analyzedAt) {
            sendJson(res, 200, { ok: true, meta: existing, cached: true })
            return
          }
          // 现场分析（同步等结果）
          const entry = store.get(word)
          const dictInfo = dict.lookup(word)
          const translation = entry
            ? entry.translation
            : dictInfo
              ? dictInfo.senses.map((s) => s.text).join('\n')
              : ''
          const definition = dictInfo ? (dictInfo.definition || []).join('\n') : ''
          const selection = await resolveAiModel(ctx, store)
          // 失败要说清楚原因：模型不可用、限流、返回的不是 JSON 都不一样，
          // 糊成一句"可能是模型不可用"只会让人换模型瞎试。
          let meta!: WordAnalysis
          try {
            meta = await analyzeWord(ctx, word, translation, definition, selection)
          } catch (err) {
            const cause = err as { message?: unknown; code?: unknown } | null
            const message = String((cause && cause.message) || 'AI 分析失败')
            try {
              console.warn('[dsh-word-learn] AI 分析失败 ' + word + '：' + message)
            } catch {}
            sendJson(res, 502, {
              ok: false,
              error: message,
              code: (cause && cause.code) || 'ANALYSIS_FAILED',
            })
            return
          }
          let final: WordAnalysis | WordMeta = meta
          if (field && existing) {
            // 单字段更新：只替换指定字段，保留其他
            final = {
              ...existing,
              [field]: (meta as unknown as Record<string, unknown>)[field],
              analyzedAt: Date.now(),
            }
          }
          store.setMeta(word, final)
          sendJson(res, 200, { ok: true, meta: final, cached: false })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // 选择题数据

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_QUIZ,
      methods: ['GET'],
      handler: (req, res) => {
        const url = new URL(req.url, 'http://x')
        const word = String(url.searchParams.get('word') || '')
          .trim()
          .toLowerCase()
        if (!word) {
          sendJson(res, 400, { ok: false, error: '缺少 word' })
          return
        }
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          const entry = store.get(word)
          if (!entry) {
            sendJson(res, 404, { ok: false, code: 'WORD_NOT_FOUND', error: '生词本里没有这个词' })
            return
          }
          const meta = store.getMeta(word)
          const quiz = generateQuiz(word, entry.translation, meta, store)
          if (!quiz) {
            sendJson(res, 200, { ok: false, error: '无法生成选择题（释义不足）' })
            return
          }
          sendJson(res, 200, { ok: true, quiz })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // AI 分析模型：DSH 模型目录里的文本模型清单 + 当前选择。
  //
  // 清单和 GUI 模型选择器同源（ctx.llm.listProviders/listModels），
  // 不自己维护模型名单；选择默认取目录第一个，用户自选后存进 user.db。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_MODELS,
      methods: ['GET'],
      handler: async (_req, res) => {
        try {
          const resolved = await resolveAiModel(ctx, store)
          sendJson(res, 200, {
            ok: true,
            models: resolved.models,
            failures: resolved.failures,
            selection: publicSelection(resolved),
            // 目录第一个，前端用来说明"默认就是这个"
            defaultSelection: resolved.models.length
              ? {
                  provider: resolved.models[0].provider,
                  model: resolved.models[0].id,
                  name: resolved.models[0].name,
                  providerName: resolved.models[0].providerName,
                }
              : null,
            // 用户自选过、但现在目录里已经没有的模型（提示用）
            lostSelection: savedSelectionLost(store, resolved.models),
          })
        } catch (err) {
          try {
            console.warn(
              '[dsh-word-learn] 模型目录不可用：' +
                String((err as { message?: unknown } | null)?.message || err),
            )
          } catch (e) {}
          safeSend(res, 500, {
            ok: false,
            code: 'MODELS_UNAVAILABLE',
            error: '读不到模型目录，请稍后重试',
            models: [],
          })
        }
      },
    }),
  )

  // 保存 / 重置 AI 分析模型

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_MODEL,
      methods: ['POST'],
      handler: async (req, res) => {
        let payload!: Record<string, unknown>
        try {
          payload = await readJson(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        try {
          if (payload && payload.reset) {
            clearSavedSelection(store)
            const resolved = await resolveAiModel(ctx, store)
            sendJson(res, 200, { ok: true, selection: publicSelection(resolved) })
            return
          }
          const provider = String((payload && payload.provider) || '').trim()
          const model = String((payload && payload.model) || '').trim()
          if (!provider || !model) {
            sendJson(res, 400, { ok: false, error: '缺 provider 或 model' })
            return
          }
          // 只接受目录里真实存在、且还能用的模型，防止存进一个拼错的名字
          const catalog = await listTextModels(ctx)
          const hit = catalog.models.find((m) => m.provider === provider && m.id === model)
          if (!hit) {
            sendJson(res, 400, { ok: false, error: `模型不可用：${provider} / ${model}` })
            return
          }
          saveSavedSelection(store, provider, model)
          const resolved = await resolveAiModel(ctx, store, catalog)
          sendJson(res, 200, { ok: true, selection: publicSelection(resolved) })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // AI 模型信息（兼容旧接口：返回 AI 分析当前实际用的模型）

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_MODEL_INFO,
      methods: ['GET'],
      handler: async (_req, res) => {
        try {
          const resolved = await resolveAiModel(ctx, store)
          sendJson(res, 200, {
            ok: true,
            provider: resolved.provider || null,
            model: resolved.model || null,
            name: resolved.name || '',
            source: resolved.source,
          })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  return disposers
}
