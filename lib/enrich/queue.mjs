// enrich/queue.mjs —— 后台分析队列：串行调度、去重、限流、卸载收尾。
//
// 从 ai-enrich.mjs 拆出来的（2026-11-05，原文件超 CODE_BUDGET）。
// 队列分两条（词级 / 义项），互不阻塞：义项分析更容易失败，不能拖住词级分析。
// 依赖方向刻意单向：queue → analysis / sense / llm / models，
// 被调用的业务模块不知道队列存在（否则 disposeQueues 会绕成环）。
import { resolveAiModel } from '../models.mjs'
import { analyzeWord } from './analysis.mjs'
import { analyzeSense } from './sense.mjs'
import { reason } from './llm.mjs'

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
