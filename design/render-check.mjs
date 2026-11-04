/**
 * 渲染自检 —— 不启动 DSH，也能把 assets/dashboard.js 真实跑一遍。
 *
 * 做法：给一个最小化的 React 替身（h / useState / useEffect / useMemo /
 * useCallback / useRef）+ 假的 ctx，把模块里注册到 `main` slot 的组件取出来，
 * 直接调用它，把返回的元素树序列化成 HTML。
 *
 * 能验到：组件不抛异常、数据形状对得上、文案和结构符合预期、CSS 真的被注入。
 * 验不到：真实的挂载/副作用时序、真实主题令牌的实际色值（下面用近似值代替）。
 *
 * 用法：node design/render-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const outDir = path.join(here, 'render')
fs.mkdirSync(outDir, { recursive: true })

// ── 假 React ────────────────────────────────────────────────────────────
//
// useState 走「按组件名 + hook 序号」的注入表。序号是确定性的：
// 只要组件里 hook 调用顺序不变，第 N 个 useState 就是第 N 个值。
// 这样不用真渲染，就能把 loading / 空 / 完成 / 有数据 这几种状态都摆出来。

const overrides = {}
let curComp = ''
let hookIdx = 0

function flatten(list) {
  const out = []
  for (const c of list) {
    if (Array.isArray(c)) out.push(...flatten(c))
    else out.push(c)
  }
  return out
}

function h(type, props, ...children) {
  return { type, props: props || {}, children: flatten(children) }
}

function useState(init) {
  const table = overrides[curComp] || {}
  const has = Object.prototype.hasOwnProperty.call(table, hookIdx)
  const value = has ? table[hookIdx] : init
  hookIdx += 1
  return [value, () => {}]
}

const React = {
  createElement: h,
  useState,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}

// ── 加载模块 ────────────────────────────────────────────────────────────

const sheet = []
const sandbox = {
  React,
  window: {
    __ModuleLoader__: {
      load(def) {
        sandbox.__def = def
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  document: {
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: {
      appendChild: (tag) => {
        sheet.push(tag.textContent)
      },
    },
  },
  fetch: async () => ({ json: async () => ({ ok: false }) }),
  URLSearchParams,
  console,
  Date,
  Math,
  Number,
  String,
  Array,
  Object,
  JSON,
}

vm.createContext(sandbox)
const src = fs.readFileSync(path.join(pluginRoot, 'assets', 'dashboard.js'), 'utf8')
vm.runInContext(src, sandbox, { filename: 'dashboard.js' })

const def = sandbox.__def
if (!def || typeof def.factory !== 'function') throw new Error('模块没有注册 factory')

const mod = def.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

// ── 跑 apply，抓组件与 CSS ──────────────────────────────────────────────

const slots = {}
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  locale: {
    register: () => () => {},
    bind: () => (k) => k,
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (registration, component) => {
      slots[registration.name] = component
      return () => {}
    },
  },
}

mod.apply(ctx)

const Page = slots.main
if (typeof Page !== 'function') throw new Error('main slot 没有注册组件')
const CSS = sheet.join('\n')
if (!CSS.includes('.dwl-page')) throw new Error('CSS 没有被注入')

// ── 序列化 ──────────────────────────────────────────────────────────────

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c])

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])
const SKIP = new Set(['key', 'children', 'dangerouslySetInnerHTML'])

function styleText(style) {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
    .join(';')
}

function attrs(props) {
  let out = ''
  for (const [k, v] of Object.entries(props)) {
    if (SKIP.has(k) || v === undefined || v === null || v === false || v === true) continue
    if (k === 'style') {
      const s = styleText(v)
      if (s) out += ` style="${esc(s)}"`
      continue
    }
    const name = k === 'className' ? 'class' : k
    out += ` ${name}="${esc(v)}"`
  }
  return out
}

function render(node, out) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(esc(node))
    return
  }
  if (Array.isArray(node)) {
    for (const n of node) render(n, out)
    return
  }
  if (typeof node.type === 'function') {
    const prevComp = curComp
    const prevIdx = hookIdx
    curComp = node.type.name || 'Anon'
    hookIdx = 0
    const inner = node.type(node.props)
    curComp = prevComp
    hookIdx = prevIdx
    render(inner, out)
    return
  }
  const tag = node.type
  out.push('<' + tag + attrs(node.props) + '>')
  if (VOID.has(tag)) return
  if (typeof node.props.textContent === 'string') out.push(esc(node.props.textContent))
  for (const c of node.children) render(c, out)
  out.push('</' + tag + '>')
}

// ── 假数据（字段照 lib/store.mjs 的 dashboard() 与 schedule.mjs 的 dueQueue）──

const now = Date.now()
const DAY = 86400000

const dash = {
  ok: true,
  words: {
    total: 1284,
    graduated: 36,
    starred: 12,
    byTier: [
      { tier: 'top1k', n: 420 },
      { tier: 'top3k', n: 380 },
      { tier: 'top8k', n: 300 },
      { tier: 'rare', n: 150 },
      { tier: 'unknown', n: 34 },
    ],
  },
  cards: { total: 1284, fresh: 642, suspended: 3, learning: 120, review: 480, relearning: 39, started: 642 },
  queue: { dueToday: 37, dueTomorrow: 19, reviewedToday: 12 },
  forecast: Array.from({ length: 14 }, (_, i) => ({ day: i, date: now + i * DAY, count: [19, 24, 11, 6, 3, 8, 14, 21, 9, 4, 2, 7, 12, 5][i] })),
  activity: Array.from({ length: 14 }, (_, i) => ({ day: i - 13, date: now - (13 - i) * DAY, count: [4, 7, 0, 11, 9, 15, 6, 3, 12, 18, 7, 0, 9, 12][i] })),
  ability: {
    recognize: [10, 26, 42, 88, 120, 90],
    meaning: [30, 52, 70, 84, 60, 30],
    write: [120, 90, 58, 26, 10, 4],
    listen: [96, 74, 48, 22, 8, 3],
    pronounce: [70, 86, 60, 34, 14, 5],
  },
  accuracy: { total: 431, correct: 336, rate: 0.78, dist: { 1: 40, 2: 55, 3: 240, 4: 96 } },
  hardest: [
    { word: 'notwithstanding', translation: '尽管，虽然', lapses: 7 },
    { word: 'vicissitude', translation: '（命运的）变迁起伏', lapses: 5 },
    { word: 'penchant', translation: '嗜好，偏好', lapses: 4 },
  ],
  recent: [
    { word: 'ephemeral', translation: '短暂的，转瞬即逝的', seen_at: now - 60000 },
    { word: 'ubiquitous', translation: '无处不在的', seen_at: now - 3600000 },
  ],
  since: now - 23 * DAY,
  dbPath: 'C:/Users/xiaoliyue/.dsh/dsh-word-learn/user.db',
  schedule: { ok: true },
}

const queue = {
  ok: true,
  items: [
    { cardId: 101, word: 'ephemeral', phonetic: 'ɪˈfem.ər.əl', translation: '短暂的，转瞬即逝的\n存在时间极短的事物', track: 'receptive', trackLabel: '认得', isNew: false, overdueDays: 0, reps: 3, lapses: 1 },
    { cardId: 102, word: 'cumbersome', phonetic: 'ˈkʌm.bə.səm', translation: '笨重的，繁琐的', track: 'receptive', trackLabel: '认得', isNew: true, overdueDays: 0, reps: 0, lapses: 0 },
    { cardId: 103, word: 'notwithstanding', phonetic: 'ˌnɒt.wɪθˈstæn.dɪŋ', translation: '尽管，虽然', track: 'productive', trackLabel: '能写', isNew: false, overdueDays: 3, reps: 5, lapses: 2 },
  ],
  total: 3,
}

const vocabItems = [
  ['ephemeral', 'ɪˈfem.ər.əl', '短暂的，转瞬即逝的', 'top3k'],
  ['ubiquitous', 'juːˈbɪk.wɪ.təs', '无处不在的', 'top3k'],
  ['mitigate', 'ˈmɪt.ɪ.ɡeɪt', '减轻，缓和（不良影响）', 'top1k'],
  ['caveat', 'ˈkæv.i.æt', '提醒，限制性条件', 'top8k'],
  ['resilient', 'rɪˈzɪl.i.ənt', '有韧性的，能快速恢复的', 'top3k'],
  ['cumbersome', 'ˈkʌm.bə.səm', '笨重的，繁琐的', 'top8k'],
  ['ambiguous', 'æmˈbɪɡ.ju.əs', '有歧义的，含糊不清的', 'top3k'],
  ['pragmatic', 'præɡˈmæt.ɪk', '务实的，讲求实效的', 'top1k'],
  ['notwithstanding', 'ˌnɒt.wɪθˈstæn.dɪŋ', '尽管，虽然', 'rare'],
  ['intricate', 'ˈɪn.trɪ.kət', '错综复杂的', 'top3k'],
  ['plausible', 'ˈplɔː.zə.bəl', '看似可信的', 'top1k'],
  ['deteriorate', 'dɪˈtɪə.ri.ə.reɪt', '恶化，变坏', 'top8k'],
  ['elucidate', 'ɪˈluː.sɪ.deɪt', '阐明，解释清楚', 'rare'],
  ['tenuous', 'ˈten.ju.əs', '纤细的；站不住脚的', 'top8k'],
  ['meticulous', 'məˈtɪk.jə.ləs', '一丝不苟的', 'top8k'],
  ['nonplussed', 'nɒnˈplʌst', '困惑的，不知所措的', 'rare'],
].map(([word, phonetic, translation, freqTier], i) => ({
  id: i + 1,
  word,
  phonetic,
  translation,
  freqTier,
}))

// ── 三种状态 ────────────────────────────────────────────────────────────

const STATES = {
  study: {
    WordLearnPage: { 0: 'study', 1: dash, 2: queue, 3: false, 4: '', 5: false, 6: 0, 7: false, 8: 0 },
  },
  'study-revealed': {
    WordLearnPage: { 0: 'study', 1: dash, 2: queue, 3: false, 4: '', 5: false, 6: 0, 7: true, 8: 0 },
  },
  vocab: {
    WordLearnPage: { 0: 'vocab', 1: dash, 2: queue, 3: false, 4: '', 5: false, 6: 0, 7: false, 8: 0 },
    VocabView: { 0: '', 1: '', 2: vocabItems, 3: 1284, 4: false, 5: '' },
  },
  stats: {
    WordLearnPage: { 0: 'stats', 1: dash, 2: queue, 3: false, 4: '', 5: false, 6: 0, 7: false, 8: 0 },
  },
  done: {
    WordLearnPage: { 0: 'study', 1: dash, 2: queue, 3: false, 4: '', 5: false, 6: 3, 7: false, 8: 3 },
  },
}

// 主题令牌：这里是近似值（真实值只有宿主知道），只用来验布局与层级
const TOKENS = `
:root{
  --dsw-alias-bg-base:#FAFAF9;
  --dsw-alias-bg-layer-1:#FFFFFF;
  --dsw-alias-bg-skeleton:#EAEAE7;
  --dsw-alias-border-l2:#E3E3DF;
  --dsw-alias-label-primary:#191917;
  --dsw-alias-label-secondary:#5A5A55;
  --dsw-alias-label-tertiary:#8E8E87;
  --dsw-alias-interactive-bg-hover:#F2F2EF;
  --dsw-alias-brand-primary:#0D9488;
  --dsw-alias-state-success-primary:#16A34A;
  --dsw-alias-state-warn-primary:#D97706;
  --dsw-alias-state-error-primary:#DC2626;
  --dsw-alias-state-business-primary:#2563EB;
}
html,body{height:100%;margin:0;background:var(--dsw-alias-bg-base)}
`

for (const [name, table] of Object.entries(STATES)) {
  for (const k of Object.keys(overrides)) delete overrides[k]
  Object.assign(overrides, table)

  const out = []
  render(h(Page, {}), out)
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-word-learn · ${name}</title>
<style>${TOKENS}</style>
<style>${CSS}</style>
</head><body>${out.join('')}</body></html>`

  fs.writeFileSync(path.join(outDir, `${name}.html`), html)

  const text = out
    .join('')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  console.log(`\n=== ${name} ===`)
  console.log(text.slice(0, 420))
}

// ── 断言：几条重构承诺必须真的成立 ──────────────────────────────────────

const studyHtml = fs.readFileSync(path.join(outDir, 'study.html'), 'utf8')

const checks = [
  ['学习视图有 4 个评分按钮', (studyHtml.match(/class="rl"/g) || []).length === 4],
  ['评分按钮带 aria-label', /aria-label="忘了，快捷键 1"/.test(studyHtml)],
  ['释义默认收起（data-on="0"）', /data-on="0"/.test(studyHtml)],
  ['单词用衬线', /class="dwl-word" lang="en"/.test(studyHtml)],
  ['有进度条', /class="dwl-track"/.test(studyHtml)],
  ['不再出现旧的 50 行列表', !/dwl-qrow/.test(studyHtml)],
  ['页面不再有"刷新"按钮', !/>刷新</.test(studyHtml)],
]

let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

console.log(`\n输出目录：${outDir}`)
if (failed) {
  console.error(`${failed} 项断言失败`)
  process.exit(1)
}