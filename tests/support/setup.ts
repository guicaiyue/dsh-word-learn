/**
 * 组件测试的全局兜底。
 *
 * jsdom 与真实浏览器的差距收敛在这里，别散到各个 case 里：
 *   - `matchMedia` / `ResizeObserver`：jsdom 没有，写「响应式」组件时一碰就崩；
 *   - `IS_REACT_ACT_ENVIRONMENT`：React 19 的 act 环境标记；
 *   - `afterEach(cleanup)`：`globals: false` 时 RTL 不会自动注册清理，显式接上，
 *     否则上一个 case 的 DOM 残留会让 `screen.getByText` 撞到重名节点。
 *
 * 刻意不做的事：不设 `DSH_HOME`、不碰文件系统 —— 组件测试只渲 DOM，
 * 不写用户库（CONVENTIONS §9.2 的临时 DSH_HOME 是给 e2e 脚本的）。
 */
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// React 19：没有这个标记时，RTL 里的 act() 会报「environment not configured」。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    })
  }

  if (typeof window.ResizeObserver !== 'function') {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      value: ResizeObserverStub,
    })
  }
}

afterEach(() => {
  cleanup()
})
