# ADR-0004：测试体系 —— vitest + jsdom/RTL，删除 vm 替身与 legacy 脚本

- 状态：提议（等待用户批准）
- 日期：2026-11-05
- 相关：ADR-0001、ADR-0003、ADR-0005

## 背景

现有测试是「零构建」的产物：

- `tests/unit/*.test.mjs`：110 个 `node:test` 用例，其中前端组件的用例靠 `tests/helpers/dashboard.mjs`（320 行）用 `node:vm` 整文件加载 `assets/dashboard.js`，手搓 React hooks（useState/useEffect/useMemo/useCallback/useRef）、`CustomEvent`、`setInterval`、假 `head`、`fetch` 桩、虚拟 DOM 树遍历。测的是「手搓替身 + 真实模块」的混合体，不是真实 React 渲染。
- `scripts/test-*.mjs`：11 个手写断言脚本（`scripts/test-all.mjs` 串行收编，8.9s），部分是真正有价值的集成回归（`test-routes` 667 行、`test-annotate` 566 行、`test-scope` 362 行、`test-voice` 等），部分与单测重叠。
- 覆盖率只卡 `lib/http.mjs` / `lib/text.js` / `lib/models.mjs` 三个文件（行 95 / 分支 85 / 函数 95），当前恰好 100%，是「现状快照」而不是质量杠杆。
- 本轮 5 个真缺陷里，唯一由测试抓到的是「用真实 P1 老库跑迁移回归」——这恰好说明：**值钱的是集成级、真实数据形态的测试，不是形状约束**。

社区先例（本机可读）：`@anionex/dsh-vision-toolkit` 用 `vitest 4.1.8 + jsdom 29 + @testing-library/react 16 + TypeScript 6`；`dsh-context` 同样 vitest。工具链与 DSH 生态一致。

## 决策

1. **统一 vitest 4**，两个 project：
   - `node`：host 单元 + store/domain 集成（真实 `node:sqlite` 临时库）。
   - `jsdom`：client 组件（RTL 真实 React 渲染）+ DOM 交互。
2. **目录**：`tests/unit`（宿主纯函数）、`tests/component`（前端视图/交互）、`tests/integration`（路由 + 真实 ctx 桩 + 临时 DSH_HOME）、`tests/contract`（产物契约、locale 键一致、路由 methods/栅栏不变量）。
3. **React 从 node_modules 直接 import**：源码写真实 ESM `import`，构建时才把 react external 成 `require('react')`。测试里就是真 React，不再有 vm/hooks 替身。
4. **删除**：`tests/helpers/dashboard.mjs`（整文件）、`scripts/test-*.mjs`（逐条迁移或合并为 vitest 集成用例）、`scripts/test-all.mjs`、`test:legacy` 脚本。迁移后断言覆盖不得减少（逐条对照清单落在 PR 里）。
5. **覆盖率**：v8 provider，全局阈值 `lines 80 / branches 70 / functions 80`（排除 entry/composition/纯样式常量），关键纯模块（`shared/params`、`host/domain/schedule`、`host/store/schema`、`client/dashboard/logic`）单文件 90%；CI 上传 coverage。
6. **真实浏览器不替代**：组件测试绿 != 真机可用。每阶段仍有真机清单（普通刷新 ×5、硬刷新、划词、标注、学习页四 tab、HMR），证据落盘（截图/JSON/console）。E2E 用 Playwright 作为本地可选 `pnpm test:e2e`，不进默认 verify（需要运行中的 dsh 与鉴权）。
7. 迁移顺序：阶段 1 先让 vitest 基座跑通（新写 2–3 个示例），`node:test` 继续跑；阶段 3 全量迁移并删除旧体系。

## 后果

- 删除约 320 行 vm 替身 + 约 3k 行手写脚本（按审计报告 §5 的实际统计），替换为更少但更真实的用例；短期工作量约 2–3 人天（审计报告给分档）。
- 组件测试获得真实 hooks 语义（依赖数组、清理函数、并发渲染），能抓到 vm 替身抓不到的清理/竞态缺陷——这正是阶段 2 删除「加载顺序协议」后最需要守的东西。
- 集成测试需要真实 `ctx.webServer` 桩；在 `tests/integration/support/` 维护一份最小桩（register/tapIndex/fence 语义），避免每次手写。

## 备选方案

| 方案                            | 结论                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| node:test + jsdom + RTL         | 可行且少装依赖，但组件断言/覆盖率/快照生态弱，社区插件无人用 |
| vitest browser mode（真浏览器） | 成本高、CI 重；作为 Playwright E2E 的补充而非替代            |
| Playwright 全面替代组件测试     | 太慢，且调试成本高；只用于本地可选 E2E                       |

选 vitest + jsdom/RTL。
