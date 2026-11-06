// @vitest-environment node
// 测什么：lib/enrich/queue.mjs 的「dispose 之后还能重新武装」。
//
// 为什么必须有这条回归：队列是模块级单例状态。插件热重挂（不重启 dsh）时
// lib/index.js 的清理会调 disposeQueues()；如果 disposed 置位后永不复位，
// 之后所有 enqueue* 都直接 return —— AI 分析与义项分析静默失效，用户只能
// 重启宿主。legacy 脚本每次都是新进程，天然测不到「同一进程里 dispose 后再入队」。
//
// 约束（CONVENTIONS §9.2）：模型调用全部 stub（假 ctx.llm，不发真网络）；
// 在任何 lib/* import 之前把 DSH_HOME 指向 mkdtemp 出的临时目录，绝不碰真实用户库。
import { afterAll, describe, test } from 'vitest'
import assert from 'node:assert/strict'

import { useTempHome } from '../helpers/tmp-home.mjs'

// 关键时序：先造临时 DSH_HOME，再动态 import 队列（静态 import 会被提升到前面）。
const tmp = useTempHome('dwl-queue-unit-')
const { disposeQueues, enqueueAnalysis, enqueueSenseAnalysis } =
  await import('../../lib/host/enrich/queue.js')
afterAll(() => tmp.cleanup())

/** 等 predicate 成立，超时给可读失败信息（而不是让测试静默挂住）。 */
async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

/** 假模型服务：只实现 models.mjs / analysis.mjs / sense.mjs 用到的接口，不发网络。 */
function makeLlm() {
  return {
    listProviders: () => [{ id: 'stub-provider', name: 'Stub Provider' }],
    listModels: async () => [{ provider: 'stub-provider', id: 'stub-model', name: 'Stub Model' }],
    async prepareCall() {
      return {
        config: {},
        async *stream(options) {
          // 词级分析要 word_meta，义项分析要 sense_meta：按 system 提示词分流
          const isSense = /义项修复卡/.test(String(options.system || ''))
          if (isSense) {
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                sense_here: '甲',
                likely_assumed: '乙',
                why_confusable: '技术语境里常把这两个义项混着用',
                contrast: '你以为是乙，这句里是甲',
                personal_example: 'We beta the release now.',
                cloze: 'We ______ the release now.',
                other_sense: { sentence: 'The beta is 甲 here.', gloss: '乙' },
                etymology_note: '',
                confidence: 'low',
              }),
            }
          } else {
            yield { type: 'text-delta', text: '{"mnemonic":"stub 记忆法"}' }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
}

/** 假 Store：只保留队列与 resolveAiModel 会碰的方法。 */
function makeStore() {
  const metas = new Map()
  const senseMetas = new Map()
  return {
    metas,
    senseMetas,
    getMeta: (word) => metas.get(word) || null,
    setMeta: (word, meta) => metas.set(word, meta),
    getSenseMeta: (word) => senseMetas.get(word) || null,
    setSenseMeta: (word, meta) => senseMetas.set(word, meta),
    getSetting: () => null,
  }
}

const ctx = { get: (name) => (name === 'llm' ? makeLlm() : undefined) }

describe('enrich 队列：dispose 后可重新武装', () => {
  test('dispose 前正常调度（基线，证明 stub 通路本身是通的）', async () => {
    const store = makeStore()
    enqueueAnalysis(ctx, store, 'alpha', 'n. 甲', 'definition')
    await waitFor(() => store.metas.has('alpha'), '基线：enqueueAnalysis 后应写入 word_meta')
    assert.equal(store.metas.get('alpha').mnemonic, 'stub 记忆法')
  })

  test('dispose 后再次 enqueueAnalysis 仍会调度（热重挂后不能静默失效）', async () => {
    disposeQueues()
    const store = makeStore()
    enqueueAnalysis(ctx, store, 'beta', 'n. 甲', 'definition')
    await waitFor(
      () => store.metas.has('beta'),
      'disposeQueues() 后再 enqueueAnalysis 应该重新武装调度并写入 word_meta，' +
        '否则插件热重挂后 AI 分析会静默失效，只能重启宿主',
    )
  })

  test('dispose 后再次 enqueueSenseAnalysis 仍会调度', async () => {
    disposeQueues()
    const store = makeStore()
    enqueueSenseAnalysis(ctx, store, {
      word: 'beta',
      translation: 'n. 甲, 乙, 丙, 丁',
      sentence: 'We beta the release now.',
    })
    await waitFor(
      () => store.senseMetas.has('beta'),
      'disposeQueues() 后再 enqueueSenseAnalysis 应该重新武装调度并写入 sense_meta',
    )
    assert.equal(store.senseMetas.get('beta').sense_here, '甲')
  })
})
