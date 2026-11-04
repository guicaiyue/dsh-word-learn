// 设置页「AI 分析模型」的渲染测试。
//
// 不装 React、不开浏览器：从 assets/dashboard.js 里**原样切出** SettingsView
// 的函数体，用一套最小 hooks 运行时渲染它，再对渲染出的元素树做断言。
// 为什么要这么测：宿主重启前看不到真页面，而这段 JSX 一旦写错
// （select 的 value 对不上、空态分支漏了）只有打开设置页才会炸。

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const SRC = path.join(import.meta.dirname, '..', 'assets', 'dashboard.js')
const text = fs.readFileSync(SRC, 'utf8')

// ── 1. 从真实源码里切出 SettingsView（按花括号配平，不靠复制粘贴）
const START = '    function SettingsView({ api }) {'
const start = text.indexOf(START)
assert.ok(start >= 0, 'dashboard.js 里找不到 SettingsView')
let depth = 0
let end = -1
// 从函数体的 `{` 开始配平：START 里最后一个 `{` 才是函数体，
// 前面的 `({ api })` 是参数解构，拿它当入口会在参数括号闭合时就结束。
for (let i = start + START.lastIndexOf('{'); i < text.length; i++) {
  if (text[i] === '{') depth++
  else if (text[i] === '}') {
    depth--
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}
assert.ok(end > start, 'SettingsView 花括号没有闭合')
const source = text.slice(start, end)
assert.ok(source.includes('catalog && catalog.lostSelection'), '切出来的不是新的设置页代码')

// ── 2. 最小 hooks 运行时：够跑 useState / useEffect / useCallback / useMemo
const h = (type, props, ...children) => ({
  type,
  props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
})

let current = null
function useState(init) {
  const box = current
  const i = box.i++
  if (!(i in box.states)) box.states[i] = typeof init === 'function' ? init() : init
  const set = (v) => {
    box.states[i] = typeof v === 'function' ? v(box.states[i]) : v
    box.dirty = true
  }
  return [box.states[i], set]
}
function useEffect(fn) {
  current.effects.push(fn)
}
function useCallback(fn) {
  return fn
}
function useMemo(fn) {
  return fn()
}

const factory = new Function(
  'h',
  'useState',
  'useEffect',
  'useCallback',
  'useMemo',
  'loadAccent',
  'saveAccent',
  'loadAutoSpeak',
  'saveAutoSpeak',
  source + '\nreturn SettingsView',
)
const SettingsView = factory(
  h,
  useState,
  useEffect,
  useCallback,
  useMemo,
  () => 'us',
  () => {},
  () => true,
  () => {},
)

// ── 3. 渲染驱动：跑完 effect 里的 fetch，state 变了就重渲，直到稳定
async function render(api) {
  const box = { i: 0, states: [], effects: [], dirty: false }
  const prev = current
  current = box
  let tree = SettingsView({ api })

  // 注意：不能在这里调用 effect 返回的 cleanup —— 那个 cleanup 会把
  // `alive` 置 false，effect 里 fetch 的回调就再也不会 setState，
  // 组件会永远停在"读取中"。
  for (let round = 0; round < 5; round++) {
    const effects = box.effects
    box.effects = []
    for (const fn of effects) fn()
    await new Promise((r) => setTimeout(r, 0))
    if (!box.dirty) break
    box.dirty = false
    box.i = 0
    current = box
    tree = SettingsView({ api })
  }
  current = prev
  return tree
}

// ── 4. 在元素树里找东西
function walk(node, visit) {
  if (node == null || node === false) return
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit))
    return
  }
  if (typeof node !== 'object') {
    visit(node)
    return
  }
  visit(node)
  walk(node.props && node.props.children, visit)
}

function findAll(tree, pred) {
  const out = []
  walk(tree, (n) => {
    if (n && typeof n === 'object' && pred(n)) out.push(n)
  })
  return out
}

function textOf(node) {
  let s = ''
  walk(node, (n) => {
    if (typeof n === 'string' || typeof n === 'number') s += String(n)
  })
  return s
}

const CATALOG = {
  ok: true,
  models: [
    {
      provider: 'deepseek-official',
      providerName: 'DeepSeek 官方',
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
    },
    {
      provider: 'deepseek-official',
      providerName: 'DeepSeek 官方',
      id: 'deepseek-v4',
      name: 'DeepSeek V4',
    },
    { provider: 'other', providerName: '别家', id: 'other-large', name: 'Other Large' },
  ],
  selection: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    providerName: 'DeepSeek 官方',
    source: 'default',
  },
  defaultSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  lostSelection: null,
}

// ── 5. 默认态：下拉选中第一个，说明里写清"默认：列表第一个"
let calls = []
let tree = await render(async (p, opt) => {
  calls.push({ p, opt })
  return CATALOG
})
let select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dwl-model-select')
assert.equal(select.length, 1, '应渲染出模型下拉框')
assert.equal(select[0].props.value, '0', '默认应选中列表第一个（下标 0）')

const options = findAll(select[0], (n) => n.type === 'option')
assert.equal(options.length, 3, '三个模型应有三个 option')
assert.equal(textOf(options[0]), 'DeepSeek V4 Flash（deepseek-v4-flash）')
const groups = findAll(tree, (n) => n.type === 'optgroup')
assert.equal(groups.length, 2, '应按 provider 分成两个 optgroup')
assert.match(textOf(tree), /当前生效：DeepSeek 官方 · DeepSeek V4 Flash（默认：列表第一个）/)
assert.equal(findAll(tree, (n) => n.type === 'button' && textOf(n).includes('恢复默认')).length, 0)
// 自动发音开关：默认开，且关掉后说明文字会变
const autoInput = findAll(tree, (n) => n.type === 'input' && n.props.id === 'dwl-auto-speak')
assert.equal(autoInput.length, 1, '应有"自动发音"开关')
assert.equal(autoInput[0].props.type, 'checkbox', '开关是 checkbox')
assert.equal(autoInput[0].props.checked, true, '默认开启自动发音')
assert.match(textOf(tree), /自动发音/)
assert.match(textOf(tree), /都会自动读一遍/)
console.log('✓ 默认态：下拉选中第一个，标注"默认：列表第一个"，没有恢复按钮；自动发音默认开')

// ── 6. 自选态：选中自定义模型，出现"恢复默认"
const custom = {
  ...CATALOG,
  selection: {
    provider: 'other',
    model: 'other-large',
    name: 'Other Large',
    providerName: '别家',
    source: 'custom',
  },
}
tree = await render(async () => custom)
select = findAll(tree, (n) => n.props.id === 'dwl-model-select')[0]
assert.equal(select.props.value, '2', '自选第三个模型时下拉应指向下标 2')
assert.match(textOf(tree), /当前生效：别家 · Other Large/)
assert.equal(findAll(tree, (n) => n.type === 'button' && textOf(n).includes('恢复默认')).length, 1)
console.log('✓ 自选态：下拉指向自选模型，出现"恢复默认（第一个）"')

// ── 7. 改选：onChange 发 POST /model，成功后界面跟着变
calls = []
const apiAfter = async (p, opt) => {
  calls.push({ p, opt })
  if (p === '/models') return CATALOG
  if (p === '/model') return { ok: true, selection: { ...CATALOG.models[1], source: 'custom' } }
  throw new Error('意外请求 ' + p)
}
tree = await render(apiAfter)
select = findAll(tree, (n) => n.props.id === 'dwl-model-select')[0]
await select.props.onChange({ target: { value: '1' } })
const post = calls.find((c) => c.p === '/model')
assert.ok(post, '改选应发 POST /model')
assert.deepEqual(
  post.opt.body,
  { provider: 'deepseek-official', model: 'deepseek-v4' },
  'POST 要带 provider/model',
)
console.log('✓ 改选：onChange -> POST /model {provider, model}')

// ── 8. 空目录 / 错误 / 模型丢失三种分支
tree = await render(async () => ({
  ok: true,
  models: [],
  selection: { provider: 'agent', model: 'agent-model', name: 'Agent', source: 'agent' },
}))
assert.match(textOf(tree), /还没有可用的文本模型.*暂时跟随会话默认模型（Agent）/)
assert.equal(
  findAll(tree, (n) => n.type === 'select' && n.props.id === 'dwl-model-select').length,
  0,
)
console.log('✓ 空目录：说明跟随会话默认模型，不渲染空下拉')

tree = await render(async () => ({ ok: false, error: 'DSH 模型服务不可用（ctx.llm 缺失）' }))
assert.match(textOf(tree), /DSH 模型服务不可用/)
console.log('✓ 读取失败：直接显示错误，不白屏')

tree = await render(async () => ({
  ...CATALOG,
  lostSelection: { provider: 'deepseek-official', model: 'retired-model' },
}))
assert.match(textOf(tree), /retired-model 已不在 DSH 模型目录里/)
console.log('✓ 模型丢失：提示旧选择已失效、现按默认第一个')

// ── 9. 加载中
tree = await render(() => new Promise(() => {}))
assert.match(textOf(tree), /读取 DSH 模型列表…/)
console.log('✓ 加载中：显示"读取 DSH 模型列表…"')

console.log('\nUI 分支全部通过')
