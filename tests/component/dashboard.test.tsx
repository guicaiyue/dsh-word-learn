/**
 * 组件测试：**真实 bundle 产物 + 真实 dashboard-logic 资产**，用 jsdom + RTL 渲染。
 *
 * 这组 case 要回答的问题是：拆掉 tests/helpers/dashboard.mjs 那套 320 行手搓
 * React 替身（假 hooks / 假 head / 假 setInterval / vm 整文件加载）之后，能不能
 * 直接拿宿主会加载的那份 `dist/client.js` 在 jsdom 里渲出真实 DOM。能，就说明迁移
 * 方向成立；不能，就说明还缺哪块 shim。
 *
 * 取组件的方式是 `bundle.__test__`（`src/client/entry.ts` 从 plugin.js 转出），
 * 不 import src/** —— 测的是产物，不是源码。组件内部通过 `assetOf(name)` 在渲染
 * 时读 `window.__dwlDashboardLogic`，所以这里不手搓逻辑桩，而是把
 * `assets/dashboard-logic.js`（注入页面用的那份纯逻辑 IIFE）真的执行一遍。
 * 只有需要断言「调用发生了」的个别函数（saveAccent）用 spy 包一层。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ComponentType } from 'react'
import { loadBundle, loadLogicAsset, type LoadedBundle } from '../support/load-bundle'

/** 宿主 /models 的返回形状（SettingsView 的目录来源）。 */
const CATALOG = {
  ok: true,
  models: [
    { provider: 'deepseek', providerName: 'DeepSeek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    {
      provider: 'deepseek',
      providerName: 'DeepSeek',
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
    },
  ],
  selection: {
    provider: 'deepseek',
    providerName: 'DeepSeek',
    model: 'deepseek-chat',
    name: 'DeepSeek Chat',
    source: 'default',
  },
  lostSelection: null,
}

/** StatsView 需要的 `/stats` 数据（字段口径见 lib/store/review.mjs）。 */
const STATS = {
  words: {
    total: 120,
    byTier: [
      { tier: 'top1k', n: 40 },
      { tier: 'top3k', n: 20 },
    ],
  },
  cards: { started: 30, fresh: 5, learning: 10, review: 80, relearning: 5 },
  queue: { dueTomorrow: 7, reviewedToday: 12 },
  accuracy: { total: 8, rate: 0.75, dist: { 1: 1, 2: 2, 3: 3, 4: 2 } },
  ability: {
    recognize: [1, 2, 3, 4, 5, 6],
    meaning: [0, 1, 2, 3, 4, 5],
    write: [0, 0, 1, 2, 3, 4],
    listen: [0, 0, 0, 1, 2, 3],
    pronounce: [0, 1, 1, 2, 2, 3],
  },
  forecast: [{ date: Date.now(), count: 3 }],
  activity: [{ date: Date.now(), count: 2 }],
  hardest: [{ word: 'ephemeral', translation: '短暂的\nadj.', lapses: 3 }],
  recent: [{ word: 'ubiquitous', translation: '无处不在的', seen_at: Date.now() - 3_600_000 }],
  dbPath: '/tmp/dsh-word-learn/user.db',
}

/** SettingsView / StatsView 的 props（避免测试里出现隐式 any）。 */
interface SettingsProps {
  api: (path: string, options?: unknown) => Promise<unknown>
}
interface StatsProps {
  data: unknown
}

let bundle: LoadedBundle
let logic: Record<string, unknown>
let realSaveAccent: unknown

beforeAll(() => {
  bundle = loadBundle()
  logic = loadLogicAsset(bundle.window)
  realSaveAccent = logic.saveAccent
})

afterEach(() => {
  // spy 从句柄上摘掉；localStorage 清掉，避免上一个 case 的口音偏好串场。
  logic.saveAccent = realSaveAccent
  bundle.window.localStorage.clear()
})

describe('dist/client.js 产物契约（测试入口）', () => {
  it('loader 登记 + factory 返回 Cordis 插件面与 __test__', () => {
    expect(bundle.id).toBe('dsh-word-learn')
    expect(Array.isArray(bundle.inject)).toBe(true)
    expect(typeof bundle.apply).toBe('function')
    // 宿主模块表只该被要 react；要别的说明 external 配错（运行期就是 missed the module table）。
    expect(bundle.requireCalls).toEqual(['react'])

    for (const name of [
      'HoverWord',
      'WritePanel',
      'SettingsView',
      'StatsView',
      'VocabView',
      'WordLearnPage',
    ]) {
      expect(typeof bundle.tests[name], `__test__.${name} 应该是组件`).toBe('function')
    }
    for (const name of ['normalizeSpelling', 'editDistance', 'spellCheck']) {
      expect(typeof bundle.tests[name], `__test__.${name} 应该是纯函数`).toBe('function')
    }
  })

  it('产物的纯函数是真实实现（不依赖 window 逻辑资产）', () => {
    const normalizeSpelling = bundle.tests.normalizeSpelling as (value: string) => string
    const editDistance = bundle.tests.editDistance as (a: string, b: string) => number
    const spellCheck = bundle.tests.spellCheck as (input: string, word: string) => { state: string }
    expect(normalizeSpelling("Don't  panic!")).toBe('dontpanic')
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(spellCheck('Receive', 'receive').state).toBe('exact')
    expect(spellCheck('accomodate', 'accommodate').state).toBe('close')
  })
})

describe('SettingsView：真实组件 + 真实 dashboard-logic', () => {
  it('渲染出发音偏好 / AI 分析模型两个 section 与 select#dwl-accent-select', async () => {
    const SettingsView = bundle.tests.SettingsView as ComponentType<SettingsProps>
    const api = vi.fn(async () => CATALOG)
    let view!: RenderResult
    // act(async) 把挂载后的 /models promise 解析 + 后续 setState 一起收进 act，
    // 否则 React 19 会把这次更新报成「not wrapped in act」。
    await act(async () => {
      view = render(<SettingsView api={api} />)
    })

    expect(api).toHaveBeenCalledTimes(1)
    expect(api).toHaveBeenCalledWith('/models')

    const heads = [...view.container.querySelectorAll('.dwl-settings-section > .hd')].map(
      (node) => node.textContent,
    )
    expect(heads).toEqual(['发音偏好', 'AI 分析模型', '关于'])

    const accent = view.container.querySelector<HTMLSelectElement>('#dwl-accent-select')
    expect(accent, 'select#dwl-accent-select 应存在').not.toBeNull()
    expect(accent!.value).toBe('us')
    expect([...accent!.options].map((option) => option.value)).toEqual(['us', 'uk'])

    // 真实 modelCatalogView()：模型按 provider 分组成 optgroup。
    const model = view.container.querySelector<HTMLSelectElement>('#dwl-model-select')
    expect(model, 'select#dwl-model-select 应存在').not.toBeNull()
    expect([...model!.querySelectorAll('optgroup')].map((group) => group.label)).toEqual([
      'DeepSeek',
    ])
    expect([...model!.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'DeepSeek Chat（deepseek-chat）',
      'DeepSeek Reasoner（deepseek-reasoner）',
    ])
    // 真实 selectionText()：当前生效那行文案。
    expect(screen.getByText('当前生效：DeepSeek · DeepSeek Chat（默认：列表第一个）')).toBeTruthy()
    // 加载态的「读取 DSH 模型列表…」在数据到达后应消失。
    expect(screen.queryByText('读取 DSH 模型列表…')).toBeNull()
  })

  it('切换口音 select 触发 onChange → 调真实 saveAccent 并写进 localStorage', async () => {
    const SettingsView = bundle.tests.SettingsView as ComponentType<SettingsProps>
    const saveAccent = vi.fn(realSaveAccent as (value: string) => void)
    logic.saveAccent = saveAccent

    const api = vi.fn(async () => CATALOG)
    let view!: RenderResult
    await act(async () => {
      view = render(<SettingsView api={api} />)
    })

    const accent = view.container.querySelector<HTMLSelectElement>('#dwl-accent-select')
    expect(accent).not.toBeNull()
    expect(accent!.value).toBe('us')

    fireEvent.change(accent!, { target: { value: 'uk' } })

    expect(saveAccent).toHaveBeenCalledTimes(1)
    expect(saveAccent).toHaveBeenCalledWith('uk')
    // 受控 select 跟随 state 更新，且真实 saveAccent 把偏好落到 localStorage
    // （与划词卡片共用 dwl-voice-accent 这个 key）。
    expect(accent!.value).toBe('uk')
    expect(bundle.window.localStorage.getItem('dwl-voice-accent')).toBe('uk')
  })
})

describe('StatsView：真实组件 + 真实 statsViewModel', () => {
  it('KPI / 画像 / 最易忘词由真实取数逻辑渲染成 DOM', async () => {
    const StatsView = bundle.tests.StatsView as ComponentType<StatsProps>
    let view!: RenderResult
    await act(async () => {
      view = render(<StatsView data={STATS} />)
    })

    const kpis = screen.getByRole('group', { name: '学习概览' })
    expect(within(kpis).getByText('30')).toBeTruthy()
    expect(within(kpis).getByText('开始 / 120 词')).toBeTruthy()
    expect(within(kpis).getByText('75%')).toBeTruthy()
    expect(within(kpis).getByText('复习正确率')).toBeTruthy()
    expect(within(kpis).getByText('7')).toBeTruthy()
    expect(within(kpis).getByText('明日到期')).toBeTruthy()
    expect(within(kpis).getByText('12')).toBeTruthy()
    expect(within(kpis).getByText('今日已复习')).toBeTruthy()

    // 真实 abilityAverage()：[1,2,3,4,5,6] → 加权平均 3.33… → '均 3.3'
    expect(screen.getByText('均 3.3')).toBeTruthy()
    expect(screen.getByText('作答分布')).toBeTruthy()
    expect(screen.getByText('共 8 次')).toBeTruthy()

    // 最易忘词 / 最近遇到走真实 relTime()
    expect(screen.getByText('ephemeral')).toBeTruthy()
    expect(screen.getByText('忘 3 次')).toBeTruthy()
    expect(screen.getByText('ubiquitous')).toBeTruthy()
    expect(screen.getByText('1 小时前')).toBeTruthy()

    // 图表区与数据落盘提示都真实渲染
    expect(screen.getByText('未来 14 天到期')).toBeTruthy()
    expect(screen.getByText('近 14 天复习量')).toBeTruthy()
    expect(screen.getByText('学习进度')).toBeTruthy()
    expect(screen.getByText('数据存在 /tmp/dsh-word-learn/user.db（本地，可备份）')).toBeTruthy()
    expect(view.container.querySelector('.dwl-stats')).not.toBeNull()
    expect(view.container.querySelectorAll('.dwl-kpi').length).toBe(4)
  })
})
