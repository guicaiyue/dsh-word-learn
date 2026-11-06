/**
 * 标注层悬停卡的「锚点消失」生命周期 —— real DOM（jsdom）。
 *
 * 为什么单独测：卡片挂在 `document.body` 上，脱离对话流；切到学习页/换会话时
 * React 会整棵卸载 `[data-chat-flow]`，**没有任何鼠标事件**，`mouseout`/`focusout`
 * 都等不到。没有「锚点已卸载就收卡」这条兜底，卡片会孤零零悬在新页面上
 * （2026-11-06 真机发现，修复见 `dropCardIfDetached()`）。
 *
 * 断言口径：
 *   - 悬停已标注的词 → 卡片打开（`data-open="1"`），锚点是那个 span；
 *   - 把整棵对话流从 DOM 里移除（模拟切页）→ 此后一个 microtask 内卡片必须收起
 *     （`data-open="0"` 且锚点清空），不能靠鼠标移出。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installAnnotate, internals } from '../../src/client/features/annotate/index.js'

const { CONFIG } = internals as unknown as {
  CONFIG: { STABLE_MS: number; DEBOUNCE_MS: number }
}

const FLOW = `
  <div data-chat-flow>
    <div data-chat-node-key="k1" data-chat-flow-kind="assistant-step">
      <div data-slot="conversation.chat.node">
        <p>The model is stable.</p>
      </div>
    </div>
  </div>
`

let dispose: (() => void) | null = null
const savedMs = { STABLE_MS: CONFIG.STABLE_MS, DEBOUNCE_MS: CONFIG.DEBOUNCE_MS }

/** 轮询到条件成立（真实计时器；jsdom 里没有布局，必须给块可视尺寸）。 */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${message}`)
}

beforeEach(() => {
  CONFIG.STABLE_MS = 0
  CONFIG.DEBOUNCE_MS = 0
  document.body.innerHTML = FLOW
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 400, height: 20, top: 10, bottom: 30, left: 0, right: 400 }) as DOMRect
  ;(window as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      words: [{ w: 'model', t: 'n. 模型', s: '', c: 2 }],
      rev: 'fixture-card',
      total: 1,
      truncated: false,
    }),
  }))
})

afterEach(() => {
  dispose?.()
  dispose = null
  CONFIG.STABLE_MS = savedMs.STABLE_MS
  CONFIG.DEBOUNCE_MS = savedMs.DEBOUNCE_MS
  delete (window as unknown as { fetch?: unknown }).fetch
  document.body.innerHTML = ''
  document.head.querySelectorAll('#dwl-anno-style').forEach((node) => node.remove())
})

describe('标注悬停卡：锚点被卸载后必须收起', () => {
  it('悬停打开卡片 -> 移除整棵对话流 -> 卡片收起、锚点清空', async () => {
    dispose = installAnnotate()
    await waitFor(
      () => document.querySelectorAll('.dwl-anno').length > 0,
      '标注层应该已经在对话正文里标出 model',
    )

    const span = document.querySelector('.dwl-anno') as HTMLElement
    expect(span.textContent).toBe('model')
    span.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))

    const card = await waitFor(() => {
      const el = document.querySelector('.dwlac') as HTMLElement | null
      return el && el.getAttribute('data-open') === '1' ? el : null
    }, '悬停后卡片应该打开').then(() => document.querySelector('.dwlac') as HTMLElement)
    expect(card).toBeTruthy()

    // 模拟切页：React 把整棵对话流卸载，鼠标没有移动、没有 mouseout。
    document.querySelector('[data-chat-flow]')?.remove()

    await waitFor(
      () => {
        const el = document.querySelector('.dwlac') as HTMLElement | null
        return !!el && el.getAttribute('data-open') === '0'
      },
      '对话流被卸载后卡片应该自动收起（不依赖鼠标移出）',
      1000,
    )
  })
})
