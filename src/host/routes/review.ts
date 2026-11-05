// routes/review.mjs —— 复习视图：仪表盘、到期队列、评分
//
// 排期与 FSRS 映射全部在 schedule.mjs；这里只做参数解析与出参整形。
// 评分先落库再记债：记债失败不能让用户看到 500（see test-routes 回归）。

import { store } from '../runtime.js'
import { intParam, strParam } from '../http.js'
import { applyGrade, dueQueue, scheduleStatus, warmSchedule } from '../schedule.js'
import { API_DASHBOARD, API_GRADE, API_QUEUE } from './paths.js'
import { clampInt, fail, readJson, safeSend, sendJson, unavailable } from './shared.js'
import type { RegisterRoute, RouteContext } from './shared.js'

/**
 * @param {Function} registerRoute 带栅栏 / methods 白名单 / 500 兜底的注册器
 * @returns {Array<Function>} 卸载函数
 */
export function registerReviewRoutes(
  registerRoute: RegisterRoute,
  _ctx: RouteContext,
): Array<() => void> {
  const disposers: Array<() => void> = []

  // 学习页看板：一次拿到整个页面要的聚合数据

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_DASHBOARD,
      methods: ['GET'],
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://x')
        const days = intParam(url, 'days', { fallback: 14, min: 3, max: 60 })
        try {
          const data = store.dashboard({ forecastDays: days })
          // 排期引擎是**懒加载**的：没人评过分时它还没被 import，
          // 直接问 scheduleStatus() 会得到 ok:false 的假警报
          // （界面显示"排期引擎不可用"，但实际能用）。
          // 这里先 await 一次预热，确保状态是真实的。
          await warmSchedule()
          sendJson(res, data.ok ? 200 : 500, { ...data, schedule: scheduleStatus() })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // 待复习队列（今日到期），附带 word_meta

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_QUEUE,
      methods: ['GET'],
      handler: (req, res) => {
        const url = new URL(req.url, 'http://x')
        const limit = intParam(url, 'limit', { fallback: 200, min: 1, max: 500 })
        const track = strParam(url, 'track')
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          let items = dueQueue(store.db!, { limit })
          if (track) items = items.filter((i) => i.track === track)

          // 批量取 word_meta，挂到每个 item 上
          const words = [...new Set(items.map((i) => i.word))]
          const metaMap = store.getMetaBatch(words)
          for (const item of items) {
            item.wordMeta = metaMap[item.word] || null
          }

          sendJson(res, 200, {
            ok: true,
            items,
            total: items.length,
            newCount: items.filter((i) => i.isNew).length,
            reviewCount: items.filter((i) => !i.isNew).length,
          })
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  // 提交一次评分

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: API_GRADE,
      methods: ['POST'],
      handler: async (req, res) => {
        let payload!: Record<string, unknown>
        try {
          payload = await readJson(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const cardId = clampInt(payload.cardId)
        const rating = clampInt(payload.rating)
        if (!cardId) {
          sendJson(res, 400, { ok: false, error: '缺少 cardId' })
          return
        }
        if (rating < 1 || rating > 4) {
          sendJson(res, 400, { ok: false, error: 'rating 必须是 1-4' })
          return
        }
        try {
          if (!store.open()) {
            unavailable(res, store)
            return
          }
          const result = await applyGrade(store.db!, cardId, rating)
          // 卡不存在是客户端问题（404），不是服务器故障（500）
          const code = result.ok ? 200 : result.code === 'not_found' ? 404 : 500
          // ⚠️ 先发响应，再做收尾副作用：applyGrade 已经写库，
          // 这里若因记债抛错回 500，客户端会重试 → 同一张卡评两次（FSRS 不可逆）。
          safeSend(res, code, result)
          if (result.ok && rating === 1) {
            try {
              // 评「忘了」开一笔补记债：会话末要复现一次，清了才算还完。
              // 注意这只是记账，不改变 FSRS 的任何字段。
              store.openRepairDebt(cardId)
            } catch (err) {
              try {
                console.warn(
                  '[dsh-word-learn] 评分已写入但记债失败 cardId=' +
                    cardId +
                    '：' +
                    String((err as { message?: unknown } | null)?.message || err),
                )
              } catch (e) {}
            }
          }
        } catch (err) {
          fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
        }
      },
    }),
  )

  return disposers
}
