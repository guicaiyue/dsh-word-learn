// 测什么：lib/models.mjs 的模型目录挑选与回退（目录过滤、默认第一个、自选命中/失效、
// 目录不可用时退回会话默认、设置读写）。
// 为什么放单测：这是纯取舍逻辑，用假 ctx + 假 store 就能把每条分支钉住；
// legacy 的 test-ai-model.mjs 同时验了 analyzeWord，这里只聚焦"选哪个模型"，
// 并用真实 Store 验一次设置确实落盘（临时 DSH_HOME，不碰真实用户库）。

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  clearSavedSelection,
  listTextModels,
  publicSelection,
  readSavedSelection,
  resolveAiModel,
  saveSavedSelection,
  savedSelectionLost,
} from '../../lib/host/models.js'
import { openTempStore, useTempHome } from '../helpers/tmp-home.mjs'

// DSH_HOME 必须在 import store 之前设好；helper 只造目录，store 由 openTempStore 动态 import。
const tmp = useTempHome('dwl-models-unit-')
const store = await openTempStore()
after(() => {
  store.close()
  tmp.cleanup()
})

const ctxWith = (services) => ({ get: (name) => services[name] })

/** 假 llm：顺序固定；broken 抛错；vision 只返回图片模型。 */
function llmFixture(overrides = {}) {
  return {
    listProviders: () => [
      { id: 'ds', name: 'DeepSeek 官方' },
      { id: 'broken', name: '坏适配器' },
      { id: 'vision', name: '只看图' },
    ],
    async listModels(provider) {
      if (provider === 'broken') throw new Error('adapter exploded')
      if (provider === 'vision') {
        return [{ provider, id: 'img-1', name: 'Img', inputModalities: ['image'] }]
      }
      return [
        { provider, id: 'flash', name: 'Flash', description: '快' },
        { provider, id: 'pro', name: 'Pro' },
      ]
    },
    ...overrides,
  }
}

const catalogCtx = ctxWith({ llm: llmFixture() })

/** 内存版 settings，够验读写契约；落盘另有真实 Store 用例。 */
function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getSetting: (key) => (data.has(key) ? data.get(key) : null),
    setSetting: (key, value) => {
      data.set(key, value)
      return true
    },
    deleteSetting: (key) => {
      data.delete(key)
      return true
    },
  }
}

describe('listTextModels', () => {
  test('按注册顺序列文本模型，单个适配器失败不拖垮整张表', async () => {
    const catalog = await listTextModels(catalogCtx)
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      ['flash', 'pro'],
      '纯图片模型应被排除，坏适配器不影响其它 provider',
    )
    assert.equal(catalog.failures.length, 1)
    assert.equal(catalog.failures[0].provider, 'broken')
    assert.equal(catalog.models[0].providerName, 'DeepSeek 官方')
    assert.equal(catalog.models[0].description, '快')
  })

  test('inputModalities：缺省/空数组算文本，显式不含 text 才排除', async () => {
    const llm = llmFixture({
      listProviders: () => [{ id: 'ds', name: 'DeepSeek 官方' }],
      listModels: async (provider) => [
        { provider, id: 'a' },
        { provider, id: 'b', inputModalities: [] },
        { provider, id: 'c', inputModalities: ['text'] },
        { provider, id: 'd', inputModalities: ['image'] },
        { provider, id: 'e', inputModalities: ['image', 'text'] },
      ],
    })
    const catalog = await listTextModels(ctxWith({ llm }))
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      ['a', 'b', 'c', 'e'],
    )
  })

  test('结构不对的模型/适配器条目被跳过，不抛错', async () => {
    const llm = llmFixture({
      listProviders: () => [{ name: '没 id' }, { id: 'ds', name: '' }],
      listModels: async () => [null, { id: '' }, { id: 42 }, { name: '没 id' }, { id: 'ok' }],
    })
    const catalog = await listTextModels(ctxWith({ llm }))
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      ['ok'],
    )
    assert.equal(catalog.models[0].providerName, 'ds', 'provider.name 缺失时回落 provider.id')
  })

  test('listModels 返回非数组按空处理；listProviders 返回非数组也按空处理', async () => {
    const listModelsBroken = llmFixture({ listModels: async () => null })
    const first = await listTextModels(ctxWith({ llm: listModelsBroken }))
    assert.deepEqual(first.models, [])
    assert.deepEqual(first.failures, [], 'listModels 自己没抛错就不算 failure')

    const providersBroken = llmFixture({ listProviders: () => 'nope' })
    const second = await listTextModels(ctxWith({ llm: providersBroken }))
    assert.deepEqual(second.models, [])
  })

  test('listProviders 抛错时报 failure，而不是让整个设置页崩掉', async () => {
    const llm = llmFixture({
      listProviders: () => {
        throw new Error('registry down')
      },
    })
    const catalog = await listTextModels(ctxWith({ llm }))
    assert.deepEqual(catalog.models, [])
    assert.match(catalog.failures[0].error, /registry down/)
  })

  test('拿不到 llm 服务时返回可读 failure（提示 ctx.llm 缺失）', async () => {
    const catalog = await listTextModels(ctxWith({}))
    assert.deepEqual(catalog.models, [])
    assert.match(catalog.failures[0].error, /ctx\.llm/)
  })
})

describe('resolveAiModel', () => {
  test('没选过 → 目录第一个，并带上可展示的 publicSelection', async () => {
    const resolved = await resolveAiModel(catalogCtx, memoryStore())
    assert.equal(resolved.source, 'default')
    assert.equal(resolved.saved, false)
    assert.deepEqual(publicSelection(resolved), {
      provider: 'ds',
      model: 'flash',
      name: 'Flash',
      providerName: 'DeepSeek 官方',
      source: 'default',
    })
  })

  test('自选模型仍在目录里 → 用自选（source=custom）', async () => {
    const storeWithChoice = memoryStore({
      ai_model: JSON.stringify({ provider: 'ds', model: 'pro' }),
    })
    const resolved = await resolveAiModel(catalogCtx, storeWithChoice)
    assert.equal(resolved.source, 'custom')
    assert.equal(resolved.saved, true)
    assert.equal(resolved.model, 'pro')
  })

  test('自选模型从目录消失 → 退回第一个，并能报出丢掉的旧选择', async () => {
    const storeWithGone = memoryStore({
      ai_model: JSON.stringify({ provider: 'ds', model: 'gone' }),
    })
    const resolved = await resolveAiModel(catalogCtx, storeWithGone)
    assert.equal(resolved.source, 'default')
    assert.equal(resolved.model, 'flash')
    assert.deepEqual(savedSelectionLost(storeWithGone, resolved.models), {
      provider: 'ds',
      model: 'gone',
    })
    assert.equal(savedSelectionLost(memoryStore(), []), null, '没选过时不该提示丢失')
  })

  test('目录为空 → 退回会话默认模型（source=agent）', async () => {
    const ctx = ctxWith({
      agentDefaultModel: { currentSelection: () => ({ provider: 'agent-p', model: 'agent-m' }) },
    })
    const resolved = await resolveAiModel(ctx, null)
    assert.equal(resolved.source, 'agent')
    assert.equal(resolved.model, 'agent-m')
    assert.equal(resolved.provider, 'agent-p')
  })

  test('目录为空且会话默认也没有 → source=none，不抛错', async () => {
    assert.equal((await resolveAiModel(ctxWith({}), null)).source, 'none')
    const throwing = ctxWith({
      agentDefaultModel: {
        currentSelection: () => {
          throw new Error('not ready')
        },
      },
    })
    assert.equal((await resolveAiModel(throwing, null)).source, 'none')
  })

  test('传入已拉取的 catalog 时不再调 llm（同一次请求不重复拉目录）', async () => {
    const catalog = {
      models: [{ provider: 'p', providerName: 'P', id: 'm', name: 'M', description: '' }],
      failures: [],
    }
    const explosiveCtx = {
      get() {
        throw new Error('不该再取 llm')
      },
    }
    const resolved = await resolveAiModel(explosiveCtx, null, catalog)
    assert.equal(resolved.source, 'default')
    assert.equal(resolved.model, 'm')
  })

  test('publicSelection 对空结果给稳定形状', () => {
    assert.deepEqual(publicSelection({}), {
      provider: '',
      model: '',
      name: '',
      providerName: '',
      source: 'none',
    })
  })
})

describe('设置读写（假 store）', () => {
  test('readSavedSelection：没选过/坏 JSON/字段缺失都按 null 处理', () => {
    assert.equal(readSavedSelection(null), null)
    assert.equal(readSavedSelection({}), null, 'store 没有 getSetting 时不该炸')
    assert.equal(readSavedSelection(memoryStore()), null)
    assert.equal(readSavedSelection(memoryStore({ ai_model: '{oops' })), null)
    assert.equal(readSavedSelection(memoryStore({ ai_model: '{"provider":"ds"}' })), null)
    assert.equal(readSavedSelection(memoryStore({ ai_model: '{"provider":"","model":""}' })), null)
    assert.deepEqual(
      readSavedSelection(memoryStore({ ai_model: '{"provider":"ds","model":"m"}' })),
      {
        provider: 'ds',
        model: 'm',
      },
    )
  })

  test('saveSavedSelection 写入 JSON；store 不支持时返回 false', () => {
    const storeWithSettings = memoryStore()
    assert.equal(saveSavedSelection(storeWithSettings, 'ds', 'pro'), true)
    assert.equal(storeWithSettings.data.get('ai_model'), '{"provider":"ds","model":"pro"}')
    assert.equal(saveSavedSelection(null, 'ds', 'pro'), false)
    assert.equal(saveSavedSelection({}, 'ds', 'pro'), false)
  })

  test('clearSavedSelection 删除键；store 不支持时返回 false', () => {
    const storeWithChoice = memoryStore({ ai_model: '{"provider":"ds","model":"pro"}' })
    assert.equal(clearSavedSelection(storeWithChoice), true)
    assert.equal(storeWithChoice.data.has('ai_model'), false)
    assert.equal(clearSavedSelection({}), false)
  })
})

describe('设置读写（真实 Store，临时 DSH_HOME）', () => {
  test('自选模型落盘、读回、清空', () => {
    assert.equal(saveSavedSelection(store, 'ds', 'pro'), true)
    assert.deepEqual(readSavedSelection(store), { provider: 'ds', model: 'pro' })
    assert.equal(store.getSetting('ai_model'), '{"provider":"ds","model":"pro"}')
    assert.equal(clearSavedSelection(store), true)
    assert.equal(readSavedSelection(store), null)
  })

  test('库里的坏 JSON 按"没选过"处理，解析结果退回默认', async () => {
    store.setSetting('ai_model', '{oops')
    assert.equal(readSavedSelection(store), null)
    const resolved = await resolveAiModel(catalogCtx, store)
    assert.equal(resolved.source, 'default')
  })

  test('user.db 建在临时 DSH_HOME 下（证明没碰真实用户库）', () => {
    assert.ok(
      fs.existsSync(path.join(tmp.home, 'dsh-word-learn', 'user.db')),
      '临时 DSH_HOME 下应有 user.db',
    )
  })
})
