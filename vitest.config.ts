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
      // 单元 / 特性 / 契约测试（原 node:test，ADR-0004 统一到 vitest node project）：
      // 文件顶部写 `// @vitest-environment node`，不碰 jsdom；只 import 宿主编译产物 lib/host/*.js
      // 或 src/client 的纯模块。一个文件只归一个 glob，不会双跑。
      'tests/**/*.test.mjs',
      // 集成测试（真实 ctx 桩 + 临时 DSH_HOME + 真实 node:sqlite）。
      // 文件顶部写 `// @vitest-environment node` 覆盖本文件的 jsdom 环境。
      'tests/integration/**/*.test.ts',
    ],
    globals: false,
    setupFiles: ['tests/support/setup.ts'],
    // 每个 case 结束后自动还原被替换/被 spy 的实现，避免桩跨 case 泄漏。
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      // 只量宿主编译产物：测试 import 的就是 `lib/host/*.js`（运行期真正加载的那份），
      // 覆盖它才有意义。客户端不走这里 —— 组件测试测的是 `dist/client.js` 产物，
      // 而 jsdom 覆盖不到布局/悬停/滚动分支，硬卡 src/client 的行数只会逼出假测试
      // （ADR-0005：门禁要能说出它拦的是哪个真实缺陷）。
      include: ['lib/host/**/*.js'],
      exclude: ['lib/host/index.js'],
      // 全局门槛按 2026-11-06 实测值留出余量（实测 72.81 行 / 66.09 分支 / 80.65 函数）；
      // 关键模块单独卡 95/85/95，防止「平均值涨了、关键路径其实没测」。
      thresholds: {
        lines: 70,
        branches: 62,
        functions: 78,
        'lib/host/http.js': { lines: 95, branches: 85, functions: 95 },
        'lib/host/text.js': { lines: 95, branches: 85, functions: 95 },
        'lib/host/models.js': { lines: 95, branches: 85, functions: 95 },
      },
    },
  },
})
