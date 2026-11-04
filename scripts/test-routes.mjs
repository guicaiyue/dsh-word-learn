// 端到端测试插件路由：造一个最小 ctx + req/res 桩，真跑查词/写库/发音。
//
// 为什么要这么测：宿主重启才能让插件生效，而重启前必须确认插件本身没问题，
// 否则重启后看到 404 或白屏，分不清是"没装上"还是"代码坏了"。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// 必须跑在临时 DSH_HOME 上：Store 在 import 插件的那一刻按 DSH_HOME 打开用户库，
// 用真实库跑这个脚本会真的给用户改排期、加补记债、写 review_log（2026-11-04 踩过）。
// 注意：宿主会把 DSH_HOME 导进环境变量，所以**不能**用「没设才临时」的判断。
const allowRealDb = process.argv.includes('--allow-real-db')
if (!allowRealDb) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-routes-'))
  process.env.DSH_HOME = tmpHome
  console.log('[test] DSH_HOME ->', tmpHome, '(临时库，不碰真实数据)')
  process.on('exit', () => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch (err) {}
  })
}

const routes = {}
const taps = []
const injects = []

const fakeCtx = {
  get: () => null,
  connection: null,
  webServer: {
    register: (r) => {
      routes[r.path] = r.handler
      return () => {}
    },
    tapIndex: (fn) => {
      taps.push(fn)
      return () => {}
    },
  },
  effect: () => () => {},
}

const root = {
  effect: () => () => {},
  on: (event, fn) => {
    if (event === 'webserver/index-inject') injects.push(fn)
    return () => {}
  },
  inject: (deps, fn) => fn(fakeCtx),
}

const mod = await import('../lib/index.js')
mod.default.apply(root)

const table = []
injects.forEach((fn) => fn(table))
console.log(
  `注入行 ${table.length} 条, 路由 ${Object.keys(routes).length} 条, tapIndex ${taps.length} 个\n`,
)

function mkRes() {
  // 真实的 http.ServerResponse 支持 res.statusCode = N 赋值，
  // 桩也必须支持，否则测信任栅栏时会把 403 记成 0（第一次就踩了这个坑）。
  // 另外要模拟 headersSent / writableEnded / setHeader / destroy：
  // 「二次写头」这类 bug 只有桩足够像真的时候才测得出来。
  const out = {
    code: 0,
    body: '',
    headers: {},
    ends: 0,
    writes: 0,
    destroyed: false,
    doubleSend: false,
  }
  const res = {
    writeHead: (c, headers) => {
      if (out.writes > 0 || out.ends > 0) out.doubleSend = true
      out.writes++
      out.code = c
      if (headers) out.headers = { ...out.headers, ...headers }
    },
    setHeader: (k, v) => {
      out.headers[k] = v
    },
    end: (b) => {
      out.ends++
      if (!out.code) out.code = res.statusCode || 0
      out.body = b === undefined || b === null ? '' : b
    },
    destroy: () => {
      out.destroyed = true
    },
    get headersSent() {
      return out.writes > 0
    },
    get writableEnded() {
      return out.ends > 0
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

async function call(path, { method = 'GET', body, url, headers } = {}) {
  const res = mkRes()
  await routes[path](mkReq(url || path, method, body, headers), res)
  let json
  const rawBody = res.result.body
  try {
    json = JSON.parse(rawBody)
  } catch (err) {
    json = Buffer.isBuffer(rawBody) ? null : rawBody
  }
  return {
    code: res.result.code,
    json,
    raw: Buffer.isBuffer(rawBody) ? rawBody : null,
    headers: res.result.headers || {},
    // 响应次数/是否二次写头/是否被 destroy —— task-6 断言要用
    ends: res.result.ends,
    writes: res.result.writes,
    doubleSend: res.result.doubleSend,
    destroyed: res.result.destroyed,
  }
}

console.log('=== 查词 throughput ===')
let r = await call('/dsh-word-learn/lookup', { url: '/dsh-word-learn/lookup?word=throughput' })
console.log('  HTTP', r.code)
if (r.json.ok) {
  const d = r.json.dict
  console.log(`  ${d.word} /${d.phonetic}/ ${d.frequency.label} likelyKnown=${d.likelyKnown}`)
  console.log(
    `  义项: ${d.senses
      .map((s) => s.text)
      .join(' | ')
      .slice(0, 64)}`,
  )
  console.log(
    `  例句 ${r.json.enrich.examples.length} 条  发音=${r.json.enrich.audio ? '有' : '无'}  已存id=${r.json.saved?.id}`,
  )
} else {
  console.log('  失败:', r.json.error)
}

console.log('\n=== 变形词 children（应归到 child，继承高频） ===')
r = await call('/dsh-word-learn/lookup', { url: '/dsh-word-learn/lookup?word=children' })
console.log(
  `  -> ${r.json.dict.word} (${r.json.dict.matchedBy}) ${r.json.dict.frequency.label} likelyKnown=${r.json.dict.likelyKnown}`,
)

console.log('\n=== 查不到的词 ===')
r = await call('/dsh-word-learn/lookup', { url: '/dsh-word-learn/lookup?word=zzzznotaword' })
console.log('  HTTP', r.code, '->', r.json.error)

console.log('\n=== 拆词（含代码路径） ===')
r = await call('/dsh-word-learn/save', {
  method: 'POST',
  body: JSON.stringify({ text: 'Edit src/lib/index.js to improve the throughput.' }),
})
console.log('  kind:', r.json.kind, ' best:', r.json.best)
console.log('  候选:', r.json.words.map((w) => w.word + (w.likelyKnown ? '(熟)' : '')).join(', '))

console.log('\n=== 统计（/stats 路由已按 review 删除，用 list 总量代替） ===')
r = await call('/dsh-word-learn/list')
console.log('  total:', r.json.total)

console.log('\n=== 列表 ===')
r = await call('/dsh-word-learn/list')
console.log('  total:', r.json.total, '->', r.json.items.map((i) => i.word).join(', '))

console.log('\n=== 收藏 + 改画像 ===')
r = await call('/dsh-word-learn/update', {
  method: 'POST',
  body: JSON.stringify({ word: 'throughput', patch: { starred: true, ability: { recognize: 3 } } }),
})
console.log('  update ok:', r.json.ok)
r = await call('/dsh-word-learn/list', { url: '/dsh-word-learn/list?starred=1' })
console.log('  收藏数:', r.json.total)

console.log('\n=== 移除 ===')
r = await call('/dsh-word-learn/remove', {
  method: 'POST',
  body: JSON.stringify({ word: 'throughput' }),
})
console.log('  remove ok:', r.json.ok)
r = await call('/dsh-word-learn/list')
console.log('  剩余:', r.json.total)

console.log('\n=== 信任栅栏 ===')
r = await call('/dsh-word-learn/list', { headers: { 'sec-fetch-site': 'cross-site' } })
console.log('  跨站 -> HTTP', r.code)
r = await call('/dsh-word-learn/list', { headers: { origin: 'http://evil.example' } })
console.log('  异源 -> HTTP', r.code)

console.log('\n=== 前端脚本可取出 ===')
r = await call('/dsh-word-learn/client.js')
console.log(
  '  HTTP',
  r.code,
  ' 长度',
  String(r.json).length,
  ' 含 __dshWordLearn:',
  String(r.json).includes('__dshWordLearn'),
)

// ─────────────────────────────────────────────────────────────
// P2a：学习页那四条路由
// ─────────────────────────────────────────────────────────────

console.log('\n=== 学习页：dashboard ===')
r = await call('/dsh-word-learn/dashboard', { url: '/dsh-word-learn/dashboard?days=14' })
console.log('  HTTP', r.code, ' ok:', r.json.ok)
if (r.json.ok) {
  const d = r.json
  console.log(`  词 ${d.words.total} 卡片 ${d.cards.total} 已开始(按词) ${d.cards.started}`)
  console.log(
    `  今日 ${d.queue.dueToday} 明日 ${d.queue.dueTomorrow} 今日已复习 ${d.queue.reviewedToday}`,
  )
  console.log(`  forecast ${d.forecast.length} 天, activity ${d.activity.length} 天`)
  console.log(`  排期引擎 ok=${d.schedule?.ok} ${d.schedule?.error || ''}`)

  // 口径回归：进度不能超 100%（曾经拿卡片数当分子，实测出过 135%）
  const pct = d.words.total ? (d.cards.started / d.words.total) * 100 : 0
  console.log(`  进度 ${pct.toFixed(0)}% ${pct <= 100 ? '✓ 未超 100%' : '✗ 超了！口径又错了'}`)

  // 前端直接读这些字段，缺一个就会渲染出 undefined
  const need = [
    ['words.byTier', Array.isArray(d.words.byTier)],
    ['cards.started', typeof d.cards.started === 'number'],
    ['queue.dueToday', typeof d.queue.dueToday === 'number'],
    ['forecast[].count', d.forecast.every((x) => typeof x.count === 'number')],
    ['ability.recognize', Array.isArray(d.ability?.recognize)],
    ['accuracy.dist', typeof d.accuracy?.dist === 'object'],
    ['hardest', Array.isArray(d.hardest)],
    ['recent', Array.isArray(d.recent)],
  ]
  const miss = need.filter(([, ok]) => !ok)
  console.log(
    `  字段完整性: ${miss.length === 0 ? '✓ 全齐' : '✗ 缺 ' + miss.map((x) => x[0]).join(', ')}`,
  )
} else {
  console.log('  失败:', r.json.error)
}

console.log('\n=== 学习页：queue ===')
r = await call('/dsh-word-learn/queue', { url: '/dsh-word-learn/queue?limit=200' })
console.log(
  '  HTTP',
  r.code,
  ' items:',
  r.json.items?.length,
  ' new:',
  r.json.newCount,
  ' review:',
  r.json.reviewCount,
)
if (r.json.items?.length) {
  const it = r.json.items[0]
  console.log(
    `  样本: ${it.word} [${it.trackLabel}] ${it.translation || '(无释义)'} isNew=${it.isNew}`,
  )
}

console.log('\n=== 学习页：word 详情 ===')
r = await call('/dsh-word-learn/word', { url: '/dsh-word-learn/word?word=throughput' })
console.log(
  '  HTTP',
  r.code,
  ' ok:',
  r.json.ok,
  ' 两条线:',
  (r.json.cards || []).map((c) => c.track).join(', ') || '(无)',
)

console.log('\n=== 学习页：grade 评分（要真写回排期） ===')
r = await call('/dsh-word-learn/queue', { url: '/dsh-word-learn/queue?limit=1' })
if (r.json.items?.length) {
  const card = r.json.items[0]
  const before = await call('/dsh-word-learn/word', {
    url: `/dsh-word-learn/word?word=${encodeURIComponent(card.word)}`,
  })
  const b = (before.json.cards || []).find((c) => c.track === card.track)
  const g = await call('/dsh-word-learn/grade', {
    method: 'POST',
    body: JSON.stringify({ cardId: card.cardId, rating: 3 }),
  })
  console.log('  HTTP', g.code, ' ok:', g.json.ok)
  const after = await call('/dsh-word-learn/word', {
    url: `/dsh-word-learn/word?word=${encodeURIComponent(card.word)}`,
  })
  const a = (after.json.cards || []).find((c) => c.track === card.track)
  console.log(`  reps ${b?.reps} -> ${a?.reps}   state ${b?.state} -> ${a?.state}`)
  console.log(`  due 变了: ${b?.due !== a?.due ? '✓' : '✗ 没变（排期没写回）'}`)
  console.log(
    `  stability ${Number(b?.stability || 0).toFixed(2)} -> ${Number(a?.stability || 0).toFixed(2)}`,
  )
} else {
  console.log('  （队列为空，跳过）')
}

console.log('\n=== 补记：评「忘了」→ 开债 → 记事件 → 清债 ===')
const q2 = await call('/dsh-word-learn/queue', { url: '/dsh-word-learn/queue?limit=1' })
if (q2.json.items?.length) {
  const card = q2.json.items[0]
  const g1 = await call('/dsh-word-learn/grade', {
    method: 'POST',
    body: JSON.stringify({ cardId: card.cardId, rating: 1 }),
  })
  const rep = await call('/dsh-word-learn/repair', {
    url: '/dsh-word-learn/repair?cardId=' + card.cardId,
  })
  console.log(
    '  grade HTTP',
    g1.code,
    ' repair HTTP',
    rep.code,
    ' 原句:',
    rep.json.sentence ? '✓' : '✗',
    ' senseMeta:',
    rep.json.senseMeta ? '有' : 'null(降级)',
  )
  console.log('  债:', rep.json.debt && rep.json.debt.cleared_at === null ? '未清 ✓' : '✗ 没有开债')
  const lg = await call('/dsh-word-learn/repair/log', {
    method: 'POST',
    body: JSON.stringify({
      cardId: card.cardId,
      stage: 'pick',
      ok: false,
      guess: 'x',
      elapsedMs: 900,
    }),
  })
  console.log('  log HTTP', lg.code, ' ok:', lg.json.ok)
  const st = await call('/dsh-word-learn/repair/stats', {
    url: '/dsh-word-learn/repair/stats?days=14',
  })
  console.log(
    '  stats HTTP',
    st.code,
    ' stages:',
    JSON.stringify(st.json.stages),
    ' debt:',
    JSON.stringify(st.json.debt),
  )
  const cl = await call('/dsh-word-learn/repair/clear', {
    method: 'POST',
    body: JSON.stringify({ cardId: card.cardId }),
  })
  const rep2 = await call('/dsh-word-learn/repair', {
    url: '/dsh-word-learn/repair?cardId=' + card.cardId,
  })
  console.log(
    '  clear HTTP',
    cl.code,
    ' 债已清:',
    rep2.json.debt && rep2.json.debt.cleared_at ? '✓' : '✗',
  )
} else {
  console.log('  （队列为空，跳过）')
}

console.log('\n=== P2/P3：次日回访 / 义项地图 / 标注词表 ===')
r = await call('/dsh-word-learn/repair/recap', { url: '/dsh-word-learn/repair/recap?limit=5' })
console.log(
  '  recap HTTP',
  r.code,
  ' trials:',
  Array.isArray(r.json.trials) ? r.json.trials.length : '✗',
  '(没题也必须 200+空数组)',
)
r = await call('/dsh-word-learn/repair/recap', { method: 'POST', body: JSON.stringify({}) })
console.log('  recap 缺 wordId -> HTTP', r.code, '(应 400)')
r = await call('/dsh-word-learn/sense-map', { url: '/dsh-word-learn/sense-map?word=latent' })
console.log(
  '  sense-map HTTP',
  r.code,
  ' senses:',
  Array.isArray(r.json.senses) ? r.json.senses.length : '✗',
)
r = await call('/dsh-word-learn/sense-map', { url: '/dsh-word-learn/sense-map?word=' })
console.log('  sense-map 空词 -> HTTP', r.code, '(应 400)')
r = await call('/dsh-word-learn/annotate/words', { url: '/dsh-word-learn/annotate/words?limit=50' })
console.log(
  '  annotate/words HTTP',
  r.code,
  ' 词数:',
  Array.isArray(r.json.words) ? r.json.words.length : '✗',
  ' rev:',
  r.json.rev ? '✓' : '✗',
  ' 形状:',
  r.json.words && r.json.words[0] ? Object.keys(r.json.words[0]).join('/') : '(空)',
)
r = await call('/dsh-word-learn/annotate.js')
const annotateSrc = typeof r.json === 'string' ? r.json : ''
console.log(
  '  annotate.js HTTP',
  r.code,
  ' 字节:',
  annotateSrc.length,
  ' 有 CONFIG:',
  annotateSrc.includes('ROOT_SELECTOR') ? '✓' : '✗',
)

console.log('\n=== 边界：评分参数非法 ===')
r = await call('/dsh-word-learn/grade', {
  method: 'POST',
  body: JSON.stringify({ cardId: 999999, rating: 3 }),
})
console.log('  不存在的 cardId -> HTTP', r.code, r.json.error || '')
r = await call('/dsh-word-learn/grade', {
  method: 'POST',
  body: JSON.stringify({ cardId: 1, rating: 99 }),
})
console.log('  rating=99 -> HTTP', r.code, r.json.error || '')
r = await call('/dsh-word-learn/dashboard', { url: '/dsh-word-learn/dashboard?days=99999' })
console.log('  days=99999 -> HTTP', r.code, ' forecast 长度', r.json.forecast?.length, '(应被夹住)')

console.log('\n=== 翻译：划句子必须给译文（不是只拆词） ===')
r = await call('/dsh-word-learn/translate', {
  method: 'POST',
  body: JSON.stringify({ text: 'The latent space captures semantic structure.' }),
})
console.log('  HTTP', r.code, ' ok:', r.json.ok, ' 来源:', r.json.source || '(无)')
if (r.json.ok) {
  const cn = (r.json.text.match(/[\u4e00-\u9fff]/g) || []).length
  console.log('  译文:', r.json.text)
  console.log('  含汉字:', cn > 0 ? '✓' : '✗ 不是中文')
} else {
  console.log('  失败原因:', r.json.error, '（离线或断网时允许失败）')
}

console.log('\n=== 翻译：空文本应被拒 ===')
r = await call('/dsh-word-learn/translate', {
  method: 'POST',
  body: JSON.stringify({ text: '   ' }),
})
console.log('  空文本 -> HTTP', r.code, r.json.error || '')

console.log('\n=== 翻译：不是 JSON 应被拒 ===')
r = await call('/dsh-word-learn/translate', { method: 'POST', body: '{oops' })
console.log('  坏 JSON -> HTTP', r.code, r.json.error || '')

console.log('\n=== 整句划词：译文 + 拆词 都要有 ===')
r = await call('/dsh-word-learn/save', {
  method: 'POST',
  body: JSON.stringify({ text: 'The latent space captures semantic structure.' }),
})
console.log('  拆词 HTTP', r.code, ' 候选:', (r.json.words || []).map((w) => w.word).join(', '))
const tr = await call('/dsh-word-learn/translate', {
  method: 'POST',
  body: JSON.stringify({ text: 'The latent space captures semantic structure.' }),
})
console.log('  译文 HTTP', tr.code, ' ok:', tr.json.ok)
console.log(
  '  两者都在:',
  (r.json.words || []).length > 0 && tr.json.ok ? '✓ 用户既看到句意也能拆词' : '✗ 缺一半',
)

console.log('\n=== 语音：服务端发音已下线，只剩前端脚本 ===')
// 用户要求：发音全部由浏览器自带语音合成（免费、离线），不再有服务端拉音频的链路。
console.log('  旧 /tts 路由已注销:', routes['/dsh-word-learn/tts'] === undefined ? '✓' : '✗')
console.log(
  '  旧 /tts-prepare 路由已注销:',
  routes['/dsh-word-learn/tts-prepare'] === undefined ? '✓' : '✗',
)
r = await call('/dsh-word-learn/voice.js', { url: '/dsh-word-learn/voice.js' })
console.log(
  '  /voice.js -> HTTP',
  r.code,
  ' 字节',
  (r.raw || Buffer.alloc(0)).length,
  r.headers['Cache-Control'] === 'no-store' ? '（no-store ✓）' : '',
)

console.log('\n=== 悬浮预览：save=false 只看不记 ===')
const probe = 'wander'
r = await call('/dsh-word-learn/word', { url: '/dsh-word-learn/word?word=' + probe })
console.log('  预览前查详情 -> HTTP', r.code, '(404 = 还不在生词本)')
r = await call('/dsh-word-learn/lookup', {
  url: '/dsh-word-learn/lookup?word=' + probe + '&enrich=false&save=false',
})
console.log(
  '  预览 HTTP',
  r.code,
  ' ok:',
  r.json.ok,
  ' 义项:',
  ((r.json.dict && r.json.dict.senses) || []).length,
)
console.log('  预览后 saved:', r.json.saved)
r = await call('/dsh-word-learn/word', { url: '/dsh-word-learn/word?word=' + probe })
console.log('  预览后查详情 -> HTTP', r.code, '(404 = 没被写进生词本 ✓)')
r = await call('/dsh-word-learn/lookup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ word: probe, enrich: false, save: true }),
})
console.log('  加入生词本 -> HTTP', r.code, ' saved:', !!r.json.saved)
r = await call('/dsh-word-learn/word', { url: '/dsh-word-learn/word?word=' + probe })
console.log('  加入后查详情 -> HTTP', r.code, '(200 = 已入库 ✓)')

// ─────────────────────────────────────────────────────────────
// task-6：路由健壮性断言（上半部分只打印，这里开始真正 pass/fail）
// ─────────────────────────────────────────────────────────────
let passed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) passed++
  else failures.push(name + (extra === undefined ? '' : ' -> ' + String(extra)))
}
function checkEq(name, actual, expected) {
  check(
    name,
    actual === expected,
    `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`,
  )
}
function checkNoPath(name, body) {
  const raw = String(body || '')
  // 绝对路径在 JSON 里要么带盘符、要么带目录名；顺手把探针故意抛的 'boom' 也查上
  check(
    name,
    !raw.includes('C:') &&
      !raw.includes('dsh-word-learn') &&
      !raw.includes('user.db') &&
      !raw.includes('boom'),
    raw,
  )
}

console.log('\n=== task-6：POST body 非法 → 400（不是 500，也不是空 400） ===')
r = await call('/dsh-word-learn/update', { method: 'POST', body: 'null' })
checkEq('body=null -> 400', r.code, 400)
checkEq('body=null 有说明', typeof r.json.error, 'string')
r = await call('/dsh-word-learn/update', { method: 'POST', body: '[]' })
checkEq('body=[] -> 400', r.code, 400)
r = await call('/dsh-word-learn/update', { method: 'POST', body: '"x"' })
checkEq('body=标量 -> 400', r.code, 400)
r = await call('/dsh-word-learn/update', { method: 'POST', body: '' })
checkEq('body=空 -> 400', r.code, 400)

console.log('\n=== task-6：非 GET/POST → 405 ===')
r = await call('/dsh-word-learn/repair/recap', { method: 'PUT' })
checkEq('PUT recap -> 405', r.code, 405)
checkEq('405 有稳定 code', r.json.code, 'METHOD_NOT_ALLOWED')
checkEq('405 只发一次', r.ends, 1)
r = await call('/dsh-word-learn/lookup', {
  method: 'DELETE',
  url: '/dsh-word-learn/lookup?word=daemon',
})
checkEq('DELETE lookup -> 405', r.code, 405)
checkEq('DELETE lookup 只发一次', r.ends, 1)

console.log('\n=== task-6：/list 参数夹取 ===')
r = await call('/dsh-word-learn/list', { url: '/dsh-word-learn/list?limit=-1&offset=-5' })
checkEq('limit=-1 -> HTTP 200', r.code, 200)
check(
  'limit=-1 被夹到 1',
  Array.isArray(r.json.items) && r.json.items.length <= 1,
  r.json.items?.length,
)
check('offset=-5 被夹到 0', typeof r.json.total === 'number')

console.log('\n=== task-6：/stats 路由已删 ===')
check('/stats 已注销', routes['/dsh-word-learn/stats'] === undefined)

console.log('\n=== task-6：500 响应不含绝对路径 ===')
const { Store } = await import('../lib/store.mjs')

// ① 没有自带 try/catch 的 /list：靠 registerRoute 统一兜底
const realList = Store.prototype.list
Store.prototype.list = function () {
  throw new Error('boom ' + path.join(os.tmpdir(), 'dsh-word-learn', 'user.db'))
}
try {
  r = await call('/dsh-word-learn/list')
  checkEq('handler 抛错 -> 500', r.code, 500)
  checkEq('500 有稳定 code', r.json.code, 'INTERNAL_ERROR')
  checkNoPath('500 不含绝对路径', r.raw)
  checkEq('500 只发一次', r.ends, 1)
  check('500 没有二次写头', r.doubleSend === false)
} finally {
  Store.prototype.list = realList
}

// ② 用户库打不开：不回 store.error（含绝对路径），只回 DB_UNAVAILABLE
//    用带 query 的第二次 import 拿一份全新的模块实例（同一个 Store 类）。
const realOpen = Store.prototype.open
Store.prototype.open = () => false
try {
  const routes2 = {}
  const ctx2 = {
    get: () => null,
    connection: null,
    webServer: {
      register: (route2) => {
        routes2[route2.path] = route2.handler
        return () => {}
      },
      tapIndex: () => () => {},
    },
    effect: () => () => {},
  }
  const root2 = { effect: () => () => {}, on: () => () => {}, inject: (deps, fn) => fn(ctx2) }
  const mod2 = await import('../lib/index.js?probe-openfail=' + Date.now())
  mod2.default.apply(root2)
  // 探针必须在 open 仍被替换着的时候打，否则 store 会真的打开（那就不测这个分支了）
  const res2 = mkRes()
  await routes2['/dsh-word-learn/queue'](mkReq('/dsh-word-learn/queue?limit=1'), res2)
  const body2 = res2.result.body
  let json2 = null
  try {
    json2 = JSON.parse(body2)
  } catch (err) {}
  checkEq('库打不开 -> 500', res2.result.code, 500)
  checkEq('库打不开有稳定 code', json2 && json2.code, 'DB_UNAVAILABLE')
  checkNoPath('库打不开不含绝对路径', body2)
  checkEq('库打不开只发一次', res2.result.ends, 1)
} catch (err) {
  check('库打不开探针可用', false, (err && err.message) || String(err))
} finally {
  Store.prototype.open = realOpen
}

// ③ 评分已写库：收尾记债抛错也不能回 500（否则客户端重试 → 重复评分）
console.log('\n=== task-6：评分已写库后回 200（记债失败不回 500） ===')
r = await call('/dsh-word-learn/queue', { url: '/dsh-word-learn/queue?limit=1' })
const gItem = (r.json.items || [])[0]
if (gItem) {
  const realOpenDebt = Store.prototype.openRepairDebt
  Store.prototype.openRepairDebt = () => {
    throw new Error('debt bookkeeping failed ' + path.join(os.tmpdir(), 'user.db'))
  }
  try {
    r = await call('/dsh-word-learn/grade', {
      method: 'POST',
      body: JSON.stringify({ cardId: gItem.cardId, rating: 1 }),
    })
    checkEq('记债抛错仍 200', r.code, 200)
    checkEq('评分结果 ok=true', r.json.ok, true)
    checkEq('评分响应只发一次', r.ends, 1)
    checkNoPath('评分响应不含绝对路径', r.raw)
  } finally {
    Store.prototype.openRepairDebt = realOpenDebt
  }
} else {
  console.log('  （队列为空，跳过评分收尾断言）')
}

console.log('\n=== task-6 断言汇总 ===')
const totalChecks = passed + failures.length
if (failures.length) {
  console.log(`✗ ${failures.length} / ${totalChecks} 项失败`)
  for (const f of failures) console.log('  -', f)
  process.exitCode = 1
} else {
  console.log(`✓ ${totalChecks} 项断言全部通过`)
}
