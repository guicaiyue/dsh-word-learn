# 提示词模板：写测试

## 适用场景

- 新增功能要配套测试：{{功能，例如"评分后补记债的记录与清偿"}}；
- 修 bug 要补回归（先跟 `fix-bug.md` 的步骤 3 对齐）；
- 给某个模块从"只能整文件跑"改成可重跑的断言（用本模板选层）。

先选层，选错层会写出一堆跑得慢又抓不到 bug 的测试：

| 层       | 位置                                                 | 跑什么                                                               | 适合                                                  | 不适合                       |
| -------- | ---------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| 单元测试 | `tests/unit/*.test.mjs`（`node --test`）             | 宿主纯函数、模块契约、排期字段映射、文本判断                         | 纯逻辑，不需要 ctx/HTTP                               | 需要 `ctx`/真实页面结构      |
| 前端特性 | `tests/features/*.test.mjs`（`node --test`）         | 直接 import `src/client/features/*` 的纯函数与 `installXxx` 生命周期 | 范围判定、标注规则、发音协议                          | 需要真实 DOM/布局/渲染       |
| 契约测试 | `tests/contract/*.test.mjs`（`node --test`）         | 产物源码级不变量、locale 键一致                                      | 产物/配置类的"永久契约"                               | 行为分支                     |
| 组件测试 | `tests/component/*.test.tsx`（vitest + jsdom + RTL） | 渲染 `dist/client.js` 的真实 React 组件（从 `__test__` 取）          | 视图文案/role/回调/提交的 fetch 载荷、install→dispose | 宿主路由、真实网络、真实布局 |
| 集成测试 | `tests/integration/*.test.ts`（vitest，node 环境）   | 真实 `ctx` 桩 + 临时 `DSH_HOME` + 真实 `node:sqlite` + `lib/host/**` | 22 条路由、写库路径、模型路由、R5/排期                | 只测一个纯函数（太重）       |

## 先读什么（别跳）

| 文件                                    | 位置（按符号搜）                     | 为什么                                                              |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `tests/integration/support/tmp-home.ts` | 全文                                 | 临时 `DSH_HOME` 的标准写法 + canary（为什么必须在 import 前）       |
| `tests/integration/support/ctx-stub.ts` | 导出面                               | 宿主 `ctx`/`req`/`res` 的语义桩，路由测试直接复用，别手搓           |
| `tests/integration/support/db.ts`       | `openTempStore` / `openTempDatabase` | 真实 `node:sqlite` 临时库；建表走宿主 schema，不手抄 DDL            |
| `tests/support/load-bundle.ts`          | 全文                                 | 把 `dist/client.js` 装进 jsdom，返回 `__test__`；组件测试的入口     |
| `tests/component/dashboard.test.tsx`    | 全文                                 | 真实 React 渲染范例：`act(async)` 收 promise、fetch 打桩、`cleanup` |
| `tests/features/scope.test.mjs`         | 全文                                 | 直接 import 真实模块求值的范例（不复制实现）                        |
| `CONVENTIONS.md`                        | §9 测试                              | 三个层次、硬规则、覆盖率现状、何时必须有测试                        |
| 被测模块                                | 文件头 + 导出清单                    | 先知道它的输入输出与已知坑                                          |

## 步骤

1. **写清"这条测试能抓到什么 bug"**。抓不到的测试是负担；不确定就先别写。
2. **隔离环境**（会写库/会 import 宿主模块的）：用
   `tests/integration/support/tmp-home.ts` 的 `createTempHome()`，**必须在 import 宿主模块之前**
   （`src/host/store/schema.ts` 在 import 那一刻按 `DSH_HOME` 定库路径），结束 `cleanup()`。
   它自带 canary：库路径必须落在临时 home、绝不能是真实 `~/.dsh`。
   不要用"没设才临时"的判断（宿主导出过 `DSH_HOME`）。
3. **挡住外部世界**：LLM 用假 `ctx`（带 `get()` 返回假 llm）、`fetch`/`window.fetch` 打桩、
   发音注入假 synth（不要真发声）、翻译用已落盘缓存或桩。测试必须能在断网机器上跑。
4. **写断言**：
   - node:test：`import assert from 'node:assert/strict'`，每条断言带中文信息且能独立读懂：
     `assert.equal(got, 'child', 'children 应回退到原形 child，实际得到 ' + got)`。
     不要 `console.log` 后目测，不要 `assert.ok(x)` 这种信息量低的写法。
   - vitest 组件层：`expect` + RTL 查询（`getByRole`/`getByText`/`fireEvent`），断言
     **用户可见行为**，不要断言元素树 props。
   - vitest 集成层：`expect` + 真实 `ctx` 桩，断言状态码/响应体/库内容，不打印后目测。
5. **先跑一次确认**：新断言若应捕获已知 bug，要先看到红；纯新增覆盖则要先绿。
6. **登记入口**：不需要登记——`pnpm test:unit` 按 `tests/**/*.test.mjs` 收，
   `pnpm test:component` 按 `vitest.config.ts` 的 include 收 `tests/component/**` 与
   `tests/integration/**`。新增**产物类**契约放 `tests/contract/`（node:test，由 `test:unit` 跑）；
   不要往 `scripts/` 加测试——那里只留产物/包清单/词典构建。
7. 跑验证。

## 硬约束

- **禁止真实用户库**：任何会写库的路径都必须 `createTempHome()`；真实 `user.db` 不可再生。
- **禁止真实网络**：不许打真实翻译/LLM/TTS/例句接口，也不许把网络失败当断言通过条件。
- **不许复制被测逻辑**：node:test 直接 import 真实模块；组件层渲染真实产物 `dist/client.js`
  的 `__test__`。不要手搓 React 替身、不要按函数名切字符串。
- **组件/集成测试前先 `pnpm build`**（vitest 读 `dist/client.js` 与 `lib/host/**`）。
- 不许用 `setTimeout` 等固定时间当**同步手段**；防抖/节流这类真实计时器只能等它的真实窗口
  （留余量），并用"结果出现"作为断言条件，不要拿等待本身当完成信号。
- 不许为了让测试过而改产品代码的语义；发现产品代码有问题就回到 bug/重构流程。
- 断言信息中文；失败时要能直接看出"哪个输入、期望什么、实际什么"。
- 覆盖率现状：只有 `lib/host/{http,text,models}.js` 三个模块有门槛（95/85/95），全局覆盖率
  还没有统一门禁（node:test 与 vitest 两份运行不合并）——补测试是为了行为，不是刷数字。

## 必须执行的验证

```bash
pnpm build                          # unit 层读 lib/host/**、组件/集成读 dist/client.js 与 lib/host/**
npx vitest run tests/component/xxx.test.tsx   # 组件：先单跑
npx vitest run tests/integration/xxx.test.ts  # 集成：先单跑
pnpm test:unit                      # unit/features/contract 全跑
pnpm test:unit:coverage             # 碰到 http/text/models 时
pnpm verify                         # 唯一验收
```

额外自检：断网跑一次（确认没有隐藏的真实网络依赖）；
把临时目录打印出来确认不是 `$DSH_HOME/dsh-word-learn/user.db`；
组件测试跑完确认 `afterEach(cleanup)` 没漏（`tests/support/setup.ts` 已兜底）。

## 交付输出模板

```text
目标：{{要锁住的行为 / 要抓的 bug}}

层与位置：{{tests/unit|features|contract|component|integration}}，为什么这层

覆盖点：
- {{输入}} → {{断言}}

隔离：临时 DSH_HOME = {{createTempHome 模式}}；外部依赖 {{stub 了什么}}

改动：
- {{测试文件}} —— 新增 {{N}} 条断言
- {{被测模块}} —— 是否补了测试入口（`__test__`/导出）

验证：{{单跑结果}}；pnpm test:unit / test:component → {{结果}}；pnpm verify → {{结果}}

未覆盖：{{仍需要真机/人工确认的部分}}
```
