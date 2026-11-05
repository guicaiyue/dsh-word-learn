/**
 * SettingsView（发音偏好 / AI 分析模型 / 关于）—— 真实 React 渲染（jsdom + RTL）。
 *
 * 迁移自 `scripts/test-settings-ui.mjs`（vm 加载 + 手搓 React 运行时），并把
 * `dashboard.test.tsx` 里两条只属于设置页的用例一并搬来。断言逐条保留：
 *   - 三个 section、口音 select 默认 us（美式/英式两项）、自动发音默认开；
 *   - 模型目录按 provider 分成 optgroup，select 用下标做 value，默认第一个；
 *   - 「当前生效：…」文案来自真实 selectionText()，标注是否"默认"；自选态出「恢复默认」；
 *   - 改选 → POST /model {provider, model}，成功后界面跟着变；
 *   - 空目录 / 读失败 / 模型丢失 / 加载中四种分支各给对应文案；
 *   - 口音切换真的落到 localStorage（与划词卡片共用 key）；自动发音同理。
 *
 * 组件来自 `dist/client.js`；宿主 API 用 `api` prop 注入（等价于真实 ctx 注入），不联网。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ComponentType } from 'react'
import { loadBundle, loadLogic, type LoadedBundle } from '../support/load-bundle'

interface SettingsProps {
  api: (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
}
interface ApiCall {
  path: string
  options?: { method?: string; body?: unknown }
}

/** 宿主 /models 的 models[] 项（id 是模型 id，name 是展示名）。 */
const MODELS = [
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
]

/**
 * selection 的形状来自 src/host/models.ts 的 publicSelection()：
 * 字段是 `model`（模型 id）而不是 `id`，前端靠 provider+model 反查下标。
 */
const DEFAULT_SELECTION = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  providerName: 'DeepSeek 官方',
  source: 'default',
}
const CUSTOM_SELECTION = {
  provider: 'other',
  model: 'other-large',
  name: 'Other Large',
  providerName: '别家',
  source: 'custom',
}

/** 宿主 /models 的响应（见 logic.js 的 modelCatalogView）。 */
const CATALOG = { ok: true, models: MODELS, selection: DEFAULT_SELECTION }

let bundle: LoadedBundle
let logic: Record<string, unknown>
let realSaveAccent: unknown
let realSaveAutoSpeak: unknown

beforeAll(() => {
  bundle = loadBundle()
  logic = loadLogic(bundle)
  realSaveAccent = logic.saveAccent
  realSaveAutoSpeak = logic.saveAutoSpeak
})

afterEach(() => {
  logic.saveAccent = realSaveAccent
  logic.saveAutoSpeak = realSaveAutoSpeak
  bundle.window.localStorage.clear()
})

/** 按路径分派的宿主 API 桩；calls 记录每次调用的 path/options。 */
function makeApi(routes: Record<string, unknown>): { api: SettingsProps['api']; calls: ApiCall[] } {
  const calls: ApiCall[] = []
  const api: SettingsProps['api'] = (path, options) => {
    calls.push({ path, options })
    const result = routes[path]
    if (result === undefined) throw new Error('意外请求 ' + path)
    return typeof result === 'function'
      ? (result as () => Promise<unknown>)()
      : Promise.resolve(result)
  }
  return { api, calls }
}

/** 渲染并等 `/models` 落地（Loading → 数据态都在 act 内完成）。 */
async function renderSettings(api: SettingsProps['api']): Promise<RenderResult> {
  const SettingsView = bundle.tests.SettingsView as ComponentType<SettingsProps>
  let view!: RenderResult
  await act(async () => {
    view = render(<SettingsView api={api} />)
  })
  return view
}

const select = (view: RenderResult, id: string) =>
  view.container.querySelector<HTMLSelectElement>('#' + id)

describe('SettingsView：结构与默认态', () => {
  it('三个 section + 口音 select 默认 us + 自动发音默认开', async () => {
    const { api, calls } = makeApi({ '/models': CATALOG })
    const view = await renderSettings(api)

    expect(calls[0]).toEqual({ path: '/models', options: undefined })

    const heads = [...view.container.querySelectorAll('.dwl-settings-section > .hd')].map(
      (node) => node.textContent,
    )
    expect(heads).toEqual(['发音偏好', 'AI 分析模型', '关于'])

    const accent = select(view, 'dwl-accent-select')
    expect(accent, 'select#dwl-accent-select 应存在').not.toBeNull()
    expect(accent!.value).toBe('us')
    expect([...accent!.options].map((option) => option.value)).toEqual(['us', 'uk'])

    const autoSpeak = view.container.querySelector<HTMLInputElement>('#dwl-auto-speak')
    expect(autoSpeak, '#dwl-auto-speak 应存在').not.toBeNull()
    expect(autoSpeak!.type).toBe('checkbox')
    expect(autoSpeak!.checked).toBe(true)
    expect(view.container.textContent).toContain('自动发音')
    expect(view.container.textContent).toContain('都会自动读一遍')
  })

  it('模型目录：按 provider 分组、select 用下标、默认第一个生效', async () => {
    const { api } = makeApi({ '/models': CATALOG })
    const view = await renderSettings(api)

    const model = select(view, 'dwl-model-select')
    expect(model, 'select#dwl-model-select 应存在').not.toBeNull()
    expect(model!.value).toBe('0')
    expect([...model!.querySelectorAll('optgroup')].map((group) => group.label)).toEqual([
      'DeepSeek 官方',
      '别家',
    ])
    expect([...model!.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'DeepSeek V4 Flash（deepseek-v4-flash）',
      'DeepSeek V4（deepseek-v4）',
      'Other Large（other-large）',
    ])
    expect(
      screen.getByText('当前生效：DeepSeek 官方 · DeepSeek V4 Flash（默认：列表第一个）'),
    ).toBeTruthy()
    // 默认态没有"恢复默认"可点（本来就是默认）
    expect(screen.queryAllByRole('button', { name: '恢复默认（第一个）' }).length).toBe(0)
    // 加载态的「读取 DSH 模型列表…」在数据到达后消失
    expect(screen.queryByText('读取 DSH 模型列表…')).toBeNull()
  })

  it('自选态：下拉指向自选模型，并出现「恢复默认（第一个）」', async () => {
    const { api } = makeApi({
      '/models': { ...CATALOG, selection: CUSTOM_SELECTION },
    })
    const view = await renderSettings(api)

    expect(select(view, 'dwl-model-select')!.value).toBe('2')
    expect(screen.getByText('当前生效：别家 · Other Large')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '恢复默认（第一个）' }).length).toBe(1)
  })
})

describe('SettingsView：改选 / 恢复默认', () => {
  it('改选 → POST /model {provider, model}，成功后"当前生效"跟着变', async () => {
    const { api, calls } = makeApi({
      '/models': CATALOG,
      // 保存成功：宿主回传新的 publicSelection（source=custom → 界面不再标"默认"）
      '/model': {
        ok: true,
        selection: {
          ...DEFAULT_SELECTION,
          model: 'deepseek-v4',
          name: 'DeepSeek V4',
          source: 'custom',
        },
      },
    })
    const view = await renderSettings(api)

    const model = select(view, 'dwl-model-select')!
    await act(async () => {
      fireEvent.change(model, { target: { value: '1' } })
    })

    const post = calls.find((call) => call.path === '/model')
    expect(post, '改选应发 POST /model').toBeTruthy()
    expect(post!.options).toEqual({
      method: 'POST',
      body: { provider: 'deepseek-official', model: 'deepseek-v4' },
    })
    expect(screen.getByText('当前生效：DeepSeek 官方 · DeepSeek V4')).toBeTruthy()
  })

  it('点「恢复默认」→ POST /model {reset:true}，回到默认文案', async () => {
    const { api, calls } = makeApi({
      '/models': { ...CATALOG, selection: CUSTOM_SELECTION },
      '/model': { ok: true, selection: DEFAULT_SELECTION },
    })
    const view = await renderSettings(api)
    expect(screen.getByText('当前生效：别家 · Other Large')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '恢复默认（第一个）' }))
    })

    const post = calls.find((call) => call.path === '/model')
    expect(post!.options).toEqual({ method: 'POST', body: { reset: true } })
    expect(
      screen.getByText('当前生效：DeepSeek 官方 · DeepSeek V4 Flash（默认：列表第一个）'),
    ).toBeTruthy()
    expect(view.container.querySelectorAll('#dwl-model-select').length).toBe(1)
  })
})

describe('SettingsView：异常分支不白屏', () => {
  it('空目录：说明跟随会话默认模型，不渲染空下拉', async () => {
    const { api } = makeApi({
      '/models': {
        ok: true,
        models: [],
        selection: { provider: 'agent', model: 'agent-model', name: 'Agent', source: 'agent' },
      },
    })
    const view = await renderSettings(api)
    expect(view.container.textContent).toMatch(
      /还没有可用的文本模型.*暂时跟随会话默认模型（Agent）/,
    )
    expect(view.container.querySelectorAll('#dwl-model-select').length).toBe(0)
  })

  it('读取失败：直接显示错误，不白屏', async () => {
    const { api } = makeApi({
      '/models': { ok: false, error: 'DSH 模型服务不可用（ctx.llm 缺失）' },
    })
    const view = await renderSettings(api)
    expect(view.container.textContent).toContain('DSH 模型服务不可用（ctx.llm 缺失）')
  })

  it('模型丢失：提示旧选择已失效、现按默认第一个', async () => {
    const { api } = makeApi({
      '/models': {
        ...CATALOG,
        lostSelection: { provider: 'deepseek-official', model: 'retired-model' },
      },
    })
    const view = await renderSettings(api)
    expect(view.container.textContent).toMatch(/retired-model 已不在 DSH 模型目录里/)
    expect(select(view, 'dwl-model-select')!.value).toBe('0')
  })

  it('加载中：显示「读取 DSH 模型列表…」', async () => {
    const { api } = makeApi({ '/models': () => new Promise(() => {}) })
    const SettingsView = bundle.tests.SettingsView as ComponentType<SettingsProps>
    let view!: RenderResult
    await act(async () => {
      view = render(<SettingsView api={api} />)
    })
    expect(screen.getByText('读取 DSH 模型列表…')).toBeTruthy()
    expect(view.container.querySelectorAll('#dwl-model-select').length).toBe(0)
  })
})

describe('SettingsView：本地偏好写盘', () => {
  it('切换口音 → saveAccent 被调用并写进 localStorage（与划词卡片共用 key）', async () => {
    const saveAccent = vi.fn(realSaveAccent as (value: string) => void)
    logic.saveAccent = saveAccent

    const { api } = makeApi({ '/models': CATALOG })
    const view = await renderSettings(api)
    const accent = select(view, 'dwl-accent-select')!
    expect(accent.value).toBe('us')

    fireEvent.change(accent, { target: { value: 'uk' } })

    expect(saveAccent).toHaveBeenCalledTimes(1)
    expect(saveAccent).toHaveBeenCalledWith('uk')
    expect(accent.value).toBe('uk')
    expect(bundle.window.localStorage.getItem('dwl-voice-accent')).toBe('uk')
  })

  it('关闭自动发音 → saveAutoSpeak(false) + localStorage 记 0，说明文案同步切换', async () => {
    const saveAutoSpeak = vi.fn(realSaveAutoSpeak as (on: boolean) => void)
    logic.saveAutoSpeak = saveAutoSpeak

    const { api } = makeApi({ '/models': CATALOG })
    const view = await renderSettings(api)
    const box = view.container.querySelector<HTMLInputElement>('#dwl-auto-speak')!

    fireEvent.click(box)

    expect(saveAutoSpeak).toHaveBeenCalledTimes(1)
    expect(saveAutoSpeak).toHaveBeenCalledWith(false)
    expect(box.checked).toBe(false)
    expect(bundle.window.localStorage.getItem('dwl-auto-speak')).toBe('0')
    expect(view.container.textContent).toContain('已关闭：只有点喇叭（或按 S）才会发音。')
  })
})
