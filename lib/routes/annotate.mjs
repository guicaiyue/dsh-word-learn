// routes/annotate.mjs —— 对话内联标注的目标词表与义项地图
//
// 只返回「在学、有卡片」的词：避免满屏标生词（annotate.mjs 的判据）。
// rev 变了前端会清掉重标；空库也要 200 + 空数组，前端静默无标注。

import { store } from '../runtime.mjs'
import { intParam } from '../http.mjs'
import { normalizeWord } from '../text.js'
import { annotateWordList } from '../annotate.mjs'
import { senseMap } from '../r5.mjs'
import { API_ANNOTATE_WORDS, API_SENSE_MAP } from './paths.mjs'
import { fail, sendJson, unavailable } from './shared.mjs'

/**
 * @param {Function} registerRoute 带栅栏 / methods 白名单 / 500 兜底的注册器
 * @returns {Array<Function>} 卸载函数
 */
export function registerAnnotateRoutes(registerRoute) {
  const disposers = []

  // P3 标注层目标词表：只返回在学、有卡片的词（避免满屏标生词）。
  // rev 变了前端会清掉重标；空库也要 200 + 空数组，前端静默无标注。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_ANNOTATE_WORDS,
      methods: ['GET'],
      handler: (req, res) => {
        const url = new URL(req.url, 'http://x')
        const limit = intParam(url, 'limit', { fallback: 2000, min: 1, max: 5000 })
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          const words = annotateWordList(store, { limit })
          // annotateWordList 失败时返回 { ok:false, error }（不带 words）。
          // 这里映射成 500：语义清楚，日志/监控能看到；前端已按 ok:false 处理并保留旧标注。
          if (words && words.ok === false) {
            sendJson(res, 500, words)
            return
          }
          sendJson(res, 200, { ok: true, ...words })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // P2 · 义项地图：这个词见过哪几个义项、各自答对过没有。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_SENSE_MAP,
      methods: ['GET'],
      handler: (req, res) => {
        const url = new URL(req.url, 'http://x')
        const word = normalizeWord(url.searchParams.get('word') || '')
        if (!word) {
          sendJson(res, 400, { ok: false, error: '词不合法' })
          return
        }
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          sendJson(res, 200, { ok: true, word, senses: senseMap(store, word) })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  return disposers
}
