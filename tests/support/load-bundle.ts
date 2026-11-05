/**
 * 把仓库里的两个「经典 script」装进 jsdom：
 *
 *  1. `dist/client.js` —— tsdown 产物，形如
 *       window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *     顶层没有任何 import/export（宿主按 `;\n` 拼接多个 bundle，出现顶层
 *     import/export 会把后续脚本全部带崩），所以这里用 `new Function` 执行，
 *     只给它 `window` / `document` 两个形参。
 *
 *  2. `assets/dashboard-logic.js` —— 注入页面的纯逻辑 IIFE，往
 *     `window.__dwlDashboardLogic` 上挂纯函数/常量。bundle 里的组件通过
 *     `assetOf(name)` 在**渲染时**读它（故意不做模块级快照，见 plugin.js 的注释）。
 *
 * 关于 `require`：factory 的形参就是宿主的模块表查询函数，不是全局 require。
 * 这里只把 `react` 映射到真实的 React（否则 hooks/dispatcher 对不上），其余 id
 * 一律抛 `missed the module table` —— 与宿主漏配 external 时的真实报错同形。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import React from 'react'

export const PLUGIN_ID = 'dsh-word-learn'

/** 本文件所在目录（tests/support）。vitest 的 transform 会给出真实路径。 */
const HERE = import.meta.dirname || process.cwd()
/** 仓库根：tests/support -> 上两级。 */
const REPO_ROOT = path.resolve(HERE, '..', '..')

/** 构建产物位置。 */
export const BUNDLE_PATH = path.join(REPO_ROOT, 'dist', 'client.js')
/** 注入页面的纯逻辑资产。 */
export const LOGIC_ASSET_PATH = path.join(REPO_ROOT, 'assets', 'dashboard-logic.js')

/** 宿主 loader 登记的模块。 */
export interface ModuleRegistration {
  id: string
  factory: (require: (id: string) => unknown) => Record<string, unknown>
}

/** bundle 导出给测试的组件/纯函数集合（`__test__` 的形状）。 */
export interface TestExports {
  HoverWord: unknown
  WritePanel: unknown
  SettingsView: unknown
  StatsView: unknown
  VocabView: unknown
  WordLearnPage: unknown
  normalizeSpelling: unknown
  editDistance: unknown
  spellCheck: unknown
  [key: string]: unknown
}

/** 被加载脚本会读写的那几个 window 字段。 */
export interface DshWindow extends Window {
  __ModuleLoader__?: { load: (registration: ModuleRegistration) => void }
  __dwlDashboardLogic?: Record<string, unknown>
  __dwlDashboardCSS?: string
}

export interface LoadedBundle {
  /** loader 登记里的 id（应等于 package.json name）。 */
  id: string
  /** Cordis 插件面。 */
  inject: string[]
  apply: (...args: unknown[]) => unknown
  /** 测试入口：组件与纯函数。 */
  tests: TestExports
  /** 产物执行时真正 require 过的 id 序列。 */
  requireCalls: string[]
  /** 脚本所在的 jsdom window。 */
  window: DshWindow
}

function readScript(path: string, hint: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error(`读不到 ${path}。${hint}`)
  }
}

function jsdomWindow(): DshWindow {
  const win = globalThis.window as DshWindow | undefined
  if (!win || !win.document) {
    throw new Error(
      '当前测试环境没有 window/document；vitest.config.ts 的 environment 必须是 jsdom。',
    )
  }
  return win
}

/** 执行一段经典 script：没有模块包装，只有 `window` / `document` 两个形参。 */
function runClassicScript(code: string, win: DshWindow): void {
  // `new Function` 的函数体里，`window`/`document` 是形参而不是全局 —— 与真实
  // <script> 的差别仅此一处，正好把「脚本依赖哪个全局」显式化。
  const run = new Function('window', 'document', code) as (
    window: DshWindow,
    document: Document,
  ) => void
  run(win, win.document)
}

/** 宿主模块表：唯一的真实模块是 react，其余 id 走漏配报错。 */
function makeRequire(requireCalls: string[]): (id: string) => unknown {
  return (id: string) => {
    requireCalls.push(id)
    if (id === 'react') return React
    throw new Error(
      `missed the module table: "${id}" —— 该 id 不在 baseline seed 里，` +
        '产物应把它打进 bundle（tsdown.config.ts 的 deps.neverBundle 只留 11 个 seed）。',
    )
  }
}

/**
 * 加载 dist/client.js 并调用一次 factory，返回插件面与 `__test__`。
 *
 * 产物缺失时抛清晰错误，而不是悄悄绿：组件测试的前提是「构建产物存在」。
 */
export function loadBundle(): LoadedBundle {
  const win = jsdomWindow()
  const code = readScript(BUNDLE_PATH, '先跑 `npx tsdown`（或 `pnpm build`）产出 dist/client.js。')

  const registrations: ModuleRegistration[] = []
  win.__ModuleLoader__ = {
    load: (registration) => {
      registrations.push(registration)
    },
  }

  runClassicScript(code, win)

  if (registrations.length !== 1) {
    throw new Error(
      `期望恰好 1 次 window.__ModuleLoader__.load(...)，实际 ${registrations.length} 次。` +
        '产物被拼了多份，或顶层有 import/export 导致脚本提前中断。',
    )
  }
  const registration = registrations[0]
  if (typeof registration.factory !== 'function') {
    throw new Error('module registration 缺少 factory(require) 函数。')
  }

  const requireCalls: string[] = []
  const exports = registration.factory(makeRequire(requireCalls))
  if (!exports || typeof exports !== 'object') {
    throw new Error('factory 没有返回导出对象。')
  }
  const tests = exports.__test__ as TestExports | undefined
  if (!tests) {
    throw new Error('产物没有导出 __test__：确认 src/client/entry.ts 导出了它，并重新构建。')
  }

  return {
    id: registration.id,
    inject: exports.inject as string[],
    apply: exports.apply as (...args: unknown[]) => unknown,
    tests,
    requireCalls,
    window: win,
  }
}

/**
 * 加载 assets/dashboard-logic.js，返回挂在 window 上的真实逻辑对象。
 *
 * 组件通过 `assetOf()` 读全局，所以这里给的是**真的**纯逻辑（档位、统计取数、
 * 口音偏好读写……），不是手搓桩；需要断言副作用的个别函数由测试自己 spy。
 */
export function loadLogicAsset(win: DshWindow = jsdomWindow()): Record<string, unknown> {
  const code = readScript(
    LOGIC_ASSET_PATH,
    'assets/dashboard-logic.js 丢了？它是指入脚本的纯逻辑资产。',
  )
  runClassicScript(code, win)
  const logic = win.__dwlDashboardLogic
  if (!logic) {
    throw new Error('assets/dashboard-logic.js 执行后没有挂上 window.__dwlDashboardLogic。')
  }
  return logic
}
