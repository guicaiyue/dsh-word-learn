# 工程规范（dsh-word-learn）

## 0. 这份文档管什么

写给下一次改这个插件的人或 AI。它解释**为什么**，以及哪些判断机器查不出来。

| 谁          | 管什么                                                           | 权威文件                              |
| ----------- | ---------------------------------------------------------------- | ------------------------------------- |
| Prettier    | 排版：缩进、引号、换行、尾逗号、表格对齐                         | `.prettierrc.json`、`.prettierignore` |
| ESLint      | 正确性 + 架构边界 + 文件体量预算                                 | `eslint.config.js`                    |
| 本文档      | 配置表达不了的判断：职责归属、契约、拆分时机、测试纪律、依赖门槛 | 本文档                                |
| `README.md` | 用户视角的功能与接口清单                                         | `README.md`                           |
| `DESIGN.md` | 历史设计结论与实测踩坑                                           | `DESIGN.md`                           |

优先级：**ESLint 报错 > 本文档 > 个人偏好 > 参考仓库的写法**。冲突时改代码，不改规则。
本文档不抄配置项：`printWidth` 之类的值看 `.prettierrc.json`；`lib/` 为什么不能 import `assets/` 往下读。文档与机器版本不一致时以机器为准，并修文档。

## 1. 项目形态与目录职责

零构建 ESM 插件：宿主直接 `import` `lib/index.js`，页面直接 `<script>` 加载 `assets/*.js`。
没有打包、没有转译、没有 `dist/`。Node >= 22.5，包管理器 pnpm，运行时依赖只有 `ts-fsrs`。

| 路径                               | 跑在哪                        | 能做什么                                                  | 禁止什么                                         |
| ---------------------------------- | ----------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `lib/index.js`                     | 宿主（Node ESM）              | 注入行、信任栅栏、registerRoute 包装、挂载/卸载           | 写业务算法；写 handler；拼 SQL；import `assets/` |
| `lib/routes/*.mjs`                 | 宿主（Node ESM）              | 25 条路由按组注册：assets/study/review/ai/repair/annotate | 绕开 registerRoute；自己拼响应头                 |
| `lib/routes/shared.mjs`            | 宿主（Node ESM）              | safeSend / fail / readJson / intParam 之外的公共出口      | 直接 res.writeHead 二次写头                      |
| `lib/routes/paths.mjs`             | 宿主（Node ESM）              | 路由路径常量唯一出口                                      | handler 里写死路径字符串                         |
| `lib/runtime.mjs`                  | 宿主（Node ESM）              | 词典/用户库单例、前端脚本 mtime 缓存                      | 路由层状态；加载 assets 里的业务逻辑             |
| `lib/lookup.mjs`                   | 宿主（Node ESM）              | 查词组装（词典 + 补全 + 生词本 + 警告）                   | 直接注册路由                                     |
| `lib/http.mjs`                     | 宿主（Node ESM）              | 路由层 query 参数读值与钳制                               | 在 handler 里裸写 `Number(...)`；自己夹上下限    |
| `lib/*.mjs`、`lib/text.js`         | 宿主（Node ESM）              | 词典、存储、排期、翻译、AI、R5、文本工具                  | import `assets/`；模块加载时开用户库             |
| `assets/wordcard.js`               | 页面（普通 `<script>`，IIFE） | 划词判定、浮层卡片、调本插件路由                          | import/export、`require`、`process`、改正文      |
| `assets/annotate.js`               | 页面（普通 `<script>`，IIFE） | 给已学词加虚线下划线                                      | 同上；标代码块/流式内容/其它插件弹窗             |
| `assets/dashboard.js`              | DSH 客户端（React 模块）      | 左栏入口、学习页、客户端 locale                           | Node API；ESM import；直连 SQLite                |
| `data/ecdict.db`                   | 只读                          | ECDICT 精简词典，可重建                                   | 写入；提交进 git                                 |
| `$DSH_HOME/dsh-word-learn/user.db` | 只经 `lib/store.mjs`          | 生词本、卡片、复习日志、设置                              | 测试直连真实库                                   |
| `$DSH_HOME/dsh-word-learn/cache/`  | 可删                          | 翻译缓存（发音不走网络，没有音频缓存）                    | 当持久数据依赖                                   |
| `scripts/test-*.mjs`               | Node（手跑）                  | 回归脚本，可单独执行                                      | 真实网络、真实用户库                             |
| `tests/`                           | Node（`node --test`）         | 新增功能的单测                                            | 同上                                             |
| `design/`、`lab/`                  | 不运行                        | 历史设计稿、实验页、截图                                  | 被 `lib/` 或 `assets/` 引用                      |
| `locale/`                          | 宿主与客户端                  | 包级文案（`meta.*`）                                      | 放业务文案                                       |

分文件是因为"改翻译不碰排期"：词汇、存储、排期、外部能力（`translate`/`enrich`/`ai-enrich`/`models`）各一层，新模块照这个切法起名。
发音在 `assets/voice.js`（纯浏览器 speechSynthesis，零网络），没有服务端模块。

## 2. 三条铁律

违反会坏在用户机器上，而且往往不报错。

### 2.1 `assets/` 不许 import，也不许碰 Node API

`assets/` 是被 `<script>` 直接塞进页面的，页面里没有模块解析器：`import` 是语法错误，
`require`/`process` 是未定义全局（ESLint 三个都禁了）。唯一例外是 `dashboard.js` 的
`require('react')`——那是 `__ModuleLoader__.load({ factory(require) })` 传进来的参数，
不是 Node 的 `require`，所以只能 `require('react')`。

反过来 `lib/` 也不许 import `assets/`：那些代码假设自己在浏览器里（`window`/`document`）。
两份需要共享的实现（比如发音逻辑）**故意重复**，因为打包器不存在。改一处必须同步另一处，
并在注释里写明"另一份在哪"。

### 2.2 颜色只走 `--dsw-alias-*` 主题令牌

- 一律 `var(--dsw-alias-bg-overlay, 兜底值)`，兜底只在令牌缺失时生效。
- 不许判 `data-theme="dark"`：DSH 的深色标记是 `body[data-ds-dark-theme]`（DESIGN.md 风险 13）。
- 不许只监听 `matchMedia`：手动切主题时系统偏好没变，必须同时用 `MutationObserver` 盯 body。
- 不许凭感觉填色：新令牌先查 DESIGN.md §9 的令牌取值表并核对对比度
  （浅色 `label-tertiary` 只有 3.71，只够大字）。

在用令牌：`bg-base/layer-1/2/3/overlay/skeleton`、`border-l2`、`label-primary/secondary/tertiary`、
`interactive-bg-hover`、`brand-primary`、`state-{success,warn,error,business}-primary`。

### 2.3 不引入构建步骤

宿主直接加载源码，"改一行"的成本应该只是一次保存。引入 TS/bundler/CSS 预处理器之后：
改代码要先 build（忘了就是"改了没生效"的假故障）、`lib/` 的 mtime 热重载与 `assets/` 的重读全部失效、
宿主 import 的目标从源码变产物导致堆栈对不上行号。所以要类型写 JSDoc，要复用按 2.1 复制，不写 TS、不加打包、不引入需要编译的 CSS。

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
- 空 `catch` 必须紧邻一句"为什么可以吞"（注入行、页面侧、响应已发出后的收尾副作用都属于此类）。

### 3.3 命名

| 对象         | 规则                          | 例子                                            |
| ------------ | ----------------------------- | ----------------------------------------------- |
| 文件名       | 短、小写、按职责              | `store.mjs`、`ai-enrich.mjs`、`test-routes.mjs` |
| 常量         | `UPPER_SNAKE`                 | `CODE_BUDGET`、`MAX_INPUT`、`LEECH_THRESHOLD`   |
| 函数/变量    | `camelCase`                   | `lookupWord`、`dueQueue`                        |
| 布尔         | `is`/`has`/`should`/`can`     | `isFalse`、`shouldEnrich`                       |
| CSS 类       | `dwl-` 前缀                   | `dwl-card`、`dwl-anno`                          |
| localStorage | `dwl-*` 或 `dsh-word-learn:*` | `dwl-voice-accent`、`dwl-voice-pref:us`         |
| window 守卫  | `__dwl*`，每个脚本独立        | `__dwlAnnotate`、`__dshWordLearnBoot`           |

**守卫名各用各的**：注入器用 `__dshWordLearnBoot`，脚本用自己的 `__dshWordLearn`/`__dwlAnnotate`。
2026-11-04 踩过：注入器抢了脚本的守卫名，脚本一执行就 return，整个卡片没装。

### 3.4 导出形态

- `lib/index.js` 默认导出 `{ name, apply(root) }`（宿主契约）。
- 其余 `lib/*` 一律**命名导出**，方便测试按需引；不要为整齐加 `default`。
- `assets/` 的 IIFE 不导出，状态挂 `window.__dwl*`；`dashboard.js` 只导出 `{ inject, apply }`。
- 测试脚本不导出，用 `process.exitCode` 决定成败。

### 3.5 异步与错误处理

照 `lib/index.js` 抄，别自创：

1. 路由 `handler` 可以 `async`，但**参数解析失败必须自己 `sendJson(..., 400, ...)` 返回**；
   抛给外层只能得到 500，而 400 才是事实。
2. 业务异常进 `fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)`。
   原始 `err.message` 常带绝对路径，**只进 `console.warn`，不给浏览器**。
3. 响应发出后的副作用（入队、记债）必须自己吞错：已发出的响应改不了状态码，抛出去只会引发重试。
4. 只读查询用同步 `node:sqlite` 没问题，别为"异步"包 Promise。
5. 统一出口 `safeSend`：已发过就什么都不做，绝不二次写头。

### 3.6 数值与字符串一律钳制

外部输入没有可信度。数字参数一律走 `lib/http.mjs`：

```js
const limit = intParam(url, 'limit', { fallback: 200, min: 1, max: 500, floor: true })
```

- 禁止在 handler 里裸写 `Number(url.searchParams.get(...))`：读值与钳制只留一个入口。
- `fallback` 兜的是缺省 / 空串 / 非数字 / 0，与旧的 `Number(x) || fallback` 等价。
- `floor: true` 只给分页类（`limit`/`offset`），其余参数保持原值。
- 字符串用 `strParam(source, name, fallback)`，进库/外呼前再 `slice(0, N)`；布尔用 `isFalse()`
  （`'false'` 是字符串，`!== false` 会当 true，踩过）。非法值**就地 400**，别"兜底成默认值"。

## 4. 模块与拆分

### 4.1 预算表怎么读

`max-lines` 按**代码行**算：空行和注释不计。所以预算衡量的是"代码有多复杂"，不是"文件多长"，
注释写得多不会报警。默认 400；已豁免的都在 `eslint.config.js` 的 `CODE_BUDGET`，每一条都是历史债：

| 文件                  | 预算    | 现状（代码行）                    |
| --------------------- | ------- | --------------------------------- |
| `lib/index.js`        | 210     | 入口：注入行 + 栅栏 + 挂载/卸载   |
| `lib/routes/*.mjs`    | 400     | 六组路由，单组最重约 234 行       |
| `lib/runtime.mjs`     | 400     | 单例 + 三段脚本缓存               |
| `lib/lookup.mjs`      | 400     | 查词组装                          |
| `lib/store.mjs`       | 800     | schema + migrate + 全部用户库读写 |
| `lib/ai-enrich.mjs`   | 620     | 分析 / 义项 / 队列 / 出题         |
| `assets/dashboard.js` | 3400    | 学习页四视图 + CSS，最大          |
| `assets/annotate.js`  | 1300    | 标注全流程                        |
| `assets/wordcard.js`  | 1150    | 划词卡片 + CSS                    |
| `scripts/test-*.mjs`  | 380–560 | 端到端脚本，长是正常的            |

**预算是警报，不是目标。** 贴着上限写不算达标，离上限很远也不代表写得好。

### 4.2 什么时候该拆

满足任一就拆，别等 ESLint 报错：

- 文件里出现第二个职责名词（"这里还顺手做了 X"就是信号）；
- 某段逻辑想单独测，却只能整文件跑；
- 改一个功能要动三处互不相邻的区域；
- 新增一条路由，handler 要挤 80 行以上业务代码；
- 同一分支在 `assets/` 与 `lib/` 各有一份且开始不一致。

### 4.3 怎么拆

1. 先抽**纯函数**到独立 `lib/*.mjs`：无 `ctx`、无网络、无文件系统，输入输出都是普通对象。
2. 路由 handler 只留：解析 → 校验/钳制 → 调 service → `safeSend`。
3. 外部服务把"取服务"和"发请求"分开：`service.mjs` 负责 `ctx.get(name)`，
   业务模块只接收依赖，测试传假对象即可。
4. 拆完按需加进 `CODE_BUDGET`，并同步 §4.1 的表。

### 4.4 不许有 import 环

`lib/` 之间、以及 `tests/`/`scripts/` 对 `lib/` 的引用，都不许成环。环会让「谁依赖谁」失去方向：
拆模块时绕一圈又拆回去，改 A 会莫名影响 B，单测也不得不整包跑。

- 门禁：`pnpm check:cycles`（`scripts/check-cycles.mjs`，遍历静态 `import` 与动态 `import()`，
  打印完整环路径并 exit 1），已挂进 `pnpm check` → `pnpm verify`；
- 为什么不用 ESLint 插件：ESLint 10 下 `eslint-plugin-import-x` 4.17.1 的 `no-cycle` 实测对
  故意造出的 `a.mjs ↔ b.mjs` 环不报错（resolver-next / 旧 node resolver 都试过），已移除；
- 检测器自身有单测（`tests/unit/cycles.test.mjs`：正例、菱形误报、多环、动态 import），
  保证门禁不是摆设。

### 4.5 不许做的

- **调大 `CODE_BUDGET` 让 lint 变绿**——本项目唯一明令禁止的"修复"。
- 把逻辑挪进 `assets/` 另一个文件规避预算（预算对所有文件生效）。
- 用 `eslint-disable` 绕 `max-lines`（它也不支持行内禁用）。
- 为拆而拆：抽出只调用一次、6 个参数的"工具函数"。

## 5. 路由契约

### 5.1 注册位置

所有路由只能在 `lib/index.js` 的 `root.inject(['webServer'], (ctx) => { ... })` 里注册，
并经过 `registerRoute`（它自动套栅栏、方法白名单、500 兜底）。别处直接
`ctx.webServer.register` 会绕过栅栏。

- `kind: 'exact'` + 完整路径；路径常量集中在文件头（如 `API_LOOKUP`）。
- **写操作必须显式 `methods: ['POST']`**；不声明等于任何方法都放行，GET 也能顺手写库。
- 前端脚本路由（`/client.js`、`/annotate.js`）不声明 methods，但必须 `Cache-Control: no-store` 并按 mtime 重读。
- 现状例外：`/update`、`/remove`、`/grade`、`/model` 等历史路由没声明 methods，改动它们时补上，别照抄。

### 5.2 入参

- POST 体一律 `readJson(req)`：只接受 JSON 对象；数组/标量/`null`/空 body 在那里抛，
  由 handler 的 400 分支接管（别让它变成 `TypeError` → 500）。上限 256 KB。
- GET query 全是字符串：布尔用 `isFalse()`，数字按 §3.6 钳制，字符串 `slice` 上限。
- 词输入必须过 `looksLikeWord`（单 token 时）——路由是公开的，前端过滤不是唯一防线。
  2026-11 实测漏进来过 `≈62.3M` 的 `M`、`≈65.7k` 的 `k`。
- 长文本有上限：翻译 6000 字符、原句 2000、请求体 256 KB。新增入口照这个加。

### 5.3 响应

成功 `{ ok: true, ... }`，失败 `{ ok: false, code?, error }`。`code` 是前端分支用的稳定字符串
（`DB_UNAVAILABLE`、`METHOD_NOT_ALLOWED`、`INTERNAL_ERROR`…），`error` 是一句能给用户看的中文。
**不要把 `err.message` 塞进 `error`。**

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

1. 路径常量加到 `lib/index.js` 头部；
2. `registerRoute` 实现，handler 只做解析 + 转发；
3. 业务进 `lib/*.mjs` 并补单测；
4. `README.md`「接口」表加一行（方法 / 路径 / 说明 + 参数）；
5. `scripts/test-routes.mjs` 加端到端断言（桩 ctx 真跑，不用重启宿主）；
6. 前端要用的，在各 `assets/*.js` 的 `API` 常量表加一行；
7. 跑 `pnpm verify`。

漏了第 4 步，下一个人就不知道这条路由存在——接口表是唯一清单。

### 5.5 handler 的边界

允许：读 `req`、`readJson`、`new URL`、校验与钳制、调 `store`/`dict`/`schedule`/`translate`/
`ai-enrich`、`safeSend`/`fail`/`unavailable`。
不允许：SQL、FSRS 参数计算、fetch、文件路径拼接、超过 20 行的聚合逻辑。出现就该拆 service（§4.3）。

## 6. 数据访问

### 6.1 三个数据位置

| 数据   | 位置                               | 可再生                        | 规则                      |
| ------ | ---------------------------------- | ----------------------------- | ------------------------- |
| 词典   | `<插件目录>/data/ecdict.db`        | 是（`scripts/build_dict.py`） | 只读，只经 `lib/dict.mjs` |
| 用户库 | `$DSH_HOME/dsh-word-learn/user.db` | **否**                        | 只经 `lib/store.mjs` 打开 |
| 缓存   | `$DSH_HOME/dsh-word-learn/cache/`  | 是                            | 可直接删，不当持久数据    |

用户库路径由 `DSH_HOME` 决定（缺省 `~/.dsh`），这个变量同时是测试隔离开关（§9.2）。

### 6.2 SQL 归口

- 用户库**新 SQL 一律加在 `lib/store.mjs` 的方法里**（现在 60+ 处）。
- 排期/回访/标注模块接收 `store.db` 句柄做针对性查询（`schedule`/`r5`/`annotate` 的历史写法）。
  这是历史债：**只允许收窄，不允许扩散**——不要在这些模块新增表级写入。
- 词典 SQL 只许在 `lib/dict.mjs`；别处要词数据调 `dict.lookup()`。
- 参数一律绑定（`prepare(...).get(word)`），不拼字符串。拼 SQL 的地方就是注入点。

### 6.3 schema 变更

1. 改 `lib/store.mjs` 的 `SCHEMA`（`CREATE TABLE IF NOT EXISTS` 只对新库生效）；
2. **必须**在 `migrate()` 加增量步骤：`PRAGMA table_info` 查列、缺列 `ALTER TABLE ADD COLUMN`；
3. 迁移必须幂等：老库/新库/半新库跑同一段代码得到同一结构；
4. 在 `DESIGN.md` §2 记一笔：日期、加改了什么、为什么、怎么迁。
   反例见风险 14：`learning_steps` 没存，排期静默失效（间隔永远 0 天，不报错）。

禁止：`DROP TABLE`、重建库、改列类型、在迁移里写业务逻辑。用户数据不可再生。

### 6.4 迁移与备份

- 开发前先复制 `user.db`（含 `-wal`/`-shm`）到临时目录，拿副本做实验。
- 重跑迁移验证时用 `DSH_HOME=<临时目录>`，不要动真实库。
- 写库测试必须 `mkdtemp` 临时 `DSH_HOME`（§9.2）；`store.mjs` 在 import 时按 `DSH_HOME` 定路径，
  所以**必须在 import 之前设好**环境变量。
- 备份不是插件职责：README 已写"生词本不可再生，请备份"，不要加自动备份/云同步。

### 6.5 写库的幂等

同一动作重复调用不能产生第二条记录或第二次评分：`touch` 撞已有行就 `seen_count + 1`；
卡片按 `UNIQUE(word_id, track)` 建、`ensureCards` 可重复调；评分接口不接受重试（服务端不回 5xx 诱导重试，去重由前端做）。

## 7. 前端约定

### 7.1 两个注入面，选型是硬判断

|          | 普通 script（`wordcard`/`annotate`）                    | dsh.client（`dashboard`）                                |
| -------- | ------------------------------------------------------- | -------------------------------------------------------- |
| 加载     | `webserver/index-inject` 内联脚本 → 自建 `<script src>` | `package.json` 的 `dsh.client` + `__ModuleLoader__.load` |
| 技术栈   | 原生 DOM，无依赖                                        | React（加载器提供）                                      |
| slot     | 不能                                                    | 能（`sidebar.panellist`、`main`）                        |
| 改动生效 | 硬刷新页面（按 mtime 重读）                             | **重新激活插件**（激活时读快照）                         |
| 坏了     | 只影响自己                                              | 可能拖垮客户端包                                         |

判据：**要挂进 DSH 布局 → client 模块；只加工页面内容 → 普通 script。**
不要为"用上 React"把纯 DOM 功能塞进客户端包；也别想在普通 script 里注册 slot。

### 7.2 样式

- 类名 `dwl-` 前缀，选择器限定在自己的根节点下（`.dwl-card ...`）。
- 不写全局选择器（`button {}`、`* {}`），不 `!important` 盖宿主样式。
- 颜色见 §2.2；间距/圆角可自带，字号跟 DSH body 走，不写死大字号。
- `dashboard.js` 的 `<style>` 挂 `<head>` 并带 `data-plugin="dsh-word-learn"`，
  在 `ctx.effect` 清理函数里移除，别留孤儿样式。
- 浮层一律 `position: fixed` + `--dsw-alias-bg-overlay`，不要 absolute 挂宿主节点。

### 7.3 不碰页面 DOM

- `wordcard.js`：只**读**选区，只往 `document.body` 追加自己的浮层；绝不改正文节点、
  不包裹文本、不改宿主属性。异常一律吞掉（注释说明为什么），不能因为划词把页面搞白。
- `annotate.js`：只在 `[data-chat-flow]` 内操作，且只包裹**自己认定的目标词**节点。
  排除代码块/行内代码/文件名/URL/链接、流式生成（`[data-streaming]` + 文本稳定 600ms）、
  折叠内容（只标标题）、其它插件弹窗。原文不改、不翻译。
- 作用范围判定必须从真实源码切出来测（`scripts/test-scope.mjs`），不要复制一份逻辑。

### 7.4 无障碍

可点元素用 `<button type="button">`；图标按钮必须 `aria-label`；动态区域（结果、错误、朗读状态）
用 `aria-live="polite"`；键盘可达（卡片 Esc 关、学习视图空格揭晓、`1-4` 评分），焦点态不能被 CSS 抹掉；
触控目标不小于 28×28；不要用 hover 当唯一入口。

### 7.5 热重载与验证

| 改了什么                                   | 怎么生效                                                      |
| ------------------------------------------ | ------------------------------------------------------------- |
| `assets/wordcard.js`、`assets/annotate.js` | 硬刷新页面（mtime 热重载，no-store）                          |
| `assets/dashboard.js`                      | **重新激活插件**（改 `cordis.patch.yml` 触发 HMR 或重启宿主） |
| `lib/*`                                    | 重挂插件即可，不必重启宿主                                    |

"生效没有"的权威信号是 `__DSH_BOOT__.entries` 里有没有 `dsh-word-learn`；取脚本用清单里的
`url` 字段（`/plugins/??dsh-word-learn/client.js&rev=<hash>`），自己拼
`/plugins/dsh-word-learn/client.js` 一定 404。详细步骤见 README「开发」节。

## 8. i18n

| 层     | 位置                               | 内容                                 | 谁读                                     |
| ------ | ---------------------------------- | ------------------------------------ | ---------------------------------------- |
| 包级   | `locale/zh.json`、`locale/en.json` | 只有 `meta.title`/`meta.description` | 宿主按 `./locale/*.json` 导出约定读      |
| 客户端 | `assets/dashboard.js` 的 `DICT`    | 侧栏/面板标题                        | `ctx.locale.register(NS, DICT)` 后 `t()` |

- **两份键必须同步**：`zh`/`en` 的键集合完全一致；`DICT` 里 `zh`/`en` 同键。加一个键两处一起加。
- **注册必须早于 slot**，否则 `label` 求值时目录还是空的（DESIGN.md 风险 17）。
- **缺键的回落是"原始 key"**，不是英文也不是中文兜底：没注册目录时 `t('panel.title')`
  会在侧栏显示 `panel.title`。所以宁可不加 key，也不要加半套。
- `locale: NS` 只是声明不是注册；声明了不 `register` 等于空配置。
- NS 固定 `dsh-word-learn`，必须过 BCP 47 正则 `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$`，否则宿主 throw。
- **`lib/` 不做翻译**：宿主侧没有 locale 服务。`lib/` 只回稳定 `code` + 中文人话，英文由前端按
  `code` 映射；新增 `code` 时在文档记一句语义。

## 9. 测试

### 9.1 三个入口

| 命令                      | 跑什么                                                   | 何时跑               |
| ------------------------- | -------------------------------------------------------- | -------------------- |
| `pnpm test:unit`          | `node --test "tests/**/*.test.mjs"`                      | 改完逻辑             |
| `pnpm test:unit:coverage` | 单测 + 覆盖率门槛（http/text/models）                    | 改纯函数或模型层     |
| `pnpm test:legacy`        | `node scripts/test-all.mjs`（收编 `scripts/test-*.mjs`） | 改路由/前端判定/排期 |
| `pnpm check:cycles`       | `scripts/check-cycles.mjs`（lib/ import 环）             | 拆/并模块后          |
| `pnpm verify`             | `check`（lint + format:check + 环检测）+ 上面三个        | **交付前唯一验收**   |

`tests/` 放 `node:test` 单测（`*.test.mjs`），覆盖纯函数与模块契约；
覆盖率只给已经有单测的三个模块设门槛（`lib/http.mjs`、`lib/text.js`、`lib/models.mjs`，
行 95% / 分支 85% / 函数 95%）：先把门槛钉在达标处，改坏了会红；没单测的模块不设假门槛。
`scripts/test-*.mjs` 是历史端到端脚本，可单跑，但必须登记进 `scripts/test-all.mjs`，
否则 CI 只跑一半。顺序：单跑通过 → 注册进 `test-all.mjs` → `pnpm verify`。

### 9.2 硬规则

- **必须临时 `DSH_HOME`**：`fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-xxx-'))`，
  在 `import` 插件之前设 `process.env.DSH_HOME`，退出时 `rmSync` 清理。
  理由：`store.mjs` 在 import 时按 `DSH_HOME` 打开用户库，用真实库跑脚本会真的改排期、加补记债、
  写 `review_log`（2026-11-04 踩过）。宿主导出过 `DSH_HOME`，**不能**用"没设才临时"的判断。
- 禁止真实网络：翻译/LLM/例句必须 stub（假 `ctx.llm`、`fetch` 打桩、已落盘缓存）。断网要能跑。
- 发音是纯前端 `speechSynthesis`，测试里用 `__setSynth` 注入假 synth，不要真的发声。
- 禁止打印后目测：用 `assert/strict`，失败信息写中文且能独立读懂，例如
  `assert.equal(got, 'child', 'children 应回退到原形 child，实际得到 ' + got)`。
- 测前端判定**从真实源码切片段**求值（`test-scope.mjs` 用 `indexOf` 切 `SCOPE_SELECTOR`/`inConversation`），
  不要在测试里复制实现——那样改了源码测试还绿。
- `--allow-real-db` 这类开关默认关闭，只允许人手在确认无副作用时打开。

### 9.3 什么时候必须有测试

| 改动                    | 要求                                                         |
| ----------------------- | ------------------------------------------------------------ |
| 新增/修改路由           | `scripts/test-routes.mjs` 加断言（桩 ctx 真跑）              |
| 修 bug                  | **先写一条会红的回归**再修；交付说明里写"哪个断言之前是红的" |
| 改排期/FSRS 映射        | 单测覆盖间隔序列（`test-schedule.mjs` 是范例）               |
| 改前端作用范围/标注判定 | `test-scope.mjs`/`test-annotate.mjs` 必须仍绿                |
| 改响应形状              | 同步改前端调用与端到端断言                                   |
| 纯注释/文档             | 不需要                                                       |

## 10. 完成定义（DoD）

- [ ] 改动范围与任务一致，没有顺手重构无关代码。
- [ ] 新增/改动的路由已在 `README.md`「接口」表登记。
- [ ] 新增行为有测试；修的 bug 有回归断言（且能说明它之前为什么红）。
- [ ] 没有新增 `eslint-disable`（确需例外时写明原因 + 到期条件，见 §4.4）。
- [ ] 没有调大 `CODE_BUDGET`；超预算已按 §4.3 拆分。
- [ ] `pnpm lint:fix` 与 `pnpm format` 已跑，`pnpm format:check` 通过。
- [ ] `pnpm verify` 全绿，并保留输出。
- [ ] 注释与代码一致，过时注释已删改。
- [ ] 数据/schema 变更已写进 `DESIGN.md` §2，迁移幂等。
- [ ] 前端改动写明了生效方式（硬刷新 / 重新激活插件）。
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
不把 `.db`、`cache/`、截图混进提交；`design/` 的历史材料只增不改。
改规则（`eslint.config.js`、预算、格式化选项）单独一次提交，说明影响面并同步本文档。

## 12. 依赖政策

### 12.1 运行时依赖门槛

新增 `dependencies` 必须同时满足：

1. 在 `lib/` 或 `assets/` 真实使用，不能是"以后可能用"；
2. 纯 ESM 可直接 import，无原生编译、无 `postinstall`；
3. 许可清楚（MIT/BSD/Apache 可接受；GPL 系单独评估，见 DESIGN.md 风险 7）；
4. 离线可用，或只用于可降级的增强；
5. 能内置替代的优先内置：`node:sqlite`、`node:test`、全局 `fetch`、`node:fs/promises`；
6. 体积与启动成本可接受（插件加载在宿主进程里）。

现有唯一运行时依赖 `ts-fsrs@6.0.0`（MIT）。**钉死版本，不追 FSRS-7**——
排期参数是实测校准的，换大版本等于换算法（DESIGN.md §4）。

### 12.2 开发依赖可放宽

eslint / prettier / globals 这类不进运行时的按需加，不必走上面的门槛。
但同样**不许引入构建链**（typescript、tsup、esbuild、postcss 等编译步骤，见 §2.3）。
加之前先问：`node:test` + `assert/strict` 够不够？

### 12.3 lockfile 与升级

- `pnpm-lock.yaml` **只由 pnpm 生成**：禁止手改，禁止用 npm/yarn 装包。
- 升级依赖单独一次提交，写升级原因 + `pnpm verify` 结果。
- 升级 `ts-fsrs` 前先跑 `test-schedule.mjs` 对比间隔序列；大版本视为算法变更，需要重新校准。
