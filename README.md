# dsh-word-learn · 划词学单词

在 DSH 对话里划中任意英文单词，就地浮出学习卡：音标、释义、词形变化、词频分级、
真人发音、例句与近义词。查过的词自动进生词本，P2 起接 FSRS 间隔重复复习。

面向的场景很具体：**以英语为工作语言的开发者，读英文技术内容时靠模型的思维链**。
这类人的问题不是"没背过单词"，而是"一个词只认得它在某处的那一个意思"，
并且**读得准不准自己也不知道**。

## 它和划词翻译有什么不同

|          | 划词翻译           | 本插件                         |
| -------- | ------------------ | ------------------------------ |
| 目标     | 让你**看懂这句话** | 让你**记住这个词**             |
| 结果     | 译文，看完就忘     | 生词本 + 复习排期              |
| 对常见词 | 照样翻译           | 标出"这是高频词，你多半已认识" |
| 数据     | 无                 | 本地 SQLite，可导出            |

## 已实现（P1）

- **划词卡片**：选中即查，不修改页面 DOM，纯浮层
- **只对对话正文生效**：选区两端必须落在 `[data-chat-flow]` 里（Chat 视图正文列）。
  左侧栏、右侧栏、轨迹（Trajectory）页、英语学习看板一律不响应。
  严格模式：锚点找不到就完全不弹，不会退回"全页面乱弹"。
  改动前先跑 `node scripts/test-scope.mjs`（见 DESIGN.md 风险 19）
- **划句子给译文**：选中整句时先给中文译文，下面再列可拆的候选词。
  优先用 **DSH 自己的模型**翻（技术语境更准，`reviews`→复习、`latent space`→潜空间），
  模型不可用时降级到 **MyMemory** 公共接口；翻译挂了也不影响拆词
- **本地词典**：ECDICT 精简为 14.4 MB SQLite，59,111 词条 + 39,053 变形索引，**离线可查**
- **变形回退**：`children` → `child`、`better` → `good`、`perceived` → `perceive`，
  并**继承原形的词频**（ECDICT 把变形词单独立条，词频字段常常是错的）
- **词频分级**：最高频 1000 / 高频 3000 / 常用 8000 / 低频 / 专业词
- **代码过滤**：`src/lib/index.js`、`config_path`、`getElementById` 不会被当成单词
- **数值后缀过滤**：`≈62.3M`、`≈65.7k` 不会被当成单词 `M` / `k`
  （前端与宿主路由**两处**都设了闸，见 DESIGN.md 风险 18）
- **真人发音 + 例句**：例句来自 dictionaryapi.dev（带磁盘缓存，拿不到就降级，不影响查词）；
  发音走**浏览器内置语音**（`src/client/features/voice.js` → `speechSynthesis`）：零网络、离线可用，
  优先挑系统里的 natural/online 英文音色，选中的音色与语速记在本地。
  浏览器不允许录制合成结果，所以没有音频文件缓存——每次都是本机实时合成
- **自动发音（可关）**：进入学习页、单词出现时自动读一遍；看答案（忘了/模糊）和
  拼写结果出来时再读一遍，营造"边看边听"的环境。喇叭图标随时可以手动重听，
  自动播放出错不会弹提示。开关在 **设置 → 发音偏好 → 自动发音**
- **生词本**：记原句、遇见次数、五维能力画像（认得/意思/能写/能听/读准）、收藏、笔记
- **易混淆词可悬浮查义**：学习页和 AI 分析里的易混淆词/近义词是虚线小标签，
  鼠标停留（或点一下）浮出音标 + 释义，卡片里一键 **加入生词本**；
  悬浮只是预览，不会把扫过的词都塞进生词本
- **跟随 DSH 主题**：颜色取 DSH 的主题令牌（`--dsw-alias-*`），明暗切换自动跟随，无需重启
- **AI 分析模型可换**：词根拆解/干扰项/记忆法用哪个模型，在设置页从 **DSH 已有的文本模型列表**里选，
  默认用第一个；不跟随对话的默认模型，改完下一次分析立刻生效
- **分析失败给原因**：拿不到模型服务、没配 Key、限流、输出不是 JSON 会分别报出来，
  不再一律显示"可能是模型不可用"
- **信任栅栏**：跨站请求一律 403

## 学习页（P2a）

左栏上半部分有「英语学习」入口，点开是整页面板：

- **今日复习**：到期队列，直接评「忘了 / 勉强 / 记得 / 太简单」，写回 FSRS 排期
- **明日到期**：按当前排期算出明天有多少
- **未来 14 天预测 / 近 14 天复习量**：两张柱状图
- **学习进度**：按词频档位的堆叠条 + 已开始排期比例
- **能力画像**：五维（认得/意思/能写/能听/读准）各自的 0-5 分布直方图
- **报表**：正确率与作答分布、最容易忘的词、最近遇到

排期用 **FSRS-6**（`ts-fsrs@6.0.0`，MIT），每个词两条独立线：
**认得出**（receptive）与**写得出**（productive）。

- **写得出要等认得出稳了才上线**：receptive 进入复习态（`state>=2`）且评过至少 2 次，
  productive 才排进队列。查词建卡时 productive 只是先把结构建好，**不进队列**。
- **一个词一轮只出现一次**：两条线同一天到期时，先做更早到期的那张（同 due 时先认得出），
  另一张留到下一轮；看板的今日/明日/预测也按词去重。
  连着把同一个词做两遍是 massed practice，不是间隔重复——早先的实现漏了这两条，
  所以会出现"刚背完一个词，下一张还是它"。
- **两条线练的东西不一样**：认得出给英文、选释义；写得出给中文释义、把单词拼出来
  （提交后对照正确拼写，拼对/笔误/写错分别算 太简单/记得/忘了）。
- 一个词反复忘到 8 次会自动挂起（leech），不再进队列消耗耐心。
- **「忘了」不是直接给答案**：先自己写一次意思 → 对照释义和原句 → 把词拼对一次，
  才评 Again(1)。单词在拼写阶段被藏起来，喇叭和跳过也一并收起。
  这一步只增加提取与产出，**不改变评级**——补记成功照样评「忘了」，
  免得骗过 FSRS 把间隔拉长（见 `design/forgot-repair-loop.md`）。
- **有义项材料时先做四选一**：AI 按「这个词 + 你遇见它的原句」生成义项材料后，
  「忘了」会先让你从四个义项里选「这句里是哪个」，再给「你选的是 X / 这句里是 Y」
  的反差，然后才进拼写。分析还没跑完时自动退回上面的自由回忆。
- **会话末补记**：今天评过「忘了」的词，在这轮结束前再拼一次；拼对才清掉那笔
  「补记债」。统计页有「补记循环」面板，看义项首猜命中率与债的清偿。
- **次日回访**（R5）：第二天进学习页，先花一分钟做「昨天忘过的词，这两句里同一个意思吗」
  —— 同义/异义各半，答对清债、答错重开债，只记日志、不动 FSRS。可「跳过回访」。
- **对话内联标注**：你在读的英文里，**在学、有卡片**的词会带一条虚线下划线；
  悬停/聚焦出小卡（这个词在这句里的义项 + 「收进复习」）。原文不改、不翻译，
  代码块、行内代码、文件名、URL、链接、弹窗、其它插件界面都不标。
  折叠着的内容只标标题，展开后才补标；流式生成中的文字不碰。
  关掉：控制台 `localStorage['dwl-annotate'] = 'off'` 后刷新。

> 看板上的「正确率」是本插件自己定的口径（「记得/太简单」算对），
> **不是 FSRS 的官方指标**。

## 数据位置

| 文件     | 位置                               | 说明                 |
| -------- | ---------------------------------- | -------------------- |
| 词典     | `<插件目录>/data/ecdict.db`        | 只读，可重新生成     |
| 生词本   | `$DSH_HOME/dsh-word-learn/user.db` | **不可再生**，请备份 |
| 外部缓存 | `$DSH_HOME/dsh-word-learn/cache/`  | 可删                 |

## 重新生成词典

```powershell
# 1) 下载 ECDICT（63 MB）
curl -L -o D:\dsh-cache\tmp\ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv

# 2) 构建
python scripts\build_dict.py
```

## 接口

前端（划词卡 / 标注 / 学习页）全部在 `dist/client.js` 一个产物里，由宿主按
`package.json` 的 `exports["./client"]` 加载 —— **没有**前端脚本路由，也没有页面注入。
下面只剩数据面接口：

| 方法     | 路径                             | 说明                                                             |
| -------- | -------------------------------- | ---------------------------------------------------------------- |
| GET/POST | `/dsh-word-learn/lookup`         | 查词（`word`, `sentence`, `enrich`）                             |
| GET/POST | `/dsh-word-learn/translate`      | 整句翻译（`text`），永远回 200 + `ok`                            |
| POST     | `/dsh-word-learn/save`           | 拆词（`text`）                                                   |
| GET      | `/dsh-word-learn/list`           | 生词本（`limit`, `offset`, `tier`, `starred`, `order`）          |
| POST     | `/dsh-word-learn/update`         | 改画像/收藏/笔记                                                 |
| POST     | `/dsh-word-learn/remove`         | 移除                                                             |
| GET      | `/dsh-word-learn/dashboard`      | 学习页全部聚合数据（`days`）                                     |
| GET      | `/dsh-word-learn/queue`          | 今日到期队列（`limit`, `track`）                                 |
| POST     | `/dsh-word-learn/grade`          | 提交评分（`cardId`, `rating` 1-4）                               |
| GET      | `/dsh-word-learn/word`           | 单词详情 + 两条线状态（`word`）                                  |
| GET      | `/dsh-word-learn/models`         | AI 分析可用的文本模型（复用 DSH 模型目录）+ 当前选择             |
| POST     | `/dsh-word-learn/model`          | 选 AI 分析模型（`provider`,`model`；或 `reset:true` 回到第一个） |
| GET      | `/dsh-word-learn/model-info`     | AI 分析当前实际用的模型 + 来源（兼容旧接口）                     |
| POST     | `/dsh-word-learn/enrich-ai`      | 手动触发/补 AI 分析（`word`, `force`, `field`）                  |
| GET      | `/dsh-word-learn/quiz`           | 生成选择题（`word`）                                             |
| GET      | `/dsh-word-learn/repair`         | 补记卡材料（`cardId`）                                           |
| POST     | `/dsh-word-learn/repair/log`     | 记一条补记尝试（`cardId`, `stage`, `ok`, `guess`, `elapsedMs`）  |
| POST     | `/dsh-word-learn/repair/clear`   | 清补记债（`wordId` 或 `cardId`）                                 |
| GET      | `/dsh-word-learn/repair/stats`   | 补记统计（`days` 1–90，默认 14）                                 |
| GET/POST | `/dsh-word-learn/repair/recap`   | 次日回访：GET 取题（`limit` ≤10），POST 提交（`wordId` 等）      |
| GET      | `/dsh-word-learn/sense-map`      | 义项地图（`word`）                                               |
| GET      | `/dsh-word-learn/annotate/words` | 标注目标词表（`limit` 默认 2000，1–5000）                        |

## 开发

> **先读** `AGENTS.md`（改代码前的硬约束、「改 X 去哪里」定位表）和 `CONVENTIONS.md`
> （工程规范：目录边界、路由契约、数据访问、测试纪律）。
> **交付前跑 `pnpm verify`** —— 它是本插件唯一的验收命令（`lint` + `format:check` + 单测 + 回归脚本）。
> 具体任务的提示词模板在 `prompts/`：`fix-bug` / `add-route` / `edit-frontend` /
> `refactor-module` / `write-test`。

### 常用命令

```powershell
# 构建（阶段 1 起前端有构建步骤：src/client/** -> dist/client.js）
pnpm build         # tsdown：产出 dist/client.js + dist/client.js.map
pnpm dev           # tsdown --watch（改 src/client 自动重建，平台 500ms 内自动重载）

# 类型与静态检测（tsc 管类型，ESLint 管正确性与目录边界，Prettier 管排版）
pnpm typecheck     # tsc --noEmit（只覆盖 src/** 与配置文件；lib/** 的 JS 类型化在阶段 3）
pnpm lint          # eslint .
pnpm lint:fix
pnpm format        # prettier --write .
pnpm format:check
pnpm deps:check    # dependency-cruiser：环 + 分层方向 + 客户端不碰 node: 内建

# 单元测试（tests/，node:test；加载 dist/client.js 构建产物）
pnpm test:unit

# 单测 + 覆盖率门槛（http/text/models）
pnpm test:unit:coverage

# 组件测试（vitest + jsdom + 真实 React，渲染 dist 产物里的组件）
pnpm test:component

# 回归脚本（scripts/test-all.mjs 收编 scripts/test-*.mjs）
pnpm test:legacy

# 产物契约（单 factory / id / 无 node: / sourcemap / 体积预算）
pnpm artifact:check

# 全部
pnpm test          # test:unit + test:unit:coverage + test:component + test:legacy
pnpm verify        # build + check + test + artifact:check，交付前唯一验收
```

> **本地 link 安装后必须先 `pnpm build`**：DSH 从 `exports["./client"]`（现在是
> `dist/client.js`）读客户端产物，产物缺失时宿主会报 `run pnpm run build before launch`。

### 端到端与专项脚本（可单跑）

```powershell
# 语法检查
node --check lib\index.js

# 端到端跑全部路由（不需要重启宿主）
$env:DSH_HOME='D:\dsh-cache\tmp\wl-e2e'
node --no-warnings scripts\test-routes.mjs

# AI 分析模型：选择逻辑（models.mjs + analyzeWord）
node --no-warnings scripts\test-ai-model.mjs

# AI 分析模型：/models、/model 路由（假 llm，不花钱）
node --no-warnings scripts\test-model-routes.mjs

# 设置页「AI 分析模型」的渲染分支（vm 整文件加载 dashboard.js，从 __test__ 取组件）
node scripts\test-settings-ui.mjs
```

**改哪一半、要不要重启**：

| 改什么                              | 怎么生效                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/**`（前端全部源码）     | `pnpm dev`（tsdown --watch）重建 `dist/client.js` → 平台 client-hmr 轮询发现变化 → 自动重载模块；**不需要**刷新或重启（但面板会重挂，学习页退回首页，重点一次侧栏即可） |
| `lib/**/*.mjs`（宿主侧路由/数据面） | **重挂插件**即可，不必重启宿主（见下）                                                                                                                                  |

阶段 2 起**没有注入链**：划词卡、标注层、学习页都在同一个 bundle 里用 `import` 组装，
`apply()` 里 `ctx.effect(installWordcard)` / `ctx.effect(installAnnotate)` 装卸，
不存在「脚本晚到 / 依赖取不到」的竞态，也就没有了「正在加载」兜底和 `window.__dwl*` 全局。

**改生效范围之后怎么验**：`node --test tests/features/scope.test.mjs` 直接 import `src/client/features/core.js`（纯判定，
IIFE，提供最小 `window` 桩），从 `window.__dwlCore` 取**真实函数**求值（不是复制一份逻辑），覆盖
「对话正文该生效」与「左栏/右栏/对话面板根不该生效」两组。真机验证见下面「怎么确认划词范围生效」。

**改了 `lib/` 怎么不重启就生效**（2026-11-04 实测有效）：往 profile 的
`cordis.patch.yml` 末尾追加一行注释（内容随便，只要文件变了），HMR 会重排一次 profile，
把**这个链接包里改动过的模块**一起换掉；约 8 秒后 `apply()` 重跑、路由重新挂上。
判据：`POST /dsh-word-learn/<新路由>` 返回 **401**（栅栏）说明路由已挂上；
返回 **404/405** 说明还是旧代码。没生效就再追加一行注释等一次。

旧办法：用 `plugin_manager` 把本插件关掉再打开（`set_plugin` target 是 loader 条目 id
`include:dsh-word-learn`），关→开各一次。它能重跑 `apply()`，但换不换掉已缓存的模块
取决于重排时的文件比对，不如上面那条直给。

⚠️ **首次给插件加 `dsh.client` 段必须重启宿主**：`dsh-client-modules` 会把
"这个包不是 client 包"的否定结论缓存起来，HMR 不刷新该缓存。重启一次之后，
改 `dashboard.js` 就恢复 mtime 热重载。

**怎么确认学习页挂上了**（别按直觉拼 URL）：看 `__DSH_BOOT__.entries` 里有没有
`dsh-word-learn` —— 这是权威信号。有的话，用清单里的 `url` 字段去取脚本，
形态是 `/plugins/??dsh-word-learn/client.js&rev=<hash>`（`??` 是模块加载器的分隔符）。
`/plugins/dsh-word-learn/client.js` 这种拼法**一定 404**。

**怎么确认划词范围生效**：在 DSH 页面控制台跑下面这段，然后在左栏划一次、
再去对话正文划一次：

```js
document.addEventListener(
  'mouseup',
  () => {
    const r = window.getSelection().getRangeAt(0)
    const at = (n) => !!(n.nodeType === 1 ? n : n.parentElement)?.closest('[data-chat-flow]')
    console.log('两端在对话正文内：', at(r.startContainer), at(r.endContainer))
  },
  true,
)
```

左栏应打出 `false false`（卡片不弹），对话正文应打出 `true true`（卡片弹出）。

## 许可

本插件 MIT。词典数据来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT）。
例句来自 [dictionaryapi.dev](https://dictionaryapi.dev/)；发音用浏览器内置的
Web Speech API（`speechSynthesis`），不经过任何第三方服务。
