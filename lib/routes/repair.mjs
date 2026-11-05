// routes/repair.mjs —— 补救与回访：repair 日志/统计/清空、R5 次日 recap
//
// repair 是「记债」的出口：评分写库成功但记账失败时留给这里补。
// R5 只记日志、不动 FSRS 排期（r5.mjs 的约束）。

import { store } from '../runtime.mjs'
import { intParam } from '../http.mjs'
import { enqueueSenseAnalysis } from '../ai-enrich.mjs'
import { buildRecap, submitRecap } from '../r5.mjs'
import {
  API_RECAP,
  API_REPAIR,
  API_REPAIR_CLEAR,
  API_REPAIR_LOG,
  API_REPAIR_STATS,
} from './paths.mjs'
import { fail, readJson, sendJson, unavailable } from './shared.mjs'

/**
 * @param {Function} registerRoute 带栅栏 / methods 白名单 / 500 兜底的注册器
 * @returns {Array<Function>} 卸载函数
 */
export function registerRepairRoutes(registerRoute, ctx) {
  const disposers = []

  // 补记卡：义项材料 + 原句 + 债。前端按「忘了」时才拉，不预热整轮队列。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_REPAIR,
      methods: ['GET'],
      handler: (req, res) => {
        const url = new URL(req.url, 'http://x')
        const cardId = Number(url.searchParams.get('cardId')) || 0
        if (!cardId) {
          sendJson(res, 400, { ok: false, error: '缺少 cardId' })
          return
        }
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          const row = store.db
            .prepare(
              `SELECT c.id AS card_id, c.word_id, c.track, w.word, w.translation, w.phonetic
                     FROM cards c JOIN words w ON w.id = c.word_id
                    WHERE c.id = ?`,
            )
            .get(cardId)
          if (!row) {
            sendJson(res, 404, { ok: false, error: '找不到这张卡' })
            return
          }
          const sentence = store.latestSentence(row.word)
          const senseMeta = store.getSenseMeta(row.word)
          if (!senseMeta && sentence) {
            // 第一次忘了这个词：现排一次分析，这次先用自由回忆顶上。
            enqueueSenseAnalysis(ctx, store, {
              word: row.word,
              translation: row.translation || '',
              sentence,
            })
          }
          sendJson(res, 200, {
            ok: true,
            cardId,
            wordId: row.word_id,
            word: row.word,
            phonetic: row.phonetic || '',
            sentence,
            senseMeta,
            debt: store.getRepairDebt(row.word_id),
          })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // 补记事件：只落 repair_log，不碰 FSRS 排期。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_REPAIR_LOG,
      methods: ['POST'],
      handler: async (req, res) => {
        let payload
        try {
          payload = await readJson(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const cardId = Number(payload.cardId) || 0
        if (!cardId) {
          sendJson(res, 400, { ok: false, error: '缺少 cardId' })
          return
        }
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          const row = store.db.prepare('SELECT word_id FROM cards WHERE id = ?').get(cardId)
          if (!row) {
            sendJson(res, 404, { ok: false, error: '找不到这张卡' })
            return
          }
          store.logRepair({
            wordId: row.word_id,
            cardId,
            stage: payload.stage,
            ok: payload.ok,
            guess: payload.guess,
            elapsedMs: payload.elapsedMs,
          })
          sendJson(res, 200, { ok: true })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // 清债：R4 也过了才调，重复调用无害。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_REPAIR_CLEAR,
      methods: ['POST'],
      handler: async (req, res) => {
        let payload
        try {
          payload = await readJson(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          let wordId = Number(payload.wordId) || 0
          const cardId = Number(payload.cardId) || 0
          if (!wordId && cardId) {
            const row = store.db.prepare('SELECT word_id FROM cards WHERE id = ?').get(cardId)
            wordId = row ? row.word_id : 0
          }
          if (!wordId) {
            sendJson(res, 400, { ok: false, error: '缺少 wordId 或 cardId' })
            return
          }
          store.clearRepairDebt(wordId)
          sendJson(res, 200, { ok: true })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // 补记效果统计：判断这个循环有没有用，而不是凭感觉。
  //
  // 关心三件事：忘了以后有多少人真的走完补记（tries）、
  // 义项判别首猜正确率（pick 的 ok）、以及债多久能清（debt）。
  // 全部读 repair_log / repair_debt，不碰 FSRS 的表。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_REPAIR_STATS,
      methods: ['GET'],
      handler: (req, res) => {
        const url = new URL(req.url, 'http://x')
        const days = intParam(url, 'days', { fallback: 14, min: 1, max: 90 })
        const since = Date.now() - days * 86400000
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          const stages = store.db
            .prepare(
              `SELECT stage, COUNT(*) AS n, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok
                     FROM repair_log WHERE created_at >= ? GROUP BY stage`,
            )
            .all(since)
          const debt = store.db
            .prepare(
              `SELECT COUNT(*) AS opened,
                          SUM(CASE WHEN cleared_at IS NOT NULL THEN 1 ELSE 0 END) AS cleared
                     FROM repair_debt WHERE opened_at >= ?`,
            )
            .get(since)
          sendJson(res, 200, {
            ok: true,
            days,
            stages: stages.map((s) => ({
              stage: s.stage,
              n: Number(s.n) || 0,
              ok: Number(s.ok) || 0,
            })),
            debt: {
              opened: Number(debt && debt.opened) || 0,
              cleared: Number(debt && debt.cleared) || 0,
            },
          })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // P2 · R5 次日回访：取一批「昨天忘过/修过」的词，换句判别同义/异义。
  // 只读 contexts/sense_meta，不动 FSRS —— 这是检验，不是复习。
  // GET 取题，POST 交卷（同一路径按 method 分流，与其它路由一致）。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_RECAP,
      methods: ['GET', 'POST'],
      handler: async (req, res) => {
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          if (req.method === 'POST') {
            let payload
            try {
              payload = await readJson(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            if (!payload || !Number(payload.wordId)) {
              sendJson(res, 400, { ok: false, error: '缺少 wordId' })
              return
            }
            const result = submitRecap(store, payload)
            sendJson(res, 200, { ok: true, ...result })
            return
          }
          const url = new URL(req.url, 'http://x')
          const limit = intParam(url, 'limit', { fallback: 5, min: 1, max: 10 })
          sendJson(res, 200, { ok: true, ...buildRecap(store, { limit }) })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  return disposers
}
