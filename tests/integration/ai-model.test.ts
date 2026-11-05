// @vitest-environment node
// 迁移自 scripts/test-ai-model.mjs（276 行）—— AI 分析模型选择 + analyzeWord 集成测试。
//
// 测什么：DSH 模型目录复用、默认第一个、自选落盘、模型消失后回退、目录不可用降级，
// 以及 analyzeWord 的错误翻译（NO_LLM_SERVICE / AUTH / BAD_JSON / 空响应重试）。
//
// 假 ctx 只通过 get(name) 暴露服务 —— 真实 DSH（cordis 4）就是这样，属性访问
// ctx.llm 拿不到东西。早先的假 ctx 把服务也挂在属性上，正好盖住了 ai-enrich
// "只试 ctx[name]" 那个 bug（AI 分析永远失败）—— 所以 ctx-stub 也坚持只走 get。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTempStore } from './support/db.js'
import type { TempStore } from './support/db.js'

type ModelsModule = typeof import('../../../lib/host/models.js')
type AiEnrichModule = typeof import('../../../lib/host/ai-enrich.js')

let temp: TempStore
let store: TempStore['store']
let models: ModelsModule
let aiEnrich: AiEnrichModule

const providerCallLog: string[] = []
const prepareCalls: any[] = []

const services: Record<string, any> = {
  llm: {
    listProviders() {
      return [
        { id: 'deepseek-official', name: 'DeepSeek 官方' },
        { id: 'broken', name: '坏掉的适配器' },
        { id: 'vision-only', name: '只吃图片' },
      ]
    },
    async listModels(provider: string) {
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
    async prepareCall(config: any) {
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
  get(name: string) {
    return services[name]
  },
}

/** 等价于 assert.rejects(fn, predicate, message)：一条断言不拆成三条。 */
async function expectRejects(
  promise: Promise<unknown>,
  predicate: (err: any) => boolean,
  message: string,
): Promise<void> {
  const err = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(err, message + '（实际没有抛错）').toBeTruthy()
  expect(predicate(err), message).toBe(true)
}

beforeAll(async () => {
  temp = await openTempStore('dwl-int-ai-model-')
  store = temp.store
  models = await import('../../../lib/host/models.js')
  aiEnrich = await import('../../../lib/host/ai-enrich.js')
  const opened = temp.store.open()
  expect(opened, '用户库应能打开').toBe(true)
})

afterAll(() => {
  temp.cleanup()
})

describe('listTextModels', () => {
  it('只留文本模型，按注册顺序，单个适配器失败不拖垮整张表', async () => {
    const catalog = await models.listTextModels(ctx as never)
    expect(
      catalog.models.map((m) => m.id),
      '应按注册顺序列出文本模型，且排除纯图像模型',
    ).toEqual(['deepseek-v4-flash', 'deepseek-v4', 'deepseek-coder'])
    expect(catalog.failures.length).toBe(1)
    expect(catalog.failures[0].provider).toBe('broken')
    expect(catalog.models[0].providerName, 'providerName 要能给人看').toBe('DeepSeek 官方')
  })
})

describe('resolveAiModel', () => {
  it('没选过 → 默认第一个', async () => {
    const resolved = await models.resolveAiModel(ctx as never, store as never)
    expect(resolved.source).toBe('default')
    expect(models.publicSelection(resolved)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      providerName: 'DeepSeek 官方',
      source: 'default',
    })
  })

  it('自选后落盘，读回仍是自选', async () => {
    expect(models.saveSavedSelection(store as never, 'deepseek-official', 'deepseek-v4')).toBe(true)
    const resolved = await models.resolveAiModel(ctx as never, store as never)
    expect(resolved.source).toBe('custom')
    expect(resolved.model).toBe('deepseek-v4')
  })

  it('自选模型从目录里消失 → 退回第一个，并报出丢掉的旧选择', async () => {
    const shrunkCtx = {
      get: (name: string) =>
        name === 'llm'
          ? {
              listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
              listModels: async () => [
                {
                  provider: 'deepseek-official',
                  id: 'deepseek-v4-flash',
                  name: 'DeepSeek V4 Flash',
                },
              ],
            }
          : undefined,
    }
    const shrunkCatalog = await models.listTextModels(shrunkCtx as never)
    const resolved = await models.resolveAiModel(shrunkCtx as never, store as never, shrunkCatalog)
    expect(resolved.source, '自选模型消失后应回退默认').toBe('default')
    expect(resolved.model).toBe('deepseek-v4-flash')
    expect(models.savedSelectionLost(store as never, shrunkCatalog.models)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4',
    })
  })

  it('目录整个不可用 → 退回会话默认模型（至少还能分析）', async () => {
    const noLlmCtx = {
      get: (name: string) =>
        name === 'agentDefaultModel' ? services.agentDefaultModel : undefined,
    }
    const resolved = await models.resolveAiModel(noLlmCtx as never, store as never)
    expect(resolved.source).toBe('agent')
    expect(resolved.model).toBe('agent-model')
  })

  it('连会话默认都没有 → none，且不抛错', async () => {
    const resolved = await models.resolveAiModel({ get: () => undefined } as never, store as never)
    expect(resolved.source).toBe('none')
    expect(resolved.model).toBe('')
  })
})

describe('analyzeWord', () => {
  it('用选中的模型，并把 provider/model 记进 meta', async () => {
    models.clearSavedSelection(store as never)
    const meta = await aiEnrich.analyzeWord(
      ctx as never,
      'resolve',
      'v. 决心',
      'to decide firmly',
      await models.resolveAiModel(ctx as never, store as never),
    )
    expect(meta, '应解析出 meta').toBeTruthy()
    expect(meta._model).toBe('deepseek-v4-flash')
    expect(meta._provider).toBe('deepseek-official')
    expect(meta.synonyms[0]).toBe('ahead')
    expect(prepareCalls.at(-1).model, 'prepareCall 收到的应是目录第一个').toBe('deepseek-v4-flash')
  })

  it('选了别的模型后立刻生效，不用重启', async () => {
    models.saveSavedSelection(store as never, 'deepseek-official', 'deepseek-coder')
    await aiEnrich.analyzeWord(
      ctx as never,
      'resolve',
      'v. 决心',
      'x',
      await models.resolveAiModel(ctx as never, store as never),
    )
    expect(prepareCalls.at(-1).model).toBe('deepseek-coder')
  })

  it('拿不到 llm 服务时抛清楚的错，而不是静默返回 null', async () => {
    await expectRejects(
      aiEnrich.analyzeWord({ get: () => undefined } as never, 'resolve', '', '', null),
      (err) =>
        err instanceof aiEnrich.AnalysisError &&
        err.code === 'NO_LLM_SERVICE' &&
        /ctx\.llm/.test(err.message),
      '拿不到模型服务时要报 NO_LLM_SERVICE',
    )
  })

  it('适配器把失败放在 finish 块里时，翻译成人话', async () => {
    const failingCtx = {
      get: (name: string) =>
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
    await expectRejects(
      aiEnrich.analyzeWord(failingCtx as never, 'resolve', '', '', { provider: 'p', model: 'm' }),
      (err) => err.code === 'AUTH' && /认证失败/.test(err.message) && /HTTP 401/.test(err.message),
      'finish 块里的失败要带原因',
    )
  })

  it('输出不是 JSON 时报 BAD_JSON，并回显模型吐了什么', async () => {
    const junkCtx = {
      get: (name: string) =>
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
    await expectRejects(
      aiEnrich.analyzeWord(junkCtx as never, 'resolve', '', '', { provider: 'p', model: 'm' }),
      (err) => err.code === 'BAD_JSON' && /抱歉/.test(err.message),
      '非 JSON 输出要报 BAD_JSON 并回显',
    )
  })

  it('解析容错：代码块、前后夹着解释文字都能抠出来', () => {
    expect(aiEnrich.parseResponse('```json\n{"mnemonic":"x"}\n```').mnemonic).toBe('x')
    expect(
      aiEnrich.parseResponse('好的，分析如下：{"synonyms":["a"]} 希望有帮助').synonyms[0],
    ).toBe('a')
    expect(aiEnrich.parseResponse('完全不是 JSON')).toBe(null)
    expect(aiEnrich.parseResponse('{"foo":1}'), '没有已知字段的对象不算分析结果').toBe(null)
  })

  it('空响应 / 截断会换更大预算重试一次，且只重试一次', async () => {
    const retryTokens: number[] = []
    const retryCtx = {
      get: (name: string) =>
        name === 'llm'
          ? {
              async prepareCall(config: any) {
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
    const retried = await aiEnrich.analyzeWord(retryCtx as never, 'resolve', '', '', {
      provider: 'p',
      model: 'm',
    })
    expect(retried.mnemonic, '空响应应重试一次').toBe('第二次成功')
    expect(retryTokens.length, '应该正好重试一次').toBe(2)
    expect(retryTokens[1] > retryTokens[0], '重试要用更大的 maxTokens').toBe(true)
  })
})

describe('设置读写', () => {
  it('setSetting / getSetting / deleteSetting', () => {
    store.setSetting('probe', 'v1')
    expect(store.getSetting('probe')).toBe('v1')
    store.setSetting('probe', 'v2')
    expect(store.getSetting('probe'), '重复写应覆盖').toBe('v2')
    store.deleteSetting('probe')
    expect(store.getSetting('probe')).toBe(null)
  })

  it('坏 JSON 设置不炸，按没选过处理', async () => {
    store.setSetting('ai_model', '{oops')
    // 原脚本这里是恒真断言（resolveAiModel ? true : true），等价改写成「导出可用」。
    expect(typeof models.resolveAiModel).toBe('function')
    expect(
      (await models.resolveAiModel(ctx as never, store as never)).source,
      '坏设置应按没选过处理',
    ).toBe('default')
  })
})
