/**
 * 产物契约 + apply 装配 —— 用 jsdom + RTL 直接跑宿主会加载的那份 `dist/client.js`。
 *
 * 这组 case 回答两个问题：
 *   1. 产物入口对不对：loader 登记、只 require('react')、`__test__` 导出面齐全；
 *   2. apply 自足：样式由 bundle 自己写进 `<style data-plugin>`，卸载能摘干净，
 *      不再依赖任何注入脚本 / `window.__dwlDashboard*` 全局。
 *
 * 各视图的行为断言已拆到同目录的 views / settings-view / hover-word / write-panel
 * 等文件（一条用例只回答一个问题）；这里只留「整包装配」层。
 *
 * 取组件/逻辑的方式是 `bundle.tests`（`src/client/entry.ts` 从 plugin.js 转出的
 * `__test__`），不 import src/** —— 测的是产物，不是源码。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { loadBundle, type LoadedBundle } from '../support/load-bundle'

let bundle: LoadedBundle

beforeAll(() => {
  bundle = loadBundle()
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
