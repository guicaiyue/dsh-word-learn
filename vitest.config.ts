import { defineConfig } from 'vitest/config'

/**
 * 组件测试基座（阶段 1）。
 *
 * 收 tests/component/ 与 tests/integration 两处：
 *   - 阶段 1 的目标是**证明 jsdom + RTL 能真实渲染插件组件**，不是替换全部
 *     node:test 单测；tests/ 下的 .test.mjs 那套仍由 `pnpm test:unit` 跑，
 *     两边的 glob 互不重叠（.mjs vs .tsx），一个文件不会被跑两遍。
 *   - globals: false —— 显式 import describe/it/expect，测试文件不靠隐式全局，
 *     顺带让 RTL 的自动 cleanup 失效，由 `tests/support/setup.ts` 显式接上。
 *
 * 组件本身来自构建产物 `dist/client.js` 的 `__test__`（见 load-bundle.ts），
 * 不是从 src 直接 import —— 测的是**真正会被宿主加载的那份产物**。
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: [
      'tests/component/**/*.test.{ts,tsx}',
      // 集成测试（真实 ctx 桩 + 临时 DSH_HOME + 真实 node:sqlite）。
      // 文件顶部写 `// @vitest-environment node` 覆盖本文件的 jsdom 环境。
      'tests/integration/**/*.test.ts',
    ],
    globals: false,
    setupFiles: ['tests/support/setup.ts'],
    // 每个 case 结束后自动还原被替换/被 spy 的实现，避免桩跨 case 泄漏。
    restoreMocks: true,
  },
})
