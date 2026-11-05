/**
 * HoverWord（易混淆词的悬浮释义）—— 真实 React 渲染（jsdom + RTL）。
 *
 * 迁移自 `scripts/test-hoverword.mjs`（整文件 vm 加载 + 手搓 React 运行时），
 * 断言逐条保留：
 *   - 初始只渲染词、不弹卡片；
 *   - 点击 → GET /lookup?word=…&enrich=false&save=false（预览不写库、不打外部例句）；
 *   - 卡片里有音标 + 释义；
 *   - 点「加入生词本」→ POST /lookup {word, enrich:false, save:true}，卡片变成「已在生词本」；
 *   - 另一个词同样能渲染。
 *
 * 额外补一条卸载断言：卡片开着时 unmount 不留 DOM、不残留定时器（旧替身测不到清理语义）。
 *
 * fetch 用全局 stub（LOGIC.api 走 `fetch`），绝不联网。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ComponentType } from 'react'
import { loadBundle, type LoadedBundle } from '../support/load-bundle'

interface HoverWordProps {
  word: string
}
interface FetchCall {
  url: string
  options: { method?: string; body?: string }
}

const DICT = {
  word: 'adapt',
  phonetic: 'əˈdæpt',
  senses: [{ pos: 'v.', text: '适应；改编' }],
}

let bundle: LoadedBundle
let calls: FetchCall[]

beforeAll(() => {
  bundle = loadBundle()
})

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, options: FetchCall['options'] = {}) => {
      calls.push({ url: String(url), options })
      const body =
        options.method === 'POST'
          ? { ok: true, dict: DICT, saved: { seenCount: 1 } }
          : { ok: true, dict: DICT, saved: null }
      return { ok: true, json: async () => body }
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderWord(word: string): RenderResult {
  const HoverWord = bundle.tests.HoverWord as ComponentType<HoverWordProps>
  return render(<HoverWord word={word} />)
}

const trigger = (word: string) =>
  screen.getByRole('button', { name: `${word}：停留查看释义` }) as HTMLElement

/** 点开悬浮词：onClick 里 setOpen + 发起 GET，一起收进 act。 */
async function open(word: string): Promise<HTMLElement> {
  await act(async () => {
    trigger(word).click()
  })
  return screen.getByRole('dialog', { name: `${word} 的释义` })
}

describe('HoverWord', () => {
  it('初始只渲染词，不弹卡片', () => {
    const view = renderWord('adapt')
    expect(view.container.textContent?.trim()).toBe('adapt')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('点击浮出释义（音标 + 释义），查询用 save=false / enrich=false', async () => {
    const view = renderWord('adapt')
    const card = await open('adapt')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/dsh-word-learn/lookup?word=adapt')
    expect(calls[0].url).toContain('save=false') // 预览必须 save=false（只看不记）
    expect(calls[0].url).toContain('enrich=false') // 预览不打外部例句接口

    const text = card.textContent || ''
    expect(text).toContain('adapt')
    expect(text).toContain('/əˈdæpt/')
    expect(text).toContain('适应；改编')
    expect(text).not.toContain('已在生词本')

    // 卡片出现在词的下方/上方都行，但必须有定位（hoverPlacement 兜底到 8px）
    expect((card as HTMLElement).style.width).toBe('300px')

    // 卸载后 DOM 不残留（定时器由组件 cleanup 清掉）
    view.unmount()
    expect(document.querySelector('.dwl-hovercard')).toBeNull()
  })

  it('点「加入生词本」→ POST 写库，卡片显示已在生词本', async () => {
    renderWord('adapt')
    await open('adapt')
    expect(within(screen.getByRole('dialog')).getByText('＋ 加入生词本')).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: '＋ 加入生词本' }).click()
    })

    const post = calls.find((call) => call.options.method === 'POST')
    expect(post, '应发 POST 加入生词本').toBeTruthy()
    expect(post!.url).toBe('/dsh-word-learn/lookup')
    expect(JSON.parse(post!.options.body || '{}')).toEqual({
      word: 'adapt',
      enrich: false,
      save: true,
    })
    expect(screen.getByText('✓ 已在生词本 · 遇见 1 次')).toBeTruthy()
  })

  it('另一个词的卡片同样能渲染', async () => {
    renderWord('latent')
    const card = await open('latent')
    expect(card.textContent).toContain('/əˈdæpt/')
    // 未加入前给的是"加入生词本"入口
    expect(within(card).getByText('＋ 加入生词本')).toBeTruthy()
  })

  it('同一张卡片再次点击会收起（open 状态是组件内 state）', async () => {
    renderWord('adapt')
    await open('adapt')
    expect(screen.queryByRole('dialog')).not.toBeNull()

    await act(async () => {
      trigger('adapt').click()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
