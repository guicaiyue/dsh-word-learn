// @vitest-environment node
// 迁移自 scripts/test-routes.mjs（713 行）—— 22 条 HTTP 路由的集成测试。
//
// 旧脚本前半段是"打印着看一眼"的 smoke（console.log 里带 ✓/✗），后半段
// task-6 才用 check/checkEq 真断言。迁移时把两边都变成断言：
//   - 打印段每一条能表达期望的检查，都落成具体的 expect（查词/生词本/看板/
//     队列/评分/补记/翻译）；
//   - task-6 段逐条搬运：body 非法 → 400、非 GET/POST → 405、/list 参数夹取、
//     方法白名单、500 不含绝对路径、库打不开 → DB_UNAVAILABLE、评分记债失败仍 200。
//
// 与旧脚本的差异（都是"不联网 / 不碰真库"约束导致的）：
//   - 查词一律带 enrich=false（enrich 会拉外部例句/发音）；
//   - 翻译走 stub 掉的 globalThis.fetch（MyMemory 后端），不真发网络请求；
//   - DSH_HOME 指到临时目录（support/tmp-home.ts），全程不碰 ~/.dsh。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRouteHarness } from './support/ctx-stub.js'
import type { CallResult, RouteHarness } from './support/ctx-stub.js'
import { openTempStore } from './support/db.js'
import type { TempStore } from './support/db.js'

// 路由路径（与旧脚本里的硬编码一致；paths.mjs 才是源头，这里刻意保持独立，
// 这样路径被误改时测试会红，而不是跟着一起变）。
const P = {
  lookup: '/dsh-word-learn/lookup',
  translate: '/dsh-word-learn/translate',
  save: '/dsh-word-learn/save',
  list: '/dsh-word-learn/list',
  update: '/dsh-word-learn/update',
  remove: '/dsh-word-learn/remove',
  word: '/dsh-word-learn/word',
  dashboard: '/dsh-word-learn/dashboard',
  queue: '/dsh-word-learn/queue',
  grade: '/dsh-word-learn/grade',
  repair: '/dsh-word-learn/repair',
  repairLog: '/dsh-word-learn/repair/log',
  repairClear: '/dsh-word-learn/repair/clear',
  repairStats: '/dsh-word-learn/repair/stats',
  recap: '/dsh-word-learn/repair/recap',
  senseMap: '/dsh-word-learn/sense-map',
  annotateWords: '/dsh-word-learn/annotate/words',
  models: '/dsh-word-learn/models',
} as const

const WRITE_ROUTES = [
  P.save,
  P.update,
  P.remove,
  P.grade,
  '/dsh-word-learn/enrich-ai',
  P.repairLog,
  P.repairClear,
  '/dsh-word-learn/model',
]
const READ_ONLY_ROUTES = [P.list, P.queue, P.dashboard, P.repairStats, P.models]

let temp: TempStore
let harness: RouteHarness
// Store 类的引用：500/DB_UNAVAILABLE 用例要临时替换原型方法。
let Store: any

function eq(actual: unknown, expected: unknown, message?: string): void {
  expect(actual, message).toBe(expected)
}
function ok(cond: unknown, message?: string): void {
  expect(cond, message).toBe(true)
}
function match(value: unknown, re: RegExp, message?: string): void {
  expect(String(value ?? ''), message).toMatch(re)
}
function json(r: CallResult): any {
  return r.json
}
function bodyText(r: CallResult): string {
  return r.raw ? r.raw.toString('utf8') : JSON.stringify(r.json ?? '')
}
/** 500 / 库不可用的响应体里不能出现绝对路径或探针字符串。 */
function checkNoPath(r: CallResult): void {
  const raw = bodyText(r)
  ok(!raw.includes('C:'), '响应不能带盘符路径：' + raw)
  ok(!raw.includes('dsh-word-learn'), '响应不能带项目目录：' + raw)
  ok(!raw.includes('user.db'), '响应不能带库文件名：' + raw)
  ok(!raw.includes('boom'), '响应不能带原始异常消息：' + raw)
}
async function getQueue(limit = 200): Promise<any[]> {
  const r = await harness.call(P.queue, { url: `${P.queue}?limit=${limit}` })
  eq(r.code, 200, 'GET /queue 应该 200')
  return json(r).items as any[]
}
async function lookupSaved(word: string) {
  return harness.call(P.lookup, { url: `${P.lookup}?word=${word}&enrich=false` })
}

beforeAll(async () => {
  temp = await openTempStore('dwl-int-routes-')
  harness = createRouteHarness()
  const mod = await import('../../../lib/host/index.js')
  ;(mod.default as any).apply(harness.root)
  Store = (await import('../../../lib/host/store.js')).Store
})

afterAll(() => {
  temp.cleanup()
})

describe('查词与生词本', () => {
  it('GET /lookup：命中词典、默认入生词本', async () => {
    const r = await lookupSaved('throughput')
    const j = json(r)
    eq(r.code, 200)
    eq(j.ok, true, '/lookup 应成功')
    eq(j.dict.word, 'throughput')
    // 哨兵：词典库必须真的能被打开、查到释义。`lib/dict.mjs → src/host/dict.ts`
    // 那次迁移把 HERE 下移一层，data/ecdict.db 找错目录，所有词都 404 —— 而 legacy
    // 脚本只打印不红。这一行就是防止「路由形状全绿、词典其实没打开」再发生。
    ok(Array.isArray(j.dict.senses), 'senses 应该是数组')
    ok(j.dict.senses.length > 0, '词典必须真的打开：throughput 应该查到释义（库路径哨兵）')
    ok(typeof j.dict.frequency.label === 'string', 'frequency.label 应该给人看')
    ok(j.saved && typeof j.saved.id === 'number', '默认应该入生词本并返回 id')
    ok(j.saved.id > 0)
  })

  it('GET /lookup：children 归到原形 child', async () => {
    const r = await lookupSaved('children')
    const j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    eq(j.dict.word, 'child', 'children 应归到原形 child')
  })

  it('GET /lookup：查不到的词 → 404 且 ok:false', async () => {
    const r = await lookupSaved('zzzznotaword')
    eq(r.code, 404)
    eq(json(r).ok, false)
    ok(typeof json(r).error === 'string' && json(r).error.length > 0, '404 应带说明')
  })

  it('POST /save：拆词返回 kind/best/words，过滤掉代码路径', async () => {
    const r = await harness.call(P.save, {
      method: 'POST',
      body: JSON.stringify({ text: 'Edit src/lib/index.js to improve the throughput.' }),
    })
    const j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    ok(typeof j.kind === 'string' && j.kind.length > 0, 'kind 应该是非空字符串')
    ok(typeof j.best === 'string' && j.best.length > 0, 'best 应该是候选里最好的词')
    ok(Array.isArray(j.words) && j.words.length > 0, '应该拆出候选词')
    for (const item of j.words) {
      ok(
        typeof item.word === 'string' && /^[a-z-]+$/i.test(item.word),
        '候选词应该只是单词：' + item.word,
      )
    }
    ok(
      j.words.some((item: any) => item.word === 'throughput'),
      '句子里的 throughput 应该在候选里',
    )
  })

  it('GET /list：分页字段齐全', async () => {
    const r = await harness.call(P.list)
    const j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    ok(Array.isArray(j.items), 'items 应该是数组')
    ok(typeof j.total === 'number', 'total 应该是数字')
  })

  it('POST /update + GET /list?starred=1：收藏能写能筛', async () => {
    let r = await harness.call(P.update, {
      method: 'POST',
      body: JSON.stringify({ word: 'throughput', patch: { starred: true } }),
    })
    eq(r.code, 200)
    eq(json(r).ok, true)

    r = await harness.call(P.list, { url: `${P.list}?starred=1` })
    const j = json(r)
    eq(r.code, 200)
    eq(j.total, 1, '只收藏了一个词')
    ok(
      j.items.every((item: any) => item.starred),
      'starred=1 只返回收藏词',
    )
  })

  it('POST /remove：删掉后列表里不再有它', async () => {
    const r = await harness.call(P.remove, {
      method: 'POST',
      body: JSON.stringify({ word: 'throughput' }),
    })
    eq(r.code, 200)
    eq(json(r).ok, true)

    const list = json(await harness.call(P.list))
    ok(
      list.items.every((item: any) => item.word !== 'throughput'),
      '删掉后列表里不能再出现 throughput',
    )
  })

  it('信任栅栏：跨站 / 跨源一律 403', async () => {
    let r = await harness.call(P.list, { headers: { 'sec-fetch-site': 'cross-site' } })
    eq(r.code, 403, 'sec-fetch-site: cross-site 必须 403')
    r = await harness.call(P.list, { headers: { origin: 'https://evil.example' } })
    eq(r.code, 403, '跨源 Origin 必须 403')
  })

  it('旧静态资源路由与 /tts、/stats 全部注销', async () => {
    for (const name of [
      'core.js',
      'voice.js',
      'wordcard.js',
      'wordcard-style.js',
      'wordcard-card.js',
      'annotate.js',
      'client.js',
    ]) {
      ok(!harness.routes.has('/dsh-word-learn/' + name), '静态路由应已注销：' + name)
    }
    ok(!harness.routes.has('/dsh-word-learn/tts'), '旧 /tts 路由应已注销')
    ok(!harness.routes.has('/dsh-word-learn/tts-prepare'), '旧 /tts-prepare 路由应已注销')
    ok(!harness.routes.has('/dsh-word-learn/stats'), '/stats 路由应已删除')
  })

  it('GET /word：已删除的词 404，队列里的词能查到两条线的卡片', async () => {
    let r = await harness.call(P.word, { url: `${P.word}?word=throughput` })
    eq(r.code, 404, '删掉的词应该 404')
    eq(json(r).ok, false)

    const items = await getQueue()
    ok(items.length > 0, '队列里应该有词')
    const word = items[0].word
    r = await harness.call(P.word, { url: `${P.word}?word=${encodeURIComponent(word)}` })
    const j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    ok(j.entry && typeof j.entry.word === 'string', 'entry 应该带词条')
    ok(Array.isArray(j.cards) && j.cards.length > 0, 'cards 应该有内容')
    for (const card of j.cards) ok(typeof card.trackLabel === 'string', '卡片应带 trackLabel')
  })
})

describe('学习视图：看板 / 队列 / 评分 / 补记', () => {
  it('GET /dashboard：聚合字段齐全', async () => {
    const r = await harness.call(P.dashboard)
    const j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    ok(j.words && typeof j.words.total === 'number', 'words.total 应该是数字')
    ok(j.cards && typeof j.cards.total === 'number', 'cards.total 应该是数字')
    ok(Array.isArray(j.forecast), 'forecast 应该是数组')
    ok(j.queue && typeof j.queue.dueToday === 'number', 'queue.dueToday 应该是数字')
    ok(j.schedule && typeof j.schedule.ok === 'boolean', '排期状态应该挂在 schedule 上')
  })

  it('GET /dashboard?days=99999：days 被夹到上限 60 天', async () => {
    const r = await harness.call(P.dashboard, { url: `${P.dashboard}?days=99999` })
    eq(r.code, 200)
    const forecast = json(r).forecast
    ok(Array.isArray(forecast), 'forecast 应该是数组')
    ok(forecast.length <= 60, 'days 应被夹到 60，实际 ' + forecast.length)
  })

  it('GET /queue：items 与 newCount/reviewCount 自洽', async () => {
    const r = await harness.call(P.queue)
    const j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    ok(Array.isArray(j.items), 'items 应该是数组')
    eq(j.total, j.items.length, 'total 应该等于 items.length')
    eq(j.newCount + j.reviewCount, j.total, 'newCount + reviewCount 应该等于 total')
    if (j.items.length > 0) {
      const item = j.items[0]
      ok(item.cardId > 0, 'queue item 应带 cardId')
      eq(typeof item.word, 'string')
      eq(typeof item.trackLabel, 'string')
      eq(typeof item.isNew, 'boolean')
    }
  })

  it('POST /grade：评分写回卡片（reps/due/stability）', async () => {
    const item = (await getQueue())[0]
    ok(!!item, '评分前队列不能为空')
    const before = json(
      await harness.call(P.word, { url: `${P.word}?word=${encodeURIComponent(item.word)}` }),
    )
    const cardBefore = before.cards.find((c: any) => c.id === item.cardId)
    ok(!!cardBefore, '应该能读到评分前的卡片状态')

    const r = await harness.call(P.grade, {
      method: 'POST',
      body: JSON.stringify({ cardId: item.cardId, rating: 3 }),
    })
    eq(r.code, 200)
    eq(json(r).ok, true)

    const after = json(
      await harness.call(P.word, { url: `${P.word}?word=${encodeURIComponent(item.word)}` }),
    )
    const cardAfter = after.cards.find((c: any) => c.id === item.cardId)
    eq(cardAfter.reps, cardBefore.reps + 1, '评分后 reps 应该 +1')
    ok(cardAfter.due !== cardBefore.due, '评分后 due 应该变化')
    eq(typeof cardAfter.stability, 'number', '评分后 stability 应该是数字')
  })

  it('补记链路：忘了 → 开债 → 记日志 → 统计 → 清债', async () => {
    let queue = await getQueue()
    if (queue.length === 0) {
      // 本地词典造一个新词进队列（enrich=false 不联网）
      const added = await lookupSaved('daemon')
      eq(added.code, 200)
      queue = await getQueue()
    }
    const target = queue[0]
    ok(!!target, '补记链路需要一个队列里的卡片')

    let r = await harness.call(P.grade, {
      method: 'POST',
      body: JSON.stringify({ cardId: target.cardId, rating: 1 }),
    })
    eq(r.code, 200)
    eq(json(r).ok, true)

    r = await harness.call(P.repair, { url: `${P.repair}?cardId=${target.cardId}` })
    let j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    eq(j.cardId, target.cardId)
    eq(typeof j.word, 'string')
    ok(j.sentence === null || typeof j.sentence === 'string', 'sentence 应该是字符串或 null')
    ok(j.debt && j.debt.cleared_at == null, '评「忘了」应该开一笔未清的债')

    r = await harness.call(P.repairLog, {
      method: 'POST',
      body: JSON.stringify({
        cardId: target.cardId,
        stage: 'pick',
        ok: true,
        guess: 'same',
        elapsedMs: 12,
      }),
    })
    eq(r.code, 200)
    eq(json(r).ok, true)

    r = await harness.call(P.repairStats)
    j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    ok(Array.isArray(j.stages), 'stages 应该是数组')
    ok(j.debt && typeof j.debt.opened === 'number', 'debt.opened 应该是数字')
    const pick = j.stages.find((s: any) => s.stage === 'pick')
    ok(pick && pick.n >= 1, '刚记了一条 pick 日志，统计里应该有')

    r = await harness.call(P.repairClear, {
      method: 'POST',
      body: JSON.stringify({ cardId: target.cardId }),
    })
    eq(r.code, 200)
    eq(json(r).ok, true)

    r = await harness.call(P.repair, { url: `${P.repair}?cardId=${target.cardId}` })
    ok(json(r).debt && json(r).debt.cleared_at != null, '清债后 cleared_at 应该非空')
  })

  it('GET/POST /recap：取题 200，交卷缺 wordId → 400', async () => {
    let r = await harness.call(P.recap)
    const j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    ok(Array.isArray(j.trials), 'GET /recap 的 trials 应该是数组')

    r = await harness.call(P.recap, { method: 'POST', body: JSON.stringify({}) })
    eq(r.code, 400)
    match(json(r).error, /wordId/)
  })

  it('GET /sense-map：有词返回数组，空词 400', async () => {
    let r = await harness.call(P.senseMap, { url: `${P.senseMap}?word=daemon` })
    eq(r.code, 200)
    eq(json(r).ok, true)
    eq(json(r).word, 'daemon')
    ok(Array.isArray(json(r).senses), 'senses 应该是数组')

    r = await harness.call(P.senseMap, { url: `${P.senseMap}?word=` })
    eq(r.code, 400)
    match(json(r).error, /词不合法/)
  })

  it('GET /annotate/words：目标词表带 rev 与词条形状', async () => {
    const r = await harness.call(P.annotateWords)
    const j = json(r)
    eq(r.code, 200)
    eq(j.ok, true)
    ok(Array.isArray(j.words), 'words 应该是数组')
    eq(typeof j.rev, 'string', 'rev 应该是字符串')
    ok(typeof j.total === 'number' && typeof j.truncated === 'boolean', 'total/truncated 字段齐全')
    if (j.words.length > 0) {
      const w = j.words[0]
      eq(typeof w.w, 'string')
      eq(typeof w.t, 'string')
      eq(typeof w.s, 'string')
      eq(typeof w.c, 'number')
    }
  })

  it('POST /grade：不存在的卡 404、非法 rating 400', async () => {
    let r = await harness.call(P.grade, {
      method: 'POST',
      body: JSON.stringify({ cardId: 999999, rating: 3 }),
    })
    eq(r.code, 404)
    eq(json(r).ok, false)

    const item = (await getQueue())[0]
    const cardId = item ? item.cardId : 1
    r = await harness.call(P.grade, {
      method: 'POST',
      body: JSON.stringify({ cardId, rating: 99 }),
    })
    eq(r.code, 400)
    match(json(r).error, /rating/)
  })
})

describe('翻译（stub 掉 fetch，不联网）', () => {
  let realFetch: typeof globalThis.fetch | undefined

  function stubFetch(): void {
    realFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      async json() {
        return { responseData: { translatedText: '潜空间捕捉语义结构' } }
      },
    })) as any
  }

  it('空文本 / 坏 JSON → 400', async () => {
    let r = await harness.call(P.translate, {
      method: 'POST',
      body: JSON.stringify({ text: '   ' }),
    })
    eq(r.code, 400)
    match(json(r).error, /没有要翻译/)

    r = await harness.call(P.translate, { method: 'POST', body: '{oops' })
    eq(r.code, 400)
  })

  it('整句划词：译文 + 拆词 都要有', async () => {
    stubFetch()
    try {
      const sentence = 'The latent space captures semantic structure.'
      const save = await harness.call(P.save, {
        method: 'POST',
        body: JSON.stringify({ text: sentence }),
      })
      eq(save.code, 200)
      ok((json(save).words || []).length > 0, '拆词应该给出候选')

      const r = await harness.call(P.translate, {
        method: 'POST',
        body: JSON.stringify({ text: sentence }),
      })
      const j = json(r)
      eq(r.code, 200, '翻译失败也应 200（前端画失败一行）')
      eq(j.ok, true, 'stub 后翻译应成功')
      eq(j.text, '潜空间捕捉语义结构')
      eq(typeof j.source, 'string', 'source 应说明用了哪个后端')
      ok(j.status && typeof j.status === 'object', 'status 应带后端状态')
    } finally {
      globalThis.fetch = realFetch as any
    }
  })
})

describe('task-6：路由健壮性', () => {
  it('POST body 非法（null / 数组 / 标量 / 空）→ 400 且有说明', async () => {
    for (const body of ['null', '[]', '"x"', '']) {
      const r = await harness.call(P.update, { method: 'POST', body })
      eq(r.code, 400, 'body=' + body + ' 应该 400')
      eq(typeof json(r).error, 'string', 'body=' + body + ' 应带 error 说明')
    }
  })

  it('非 GET/POST → 405，带稳定 code 且只发一次', async () => {
    let r = await harness.call(P.recap, { method: 'PUT' })
    eq(r.code, 405)
    eq(json(r).code, 'METHOD_NOT_ALLOWED')
    eq(r.ends, 1)

    r = await harness.call(P.lookup, { method: 'DELETE', url: `${P.lookup}?word=daemon` })
    eq(r.code, 405)
    eq(r.ends, 1)
  })

  it('GET /list 参数夹取：负 limit 夹到 1、负 offset 夹到 0', async () => {
    const r = await harness.call(P.list, { url: `${P.list}?limit=-1&offset=-5` })
    const j = json(r)
    eq(r.code, 200)
    ok(Array.isArray(j.items) && j.items.length <= 1, 'limit=-1 应夹到 1，实际 ' + j.items?.length)
    eq(typeof j.total, 'number')
  })

  it('方法白名单：每条路由都拒 DELETE，写路由拒 GET、只读路由拒 POST', async () => {
    eq(harness.routeDefs.length, harness.routes.size, '注册的路由条数应与路由表一致')

    for (const def of harness.routeDefs) {
      const r = await harness.call(def.path, {
        method: 'DELETE',
        url: `${def.path}?word=daemon&cardId=1`,
      })
      eq(r.code, 405, 'DELETE ' + def.path + ' 应 405')
      match(String(r.headers.Allow || ''), /GET|POST/, def.path + ' 405 应带 Allow 头')
      eq(r.ends, 1, def.path + ' 405 只发一次')
    }

    for (const path of WRITE_ROUTES) {
      let r = await harness.call(path, { method: 'GET' })
      eq(r.code, 405, path + ' 用 GET 打应 405')
      eq(json(r).code, 'METHOD_NOT_ALLOWED')
      match(String(r.headers.Allow || ''), /POST/, path + ' 应声明 Allow: POST')

      r = await harness.call(path, { method: 'POST', body: JSON.stringify({}) })
      ok(r.code !== 405, path + ' 用 POST 打不能被 405 拦')
    }

    for (const path of READ_ONLY_ROUTES) {
      let r = await harness.call(path, { method: 'POST', body: JSON.stringify({}) })
      eq(r.code, 405, path + ' 用 POST 打应 405')

      r = await harness.call(path, { method: 'GET' })
      ok(r.code !== 405, path + ' 用 GET 打不能被 405 拦')
    }
  })

  it('500 响应不含绝对路径，且只发一次、没有二次写头', async () => {
    const realList = Store.prototype.list
    Store.prototype.list = function () {
      throw new Error('boom ' + ['C:', 'tmp', 'dsh-word-learn', 'user.db'].join('/'))
    }
    try {
      const r = await harness.call(P.list)
      eq(r.code, 500)
      eq(json(r).code, 'INTERNAL_ERROR')
      checkNoPath(r)
      eq(r.ends, 1)
      eq(r.doubleSend, false, '不能二次写头')
    } finally {
      Store.prototype.list = realList
    }
  })

  it('库打不开 → 500 + DB_UNAVAILABLE，不泄露路径', async () => {
    const realOpen = Store.prototype.open
    Store.prototype.open = () => false
    try {
      const r = await harness.call(P.queue)
      eq(r.code, 500)
      eq(json(r).code, 'DB_UNAVAILABLE')
      checkNoPath(r)
      eq(r.ends, 1)
    } finally {
      Store.prototype.open = realOpen
    }
  })

  it('评分已写库：收尾记债抛错也必须回 200', async () => {
    const item = (await getQueue())[0]
    ok(!!item, '需要一个队列里的卡片')
    const realOpenDebt = Store.prototype.openRepairDebt
    Store.prototype.openRepairDebt = function () {
      throw new Error('debt bookkeeping failed ' + ['C:', 'tmp', 'user.db'].join('/'))
    }
    try {
      const r = await harness.call(P.grade, {
        method: 'POST',
        body: JSON.stringify({ cardId: item.cardId, rating: 1 }),
      })
      eq(r.code, 200, '记债抛错仍应 200（客户端不能重试）')
      eq(json(r).ok, true)
      eq(r.ends, 1)
      checkNoPath(r)
    } finally {
      Store.prototype.openRepairDebt = realOpenDebt
    }
  })
})
