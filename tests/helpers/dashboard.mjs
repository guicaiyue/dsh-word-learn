/**
 * dashboard.js 整文件加载器（给单测用）。
 *
 * 为什么不切片：过去 3 个测试从 assets/dashboard.js 里按函数名切源码再 `new Function`，
 * 该注释/缩进/参数解构一变就碎，而且测的不是真实模块。这里用 `vm` 把整个
 * 客户端模块跑起来，提供最小 React + fetch 替身，从模块的 `__test__` 取组件。
 *
 * 与真实环境的差异：没有 DOM（组件只产出元素树）、没有真网络（fetch 由测试传）。
 * 这正是组件级单测该有的边界。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const DASHBOARD = path.join(import.meta.dirname, '..', '..', 'assets', 'dashboard.js')

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

  function useEffect(fn) {
    current.effects.push(fn)
  }

  function useCallback(fn) {
    return fn
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
    const box = { i: 0, states: [], refs: {}, effects: [], dirty: false }
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
 * 加载 dashboard.js 整个模块。
 * @param {{fetch?: Function, window?: object}} [options] 测试提供的替身
 * @returns {object} 模块导出对象（含 `__test__`）
 */
export function loadDashboard(options = {}) {
  const code = fs.readFileSync(DASHBOARD, 'utf8')
  const { React, mount } = createReactRuntime()
  const win = {
    innerWidth: 1200,
    innerHeight: 800,
    localStorage: options.localStorage || {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    ...(options.window || {}),
  }
  const sandbox = {
    window: win,
    document: options.document || {
      createElement: () => ({ style: {}, dataset: {}, appendChild() {}, remove() {} }),
      head: { appendChild() {} },
      body: {},
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    localStorage: win.localStorage,
    fetch: options.fetch || (async () => ({ status: 200, json: async () => ({ ok: true }) })),
    setTimeout,
    clearTimeout,
    console,
    URL,
  }
  win.__ModuleLoader__ = {
    load(def) {
      sandbox.__module = def
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'assets/dashboard.js' })
  const def = sandbox.__module
  if (!def || typeof def.factory !== 'function') {
    throw new Error('dashboard.js 没有走 window.__ModuleLoader__.load({ factory })')
  }
  const mod = def.factory((name) => {
    if (name === 'react') return React
    throw new Error('dashboard.js 只允许 require("react")，实际 require(' + name + ')')
  })
  if (!mod || !mod.__test__) {
    throw new Error('dashboard.js 缺少 __test__ 导出（单测入口）')
  }
  // 挂上运行时与源码：组件测试要 mount，源码级断言（不许 new Audio 等）要原文。
  mod.__helpers__ = { mount, React }
  mod.__source__ = code
  return mod
}
