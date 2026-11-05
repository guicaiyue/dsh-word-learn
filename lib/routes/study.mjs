// routes/study.mjs —— 学习主线：查词、生词本增删改查、列表、整句翻译
//
// 这些路由的公共形态：先 parse 参数（数字走 http.mjs 的 intParam），
// 再 store.open() 判据，最后统一走 sendJson / fail 出口。

import { dict, store } from '../runtime.mjs'
import { intParam, strParam } from '../host/http.js'
import { classifySelection, looksLikeWord, pickBest, splitWords } from '../host/text.js'
import { enqueueLookupFollowUps, lookupWord } from '../lookup.mjs'
import { cardStates } from '../host/schedule.js'
import { translate, translateStatus } from '../translate.mjs'
import {
  API_LIST,
  API_LOOKUP,
  API_REMOVE,
  API_SAVE,
  API_TRANSLATE,
  API_UPDATE,
  API_WORD,
} from './paths.mjs'
import { fail, isFalse, readJson, safeSend, sendJson } from './shared.mjs'

/**
 * @param {Function} registerRoute 带栅栏 / methods 白名单 / 500 兜底的注册器
 * @returns {Array<Function>} 卸载函数
 */
export function registerStudyRoutes(registerRoute, ctx) {
  const disposers = []

  // 查词

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_LOOKUP,
      methods: ['GET', 'POST'],
      handler: async (req, res) => {
        let payload
        try {
          payload =
            req.method === 'POST'
              ? await readJson(req)
              : Object.fromEntries(new URL(req.url, 'http://x').searchParams)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const word = String(payload.word || '').trim()
        if (!word) {
          sendJson(res, 400, { ok: false, error: '没有要查的词' })
          return
        }
        // 拒绝"看起来不像单词"的输入。
        //
        // 为什么加这道闸：前端划词已经过滤过一轮，但**路由是公开的**，
        // 而且实测漏进来过 —— 模型回答里的 `≈62.3M`、`≈65.7k` 被划中后
        // 把单位后缀 `M`、`k` 当成了单词存进生词本，两条噪音词条。
        // 过滤放在这里，无论调用方是谁都拦得住。
        // 注意只对"单个 token"的查询生效：查 `take effect` 这种短语
        // 由 /save 负责拆词，这里若整串丢进 looksLikeWord 会误杀。
        if (!/\s/.test(word) && !looksLikeWord(word)) {
          sendJson(res, 400, { ok: false, error: `「${word}」不像一个英文单词` })
          return
        }
        try {
          // GET 的 query 参数都是字符串，`save=false` 得按字符串认，
          // 只判 `!== false` 会把 'false' 当成 true（踩过一次）。
          const save = !isFalse(payload.save)
          const result = await lookupWord(word, {
            withEnrich: !isFalse(payload.enrich),
            sentence: String(payload.sentence || '').slice(0, 2000),
            save,
          })
          safeSend(res, result.ok ? 200 : 404, result)
          // 响应已发出：下面的入队是收尾副作用，出错只能记日志，
          // 绝不能改状态码（客户端会当失败重试，重复查词/重复入队）。
          try {
            if (save) enqueueLookupFollowUps(ctx, store, result, payload)
          } catch (err) {
            try {
              console.warn(
                '[dsh-word-learn] 查词后入队失败：' + ((err && err.message) || String(err)),
              )
            } catch (e) {}
          }
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // 翻译：把划中的一段话翻成简体中文。
  //
  // 这是"划句子"场景的主功能。拆词只是它下面的一行附加，
  // 不能拿拆词冒充翻译 —— 用户划一句话是因为没读懂，不是想收集生词。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_TRANSLATE,
      methods: ['GET', 'POST'],
      handler: async (req, res) => {
        let payload
        try {
          payload =
            req.method === 'POST'
              ? await readJson(req)
              : Object.fromEntries(new URL(req.url, 'http://x').searchParams)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const text = String(payload.text || '').trim()
        if (!text) {
          sendJson(res, 400, { ok: false, error: '没有要翻译的内容' })
          return
        }
        // 划词浮层是交互路径：翻译失败也要回 200 + ok:false，
        // 让卡片画一行"翻译失败"就好，不要用 500 让前端当网络错误处理。
        const result = await translate(ctx, text.slice(0, 6000))
        sendJson(res, 200, { ...result, status: translateStatus() })
      },
    }),
  )

  // 拆词：把一个短语/句子拆成候选单词，并逐个给词典结果（不含外部增强）

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_SAVE,
      methods: ['POST'],
      handler: async (req, res) => {
        let payload
        try {
          payload = await readJson(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const text = String(payload.text || '').trim()
        if (!text) {
          sendJson(res, 400, { ok: false, error: '没有文本' })
          return
        }
        try {
          const classified = classifySelection(text)
          const words = classified.words.length ? classified.words : splitWords(text)
          const items = words.slice(0, 40).map((word) => {
            const info = dict.lookup(word)
            if (!info) return { word, found: false }
            return {
              word: info.word,
              found: true,
              phonetic: info.phonetic,
              brief: info.senses[0] ? info.senses[0].text.slice(0, 60) : '',
              frequency: info.frequency,
              tags: info.tags.map((t) => t.label),
              likelyKnown: dict.isLikelyKnown(info),
            }
          })
          sendJson(res, 200, {
            ok: true,
            kind: classified.kind,
            best: pickBest(words),
            words: items,
          })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // 生词本列表

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_LIST,
      methods: ['GET'],
      handler: (req, res) => {
        const url = new URL(req.url, 'http://x')
        // 负 limit 在 SQLite 里等于「不设上限」（会全表导出），必须夹住
        const result = store.list({
          limit: intParam(url, 'limit', { fallback: 200, min: 1, max: 500, floor: true }),
          offset: intParam(url, 'offset', { fallback: 0, min: 0, floor: true }),
          tier: strParam(url, 'tier'),
          starredOnly: url.searchParams.get('starred') === '1',
          order: strParam(url, 'order', 'recent'),
        })
        sendJson(res, 200, { ok: true, ...result })
      },
    }),
  )

  // 改画像 / 收藏 / 笔记

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_UPDATE,
      methods: ['POST'],
      handler: async (req, res) => {
        let payload
        try {
          payload = await readJson(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const ok = store.update(String(payload.word || ''), payload.patch || {})
        sendJson(res, ok ? 200 : 404, { ok })
      },
    }),
  )

  // 移除

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_REMOVE,
      methods: ['POST'],
      handler: async (req, res) => {
        let payload
        try {
          payload = await readJson(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        sendJson(res, 200, { ok: store.remove(String(payload.word || '')) })
      },
    }),
  )

  // 单词详情（含两条排期线的状态）

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_WORD,
      methods: ['GET'],
      handler: (req, res) => {
        const url = new URL(req.url, 'http://x')
        const word = String(url.searchParams.get('word') || '').trim()
        if (!word) {
          sendJson(res, 400, { ok: false, error: '没有要查的词' })
          return
        }
        try {
          const info = store.get(word)
          if (!info) {
            sendJson(res, 404, { ok: false, error: '生词本里没有这个词' })
            return
          }
          const dictInfo = dict.lookup(word)
          sendJson(res, 200, {
            ok: true,
            entry: info,
            dict: dictInfo || null,
            cards: cardStates(store.db, info.id),
          })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  return disposers
}
