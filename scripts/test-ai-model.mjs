// 验证 AI 分析模型的选择逻辑：DSH 模型目录复用、默认第一个、自选落盘、
// 模型消失后回退。不碰真实用户库（DSH_HOME 指到临时目录）。
//
// 为什么单独立一个：宿主要重启才加载新代码，重启前得先确认
// models.mjs 的取舍（"目录第一个"到底是哪个、失败了会不会整体崩）是对的。
//
// 假 ctx 只通过 get(name) 暴露服务 —— 真实 DSH（cordis 4）就是这样，
// 属性访问 ctx.llm 拿不到东西。早先这个假 ctx 把服务也挂在属性上，
// 正好盖住了 ai-enrich.mjs "只试 ctx[name]" 那个 bug（AI 分析永远失败）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-model-test-'))
process.env.DSH_HOME = tmp

const { Store } = await import('../lib/host/store.js')
const {
  listTextModels,
  resolveAiModel,
  saveSavedSelection,
  clearSavedSelection,
  savedSelectionLost,
  publicSelection,
} = await import('../lib/host/models.js')
const { analyzeWord, parseResponse, AnalysisError } = await import('../lib/ai-enrich.mjs')

const providerCallLog = []
const prepareCalls = []

const services = {
  llm: {
    listProviders() {
      return [
        { id: 'deepseek-official', name: 'DeepSeek 官方' },
        { id: 'broken', name: '坏掉的适配器' },
        { id: 'vision-only', name: '只吃图片' },
      ]
    },
    async listModels(provider) {
      providerCallLog.push(provider)
      if (provider === 'broken') throw new Error('adapter exploded')
      if (provider === 'vision-only') {
        return [{ provider, id: 'img-1', name: 'Image Only', inputModalities: ['image'] }]
      }
      return [
        { provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: '快' },
        { provider, id: 'deepseek-v4', name: 'DeepSeek V4' },
        { provider, id: 'deepseek-coder', name: 'DeepSeek Coder', inputModalities: ['text'] },
      ]
    },
    async prepareCall(config) {
      prepareCalls.push(config)
      return {
        config: {},
        async *stream() {
          yield {
            type: 'text-delta',
            text: '{"roots":[{"part":"re-","type":"prefix","meaning":"再次"}],',
          }
          yield { type: 'text-delta', text: '"synonyms":["ahead"],"distractors":["旋转","共鸣"],' }
          yield { type: 'text-delta', text: '"mnemonic":"联想","confusables":["revolution"]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  },
  agentDefaultModel: {
    currentSelection() {
      return { provider: 'agent-provider', model: 'agent-model' }
    },
  },
}

/** 真实 cordis 的取法：服务只挂在 ctx.get 上，属性是 undefined。 */
const ctx = {
  get(name) {
    return services[name]
  },
}

const store = new Store()
assert.equal(store.open(), true, '用户库应能打开')

// ── 1. 目录：只留文本模型，单个适配器失败不拖垮整张表
const catalog = await listTextModels(ctx)
assert.deepEqual(
  catalog.models.map((m) => m.id),
  ['deepseek-v4-flash', 'deepseek-v4', 'deepseek-coder'],
  '应按注册顺序列出文本模型，且排除纯图像模型',
)
assert.equal(catalog.failures.length, 1)
assert.equal(catalog.failures[0].provider, 'broken')
assert.equal(catalog.models[0].providerName, 'DeepSeek 官方', 'providerName 要能给人看')

// ── 2. 没选过 → 默认第一个
let resolved = await resolveAiModel(ctx, store)
assert.equal(resolved.source, 'default')
assert.deepEqual(publicSelection(resolved), {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  providerName: 'DeepSeek 官方',
  source: 'default',
})

// ── 3. 自选后落盘，读回仍是自选
assert.equal(saveSavedSelection(store, 'deepseek-official', 'deepseek-v4'), true)
resolved = await resolveAiModel(ctx, store)
assert.equal(resolved.source, 'custom')
assert.equal(resolved.model, 'deepseek-v4')

// ── 4. 自选模型从目录里消失 → 退回第一个，并报出丢掉的旧选择
const shrunkCtx = {
  get: (name) =>
    name === 'llm'
      ? {
          listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
          listModels: async () => [
            { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          ],
        }
      : undefined,
}
const shrunkCatalog = await listTextModels(shrunkCtx)
resolved = await resolveAiModel(shrunkCtx, store, shrunkCatalog)
assert.equal(resolved.source, 'default', '自选模型消失后应回退默认')
assert.equal(resolved.model, 'deepseek-v4-flash')
assert.deepEqual(savedSelectionLost(store, shrunkCatalog.models), {
  provider: 'deepseek-official',
  model: 'deepseek-v4',
})

// ── 5. 目录整个不可用 → 退回会话默认模型（至少还能分析）
const noLlmCtx = {
  get: (name) => (name === 'agentDefaultModel' ? services.agentDefaultModel : undefined),
}
resolved = await resolveAiModel(noLlmCtx, store)
assert.equal(resolved.source, 'agent')
assert.equal(resolved.model, 'agent-model')

// 连会话默认都没有 → none，且不抛错
resolved = await resolveAiModel({ get: () => undefined }, store)
assert.equal(resolved.source, 'none')
assert.equal(resolved.model, '')

// ── 6. analyzeWord 用选中的模型，并把 provider/model 记进 meta
clearSavedSelection(store)
const meta = await analyzeWord(
  ctx,
  'resolve',
  'v. 决心',
  'to decide firmly',
  await resolveAiModel(ctx, store),
)
assert.ok(meta, '应解析出 meta')
assert.equal(meta._model, 'deepseek-v4-flash')
assert.equal(meta._provider, 'deepseek-official')
assert.equal(meta.synonyms[0], 'ahead')
assert.equal(prepareCalls.at(-1).model, 'deepseek-v4-flash', 'prepareCall 收到的应是目录第一个')

// 选了别的模型后立刻生效，不用重启
saveSavedSelection(store, 'deepseek-official', 'deepseek-coder')
await analyzeWord(ctx, 'resolve', 'v. 决心', 'x', await resolveAiModel(ctx, store))
assert.equal(prepareCalls.at(-1).model, 'deepseek-coder')

// ── 6b. 拿不到 llm 服务时必须抛清楚的错，而不是静默返回 null
await assert.rejects(
  () => analyzeWord({ get: () => undefined }, 'resolve', '', '', null),
  (err) =>
    err instanceof AnalysisError && err.code === 'NO_LLM_SERVICE' && /ctx\.llm/.test(err.message),
  '拿不到模型服务时要报 NO_LLM_SERVICE',
)

// ── 6c. 适配器把失败放在 finish 块里时，要翻译成人话
const failingCtx = {
  get: (name) =>
    name === 'llm'
      ? {
          async prepareCall() {
            return {
              config: {},
              async *stream() {
                yield { type: 'text-delta', text: '{"mnemonic":"半' }
                yield {
                  type: 'finish',
                  reason: {
                    kind: 'error',
                    failure: { code: 'AUTH', message: 'invalid api key', status: 401 },
                  },
                }
              },
            }
          },
        }
      : undefined,
}
await assert.rejects(
  () => analyzeWord(failingCtx, 'resolve', '', '', { provider: 'p', model: 'm' }),
  (err) => err.code === 'AUTH' && /认证失败/.test(err.message) && /HTTP 401/.test(err.message),
  'finish 块里的失败要带原因',
)

// ── 6d. 输出不是 JSON 时要报 BAD_JSON，并回显模型吐了什么
const junkCtx = {
  get: (name) =>
    name === 'llm'
      ? {
          async prepareCall() {
            return {
              config: {},
              async *stream() {
                yield { type: 'text-delta', text: '抱歉，我无法分析这个词。' }
              },
            }
          },
        }
      : undefined,
}
await assert.rejects(
  () => analyzeWord(junkCtx, 'resolve', '', '', { provider: 'p', model: 'm' }),
  (err) => err.code === 'BAD_JSON' && /抱歉/.test(err.message),
  '非 JSON 输出要报 BAD_JSON 并回显',
)

// ── 6e. 解析容错：代码块、前后夹着解释文字都能抠出来
assert.equal(parseResponse('```json\n{"mnemonic":"x"}\n```').mnemonic, 'x')
assert.equal(parseResponse('好的，分析如下：{"synonyms":["a"]} 希望有帮助').synonyms[0], 'a')
assert.equal(parseResponse('完全不是 JSON'), null)
assert.equal(parseResponse('{"foo":1}'), null, '没有已知字段的对象不算分析结果')

// ── 6f. 空响应 / 截断会换更大预算重试一次，且只重试一次
const retryTokens = []
const retryCtx = {
  get: (name) =>
    name === 'llm'
      ? {
          async prepareCall(config) {
            retryTokens.push(config.maxTokens)
            const first = retryTokens.length === 1
            return {
              config,
              async *stream() {
                if (first) return // 第一次：一个 token 都不给
                yield { type: 'text-delta', text: '{"mnemonic":"第二次成功"}' }
                yield { type: 'finish', reason: { kind: 'stop' } }
              },
            }
          },
        }
      : undefined,
}
const retried = await analyzeWord(retryCtx, 'resolve', '', '', { provider: 'p', model: 'm' })
assert.equal(retried.mnemonic, '第二次成功', '空响应应重试一次')
assert.equal(retryTokens.length, 2, '应该正好重试一次')
assert.ok(retryTokens[1] > retryTokens[0], '重试要用更大的 maxTokens')

// ── 7. 设置读写
store.setSetting('probe', 'v1')
assert.equal(store.getSetting('probe'), 'v1')
store.setSetting('probe', 'v2')
assert.equal(store.getSetting('probe'), 'v2', '重复写应覆盖')
store.deleteSetting('probe')
assert.equal(store.getSetting('probe'), null)

// 坏 JSON 不炸
store.setSetting('ai_model', '{oops')
assert.equal(resolveAiModel ? true : true, true)
assert.equal((await resolveAiModel(ctx, store)).source, 'default', '坏设置应按没选过处理')

store.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('✓ models.mjs / analyzeWord / settings 全部通过')
console.log('  providers 调用顺序:', providerCallLog.join(' → '))
