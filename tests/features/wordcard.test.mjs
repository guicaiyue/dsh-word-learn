// 测什么：src/client/features/wordcard/**（原注入脚本 assets/wordcard.js +
// wordcard-card.js + wordcard-style.js）—— 安装/卸载生命周期、划词判定、卡片内容。
//
// 迁移来源：这几块原先没有独立单测（只有旧 vm 脚本——已迁入 tests/component/hover-word.test.tsx
// ——那种"整文件加载学习页"的间接覆盖 + 真机复验）。构建化后模块是纯 ESM，能直接 import，于是把
// 「注入顺序 / window 全局 / 真机才看得到」的那部分行为补成可重跑的断言。
//
// 为什么手搓假 DOM 而不用 jsdom：这一层是 node:test（不是 vitest + jsdom 的组件层），
// 且真正要验的是"监听有没有挂/摘、选区落在哪个容器、卡片被喂了什么" —— 全在逻辑面上，
// 不需要排版；假 DOM 还能直接给出 getClientRects 的矩形（jsdom 没有布局，永远是 0×0，
// 卡片根本不会弹）。jsdom 侧的装卸生命周期另见 tests/component/install-dispose.test.ts。
//
// 边界：不联网（fetch 全 stub）、不碰用户库、不起宿主；语音模块由 core.js 的
// voiceModule() 从 window 找（阶段 2 收尾改成 import），这里不依赖它可用。
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 先 import 再建假 DOM：模块顶层零副作用，import 期不该碰 document / window。
// （下面这条断言就是这件事的自证；若 import 期读了 document，本文件根本加载不起来。）
import { installWordcard } from '../../src/client/features/wordcard/index.js'
import CARD from '../../src/client/features/wordcard/card.js'
import { CSS as WORDCARD_CSS } from '../../src/client/features/wordcard/style.js'
import CORE from '../../src/client/features/core.js'

const importedWithoutDom = typeof globalThis.document === 'undefined'

// ============================================================ 假 DOM
//
// 只实现被测代码真正用到的那一小撮 DOM：createElement / innerHTML / querySelector /
// closest / 属性 / 事件登记 / isConnected。够用就好，不追求完整实现。

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])

function makeText(doc, text) {
  return {
    nodeType: 3,
    ownerDocument: doc,
    parentNode: null,
    get parentElement() {
      return null
    },
    get textContent() {
      return text
    },
    set textContent(value) {
      text = String(value)
    },
    get innerText() {
      return text
    },
  }
}

function makeElement(doc, tagName) {
  const el = {
    nodeType: 1,
    ownerDocument: doc,
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    attributes: new Map(),
    listeners: new Map(),
    style: {},
    id: '',
    className: '',
    disabled: false,
    offsetWidth: 0,
    offsetHeight: 0,
    get parentElement() {
      return el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null
    },
    get isConnected() {
      let node = el
      while (node.parentNode) node = node.parentNode
      return node === doc
    },
  }

  el.setAttribute = (name, value) => {
    const v = value === undefined ? '' : String(value)
    el.attributes.set(String(name), v)
    // 真实 DOM 里 class / id 属性与同名 property 是同一个槽；下面按选择器匹配要用。
    if (name === 'class') el.className = v
    if (name === 'id') el.id = v
  }
  el.getAttribute = (name) => (el.attributes.has(name) ? el.attributes.get(name) : null)
  el.hasAttribute = (name) => el.attributes.has(name)
  el.removeAttribute = (name) => el.attributes.delete(name)

  el.appendChild = (child) => {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = el
    el.children.push(child)
    return child
  }
  el.removeChild = (child) => {
    const i = el.children.indexOf(child)
    if (i >= 0) el.children.splice(i, 1)
    child.parentNode = null
    return child
  }
  el.contains = (node) => {
    let cur = node
    while (cur) {
      if (cur === el) return true
      cur = cur.parentNode
    }
    return false
  }

  el.addEventListener = (type, fn) => {
    if (!el.listeners.has(type)) el.listeners.set(type, [])
    el.listeners.get(type).push(fn)
  }
  el.removeEventListener = (type, fn) => {
    const list = el.listeners.get(type) || []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }

  el.closest = (selector) => {
    let cur = el
    while (cur && cur.nodeType === 1) {
      if (matches(cur, selector)) return cur
      cur = cur.parentNode
    }
    return null
  }
  el.querySelector = (selector) => findOne(el, selector)

  Object.defineProperty(el, 'textContent', {
    get() {
      return el.children.map((child) => child.textContent).join('')
    },
    set(value) {
      el.children.slice().forEach((child) => el.removeChild(child))
      if (value !== '') el.appendChild(makeText(doc, String(value)))
    },
  })
  Object.defineProperty(el, 'innerText', {
    get() {
      return el.textContent
    },
  })
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el.children.map(serialize).join('')
    },
    set(value) {
      el.children.slice().forEach((child) => el.removeChild(child))
      const frag = parseHtml(doc, String(value))
      frag.children.slice().forEach((child) => el.appendChild(child))
    },
  })

  return el
}

/**
 * 选择器匹配：支持 `.cls` / `#id` / `[attr]` / `[attr="v"]` / 标签名的**复合**形式
 * （如 `.dwl-cand[data-word="model"]`），逗号分隔取或。不做后代/子代组合。
 */
function matchSimple(el, selector) {
  if (!el || el.nodeType !== 1) return false
  const sel = selector.trim()
  const parts = sel.match(/^[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g)
  if (!parts || parts.join('') !== sel) return false
  return parts.every((part) => {
    if (part[0] === '.') return el.className.split(/\s+/).includes(part.slice(1))
    if (part[0] === '#') return el.id === part.slice(1)
    if (part[0] === '[') {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part)
      if (!m) return false
      if (!el.attributes.has(m[1])) return false
      return m[2] === undefined || el.attributes.get(m[1]) === m[2]
    }
    return el.tagName === part.toUpperCase()
  })
}

function matches(el, selector) {
  return selector.split(',').some((part) => matchSimple(el, part))
}

function findOne(root, selector) {
  for (const child of root.children || []) {
    if (child.nodeType !== 1) continue
    if (matches(child, selector)) return child
    const found = findOne(child, selector)
    if (found) return found
  }
  return null
}

function findAllNodes(root, visit) {
  for (const child of root.children || []) {
    if (visit(child)) return child
    const found = findAllNodes(child, visit)
    if (found) return found
  }
  return null
}

function serialize(node) {
  if (node.nodeType === 3) return node.textContent
  const attrs = Array.from(node.attributes.entries())
    .map(([k, v]) => (v === '' ? ' ' + k : ' ' + k + '="' + v + '"'))
    .join('')
  return (
    '<' +
    node.tagName.toLowerCase() +
    attrs +
    '>' +
    node.innerHTML +
    '</' +
    node.tagName.toLowerCase() +
    '>'
  )
}

/** 只为测试服务的最小 HTML 解析：够 card.js 的 markup 与 render 出来的片段用。 */
function parseHtml(doc, html) {
  const frag = makeElement(doc, '#fragment')
  const stack = [frag]
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(html)) !== null) {
    const [, closing, tag, attrText, selfClose, text] = m
    if (text !== undefined) {
      const trimmed = text.trim()
      if (trimmed) stack[stack.length - 1].appendChild(makeText(doc, trimmed))
      continue
    }
    if (closing) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const el = makeElement(doc, tag)
    const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    let am
    while ((am = attrRe.exec(attrText || '')) !== null) {
      el.setAttribute(am[1], am[2] ?? am[3] ?? am[4] ?? '')
    }
    stack[stack.length - 1].appendChild(el)
    if (!selfClose && !VOID_TAGS.has(tag.toLowerCase())) stack.push(el)
  }
  return frag
}

function makeDocument() {
  const doc = { nodeType: 9, listeners: new Map() }
  doc.createElement = (tag) => makeElement(doc, tag)
  doc.createTextNode = (text) => makeText(doc, text)
  doc.documentElement = makeElement(doc, 'html')
  doc.head = makeElement(doc, 'head')
  doc.body = makeElement(doc, 'body')
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)
  doc.documentElement.parentNode = doc
  doc.getElementById = (id) => findAllNodes(doc.documentElement, (node) => node.id === id)
  doc.addEventListener = (type, fn) => {
    if (!doc.listeners.has(type)) doc.listeners.set(type, [])
    doc.listeners.get(type).push(fn)
  }
  doc.removeEventListener = (type, fn) => {
    const list = doc.listeners.get(type) || []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
  doc.listenerCount = (type) => (doc.listeners.get(type) || []).length
  return doc
}

const doc = makeDocument()
const win = {
  document: doc,
  innerWidth: 1024,
  innerHeight: 768,
  listeners: new Map(),
  getSelection: () => selection,
}
win.addEventListener = (type, fn) => {
  if (!win.listeners.has(type)) win.listeners.set(type, [])
  win.listeners.get(type).push(fn)
}
win.removeEventListener = (type, fn) => {
  const list = win.listeners.get(type) || []
  const i = list.indexOf(fn)
  if (i >= 0) list.splice(i, 1)
}
win.listenerCount = (type) => (win.listeners.get(type) || []).length
doc.defaultView = win

globalThis.window = win
globalThis.document = doc

// ---- 选区 ----
//
// 真 Selection 需要布局；这里直接给一个假 selection，把"选区落在哪个容器"这句
// 事实交给用例命名 —— 这正是 core 的范围规则要判的那句话。
let selection = null
const RECT = { width: 120, height: 16, top: 100, left: 100, bottom: 116, right: 220 }

function makeSelection(target, text) {
  const range = {
    startContainer: target,
    endContainer: target,
    startOffset: 0,
    endOffset: text.length,
    getClientRects: () => [RECT],
    getBoundingClientRect: () => RECT,
  }
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
  }
}

// ---- fetch ----
let fetchCalls = []
let fetchRoute = () => null

globalThis.fetch = (url, opt) => {
  const call = { url: String(url), opt: opt || {} }
  fetchCalls.push(call)
  return Promise.resolve({ json: async () => fetchRoute(call) })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function flush() {
  await tick()
  await tick()
  await tick()
}

/** 防抖 DEBOUNCE_MS = 220，等它过去再断言。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 260))

// ============================================================ 夹具

const LOOKUP_CHARGE = {
  ok: true,
  warnings: ['生词本写入失败（磁盘满）'],
  dict: {
    word: 'charge',
    query: 'charge',
    phonetic: '/tʃɑːdʒ/',
    matchedBy: 'exact',
    frequency: { tier: 'top3k', label: '高频 3000', rank: 1842 },
    collins: 3,
    oxford: true,
    tags: [{ label: '考研' }],
    likelyKnown: false,
    senses: [
      { pos: 'v.', text: '收费；要价' },
      { pos: 'n.', text: '费用' },
    ],
    forms: [{ label: '过去式', value: 'charged' }],
  },
  enrich: {
    examples: [{ pos: 'v.', text: 'They charge ten dollars.' }],
    synonyms: ['bill', 'fee'],
  },
  saved: { starred: false, seenCount: 2 },
}

const SPLIT_CHARGE_MODEL = {
  ok: true,
  text: '费用模型',
  source: 'llm',
  cached: true,
  words: [
    { word: 'charge', found: true, likelyKnown: false, brief: '收费' },
    { word: 'model', found: true, likelyKnown: true, brief: '模型' },
  ],
  best: 'charge',
}

/** 换一份干净页面：一个空 body（body 里只放用例自己造的内容）。 */
function resetPage() {
  doc.body.innerHTML = ''
  selection = null
  fetchCalls = []
  fetchRoute = () => null
}

/** 建一个"对话正文"容器，html 是它内部的内容。 */
function makeFlow(html) {
  const flow = doc.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  flow.innerHTML = html
  doc.body.appendChild(flow)
  return flow
}

function fireDoc(type, event) {
  const list = (doc.listeners.get(type) || []).slice()
  list.forEach((fn) => fn(event))
}

function fireWin(type, event) {
  const list = (win.listeners.get(type) || []).slice()
  list.forEach((fn) => fn(event))
}

const card = () => doc.body.querySelector('.dwl-card')
const styleTag = () => doc.getElementById('dwl-style')

/** install → 断言 → 一定 dispose（避免用例之间互相污染）。 */
async function withCard(fn) {
  const dispose = installWordcard()
  try {
    return await fn(dispose)
  } finally {
    dispose()
    dispose() // 重复 dispose 必须是 no-op（原生实现里很容易在这里抛）
  }
}

// ============================================================ 用例：模块形状

test('模块顶层零副作用：没有 window/document 时也能 import', () => {
  assert.equal(importedWithoutDom, true, 'import 期不该读 document')
})

test('导出面：installWordcard / card 的五个函数 / CSS 常量', () => {
  assert.equal(typeof installWordcard, 'function')
  for (const name of ['mount', 'render', 'place', 'isDark', 'escapeHtml']) {
    assert.equal(typeof CARD[name], 'function', name + ' 不是函数')
  }
  assert.ok(WORDCARD_CSS.length > 4000, 'CSS 常量太短，像是没搬进来')
  assert.match(WORDCARD_CSS, /^\.dwl-card\{/)
  assert.ok(WORDCARD_CSS.includes('.dwlk-skel'), 'CSS 应包含骨架屏样式')
  assert.equal(CARD.escapeHtml('<b>"x"&</b>'), '&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;')
  assert.equal(CARD.isDark(), false, '假 DOM 是浅色')
})

// ============================================================ 用例：安装 / 卸载

test('install：注入样式 + 把卡片挂到 body + 挂上监听', async () => {
  resetPage()
  const dispose = installWordcard()
  try {
    assert.equal(typeof dispose, 'function', 'installWordcard 必须返回 dispose')

    const style = styleTag()
    assert.ok(style, '应注入 <style id="dwl-style">')
    assert.equal(style.textContent, WORDCARD_CSS, '样式内容必须是 style.js 的 CSS 常量')

    const el = card()
    assert.ok(el, '卡片应挂到 body 上')
    assert.equal(el.getAttribute('role'), 'dialog')
    assert.equal(el.getAttribute('aria-label'), '单词学习卡')
    assert.equal(el.style.display, 'none', '卡片初始应隐藏')

    // 卡片内部四件套 + 口音按钮（口音取自 localStorage，缺省是美音）
    assert.ok(el.querySelector('.dwlk-word'), '应有词头容器')
    assert.ok(el.querySelector('.dwl-tiers'), '应有分级 chips 容器')
    assert.ok(el.querySelector('.dwlk-body'), '应有正文容器')
    assert.ok(el.querySelector('.dwl-foot'), '应有底栏')
    assert.equal(el.querySelector('[data-act="accent"]').textContent, 'US')

    // 监听：document 上四个 + window 上两个
    assert.equal(doc.listenerCount('mouseup'), 1)
    assert.equal(doc.listenerCount('keyup'), 1)
    assert.equal(doc.listenerCount('mousedown'), 1)
    assert.equal(doc.listenerCount('keydown'), 1)
    assert.equal(win.listenerCount('scroll'), 1)
    assert.equal(win.listenerCount('resize'), 1)
  } finally {
    dispose()
  }
})

test('install 幂等：第二次不叠监听/样式/DOM，并返回同一个 dispose', async () => {
  resetPage()
  const first = installWordcard()
  try {
    const second = installWordcard()
    const third = installWordcard()
    assert.equal(second, first, '重复 install 应返回同一个 dispose')
    assert.equal(third, first)
    assert.equal(doc.listenerCount('mouseup'), 1, '监听不该翻倍')
    assert.equal(doc.listenerCount('keydown'), 1)
    assert.equal(doc.listenerCount('mousedown'), 1)
    assert.equal(doc.listenerCount('keyup'), 1)
    assert.equal(win.listenerCount('scroll'), 1)
    assert.equal(win.listenerCount('resize'), 1)
    assert.equal(doc.documentElement.children.length, 2, 'html 只该有 head + body')
    let styleCount = 0
    let cardCount = 0
    doc.body.children.forEach((child) => {
      if (child.className === 'dwl-card') cardCount += 1
    })
    doc.head.children.forEach((child) => {
      if (child.id === 'dwl-style') styleCount += 1
    })
    assert.equal(styleCount, 1, '样式只该有一份')
    assert.equal(cardCount, 1, '卡片只该有一份')
  } finally {
    first()
  }
})

test('dispose：摘监听 / 摘样式 / 摘卡片，之后再划词不再响应', async () => {
  resetPage()
  const flow = makeFlow('<p>the charge model</p>')
  fetchRoute = () => LOOKUP_CHARGE
  const dispose = installWordcard()
  dispose()

  assert.equal(doc.listenerCount('mouseup'), 0, 'document 监听应摘干净')
  assert.equal(doc.listenerCount('keyup'), 0)
  assert.equal(doc.listenerCount('mousedown'), 0)
  assert.equal(doc.listenerCount('keydown'), 0)
  assert.equal(win.listenerCount('scroll'), 0, 'window 监听应摘干净')
  assert.equal(win.listenerCount('resize'), 0)
  assert.equal(styleTag(), null, '样式节点应摘掉')
  assert.equal(card(), null, '卡片 DOM 应摘掉')

  // 卸载后再划词：没有监听，不该再建卡，也不该发请求。
  selection = makeSelection(flow.children[0], 'charge')
  fireDoc('mouseup', { target: flow })
  await settle()
  await flush()
  assert.equal(card(), null, '卸载后不该再建卡')
  assert.equal(fetchCalls.length, 0, '卸载后不该再发请求')
})

test('dispose 幂等：调两次不抛错；卸载后还能重新 install', async () => {
  resetPage()
  const dispose = installWordcard()
  dispose()
  dispose()
  assert.equal(card(), null)

  const again = installWordcard()
  assert.ok(card(), '重新 install 应重新建卡')
  assert.equal(doc.listenerCount('mouseup'), 1)
  again()
  assert.equal(doc.listenerCount('mouseup'), 0)
})

// ============================================================ 用例：划词判定

test('划词：对话正文里选中单词 → 弹卡 + 发查词请求 + 卡片内容字段齐全', async () => {
  resetPage()
  assert.equal(CORE.SCOPE_SELECTOR, '[data-chat-flow]', '范围规则来自 core 的单一来源')
  const flow = makeFlow('<p>the charge model explains billing</p>')
  const para = flow.children[0]
  fetchRoute = () => LOOKUP_CHARGE
  await withCard(async () => {
    selection = makeSelection(para, 'charge')
    fireDoc('mouseup', { target: para })
    await settle()
    await flush()

    // 一次查词请求：单词 + 原句（原句靠 Range 规划，假 DOM 里退回选中文本本身）
    assert.equal(fetchCalls.length, 1, '应只发一次请求，实际 ' + fetchCalls.length)
    assert.match(fetchCalls[0].url, /\/dsh-word-learn\/lookup\?word=charge/)
    assert.equal(fetchCalls[0].opt.credentials, 'same-origin')

    const el = card()
    assert.ok(el, '卡片应已建好')
    assert.equal(el.style.display, 'block', '卡片应显示')
    assert.equal(el.style.top, '124px', '卡片应定位到选区下方（rect.bottom + 8）')
    assert.equal(el.style.left, '100px')

    // ---- 卡片内容字段
    const textOf = (selector) => el.querySelector(selector).textContent
    assert.match(textOf('.dwlk-word'), /charge/, '词头应有原词')
    assert.match(textOf('.dwlk-word'), /tʃɑːdʒ/, '词头应有音标（去掉两边的斜杠）')
    assert.match(textOf('.dwl-tiers'), /高频 3000/, '应有词频档位 chip')
    assert.match(textOf('.dwl-tiers'), /柯林斯 3 星/)
    assert.match(textOf('.dwl-tiers'), /牛津核心/)
    assert.match(textOf('.dwl-tiers'), /考研/, '应有考试标签 chip')
    assert.match(textOf('.dwl-hint'), /第 2 次遇见/, '已记录次数应出现在提示里')
    assert.match(textOf('.dwlk-body'), /收费；要价/, '正文应有释义')
    assert.match(textOf('.dwlk-body'), /词形变化/, '正文应有词形变化块')
    assert.match(textOf('.dwlk-body'), /charged/)
    assert.match(textOf('.dwlk-body'), /例句/)
    assert.match(textOf('.dwlk-body'), /They charge ten dollars\./)
    assert.match(textOf('.dwlk-body'), /近义词/)
    assert.match(textOf('.dwlk-body'), /bill/)
    assert.match(textOf('.dwl-foot'), /词频 #1842/, '底栏应有词频排名')
    assert.match(textOf('.dwl-foot'), /生词本写入失败（磁盘满）/, '服务端 warnings 必须让用户看见')
    assert.match(textOf('.dwl-foot'), /Esc 关闭/)

    // 卡片自带的事件挂在卡片上（不是 document 上），按钮也在
    assert.equal((el.listeners.get('click') || []).length, 1, '卡片上应有 click 监听')
    assert.equal((el.listeners.get('keydown') || []).length, 1, '卡片上应有 keydown 监听')
    assert.ok(el.querySelector('[data-act="sound"]'), '应有朗读按钮')
    assert.ok(el.querySelector('[data-act="close"]'), '应有关闭按钮')
    assert.ok(el.querySelector('[data-act="star"]'), '应有收藏按钮')
  })
})

test('范围规则：选区不在 [data-chat-flow] 里 → 不弹卡、不请求', async () => {
  resetPage()
  const outside = doc.createElement('p')
  outside.textContent = 'the charge model'
  doc.body.appendChild(outside)
  fetchRoute = () => LOOKUP_CHARGE
  await withCard(async () => {
    selection = makeSelection(outside, 'charge')
    fireDoc('mouseup', { target: outside })
    await settle()
    await flush()
    assert.equal(card().style.display, 'none', '范围外不该弹卡')
    assert.equal(fetchCalls.length, 0, '范围外不该发请求')
  })
})

test('范围规则：选区落在代码块/输入框里 → 不弹卡（core 的排除范围）', async () => {
  resetPage()
  const flow = makeFlow('<pre><code>charge</code></pre><textarea></textarea>')
  const code = flow.children[0].children[0]
  const textarea = flow.children[1]
  fetchRoute = () => LOOKUP_CHARGE
  await withCard(async () => {
    selection = makeSelection(code, 'charge')
    fireDoc('mouseup', { target: code })
    await settle()
    await flush()
    assert.equal(card().style.display, 'none', '代码块里选中不该弹卡')
    assert.equal(fetchCalls.length, 0)

    selection = makeSelection(textarea, 'charge')
    fireDoc('mouseup', { target: textarea })
    await settle()
    await flush()
    assert.equal(card().style.display, 'none', '输入框里选中不该弹卡')
    assert.equal(fetchCalls.length, 0)
  })
})

test('键盘选词：Ctrl+A / Shift 触发判定，纯字母键不触发', async () => {
  resetPage()
  const flow = makeFlow('<p>the billing model</p>')
  const para = flow.children[0]
  fetchRoute = () => ({ ...LOOKUP_CHARGE, dict: { ...LOOKUP_CHARGE.dict, word: 'billing' } })
  await withCard(async () => {
    selection = makeSelection(para, 'billing')
    fireDoc('keyup', { key: 'a', ctrlKey: true, shiftKey: false })
    await settle()
    await flush()
    assert.equal(fetchCalls.length, 1, 'Ctrl+A 应触发判定')

    // 普通按键不该重新算：先把卡片收起，再按一个普通键
    fireDoc('mousedown', { target: doc.body })
    assert.equal(card().style.display, 'none', '点别处应收起卡片')
    fireDoc('keyup', { key: 'x', ctrlKey: false, shiftKey: false })
    await settle()
    await flush()
    assert.equal(card().style.display, 'none', '普通按键不该弹卡')
    assert.equal(fetchCalls.length, 1)
  })
})

test('Esc 关闭卡片；滚动/缩放收起卡片', async () => {
  resetPage()
  const flow = makeFlow('<p>the charge model</p>')
  const para = flow.children[0]
  fetchRoute = () => LOOKUP_CHARGE
  await withCard(async () => {
    selection = makeSelection(para, 'charge')
    fireDoc('mouseup', { target: para })
    await settle()
    await flush()
    assert.equal(card().style.display, 'block')

    fireDoc('keydown', { key: 'Escape' })
    assert.equal(card().style.display, 'none', 'Esc 应关闭卡片')

    fireDoc('mouseup', { target: para })
    await settle()
    await flush()
    assert.equal(card().style.display, 'block')
    fireWin('scroll', { target: doc.body })
    assert.equal(card().style.display, 'none', '滚动应收起卡片')

    fireDoc('mouseup', { target: para })
    await settle()
    await flush()
    fireWin('resize', {})
    assert.equal(card().style.display, 'none', '缩放应收起卡片')
  })
})

// ============================================================ 用例：短语场景 / 交互

test('短语：一次划一段话 → 先出译文 + 候选词，点候选词再查该词', async () => {
  resetPage()
  const flow = makeFlow('<p>charge model</p>')
  const para = flow.children[0]
  const LOOKUP_MODEL = {
    ok: true,
    dict: {
      word: 'model',
      query: 'model',
      phonetic: '/ˈmɒdl/',
      matchedBy: 'exact',
      frequency: { tier: 'top3k', label: '高频 3000', rank: 921 },
      senses: [{ pos: 'n.', text: '模型' }],
    },
    saved: { starred: false, seenCount: 1 },
  }
  fetchRoute = (call) => {
    if (call.url.indexOf('/save') >= 0) return SPLIT_CHARGE_MODEL
    if (call.url.indexOf('/translate') >= 0) return SPLIT_CHARGE_MODEL
    if (/word=model/.test(call.url)) return LOOKUP_MODEL
    return LOOKUP_CHARGE
  }
  await withCard(async () => {
    selection = makeSelection(para, 'charge model')
    fireDoc('mouseup', { target: para })
    await settle()
    await flush()

    const urls = fetchCalls.map((call) => call.url)
    assert.ok(
      urls.some((u) => u.indexOf('/dsh-word-learn/save') >= 0),
      '短语应发拆词请求',
    )
    assert.ok(
      urls.some((u) => u.indexOf('/dsh-word-learn/translate') >= 0),
      '短语应同时发译文请求',
    )

    const el = card()
    // 词头区（选一个词 + 候选数量）+ 正文（译文 + 候选列表）
    assert.match(el.querySelector('.dwlk-word').textContent, /选一个词/)
    assert.match(el.querySelector('.dwlk-word').textContent, /共 2 个候选/)
    const body = el.querySelector('.dwlk-body')
    assert.match(body.textContent, /费用模型/, '应显示译文')
    assert.match(body.textContent, /charge/)
    assert.equal(el.querySelector('.dwl-tr-src').textContent, 'DSH 模型', '译文来源应翻译成人话')

    // 点候选词 → 查该词的词典数据（这条走的是卡片上的 click 监听）
    const cand = body.querySelector('.dwl-cand[data-word="model"]')
    assert.ok(cand, '应有候选词 model')
    const clickListener = (el.listeners.get('click') || [])[0]
    clickListener({ target: cand })
    await flush()
    assert.ok(
      fetchCalls.some((call) => /lookup\?word=model/.test(call.url)),
      '点候选词应查该词，实际请求：' + fetchCalls.map((c) => c.url).join(' , '),
    )
    assert.match(card().querySelector('.dwlk-word').textContent, /model/, '词典数据回来后应重绘')
    assert.match(card().querySelector('.dwlk-body').textContent, /模型/)
  })
})

test('点关闭按钮收起卡片；点卡片内部不收起', async () => {
  resetPage()
  const flow = makeFlow('<p>the charge model</p>')
  const para = flow.children[0]
  fetchRoute = () => LOOKUP_CHARGE
  await withCard(async () => {
    selection = makeSelection(para, 'charge')
    fireDoc('mouseup', { target: para })
    await settle()
    await flush()

    const el = card()
    const closeBtn = el.querySelector('[data-act="close"]')
    const clickListener = (el.listeners.get('click') || [])[0]
    clickListener({ target: closeBtn })
    assert.equal(el.style.display, 'none', '点关闭应收起')

    // 卡片内部的 mousedown 不该被当成"点别处"
    fireDoc('mouseup', { target: para })
    await settle()
    await flush()
    assert.equal(el.style.display, 'block')
    fireDoc('mousedown', { target: el.querySelector('.dwlk-body') })
    assert.equal(el.style.display, 'block', '点卡片内部不该收起')
    fireDoc('mousedown', { target: doc.body })
    assert.equal(el.style.display, 'none', '点卡片外部应收起')
  })
})
