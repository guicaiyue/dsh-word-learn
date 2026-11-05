// HoverWord（易混淆词/近义词的悬浮释义）单测。
//
// 整文件加载 assets/dashboard.js（见 tests/helpers/dashboard.mjs），不再切片源码：
// 用最小 React 运行时渲染真实组件，模拟"点击浮出 → 拿到释义 → 加入生词本"。
//
// 为什么测：这段是"看不懂的英文词"唯一的解释入口，卡片渲染错了
// 等于又回到"只给个英文词让你猜"。
import assert from 'node:assert/strict'

import { findByClass, loadDashboard, textOf } from '../tests/helpers/dashboard.mjs'

const calls = []
function fakeFetch(url, opt = {}) {
  calls.push({ p: url, opt })
  const dict = {
    word: 'adapt',
    phonetic: 'əˈdæpt',
    senses: [{ pos: 'v.', text: '适应；改编' }],
  }
  const body =
    opt.method === 'POST'
      ? { ok: true, dict, saved: { seenCount: 1 } }
      : { ok: true, dict, saved: null }
  return Promise.resolve({ status: 200, json: async () => body })
}

const module = loadDashboard({ fetch: fakeFetch })
const { HoverWord } = module.__test__
const { mount } = module.__helpers__
const source = module.__source__

function makePanel(word) {
  const handle = mount(HoverWord, { word })
  const panel = { tree: handle.tree, render: handle.render, flush: handle.flush }
  panel.click = async () => {
    findByClass(panel.tree, 'dwl-hoverword')[0].props.onClick({
      preventDefault() {},
      stopPropagation() {},
    })
    panel.tree = await panel.flush()
  }
  panel.add = async () => {
    const btn = findByClass(panel.tree, 'dwl-hovercard-add')[0]
    assert.ok(btn, '应有「加入生词本」按钮')
    btn.props.onClick({ stopPropagation() {} })
    panel.tree = await panel.flush()
  }
  return panel
}

const p = makePanel('adapt')
assert.equal(textOf(p.tree).trim(), 'adapt', '未交互时只渲染这个词')
assert.equal(findByClass(p.tree, 'dwl-hovercard').length, 0, '未交互时不显示卡片')
console.log('  ✓ 初始只渲染词，不弹卡片')

await p.click()
assert.equal(calls.length, 1, '点击触发一次查询')
assert.match(calls[0].p, /word=adapt/)
assert.match(calls[0].p, /save=false/, '预览必须 save=false（只看不记）')
assert.match(calls[0].p, /enrich=false/, '预览不打外部例句接口')
const card = findByClass(p.tree, 'dwl-hovercard')[0]
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
assert.equal(JSON.parse(post.opt.body).word, 'adapt')
assert.match(textOf(p.tree), /已在生词本/, '加入后状态更新')
console.log('  ✓ 点「加入生词本」→ POST 写库，卡片显示已在生词本')

const p2 = makePanel('latent')
await p2.click()
assert.match(textOf(p2.tree), /已在生词本|加入生词本/)
console.log('  ✓ 另一个词的卡片同样能渲染')

// 源码级约束：发音走浏览器自带语音（语音模块已并入 bundle），不再有服务端音频链路。
// 注意不能只查 'tts' 字样：voice.js 里还保留着老 localStorage 键
// `dwl-tts-accent` 的一次性迁移，那是数据迁移，不是服务端链路。
assert.ok(!/\/tts|tts-prepare/.test(source), '不应再引用服务端 /tts 音频路由')
assert.ok(!/new Audio\s*\(/.test(source), '不应 new Audio（发音走 speechSynthesis）')
assert.ok(source.includes('speechSynthesis'), '发音应走浏览器自带 speechSynthesis')
assert.ok(source.includes('preload()'), '开始一轮应预热音色列表')
assert.ok(/voiceModule\(\)/.test(source), '没有语音模块时要能降级')
console.log('  ✓ 发音走浏览器自带 speechSynthesis，不再引用服务端音频')

console.log('\n全部通过 ✓')
