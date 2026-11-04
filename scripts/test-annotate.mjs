#!/usr/bin/env node
// scripts/test-annotate.mjs —— P3 标注层的自测。
//
// 三部分：
//   1. 纯函数（tokenize / 词形还原 / matchText / 句界）—— 用 vm 在 Node 里直接跑
//      assets/annotate.js，无 DOM 时它只暴露 _internals，不会碰 document。
//   2. annotateWordList —— 临时 DSH_HOME 建一个最小用户库，验证词表契约
//      （只取"在学"的词、首义、最近 sense_here、卡片 id、版本号）。
//   3. 端到端（--browser）—— 起静态服务，用 bsk 打开 scripts/test-annotate-fixture/，
//      断言：正常段落标了、代码/行内代码/链接/路径/URL/弹窗/工具块零标注、
//      流式零标注、折叠框未展开只标 summary、展开后 body 补标、单块 60 上限、
//      关掉开关后零 span。
//
// 用法：
//   node scripts/test-annotate.mjs
//   BSK_BROWSER=bda3db85 node scripts/test-annotate.mjs --browser
//
// 注意：--browser 会自己 bsk session start / stop，不碰别人正在用的会话。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const ANNOTATE_JS = path.join(ROOT, 'assets', 'annotate.js')
const FIXTURE_DIR = path.join(HERE, 'test-annotate-fixture')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(
    '[' + mark + '] ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)),
  )
}
function equal(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  record(name, a === b, { actual, expected })
}
function truthy(name, actual) {
  record(name, !!actual, actual)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- 1. 纯函数
function loadPure() {
  const code = fs.readFileSync(ANNOTATE_JS, 'utf8')
  const noop = function () {}
  const sandbox = {
    window: {
      localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
      fetch: () => Promise.reject(new Error('no network in unit test')),
      setTimeout: () => 0,
      clearTimeout: noop,
      addEventListener: noop,
      removeEventListener: noop,
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'assets/annotate.js' })
  return sandbox.window.__dwlAnnotate
}

function testPure() {
  console.log('== 1. 纯函数 ==')
  const api = loadPure()
  truthy('无 DOM 时不崩、只暴露 _internals', api && api._noDom && api._internals)
  const i = api._internals
  const ws = new Set(['charge', 'model', 'token', 'use', 'index', 'api', 'get'])

  const m1 = i.matchText('The model charge and token are stable.', ws)
  equal(
    '普通句子命中 3 个',
    m1.map((x) => x.lemma),
    ['model', 'charge', 'token'],
  )

  const m2 = i.matchText('See https://charge.example.com/charge and src/lib/charge.js', ws)
  equal('URL/路径里的词一个都不命中', m2.length, 0)

  const m3 = i.matchText('getElementById charge API 3D v24.13.0', ws)
  equal(
    '驼峰/缩写/版本号不命中，只命中自然词',
    m3.map((x) => x.lemma),
    ['charge'],
  )

  const m4 = i.matchText('model model model', ws)
  equal('同一句多次出现都命中', m4.length, 3)

  const m5 = i.matchText('model/charge', ws)
  equal('斜杠邻接的标识符不命中', m5.length, 0)

  const c1 = i.lemmaCandidates('charged')
  truthy('charged 的候选里含 charge', c1.indexOf('charge') >= 0)
  const c2 = i.lemmaCandidates("model's")
  truthy("model's 的候选里含 model", c2.indexOf('model') >= 0)

  const s1 = i.sentenceAround('First sentence here. The charge was dropped. Last one.', 24, 30)
  equal('句界截取只拿中间那句', s1, 'The charge was dropped.')

  // 非 ASCII 词被切断后不能误标（résumé 的 "sum"）。
  const m6 = i.matchText('résumé model', new Set(['sum', 'model']))
  equal(
    '非 ASCII 词切出的残片不命中',
    m6.map((x) => x.lemma),
    ['model'],
  )
  const m7 = i.matchText('café charge', new Set(['caf', 'charge']))
  equal(
    'café 的 "caf" 不命中',
    m7.map((x) => x.lemma),
    ['charge'],
  )
  // 弯撇号归一化：don’t 应命中 don't。
  const m8 = i.matchText('don’t charge', new Set(["don't", 'charge']))
  equal(
    '弯撇号归一化后命中',
    m8.map((x) => x.lemma),
    ["don't", 'charge'],
  )
  // 邻接的 Unicode 标点/空白不能被当成"非 ASCII 字母"把正常词判成残片。
  const m9 = i.matchText('model\u00a0charge', new Set(['model', 'charge']))
  equal(
    '不换行空格邻接照常命中',
    m9.map((x) => x.lemma),
    ['model', 'charge'],
  )
  const m10 = i.matchText('model—charge', new Set(['model', 'charge']))
  equal(
    '破折号邻接照常命中',
    m10.map((x) => x.lemma),
    ['model', 'charge'],
  )

  const h1 = i.hashText('same text')
  const h2 = i.hashText('same text')
  const h3 = i.hashText('other text')
  truthy('hash 稳定且能区分变化', h1 === h2 && h1 !== h3)
}

// ---------------------------------------------------------------- 2. 词表契约
async function testWordList() {
  console.log('== 2. annotateWordList ==')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-annotate-'))
  // store.mjs 在模块加载时读 DSH_HOME，所以必须先设环境变量再动态 import。
  process.env.DSH_HOME = tmp
  const storeUrl = pathToFileURL(path.join(ROOT, 'lib', 'store.mjs')).href
  const annotateUrl = pathToFileURL(path.join(ROOT, 'lib', 'annotate.mjs')).href
  const { Store } = await import(storeUrl)
  const { annotateWordList } = await import(annotateUrl)

  const store = new Store()
  const opened = store.open()
  truthy('临时用户库能打开', opened)
  const db = store.db
  const now = 1000
  function addWord(word, translation, extra) {
    const sql =
      'INSERT INTO words (word, translation, phonetic, graduated, seen_count, created_at, seen_at) VALUES (?,?,?,?,?,?,?)'
    const info = db
      .prepare(sql)
      .run(word, translation, '', (extra && extra.graduated) || 0, 1, now, now)
    return Number(info.lastInsertRowid)
  }
  function addCard(wordId, track, extra) {
    const sql =
      'INSERT INTO cards (word_id, track, due, state, reps, suspended) VALUES (?,?,?,?,?,?)'
    const info = db.prepare(sql).run(wordId, track, now, 2, 0, (extra && extra.suspended) || 0)
    return Number(info.lastInsertRowid)
  }

  const chargeId = addWord('charge', 'v. 收费；充电', {})
  const chargeCard = addCard(chargeId, 'receptive', {})
  addCard(chargeId, 'productive', {})

  const modelId = addWord('model', 'n. 模型', {})
  addCard(modelId, 'receptive', { suspended: 1 })

  const tokenId = addWord('token', 'n. 令牌', { graduated: 1 })
  addCard(tokenId, 'receptive', {})

  // 同一个词两条 sense_meta：取 created_at 最新的那条
  db.prepare(
    'INSERT INTO sense_meta (word_id, sense_key, json, model, created_at) VALUES (?,?,?,?,?)',
  ).run(chargeId, 'v. 收费；充电', JSON.stringify({ sense_here: 'v. 收费；充电' }), 'test', now)
  db.prepare(
    'INSERT INTO sense_meta (word_id, sense_key, json, model, created_at) VALUES (?,?,?,?,?)',
  ).run(chargeId, 'n. 指控', JSON.stringify({ sense_here: 'n. 指控' }), 'test', now + 500)

  const out = annotateWordList(store, { limit: 10 })
  equal(
    '只返回在学的词（挂起/毕业的词被排除）',
    out.words.map((x) => x.w),
    ['charge'],
  )
  equal('首义 = translation 第一段', out.words[0] && out.words[0].t, 'v. 收费；充电')
  equal('s = 最近一条 sense_here', out.words[0] && out.words[0].s, 'n. 指控')
  equal('c = 代表卡片 id（receptive 优先，取较小 id）', out.words[0] && out.words[0].c, chargeCard)
  truthy('rev 是非空字符串', typeof out.rev === 'string' && out.rev.length > 0)
  equal('成功响应带 ok:true', out.ok, true)
  equal('total = 过滤后的总词数', out.total, 1)
  equal('truncated = false', out.truncated, false)

  const before = out.rev
  db.prepare('UPDATE cards SET last_review = ? WHERE id = ?').run(now + 9000, chargeCard)
  const after = annotateWordList(store, { limit: 10 })
  truthy('卡片状态变化会改 rev', after.rev !== before)

  // rev 内容投影：这三类写入以前不改 rev（审查报告 2026-11-04 第 3 节第 1 条）。
  let prevRev = after.rev
  db.prepare('UPDATE words SET translation = ? WHERE id = ?').run('v. 收费；充电；控告', chargeId)
  const afterTranslation = annotateWordList(store, { limit: 10 })
  truthy('补全/改写 translation 会改 rev', afterTranslation.rev !== prevRev)
  prevRev = afterTranslation.rev

  db.prepare('UPDATE words SET seen_count = seen_count + 1 WHERE id = ?').run(chargeId)
  const afterSeen = annotateWordList(store, { limit: 10 })
  truthy('seen_count 变化会改 rev', afterSeen.rev !== prevRev)
  prevRev = afterSeen.rev

  db.prepare('UPDATE words SET graduated = 1 WHERE id = ?').run(chargeId)
  const afterGraduated = annotateWordList(store, { limit: 10 })
  truthy('graduated 变化会改 rev', afterGraduated.rev !== prevRev)
  equal('毕业的词立刻从词表消失', afterGraduated.words.length, 0)
  db.prepare('UPDATE words SET graduated = 0 WHERE id = ?').run(chargeId)
  const afterUngraduate = annotateWordList(store, { limit: 10 })
  prevRev = afterUngraduate.rev

  db.prepare('UPDATE cards SET suspended = 1 WHERE id = ?').run(chargeCard)
  const afterSuspended = annotateWordList(store, { limit: 10 })
  truthy('卡片 suspended 变化会改 rev', afterSuspended.rev !== prevRev)
  // 只挂起 receptive 线时，productive 线还活着，词仍在；代表卡片切换到活着的那张。
  equal('单条线挂起后词仍在（另一条线还在）', afterSuspended.words.length, 1)
  equal(
    '代表卡片切到未挂起的那条',
    afterSuspended.words[0] && afterSuspended.words[0].c,
    chargeCard + 1,
  )
  db.prepare('UPDATE cards SET suspended = 0 WHERE id = ?').run(chargeCard)

  // limit 语义：缺省 2000；负数/0 夹到 1；Infinity 夹到 5000；NaN 走缺省。
  equal('limit=0 夹到 1', annotateWordList(store, { limit: 0 }).words.length, 1)
  equal('limit=-5 夹到 1', annotateWordList(store, { limit: -5 }).words.length, 1)
  truthy('limit=Infinity 不抛且返回成功', annotateWordList(store, { limit: Infinity }).ok === true)
  truthy('limit=NaN 走缺省且成功', annotateWordList(store, { limit: 'abc' }).ok === true)

  // 最近加入优先 + total/truncated：再塞三个"在学"词（created_at 相同 → 按 id DESC）。
  for (const name of ['alpha', 'beta', 'gamma']) {
    const id = addWord(name, 'n. ' + name, {})
    addCard(id, 'receptive', {})
  }
  const limited = annotateWordList(store, { limit: 2 })
  equal(
    'limit 生效且最近加入优先',
    limited.words.map((x) => x.w),
    ['gamma', 'beta'],
  )
  equal('total 不受 limit 影响', limited.total, 4)
  equal('truncated = true', limited.truncated, true)
  equal('limit=2.9 向下取整为 2', annotateWordList(store, { limit: 2.9 }).words.length, 2)

  // 错误语义：查询失败必须返回 ok:false（不带 words），不能伪装成空词表。
  const brokenStore = {
    open: () => true,
    db: {
      prepare: () => {
        throw new Error('boom: disk I/O error')
      },
    },
  }
  const broken = annotateWordList(brokenStore, { limit: 10 })
  equal('查询失败返回 ok:false', broken.ok, false)
  truthy('查询失败带 error', typeof broken.error === 'string' && broken.error.length > 0)
  equal('查询失败不带 words（前端据此保留旧标注）', Array.isArray(broken.words), false)

  const noStore = annotateWordList(null)
  equal('没有 store 也返回 ok:false', noStore.ok, false)

  store.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 3. 端到端
// ---------- 3.1 静态服务 ----------
const serverState = { empty: false, failWords: false, port: 0 }
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = String(req.url || '/').split('?')[0]
      function send(status, type, body) {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
        res.end(body)
      }
      try {
        if (urlPath === '/' || urlPath === '/index.html') {
          send(
            200,
            'text/html; charset=utf-8',
            fs.readFileSync(path.join(FIXTURE_DIR, 'index.html')),
          )
          return
        }
        if (urlPath === '/assets/annotate.js') {
          send(200, 'text/javascript; charset=utf-8', fs.readFileSync(ANNOTATE_JS))
          return
        }
        if (urlPath === '/dsh-word-learn/annotate/words' || urlPath === '/annotate/words') {
          if (serverState.failWords) {
            // 模拟"查询失败"：和 index.js 里的 `{ok:true, ...annotateWordList()}` 展开一致——
            // annotateWordList 返回 {ok:false,error} 时整体变成 ok:false（HTTP 仍可能 200）。
            send(
              200,
              'application/json; charset=utf-8',
              JSON.stringify({ ok: false, error: 'fixture transient db error' }),
            )
            return
          }
          if (serverState.empty) {
            send(
              200,
              'application/json; charset=utf-8',
              JSON.stringify({
                ok: true,
                words: [],
                rev: 'fixture-empty',
                total: 0,
                truncated: false,
              }),
            )
            return
          }
          send(
            200,
            'application/json; charset=utf-8',
            fs.readFileSync(path.join(FIXTURE_DIR, 'dsh-word-learn', 'annotate', 'words')),
          )
          return
        }
        send(404, 'text/plain; charset=utf-8', 'not found')
      } catch (err) {
        send(500, 'text/plain; charset=utf-8', String(err && err.message))
      }
    })
    server.listen(0, '127.0.0.1', () => {
      serverState.port = server.address().port
      resolve(server)
    })
  })
}

// ---------- 3.2 bsk CLI ----------
const BSK = process.env.BSK_BIN || 'bsk'
function bsk(args, options) {
  const opts = options || {}
  return execFileSync(BSK, args, {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { BSK_AUTO_START: '0' }),
    timeout: 60000,
    input: opts.input,
  })
}
/** 允许失败的 bsk 调用：返回 { ok, stdout, stderr }，不抛。 */
function bskSoft(args) {
  try {
    return { ok: true, stdout: bsk(args) }
  } catch (err) {
    return {
      ok: false,
      stdout: String((err && err.stdout) || ''),
      stderr: String((err && err.stderr) || ''),
      message: String((err && err.message) || err),
    }
  }
}
function parseJson(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('bsk 输出不是 JSON: ' + raw.slice(0, 200))
  return JSON.parse(raw.slice(start, end + 1))
}
function bskSessionStart(browserId) {
  const out = bsk(['session', 'start', '--browser', browserId, '--json'])
  const json = parseJson(out)
  if (!json.session_id) throw new Error('session start 没有返回 session_id')
  return json.session_id
}
function bskEvaluate(sessionId, expression) {
  let lastErr = ''
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sync = parseJson(bsk(['cooperate', 'sync', '--session', sessionId, '--json']))
    const args = [
      'evaluate',
      '--json',
      '--session',
      sessionId,
      '--context',
      sync.context_id,
      '--observation',
      sync.observation_id,
      expression,
    ]
    const out = bsk(args)
    const json = parseJson(out)
    if (json.code === 'permission_denied') {
      lastErr = json.message || 'permission_denied'
      continue
    }
    if (json.ok === false) throw new Error('evaluate 失败: ' + JSON.stringify(json).slice(0, 300))
    return json.value
  }
  throw new Error('evaluate 连续失败: ' + lastErr)
}

const COUNT_EXPR = [
  '(function(){',
  '  var r = {};',
  '  function spans(el){ return el ? el.querySelectorAll(".dwl-anno").length : -1 }',
  '  function byId(id){ return document.getElementById(id) }',
  '  var api = window.__dwlAnnotate;',
  '  r.version = api && api.version;',
  '  r.enabled = api ? api.stats().enabled : null;',
  '  r.words = api ? api.stats().words : null;',
  '  r.para = spans(byId("ok-para"));',
  '  r.inlineCode = spans(byId("inline-code"));',
  '  r.preCode = spans(byId("pre-code"));',
  '  r.mdCode = spans(byId("md-code"));',
  '  r.link = spans(byId("link"));',
  '  r.path = spans(byId("path-para"));',
  '  r.url = spans(byId("url-para"));',
  '  r.detailsSummary = spans(byId("det-sum"));',
  '  r.detailsBody = spans(byId("det-body"));',
  '  r.streaming = spans(byId("streaming"));',
  '  r.hiddenSub = spans(byId("hidden-sub"));',
  '  r.cap = spans(byId("cap"));',
  '  r.reasonCollapsed = spans(document.querySelector("[data-testid=block-reason-collapsed]"));',
  '  r.reasonOpenTitle = spans(byId("reason-open-title"));',
  '  r.reasonOpenBody = spans(byId("reason-open-body"));',
  '  r.dialog = spans(byId("dialog"));',
  '  r.tool = spans(byId("tool"));',
  '  r.outside = spans(byId("outside"));',
  '  r.processTitle = spans(byId("process-title"));',
  '  r.processBody = spans(byId("process-body"));',
  '  r.processBlock = spans(document.querySelector("[data-testid=block-process]"));',
  '  r.total = document.querySelectorAll(".dwl-anno").length;',
  '  r.storage = (function(){ try { return localStorage.getItem("dwl-annotate") } catch(e) { return "?" } })();',
  '  return r;',
  '})()',
].join('')

function expectCounts(label, counts, expected) {
  for (const key of Object.keys(expected)) {
    equal(label + ' :: ' + key, counts[key], expected[key])
  }
}

async function testBrowser(browserId) {
  console.log('== 3. 端到端（bsk + fixture） ==')
  const server = await startServer()
  const base = 'http://127.0.0.1:' + serverState.port + '/'
  let sessionId = ''
  try {
    sessionId = bskSessionStart(browserId)
    console.log('session:', sessionId, 'url:', base)
    // 新 Agent Window 的扩展链路要几秒才就绪；navigate 偶尔以 exit 4（超时但可能已生效）
    // 结束，所以这里软失败 + 重试，随后用 evaluate 确认页面真的到了。
    await sleep(1200)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nav = bskSoft(['navigate', '--session', sessionId, base, '--json'])
      if (nav.ok) break
      if (attempt === 2) console.log('navigate 软失败（继续，后续用 evaluate 验证）:', nav.message)
      await sleep(1500)
    }

    // 正常路径：词表 3 个词，正常段落 3 个 span。
    await sleep(2600)
    const first = bskEvaluate(sessionId, COUNT_EXPR)
    expectCounts('首轮', first, {
      para: 3,
      inlineCode: 0,
      preCode: 0,
      mdCode: 0,
      link: 0,
      path: 0,
      url: 0,
      detailsSummary: 1,
      detailsBody: 0,
      streaming: 0,
      hiddenSub: 0,
      cap: 60,
      // 真实 DSH 形态：折叠思考行的**标题**要标（charge model preview），
      // 但整个 process 块此时 hidden="until-found"，所以 block-process 里 0 个。
      reasonCollapsed: 2,
      reasonOpenTitle: 1,
      reasonOpenBody: 2,
      processBlock: 0,
      processTitle: 0,
      dialog: 0,
      tool: 0,
      outside: 0,
      total: 69,
    })
    equal('首轮 :: 版本号', first.version, '1.0.0')
    equal('首轮 :: 默认开启', first.enabled, true)

    // 展开 <details>：body 补标，summary 不重复标。
    bskEvaluate(
      sessionId,
      '(function(){ document.getElementById("details").open = true; return true })()',
    )
    await sleep(1800)
    const opened = bskEvaluate(sessionId, COUNT_EXPR)
    equal('展开折叠框后 body 补标', opened.detailsBody, 3)
    equal('展开折叠框后 summary 不重复标', opened.detailsSummary, 1)
    equal('展开折叠框后总数', opened.total, 72)

    // 关掉开关：零 span + localStorage 标记。
    bskEvaluate(sessionId, 'window.__dwlAnnotate.disable()')
    await sleep(400)
    const off = bskEvaluate(sessionId, COUNT_EXPR)
    equal('关闭开关后零 span', off.total, 0)
    equal('关闭开关后 localStorage = off', off.storage, 'off')
    equal(
      '关闭开关后 running = false',
      bskEvaluate(sessionId, 'window.__dwlAnnotate.stats().running'),
      false,
    )

    // 重新打开：应恢复标注（details 仍开着，所以总数 72）。
    bskEvaluate(sessionId, 'window.__dwlAnnotate.enable()')
    await sleep(2400)
    const on = bskEvaluate(sessionId, COUNT_EXPR)
    equal('重新打开后恢复标注', on.total, 72)
    equal('重新打开后 details body 仍标注', on.detailsBody, 3)

    // stats.blocks 必须是"去重后的块数"，不是 span 数。
    // fixture 里含 span 的块：ok-para、details（summary+body 同块）、cap、
    // reason-collapsed（标题）、reason-open（标题+正文）= 5。
    const st = bskEvaluate(sessionId, 'window.__dwlAnnotate.stats()')
    equal('stats.blocks 是去重块数', st.blocks, 5)
    equal('stats.spans 是 span 总数', st.spans, 72)

    // 模拟 React 重渲染把 span 冲掉（文本不变）：refresh 后必须补标。
    // 这条同时证明"计数用实时值"：旧实现累加值不降，冲掉后再也不会标。
    const wiped = bskEvaluate(
      sessionId,
      '(function(){ var p=document.getElementById("ok-para"); var spans=p.querySelectorAll(".dwl-anno");' +
        ' for (var i=0;i<spans.length;i++){ var s=spans[i]; s.parentNode.replaceChild(document.createTextNode(s.textContent), s) }' +
        ' return p.querySelectorAll(".dwl-anno").length })()',
    )
    equal('模拟 React 冲掉后本块零 span', wiped, 0)
    bskEvaluate(sessionId, 'window.__dwlAnnotate.refresh()')
    await sleep(2400)
    const restored = bskEvaluate(sessionId, COUNT_EXPR)
    equal('refresh 后块内 span 补回（指纹含 span 数）', restored.para, 3)
    equal('refresh 后总数恢复', restored.total, 72)

    // 属性变化（摘掉 data-streaming）要能触发重扫并补标。
    bskEvaluate(
      sessionId,
      '(function(){ var el=document.getElementById("streaming"); el.removeAttribute("data-streaming"); return true })()',
    )
    await sleep(2000)
    const unstreamed = bskEvaluate(sessionId, COUNT_EXPR)
    equal('去掉 data-streaming 后重扫补标', unstreamed.streaming, 3)
    equal('属性变化后总数', unstreamed.total, 75)

    // 真实 DSH 的 process 组：整体 hidden 时零标注；摘掉 hidden 后
    // 折叠行的**标题**（div[role=button][data-disclosure-row][aria-expanded=false]）要补标；
    // 再展开该行（aria-expanded=true + 正文进 DOM）后正文也要标。
    bskEvaluate(
      sessionId,
      '(function(){ document.querySelector("[data-testid=block-process]").removeAttribute("hidden"); return true })()',
    )
    await sleep(2000)
    const processOpen = bskEvaluate(sessionId, COUNT_EXPR)
    equal('process 组展开后标题补标（role=button 不再误杀）', processOpen.processTitle, 3)
    equal('process 组展开后 block 内 span', processOpen.processBlock, 3)
    equal('process 组展开后总数', processOpen.total, 78)

    bskEvaluate(
      sessionId,
      '(function(){' +
        ' var row = document.getElementById("process-row");' +
        ' row.setAttribute("aria-expanded", "true");' +
        ' var body = document.createElement("div");' +
        ' body.innerHTML = \'<p id="process-body" data-testid="process-body">charge model token body</p>\';' +
        ' row.parentElement.parentElement.parentElement.appendChild(body);' +
        ' return true })()',
    )
    await sleep(2000)
    const processExpanded = bskEvaluate(sessionId, COUNT_EXPR)
    equal('process 行展开后正文补标', processExpanded.processBody, 3)
    equal('process 行展开后标题不重复标', processExpanded.processTitle, 3)
    equal('process 行展开后总数', processExpanded.total, 81)

    // 查询失败（服务端 ok:false）：必须保留旧词表与已有标注、不 detach 观察器，
    // 只排一次重试（审查报告 2026-11-04 第 3 节第 2 条）。
    serverState.failWords = true
    bskEvaluate(sessionId, 'window.__dwlAnnotate.refresh()')
    await sleep(1800)
    const failed = bskEvaluate(sessionId, COUNT_EXPR)
    equal('查询失败后保留旧标注（不清空）', failed.total, 81)
    equal('查询失败后词表不变', failed.words, 3)
    const failedStats = bskEvaluate(sessionId, 'window.__dwlAnnotate.stats()')
    equal('查询失败后仍在运行（未 detach 观察器）', failedStats.running, true)
    equal('stats 暴露 total', failedStats.total, 3)
    equal('stats 暴露 truncated', failedStats.truncated, false)
    serverState.failWords = false

    // 空词表：旧标注必须被立刻清掉，且不再观察 DOM。
    // 用 reload 而不是 navigate：navigate 在这个 Agent Window 上会偶发超时，
    // reload 走的是当前 URL，词表由服务端 serverState 控制，行为稳定。
    serverState.empty = true
    equal('空词表：切换到空词表前确有标注', failed.total, 81)
    bskEvaluate(sessionId, '(function(){ location.reload(); return true })()')
    await sleep(2600)
    const empty = bskEvaluate(sessionId, COUNT_EXPR)
    equal('词表为空时零 span（旧标注被清掉）', empty.total, 0)
    equal('词表为空时 words = 0', empty.words, 0)
    serverState.empty = false
  } finally {
    // session stop 的 session id 是位置参数（不是 --session）；失败也不影响测试结果。
    if (sessionId) {
      const stop = bskSoft(['session', 'stop', sessionId])
      if (!stop.ok) console.log('session stop 失败（忽略）:', stop.message)
    }
    server.close()
  }
}

// ---------------------------------------------------------------- main
async function main() {
  testPure()
  await testWordList()

  const browserId = process.env.BSK_BROWSER || ''
  const wantBrowser = process.argv.indexOf('--browser') >= 0 || !!browserId
  if (wantBrowser) {
    if (!browserId) {
      console.log('跳过端到端：没有 BSK_BROWSER（浏览器实例 id）')
    } else {
      await testBrowser(browserId)
    }
  } else {
    console.log('（跳过端到端；加 --browser 且设 BSK_BROWSER=<实例id> 可跑）')
  }

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' 通过')
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log('  - ' + f.name + ' ' + JSON.stringify(f.detail))
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('测试异常:', err)
  process.exitCode = 1
})
