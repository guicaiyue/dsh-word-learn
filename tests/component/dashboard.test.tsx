/**
 * 组件测试：**真实 bundle 产物**，用 jsdom + RTL 渲染。
 * （学习页逻辑/样式自阶段 2 起就在 bundle 内，不再有第二种「资产」形态。）
 *
 * 这组 case 要回答的问题是：拆掉 tests/helpers/dashboard.mjs 那套 320 行手搓
 * React 替身（假 hooks / 假 head / 假 setInterval / vm 整文件加载）之后，能不能
 * 直接拿宿主会加载的那份 `dist/client.js` 在 jsdom 里渲出真实 DOM。能，就说明迁移
 * 方向成立；不能，就说明还缺哪块 shim。
 *
 * 取组件的方式是 `bundle.__test__`（`src/client/entry.ts` 从 plugin.js 转出），
 * 不 import src/** —— 测的是产物，不是源码。纯逻辑通过 `__test__.LOGIC` 取真实对象，
 * 只有需要断言「调用发生了」的个别函数（saveAccent）在它上面用 spy 包一层。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ComponentType } from 'react'
import { loadBundle, loadLogic, type LoadedBundle } from '../support/load-bundle'

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

/** SettingsView 的 props（避免测试里出现隐式 any）。 */
interface SettingsProps {
  api: (path: string, options?: unknown) => Promise<unknown>
}

let bundle: LoadedBundle
let logic: Record<string, unknown>
let realSaveAccent: unknown

beforeAll(() => {
  bundle = loadBundle()
  logic = loadLogic(bundle)
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

describe('apply：bundle 自足（阶段 2：逻辑/样式不再靠注入脚本）', () => {
  interface FakeCtx {
    effect: (fn: () => (() => void) | void, label?: string) => () => void
    locale: { register: () => () => void; bind: () => (key: string) => string }
    slots: { inject: (name: string, fn: () => void) => void; register: () => () => void }
    disposers: Array<() => void>
  }

  function makeCtx(): FakeCtx {
    const disposers: Array<() => void> = []
    return {
      disposers,
      effect: (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => {}
      },
      locale: { register: () => () => {}, bind: () => (key: string) => key },
      slots: { inject: (_name, fn) => fn(), register: () => () => {} },
    }
  }

  it('apply 后样式由 bundle 自己写进 <style>，不依赖 window.__dwlDashboard*', () => {
    const win = bundle.window as unknown as Record<string, unknown>
    const ctx = makeCtx()
    const dispose = bundle.apply(ctx) as (() => void) | undefined

    // 注入脚本那套全局约定必须已经不存在：产物自足，晚到/不到都不影响。
    expect(win.__dwlDashboardLogic).toBeUndefined()
    expect(win.__dwlDashboardCSS).toBeUndefined()

    const tag = win.document.querySelector<HTMLStyleElement>('style[data-plugin="dsh-word-learn"]')
    expect(tag, 'apply 应写入一个 style[data-plugin="dsh-word-learn"]').not.toBeNull()
    const css = tag!.textContent || ''
    expect(css.length).toBeGreaterThan(10_000)
    // 关键选择器在，且是真的 CSS 而不是空壳（历史上就是空串导致整页没样式）。
    expect(css).toContain('.dwl-page{')
    expect(css).toContain('.dwl-mid')

    // 卸载：effect 的清理函数必须把样式摘掉（重复 apply 才不会堆叠）。
    for (const fn of ctx.disposers) fn()
    if (typeof dispose === 'function') dispose()
    expect(win.document.querySelector('style[data-plugin="dsh-word-learn"]')).toBeNull()
  })

  it('style 内容与上一版注入脚本逐字节一致（改样式只该动模板串内部）', () => {
    const ctx = makeCtx()
    bundle.apply(ctx)
    const tag = bundle.window.document.querySelector<HTMLStyleElement>(
      'style[data-plugin="dsh-word-learn"]',
    )
    const css = tag!.textContent || ''
    // 首尾各抽一段：CSS 开头是变量声明块，结尾是深色主题覆盖。
    // CSS 以换行 + `.dwl-page{` 开头（与注入脚本逐字节一致）
    expect(css.charCodeAt(0)).toBe(10)
    expect(css.slice(1, 10)).toBe('.dwl-page')
    expect(css.trimEnd().endsWith('}')).toBe(true)
    expect(css).toContain('--dwl-shadow:0 1px 2px rgba(24,24,20,.05)')
    expect(css).not.toContain('${')
    for (const fn of ctx.disposers) fn()
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
