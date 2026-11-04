# P3：DSH 对话内联标注（v1 DOM 标注层）

> 目标：用户正在学的词，出现在 DSH 对话正文里时被「悄悄提醒」——原文一个字不改，
> 只加虚线下划线；悬停/聚焦出小卡：词、义项、一个「收进复习」按钮。
>
> 状态：v1 已落地。`assets/annotate.js`（纯 IIFE）+ `lib/annotate.mjs`（词表）+ 静态 fixture 自测 69/69 通过（无浏览器 22 项 + 浏览器 47 项）。
> 日期：2026-11-04。

---

## 0. 一句话结论

v1 走**普通 script 注入 + DOM 标注**，不接管 React 渲染、不进客户端包：
改 `assets/annotate.js` 刷新页面即生效（宿主按 mtime 读文件、no-store），不需要重启宿主。
代价是依赖 DSH 的 DOM 契约，所以契约、黑白名单、折叠/流式判定全部显式配置化，
DSH 改版时只需改 `CONFIG`，不用重写逻辑。

---

## 1. 目标与非目标

**做：**

1. 只处理 DSH **对话正文**（`.EvIC1a_column` / `.O_Ebla_content` 里的 `flowItem`）。
2. 命中词来自 `GET /dsh-word-learn/annotate/words`——只包含**有卡片、没毕业、没挂起**的词。
3. 命中后只加 `span.dwl-anno`（虚线下划线），原文文本节点内容零改动。
4. 悬停/聚焦出小卡：`w` + 义项（`s`，没有就 `t`）+「收进复习」。
5. 显式白名单/黑名单；localStorage 开关；性能限额；失败静默降级。

**不做（v1 明确排除）：**

- 不翻译、不替换原文、不改字号/行高（避免"沉浸式替换"那类整页排版风险）。
- 不处理非对话页面：侧栏、轨迹（trajectory）、学习页（dashboard）、文件预览、其它网站。
- 不处理流式中的文本；不处理代码块/行内代码/文件名/URL/其它插件弹窗。
- 不写库、不调模型（「收进复习」复用已有 `/lookup` 入库路径）。

---

## 2. 为什么是 DOM 标注，而不是 React slot

DESIGN.md「表面 C」里有两个挂法：

| 挂法 | 位置 | 代价 |
|---|---|---|
| A | `conversation.chat.node` 的 `assistant-step` 键，`priority: -1` | 自己接管整个助手渲染（markdown/图片/折叠），重、脆 |
| B | `conversation.chat.reasoning.body` single 槽位 | 轻，但只管思考正文 |

v1 选了**都不走**：宿主以普通 `<script>` 注入 `assets/annotate.js`。
理由：

- 这个功能是纯 DOM 的「加一层 span」，不需要 React 组件树；
- 进客户端包要重启宿主才能生效，迭代成本高；
- 坏掉的爆炸半径小：IIFE 里全部 try/catch，出问题只是"没有下划线"，划词卡片/学习页照常。

v2 若 DSH 提供稳定的「正文文本管道」（slot 里拿到 markdown 纯文本或 AST），再迁到 slot（见 §12）。

---

## 3. DOM 契约（2026-11-04 实测）

两个实例交叉验证：主 GUI（`100.115.120.50:3080`，源码级核对 `dsh-client-ui-chat` /
`dsh-client-ui-conversation` 的 client bundle）+ Lead 的第二实例（`127.0.0.1:3099`）。

### 3.1 范围与块

| 语义 | 选择器 | 备注 |
|---|---|---|
| 白名单根 | `[data-chat-flow]` | 同时是 `wordcard.js` 的 `SCOPE_SELECTOR`；可能嵌套（外层 `.EvIC1a_column` + 消息流 `.O_Ebla_content`），只取顶层去重 |
| 块（最小处理单位） | `[data-chat-node-key]`，兜底 `.EvIC1a_flowItem` | 一条消息 / 一个步骤 |
| 块类型 | `[data-chat-flow-kind]` | 实测值：`user` / `assistant-step` / `tool-call` / `context` / `compaction` / `turn-process` / `turn-tail` |
| 分组 | `[data-chat-group-part]` | `reasoning`（思考） / `response`（回答） |
| 正文容器 | `[data-slot="conversation.chat.node"]` | slot 语义标识，跨版本比哈希类名稳 |
| 思考正文 slot | `[data-slot="conversation.chat.reasoning.body"]` | 展开后才渲染 |
| 对话区滚动容器 | `[data-conversation-scroll]` | 可选，未使用（IO 用 viewport + 裁剪祖先） |

**只标 `user` 与 `assistant-step`**（`ALLOWED_KINDS`）；
`tool-call`/`context`/`compaction`/`turn-process`/`turn-tail` 整类排除——它们是命令、路径、JSON、
耗时行，不是阅读材料。

### 3.2 折叠（三种形态都要兼容）

1. **DSH process 组（3080 实测）**：未展开的组成员被 `hidden="until-found"` 包着
   （`O_Ebla_root` / `O_Ebla_body` 上），DOM 里存在但不可见；展开后 `hidden` 被移除。
   → 规则：`[hidden]` 子树一律跳过。
2. **aria 折叠（Lead 在 3099 实测）**：`button[aria-expanded="false"]` + 兄弟面板。
   → 规则：`[aria-expanded="false"]` 子树跳过；点击后立即重标该块。
3. **思考块（`data-variant="think"`）**：未展开时正文**不在 DOM**，只有标题「思考」+ 一句预览；
   展开后才有 `data-expanded` 和正文。
   → 规则：`[data-variant="think"]:not([data-expanded])` 跳过；展开后只标正文，标题区不标。
4. **原生 `<details>/<summary>`**：DSH 当前不用，但作为通用兜底——
   未展开只标 `summary`，展开后标全部（选择器 `details:not([open]) > :not(summary)`）。

「未展开只处理标题」在 DSH 里的实际效果：思考标题是中文「思考」、process 组标题是
「已完成，用时 1 分 0 秒」这类 UI 文案，本来就没有英文可标，所以等价于「未展开零标注」。

### 3.3 流式（三重判定，不靠猜）

| 判据 | 来源 | 用法 |
|---|---|---|
| `[data-streaming]` | DSH 源码：`AssistantMarkdown` / 思考摘要流式时挂 | 子树跳过；没有这个属性的版本自动退化到后两条 |
| 文本 800ms 无变化 | 本层 MutationObserver 重排 | 每块指纹（文本 + 折叠状态）不变满 800ms 才标 |
| 活动回合尾块 | `[data-chat-running]` / `[aria-busy="true"]` | 页面在跑时，DOM 顺序上最后一个可标块一律跳过 |

为什么最后一条必要：实测某些回合没有稳定的 streaming 属性（Lead 3099 上
`[data-streaming]`/`[aria-busy]` 都是 0），而「运行指示器 + 最后一块」是
"正在增长的那条消息"的可靠近似。回合结束（指示器消失）后，mutation 会重新触发扫描。

> 与最初的需求差异：需求写的是"离流式尾部 120 字符"（dsh-think-translate 的替换式方案）。
> 本层是**增量加 span**，不需要对齐字符偏移，用「块级 + 稳定窗口」更稳。

### 3.4 代码与"非自然语言"

| 类型 | DOM | 处理 |
|---|---|---|
| 围栏代码块 | `div.md-code-block > pre > code`，banner 带 `[data-code-block-banner]` | 黑名单整块跳过 |
| 工具/文件预览代码 | `[data-code-wrap]` | 跳过 |
| 行内代码 | `<code>` | 跳过 |
| 链接 | `<a>` | 跳过（URL 不该被拆成词） |
| 文件引用芯片 | `[data-ref-chip]` | 跳过 |
| 纯文本里的路径/URL/标识符 | 无特殊 DOM | token 邻接字符判断（§4.4） |
| 表格 | `table` / `.md-table-wide` | v1 跳过（悬停卡在密集表格里挡视线），可配置放开 |
| 其它插件弹窗/内联卡 | `[role=dialog]`、`[data-approval-key]`、`[data-question-key]`、`[data-plan-review-key]` | 跳过 |
| 输入区 / 任务面板 | `[data-composer-seat]`、`[data-composer-card]`、`[data-testid=todo-panel]` | 跳过 |

注意：对话页 `details`/`summary`/`pre` 在**当前会话**可能为 0——"存在即会渲染"，
不能因为某次快照没有就假设永远没有。黑名单按语义写，不按"这次测到了什么"写。

### 3.5 脆弱点（改版时先看这里）

- 哈希类名（`.EvIC1a_*`、`.O_Ebla_*`、`.hWmORq_*`、`.lcKema_*`）会随 CSS module 构建变化：
  **逻辑只依赖 `data-*`/slot/role 属性**，类名只出现在 `BLOCK_SELECTOR` 兜底里。
- `data-chat-flow-kind` 若消失：`kindOf()` 兜底把 `.EvIC1a_flowItem` 当 `assistant-step`，
  其余未知节点一律不标（宁可少标）。
- 白名单根消失（比如未来对话换容器）：本层静默不工作，不影响宿主。

---

## 4. 分层架构

```
① 范围发现   collectRoots()          只认 [data-chat-flow]（顶层去重）
② 块分类     kindOf()/isAllowedKind  只放行 user / assistant-step
③ 判定闸门   hidden / streaming / aria-expanded / active-tail / 折叠指纹
④ tokenize   tokenize()              手写字符扫描（无正则字面量，避开转义坑）
⑤ 匹配       matchText()             词表 Set + 词形候选 + 邻接字符过滤
⑥ 渲染       annotateBlock()         文本节点拆成 [原文, span, 原文, …]，限 60/块
⑦ 悬停卡     showCard()/onCapture()  单例 fixed 卡片，事件委托
```

状态机（每块）：

```
观察到 → 稳定性(800ms) → 标注 → doneHash[block]=指纹
                                  │
              mutation / 折叠切换 / 词表 rev 变化
                                  ↓
                        指纹变了 → 删除 doneHash → 重新走流程
```

- 幂等：标注产物是 `span.dwl-anno`，重扫时跳过 span 内文本节点，不会套娃。
- 回滚：`clear()` / 关闭开关 / 词表变空 → 把所有 span 换回文本节点并 `normalize()`。

---

## 5. 白名单 / 黑名单（配置化）

全部集中在 `assets/annotate.js` 顶部 `CONFIG`，两项都是**数据**，改配置不改逻辑。

### 5.1 白名单

| 配置 | 值 | 说明 |
|---|---|---|
| `ROOT_SELECTOR` | `[data-chat-flow]` | 对话流锚点 |
| `BLOCK_SELECTOR` | `[data-chat-node-key], .EvIC1a_flowItem` | 块 |
| `CONTENT_SLOT` | `[data-slot="conversation.chat.node"]` | 正文 |
| `ALLOWED_KINDS` | `['user', 'assistant-step']` | 只标自然语言消息 |
| `REASONING_EXPANDED` | `[data-variant="think"][data-expanded]` | 思考正文（仅展开） |
| 词表 | `/annotate/words` | 只标"在学"的词 |
| `WORDS_PATHS` | `/dsh-word-learn/annotate/words` → `/annotate/words` | 路由兼容，两个都 404 就静默退避 |

### 5.2 黑名单（容器级，命中整棵子树跳过）

```
pre, code, .md-code-block, [data-code-wrap], [data-code-block-banner]
a, [data-ref-chip]
button, [role="button"]
table, .md-table-wide
[hidden], [data-streaming], [data-chat-running], [aria-expanded="false"]
[data-disclosure-header], [data-variant="think"]:not([data-expanded])
details:not([open]) > :not(summary)
[data-composer-seat], [data-composer-card], [data-testid="todo-panel"]
[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"]
[data-approval-key], [data-question-key], [data-plan-review-key]
.dwl-anno, .dwlac          （自己的产物，重扫时别钻进去）
```

### 5.3 token 级排除（纯文本里的"像代码"的东西）

手写字符扫描（不用正则字面量），规则：

- 全大写且长度 ≥ 2（`API`/`HTTP`）、驼峰（`getElementById`）→ 跳过；
- 两侧邻接 `/ \ _ @ # $ % & = + < > ~ ^ :` 或数字 → 跳过（路径、URL、标识符、版本号）；
- 连字符邻接 → 跳过（`dsh-word-learn` 不会拆出 word/learn；代价是 `well-known` 也不标，保守方向正确）；
- 句点邻接：`.` 后跟字母/数字（`index.js`）或前跟字母/数字（`obj.method`）→ 跳过；
  `.` 后跟空白/行尾是正常句号，不跳过。

---

## 6. 渲染与交互

- **原文零改动**：`span.textContent = 原始 token`；只是外面套一层。大小写、标点、所有格全部保留。
- 样子：`border-bottom: 1px dashed var(--dsw-alias-brand-primary)`；
  hover/focus 背景用 `--dsw-alias-interactive-bg-hover-accent`；没有写死颜色，全走宿主主题令牌。
- 小卡：单例 `div.dwlac`（`role="dialog"`，`position:fixed`，视口边缘自动翻转/夹紧）。
  内容：词（衬线）+ 徽标（`最近义项` / `首义` / `在学`）+ 义项 + 「收进复习」。
- 触发：`mouseover` 90ms 延迟避免扫过就弹；移出 200ms 后关；`focusin` 直接开；
  `Enter`/`Space` 打开并聚焦按钮；`Esc` 关；滚动/缩放时跟随重定位。
- 性能：`mouseover/mouseout/focusin/focusout/keydown/toggle/click` 全部委托到 `document`，
  不给每个 span 挂监听。
- 无障碍：span 可 Tab 聚焦（`tabindex=0`）+ `:focus-visible` 描边；卡片按钮原生 `<button>`。
- 词形：`charged/charges/charging/model's` 等通过候选表匹配到原形，span 标的是**原文形态**，
  卡片显示原形（词表里的 `w`）。

---

## 7. 数据接口

### 7.1 GET 词表（Lead 挂路由，本层只消费）

```
GET /dsh-word-learn/annotate/words            （fallback: /annotate/words）
200 { "words": [{ "w": "charge", "t": "v. 收费；充电", "s": "n. 指控", "c": 12 }], "rev": "…" }
```

| 字段 | 含义 | 来源 |
|---|---|---|
| `w` | 小写原形 | `words.word` |
| `t` | 首义（第一行） | `words.translation` 按换行截断 |
| `s` | 最近义项 | `sense_meta` 最新一条的 `sense_here`，没有 `''` |
| `c` | 卡片 id | 未挂起卡片中 `MIN(id)`（receptive 优先）；无卡片不返回该词 |
| `rev` | 词表版本 | 词数/卡片状态/义项时间戳的组合；变了前端清掉重标 |

服务端实现：`lib/annotate.mjs` 的 `annotateWordList(store, { limit = 2000, minSeen = 0 })`，
只读用户库、不写、不调模型；打不开库返回 `{ words: [], rev: '', error }`。

为什么只返回"在学"的词：全库生词都标会把每段英文变成虚线地毯，标注的价值是
「正在学的词在真实语境里复现」，不是「高亮所有不认识的词」。

### 7.2 收进复习

```
POST /dsh-word-learn/lookup
{ "word": "charge", "sentence": "The charge was dropped.", "save": true, "enrich": false }
```

复用现有入库路径：`store.touch()` 记一次遇见 + 把这句话写进 `contexts`（同句去重）、
刷新 `seen_at`。`enrich:false` 跳过外部词典增强（按钮语义是"收集语境"，不是重新查词）。

> v2 可选：加一条更轻的 `POST /dsh-word-learn/annotate/capture`（只写 context + 一次
> `review_log(kind='recognize')`，不触发 AI 队列）。前端改 `CONFIG.CAPTURE_PATH` 一行即可。

### 7.3 失败降级

| 失败 | 表现 |
|---|---|
| 词表 404 / 超时 / 坏 JSON | 静默，指数退避重试（20s→5min 上限），不刷 console |
| 词表为空 | 清掉旧标注、断开 Observer，60s 后再看一次；不做任何 DOM 操作 |
| 单个块抛异常 | 只跳过该块，不影响其它块 |
| 「收进复习」失败 | 按钮变「重试」+ 一句"网络不通"，不弹窗、不写 console |
| localStorage 被禁用 | 默认开启；开关不生效但不影响功能 |

---

## 8. 开关与可回滚

| 项 | 值 |
|---|---|
| localStorage | `dwl-annotate`：`'off'` 关闭；缺省/其它 = 开（默认开） |
| 运行期 API | `window.__dwlAnnotate.{version, enable(), disable(), refresh(), clear(), stats()}` |
| 事件 | `window.dispatchEvent(new CustomEvent('dwl-annotate:toggle', { detail: { enabled } }))` |
| 跨标签页 | 监听 `storage` 事件同步开关 |
| 回滚 | 关闭开关 = 立刻清 span + 断开 Observer；卸掉注入 = 功能消失，宿主不受影响 |

`stats()` 返回 `{ enabled, running, words, rev, blocks, spans }`，排查用。

---

## 9. 性能预算

| 项 | 值 | 理由 |
|---|---|---|
| 单块 span 上限 | 60 | 一段长文里 60 个已足够；防"虚线地毯" |
| 整页 span 上限 | 800 | 超出后不再标（回滚/重建会重置） |
| 单块文本上限 | 12000 字符 | 超长块（日志/表格）直接跳过 |
| 单块文本节点上限 | 600 | 防病态 DOM |
| 稳定性窗口 | 800ms | 流式兜底；用户主动展开走 30ms 快速通道 |
| mutation 防抖 | 250ms | 流式期间不每帧扫描 |
| 可见性 | IntersectionObserver（rootMargin 400px）+ 后台页 rect 兜底 | 只处理视口附近块 |
| 词表请求 | 5 分钟 TTL + `rev` 比对；请求超时 4s | 不重复拉、不阻塞 |
| 网络 | 只在启动/可见性恢复/手动 `refresh()` 时请求 | 不吃带宽 |

复杂度：一次 scan 是 `O(块数)` 的属性读取；标注是 `O(文本节点数 × token 数)`，且只发生在
"通过 IO + 稳定性 + 限额"的块上。

---

## 10. 测试与断言（fixture）

```bash
# 纯函数 + 词表契约（无浏览器）
node scripts/test-annotate.mjs

# 端到端：自己起静态服务 + 自己开 bsk 会话，跑完自己关
BSK_BROWSER=<browser-instance-id> node scripts/test-annotate.mjs --browser
```

fixture：`scripts/test-annotate-fixture/index.html` 复刻 DSH 对话 DOM
（`[data-chat-flow]` / `flowItem` / `[data-slot=conversation.chat.node]`），
并模拟：正常段落、行内 code、`pre>code`、`.md-code-block`、链接、路径/URL 文本、
`<details>`、`[data-streaming]`、`[hidden]`、折叠/展开的思考块、`[role=dialog]`、
`tool-call` 块、对话外文本、100 次重复词的限额块。

**最近一次结果（2026-11-05，`BSK_BROWSER=bda3db85`）：69/69 通过**（无浏览器 22 + 浏览器 47）。

关键断言：

| 断言 | 期望 | 结果 |
|---|---|---|
| 正常段落 3 个词 | 3 span | ✅ |
| 行内 code / pre / md-code-block 内 | 0 span | ✅ |
| 链接 / 路径文本 / URL 文本 | 0 span | ✅ |
| `<details>` 未展开：summary=1、body=0 | 只标标题 | ✅ |
| 展开后：body=3、summary 不重复 | 补标且不重复 | ✅ |
| `[data-streaming]` 子树 | 0 span | ✅ |
| `[hidden]` 子树 | 0 span | ✅ |
| 折叠思考块 | 0 span；展开后正文 2 span | ✅ |
| `[role=dialog]` 内联弹窗 | 0 span | ✅ |
| `tool-call` 块 | 0 span | ✅ |
| 对话外文本 | 0 span | ✅ |
| 100 次重复词 | 恰好 60 span（单块上限） | ✅ |
| 关掉开关 | 0 span + `localStorage=off` + running=false | ✅ |
| 重新打开 | 恢复标注（69 span） | ✅ |
| 词表变空 | 旧标注被清掉、0 span、words=0 | ✅ |

另：`node --check assets/annotate.js`、`node --check lib/annotate.mjs` 通过。

---

## 11. 已知风险

1. **DSH 改版**：哈希类名变了不致命（只用作兜底）；`data-*`/slot 变了需要改 `CONFIG`，
   最坏情况是"白名单根没了 → 静默不工作"，不会破坏页面。
2. **React 重渲染**：DSH 重渲染某个 markdown 块会把我们的 span 冲掉——mutation 触发重扫、
   指纹比对后补标。不会出现"标了两次"（span 内文本被跳过、块级幂等）。
3. **流式漏标**：极端情况下（无 `data-streaming` 且回合未结束）最后一块会晚标到回合结束，
   这是刻意的：**宁可少标，不能标正在增长的内容**。
4. **义项不是"这句里的"**：sense_meta 没有句子级索引，v1 只能给"最近义项"并在 UI 上标明；
   真·句子级义项留 v2（给 `sense_meta` 补 sentence 列或建 `sense_context` 映射）。
5. **误标**：token 过滤偏保守；若用户词表里有 `api`/`get` 这类短词，在 `API`/`getElementById`
   语境里仍可能漏标（我们已经跳过全大写/驼峰，所以是"漏"而不是"错"）。
6. **后台标签页**：IO 不触发，用 rect 兜底；页面隐藏时仍会标注（不可见，无性能问题）。
7. **不处理中文**：只匹配英文 token；中英混排里的英文词照常标。

---

## 12. 演进路线

**v1（当前）** DOM 标注：普通 script、span + 悬停卡、词表接口、黑白名单配置化。

**v1.1（低成本增强）**

- `/annotate/capture` 轻量入库路由（去掉 AI 队列副作用）。
- 设置项：`dwl-annotate` 支持 `'off' | 'plain' | 'all'`（当前只有开/关）。
- 词形还原升级：不规则动词表（go/went、take/took）+ 名词复数（-ies/-ves）。
- 标注密度策略：同一段只标最近未复习的前 N 个词（避免"地毯"）。

**v2（若 DSH 提供稳定文本管道）**

- 迁到 `conversation.chat.node` 的 slot：拿到 markdown 文本/AST 再标，避免 DOM 结构依赖；
  但优先级低于"确保不接管渲染"的底线。
- 句子级义项：`sense_meta` 增加 `sentence_hash`，标注时按当前句匹配 `sense_here`；
  小卡展示"这句里的义项"而不是"最近义项"。
- 与补记循环联动：标注点开 → 直接发起一次 R3 同会话复现（而不是只入库）。
- 度量：标注曝光数 / hover 率 / 收进复习率 / 标注词的复习保持率，用于 A/B 决定是否保留。

---

## 13. 变更记录

- 2026-11-04 v1：`assets/annotate.js` + `lib/annotate.mjs` + fixture/测试；49/49 通过。
  修复（Lead 实测反馈）：展开折叠框后补标延迟（加 `toggle`/`click` 快速通道 +
  attributes MutationObserver）；词表变空时旧标注未清除（adoptWords/loadWords 双处 clear + detach）。

- 2026-11-05 v2（静态审查 A 批修复；69/69，无浏览器 22 + 浏览器 47）：
  - **停摆**：`spanCount` 改实时计数（`querySelectorAll('.dwl-anno').length`），React 冲掉 span 后限额自动恢复；
    指纹加入"本块 span 数"，span 被重渲染抹掉但文本没变也能补标；doneHash 改为在**标注后**取指纹
    （旧代码存标注前的指纹，配合 `STABLE_MS=0` 会变成紧循环把页面卡死）。
  - **开销**：MutationObserver 回调只把 target/addedNodes 标脏，`scan` 只处理脏块，`.dwl-anno/.dwlac`
    内的变化直接忽略；`hasRunningIndicator`/`findTailBlock` 每轮只算一次下传；黑名单按块缓存（每块只 `matches` 一次）；
    稳定窗定时器每块单例、`stop()` 统一清理。
  - **React 兼容**：`unwrapSpan` 去掉 `parent.normalize()`（会把 React 持有的相邻文本节点合并成孤儿）。
  - **悬停卡**：`fetch` 加 6s 超时；定位改 rAF 合并 + 缓存卡片尺寸 + `transform`，消除滚动时的强制同步布局。
  - **真实 DOM 契约（重要）**：DSH 的思考/过程折叠行是
    `div[role="button"][data-disclosure-row][aria-expanded="false"]`，**不能把 `[role="button"]` 拉黑**
    （否则折叠标题全被误杀）；`contentRoots()` 对 `part=reasoning` 在旧 DOM 上回退到 `[data-slot=conversation.chat.node]`。
  - **IO 观察桶**：页面可见时被 `IO.observe` 的块，标签页转 hidden 后 IO 不再回调，`observed` 里的块会永久
    "等回调"被 scan 跳过（`disable/enable/refresh` 都救不回来）。现在不可见时 `io.disconnect()` + 清空 `observed`，
    改用 rect 兜底，`visibilitychange` 转 hidden 时也清。
  - 词法：`résumé`/`café` 不再被切成 `sum`/`caf` 误标；`don’t` 与 `don't` 归一化后互认。
  - fixture 补入真实形态的 process 块（`hidden="until-found"` + `role=button` 标题行 + 展开正文），
    断言链覆盖「组折叠→0 / 摘 hidden→标题 3 / 展开→正文补 3 且标题不重复」。
