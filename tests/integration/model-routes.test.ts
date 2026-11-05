// @vitest-environment node
// 迁移自 scripts/test-model-routes.mjs（179 行）—— /models、/model、/model-info 的 HTTP 层测试。
//
// 用假的 ctx.llm（不碰真模型、不花钱）、临时 DSH_HOME（不碰真生词本），
// 断言「列表—保存—恢复默认—不可用」这条链在真实 handler 里是通的。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRouteHarness } from './support/ctx-stub.js'
import type { RouteHarness } from './support/ctx-stub.js'
import { openTempStore } from './support/db.js'
import type { TempStore } from './support/db.js'

let temp: TempStore
let harness: RouteHarness

const modelsByProvider: Record<string, any[]> = {
  'deepseek-official': [
    { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { provider: 'deepseek-official', id: 'deepseek-v4', name: 'DeepSeek V4' },
  ],
  other: [{ provider: 'other', id: 'other-large', name: 'Other Large' }],
  images: [{ provider: 'images', id: 'img-1', name: 'Image Only', inputModalities: ['image'] }],
}

const fakeLlm = {
  listProviders: () => [
    { id: 'deepseek-official', name: 'DeepSeek 官方' },
    { id: 'other', name: '别家' },
    { id: 'images', name: '图像' },
  ],
  async listModels(provider: string) {
    return modelsByProvider[provider] || []
  },
  async prepareCall() {
    return { config: {}, async *stream() {} }
  },
}

beforeAll(async () => {
  temp = await openTempStore('dwl-int-model-routes-')
  harness = createRouteHarness({
    services: {
      llm: fakeLlm,
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'agent', model: 'agent-model' }),
      },
    },
  })
  const mod = await import('../../../lib/host/index.js')
  ;(mod.default as any).apply(harness.root)
})

afterAll(() => {
  temp.cleanup()
})

describe('模型路由', () => {
  it('GET /models：默认取目录第一个，纯图像模型被排除', async () => {
    const r = await harness.call('/dsh-word-learn/models')
    const json = r.json as any
    expect(r.code).toBe(200)
    expect(json.models.map((m: any) => m.provider + '/' + m.id)).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'deepseek-official/deepseek-v4',
      'other/other-large',
    ])
    expect(json.selection.source).toBe('default')
    expect(json.selection.model).toBe('deepseek-v4-flash')
    expect(json.defaultSelection.model).toBe('deepseek-v4-flash')
    expect(json.lostSelection).toBe(null)
  })

  it('POST /model：自选写入 user.db，再读回来仍是它', async () => {
    let r = await harness.call('/dsh-word-learn/model', {
      method: 'POST',
      body: JSON.stringify({ provider: 'other', model: 'other-large' }),
    })
    expect(r.code).toBe(200)
    expect((r.json as any).selection.source).toBe('custom')
    expect((r.json as any).selection.model).toBe('other-large')

    r = await harness.call('/dsh-word-learn/models')
    expect((r.json as any).selection.source, '刷新后应读回自选模型').toBe('custom')
    expect((r.json as any).selection.providerName).toBe('别家')
  })

  it('POST /model：不存在的模型 / 缺 provider 都被拒', async () => {
    let r = await harness.call('/dsh-word-learn/model', {
      method: 'POST',
      body: JSON.stringify({ provider: 'other', model: 'nope' }),
    })
    expect(r.code).toBe(400)
    expect((r.json as any).error).toMatch(/模型不可用/)

    r = await harness.call('/dsh-word-learn/model', {
      method: 'POST',
      body: JSON.stringify({ model: 'x' }),
    })
    expect(r.code).toBe(400)
  })

  it('POST /model {reset:true}：回到列表第一个', async () => {
    const r = await harness.call('/dsh-word-learn/model', {
      method: 'POST',
      body: JSON.stringify({ reset: true }),
    })
    expect(r.code).toBe(200)
    expect((r.json as any).selection.source).toBe('default')
    expect((r.json as any).selection.model).toBe('deepseek-v4-flash')
  })

  it('GET /model-info：返回 AI 分析实际用的模型 + 来源', async () => {
    const r = await harness.call('/dsh-word-learn/model-info')
    const json = r.json as any
    expect(r.code).toBe(200)
    expect(json.provider).toBe('deepseek-official')
    expect(json.model).toBe('deepseek-v4-flash')
    expect(json.source).toBe('default')
  })

  it('新路由同样受信任栅栏保护（跨站 403）', async () => {
    const r = await harness.call('/dsh-word-learn/model', {
      method: 'POST',
      body: JSON.stringify({ provider: 'other', model: 'other-large' }),
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(r.code).toBe(403)
  })

  it('POST /model：坏 JSON -> 400', async () => {
    const r = await harness.call('/dsh-word-learn/model', { method: 'POST', body: '{oops' })
    expect(r.code).toBe(400)
  })
})
