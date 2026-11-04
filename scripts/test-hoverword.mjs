// HoverWord（易混淆词/近义词的悬浮释义）单测。
//
// 不装 React：从 assets/dashboard.js 原样切出 HoverWord，
// 用最小 hooks 运行时渲染，模拟"点击浮出 → 拿到释义 → 加入生词本"。
//
// 为什么测：这段是"看不懂的英文词"唯一的解释入口，卡片渲染错了
// 等于又回到"只给个英文词让你猜"。

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const SRC = path.join(import.meta.dirname, '..', 'assets', 'dashboard.js')
const text = fs.readFileSync(SRC, 'utf8')

// ── 1. 切出组件（花括号配平；签名末尾的 { 才是函数体）
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

const source = cut('function HoverWord({ word }) {')

// ── 2. 最小 hooks 运行时
const h = (type, props, ...children) => ({
  type,
  props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
})
const globals = { window: { innerWidth: 1200, innerHeight: 800 } }
let current = null
function useState(init) {
  const box = current
  const i = box.i++
  if (!(i in box.states)) box.states[i] = typeof init === 'function' ? init() : init
  return [
    box.states[i],
    (v) => {
      box.states[i] = typeof v === 'function' ? v(box.states[i]) : v
      box.dirty = true
    },
  ]
}
function useRef(init) {
  const box = current
  const i = box.i++
  if (!(i in box.refs)) box.refs[i] = { current: init }
  return box.refs[i]
}
function useEffect(fn) {
  current.effects.push(fn)
}
function useCallback(fn) {
  return fn
}

const calls = []
async function fakeApi(p, opt) {
  calls.push({ p, opt })
  if (opt && opt.method === 'POST') {
    return {
      ok: true,
      dict: { word: 'adapt', phonetic: 'əˈdæpt', senses: [{ pos: 'v.', text: '适应；改编' }] },
      saved: { seenCount: 1 },
    }
  }
  return {
    ok: true,
    dict: { word: 'adapt', phonetic: 'əˈdæpt', senses: [{ pos: 'v.', text: '适应；改编' }] },
    saved: null,
  }
}

const HoverWord = new Function(
  'h',
  'useState',
  'useRef',
  'useEffect',
  'useCallback',
  'api',
  'window',
  source + '\nreturn HoverWord',
)(h, useState, useRef, useEffect, useCallback, fakeApi, globals.window)

// ── 3. 渲染驱动
function makePanel(word) {
  const box = { i: 0, states: [], refs: {}, effects: [], dirty: false }
  const api = {
    tree: null,
    render() {
      box.dirty = false
      box.i = 0
      const prev = current
      current = box
      api.tree = HoverWord({ word })
      const effects = box.effects
      box.effects = []
      for (const fn of effects) fn()
      current = prev
      return api.tree
    },
    async click() {
      findAll(api.tree, (n) => n.props && n.props.className === 'dwl-hoverword')[0].props.onClick({
        preventDefault() {},
        stopPropagation() {},
      })
      api.render()
      await new Promise((r) => setTimeout(r, 0)) // 等 fakeApi 的 promise
      api.render()
    },
    async add() {
      const btn = findAll(api.tree, (n) => n.props && n.props.className === 'dwl-hovercard-add')[0]
      assert.ok(btn, '应有「加入生词本」按钮')
      btn.props.onClick({ stopPropagation() {} })
      api.render()
      await new Promise((r) => setTimeout(r, 0))
      api.render()
    },
  }
  return api
}

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

// ── 4. 断言
const p = makePanel('adapt')
p.render()
assert.equal(textOf(p.tree).trim(), 'adapt', '未交互时只渲染这个词')
assert.equal(
  findAll(p.tree, (n) => n.props && n.props.className === 'dwl-hovercard').length,
  0,
  '未交互时不显示卡片',
)
console.log('  ✓ 初始只渲染词，不弹卡片')

await p.click()
assert.equal(calls.length, 1, '点击触发一次查询')
assert.match(calls[0].p, /word=adapt/)
assert.match(calls[0].p, /save=false/, '预览必须 save=false（只看不记）')
assert.match(calls[0].p, /enrich=false/, '预览不打外部例句接口')
const card = findAll(p.tree, (n) => n.props && n.props.className === 'dwl-hovercard')[0]
assert.ok(card, '应浮出释义卡')
const cardText = textOf(card)
assert.match(cardText, /adapt/)
assert.match(cardText, /əˈdæpt/, '卡片里有音标')
assert.match(cardText, /适应；改编/, '卡片里有释义')
console.log('  ✓ 点击浮出释义（音标 + 释义），查询用 save=false')

assert.ok(!/已在生词本/.test(cardText), '还没加入')
await p.add()
const post = calls.find((c) => c.opt && c.opt.method === 'POST')
assert.ok(post, '应发 POST 加入生词本')
assert.equal(post.opt.body.word, 'adapt')
assert.notEqual(post.opt.body.save, false, '加入时要真正写库')
assert.match(textOf(p.tree), /已在生词本/, '加入后状态更新')
console.log('  ✓ 点「加入生词本」→ POST 写库，卡片显示已在生词本')

const p2 = makePanel('latent')
p2.render()
await p2.click()
assert.match(textOf(p2.tree), /已在生词本|加入生词本/)
console.log('  ✓ 另一个词的卡片同样能渲染')

// ── 5. 发音已经切到浏览器自带语音（voice.js），不再走服务端音频链路
assert.ok(!/tts/i.test(text), 'dashboard.js 不应再出现 tts 字样（服务端发音链路已删）')
assert.ok(!/new Audio\s*\(/.test(text), 'dashboard.js 不应再 new Audio（改为 __dwlVoice.speak）')
assert.ok(text.includes('__dwlVoice'), 'dashboard.js 应通过 window.__dwlVoice 朗读')
assert.ok(text.includes('preload()'), '开始一轮应预热音色列表')
assert.ok(/voiceModule\(\)/.test(text), '没有语音模块时要能降级')
console.log('  ✓ 发音走 window.__dwlVoice，不再引用服务端音频')

console.log('\n全部通过 ✓')
