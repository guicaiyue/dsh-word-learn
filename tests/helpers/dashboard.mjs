/**
 * 客户端产物（dist/client.js）整文件加载器（给单测用）。
 *
 * 为什么加载产物而不是源码：过去 3 个测试从 assets/dashboard.js 里按函数名切源码再
 * `new Function`，注释/缩进/参数解构一变就碎，而且测的不是真实模块。阶段 1 起前端
 * 由 tsdown 构建（src/client/plugin.js → dist/client.js），这里直接跑构建产物：
 * 同一批 110 条断言同时成为「构建产物行为等价」的证据。
 *
 * 为什么不换成 jsdom：这一层测的是组件树与纯逻辑，不需要真实 DOM；真实 DOM 的组件
 * 测试在 `tests/component/`（vitest + jsdom + RTL）。两层并存是刻意的。
 *
 * 与真实环境的差异：没有 DOM（组件只产出元素树）、没有真网络（fetch 由测试传）。
 * 这正是组件级单测该有的边界。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const DASHBOARD = path.join(import.meta.dirname, '..', '..', 'dist', 'client.js')
// dashboard.js 消费的两个注入脚本（生产环境由 lib/index.js 按同样顺序注入）：
// 纯逻辑与 CSS 先加载，dashboard.js 的 factory 再从这里取 window.__dwlDashboard*。
const LOGIC = path.join(import.meta.dirname, '..', '..', 'assets', 'dashboard-logic.js')
const STYLE = path.join(import.meta.dirname, '..', '..', 'assets', 'dashboard-style.js')

/** 极简 React：createElement + 5 个 hooks，足够渲染这些无副作用组件。 */
export function createReactRuntime() {
  /** 当前正在渲染的组件实例状态盒。 */
  let current = null

  const h = (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
  })

  function useState(init) {
    const box = current
    const i = box.i++
    if (!(i in box.states)) box.states[i] = typeof init === 'function' ? init() : init
    return [
      box.states[i],
      (v) => {
        box.states[i] = typeof v === 'function' ? v(box.states[i]) : v
        box.dirty = true
      },
    ]
  }

  function useRef(init) {
    const box = current
    const i = box.i++
    if (!(i in box.refs)) box.refs[i] = { current: init }
    return box.refs[i]
  }

  function useEffect(fn, deps) {
    const box = current
    const i = box.i++
    const prev = box.effectDeps[i]
    // 与 React 一致：只有 deps 变化才重新执行。忽略 deps 会让
    // useEffect([load]) 每轮重渲都发一次请求（VocabView 会无限刷新）。
    if (prev && sameDeps(prev, deps)) return
    box.effectDeps[i] = deps
    box.effects.push(fn)
  }

  /**
   * useCallback 必须真的按 deps 记忆：VocabView 的 load/more 依赖它稳定，
   * 否则每次渲染都得到新函数 → useEffect([load]) 每轮重跑 → 无限重新请求。
   * 这里按 React 语义做浅比较（长度 + 逐项 ===）。
   */
  function useCallback(fn, deps) {
    const box = current
    const i = box.i++
    const prev = box.callbacks[i]
    if (prev && sameDeps(prev.deps, deps)) return prev.fn
    box.callbacks[i] = { fn, deps }
    return fn
  }

  function sameDeps(a, b) {
    if (!a || !b) return a === b
    if (a.length !== b.length) return false
    return a.every((v, i) => v === b[i])
  }

  function useMemo(fn) {
    return fn()
  }

  const React = {
    createElement: h,
    Fragment: Symbol.for('react.fragment'),
    useState,
    useRef,
    useEffect,
    useLayoutEffect: useEffect,
    useCallback,
    useMemo,
    useReducer: (reducer, init) => [init, () => {}],
  }

  /**
   * 渲染一个组件：跑组件函数 → 收集元素树 → 同步执行本轮 effect。
   * 返回渲染句柄：`render()` 重渲染，`flush()` 等异步 effect 落地。
   */
  function mount(Component, props) {
    const box = {
      i: 0,
      states: [],
      refs: {},
      effects: [],
      callbacks: [],
      effectDeps: [],
      dirty: false,
    }
    const handle = {
      tree: null,
      render() {
        box.dirty = false
        box.i = 0
        const prev = current
        current = box
        try {
          handle.tree = Component(props)
        } finally {
          current = prev
        }
        const effects = box.effects
        box.effects = []
        for (const fn of effects) fn()
        return handle.tree
      },
      /** 等一轮宏任务，让 effect 里的 fetch/await 落地，然后按需重渲染。 */
      async flush() {
        await new Promise((r) => setTimeout(r, 0))
        await new Promise((r) => setTimeout(r, 0))
        handle.render()
        return handle.tree
      },
      /**
       * 反复「等异步 → 有变更就重渲」，直到稳定或轮数用尽。
       * 组件里的 effect 会发请求再 setState，一轮往往不够。
       */
      async settle(rounds = 6) {
        for (let i = 0; i < rounds; i++) {
          await new Promise((r) => setTimeout(r, 0))
          if (!box.dirty) break
          handle.render()
        }
        return handle.tree
      },
    }
    handle.render()
    return handle
  }

  return { React, h, mount }
}

/** 元素树工具：深度遍历、按条件查找、取纯文本。 */
export function walk(node, visit) {
  if (node == null || node === false) return
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit)
    return
  }
  if (typeof node !== 'object') {
    visit(node)
    return
  }
  visit(node)
  walk(node.props && node.props.children, visit)
}

export function findAll(tree, pred) {
  const out = []
  walk(tree, (n) => {
    if (n && typeof n === 'object' && pred(n)) out.push(n)
  })
  return out
}

export function findByClass(tree, className) {
  return findAll(tree, (n) => n.props && n.props.className === className)
}

export function textOf(node) {
  let s = ''
  walk(node, (n) => {
    if (typeof n === 'string' || typeof n === 'number') s += String(n)
  })
  return s
}

/**
 * 加载 dist/client.js 整个模块。
 * @param {{fetch?: Function, window?: object}} [options] 测试提供的替身
 * @returns {object} 模块导出对象（含 `__test__`）
 */
export function loadDashboard(options = {}) {
  const code = fs.readFileSync(DASHBOARD, 'utf8')
  const logicCode = fs.readFileSync(LOGIC, 'utf8')
  const styleCode = fs.readFileSync(STYLE, 'utf8')
  const { React, mount } = createReactRuntime()
  // 最小事件总线：注入脚本（logic/style）就绪后 dispatch dwl:assets-ready，
  // dashboard.js 侧要能收到并补渲染 —— 普通刷新竞态就靠它恢复。
  const listeners = new Map()
  const win = {
    innerWidth: 1200,
    innerHeight: 800,
    localStorage: options.localStorage || {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type)
      if (set) set.delete(fn)
    },
    dispatchEvent(evt) {
      for (const fn of [...(listeners.get(evt.type) || [])]) fn(evt)
      return true
    },
    ...(options.window || {}),
  }
  // 极简 <head>：dashboard.js 的样式 effect 会 createElement('style') 再 appendChild，
  // 测试要能断言「样式元素真的出现了、内容非空、卸载时被移除」。
  const headChildren = []
  const fakeDocument = {
    createElement() {
      const el = {
        style: {},
        dataset: {},
        textContent: '',
        appendChild() {},
        remove() {
          const i = headChildren.indexOf(el)
          if (i !== -1) headChildren.splice(i, 1)
        },
      }
      return el
    },
    head: {
      appendChild(el) {
        headChildren.push(el)
      },
    },
    body: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    get _styles() {
      return headChildren.map((el) => (el.textContent || '').length)
    },
  }
  const sandbox = {
    window: win,
    document: options.document || fakeDocument,
    localStorage: win.localStorage,
    fetch: options.fetch || (async () => ({ status: 200, json: async () => ({ ok: true }) })),
    setTimeout,
    clearTimeout,
    console,
    URL,
    // VocabView 用 new URLSearchParams 拼 /list 查询串；浏览器一定有，替身要补上，
    // 否则组件在测试里跟真实环境不是同一份能力（会直接 ReferenceError）。
    URLSearchParams,
    // 就绪信号与兜底轮询用到的浏览器能力（logic/style 的 dispatch + apply 的监听）。
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type
        this.detail = (init || {}).detail
      }
    },
    setInterval,
    clearInterval,
  }
  win.__ModuleLoader__ = {
    load(def) {
      sandbox.__module = def
    },
  }
  vm.createContext(sandbox)
  // 先注入纯逻辑/样式（与生产的注入顺序一致），再加载 dashboard.js 本体。
  // deferAssets: 模拟「DSH 自己的 client 入口先 apply、我们的注入脚本后到」的
  // 普通刷新竞态 —— 由测试稍后手动 injectAssets() 补上。
  if (!options.deferAssets) {
    vm.runInContext(logicCode, sandbox, { filename: 'assets/dashboard-logic.js' })
    vm.runInContext(styleCode, sandbox, { filename: 'assets/dashboard-style.js' })
  }
  vm.runInContext(code, sandbox, { filename: 'dist/client.js' })
  const def = sandbox.__module
  if (!def || typeof def.factory !== 'function') {
    throw new Error('dist/client.js 没有走 window.__ModuleLoader__.load({ factory })')
  }
  const mod = def.factory((name) => {
    if (name === 'react') return React
    throw new Error('dashboard.js 只允许 require("react")，实际 require(' + name + ')')
  })
  if (!mod || !mod.__test__) {
    throw new Error('dashboard.js 缺少 __test__ 导出（单测入口）')
  }
  // 挂上运行时与源码：组件测试要 mount，源码级断言（不许 new Audio 等）要原文。
  // __source__ 拼上逻辑/样式两段注入脚本：它们与 dashboard.js 一起构成页面侧客户端，
  // 源码级约束（发音走 __dwlVoice 等）应按整个客户端算，不是只看 dashboard.js。
  mod.__helpers__ = { mount, React }
  if (options.deferAssets) {
    // 竞态测试入口：先让 dashboard.js 的工厂/apply 跑起来，再注入全局并靠事件恢复。
    mod.__helpers__.injectAssets = () => {
      vm.runInContext(logicCode, sandbox, { filename: 'assets/dashboard-logic.js' })
      vm.runInContext(styleCode, sandbox, { filename: 'assets/dashboard-style.js' })
    }
    mod.__helpers__.window = win
    mod.__helpers__.document = sandbox.document
  }
  mod.__source__ = code + '\n' + logicCode + '\n' + styleCode
  return mod
}
