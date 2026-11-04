// "写得出"练习（看中文拼英文）的单测。
//
// 不装 React、不开浏览器：从 assets/dashboard.js 里原样切出
// normalizeSpelling / editDistance / spellCheck / WritePanel，
// 用一套最小 hooks 运行时把面板渲染出来，再对元素树做断言。
//
// 为什么测这个：拼写比对一旦放宽过头（把 latent 判成 patent 对），
// 或者面板在提交前就把答案漏出来，只有真用起来才发现。

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const SRC = path.join(import.meta.dirname, '..', 'assets', 'dashboard.js')
const text = fs.readFileSync(SRC, 'utf8')

// ── 1. 按花括号配平，从真实源码里切出函数
//
// marker 必须以函数体的 `{` 结尾：WritePanel 的参数是解构（`({ item, ... })`），
// 从第一个 `{` 开始配平会在参数括号闭合时就结束，切出来只有半个函数签名。
function cut(marker) {
  assert.ok(marker.endsWith('{'), `marker 要以 { 结尾：${marker}`)
  const start = text.indexOf(marker)
  assert.ok(start >= 0, `dashboard.js 里找不到 ${marker}`)
  let depth = 0
  let end = -1
  for (let i = start + marker.length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  assert.ok(end > start, `${marker} 花括号没闭合`)
  return text.slice(start, end)
}

const logicSrc = [
  cut('function normalizeSpelling(s) {'),
  cut('function editDistance(a, b) {'),
  cut('function spellCheck(input, word) {'),
].join('\n')

const logic = new Function(logicSrc + '\nreturn { normalizeSpelling, editDistance, spellCheck }')()
const { normalizeSpelling, editDistance, spellCheck } = logic

// ── 2. 拼写比对
const cases = [
  ['daemon', 'daemon', 'exact'],
  ['  Daemon. ', 'daemon', 'exact'],
  ['DAEMON', 'daemon', 'exact'],
  ['daemn', 'daemon', 'close'], // 漏一个字母
  ['daemonn', 'daemon', 'close'], // 多一个字母
  ['xemon', 'daemon', 'miss'], // 首字母不对：可能是另一个词
  ['latent', 'patent', 'miss'], // 拼成另一个真词，不能算对
  ['patent', 'latent', 'miss'],
  ['throughpu', 'throughput', 'close'],
  ['throughpuut', 'throughput', 'close'], // 长词容忍 2 个字符
  ['throughout', 'throughput', 'close'], // 只差一个字母：判"差一点"，评分不给满分
  ['cat', 'daemon', 'miss'],
  ['', 'daemon', 'miss'],
  ['   ', 'daemon', 'miss'],
  ['daemon', '', 'miss'],
]
let fails = 0
for (const [input, word, want] of cases) {
  const got = spellCheck(input, word).state
  if (got === want) {
    console.log(`  ✓ ${JSON.stringify(input)} vs ${JSON.stringify(word)} → ${got}`)
  } else {
    fails++
    console.log(`  ✗ ${JSON.stringify(input)} vs ${JSON.stringify(word)} → ${got}（应为 ${want}）`)
  }
}
assert.equal(normalizeSpelling('A-b c!'), 'abc')
assert.equal(editDistance('kitten', 'sitting'), 3)
console.log('  ✓ 规范化 / 编辑距离')

// ── 3. 最小 hooks 运行时
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
function useCallback(fn) {
  return fn
}

const WritePanel = new Function(
  'h',
  'useState',
  'useCallback',
  'spellCheck',
  cut('function WritePanel({ item, onFinish, onReveal }) {') + '\nreturn WritePanel',
)(h, useState, useCallback, spellCheck)

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

// ── 4. 渲染 + 交互
function makePanel(props) {
  const box = { i: 0, states: [], dirty: false }
  const api = {
    tree: null,
    render() {
      box.dirty = false
      box.i = 0
      const prev = current
      current = box
      api.tree = WritePanel(props)
      current = prev
      return api.tree
    },
    input() {
      return findAll(api.tree, (n) => n.type === 'input')[0]
    },
    button(label) {
      return findAll(api.tree, (n) => n.type === 'button' && textOf(n) === label)[0]
    },
    type(value) {
      api.input().props.onChange({ target: { value } })
      return api.render()
    },
    press(label) {
      api.button(label).props.onClick()
      return api.render()
    },
    submit() {
      api.button('提交').props.onClick()
      return api.render()
    },
    enter() {
      const ev = { key: 'Enter', preventDefault() {} }
      api.input().props.onKeyDown(ev)
      return api.render()
    },
    text() {
      return textOf(api.tree)
    },
  }
  return api
}

const ITEM = { word: 'daemon', phonetic: 'ˈdiːmən', translation: 'n. 守护进程' }
const SENSES = { lead: 'n. 守护进程', rest: [] }

// 4a. 提交前不能露答案
const p = makePanel({ item: ITEM, senses: SENSES, onFinish: () => {} })
p.render()
assert.ok(p.text().includes('看中文，写出对应的英文单词'), '标题')
assert.ok(!p.text().includes('daemon'), '提交前不能出现单词本身')
assert.ok(p.input(), '有输入框')
assert.equal(p.button('提交').props.disabled, true, '空输入时提交按钮不可用')
console.log('  ✓ 提交前：有输入框、不露答案、空输入不能提交')

// 4b. 输错 → 显示正确拼写，评 miss；onReveal 只在提交后触发一次
let reveals = 0
const rv = makePanel({
  item: ITEM,
  senses: SENSES,
  onFinish: () => {},
  onReveal: () => (reveals = reveals + 1),
})
rv.render()
rv.type('deamon')
assert.equal(reveals, 0, '提交前不该触发 onReveal')
rv.submit()
assert.equal(reveals, 1, '提交后触发一次 onReveal（父组件据此自动读单词）')
p.type('deamon')
assert.equal(p.button('提交').props.disabled, false, '有内容后可提交')
p.submit()
assert.ok(p.text().includes('没写对'), '输错有提示')
assert.ok(p.text().includes('daemon'), '输错后给出正确拼写')
const inputAfter = p.input()
assert.equal(inputAfter.props.readOnly, true, '结算后输入框锁定')
assert.equal(inputAfter.props['data-state'], 'miss')
console.log('  ✓ 输错：给出正确拼写、锁定输入框')

// 4c. "下一个"把结果交回去
let finished = null
const q = makePanel({ item: ITEM, senses: SENSES, onFinish: (r) => (finished = r) })
q.render()
q.type('  Daemon ')
q.enter() // 回车提交
assert.ok(q.text().includes('拼对了'), '回车能提交且判对')
q.press('下一个')
assert.deepEqual(finished && finished.state, 'exact')
console.log('  ✓ 正确：回车提交、下一个回传 exact')

// 4d. 小笔误 → close
let closeResult = null
const r = makePanel({ item: ITEM, senses: SENSES, onFinish: (x) => (closeResult = x) })
r.render()
r.type('daemn')
r.submit()
assert.ok(r.text().includes('差一点'), '笔误提示"差一点"')
r.press('下一个')
assert.equal(closeResult.state, 'close')
console.log('  ✓ 笔误：判 close')

if (fails > 0) {
  console.log(`\n${fails} 项失败 ✗`)
  process.exit(1)
}
console.log('\n全部通过 ✓')
