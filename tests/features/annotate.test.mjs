// 测什么：标注层的纯文本规则（tokenize / 词形还原 / 命中判定 / 句界 / 指纹）与
// 「在学词表」契约（lib/annotate.mjs）—— 从 scripts/test-annotate.mjs 第 1、2 部分迁移。
//
// 为什么放单测：这些是规则密集的纯函数，一个邻接字符判断写错，就会把 URL/路径/驼峰
// 标识符标进正文；legacy 脚本里这部分靠 vm 注入整个 IIFE、再先加载 core.js 才能测。
// 现在标注层是 bundle 内的模块，纯函数直接 import，不需要 DOM、不需要注入顺序。
// 词表契约用临时 DSH_HOME 建最小用户库 —— 绝不碰真实 $DSH_HOME/dsh-word-learn/user.db。
//
// 边界：不碰 DOM、不联网。真实浏览器端到端（bsk + fixture：排除范围/流式/折叠/限额/
// 开关）仍留在 scripts/test-annotate.mjs —— 那条路径 node --test 跑不了。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { annotate, installAnnotate, internals } from '../../src/client/features/annotate/index.js'

const { CONFIG, hashText, lemmaCandidates, matchText, sentenceAround } = internals
const ROOT = path.join(import.meta.dirname, '..', '..')
const ANNOTATE_DIR = path.join(ROOT, 'src', 'client', 'features', 'annotate')

/** 标注层各模块的源码（静态契约断言用；不执行 DOM）。 */
function sources() {
  return fs
    .readdirSync(ANNOTATE_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(ANNOTATE_DIR, f), 'utf8') }))
}

const WORDS = new Set(['charge', 'model', 'token', 'use', 'index', 'api', 'get'])

describe('matchText：命中与噪音过滤', () => {
  test('普通句子按词表命中', () => {
    const found = matchText('The model charge and token are stable.', WORDS)
    assert.deepEqual(
      found.map((x) => x.lemma),
      ['model', 'charge', 'token'],
    )
  })

  test('URL / 路径里的词一个都不命中', () => {
    const found = matchText('See https://charge.example.com/charge and src/lib/charge.js', WORDS)
    assert.equal(found.length, 0)
  })

  test('驼峰 / 缩写 / 版本号不命中，只命中自然词', () => {
    const found = matchText('getElementById charge API 3D v24.13.0', WORDS)
    assert.deepEqual(
      found.map((x) => x.lemma),
      ['charge'],
    )
  })

  test('同一句多次出现都命中', () => {
    assert.equal(matchText('model model model', WORDS).length, 3)
  })

  test('斜杠邻接的标识符不命中', () => {
    assert.equal(matchText('model/charge', WORDS).length, 0)
  })

  test('非 ASCII 词切出的残片不命中（résumé 的 sum / café 的 caf）', () => {
    const resume = matchText('résumé model', new Set(['sum', 'model']))
    assert.deepEqual(
      resume.map((x) => x.lemma),
      ['model'],
    )
    const cafe = matchText('café charge', new Set(['caf', 'charge']))
    assert.deepEqual(
      cafe.map((x) => x.lemma),
      ['charge'],
    )
  })

  test('弯撇号归一化后命中', () => {
    const found = matchText('don’t charge', new Set(["don't", 'charge']))
    assert.deepEqual(
      found.map((x) => x.lemma),
      ["don't", 'charge'],
    )
  })

  test('相邻的 Unicode 标点 / 空白不算「非 ASCII 字母」', () => {
    const nbsp = matchText('model\u00a0charge', new Set(['model', 'charge']))
    assert.deepEqual(
      nbsp.map((x) => x.lemma),
      ['model', 'charge'],
    )
    const dash = matchText('model—charge', new Set(['model', 'charge']))
    assert.deepEqual(
      dash.map((x) => x.lemma),
      ['model', 'charge'],
    )
  })
})

describe('lemmaCandidates：规则化词形还原', () => {
  test('过去式 / 所有格能回到原形', () => {
    assert.ok(lemmaCandidates('charged').includes('charge'), 'charged 的候选里应含 charge')
    assert.ok(lemmaCandidates("model's").includes('model'), "model's 的候选里应含 model")
  })
})

describe('sentenceAround：句界截取', () => {
  test('只拿包含目标区间的那一句', () => {
    const sentence = sentenceAround(
      'First sentence here. The charge was dropped. Last one.',
      24,
      30,
    )
    assert.equal(sentence, 'The charge was dropped.')
  })
})

describe('hashText：块指纹', () => {
  test('稳定且能区分变化', () => {
    const a = hashText('same text')
    assert.equal(a, hashText('same text'))
    assert.notEqual(a, hashText('other text'))
  })
})

describe('模块面：bundle 内模块的 install / dispose（不挂 window）', () => {
  test('纯函数是具名导出，不是挂在 window 上的 _internals', () => {
    for (const name of [
      'tokenize',
      'lemmaCandidates',
      'isPlainWord',
      'matchText',
      'hashText',
      'sentenceAround',
    ]) {
      assert.equal(typeof internals[name], 'function', `internals.${name} 应是函数`)
    }
    assert.equal(typeof internals.CONFIG, 'object')
    assert.equal(typeof internals.BLACKLIST_SEL, 'string')
  })

  test('兼容 API（开关/刷新/统计）与原注入脚本暴露的 API 同形', () => {
    assert.equal(annotate.version, '1.0.0')
    assert.equal(annotate._internals, internals)
    assert.equal(annotate._config, internals.CONFIG)
    for (const name of ['enable', 'disable', 'refresh', 'clear', 'stats', '_mergeConfig']) {
      assert.equal(typeof annotate[name], 'function', `annotate.${name} 应是函数`)
    }
  })

  test('非浏览器环境：install 是纯 no-op，幂等，dispose 可重复调用', () => {
    assert.equal(typeof installAnnotate, 'function')
    const dispose = installAnnotate()
    assert.equal(typeof dispose, 'function', 'installAnnotate() 返回 dispose')
    assert.equal(installAnnotate(), dispose, '重复 install 返回同一个 dispose（幂等）')
    assert.doesNotThrow(() => dispose())
    assert.doesNotThrow(() => dispose(), 'dispose 重复调用不应抛错')
  })

  test('源码不再读写 window 全局（依赖全部走 import）', () => {
    for (const { name, text } of sources()) {
      assert.ok(!/window\.__dwl/.test(text), `${name} 不应出现 window.__dwl* 全局读写`)
    }
  })

  test('模块顶层零副作用：不注册监听 / 不建 observer / 不动 DOM / 不读 document', () => {
    for (const { name, text } of sources()) {
      // 列首（顶格）才是模块顶层语句；函数体/对象体都是缩进的。
      const topLevel = text
        .split('\n')
        .filter((line) => /^[^\s/*]/.test(line) && !line.startsWith('import'))
      for (const line of topLevel) {
        assert.ok(
          !/\bdocument\.|\bwindow\./.test(line),
          `${name} 顶层语句不该碰 document/window：${line.trim()}`,
        )
        assert.ok(
          !/addEventListener|MutationObserver|appendChild|IntersectionObserver/.test(line),
          `${name} 顶层语句不该产生副作用：${line.trim()}`,
        )
      }
    }
  })
})

describe('annotateWordList：在学词表契约（临时 DSH_HOME）', () => {
  test('只取在学、有卡片的词，rev 覆盖内容投影，错误语义不伪装空表', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-annotate-'))
    // store.mjs 在模块加载时读 DSH_HOME，所以必须先设环境变量再动态 import。
    process.env.DSH_HOME = tmp
    const storeUrl = pathToFileURL(path.join(ROOT, 'lib', 'host', 'store.js')).href
    const annotateUrl = pathToFileURL(path.join(ROOT, 'lib', 'host', 'annotate.js')).href
    const { Store } = await import(storeUrl)
    const { annotateWordList } = await import(annotateUrl)

    const store = new Store()
    try {
      assert.ok(store.open(), '临时用户库能打开')
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
      assert.deepEqual(
        out.words.map((x) => x.w),
        ['charge'],
        '只返回在学的词（挂起/毕业的词被排除）',
      )
      assert.equal(out.words[0] && out.words[0].t, 'v. 收费；充电', '首义 = translation 第一段')
      assert.equal(out.words[0] && out.words[0].s, 'n. 指控', 's = 最近一条 sense_here')
      assert.equal(
        out.words[0] && out.words[0].c,
        chargeCard,
        'c = 代表卡片 id（receptive 优先，取较小 id）',
      )
      assert.ok(typeof out.rev === 'string' && out.rev.length > 0, 'rev 是非空字符串')
      assert.equal(out.ok, true, '成功响应带 ok:true')
      assert.equal(out.total, 1, 'total = 过滤后的总词数')
      assert.equal(out.truncated, false, 'truncated = false')

      const before = out.rev
      db.prepare('UPDATE cards SET last_review = ? WHERE id = ?').run(now + 9000, chargeCard)
      const after = annotateWordList(store, { limit: 10 })
      assert.notEqual(after.rev, before, '卡片状态变化会改 rev')

      // rev 内容投影：这三类写入以前不改 rev（审查报告 2026-11-04 第 3 节第 1 条）。
      let prevRev = after.rev
      db.prepare('UPDATE words SET translation = ? WHERE id = ?').run(
        'v. 收费；充电；控告',
        chargeId,
      )
      const afterTranslation = annotateWordList(store, { limit: 10 })
      assert.notEqual(afterTranslation.rev, prevRev, '补全/改写 translation 会改 rev')
      prevRev = afterTranslation.rev

      db.prepare('UPDATE words SET seen_count = seen_count + 1 WHERE id = ?').run(chargeId)
      const afterSeen = annotateWordList(store, { limit: 10 })
      assert.notEqual(afterSeen.rev, prevRev, 'seen_count 变化会改 rev')
      prevRev = afterSeen.rev

      db.prepare('UPDATE words SET graduated = 1 WHERE id = ?').run(chargeId)
      const afterGraduated = annotateWordList(store, { limit: 10 })
      assert.notEqual(afterGraduated.rev, prevRev, 'graduated 变化会改 rev')
      assert.equal(afterGraduated.words.length, 0, '毕业的词立刻从词表消失')
      db.prepare('UPDATE words SET graduated = 0 WHERE id = ?').run(chargeId)
      const afterUngraduate = annotateWordList(store, { limit: 10 })
      prevRev = afterUngraduate.rev

      db.prepare('UPDATE cards SET suspended = 1 WHERE id = ?').run(chargeCard)
      const afterSuspended = annotateWordList(store, { limit: 10 })
      assert.notEqual(afterSuspended.rev, prevRev, '卡片 suspended 变化会改 rev')
      // 只挂起 receptive 线时，productive 线还活着，词仍在；代表卡片切换到活着的那张。
      assert.equal(afterSuspended.words.length, 1, '单条线挂起后词仍在（另一条线还在）')
      assert.equal(
        afterSuspended.words[0] && afterSuspended.words[0].c,
        chargeCard + 1,
        '代表卡片切到未挂起的那条',
      )
      db.prepare('UPDATE cards SET suspended = 0 WHERE id = ?').run(chargeCard)

      // limit 语义：缺省 2000；负数/0 夹到 1；Infinity 夹到 5000；NaN 走缺省。
      assert.equal(annotateWordList(store, { limit: 0 }).words.length, 1, 'limit=0 夹到 1')
      assert.equal(annotateWordList(store, { limit: -5 }).words.length, 1, 'limit=-5 夹到 1')
      assert.equal(
        annotateWordList(store, { limit: Infinity }).ok,
        true,
        'limit=Infinity 不抛且返回成功',
      )
      assert.equal(annotateWordList(store, { limit: 'abc' }).ok, true, 'limit=NaN 走缺省且成功')

      // 最近加入优先 + total/truncated：再塞三个"在学"词（created_at 相同 → 按 id DESC）。
      for (const name of ['alpha', 'beta', 'gamma']) {
        const id = addWord(name, 'n. ' + name, {})
        addCard(id, 'receptive', {})
      }
      const limited = annotateWordList(store, { limit: 2 })
      assert.deepEqual(
        limited.words.map((x) => x.w),
        ['gamma', 'beta'],
        'limit 生效且最近加入优先',
      )
      assert.equal(limited.total, 4, 'total 不受 limit 影响')
      assert.equal(limited.truncated, true, 'truncated = true')
      assert.equal(
        annotateWordList(store, { limit: 2.9 }).words.length,
        2,
        'limit=2.9 向下取整为 2',
      )

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
      assert.equal(broken.ok, false, '查询失败返回 ok:false')
      assert.ok(typeof broken.error === 'string' && broken.error.length > 0, '查询失败带 error')
      assert.equal(Array.isArray(broken.words), false, '查询失败不带 words（前端据此保留旧标注）')
      assert.equal(annotateWordList(null).ok, false, '没有 store 也返回 ok:false')
    } finally {
      store.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- DOM 冒烟（jsdom）
//
// 旧注入脚本没有卸载路径（只有 enable/disable 两个开关），install/dispose 是阶段 2
// 新增的契约，必须有会红的回归：装上后真的标注、排除范围在真实 DOM 里生效、dispose
// 真的拆干净、卸载后 mutation 不再标注、卸载后还能再次安装。
//
// 这里只是冒烟：真实浏览器上的全量排除/流式/折叠/限额断言仍在
// scripts/test-annotate.mjs --browser（node --test 跑不了 bsk）。jsdom 没有
// IntersectionObserver，模块会自动退到 rect 兜底（正是后台标签页那条路径），
// 所以断言结果与浏览器一致。
describe('DOM 冒烟（jsdom）：install 装上、dispose 拆干净', () => {
  test('首次扫描 / 排除范围 / 开关 / 卸载 / 重装走一遍', async () => {
    const require = createRequire(import.meta.url)
    const { JSDOM } = require('jsdom')
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <div data-chat-flow>
          <div id="streaming-block" data-chat-node-key="k1" data-chat-flow-kind="assistant-step" data-streaming>
            <div data-slot="conversation.chat.node"><p>charge model streaming</p></div>
          </div>
          <div data-chat-node-key="k2" data-chat-flow-kind="assistant-step">
            <div data-slot="conversation.chat.node">
              <p id="body-para">The charge model is stable.</p>
              <pre id="pre">charge model</pre>
            </div>
          </div>
        </div>
        <aside><p>charge model outside</p></aside>
      </body></html>`,
      { url: 'http://localhost/', pretendToBeVisual: true },
    )
    const win = dom.window
    const doc = win.document

    // 模块在调用期读 window/document（import 期零顶层副作用），所以这里替换全局即可。
    const savedGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      NodeFilter: globalThis.NodeFilter,
      MutationObserver: globalThis.MutationObserver,
    }
    globalThis.window = win
    globalThis.document = doc
    globalThis.NodeFilter = win.NodeFilter
    globalThis.MutationObserver = win.MutationObserver

    // 词表接口 stub（不联网）：只返回两个"在学"词。
    win.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        words: [
          { w: 'charge', t: 'v. 收费', s: '', c: 1 },
          { w: 'model', t: 'n. 模型', s: '', c: 2 },
        ],
        rev: 'rev-1',
        total: 2,
        truncated: false,
      }),
    })
    // jsdom 没有布局：给块一个可视尺寸，走 inViewport 兜底而不是 IntersectionObserver。
    win.Element.prototype.getBoundingClientRect = () => ({
      width: 400,
      height: 20,
      top: 10,
      bottom: 30,
      left: 0,
      right: 400,
    })

    // 缩短稳定窗/防抖：不用等真实 800/250ms。
    const savedMs = { STABLE_MS: CONFIG.STABLE_MS, DEBOUNCE_MS: CONFIG.DEBOUNCE_MS }
    CONFIG.STABLE_MS = 0
    CONFIG.DEBOUNCE_MS = 0

    const spans = () => doc.querySelectorAll('.dwl-anno')
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    async function waitFor(predicate, message) {
      const started = Date.now()
      while (Date.now() - started < 2000) {
        if (predicate()) return
        await sleep(15)
      }
      assert.fail(message + '（2000ms 内未满足）')
    }

    let dispose = null
    try {
      dispose = installAnnotate()

      // 1) 首次扫描：正常段落标出两个词；代码块/流式块/对话正文外零标注。
      await waitFor(() => spans().length === 2, '首次扫描应标出 charge/model')
      assert.deepEqual(
        [...spans()].map((s) => s.getAttribute('data-w')),
        ['charge', 'model'],
      )
      assert.ok(doc.getElementById('dwl-anno-style'), '装好后应插入样式表')
      assert.equal(doc.querySelectorAll('#pre .dwl-anno').length, 0, '代码块里零标注')
      assert.equal(doc.getElementById('pre').textContent, 'charge model', '原文一个字不改')
      assert.equal(
        doc.querySelector('#streaming-block').querySelectorAll('.dwl-anno').length,
        0,
        '流式块零标注',
      )
      assert.equal(
        doc.querySelector('aside').querySelectorAll('.dwl-anno').length,
        0,
        '正文外零标注',
      )
      assert.equal(installAnnotate(), dispose, '重复 install 返回同一个 dispose（幂等）')

      // 2) 悬停卡：悬停后出现，dispose 时应一起拆掉。
      spans()[0].dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }))
      await waitFor(() => doc.querySelector('.dwlac') !== null, '悬停后应出现小卡')

      // 3) 宿主开关事件 detail.enabled=false/true。
      win.dispatchEvent(new win.CustomEvent('dwl-annotate:toggle', { detail: { enabled: false } }))
      assert.equal(spans().length, 0, 'toggle 关闭后零 span')
      assert.equal(win.localStorage.getItem('dwl-annotate'), 'off', '关闭写 localStorage=off')
      assert.equal(annotate.stats().running, false, '关闭后 running=false')
      assert.equal(doc.querySelector('.dwlac'), null, '关闭后小卡也拆掉')
      win.dispatchEvent(new win.CustomEvent('dwl-annotate:toggle', { detail: { enabled: true } }))
      await waitFor(() => spans().length === 2, 'toggle 重新打开后恢复标注')

      // 4) 显式 disable / enable（原浏览器 e2e 的开关断言）。
      annotate.disable()
      assert.equal(spans().length, 0, 'disable 后零 span')
      annotate.enable()
      await waitFor(() => spans().length === 2, 'enable 后恢复标注')

      // 5) dispose：span / 样式 / 小卡全拆；卸载后 mutation 不再标注。
      dispose()
      assert.equal(spans().length, 0, 'dispose 拆掉已插入的 span')
      assert.equal(doc.getElementById('dwl-anno-style'), null, 'dispose 移除样式表')
      assert.equal(doc.querySelector('.dwlac'), null, 'dispose 移除悬停卡')
      assert.equal(annotate.stats().running, false, 'dispose 后 running=false')
      doc.getElementById('body-para').textContent = 'charge model again'
      await sleep(100)
      assert.equal(spans().length, 0, '卸载后新的 mutation 不再标注')

      // 6) 卸载后可再次安装（拿到新的 dispose），并同样拆干净。
      const disposeAgain = installAnnotate()
      assert.notEqual(disposeAgain, dispose, '重新 install 返回新的 dispose')
      await waitFor(() => spans().length === 2, '重新安装后恢复标注')
      disposeAgain()
      assert.equal(spans().length, 0, '第二次 dispose 同样拆干净')
    } finally {
      if (dispose) dispose()
      CONFIG.STABLE_MS = savedMs.STABLE_MS
      CONFIG.DEBOUNCE_MS = savedMs.DEBOUNCE_MS
      for (const [key, value] of Object.entries(savedGlobals)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
      // 关掉 jsdom 窗口，别把它的 rAF/定时器留给后面的测试。
      win.close()
    }
  })
})
