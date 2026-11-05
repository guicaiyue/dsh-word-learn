// 测什么：学习页两个「数据驱动」视图的渲染 —— StatsView（概览/曲线/分布）与
// VocabView（词表/过滤/加载更多）。
//
// 为什么补这两块：拆 dashboard.js 时它们的取数与映射搬到了 dashboard-logic.js
// （statsViewModel / repairKpis / answerDistribution / filterLoadedItems），
// 但此前没有任何直接测试 —— 只有打开页面才看得到，写错一个字段名就是整块空白。
// 这里按「给定 props/接口返回 → 具体文案、条数、柱高」断言，不做快照。
//
// 边界：不联网（fetch 全 stub）、不碰用户库、不起宿主；用整文件加载 +
// tests/helpers/dashboard.mjs 的最小 React 运行时，测的是产品里真实跑的那份代码。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { findAll, loadDashboard, textOf } from '../helpers/dashboard.mjs'

/** 取 className 完全相等的元素（比 includes 更严：避免 dwl-kpi 撞 dwl-kpis）。 */
const byClass = (tree, className) =>
  findAll(tree, (n) => n.props && n.props.className === className)

/** 四个主 KPI 的数值（`.dwl-kpi > .n` 的纯文本）。 */
const kpiNumbers = (tree) =>
  byClass(tree, 'dwl-kpi').map((kpi) =>
    textOf(findAll(kpi, (n) => n.props && n.props.className === 'n')[0]),
  )

const buttonsWithText = (tree, label) =>
  findAll(tree, (n) => n.type === 'button' && textOf(n) === label)

const inputOf = (tree) =>
  findAll(tree, (n) => n.type === 'input' && n.props && n.props.type === 'search')[0]

// ─────────────────────────────────────────────────────────── StatsView

/** 一份「什么都有」的数据页返回：4 主 KPI + 补记债 + 两条曲线 + 画像 + 分布 + 列表。 */
const STATS_FIXTURE = {
  words: {
    total: 32,
    byTier: [
      { tier: 'top1k', n: 20 },
      { tier: 'top3k', n: 5 },
    ],
  },
  cards: { started: 30, fresh: 4, learning: 6, review: 18, relearning: 2 },
  queue: { dueTomorrow: 7, reviewedToday: 2 },
  accuracy: { dist: { 1: 1, 2: 1, 3: 1, 4: 1 }, total: 4, rate: 0.75 },
  ability: { recognize: [0, 3, 0, 0, 0, 0], meaning: [1, 0, 0, 0, 0, 0] },
  repair: {
    stages: [
      { stage: 'pick', n: 4, ok: 1 },
      { stage: 'spell', n: 25, ok: 3 },
    ],
    debt: { opened: 7, cleared: 3 },
  },
  forecast: [
    { date: new Date(2026, 10, 6).getTime(), count: 3 },
    { date: new Date(2026, 10, 7).getTime(), count: 0 },
  ],
  activity: [{ date: new Date(2026, 10, 5).getTime(), count: 4 }],
  hardest: [{ word: 'abandon', translation: '放弃\nv. 放弃', lapses: 3 }],
  recent: [{ word: 'apple', translation: '苹果\nn. 苹果', seen_at: Date.now() - 3600 * 1000 }],
  dbPath: '/tmp/demo/user.db',
  schedule: { ok: true },
}

/**
 * 把「组件元素」展开成真实渲染树。
 *
 * 最小 React 运行时只渲染传给 mount 的那个组件；StatsView 里的 Bars /
 * StackedProgress / Histogram 仍是未执行的组件元素。断言柱子 title 这类
 * 子组件内部结构前，要像 React 一样逐层 mount 展开（纯渲染组件无副作用）。
 */
function expand(node, mount) {
  if (node == null || node === false) return node
  if (Array.isArray(node)) return node.map((n) => expand(n, mount))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(mount(node.type, node.props).tree, mount)
  return {
    ...node,
    props: { ...node.props, children: expand(node.props.children, mount) },
  }
}

/** StatsView 是纯渲染（无 effect），可直接 mount 再展开子组件。 */
function renderStats(data) {
  const module = loadDashboard()
  const { StatsView } = module.__test__
  const { mount } = module.__helpers__
  return expand(mount(StatsView, { data }).tree, mount)
}

describe('StatsView', () => {
  test('四个主 KPI 的数值与文案来自后端字段', () => {
    const tree = renderStats(STATS_FIXTURE)
    assert.deepEqual(kpiNumbers(tree).slice(0, 4), ['30', '75%', '7', '2'])
    const text = textOf(tree)
    assert.match(text, /开始 \/ 32 词/)
    assert.match(text, /复习正确率/)
    assert.match(text, /明日到期/)
    assert.match(text, /今日已复习/)
    assert.ok(!text.includes('NaN'), '聚合结果里不应出现 NaN')
  })

  test('补记债面板：命中率/通过率/已清在三格 KPI 里', () => {
    const tree = renderStats(STATS_FIXTURE)
    // 前三格是主 KPI，后三格是补记循环
    assert.deepEqual(kpiNumbers(tree).slice(4), ['25%', '12%', '3/7'])
    const text = textOf(tree)
    assert.match(text, /补记循环/)
    assert.match(text, /义项首猜命中 \/ 4 次/)
    assert.match(text, /拼写通过 \/ 25 次/)
    assert.match(text, /补记债已清/)
    // 没有 repair 数据时整块不渲染（后端老版本没有补记循环）
    const bare = renderStats({})
    assert.equal(findAll(bare, (n) => n.type === 'h3' && textOf(n).includes('补记循环')).length, 0)
  })

  test('两条 14 天曲线：柱子的 title 与横轴日期都按数据渲染', () => {
    const tree = renderStats(STATS_FIXTURE)
    const bars = byClass(tree, 'dwl-bars')
    assert.equal(bars.length, 2, '未来 14 天到期 + 近 14 天复习量两条')
    assert.deepEqual(
      bars[0].props.children.map((n) => n.props.title),
      ['11/6：3 个', '11/7：0 个'],
    )
    assert.deepEqual(
      bars[1].props.children.map((n) => n.props.title),
      ['11/5：4 次作答'],
    )
    const axis = byClass(tree, 'dwl-axis')[0].props.children.map(textOf)
    assert.deepEqual(axis, ['11/6', '11/7'])
    // 0 的柱子仍有 2% 高度（看得见"这天没有"），不为 0 的按比例
    assert.equal(bars[0].props.children[0].props.style.height, '100%')
    assert.equal(bars[0].props.children[1].props.style.height, '2%')
  })

  test('作答分布按 1–4 评分四行，宽度=次数占比、颜色只走令牌', () => {
    const tree = renderStats(STATS_FIXTURE)
    const rows = byClass(tree, 'dwl-dist')
    assert.equal(rows.length, 4)
    assert.deepEqual(
      rows.map((r) => textOf(r)),
      ['忘了1 次', '勉强1 次', '记得1 次', '太简单1 次'],
    )
    const barOf = (row) => row.props.children[1].props.children
    assert.equal(barOf(rows[0]).props.style.width, '25%')
    assert.equal(barOf(rows[3]).props.style.width, '25%')
    assert.equal(barOf(rows[0]).props.style.background, 'var(--dsw-alias-state-error-primary)')
    assert.equal(barOf(rows[3]).props.style.background, 'var(--dsw-alias-state-business-primary)')
    assert.match(textOf(tree), /共 4 次/)
  })

  test('空数据兜底：KPI 写 0/—、空态文案齐、不渲染空曲线', () => {
    const tree = renderStats({})
    assert.deepEqual(kpiNumbers(tree).slice(0, 4), ['0', '—', '0', '0'])
    const text = textOf(tree)
    assert.match(text, /开始 \/ 0 词/)
    assert.match(text, /还没有作答记录/)
    assert.match(text, /还没有反复忘的词/)
    assert.match(text, /还没遇到过词/)
    assert.match(text, /新词 0 · 学习中 0 · 复习中 0 · 重学 0/)
    assert.match(text, /均 0\.0/)
    assert.match(text, /数据存在 \$DSH_HOME\/dsh-word-learn\/user\.db/)
    for (const bar of byClass(tree, 'dwl-bars')) {
      assert.equal(bar.props.children.length, 0, '没有曲线数据时不该凭空造柱子')
    }
  })
})

// ─────────────────────────────────────────────────────────── VocabView

/** 三条词表数据：覆盖音标/无音标/多行释义/两种词频档位。 */
const VOCAB_ITEMS = [
  { id: 1, word: 'apple', phonetic: 'ˈæpl', translation: '苹果\nn. 苹果', freqTier: 'top1k' },
  { id: 2, word: 'banana', translation: '香蕉', freqTier: 'top3k' },
  { id: 3, word: 'zebra', translation: '斑马\nn.', freqTier: 'rare' },
]

/**
 * 用给定的 fetch 桩加载模块并挂载 VocabView，等 effect 里的请求落地。
 * 桩按 URL 决定返回，`calls` 记录每次请求，方便断言 offset/tier 参数。
 */
async function renderVocab(route) {
  const calls = []
  const module = loadDashboard({
    fetch: async (url) => {
      calls.push(url)
      return { status: 200, json: async () => route(url, calls.length) }
    },
  })
  const { VocabView } = module.__test__
  const handle = module.__helpers__.mount(VocabView)
  const tree = await handle.settle(10)
  return { handle, tree, calls }
}

const vocabRows = (tree) => byClass(tree, 'dwl-vrow')

describe('VocabView', () => {
  test('词表渲染：行内容、档位徽标、计数与加载更多入口', async () => {
    const { tree, calls } = await renderVocab(() => ({
      ok: true,
      items: VOCAB_ITEMS,
      total: 5,
    }))
    assert.equal(calls[0], '/dsh-word-learn/list?limit=200&offset=0&order=recent')
    const rows = vocabRows(tree)
    assert.equal(rows.length, 3)
    assert.equal(textOf(rows[0]), 'apple/ˈæpl/苹果1k')
    assert.ok(rows[0].props['aria-label'].startsWith('apple，苹果'))
    assert.match(rows[1].props.title, /^banana · 高频 3000/)
    assert.equal(textOf(rows[2]), 'zebra斑马低频')
    assert.equal(inputOf(tree).props.placeholder, '在已加载的 3 条里搜索')
    assert.match(textOf(tree), /已加载 3 \/ 共 5 条/)
    assert.equal(buttonsWithText(tree, '加载更多').length, 1)
  })

  test('空词表：给引导文案，不出现行和"加载更多"', async () => {
    const { tree } = await renderVocab(() => ({ ok: true, items: [], total: 0 }))
    const text = textOf(tree)
    assert.match(text, /这个词表还是空的/)
    assert.match(text, /在对话里划一个英文单词/)
    assert.match(text, /已加载 0 \/ 共 0 条/)
    assert.equal(vocabRows(tree).length, 0)
    assert.equal(buttonsWithText(tree, '加载更多').length, 0)
    // 档位 chips：全部 + 5 档
    assert.equal(byClass(tree, 'dwl-chip').length, 6)
  })

  test('已加载集合内过滤：输入经防抖后只留命中的行', async () => {
    const { handle, tree } = await renderVocab(() => ({
      ok: true,
      items: VOCAB_ITEMS,
      total: 3,
    }))
    inputOf(tree).props.onChange({ target: { value: 'ban' } })
    handle.render() // 触发 220ms 防抖计时器
    await new Promise((resolve) => setTimeout(resolve, 260))
    const next = handle.render()
    assert.equal(vocabRows(next).length, 1)
    assert.match(textOf(vocabRows(next)[0]), /banana/)
    assert.match(textOf(next), /已加载 3 \/ 共 3 条/)
  })

  test('过滤无命中：说明是在"已加载"里搜的，并给加载更多入口', async () => {
    const { handle, tree } = await renderVocab(() => ({
      ok: true,
      items: VOCAB_ITEMS,
      total: 5,
    }))
    inputOf(tree).props.onChange({ target: { value: 'zzz' } })
    handle.render()
    await new Promise((resolve) => setTimeout(resolve, 260))
    const next = handle.render()
    assert.equal(vocabRows(next).length, 0)
    assert.match(textOf(next), /已加载的 3 条里没有「zzz」。试试换个词频档位，或加载更多词条。/)
    assert.equal(buttonsWithText(next, '加载更多再搜').length, 1)
  })

  test('加载更多按钮：带当前 offset 续拉并追加，拉满后按钮消失', async () => {
    const { handle, tree, calls } = await renderVocab((url) =>
      url.includes('offset=3')
        ? {
            ok: true,
            items: [
              { id: 4, word: 'delta', translation: '德尔塔', freqTier: 'top8k' },
              { id: 5, word: 'echo', translation: '回声', freqTier: 'rare' },
            ],
            total: 5,
          }
        : { ok: true, items: VOCAB_ITEMS, total: 5 },
    )
    buttonsWithText(tree, '加载更多')[0].props.onClick()
    const next = await handle.settle(10)
    assert.equal(calls.length, 2)
    assert.match(calls[1], /offset=3/)
    assert.equal(vocabRows(next).length, 5)
    assert.equal(buttonsWithText(next, '加载更多').length, 0)
    assert.match(textOf(next), /已加载 5 \/ 共 5 条/)
  })

  test('词频档位 chip：点击后按 tier 重新请求，并更新 aria-pressed', async () => {
    const { handle, tree, calls } = await renderVocab((url) =>
      url.includes('tier=top3k')
        ? { ok: true, items: [VOCAB_ITEMS[1]], total: 1 }
        : { ok: true, items: VOCAB_ITEMS, total: 3 },
    )
    buttonsWithText(tree, '高频 3000')[0].props.onClick()
    const next = await handle.settle(10)
    assert.equal(calls.length, 2)
    assert.match(calls[1], /tier=top3k/)
    const chips = byClass(next, 'dwl-chip')
    assert.equal(chips.find((c) => textOf(c) === '高频 3000').props['aria-pressed'], true)
    assert.equal(chips.find((c) => textOf(c) === '全部').props['aria-pressed'], false)
    assert.equal(vocabRows(next).length, 1)
  })
})
