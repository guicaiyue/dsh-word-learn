/**
 * StatsView / VocabView —— 真实 React 渲染（jsdom + RTL）。
 *
 * 迁移自 `tests/unit/dashboard-views.test.mjs`（node:test + 299 行手搓 React 运行时
 * 的旧基座，已随迁移删除）。旧断言逐条保留，只把「遍历元素树取 props」换成
 * 「查真实 DOM / role / 可见文案」：
 *
 *   - 树遍历 `findAll(tree, n => n.type === ...)` → `container.querySelector` /
 *     `screen.getByRole`；
 *   - `textOf(node)` → `textContent` / `getByText`（用户能看到的文案）；
 *   - `props.onChange(...)` / `props.onClick()` → `fireEvent.change` / `fireEvent.click`；
 *   - `handle.settle()`（手动等异步 + 重渲）→ `await act(async () => ...)`：
 *     React 19 真实调度，effect / setState / 防抖计时器都在 act 里刷完。
 *
 * 组件与逻辑都来自构建产物 `dist/client.js`（`__test__`），不是 import src/**：
 * 测的是宿主真正会加载的那份。fetch 一律 stub（LOGIC.api 走全局 fetch），不联网。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ComponentType } from 'react'
import { loadBundle, type LoadedBundle } from '../support/load-bundle'

/** 两份视图的 props（避免测试里出现隐式 any）。 */
interface StatsProps {
  data: unknown
}
type VocabProps = Record<string, never>

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

/** 三条词表数据：覆盖音标/无音标/多行释义/两种词频档位。 */
const VOCAB_ITEMS = [
  { id: 1, word: 'apple', phonetic: 'ˈæpl', translation: '苹果\nn. 苹果', freqTier: 'top1k' },
  { id: 2, word: 'banana', translation: '香蕉', freqTier: 'top3k' },
  { id: 3, word: 'zebra', translation: '斑马\nn.', freqTier: 'rare' },
]

let bundle: LoadedBundle

beforeAll(() => {
  bundle = loadBundle()
})

afterEach(() => {
  vi.unstubAllGlobals()
  bundle.window.localStorage.clear()
})

/** 装一个 fetch 桩：按 URL 决定返回，`calls` 记录每次请求（断言 offset/tier 用）。 */
function stubFetch(route: (url: string, callIndex: number) => unknown): string[] {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      return { ok: true, json: async () => route(url, calls.length) }
    }),
  )
  return calls
}

/** StatsView 是纯渲染（无 effect），直接 render 即可。 */
async function renderStats(data: unknown): Promise<RenderResult> {
  const StatsView = bundle.tests.StatsView as ComponentType<StatsProps>
  let view!: RenderResult
  await act(async () => {
    view = render(<StatsView data={data} />)
  })
  return view
}

// ─────────────────────────────────────────────────────────── StatsView

describe('StatsView', () => {
  it('四个主 KPI 的数值与文案来自后端字段', async () => {
    const view = await renderStats(STATS_FIXTURE)
    expect(view.container.querySelector('.dwl-stats')).not.toBeNull()
    // 4 个主 KPI + 3 个补记循环 KPI
    expect(view.container.querySelectorAll('.dwl-kpi').length).toBe(7)
    const numbers = [...view.container.querySelectorAll('.dwl-kpi > .n')].map(
      (node) => node.textContent,
    )
    expect(numbers.slice(0, 4)).toEqual(['30', '75%', '7', '2'])

    const kpis = screen.getByRole('group', { name: '学习概览' })
    expect(within(kpis).getByText('开始 / 32 词')).toBeTruthy()
    expect(within(kpis).getByText('复习正确率')).toBeTruthy()
    expect(within(kpis).getByText('明日到期')).toBeTruthy()
    expect(within(kpis).getByText('今日已复习')).toBeTruthy()
    expect(view.container.textContent).not.toContain('NaN')
  })

  it('补记债面板：命中率/通过率/已清在三格 KPI 里', async () => {
    const view = await renderStats(STATS_FIXTURE)
    const numbers = [...view.container.querySelectorAll('.dwl-kpi > .n')].map(
      (node) => node.textContent,
    )
    // 前三格是主 KPI 之后的补记循环
    expect(numbers.slice(4)).toEqual(['25%', '12%', '3/7'])
    expect(screen.getByText('补记循环')).toBeTruthy()
    expect(screen.getByText('义项首猜命中 / 4 次')).toBeTruthy()
    expect(screen.getByText('拼写通过 / 25 次')).toBeTruthy()
    expect(screen.getByText('补记债已清')).toBeTruthy()

    // 没有 repair 数据时整块不渲染（后端老版本没有补记循环）
    const bare = await renderStats({})
    expect(within(bare.container).queryByText('补记循环')).toBeNull()
  })

  it('两条 14 天曲线：柱子的 title 与横轴日期都按数据渲染', async () => {
    const view = await renderStats(STATS_FIXTURE)
    const bars = [...view.container.querySelectorAll('.dwl-bars')]
    expect(bars.length).toBe(2)

    const titles = (bar: Element) =>
      [...bar.querySelectorAll('i')].map((node) => node.getAttribute('title'))
    expect(titles(bars[0])).toEqual(['11/6：3 个', '11/7：0 个'])
    expect(titles(bars[1])).toEqual(['11/5：4 次作答'])

    const axis = [...view.container.querySelectorAll('.dwl-axis')].at(0)
    expect([...axis!.querySelectorAll('span')].map((node) => node.textContent)).toEqual([
      '11/6',
      '11/7',
    ])

    // 0 的柱子仍有 2% 高度（看得见"这天没有"），不为 0 的按比例
    const heights = [...bars[0].querySelectorAll('i')].map(
      (node) => (node as HTMLElement).style.height,
    )
    expect(heights).toEqual(['100%', '2%'])
  })

  it('作答分布按 1–4 评分四行，宽度=次数占比、颜色只走令牌', async () => {
    const view = await renderStats(STATS_FIXTURE)
    const rows = [...view.container.querySelectorAll('.dwl-dist')]
    expect(rows.length).toBe(4)
    expect(rows.map((node) => node.textContent)).toEqual([
      '忘了1 次',
      '勉强1 次',
      '记得1 次',
      '太简单1 次',
    ])

    const barOf = (row: Element) => row.querySelector('.bar i') as HTMLElement
    expect(barOf(rows[0]).style.width).toBe('25%')
    expect(barOf(rows[3]).style.width).toBe('25%')
    expect(barOf(rows[0]).style.background).toBe('var(--dsw-alias-state-error-primary)')
    expect(barOf(rows[3]).style.background).toBe('var(--dsw-alias-state-business-primary)')
    expect(screen.getByText('共 4 次')).toBeTruthy()
  })

  it('空数据兜底：KPI 写 0/—、空态文案齐、不渲染空曲线', async () => {
    const view = await renderStats({})
    expect(view.container.querySelectorAll('.dwl-kpi').length).toBe(4)
    const numbers = [...view.container.querySelectorAll('.dwl-kpi > .n')].map(
      (node) => node.textContent,
    )
    expect(numbers.slice(0, 4)).toEqual(['0', '—', '0', '0'])

    const text = view.container.textContent || ''
    expect(text).toContain('开始 / 0 词')
    expect(text).toContain('还没有作答记录')
    expect(text).toContain('还没有反复忘的词')
    expect(text).toContain('还没遇到过词')
    expect(text).toContain('新词 0 · 学习中 0 · 复习中 0 · 重学 0')
    // 空能力画像是 5 行「均 0.0」
    expect(screen.getAllByText('均 0.0').length).toBe(5)
    expect(text).toContain('数据存在 $DSH_HOME/dsh-word-learn/user.db（本地，可备份）')

    for (const bar of view.container.querySelectorAll('.dwl-bars')) {
      expect(bar.querySelectorAll('i').length, '没有曲线数据时不该凭空造柱子').toBe(0)
    }
  })
})

// ─────────────────────────────────────────────────────────── VocabView

/** 挂 VocabView，等 effect 里的首个请求落地。 */
async function renderVocab(
  route: (url: string, callIndex: number) => unknown,
): Promise<{ view: RenderResult; calls: string[] }> {
  const VocabView = bundle.tests.VocabView as ComponentType<VocabProps>
  const calls = stubFetch(route)
  let view!: RenderResult
  await act(async () => {
    view = render(<VocabView />)
  })
  return { view, calls }
}

const vocabRows = (view: RenderResult) => view.container.querySelectorAll('.dwl-vrow')

describe('VocabView', () => {
  it('词表渲染：行内容、档位徽标、计数与加载更多入口', async () => {
    const { view, calls } = await renderVocab(() => ({
      ok: true,
      items: VOCAB_ITEMS,
      total: 5,
    }))

    expect(calls[0]).toBe('/dsh-word-learn/list?limit=200&offset=0&order=recent')

    const rows = [...vocabRows(view)]
    expect(rows.length).toBe(3)
    expect(rows[0].textContent).toBe('apple/ˈæpl/苹果1k')
    expect(rows[0].getAttribute('aria-label')).toMatch(/^apple，苹果/)
    expect(rows[1].getAttribute('title')).toMatch(/^banana · 高频 3000/)
    expect(rows[2].textContent).toBe('zebra斑马低频')

    const input = screen.getByRole('searchbox', { name: '搜索单词' })
    expect(input.getAttribute('placeholder')).toBe('在已加载的 3 条里搜索')
    expect(screen.getByText('已加载 3 / 共 5 条')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '加载更多' }).length).toBe(1)
  })

  it('空词表：给引导文案，不出现行和"加载更多"', async () => {
    const { view } = await renderVocab(() => ({ ok: true, items: [], total: 0 }))
    const text = view.container.textContent || ''
    expect(text).toContain('这个词表还是空的')
    expect(text).toContain('在对话里划一个英文单词')
    expect(text).toContain('已加载 0 / 共 0 条')
    expect(vocabRows(view).length).toBe(0)
    expect(screen.queryAllByRole('button', { name: '加载更多' }).length).toBe(0)
    // 档位 chips：全部 + 5 档
    expect(view.container.querySelectorAll('.dwl-chip').length).toBe(6)
  })

  it('已加载集合内过滤：输入经防抖后只留命中的行', async () => {
    const { view } = await renderVocab(() => ({
      ok: true,
      items: VOCAB_ITEMS,
      total: 3,
    }))
    const input = screen.getByRole('searchbox', { name: '搜索单词' })

    await act(async () => {
      fireEvent.change(input, { target: { value: 'ban' } })
      // useDebouncedValue 的 220ms 防抖：在 act 里等它触发，状态更新才落在 act 作用域内
      await new Promise((resolve) => setTimeout(resolve, 260))
    })

    const rows = [...vocabRows(view)]
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('banana')
    expect(screen.getByText('已加载 3 / 共 3 条')).toBeTruthy()
  })

  it('过滤无命中：说明是在"已加载"里搜的，并给加载更多入口', async () => {
    const { view } = await renderVocab(() => ({
      ok: true,
      items: VOCAB_ITEMS,
      total: 5,
    }))
    const input = screen.getByRole('searchbox', { name: '搜索单词' })

    await act(async () => {
      fireEvent.change(input, { target: { value: 'zzz' } })
      await new Promise((resolve) => setTimeout(resolve, 260))
    })

    expect(vocabRows(view).length).toBe(0)
    expect(view.container.textContent).toContain(
      '已加载的 3 条里没有「zzz」。试试换个词频档位，或加载更多词条。',
    )
    expect(screen.getAllByRole('button', { name: '加载更多再搜' }).length).toBe(1)
  })

  it('加载更多按钮：带当前 offset 续拉并追加，拉满后按钮消失', async () => {
    const { view, calls } = await renderVocab((url) =>
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

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    })

    expect(calls.length).toBe(2)
    expect(calls[1]).toContain('offset=3')
    expect(vocabRows(view).length).toBe(5)
    expect(screen.queryAllByRole('button', { name: '加载更多' }).length).toBe(0)
    expect(screen.getByText('已加载 5 / 共 5 条')).toBeTruthy()
  })

  it('词频档位 chip：点击后按 tier 重新请求，并更新 aria-pressed', async () => {
    const { view, calls } = await renderVocab((url) =>
      url.includes('tier=top3k')
        ? { ok: true, items: [VOCAB_ITEMS[1]], total: 1 }
        : { ok: true, items: VOCAB_ITEMS, total: 3 },
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '高频 3000' }))
    })

    expect(calls.length).toBe(2)
    expect(calls[1]).toContain('tier=top3k')
    expect(screen.getByRole('button', { name: '高频 3000' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe('false')
    expect(vocabRows(view).length).toBe(1)
  })
})
