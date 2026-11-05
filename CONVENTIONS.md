# 工程规范（dsh-word-learn）

## 0. 这份文档管什么

写给下一次改这个插件的人或 AI。它解释**为什么**，以及哪些判断机器查不出来。

| 谁                 | 管什么                                                           | 权威文件                              |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------- |
| Prettier           | 排版：缩进、引号、换行、尾逗号、表格对齐                         | `.prettierrc.json`、`.prettierignore` |
| ESLint             | JS 区的正确性 + 客户端架构边界（禁 Node 全局）                   | `eslint.config.js`                    |
| tsc                | 类型与未使用检查（`src/**` 一份类型图、宿主再编一次）            | `tsconfig.json`、`tsconfig.host.json` |
| dependency-cruiser | import 环、宿主↔客户端方向、客户端不碰 `node:`                   | `.dependency-cruiser.cjs`             |
| 本文档             | 配置表达不了的判断：职责归属、契约、拆分时机、测试纪律、依赖门槛 | 本文档                                |
| `AGENTS.md`        | 改之前先看的硬约束与「改 X 去哪里」定位表                        | `AGENTS.md`                           |
| `README.md`        | 用户视角的功能与接口清单                                         | `README.md`                           |
| `DESIGN.md`        | 历史设计结论与实测踩坑（**历史结论不因迁移而改**）               | `DESIGN.md`                           |

优先级：**ESLint/tsc 报错 > 本文档 > 个人偏好 > 参考仓库的写法**。冲突时改代码，不改规则。
本文档不抄配置项：`printWidth` 之类的值看 `.prettierrc.json`；构建与测试链的现状看
`package.json` 与 `tsdown.config.ts`。文档与机器版本不一致时以机器为准，并修文档。

> 当前形态（2026-11-05 阶段 4 收尾，ADR-0001/0002/0003/0004/0005/0007）：
> 插件 = **宿主 TypeScript**（`src/host/**` → `tsc` → `lib/host/**`）+ **客户端单 bundle**
> （`src/client/**` → `tsdown` → `dist/client.js`）。没有注入脚本、没有 `window.__dwl*` 全局、
> 没有 vm 替身测试、没有 legacy 测试脚本。ADR 与 `docs/plans/` 记录迁移过程与本轮删掉的门禁。

## 1. 项目形态与目录职责

宿主是 Node ESM 插件：DSH 按 `package.json` 的 `exports["."]` 加载 `lib/host/index.js`；
浏览器侧按 `exports["./client"]` 加载 `dist/client.js`（一个 `__ModuleLoader__.load` 包）。
`lib/host/**` 与 `dist/**` 都是 gitignore 的构建产物，**不入库、不手改**。

| 路径                                                                           | 跑在哪                        | 能做什么                                                                                     | 禁止什么                                             |
| ------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `src/host/index.ts`                                                            | 宿主（Node）                  | 插件入口：`apply(root)`、`inject(['webServer'])`、信任栅栏、`registerRoute` 包装、装卸       | 写业务算法；写 handler；拼 SQL；import `src/client/` |
| `src/host/routes/*.ts`                                                         | 宿主（Node）                  | 22 条 API 路由按组注册（study/review/ai/repair/annotate）                                    | 绕开 `registerRoute`；自己拼响应头                   |
| `src/host/routes/shared.ts`                                                    | 宿主（Node）                  | `safeSend` / `fail` / `unavailable` / `readJson` / `isFalse`；`clampInt` 从 http 再导出      | 直接 `res.writeHead` 二次写头                        |
| `src/host/routes/paths.ts`                                                     | 宿主（Node）                  | 路由路径常量唯一出口                                                                         | handler 里写死路径字符串                             |
| `src/host/runtime.ts`                                                          | 宿主（Node）                  | 词典/用户库进程级单例                                                                        | 处理请求；路由层状态                                 |
| `src/host/lookup.ts`                                                           | 宿主（Node）                  | 查词组装（词典 + 补全 + 生词本 + 警告）                                                      | 直接注册路由                                         |
| `src/host/http.ts`                                                             | 宿主（Node）                  | 入参读值与钳制的唯一归口：query `intParam`/`strParam` + body `clampInt`                      | 在 handler 里裸写 `Number(...)`；自己夹上下限        |
| `src/host/store.ts`                                                            | 宿主（Node）                  | 用户库门面：open/退避重试/close + 薄委托                                                     | 写业务 SQL（SQL 在 `src/host/store/*.ts`）           |
| `src/host/store/*.ts`                                                          | 宿主（Node）                  | schema/迁移、生词本、统计/补记、设置；首参是 Store 实例                                      | 自己 open 库；把 `store.db` 往路由层传               |
| `src/host/ai-enrich.ts`                                                        | 宿主（Node）                  | AI 分析/出题/后台队列的门面（再导出 + 生命周期）                                             | 写业务算法（实现都在 `enrich/*.ts`）                 |
| `src/host/enrich/*.ts`                                                         | 宿主（Node）                  | 提示词、解析、出题、后台队列、模型调用                                                       | 直接读库；把外部失败抛给交互路径                     |
| `src/host/{dict,schedule,translate,r5,annotate,models,text,service,enrich}.ts` | 宿主（Node）                  | 词典、FSRS 排期、翻译、R5 回访、标注词表、模型选择、文本工具、取服务、外部增强               | 模块加载时开用户库；import `src/client/`             |
| `src/client/entry.ts`                                                          | 浏览器 bundle 入口            | 只做导出：`export { inject, apply, __test__ }`（loader 壳由 `tsdown.config.ts` 生成）        | 写业务                                               |
| `src/client/plugin.js`                                                         | 浏览器（React）               | 学习页四视图、侧栏入口与主面板、客户端 locale、页面级装配（`ctx.effect`）                    | Node API；`node:*`；模块期副作用；直连 SQLite        |
| `src/client/dashboard/logic.js`                                                | 浏览器（无 React）            | 学习页纯逻辑/常量/取数                                                                       | React；监听事件；写样式                              |
| `src/client/dashboard/styles.js`                                               | 浏览器                        | 学习页 CSS 模板串（`export const CSS`），apply 时写进 `<style data-plugin>`                  | 碰 DOM 逻辑；写业务                                  |
| `src/client/features/core.js`                                                  | 浏览器（纯判定）              | 划词/标注的生效范围与**排除范围单一来源**（`BLOCKED_ELEMENTS`/`blockedSelector`）            | DOM 副作用；另抄一份排除名单                         |
| `src/client/features/voice.js`                                                 | 浏览器                        | speechSynthesis 封装（零网络，缓存的是偏好不是音频）                                         | 网络请求；音频缓存                                   |
| `src/client/features/wordcard/{index,card,style}.js`                           | 浏览器                        | `installWordcard()` 装监听/建卡并返回 dispose；`card.js` 视图、`style.js` CSS 字符串         | 模块期副作用（必须在 install 内）；改页面正文        |
| `src/client/features/annotate/*`                                               | 浏览器                        | `installAnnotate()` 装 observer/监听并返回 dispose；只在 `[data-chat-flow]` 内动             | 标注代码块/流式/折叠/其它插件弹窗                    |
| `dist/client.js`（+ `.map`）                                                   | 浏览器                        | 单 bundle 产物（`pnpm build` 生成，gitignore）                                               | 手改；提交进 git；写 Node 内建                       |
| `lib/host/**`                                                                  | 宿主（Node）                  | `tsc -p tsconfig.host.json` 产物（gitignore）                                                | 手改；当源码编辑；提交进 git                         |
| `data/ecdict.db`                                                               | 只读                          | ECDICT 精简词典（`scripts/build_dict.py` 构建）                                              | 写入；手改 `.db`                                     |
| `$DSH_HOME/dsh-word-learn/user.db`                                             | 只经 `src/host/store.ts` 门面 | 生词本、卡片、复习日志、设置（**不可再生**）                                                 | 测试直连真实库                                       |
| `$DSH_HOME/dsh-word-learn/cache/`                                              | 可删                          | 翻译缓存（发音不走网络，没有音频缓存）                                                       | 当持久数据依赖                                       |
| `tests/`                                                                       | Node / jsdom                  | 见 §9：unit/features/contract（node:test）、component（vitest+jsdom）、integration（vitest） | 真实网络、真实用户库、真实 TTS 发声                  |
| `scripts/`                                                                     | Node（手跑/CI）               | `check-artifact.mjs`（产物契约）、`check-tarball.mjs`（包清单）、`build_dict.py`（词典）     | 放前端/路由回归——测试在 `tests/`                     |
| `locale/`                                                                      | 宿主与客户端                  | 包级文案（`meta.*`）                                                                         | 放业务文案                                           |
| `docs/adr/`、`docs/plans/`                                                     | 不运行                        | 决策记录与迁移计划（历史证据，不改结论，只追加）                                             | 当现行规范引用而不看日期                             |

分文件是因为「改翻译不碰排期」：词汇、存储、排期、外部能力（`translate`/`enrich`/`ai-enrich`/
`models`）各一层，新模块照这个切法起名。每个文件头注释都写了它为什么存在、踩过什么坑——
改之前先读头注释，比读全文便宜。

## 2. 四条铁律

违反会坏在用户机器上，而且往往不报错。

### 2.1 边界只在构建边界上

- `src/client/**` 是浏览器 bundle 源码：**允许** `import`/`export`（tsdown 打成一个文件），
  **禁止** Node 内建、`process`、`__dirname`、`Buffer`（ESLint 的 `no-restricted-globals` 与
  dependency-cruiser 各守一道）。产物里只允许 `require('react')`：那是
  `__ModuleLoader__.load({ factory(require) })` 传进来的宿主模块表查询函数，不是 Node 的
  `require`；多 require 一个包就是运行期 `missed the module table`。
- `src/host/**` 是 Node TypeScript（`module: NodeNext`，import 带 `.js` 后缀指向源码同名的编译产物）：
  **禁止** import `src/client/**`（反过来也禁止）。两侧共享的只有契约（HTTP 形状、locale code、
  URL 常量），实现**故意各写一份**，因为一份跑在 Node、一份跑在浏览器。
- 这三条由 `pnpm deps:check`（dependency-cruiser）与 `pnpm typecheck`（tsc 双投影）守，不靠记忆。

### 2.2 颜色只走 `--dsw-alias-*` 主题令牌

- 一律 `var(--dsw-alias-bg-overlay, 兜底值)`，兜底只在令牌缺失时生效。
- 不许判 `data-theme="dark"`：DSH 的深色标记是 `body[data-ds-dark-theme]`（DESIGN.md 风险 13）。
- 不许只监听 `matchMedia`：手动切主题时系统偏好没变，必须同时用 `MutationObserver` 盯 body。
- 不许凭感觉填色：新令牌先查 DESIGN.md §9 的令牌取值表并核对对比度
  （浅色 `label-tertiary` 只有 3.71，只够大字）。

在用令牌：`bg-base/layer-1/2/3/overlay/skeleton`、`border-l2`、`label-primary/secondary/tertiary`、
`interactive-bg-hover`、`brand-primary`、`state-{success,warn,error,business}-primary`。

### 2.3 构建是唯一入口

- 客户端产物**只能**由 `pnpm build`（tsdown）从 `src/client/**` 生成；宿主产物**只能**由
  `tsc -p tsconfig.host.json` 从 `src/host/**` 生成。`dist/**`、`lib/host/**` 是 gitignore 的产物：
  **不许手改、不许提交、不许当源码编辑**。`pnpm artifact:check` 会校验产物壳（单
  `__ModuleLoader__.load`、id = 包名、factory 参数、`require('react')` 唯一、无 `node:`、外部 sourcemap、
  体积预算）。
- 改前端不 build = 用户看不到任何变化（平台 client-hmr 轮询的是 `dist/client.js` 的 mtime）。
- 为什么接受构建（ADR-0001/0002）：零构建时代为了「不构建」付出了注入协议、加载顺序竞态、
  8 个 `window.__dwl*` 全局、vm 替身测试的代价；真正需要的是「浏览器能跑、宿主能加载」，
  而不是「源码零转译」。

### 2.4 前端模块不许在顶层产生副作用

监听、`MutationObserver`、`appendChild`、定时器一律收进 `installXxx()`，返回 `dispose`，
由 `apply()` 里 `ctx.effect(...)` 统一装卸。HMR 会反复重跑 `apply()`：顶层副作用会让监听/样式/
卡片叠 N 份，而用户只看到「越用越卡」。`tests/component/install-dispose.test.ts` 锁的就是
install→dispose→re-install 不叠加（监听净数、DOM 与 `<style>` 数量）。

## 3. 代码风格

### 3.1 排版：Prettier 说了算，不要手调

有效配置：无分号、单引号、`printWidth: 100`、2 空格、`trailingComma: all`、`arrowParens: always`、LF。
机器会改这些，不要手写对齐、不要为"更好看"手动断行。提交前 `pnpm format:check`，
别让格式化混进逻辑提交（§11）。

### 3.2 注释：中文、解释 why、记录踩过的坑

- 中文。注释是给下一个人和 AI 的判断依据，不是装饰。
- 写"为什么"，不写"这里赋值给 x"。正例：`// 先发响应再记账：评分已写库，抛错会让客户端重试 → 同一张卡评两次`。
- 实测类写清日期 + 现象 + 判据（`2026-11-04 踩过：…`）。这是本项目最有价值的注释形态。
- 改行为就一起改过时注释。注释撒谎比没注释更贵，下一轮 AI 会把它当事实。
- 空 `catch` 必须紧邻一句"为什么可以吞"（响应已发出后的收尾副作用、页面侧防御、可降级的增强都属于此类）。

### 3.3 命名

| 对象         | 规则                          | 例子                                             |
| ------------ | ----------------------------- | ------------------------------------------------ |
| 文件名       | 短、小写、按职责              | `store.ts`、`ai-enrich.ts`、`txt` 类纯函数名后缀 |
| 常量         | `UPPER_SNAKE`                 | `MAX_INPUT`、`LEECH_THRESHOLD`、`SCHEMA`         |
| 函数/变量    | `camelCase`                   | `lookupWord`、`dueQueue`                         |
| 布尔         | `is`/`has`/`should`/`can`     | `isFalse`、`shouldEnrich`                        |
| CSS 类       | `dwl-` 前缀                   | `dwl-card`、`dwl-anno`                           |
| localStorage | `dwl-*` 或 `dsh-word-learn:*` | `dwl-voice-accent`、`dwl-auto-speak`             |
| 模块装配函数 | `installXxx()` 返回 dispose   | `installWordcard`、`installAnnotate`             |

`window.__dwl*` 全局已随注入脚本一起删除（阶段 2）：页面级状态只留在模块闭包与 localStorage，
**不要**为新功能重建 window 全局；跨模块共享走 `import`。

### 3.4 导出形态

- `src/host/index.ts` **默认导出** `{ name, apply(root) }`（宿主契约）；其余宿主模块一律**命名导出**，
  方便测试按需引；不要为整齐加 `default`。
- `src/client/entry.ts` 只 `export { inject, apply, __test__ }`：前两个是 Cordis 插件面，
  `__test__` 给组件测试取组件/纯函数（`LOGIC`/`HoverWord`/`WritePanel`/`SettingsView`/
  `StatsView`/`VocabView`/`WordLearnPage` 与拼写判定函数）。`dist/client.js` 的 shell 由
  `tsdown.config.ts` 生成，不要在源码里手写 `__ModuleLoader__`。
- `src/client/features/*` 导出 `installXxx()`（返回 dispose）或纯函数/常量；样式模块只导出 CSS 字符串。
- `src/host/store/*`、`src/host/enrich/*` 的命名导出第一个参数是依赖（Store 实例 / 假对象），
  不 import 单例——测试才能传假依赖。

### 3.5 异步与错误处理

照现有 handler 与 `src/host/routes/shared.ts` 抄，别自创：

1. 路由 `handler` 可以 `async`，但**参数解析失败必须自己 `sendJson(..., 400, ...)` 返回**；
   抛给外层只能得到 500，而 400 才是事实。body 非法由 `readJson` 抛，handler 的 400 分支接管。
2. 业务异常进 `fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)`。
   原始 `err.message` 常带绝对路径，**只进 `console.warn`，不给浏览器**。
3. 响应发出后的副作用（入队、记债）必须自己吞错：已发出的响应改不了状态码，抛出去只会引发重试。
4. 只读查询用同步 `node:sqlite` 没问题，别为"异步"包 Promise。
5. 统一出口 `safeSend`：已发过就什么都不做，绝不二次写头。

### 3.6 数值与字符串一律钳制

外部输入没有可信度。数字参数一律走 `src/host/http.ts`：

```js
const limit = intParam(url, 'limit', { fallback: 200, min: 1, max: 500, floor: true })
```

- 禁止在 handler 里裸写 `Number(url.searchParams.get(...))`：读值与钳制只留一个入口。
- **POST body 的数字字段走 `src/host/http.ts` 的 `clampInt(value, { fallback, min, max })`**
  （与 `intParam` 同归口、同语义，只是入参是值而不是 URL）；`Number(payload.x) || 0` 是历史写法，
  新代码不许再用。`src/host/routes/shared.ts` 只做再导出，handler 的
  `import { clampInt } from './shared.js'` 照旧可用。
  业务合法性（如 `rating` 必须 1-4）仍留在 handler 校验——钳制不是"把非法值修好"。
- 这条不止管 handler：handler 下游**接收 payload 的函数**（如 `src/host/r5.ts` 的 `submitRecap`）
  同样要过 `clampInt`，否则从 handler 漏出去的那一段还是裸 `Number()`。
  这类业务模块直接 `import { clampInt } from './http.js'`——**业务层不许反向依赖 `routes/`**。
  唯一豁免是「当时间戳用」的注入字段（`payload.now`）：它靠 `isFinite` + 正数守卫回落
  `Date.now()`，套 `clampInt` 会把 `±Infinity` 夹成安全整数边界，造出一个假的"现在"。
- `fallback` 兜的是缺省 / 空串 / 非数字 / 0，与旧的 `Number(x) || fallback` 等价。
- `floor: true` 只给分页类（`limit`/`offset`），其余参数保持原值。
- 字符串用 `strParam(source, name, fallback)`，进库/外呼前再 `slice(0, N)`；布尔用 `isFalse()`
  （`'false'` 是字符串，`!== false` 会当 true，踩过）。非法值**就地 400**，别"兜底成默认值"。
- 词输入必须过 `looksLikeWord`（单 token 时）——路由是公开的，前端过滤不是唯一防线。

## 4. 模块与拆分

### 4.1 体量：不再用行数当门禁

行数预算（`CODE_BUDGET` + `max-lines`）已按 ADR-0005 删除：行数不是缺陷，它制造的是
「贴着上限写」与「为拆而拆」；本轮 6 个真缺陷没有一个由它抓到。现在只有一处体量门禁：

- **客户端产物** `dist/client.js`：`raw ≤ 400 KB` 且 `gzip ≤ 100 KB`（`pnpm artifact:check`）。
  这是真实的浏览器加载成本，不是复杂度代理。超了先分析（是不是引入了不该进 bundle 的代码），
  再决定分割或删功能；**改预算必须写 ADR/提交说明**，不许偷偷调。
- 宿主侧没有行数限制：文件职责由依赖方向、类型与测试约束，`wc -l` 不是指标。

### 4.2 什么时候该拆

满足任一就拆，别等出事：

- 文件里出现第二个职责名词（"这里还顺手做了 X"就是信号）；
- 某段逻辑想单独测，却只能整文件跑；
- 改一个功能要动三处互不相邻的区域；
- 新增一条路由，handler 要挤 80 行以上业务代码；
- 同一份契约在 `src/host/` 与 `src/client/` 各有一份且开始不一致（说明契约没定清）。

### 4.3 怎么拆

1. 先抽**纯函数**到独立文件：无 `ctx`、无网络、无文件系统，输入输出都是普通对象。
2. 路由 handler 只留：解析 → 校验/钳制 → 调 service → `safeSend`。
3. 外部服务把"取服务"和"发请求"分开：`service.ts` 负责 `ctx.get(name)`，
   业务模块只接收依赖，测试传假对象即可。
4. 前端拆模块：判断抽 `core.js` 这类纯函数、视图抽 `card.js`、样式抽 `style.js`，
   装配留在 `index.js` 的 `installXxx()` 里；拆完必须仍满足 §2.4（无顶层副作用）。
5. 拆完同步本文档相关节与 `AGENTS.md` 的定位表（不写行号）。

### 4.4 不许有 import 环，也不许跨边界

环会让「谁依赖谁」失去方向：拆模块时绕一圈又拆回去，改 A 会莫名影响 B，测试也不得不整包跑。

- 门禁：`pnpm deps:check`（dependency-cruiser，配置在 `.dependency-cruiser.cjs`）：
  `no-circular`（遍历静态 `import`、动态 `import()`、`export ... from`）、`host-no-client`、
  `client-no-host`、`client-no-node-builtin`。已挂进 `pnpm check` → `pnpm verify`。
- 为什么不用 ESLint 插件：ESLint 10 下 `eslint-plugin-import-x` 的 `no-cycle` 实测漏报；
  dependency-cruiser 认得 TS、别名、动态 import，实测 15/15 形态检出。
- 规则只做「能对应真实缺陷」的四件事；**不要为了消警告把配置改成 `ignore`**——那是把门禁拆了。

### 4.5 不许做的

- **改 dependency-cruiser 配置放行一个环**，或用 `// depcruise:ignore` 之类旁路——本项目唯一
  明令禁止的"修复"。
- 把逻辑挪到另一个文件规避职责判断（拆分的目的是降低耦合，不是换文件名）。
- 用 `eslint-disable` 绕规则（确需例外时写明原因 + 到期条件，见 §10）。
- 为拆而拆：抽出只调用一次、6 个参数的"工具函数"。

## 5. 路由契约

### 5.1 注册位置

所有路由按领域注册在 `src/host/routes/{study,review,ai,repair,annotate}.ts`：
各组的 `registerXxxRoutes(registerRoute, ctx)` 在 `src/host/index.ts` 的
`root.inject(['webServer'], (ctx) => { ... })` 里挂上；`registerRoute` 包装自动套
**信任栅栏 → 方法白名单 → try/catch 兜底**。别处直接 `ctx.webServer.register` 会绕过栅栏。

- `kind: 'exact'` + 完整路径；路径常量集中在 `src/host/routes/paths.ts`（如 `API_LOOKUP`），
  handler 里不写死。
- 当前共 **22 条 API 路由**（数据面）：查词/生词本/看板/队列/评分/翻译/AI 分析/出题/补记债/
  R5 回访/义项地图/标注词表/模型选择。前端资源（`client.js`、样式）不再走路由：客户端由
  `exports["./client"]` 加载，样式随 bundle 进页。**注册数量以 `paths.ts` 为准**，加路由先加常量。
- **写操作必须显式 `methods: ['POST']`**；不声明等于任何方法都放行，GET 也能顺手写库。
  非白名单方法由包装层回 405 + `Allow` 头。
- 新增一组领域时，才需要在 `src/host/index.ts` 里加一行 `registerXxxRoutes`，并把返回的
  disposer 推进 `disposers`（插件卸载时统一注销）。

### 5.2 入参

- POST 体一律 `readJson(req)`：只接受 JSON 对象；数组/标量/`null`/空 body 在那里抛，
  由 handler 的 400 分支接管（别让它变成 `TypeError` → 500）。上限 256 KB。
- body 的数字字段按 §3.6 用 `clampInt`（`src/host/http.ts`；handler 也可从
  `src/host/routes/shared.ts` 取，那里是再导出），别裸写 `Number(payload.x)`。
- GET query 全是字符串：布尔用 `isFalse()`，数字按 §3.6 钳制，字符串 `slice` 上限。
- 长文本有上限：翻译 6000 字符、原句 2000、请求体 256 KB。新增入口照这个加。

### 5.3 响应

成功 `{ ok: true, ... }`，失败 `{ ok: false, code?, error }`。`code` 是前端分支用的稳定字符串
（`DB_UNAVAILABLE`、`METHOD_NOT_ALLOWED`、`INTERNAL_ERROR`、`MODELS_UNAVAILABLE`、
`ANALYSIS_FAILED`…），`error` 是一句能给用户看的中文。**不要把 `err.message` 塞进 `error`。**

| 情况                               | 状态码                 | 说明                           |
| ---------------------------------- | ---------------------- | ------------------------------ |
| 正常                               | 200                    | `{ok:true,...}`                |
| 入参缺失 / JSON 不合法             | 400                    | `{ok:false,error}`             |
| 资源不存在（词不在词典、卡不存在） | 404                    | 客户端问题，不是服务器故障     |
| 用户库打不开                       | 500 + `DB_UNAVAILABLE` | 走 `unavailable()`，不回显路径 |
| 内部异常                           | 500 + `INTERNAL_ERROR` | 走 `fail()`                    |
| 跨站 / 栅栏拒绝                    | 401 / 403              | 空 body，由 `makeFence` 决定   |
| 方法不在白名单                     | 405                    | 带 `Allow` 头                  |

**例外：交互路径要降级，不要报错。** 划词卡片、学习页首屏这类"用户正看着"的请求，
可预期失败应回 `200 + ok:false`（`/translate` 如此：翻译失败也要让卡片画一行"翻译失败"，
不能 500 让前端当网络错误重试）。判断标准：**调用方会不会把 5xx 当重试信号**。

副作用排序：先 `safeSend` 再收尾。`/grade` 已写库，若因记债失败回 500，
客户端重试会让同一张卡评两次（FSRS 不可逆）。

### 5.4 新增一条路由的清单

1. 路径常量加到 `src/host/routes/paths.ts`；
2. handler 写进所属的 `src/host/routes/{组}.ts`，用 `registerRoute` 包一层；新组才改
   `src/host/index.ts` 的挂载列表；
3. 业务进 `src/host/*.ts`（用户库写入进 `src/host/store/*.ts`）并补单测
   （`tests/unit/*.test.mjs` 或 `tests/integration/*.test.ts`）；
4. `README.md`「接口」表加一行（方法 / 路径 / 说明 + 参数）——接口表是唯一对外清单；
5. 集成测试加断言：`tests/integration/routes.test.ts`（真实 `ctx` 桩 + 临时 `DSH_HOME`，
   不重启宿主）；新领域可仿 `model-routes.test.ts` 单开文件；
6. 前端要用的，在对应调用点的 `API` 常量表加一行（`src/client/features/wordcard/index.js`、
   `src/client/features/annotate/config.js` 或 `plugin.js` 里的常量）；
7. 跑 `pnpm verify`。

### 5.5 handler 的边界

允许：读 `req`、`readJson`、`new URL`、校验与钳制、调 `store`/`dict`/`schedule`/`translate`/
`src/host/enrich/*` 的导出、`safeSend`/`fail`/`unavailable`。
不允许：SQL、FSRS 参数计算、fetch、文件路径拼接、超过 20 行的聚合逻辑。出现就该拆 service（§4.3）。

## 6. 数据访问

### 6.1 三个数据位置

| 数据   | 位置                               | 可再生                        | 规则                                                              |
| ------ | ---------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| 词典   | `<插件目录>/data/ecdict.db`        | 是（`scripts/build_dict.py`） | 只读，只经 `src/host/dict.ts`                                     |
| 用户库 | `$DSH_HOME/dsh-word-learn/user.db` | **否**                        | 只经 `src/host/store.ts` 门面打开（SQL 在 `src/host/store/*.ts`） |
| 缓存   | `$DSH_HOME/dsh-word-learn/cache/`  | 是                            | 可直接删，不当持久数据                                            |

用户库路径由 `DSH_HOME` 决定（缺省 `~/.dsh`），这个变量同时是测试隔离开关（§9.2）。

### 6.2 SQL 归口

- 用户库**新 SQL 一律加在 `src/host/store/{words,review,settings}.ts`**（schema/迁移在 `schema.ts`）；
- 子模块函数**第一个参数是 Store 实例**（`touch(store, info, sentence)`）：「先 open() 再拿 `store.db`」
  是用户库原语的一部分，拆开后不能两边各判一次打开状态；门面把 `this` 传下去。
- 排期/回访/标注接收 `store` 实例后读 `store.db` 做针对性查询（`schedule`/`r5`/`annotate` 的历史写法）。
  这是历史债：**只允许收窄，不允许扩散**——不要在这些模块新增表级写入。
- 词典 SQL 只许在 `src/host/dict.ts`；别处要词数据调 `dict.lookup()`。
- 参数一律绑定（`prepare(...).get(word)`），不拼字符串。拼 SQL 的地方就是注入点。

### 6.3 schema 变更

1. 改 `src/host/store/schema.ts` 的 `SCHEMA`（`CREATE TABLE IF NOT EXISTS` 只对新库生效）；
2. **必须**在同文件的 `migrate()` 加增量步骤：`PRAGMA table_info` 查列、缺列 `ALTER TABLE ADD COLUMN`；
3. 迁移必须幂等：老库 / 新库 / 半新库跑同一段代码得到同一结构；
4. 在 `DESIGN.md` §2 记一笔：日期、加改了什么、为什么、怎么迁。
   反例见风险 14：`learning_steps` 没存，排期静默失效（间隔永远 0 天，不报错）。

禁止：`DROP TABLE`、重建库、改列类型、在迁移里写业务逻辑。用户数据不可再生。
子模块（words/review/settings）不许各自迁移：库形状只有一个出口，避免两个模块对同一列各写一遍。

### 6.4 迁移与备份

- 开发前先复制 `user.db`（含 `-wal`/`-shm`）到临时目录，拿副本做实验。
- 重跑迁移验证用 `DSH_HOME=<临时目录>`，不要动真实库。
- 写库测试必须走 `tests/integration/support/tmp-home.ts` 的 `createTempHome()`
  （`mkdtemp` + 写 `process.env.DSH_HOME` + canary 断言），**且必须在 import 宿主模块之前**
  （`schema.ts` 在 import 那一刻按 `DSH_HOME` 定路径）。
- 备份不是插件职责：README 已写"生词本不可再生，请备份"，不要加自动备份/云同步。

### 6.5 写库的幂等

同一动作重复调用不能产生第二条记录或第二次评分：`touch` 撞已有行就 `seen_count + 1`；
卡片按 `UNIQUE(word_id, track)` 建、`ensureCards` 可重复调；评分接口不接受重试
（服务端不回 5xx 诱导重试，去重由前端做）。

## 7. 前端约定

### 7.1 只有一个客户端模块

| 项     | 现状                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------- |
| 声明   | `package.json` 的 `dsh.client`（`platform: web`、`immediately: true`、`inject` 三个客户端服务）      |
| 加载   | `exports["./client"]` → `dist/client.js`，`__ModuleLoader__.load({ id, factory })`                   |
| 技术栈 | 真 React（宿主模块表提供 `react`）+ 原生 DOM（划词卡/标注）                                          |
| 组装   | `src/client/plugin.js` 的 `apply(ctx)`：先注册 locale 目录 → 侧栏 slot → 主面板 slot → 页面级 effect |
| 生效   | `pnpm build`（或 `pnpm dev`）重建产物 → 平台 client-hmr 检测 mtime → 自动重载（§7.5）                |

没有「普通 script vs client 模块」的选型了：**能进 bundle 的都进 bundle**。判据是副作用归谁：
页面级功能（划词、标注）用 `installXxx()` 从 `apply` 里装卸；布局功能走 `ctx.slots.register`。
不要在 bundle 里重建 `window.__dwl*` 全局或 `CustomEvent` 就绪协议——那些是零构建时代的注入面，
已删（ADR-0003）。

### 7.2 样式

- 类名 `dwl-` 前缀，选择器限定在自己的根节点下（`.dwl-card ...`）。
- 不写全局选择器（`button {}`、`* {}`），不 `!important` 盖宿主样式。
- 颜色见 §2.2；间距/圆角可自带，字号跟 DSH body 走，不写死大字号。
- 学习页样式：`src/client/dashboard/styles.js` 的 CSS 字符串，由 `apply()` 里 `ctx.effect` 写进
  `<style data-plugin="dsh-word-learn">`，卸载时移除，别留孤儿样式。
- 浮层一律 `position: fixed` + `--dsw-alias-bg-overlay`，不要 absolute 挂宿主节点。

### 7.3 不碰页面 DOM

- 划词卡（`src/client/features/wordcard/index.js`）：只**读**选区，只往 `document.body`
  追加自己的浮层；绝不改正文节点、不包裹文本、不改宿主属性。异常一律吞掉（注释说明为什么），
  不能因为划词把页面搞白。
- 排除范围只在 `src/client/features/core.js` 维护（`BLOCKED_ELEMENTS` / `blockedSelector`）：
  划词与标注层都 `import` 它，别在各自文件里再列一份；标注层拿不到就整体跳过。
- 标注层（`src/client/features/annotate/`）：只在 `[data-chat-flow]` 内操作，且只包裹**自己认定的
  目标词**节点。排除代码块/行内代码/文件名/URL/链接、流式生成（`[data-streaming]` + 文本稳定
  600ms）、折叠内容（只标标题）、其它插件弹窗。原文不改、不翻译。
- 作用范围判定直接 `import` 真实模块来测（`tests/features/scope.test.mjs` import
  `src/client/features/core.js` 与 `annotate` 的 `internals`），不在测试里复制逻辑。

### 7.4 无障碍

可点元素用 `<button type="button">`；图标按钮必须 `aria-label`；动态区域（结果、错误、朗读状态）
用 `aria-live="polite"`；键盘可达（卡片 Esc 关、学习视图空格揭晓、`1-4` 评分），焦点态不能被 CSS 抹掉；
触控目标不小于 28×28；不要用 hover 当唯一入口。
行内提示类文案的 `aria-label` 只放一行摘要（多行释义按换行切第一行，别把整段塞进读屏名称——
`tests/component/views.test.tsx` 有一条回归锁这个）。

### 7.5 生效方式与真机验证

| 改了什么                          | 怎么生效                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/**`                   | `pnpm build`（或 `pnpm dev` 常驻）重建 `dist/client.js` → 平台 client-hmr 自动重载模块；**不用刷新/重启**，但面板会重挂（学习页退回首页，重点侧栏「英语学习」） |
| `src/host/**`                     | `pnpm build`（或 `pnpm build:host`）产出新的 `lib/host/**` → **重挂插件**（或重启宿主）；宿主侧没有 mtime 热重载，别指望保存即生效                              |
| `lib/host/**`、`dist/**`          | 构建产物，**不要手改**；只改 `src/**` 再 `pnpm build`                                                                                                           |
| `locale/*.json`、`data/ecdict.db` | 重挂插件（+ 页面刷新）                                                                                                                                          |

「生效没有」的权威信号：浏览器 `/plugins/events` 出现新的 `rev`，或控制台网络里
`/plugins/??dsh-word-learn/client.js&rev=<新 hash>` 用了新产物；**不要**自己拼
`/plugins/dsh-word-learn/client.js`（一定 404），也不要指望 `__DSH_BOOT__.entries` 的 `rev`
（那是激活时快照）。真机清单见 ADR-0007 与本轮交付说明（普通刷新 ×5、硬刷新、划词、标注、
学习页四 tab、主题切换、HMR 重载后划词不叠卡）。

## 8. i18n

| 层     | 位置                               | 内容                                 | 谁读                                     |
| ------ | ---------------------------------- | ------------------------------------ | ---------------------------------------- |
| 包级   | `locale/zh.json`、`locale/en.json` | 只有 `meta.title`/`meta.description` | 宿主按 `./locale/*.json` 导出约定读      |
| 客户端 | `src/client/plugin.js` 的 `DICT`   | 侧栏/面板标题                        | `ctx.locale.register(NS, DICT)` 后 `t()` |

- **两份键必须同步**：`zh`/`en` 的键集合完全一致；`DICT` 里 `zh`/`en` 同键。加一个键两处一起加。
  `tests/contract/locale.test.mjs` 与 `artifact:check` 的 locale 检查各守一道。
- **注册必须早于 slot**，否则 `label` 求值时目录还是空的（DESIGN.md 风险 17）。
- **缺键的回落是"原始 key"**，不是英文也不是中文兜底：没注册目录时 `t('panel.title')`
  会在侧栏显示 `panel.title`。所以宁可不加 key，也不要加半套。
- `locale: NS` 只是声明不是注册；声明了不 `register` 等于空配置。
- NS 固定 `dsh-word-learn`，必须过 BCP 47 正则 `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$`，否则宿主 throw。
- **宿主不做翻译**：`src/host/**` 没有 locale 服务，只回稳定 `code` + 中文人话，英文由前端按
  `code` 映射；新增 `code` 时在本文档或 README 记一句语义。

## 9. 测试

### 9.1 三个层次与命令

| 命令                      | 跑什么                                                                                                                                                                                                        | 何时跑               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `pnpm test:unit`          | `node --test "tests/**/*.test.mjs"`：unit（宿主纯函数/模块契约，import `lib/host/**` 产物）、features（前端纯函数与 install 生命周期，import `src/client/features/*` 源码）、contract（产物源码/locale 契约） | 改完逻辑             |
| `pnpm test:unit:coverage` | 单测 + 覆盖率门槛（`lib/host/{http,text,models}.js` 三个关键模块）                                                                                                                                            | 改纯函数或模型层     |
| `pnpm test:component`     | `vitest run`：`tests/component`（jsdom + RTL，渲染 `dist/client.js` 真实组件）+ `tests/integration`（node 环境，真实 `ctx` 桩 + 临时 `DSH_HOME` + 真实 `node:sqlite`）                                        | 改前端/路由/数据访问 |
| `pnpm deps:check`         | dependency-cruiser（环 + 分层方向 + 客户端不碰 `node:`）                                                                                                                                                      | 拆/并模块后          |
| `pnpm verify`             | `build` → `artifact:check` → `check:tarball` → `check`（typecheck/lint/format/deps）→ `test`（unit/coverage/vitest）                                                                                          | **交付前唯一验收**   |

- **vitest 用哪份代码**：component 读 `dist/client.js`，integration 读 `lib/host/**`（编译产物，
  见 `tests/integration/support/tmp-home.ts` 的时序说明），所以**跑 vitest 前必须先 `pnpm build`**；
  `pnpm verify` 已先 build。只跑一条：`npx vitest run tests/component/views.test.tsx`。
- **node:test 用哪份代码**：features/contract 直接 import `src/client/features/*.js`（源码）；
  unit 直接 import `lib/host/*.js`（编译产物）。所以 `pnpm test:unit` 也要先 `pnpm build`
  （只跑 features/contract 时可以跳过）；`pnpm verify` 已先 build。
- **覆盖率现状（照实写）**：只有 `lib/host/http.js`、`lib/host/text.js`、`lib/host/models.js`
  三个文件设了门槛（行 95% / 分支 85% / 函数 95%），当前约 100%，是「现状快照」而不是质量杠杆。
  **全局覆盖率还没有统一门禁**（node:test 与 vitest 两份运行不合并、`src/client` 的 JS 计量为 0），
  这是已知缺口，不要把它说成已覆盖。
- **真浏览器不替代**：组件/集成测试绿 ≠ 真机可用。每阶段仍按 ADR-0007 的真机清单验，证据落盘。
  Playwright E2E 是本地可选项，不进默认 verify（需要运行中的 dsh 与鉴权）。

### 9.2 硬规则

- **写库测试必须隔离 `DSH_HOME`**：用 `tests/integration/support/tmp-home.ts` 的
  `createTempHome()`，在 import 宿主模块之前设 `process.env.DSH_HOME`，结束 `cleanup()`。
  它自带 **canary**：临时用户库必须落在临时 home 下、绝不能是真实 `~/.dsh`，`DSH_HOME`
  必须真指向临时目录；任何一条不满足，在建库前就红——一条断言换掉一次不可再生数据事故。
  2026-11-04 踩过：用真实库跑脚本，真的改了排期、加了补记债、写了 `review_log`。
- **禁止真实网络**：翻译/LLM/例句必须 stub（假 `ctx.llm`、`fetch` 打桩、已落盘缓存）。断网要能跑。
- **发音是纯前端 `speechSynthesis`**，测试里注入假 synth（`__setSynth` 之类测试接口），不要真的发声。
- **禁止打印后目测**：node:test 用 `assert/strict`（失败信息写中文且能独立读懂）；
  vitest 用 `expect` + RTL 查询（`getByRole`/`getByText`），断言用户可见行为，不要断言元素树 props。
- **不许复制被测逻辑**：node:test 直接 import 真实模块求值；组件层渲染真实产物
  `dist/client.js` 的 `__test__`。不要手搓 React 替身、不要按函数名切字符串。
- **测试要自己收尾**：`afterEach(cleanup)`（已由 `tests/support/setup.ts` 兜底）、
  dispose 测试必须验证 install→dispose→re-install 不叠加；写库测试清理临时目录。
- `--allow-real-db` 这类开关默认关闭，只允许人手在确认无副作用时打开。

### 9.3 什么时候必须有测试

| 改动                    | 要求                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- |
| 新增/修改路由           | `tests/integration/routes.test.ts` 加断言（真实 `ctx` 桩 + 临时库）；新领域可单开文件 |
| 修 bug                  | **先写一条会红的回归**再修；交付说明里写"哪个断言之前是红的"                          |
| 改排期/FSRS 映射        | `tests/unit/schedule.test.mjs` 覆盖间隔序列                                           |
| 改前端作用范围/标注判定 | `tests/features/scope.test.mjs`、`tests/features/annotate.test.mjs` 必须仍绿          |
| 改前端视图/交互         | `tests/component/*.test.tsx`（真实渲染 + 用户可见断言）                               |
| 改 install/dispose      | `tests/component/install-dispose.test.ts` 必须仍绿（监听/DOM 不叠加）                 |
| 改 AI 队列生命周期      | `tests/unit/enrich-queue.test.mjs` 锁 dispose 后重新武装                              |
| 改响应形状              | 同步改前端调用与 `tests/integration` 断言                                             |
| 改 schema/迁移          | 加迁移回归（真实临时库）；老库/新库/半新库三种形态                                    |
| 纯注释/文档             | 不需要                                                                                |

## 10. 完成定义（DoD）

- [ ] 改动范围与任务一致，没有顺手重构无关代码。
- [ ] 新增/改动的路由已在 `README.md`「接口」表登记（接口表是唯一对外清单）。
- [ ] 新增行为有测试；修的 bug 有回归断言（且能说明它之前为什么红）。
- [ ] 没有新增 `eslint-disable`（确需例外时写明原因 + 到期条件）。
- [ ] 没有改 `.dependency-cruiser.cjs` 放行环/跨边界；没有手改 `dist/**`、`lib/host/**`。
- [ ] `pnpm lint:fix` 与 `pnpm format` 已跑，`pnpm format:check` 通过。
- [ ] `pnpm verify` 全绿，并保留输出。
- [ ] 注释与代码一致，过时注释已删改。
- [ ] 数据/schema 变更已写进 `DESIGN.md` §2，迁移幂等。
- [ ] 前端改动写明生效方式（`pnpm build` / `pnpm dev` + HMR；宿主需重挂）。
- [ ] 没有碰 `data/`、真实 `user.db`、手改 `pnpm-lock.yaml`。
- [ ] 交付说明含：改了哪些文件 + 为什么、`pnpm verify` 结果、剩余风险/未覆盖点。

## 11. 提交与变更

- **小步**：一次提交只表达一个可验证的意图；格式化与逻辑改动分两次。
- 前缀 + "为什么"：

| 前缀                         | 用于                                   |
| ---------------------------- | -------------------------------------- |
| `feat:`                      | 新功能（路由、视图、交互）             |
| `fix:`                       | 修 bug（写触发条件与修复点）           |
| `refactor:`                  | 不改行为的拆分/搬迁                    |
| `test:` / `docs:` / `chore:` | 只改测试 / 只改文档 / 配置·依赖·格式化 |

写"为什么"，不写"改了什么"。反例 `fix: 修改 index.js`；正例
`fix: 先发评分响应再记补记债，避免客户端重试导致重复评分`。
不把 `.db`、`cache/`、截图、`dist/`、`lib/host/` 混进提交；`docs/adr/`、`docs/plans/` 的历史材料只增不改。
改规则（`eslint.config.js`、`.dependency-cruiser.cjs`、`tsdown.config.ts`、测试基座）单独一次提交，
说明影响面并同步本文档。

## 12. 依赖政策

### 12.1 运行时依赖门槛

新增 `dependencies` 必须同时满足：

1. 在 `src/host/**` 或 `src/client/**` 真实使用，不能是"以后可能用"；
2. 纯 ESM 可直接 import，无原生编译、无 `postinstall`；
3. 许可清楚（MIT/BSD/Apache 可接受；GPL 系单独评估，见 DESIGN.md 风险 7）；
4. 离线可用，或只用于可降级的增强；
5. 能内置替代的优先内置：`node:sqlite`、`node:test`、全局 `fetch`、`node:fs/promises`；
6. 客户端依赖会被打进 bundle：体积成本算进 `artifact:check` 的预算（400 KB / 100 KB gzip），
   大依赖优先留在宿主侧。

现有唯一运行时依赖 `ts-fsrs@6.0.0`（MIT）。**钉死版本，不追 FSRS-7**——
排期参数是实测校准的，换大版本等于换算法（DESIGN.md §4）。

### 12.2 开发依赖可放宽

构建/测试链（`typescript`、`tsdown`、`vitest`、`jsdom`、`@testing-library/*`、`dependency-cruiser`、
`eslint`、`prettier`）已存在且只用一次；再新增开发依赖要回答：「现有工具链做不到吗？
它的维护成本谁付？」，并写进提交说明。
不要把开发依赖混进 `dependencies`（会被打进宿主安装包）。

### 12.3 lockfile 与升级

- `pnpm-lock.yaml` **只由 pnpm 生成**：禁止手改，禁止用 npm/yarn 装包。
- 升级依赖单独一次提交，写升级原因 + `pnpm verify` 结果。
- 升级 `ts-fsrs` 前先对比 `tests/unit/schedule.test.mjs` 的间隔序列；大版本视为算法变更，
  需要重新校准。
