# 静态检测体系审计报告（2026-11-05）

- 对象：`dsh-word-learn` @ `662f6f4`（审计时工作树干净）
- 范围：`eslint.config.js`、`scripts/check-cycles.mjs`、覆盖率门槛、`tests/` 与 `scripts/test-*.mjs` 两套测试体系、`tests/helpers/dashboard.mjs` 的 vm/React 替身、`pnpm verify` 链路、文档一致性
- 方法：只读仓库；全部实验在 `.scratch/`（12 个 max-lines 夹具、15 个环形态夹具、6 种 import-x 配置、4 个构建器 bench、vitest PoC）；真实浏览器复验用 bsk 与运行中的 DSH Web
- 结论一句话：**这套门禁主要约束「形状」，本轮 6 个真实缺陷 0 个由它抓到；构建立项后应删除约 4/5 的自研门禁，改用类型、依赖图、产物契约与行为测试。**

---

## 1. 真缺陷归因：门禁的实际战果

| #   | 真实缺陷                                                        | 发现渠道               | 预算 | 环检测 | 覆盖率门槛 | 协议测试 |
| --- | --------------------------------------------------------------- | ---------------------- | :--: | :----: | :--------: | :------: |
| 1   | 21/25 条路由未声明 `methods`，GET 可触发写操作                  | 真机同源 fetch         |  ✗   |   ✗    |     ✗      |    ✗     |
| 2   | 普通刷新白屏（client 先 apply、模块工厂期快照 `window.__dwl*`） | 真机（仅普通刷新复现） |  ✗   |   ✗    |     ✗      |    ✗     |
| 3   | 注入脚本 `async` 默认 true，41KB 样式脚本晚于 client → 无样式   | 真机                   |  ✗   |   ✗    |     ✗      |    ✗     |
| 4   | 老库 `CREATE INDEX` 早于 `migrate()`，缺列老库打不开            | 真实 P1 老库迁移单测   |  ✗   |   ✗    |     ✗      |    ✗     |
| 5   | 队列 `disposed` 不可重置，热重挂后 AI 分析静默失效              | 真机 HMR 观察          |  ✗   |   ✗    |     ✗      |    ✗     |
| 6   | 临时脚本污染真实用户库                                          | 人工 review            |  ✗   |   ✗    |     ✗      |    ✗     |

- 命中率 **0/6**；预算/环/覆盖率上线后**从未产生过真实告警**。
- 三条有效渠道：真机浏览器（3）、真实数据形态的集成测试（1）、人工 review（1）、真机 HMR（1）。
- 值得注意：`inject-order.test` / `dashboard-refresh.test` 是给已踩的 #2/#3 **事后补的形状断言**，不是发现者；它们保护的是一个本不该存在的机制。

---

## 2. 门禁逐条裁定

| 门禁                                                        | 想防什么                       | 实际防住                                                                              | 构建化后是否成立                              | 裁定                                                  |
| ----------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| `CODE_BUDGET` max-lines 棘轮（12 条 + 默认 400）            | 巨型单体                       | 形状；但它把「不能 import」的后果（手工注入协议）催生了                               | 不成立：边界由 import 图保证                  | **删除**                                              |
| `no-restricted-imports`（lib 禁 assets）                    | 宿主 import 浏览器 IIFE        | 静态形态 ✓、绝对路径 ✓、**动态 import ✗**、反向 lib→tests 未设                        | 由 tsc 双 tsconfig + depcruise 接管           | **删除/迁移**                                         |
| `no-restricted-globals`（assets 禁 require/process/module） | 浏览器脚本误用 Node 全局       | ✓（唯一稳定的正确性规则）                                                             | 由 tsconfig `types` + `platform:browser` 接管 | **保留/改造**                                         |
| 颜色/主题令牌规则                                           | 写死颜色、判 `data-theme=dark` | **规则不存在**（仅文档承诺）                                                          | 仍需要（暗色主题可读性）                      | **新增**（stylelint 或 no-restricted-syntax，~30 行） |
| 三区划分（lib / assets / scripts+tests / config）           | 语境正确                       | 部分：`scripts/test-voice-fixture/cases.js`（426 行）生效规则 **0 条**却算「已 lint」 | 以 tsconfig project 边界为主                  | **改造**（加 default zone + 零规则断言）              |
| Prettier                                                    | 排版                           | ✓                                                                                     | 不变                                          | **保留**                                              |
| `scripts/check-cycles.mjs` + 其单测                         | import 环                      | 9/15 夹具；**真实仓库漏 6 条边**                                                      | 不成立                                        | **删除，换 dependency-cruiser**                       |
| 覆盖率门槛（3 文件）                                        | 覆盖率不倒退                   | 只锁 3 个文件=现状快照                                                                | 不成立                                        | **删除，换全域阈值**                                  |
| `inject-order.test`（181 行）                               | 注入顺序不坏                   | ✓ 但测的是协议                                                                        | 协议删除                                      | **删除**                                              |
| `dashboard-refresh.test`（102 行）                          | 刷新竞态不复发                 | ✓ 但测的是补丁                                                                        | 协议删除                                      | **删除**                                              |
| ESLint 正确性规则（no-var/eqeqeq/no-unused-vars/no-empty…） | 低级错误                       | ✓                                                                                     | 仍成立                                        | **保留**                                              |

自研门禁代码 **977 行 → 约 170 行**。

---

## 3. 关键数据（每项都有可复现实验，详见 `.scratch/audit/`）

### 3.1 max-lines 口径

12 个夹具中 11 个与手算一致；**1 个真偏差**：`skipBlankLines` 会把**模板字符串内的空行**也当空行丢掉。真实受害者 `assets/dashboard-style.js`（CSS 模板串）有 **21 个空行不被计数**（报 500，预算 509）。

> 含义：这个指标对「代码」正确，对「字符串里塞样式」测的不是行数；而样式文件恰恰被单列了预算。

### 3.2 环检测的漏报与误报

- 真实仓库 **6 条边看不见**：`lib/ai-enrich.mjs` 5 条、`lib/routes/shared.mjs` 1 条——因为检测器**只匹配 `import`，完全不匹配 `export ... from`**。本次重构刻意引入的两个「纯再导出门面」正好落在盲区。
- 提取器缺陷：`export {x} from` / `export * from` / `import()` 模板串或变量 / `require` / 无空格 import 全漏；**块注释与模板串里的假 import 却会被当成真边**（误报）。
- 扫描范围 `collectFiles(['lib'])` 硬编码，`CONVENTIONS §4.4` 声称的「tests/scripts 对 lib 的引用也不许成环」**未实现**（夹具 `case-cross-dir` 全量能检出、仓库实跑为 `[]`）。

### 3.3 「import-x 在 ESLint 10 下不工作」是误判

独立装 eslint@10.14 + eslint-plugin-import-x@4.17.1，6 种配置实测：

| 配置                                    | 结果                                     |
| --------------------------------------- | ---------------------------------------- |
| 显式 `no-cycle` + node resolver         | ✅ 检出                                  |
| 显式 `no-cycle`、无 resolver            | ✅ 检出                                  |
| `createNodeResolver()`                  | ✅ 检出                                  |
| `.mjs`+`.js` 混合                       | ✅ 检出                                  |
| 只铺 `flatConfigs.recommended`          | ❌ 不报（**recommended 不含 no-cycle**） |
| `files:['lib/**/*.mjs']` 而夹具在根目录 | ❌ 不报（**glob 不匹配**）               |

结论：规则可用，前任是配置错误。但也不建议换回 import-x：它仍漏别名/require/动态模板（12/15），耗时 4–5.5s。

### 3.4 检测器选型对比（同机同夹具）

| 工具                   | 15 夹具检出 |                               真实仓库耗时 | 能力                              |
| ---------------------- | ----------: | -----------------------------------------: | --------------------------------- |
| 自研 check-cycles      |        9/15 |                                      0.85s | 只 lib、只 import、正则           |
| import-x no-cycle      |       12/15 |                                     4–5.5s | 无别名/require                    |
| madge                  |        9/15 |                                   2.1–3.0s | 同类正则缺陷                      |
| **dependency-cruiser** |   **15/15** | 0.56s（lib）；3.6s（lib+tests+scripts 冷） | TS/别名/jsx/require/动态/分层规则 |

用目标分层规则跑当前仓库：**72 模块 / 205 依赖 / 0 违规**——意味着新规则可以立即全开，不需要 baseline 白名单。

### 3.5 覆盖率

| 口径                 |     行 |   分支 |   函数 |
| -------------------- | -----: | -----: | -----: |
| 门槛包住的 3 个文件  |   100% |  97.4% |   100% |
| lib/ 全量（单测）    | 69.26% | 73.12% | 56.78% |
| `assets/`（8283 行） |   不计 |      — |      — |

33 个 lib 文件里 17 个从未被单测加载（`store/review.mjs` 13.6%、`store/words.mjs` 32.6%、`schedule.mjs` 52.2%、`enrich/llm.mjs` 59.9%）；它们靠不计入门槛的 11 个 legacy 脚本覆盖。

### 3.6 verify 各段耗时（37s 基线）

| 段                                           |  耗时 | 占比 |
| -------------------------------------------- | ----: | ---: |
| lint                                         |  8.6s |  23% |
| format:check                                 | 10.0s |  27% |
| check:cycles                                 |  0.9s |   2% |
| test:unit（110 用例）                        |  3.6s |  10% |
| test:unit:coverage（同一批用例**再跑一遍**） |  6.3s |  17% |
| test:legacy（11 脚本）                       | 10.3s |  28% |

> 其中「同一批 110 用例跑两遍」是纯浪费 3.6s，且两次结果可能不一致。

---

## 4. 测试体系（详见 `.scratch/audit/tests.md`，352 行）

- 110 个 `node:test` 用例（24 套、359 次断言、1767 行），`test:unit` 墙钟 3.59s。
- 11 个手写脚本（3812 行、约 566 条检查），`test:legacy` 10.3s。
- 两套体系**断言重叠 <15%**：不是「重复」，是「纯函数/组件（快）」与「真实 DB/HTTP/浏览器（慢）」的层级分工；重复的是**基建**（两个运行时、两套断言风格、两种隔离方式）与 `models` 一处语义。
- `tests/helpers/dashboard.mjs` 320 行可删约 **295 行（92%）**，且它有三个**代码级硬伤**：`useRef` 永不赋 DOM（14 处 ref 路径被静默跳过）、14 个 `useEffect` cleanup 从未执行、`useMemo` 每次重算（比真 React 宽松 → 缺依赖 bug 假绿）。
- PoC 已验证：vitest + jsdom + RTL 能真实渲染现有组件（5/5 通过）；甚至无需构建就能直接 import 现有 IIFE 资产（2/2）。
- 迁移工作量：最小可用（单测迁 vitest）3–4 人天；全量 7–9 人天。
- DSH_HOME 现状：121 条用例/脚本路径**零污染**，但缺**全局无条件守卫**（`schema.mjs` 在 import 期就固化真实路径，实测）。

---

## 5. 构建契约与选型（详见 `.scratch/audit/build.md`，455 行）

### 5.1 DSH 客户端契约（源码证据）

- 产物 = 经典 `<script>` 里的**单个 lazy factory**：`window.__ModuleLoader__.load({id: 包名, factory:(require)=>{…return module.exports}})`（`dsh-client-modules/lib/client.js:1-7`；官方 `dsh-client-ui-deepseek-model-label-1017/lib/client.js:1-7` 同形）；**不能有顶层 ESM**（宿主按 `;\n` 拼接）。
- React 等 **11 个 baseline externals** 来自宿主冻结模块表（`dsh-web-frontend/.../index-BXV-oxvX.js:190`：react、react/jsx-runtime、react-dom、react-dom/client、cordis、zod、react-virtual、client-store、ui-slots、ui-primitives、ui-dockkit）；`dsh.client.external` 只声明**非 baseline 的其它插件包**。
- 注入方式为 classic script + `__DSH_BOOT__` 全局，无 import map；`immediately` 只是启动预取，materialize 仍懒。
- sourcemap **只认外置** `client.js.map`（v3），宿主剥 trailer 后拼 indexed map；inline 无效。
- 路径 = `dirname(package.json) + exports["./client"]`；link 安装时 `files` 不参与，发包时必须含 `dist`。

### 5.2 「deployment's Client build tooling」= tsdown

官方 **77/77** 个带 bundle 脚本的客户端包都用 tsdown；loader 源码注释原文「Source-map trailer emitted by tsdown」；HMR 文档称「shared Client tsdown preset」。

### 5.3 四工具实测（203KB 输入、8 模块 + 双入口、各 3 次取中位）

| 工具               |    冷构建 |                watch | raw / gzip      | 结论                                                    |
| ------------------ | --------: | -------------------: | --------------- | ------------------------------------------------------- |
| **tsdown 0.15.12** |  929.5 ms |               296 ms | 304.3 / 28.9 KB | **选它**（同源、零适配、保留未来 `require.async` 分块） |
| tsup 8.5.1         | 1913.8 ms | 331 ms（吞首次编辑） | 310.7 / 28.8 KB | 无一项占优                                              |
| esbuild 0.25.12    |  541.7 ms |               188 ms | 310.7 / 28.8 KB | 最快，但需自维护壳与 map 尾部，无分块协议               |
| vite 7.3.7         |   3956 ms | 734 ms（全量重打包） | 295.2 / 21.4 KB | 定位是应用，逆着用                                      |

四者产物均通过 16 项契约验证。**最大陷阱**：tsdown/tsup 会把 `dependencies` 自动 external 化（实测 `ts-fsrs` 险落空 → 运行期 `missed the module table`）；必须显式 `external`=11 个 seed + `noExternal` 收口。`ts-fsrs` 不应进客户端（+82 KB raw / +18.4 KB gzip）。

### 5.4 客户端 HMR 已实测

`touch assets/dashboard.js` 后 4 秒内，浏览器发出新的 `/plugins/??dsh-word-learn/client.js&rev=<新 hash>` 并自动重挂（`dsh-client-hmr` 每 500ms stat 产物 → SSE `rebuilt` → 浏览器 `entries.reload`）。**构建化后前端改动的回路比现在更快**（不需要硬刷新、不需要重新激活插件）。

---

## 6. 文档漂移

- `CONVENTIONS §4.1` 预算表的数字**准确**（40 文件逐行核对，误差 0），但只覆盖 17 个文件/组，23 个隐含默认预算，读者看不出 `lib/store/words.mjs`（308/400）已近红线。
- 13 个 commit 里 **3 个是纯文档对齐**（23%），最近一次提交正文自承「文档里的注入顺序、预算数字、模块归口全部过期」。
- 根因：把易变数据（行数/行号/注入顺序）写进需要长期有效的规范文档，且**没有任何机制**保证不过期（无生成脚本、无 CI 断言）。
- 处置：规范文档只写稳定规则；易变数据由脚本生成或删除。

---

## 7. 裁定汇总

**删除**：`CODE_BUDGET`/max-lines、`check-cycles.mjs`+其单测、3 文件覆盖率清单、`inject-order.test`、`dashboard-refresh.test`（随协议）、`test:legacy` 形态（迁入 vitest）。

**改造**：三区划分（加 default zone + 零规则断言）、`no-restricted-globals`→tsconfig types + depcruise、`no-restricted-imports`→depcruise 双向规则。

**保留**：ESLint 正确性规则、Prettier。

**新增**：`tsc --noEmit`、dependency-cruiser（环+分层+纯度）、vitest + jsdom/RTL（unit/component/integration/contract）、产物契约检查（单 factory/id/无 `node:`/体积）、locale 键一致测试、颜色令牌规则、客户端 bundle 体积预算（唯一保留的预算类门禁）。

**维护成本**：自研门禁 977 行 → 约 170 行；门禁耗时约 19.5s → 约 18s，但覆盖面从「3 个文件 + 形状」扩展到「全仓库类型 + 依赖方向 + 产物 + 行为」。

**误报估计**：现状 0（因为几乎不报）；新方案迁移期 0（已实测 72 模块 0 违规），稳定期预计 ≤2 条/月（分层规则的合法例外），须以 ADR/注释登记而非 disable。

---

## 8. 未覆盖 / 剩余风险

1. 颜色令牌规则、locale 键一致、产物契约目前只有方案，尚未落地（阶段 1 实施）。
2. dependency-cruiser 对 `.ts` 别名解析需在阶段 1 用真实 `src/` 验证（当前只验证了 JS）。
3. 构建后 bundle 体积会随功能增长；预算需在阶段 2 复测。
4. vitest 迁移会短期出现「旧测试删了、新测试还没补齐」的空窗；要求逐条对照断言清单，PR 附覆盖对照表。
5. 真机验收无法进 CI，仍依赖人工/Agent + 运行中的 DSH。
