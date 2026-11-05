# 提示词模板：写测试 / 收编 legacy 脚本

## 适用场景

- 新增功能要配套测试：{{功能，例如"评分后补记债的记录与清偿"}}；
- 修 bug 要补回归（先跟 `fix-bug.md` 的步骤 3 对齐）；
- 把现有的 `scripts/test-*.mjs` 收编进统一入口，或给某个模块补单测。

先选层，选错层会写出一堆跑得慢又抓不到 bug 的测试：

| 层         | 位置                                     | 适合                                                       | 不适合                       |
| ---------- | ---------------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| 单元测试   | `tests/unit/*.test.mjs`（`node --test`） | 纯函数、模块契约、排期字段映射、文本判断                   | 需要 `ctx`/HTTP/真实页面结构 |
| 端到端脚本 | `scripts/test-*.mjs`                     | 路由（桩 ctx 真跑）、跨模块写库、前端判定（vm 整文件加载） | 只测一个纯函数（太重）       |

## 先读什么（别跳）

| 文件                          | 行区                   | 为什么                                                         |
| ----------------------------- | ---------------------- | -------------------------------------------------------------- |
| `scripts/test-routes.mjs`     | 1–25                   | 临时 `DSH_HOME` 的标准写法（含"为什么不能用真实库"）           |
| `scripts/test-scope.mjs`      | 1–32                   | vm 整文件加载 `assets/core.js`，从 `__dwlCore` 取函数          |
| `tests/helpers/dashboard.mjs` | 1–60                   | vm 整文件加载 `assets/dashboard.js`，从 `__test__` 取组件      |
| `scripts/test-schedule.mjs`   | 全文（137 行）         | 断言式单测的范例：间隔序列逐条比                               |
| 被测模块                      | 文件头 1–40 + 导出清单 | 先知道它的输入输出与已知坑                                     |
| `CONVENTIONS.md`              | §9 测试                | 三个入口、硬规则、何时必须有测试                               |
| `lib/schedule.mjs`            | 28–62                  | 常量（`TRACKS`、`RATING`、`leech/上限`）直接复用，不要重抄数字 |

## 步骤

1. **写清"这条测试能抓到什么 bug"**。抓不到的测试是负担；不确定就先别写。
2. **隔离环境**：需要写库或 `import` 插件的，先
   `const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-xxx-'))`，
   `process.env.DSH_HOME = tmpHome`，**且必须在 `import` 被测模块之前设**；
   用 `process.on('exit', ...)` 清理。不要用"没设才临时"的判断（宿主导出过 `DSH_HOME`）。
3. **挡住外部世界**：LLM 用假 `ctx`（带 `get()` 返回假 llm）、`fetch` 打桩、TTS 只用已落盘缓存。
   测试必须能在断网机器上跑。
4. **写断言**：`import assert from 'node:assert/strict'`；每条断言带中文信息，且信息能独立读懂：
   `assert.equal(got, 'child', 'children 应回退到原形 child，实际得到 ' + got)`。
   不要 `console.log` 后目测，不要 `assert.ok(x)` 这种信息量低的写法。
5. **先跑一次确认**：新断言若应捕获已知 bug，要先看到红；纯新增覆盖则要先绿。
6. **登记入口**：legacy 脚本要加进 `scripts/test-all.mjs`（否则 CI 只跑一半）；
   `tests/unit/*.test.mjs` 由 `pnpm test:unit` 按 glob 捡；文件名必须是 `*.test.mjs`。
7. 跑验证。

## 硬约束

- **禁止真实用户库**：任何会写库的路径都必须临时 `DSH_HOME`；`--allow-real-db` 类开关默认关闭。
- **禁止真实网络**：不许打真实翻译/LLM/TTS/例句接口，也不许把网络失败当断言通过条件。
- **不许复制被测逻辑**到测试里（尤其前端作用范围/标注判定）：整文件 vm 加载真实源码
  （`core.js` / `dashboard.js`），不要再按函数名切字符串。
- 不许用 `setTimeout` 等固定时间当同步手段（用轮询条件或注入 now/时钟）。
- 不许为了让测试过而改产品代码的语义；发现产品代码有问题就回到 bug/重构流程。
- 测试脚本也吃 `max-lines` 预算（默认 400）；超了拆成两个脚本，别调预算。
- 断言信息中文；失败时要能直接看出"哪个输入、期望什么、实际什么"。

## 必须执行的验证

```bash
node scripts/test-<新脚本>.mjs   # legacy：必须能单跑
pnpm test:unit                   # tests/unit 下的单测
pnpm test:legacy                 # 确认已注册进 test-all
pnpm check:cycles                # 新增/移动文件后先看 import 环
pnpm verify                      # 唯一验收
```

额外自检：断网跑一次（确认没有隐藏的真实网络依赖）；
把临时目录打印出来确认不是 `$DSH_HOME/dsh-word-learn/user.db`。

## 交付输出模板

```text
目标：{{要锁住的行为 / 要抓的 bug}}

层与位置：{{tests/xxx.test.mjs | scripts/test-xxx.mjs}}，为什么这层

覆盖点：
- {{输入}} → {{断言}}

隔离：临时 DSH_HOME = {{模式}}；外部依赖 {{stub 了什么}}

改动：
- {{测试文件}} —— 新增 {{N}} 条断言
- scripts/test-all.mjs:{{行区}} —— 登记新脚本（legacy 才需要）

验证：{{单跑结果}}；pnpm verify → {{结果}}；断网复跑 → {{结果}}

未覆盖：{{仍需要真机/人工确认的部分}}
```
