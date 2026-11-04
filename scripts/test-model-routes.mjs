// 路由级测试：/models、/model、/model-info 在真实 handler 里的行为。
//
// 用假的 ctx.llm（不碰真模型、不花钱），DSH_HOME 指到临时目录（不碰真生词本）。
// 宿主重启前跑它，确认"列表—保存—恢复默认—不可用"这条链在 HTTP 层是通的。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-routes-test-'))
process.env.DSH_HOME = tmp

const routes = {}
const modelsByProvider = {
  'deepseek-official': [
    { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { provider: 'deepseek-official', id: 'deepseek-v4', name: 'DeepSeek V4' },
  ],
  other: [{ provider: 'other', id: 'other-large', name: 'Other Large' }],
  images: [{ provider: 'images', id: 'img-1', name: 'Image Only', inputModalities: ['image'] }],
}

const fakeCtx = {
  get(name) {
    return this[name]
  },
  llm: {
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek 官方' },
      { id: 'other', name: '别家' },
      { id: 'images', name: '图像' },
    ],
    listModels: async (p) => modelsByProvider[p] || [],
    prepareCall: async () => {
      return { config: {}, async *stream() {} }
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'agent', model: 'agent-model' }) },
  webServer: {
    register: (r) => {
      routes[r.path] = r.handler
      return () => {}
    },
    tapIndex: () => () => {},
  },
  effect: () => () => {},
  connection: null,
}

const root = {
  effect: () => () => {},
  on: () => () => {},
  inject: (deps, fn) => fn(fakeCtx),
}

const mod = await import('../lib/index.js')
mod.default.apply(root)

function mkRes() {
  const out = { code: 0, body: '' }
  const res = {
    writeHead: (c) => {
      out.code = c
    },
    end: (b) => {
      if (!out.code) out.code = res.statusCode || 0
      out.body = b || ''
    },
    get result() {
      return out
    },
  }
  Object.defineProperty(res, 'statusCode', {
    get: () => out.code,
    set: (v) => {
      out.code = v
    },
  })
  return res
}

function mkReq(url, method = 'GET', body, headers = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : [])
  stream.url = url
  stream.method = method
  stream.headers = { host: '127.0.0.1:3080', ...headers }
  return stream
}

async function call(p, { method = 'GET', body, headers } = {}) {
  assert.ok(routes[p], `路由不存在: ${p}`)
  const res = mkRes()
  await routes[p](mkReq(p, method, body, headers), res)
  let json
  try {
    json = JSON.parse(res.result.body)
  } catch (err) {
    json = res.result.body
  }
  return { code: res.result.code, json }
}

// ── 1. 目录：文本模型，按注册顺序，首个是默认
let r = await call('/dsh-word-learn/models')
assert.equal(r.code, 200)
assert.deepEqual(
  r.json.models.map((m) => m.provider + '/' + m.id),
  ['deepseek-official/deepseek-v4-flash', 'deepseek-official/deepseek-v4', 'other/other-large'],
)
assert.equal(r.json.selection.source, 'default')
assert.equal(r.json.selection.model, 'deepseek-v4-flash')
assert.equal(r.json.defaultSelection.model, 'deepseek-v4-flash')
assert.equal(r.json.lostSelection, null)
console.log('✓ GET /models：默认取目录第一个，纯图像模型被排除')

// ── 2. 保存自选
r = await call('/dsh-word-learn/model', {
  method: 'POST',
  body: JSON.stringify({ provider: 'other', model: 'other-large' }),
})
assert.equal(r.code, 200)
assert.equal(r.json.selection.source, 'custom')
assert.equal(r.json.selection.model, 'other-large')

r = await call('/dsh-word-learn/models')
assert.equal(r.json.selection.source, 'custom', '刷新后应读回自选模型')
assert.equal(r.json.selection.providerName, '别家')
console.log('✓ POST /model：自选写入 user.db，再读回来仍是它')

// ── 3. 不存在的模型要拒绝（不能把拼错的名字存进去）
r = await call('/dsh-word-learn/model', {
  method: 'POST',
  body: JSON.stringify({ provider: 'other', model: 'nope' }),
})
assert.equal(r.code, 400)
assert.match(r.json.error, /模型不可用/)
r = await call('/dsh-word-learn/model', { method: 'POST', body: JSON.stringify({ model: 'x' }) })
assert.equal(r.code, 400)
console.log('✓ POST /model：不存在的模型 / 缺 provider 都被拒')

// ── 4. 恢复默认
r = await call('/dsh-word-learn/model', { method: 'POST', body: JSON.stringify({ reset: true }) })
assert.equal(r.code, 200)
assert.equal(r.json.selection.source, 'default')
assert.equal(r.json.selection.model, 'deepseek-v4-flash')
console.log('✓ POST /model {reset}：回到列表第一个')

// ── 5. 兼容接口
r = await call('/dsh-word-learn/model-info')
assert.equal(r.code, 200)
assert.equal(r.json.provider, 'deepseek-official')
assert.equal(r.json.model, 'deepseek-v4-flash')
assert.equal(r.json.source, 'default')
console.log('✓ GET /model-info：返回 AI 分析实际用的模型 + 来源')

// ── 6. 信任栅栏仍然管着新路由
r = await call('/dsh-word-learn/model', {
  method: 'POST',
  body: JSON.stringify({ provider: 'other', model: 'other-large' }),
  headers: { 'sec-fetch-site': 'cross-site' },
})
assert.equal(r.code, 403)
console.log('✓ 新路由同样受信任栅栏保护（跨站 403）')

// ── 7. 坏 JSON
r = await call('/dsh-word-learn/model', { method: 'POST', body: '{oops' })
assert.equal(r.code, 400)
console.log('✓ POST /model：坏 JSON -> 400')

// 插件里的 store 是模块级单例，进程退出前不会 close（Windows 上文件被占住），
// 所以清理失败不算测试失败，标记一下就行。
try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch (err) {
  console.log('\n（临时目录被 SQLite 占住，留给系统清理：' + tmp + '）')
}
console.log('\n全部通过')
