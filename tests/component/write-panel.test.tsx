/**
 * WritePanel（看中文拼英文）—— 真实 React 渲染（jsdom + RTL）。
 *
 * 迁移自 `scripts/test-write-panel.mjs`（整文件 vm 加载 + 手搓 React 运行时）。
 * 断言逐条保留：
 *   - 拼写比对 15 条表（含"拼成另一个真词不能算对"这类关键分支）→ `it.each`；
 *   - 提交前不露答案 / 空输入不能提交 → 可见文案 + 按钮 disabled；
 *   - 输错给正确拼写并锁输入框 → 可见文案 + `readOnly` + `data-state`；
 *   - onReveal 只在提交后触发一次；回车提交；"下一个"回传判定结果 → 回调 spy。
 *
 * 组件与纯函数都取自 `dist/client.js` 的 `__test__`（测产物，不 import src/**）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ComponentType } from 'react'
import { loadBundle, type LoadedBundle } from '../support/load-bundle'

interface SpellResult {
  state: string
  distance: number
}
interface WritePanelProps {
  item: { word: string; phonetic?: string; translation?: string }
  senses?: unknown
  onFinish?: (result: SpellResult) => void
  onReveal?: () => void
}

const ITEM = { word: 'daemon', phonetic: 'ˈdiːmən', translation: 'n. 守护进程' }
const SENSES = { lead: 'n. 守护进程', rest: [] }

/** 15 条拼写判定，原样来自 legacy 脚本（表驱动，一条一个 case，红的时候一眼知道是哪条）。 */
const SPELL_CASES: Array<[string, string, string]> = [
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

let bundle: LoadedBundle

beforeAll(() => {
  bundle = loadBundle()
})

function renderPanel(overrides: Partial<WritePanelProps> = {}): RenderResult {
  const WritePanel = bundle.tests.WritePanel as ComponentType<WritePanelProps>
  return render(<WritePanel item={ITEM} senses={SENSES} onFinish={() => {}} {...overrides} />)
}

const input = () => screen.getByRole('textbox', { name: '写出对应的英文单词' })
const button = (name: string) => screen.getByRole('button', { name })

describe('拼写比对（纯函数）', () => {
  it.each(SPELL_CASES)('%j vs %j → %s', (typed, word, want) => {
    const spellCheck = bundle.tests.spellCheck as (input: string, word: string) => SpellResult
    expect(spellCheck(typed, word).state).toBe(want)
  })

  it('规范化只留字母、编辑距离按 Levenshtein', () => {
    const normalizeSpelling = bundle.tests.normalizeSpelling as (value: string) => string
    const editDistance = bundle.tests.editDistance as (a: string, b: string) => number
    expect(normalizeSpelling('A-b c!')).toBe('abc')
    expect(editDistance('kitten', 'sitting')).toBe(3)
  })
})

describe('WritePanel 渲染与交互', () => {
  it('提交前：有输入框、不露答案、空输入不能提交', () => {
    const view = renderPanel()
    expect(screen.getByText('看中文，写出对应的英文单词')).toBeTruthy()
    expect(view.container.textContent).not.toContain('daemon')
    expect(input()).toBeTruthy()
    expect((button('提交') as HTMLButtonElement).disabled).toBe(true)
  })

  it('输错：给出正确拼写、锁定输入框；onReveal 只在提交后触发一次', () => {
    const onReveal = vi.fn()
    const onFinish = vi.fn()
    const view = renderPanel({ onReveal, onFinish })

    fireEvent.change(input(), { target: { value: 'deamon' } })
    expect(onReveal).not.toHaveBeenCalled()
    expect((button('提交') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(button('提交'))

    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).toContain('没写对')
    expect(view.container.textContent).toContain('daemon')
    const after = input() as HTMLInputElement
    expect(after.readOnly).toBe(true)
    expect(after.getAttribute('data-state')).toBe('miss')
    // 结算后提交按钮不可再点
    expect((button('提交') as HTMLButtonElement).disabled).toBe(true)
    // 还没点"下一个"，不该提前回调 onFinish
    expect(onFinish).not.toHaveBeenCalled()
  })

  it('正确：回车提交判 exact，"下一个"把结果交回去', () => {
    const onFinish = vi.fn()
    const view = renderPanel({ onFinish })
    fireEvent.change(input(), { target: { value: '  Daemon ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(view.container.textContent).toContain('拼对了')

    fireEvent.click(button('下一个'))
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(onFinish).toHaveBeenCalledWith({ state: 'exact', distance: 0 })
  })

  it('小笔误：判 close，"下一个"回传 close', () => {
    const onFinish = vi.fn()
    const view = renderPanel({ onFinish })
    fireEvent.change(input(), { target: { value: 'daemn' } })
    fireEvent.click(button('提交'))
    expect(view.container.textContent).toContain('差一点')

    fireEvent.click(button('下一个'))
    expect(onFinish).toHaveBeenCalledWith({ state: 'close', distance: 1 })
  })

  it('结算后再按回车 = 下一个（不会重复提交）', () => {
    const onFinish = vi.fn()
    renderPanel({ onFinish })
    fireEvent.change(input(), { target: { value: 'daemon' } })
    fireEvent.keyDown(input(), { key: 'Enter' }) // 提交
    fireEvent.keyDown(input(), { key: 'Enter' }) // 结果已在 → next
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(onFinish).toHaveBeenCalledWith({ state: 'exact', distance: 0 })
  })
})
