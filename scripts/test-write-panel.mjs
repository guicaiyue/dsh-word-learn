// "写得出"练习（看中文拼英文）的单测。
//
// 整文件加载 assets/dashboard.js（见 tests/helpers/dashboard.mjs），不再切源码：
// 用最小 React 运行时渲染真实 WritePanel，对元素树做断言。
//
// 为什么测这个：拼写比对一旦放宽过头（把 latent 判成 patent 对），
// 或者面板在提交前就把答案漏出来，只有真用起来才发现。
import assert from 'node:assert/strict'

import { findAll, loadDashboard, textOf } from '../tests/helpers/dashboard.mjs'

const module = loadDashboard()
const { WritePanel, normalizeSpelling, editDistance, spellCheck } = module.__test__
const { mount } = module.__helpers__

// ── 1. 拼写比对
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
for (const [input, word, want] of cases) {
  const got = spellCheck(input, word).state
  assert.equal(got, want, `${JSON.stringify(input)} vs ${JSON.stringify(word)} 应为 ${want}`)
  console.log(`  ✓ ${JSON.stringify(input)} vs ${JSON.stringify(word)} → ${got}`)
}
assert.equal(normalizeSpelling('A-b c!'), 'abc')
assert.equal(editDistance('kitten', 'sitting'), 3)
console.log('  ✓ 规范化 / 编辑距离')

// ── 2. 渲染 + 交互
function makePanel(props) {
  const handle = mount(WritePanel, props)
  const panel = { tree: handle.tree, render: handle.render }
  panel.input = () => findAll(panel.tree, (n) => n.type === 'input')[0]
  panel.button = (label) =>
    findAll(panel.tree, (n) => n.type === 'button' && textOf(n) === label)[0]
  panel.type = (value) => {
    panel.input().props.onChange({ target: { value } })
    panel.tree = panel.render()
    return panel.tree
  }
  panel.press = (label) => {
    panel.button(label).props.onClick()
    panel.tree = panel.render()
    return panel.tree
  }
  panel.submit = () => panel.press('提交')
  panel.enter = () => {
    panel.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
    panel.tree = panel.render()
    return panel.tree
  }
  panel.text = () => textOf(panel.tree)
  return panel
}

const ITEM = { word: 'daemon', phonetic: 'ˈdiːmən', translation: 'n. 守护进程' }
const SENSES = { lead: 'n. 守护进程', rest: [] }

// 2a. 提交前不能露答案
const p = makePanel({ item: ITEM, senses: SENSES, onFinish: () => {} })
assert.ok(p.text().includes('看中文，写出对应的英文单词'), '标题')
assert.ok(!p.text().includes('daemon'), '提交前不能出现单词本身')
assert.ok(p.input(), '有输入框')
assert.equal(p.button('提交').props.disabled, true, '空输入时提交按钮不可用')
console.log('  ✓ 提交前：有输入框、不露答案、空输入不能提交')

// 2b. 输错 → 显示正确拼写，评 miss；onReveal 只在提交后触发一次
let reveals = 0
const rv = makePanel({
  item: ITEM,
  senses: SENSES,
  onFinish: () => {},
  onReveal: () => (reveals = reveals + 1),
})
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

// 2c. "下一个"把结果交回去
let finished = null
const q = makePanel({ item: ITEM, senses: SENSES, onFinish: (r) => (finished = r) })
q.type('  Daemon ')
q.enter() // 回车提交
assert.ok(q.text().includes('拼对了'), '回车能提交且判对')
q.press('下一个')
assert.equal(finished && finished.state, 'exact')
console.log('  ✓ 正确：回车提交、下一个回传 exact')

// 2d. 小笔误 → close
let closeResult = null
const r = makePanel({ item: ITEM, senses: SENSES, onFinish: (x) => (closeResult = x) })
r.type('daemn')
r.submit()
assert.ok(r.text().includes('差一点'), '笔误提示"差一点"')
r.press('下一个')
assert.equal(closeResult.state, 'close')
console.log('  ✓ 笔误：判 close')

console.log('\n全部通过 ✓')
