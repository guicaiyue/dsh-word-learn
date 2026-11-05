// 测什么：普通刷新竞态 —— DSH 自己的 client 入口（就是本模块）可能先于我们的
// 注入脚本执行并 apply。此时 window.__dwlDashboardLogic / __dwlDashboardCSS 还不存在。
//
// 真机现象（2026-11-05）：普通刷新后点侧栏「英语学习」→ 全部无样式、渲染抛
// `TypeError: Cannot read properties of undefined (reading 'map') at WordLearnPage`、
// slot entry crashed；硬刷新则正常（快照那一刻全局恰好已经在了）。
//
// 这条用例锁死三件事：
//   ① 全局缺失时 apply 不抛错；
//   ② 页面先显示可见的「正在加载」，而不是崩页（最坏是空页）；
//   ③ 注入脚本就绪并 dispatch dwl:assets-ready 后，样式自动补注入、页面自动重渲染。
// 旧实现（模块级快照）在第 ② 步就会红：TABS 是 undefined，渲染直接抛错。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { loadDashboard, textOf } from '../helpers/dashboard.mjs'

/** 展开未渲染的子组件元素（最小 React 运行时只渲染传给 mount 的那个组件）。 */
function expand(node, mount) {
  if (node == null || node === false) return node
  if (Array.isArray(node)) return node.map((n) => expand(n, mount))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(mount(node.type, node.props).tree, mount)
  return { ...node, props: { ...node.props, children: expand(node.props.children, mount) } }
}

/** 极简 ctx：只实现 apply 用到的 effect / locale / slots。 */
function fakeCtx() {
  const cleanups = []
  return {
    cleanups,
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    locale: { register() {}, bind: () => (key) => key },
    slots: {
      inject(_name, register) {
        register()
      },
      register() {
        return { dispose() {} }
      },
    },
  }
}

/** 模拟「普通刷新」：先加载 dashboard.js（不注入 logic/style），再手动补注入。 */
function loadRacy() {
  const module = loadDashboard({ deferAssets: true })
  const { mount, injectAssets, document } = module.__helpers__
  const { WordLearnPage } = module.__test__
  return { module, mount, injectAssets, document, WordLearnPage }
}

describe('普通刷新竞态：注入脚本晚于 client apply', () => {
  test('apply 不抛错；组件层兜底为「正在加载」而不是 undefined.map', () => {
    const { module, WordLearnPage, mount } = loadRacy()
    assert.doesNotThrow(() => module.apply(fakeCtx()), '全局缺失时 apply 不应抛错')
    assert.ok(Array.isArray(module.inject), '模块仍要导出 inject（宿主按契约调用）')
    let tree
    assert.doesNotThrow(() => {
      tree = mount(WordLearnPage, {}).tree
    }, '逻辑未就绪时渲染不应抛错 —— 旧实现会在这里 undefined.map 崩')
    assert.match(textOf(tree), /正在加载/, '最坏情况是可见的加载态，不是崩页')
  })

  test('dwl:assets-ready 到达后：样式补注入 + 页面自动重渲染', async () => {
    const { module, mount, injectAssets, document, WordLearnPage } = loadRacy()
    module.apply(fakeCtx())
    const handle = mount(WordLearnPage, {})
    assert.match(textOf(handle.tree), /正在加载/)
    assert.deepEqual(document._styles, [0], '注入脚本未到时，样式元素先挂着但内容为空')

    injectAssets() // 生产中正是这两个脚本自己在末尾 dispatch dwl:assets-ready
    // 就绪后入口才会挂真正的 ReadyPage；子组件要像 React 一样展开再断言。
    const tree = expand(await handle.settle(8), mount)

    assert.ok(
      document._styles.some((n) => n > 1000),
      `就绪后样式必须补注入，实际各样式元素长度：${JSON.stringify(document._styles)}`,
    )
    assert.match(textOf(tree), /学习/, '就绪后应重渲染出标签栏（学习/词汇/数据/设置）')
    assert.ok(!textOf(tree).includes('正在加载'), '就绪后不应停留在加载态')
  })

  test('重复事件 / 重复 apply 不会叠加样式或抛错', () => {
    const { module, injectAssets, document } = loadRacy()
    module.apply(fakeCtx())
    module.apply(fakeCtx())
    injectAssets()
    // 事件可能被两个 effect 各收到一次；样式元素数量应保持新增最小（不无限复制）
    assert.ok(
      document._styles.length <= 2,
      `样式元素不该被重复创建：${JSON.stringify(document._styles)}`,
    )
    assert.ok(
      document._styles.every((n) => n > 0),
      '两个 effect 都应拿到非空样式（就绪后补注入）',
    )
  })
})
