/**
 * 安装型模块（installWordcard / installAnnotate）的装卸语义 —— real DOM（jsdom）。
 *
 * 为什么单独测：这两个模块在 `apply()` 的 `ctx.effect` 里装卸，HMR 每次重挂都会
 * 走一遍 dispose → install。旧的手搓替身测不到这件事（它没有真实 document/window，
 * 也不执行 effect cleanup），所以「装两次叠两套监听/两套样式」这类缺陷一直漏网。
 *
 * 断言口径：
 *   - 幂等：安装中再装一次拿回**同一个** dispose，DOM/监听都不增加；
 *   - 卸载干净：卡片、<style> 都摘掉，document/window 上的净监听数回到安装前；
 *   - 可重装：dispose 后再次 install 拿**新** dispose，DOM 只有一份、净监听数与
 *     第一次安装后**完全相同**（叠加就会多出来）。
 *
 * 直接 import `src/client/features/**`：install 函数不在产物 `__test__` 里，而它
 * 正是被测对象；组件行为已经全部走 dist 产物测。annotate 首次扫描要拉词表，
 * 这里把 `window.fetch` 打成"有词"的桩（不联网），避免它进入 60s 重试分支。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWordcard } from '../../src/client/features/wordcard/index.js'
import { installAnnotate } from '../../src/client/features/annotate/index.js'

/** document/window 上的净监听数（add - remove），用来判断"有没有叠加"。 */
function trackListeners(): { net: () => number; adds: () => number } {
  const docAdd = vi.spyOn(document, 'addEventListener')
  const docRemove = vi.spyOn(document, 'removeEventListener')
  const winAdd = vi.spyOn(window, 'addEventListener')
  const winRemove = vi.spyOn(window, 'removeEventListener')
  const adds = () => docAdd.mock.calls.length + winAdd.mock.calls.length
  const net = () =>
    docAdd.mock.calls.length -
    docRemove.mock.calls.length +
    (winAdd.mock.calls.length - winRemove.mock.calls.length)
  return { net, adds }
}

let disposeCurrent: (() => void) | null = null

beforeEach(() => {
  // annotate 启动即拉标注词表；给一份非空的假词表，避免进入 60s 重试。
  ;(window as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      words: [{ w: 'model', t: '模型', s: 'n.', c: 3 }],
      rev: 'fixture-1',
      total: 1,
      truncated: false,
    }),
  }))
})

afterEach(() => {
  disposeCurrent?.()
  disposeCurrent = null
  vi.restoreAllMocks()
  delete (window as unknown as { fetch?: unknown }).fetch
  document.body.innerHTML = ''
  document.head.querySelectorAll('#dwl-style, #dwl-anno-style').forEach((node) => node.remove())
})

describe('installWordcard', () => {
  it('install → 幂等 → dispose → 再 install：卡片/样式不叠加、监听数回基线', () => {
    const { net, adds } = trackListeners()
    const baseline = net()

    disposeCurrent = installWordcard()
    expect(document.querySelectorAll('.dwl-card')).toHaveLength(1)
    expect(document.querySelectorAll('#dwl-style')).toHaveLength(1)
    expect(adds()).toBeGreaterThan(0)

    // 安装中再装：返回同一个 dispose，DOM 与监听都不增加（HMR 重挂时最常见）
    const firstNet = net()
    expect(installWordcard()).toBe(disposeCurrent)
    expect(document.querySelectorAll('.dwl-card')).toHaveLength(1)
    expect(document.querySelectorAll('#dwl-style')).toHaveLength(1)
    expect(net()).toBe(firstNet)

    disposeCurrent()
    disposeCurrent = null
    expect(document.querySelectorAll('.dwl-card'), '卸载后卡片必须摘掉').toHaveLength(0)
    expect(document.querySelectorAll('#dwl-style'), '卸载后样式必须摘掉').toHaveLength(0)
    expect(net(), '卸载后监听数应回到安装前').toBe(baseline)

    // 卸载后允许重装：拿到新 dispose，但 DOM 只有一份、监听数与第一次安装后相同
    disposeCurrent = installWordcard()
    expect(document.querySelectorAll('.dwl-card')).toHaveLength(1)
    expect(document.querySelectorAll('#dwl-style')).toHaveLength(1)
    expect(net(), '重装后监听数必须与第一次安装后相同（叠加会多）').toBe(firstNet)
  })

  it('dispose 可重复调用，不会误删重装后的实例状态', () => {
    const d1 = installWordcard()
    d1()
    d1() // 幂等：再调一次不抛
    disposeCurrent = installWordcard()
    expect(document.querySelectorAll('.dwl-card')).toHaveLength(1)
    expect(document.querySelectorAll('#dwl-style')).toHaveLength(1)
  })
})

describe('installAnnotate', () => {
  it('install → 幂等 → dispose → 再 install：样式/监听不叠加', () => {
    const { net, adds } = trackListeners()
    const baseline = net()

    disposeCurrent = installAnnotate()
    expect(document.querySelectorAll('#dwl-anno-style'), '安装后应写入标注层样式').toHaveLength(1)
    expect(adds()).toBeGreaterThan(0)
    const firstNet = net()

    // 幂等：装两次不叠加监听、不叠样式
    expect(installAnnotate()).toBe(disposeCurrent)
    expect(document.querySelectorAll('#dwl-anno-style')).toHaveLength(1)
    expect(net()).toBe(firstNet)

    disposeCurrent()
    disposeCurrent = null
    expect(document.querySelectorAll('#dwl-anno-style'), '卸载后样式必须摘掉').toHaveLength(0)
    expect(document.querySelectorAll('.dwl-anno'), '卸载后标注 span 不应残留').toHaveLength(0)
    expect(net(), '卸载后监听数应回到安装前').toBe(baseline)

    // 重装：样式只有一份，监听数与第一次安装后相同
    disposeCurrent = installAnnotate()
    expect(document.querySelectorAll('#dwl-anno-style')).toHaveLength(1)
    expect(net(), '重装后监听数必须与第一次安装后相同（叠加会多）').toBe(firstNet)
  })

  it('dispose 可重复调用；关闭开关后重装不启动（只装开关监听，不写样式）', () => {
    disposeCurrent = installAnnotate()
    disposeCurrent()
    disposeCurrent = null

    window.localStorage.setItem('dwl-annotate', 'off')
    const offNet = trackListeners()
    disposeCurrent = installAnnotate()
    // 开关关着：install 只挂 storage/自定义事件监听，start() 不跑 → 不写样式
    expect(document.querySelectorAll('#dwl-anno-style')).toHaveLength(0)
    expect(offNet.net()).toBeGreaterThan(0)
    window.localStorage.removeItem('dwl-annotate')
  })
})
