# dsh-word-learn 设计方案

> 面向用户（深度 AI 开发，工作里大量英文思维链）的英语学习插件。
> 底座抄 `syzke/dsh-translate-on-select`（划词卡片），正文标注思路参考 `UncleK/dsh-think-translate`。
> 设计日期 2026-10-29。**本文档只描述设计，不含实现。**

---

## 0. 这份方案改了什么

两轮调研（工作区 `spaced-repetition-research.md`、`pronunciation-alternatives-research.md`）
推翻了初版的三处设计，先认领：

| 初版我说 | 调研结论 | 改成 |
|---|---|---|
| 五维熟练度**各自独立排期** | 复习量 ×5，直接撞 backlog；Anki 原生做法是"一词 N 卡各自排期"，代价正是这个 | **两条排期线（receptive / productive），不是五条**；五维降为"能力画像" |
| 发音用"词典音频 + 浏览器 TTS 兜底"，对比用浏览器 | **Web Speech API 做不了音素级**：`SpeechRecognitionAlternative` 只有 `transcript` 和 `confidence`，无音素输出；且会把"读成另一个真实单词"判为正确——这恰是发音错误的主要形态 | 音素级对比**必须服务端**（OpenPronounce）；浏览器只能做二值门 |
| 口型图"可以拷贝下来用" | **CMU39 那批图出自 papagayo-ng，该仓库无 LICENSE，只有 `gpl.txt`（GPLv2）**；且 OpenPronounce 把它们拷进自己的 MIT 仓库时**没留任何 NOTICE** | **不能用**。改用 **CC0 剖面图（43 个）+ Rhubarb MIT 口型图（9 个）** |

**第二轮还推翻了一个更根本的前提**：我以为要"找一个更准的发音评测方案"，但调研发现
**OpenPronounce 精确率低不是模型差，是评分者口径与用户需求相反**——它把中国人典型口音特征判为"不算错"。
**所以真正的解法是换掉判定规则，不是换模型。** 详见 §5.1。

同时确认了一条初版判断是对的：**FSRS 是对的选择**，但要**钉住 FSRS-6**，不要追 FSRS-7。

---

## 1. 定位

**不是背单词 App，是「领域英语的半熟词补齐器」。**

用户原话：「我用其它的 app，我感觉全是生词，但又好像没那么生词。」

真正缺口不是词汇量，是**一个词只有一个义项**（`resolution` 只知"分辨率"、`latent` 只知"潜空间"），
以及**发音**（词从屏幕上捡的，从没听人念过）。

- 入口：划词即学，零摩擦
- 出口：**熟练度分级**，不是生词本（入口不筛选，出口才筛选）
- 复习：长在必经之路上，不靠自觉

---

## 2. 数据模型

### 2.1 一个词一行，五维是画像

```sql
-- words：词条主表
CREATE TABLE words (
  id            INTEGER PRIMARY KEY,
  word          TEXT NOT NULL UNIQUE,   -- 原形，小写
  lemma         TEXT,                   -- 词元（ECDICT exchange 的 0 字段）
  phonetic      TEXT,                   -- 音标
  translation   TEXT,                   -- 中文释义（多义项，换行分隔）
  definition    TEXT,                   -- 英文释义
  pos           TEXT,                   -- 词性，'/' 分隔
  collins       INTEGER,                -- 柯林斯星级
  oxford        INTEGER,                -- 是否牛津3000
  tag           TEXT,                   -- cet4/cet6/ielts/gre/zk/gk...
  bnc           INTEGER,                -- 英国国家语料库词频
  frq           INTEGER,                -- 当代语料库词频
  exchange      TEXT,                   -- 变形：d:perceived/p:perceived/3:perceives/i:perceiving
  audio         TEXT,                   -- 真人发音 mp3 url
  created_at    INTEGER,
  -- ↓ 五维能力画像（0-5，只影响"出什么题"和"是否毕业"，不单独排期）
  k_recognize   INTEGER DEFAULT 0,      -- 认得
  k_meaning     INTEGER DEFAULT 0,      -- 意思
  k_write       INTEGER DEFAULT 0,      -- 能写
  k_listen      INTEGER DEFAULT 0,      -- 能听
  k_pronounce   INTEGER DEFAULT 0,      -- 能读准
  -- ↓ 已知义项集合：解决"只懂单一场景"
  known_senses  TEXT DEFAULT '[]',      -- JSON 数组
  graduated     INTEGER DEFAULT 0       -- 1 = 五维全满，永久不再出现
);

-- cards：排期线。一个词最多两条（receptive / productive）
CREATE TABLE cards (
  id          INTEGER PRIMARY KEY,
  word_id     INTEGER NOT NULL REFERENCES words(id),
  track       TEXT NOT NULL,            -- 'receptive' | 'productive'
  -- ts-fsrs 状态
  due         INTEGER,
  stability   REAL,
  difficulty  REAL,
  elapsed_days INTEGER,
  scheduled_days INTEGER,
  reps        INTEGER DEFAULT 0,
  lapses      INTEGER DEFAULT 0,
  state       INTEGER,                  -- ts-fsrs State
  last_review INTEGER,
  leech_count INTEGER DEFAULT 0,
  UNIQUE(word_id, track)
);

-- contexts：每次遇见它的原句与出处（用户的语境资产）
CREATE TABLE contexts (
  id         INTEGER PRIMARY KEY,
  word_id    INTEGER NOT NULL REFERENCES words(id),
  sentence   TEXT NOT NULL,             -- 遇见它的原句
  session_id TEXT,                      -- 来自哪个会话
  created_at INTEGER
);

-- review_log：每次交互（也是 LLM 调参的数据来源）
CREATE TABLE review_log (
  id         INTEGER PRIMARY KEY,
  card_id    INTEGER NOT NULL REFERENCES cards(id),
  rating     INTEGER NOT NULL,          -- ts-fsrs Rating: 1=Again 2=Hard 3=Good 4=Easy
  kind       TEXT NOT NULL,             -- 题型：recognize|meaning|write|listen|pronounce
  elapsed_ms INTEGER,                   -- 反应时间（"看一眼就走"的弱信号）
  evidence   TEXT,                      -- 'view'|'hover'|'expand'|'answer' 证据等级
  created_at INTEGER
);
```

### 2.2 为什么是两条线，不是五条

调研里那篇 2026 论文（Zhai, *Language Teaching Research*, DOI 10.1177/13621688261449449，152 名学习者）的结论：

- **即时后测：contracting 间距对 receptive 和 productive 都占优**
- **延迟后测：productive 知识上 expanded 间距占优**
- 论文自己建议给软件设计用 **hybrid optimal spacing system**

所以：

```
阶段一 receptive（认得 + 意思）
  间距形状：contracting（密集、短间隔）
  desired retention：高（0.90-0.92）
  ↓ 认得与意思都到 4 分，且稳定
阶段二 productive（能写 + 能听 + 能读准）
  间距形状：expanded（长间隔）
  desired retention：低（0.85-0.88）
```

**两条线 = 最多 2 倍复习量，而不是 5 倍。** 五维分数只决定：出什么题、是否升到 productive 阶段、是否毕业。

#### 实现口径（2026-11-04 修：同一个词连着出现两次）

- `ensureCards` 一次建两条卡，但 productive 卡只是**结构**：要等 receptive 稳
  （`state>=2` 且 `reps>=2`，见 `schedule.productiveReady`）才进 `dueQueue`。
  解锁时把 productive 的 `due` 挪到明天，避免一上线就显示"拖了 N 天"。
  恰好在"阶段二"这道闸上：一直评"忘了/勉强"的词会停在 learning，productive 就不上线。
- `dueQueue` **一个词一轮只出现一次**：两条线都到期时先取 `due` 更早的那张
  （同 `due` 先 receptive），另一张留到下一轮。看板口径（今日/明日/预测）同步
  `COUNT(DISTINCT word_id)`，否则数字会是队列的两倍。
- 早期实现漏了这两条：两张卡同时 `due = 建卡时间`，队列里同一个词紧挨着出现，
  等于 massed practice。这也是"连续重复"的直接原因。

#### 阶段二的题目：看中文拼英文（2026-11-04）

阶段一和阶段二练的不是同一件事，题面也不能一样：

| 线 | 题面 | 判定 |
|---|---|---|
| receptive | 给英文，选释义（多选，AI 干扰项 + 同频词释义兜底） | 正确率 → Easy/Good |
| productive | 给中文释义，**把单词拼出来**（隐藏单词与音标） | 全对 → Easy；1-2 字母笔误 → Good；写错 → Again |

拼写的宽松度按"首字母必须一致 + 长词（≥8 字母）容忍 2 个字符、其余 1 个"：
`daemn → daemon` 算差一点，`latent → patent` 必须算错——否则"拼成另一个真词"会被判对。
从"模糊"分支进来时，判定整体降一档（写对 → Good，写错 → Hard），因为用户本来就没把握。

实现：`assets/dashboard.js` 的 `spellCheck` / `WritePanel`；测试
`scripts/test-write-panel.mjs` 直接从源码切出这两个函数渲染断言。

### 2.3 毕业机制（解决噪音）

- 五维全满 → `graduated = 1`，**永久不再出现**
- `the` / `to` / `of` 这类：第一次复习就答对，直接毕业
- **入口不筛选，出口才筛选**——这是对用户"所有词都进"要求的正确实现

---

## 3. 三个学习表面

### 表面 A：划词卡片（抄 dsh-translate-on-select）

```
划中一段话 → 译文卡片（原样抄）→ 卡片上多一行 [📖 拆词学习]
划中的是单个词 → 跳过翻译，直接进学习卡
```

**沿用参考仓库的全部实现**：`makeFence` 信任栅栏、注入行写法、mtime 热重载、毛玻璃卡片、
骨架屏、明暗主题、Esc/点空白关闭、滚动即收起、`prefers-reduced-motion`。

**学习卡内容（分层）**：

| 层 | 内容 | 来源 | 无 LLM 时 |
|---|---|---|---|
| 骨架 | 音标、词性、多义项、变形（时态/复数/比较级）、词频星级 | ECDICT 本地 SQLite | ✅ |
| 发音 | 服务器缓存的有道词音（美音/英音各一份，落盘复用）；不可用时退回浏览器本地合成 | 有道 dictvoice → 本地缓存 | ✅ |
| 例句 | 英文例句 | dictionaryapi.dev | ✅ |
| **场景增强** | "你在这句里理解成 X，这里其实是 Y" | LLM | ❌ 降级 |
| 记忆钩子 | 词根拆解 / 联想 / 你的原句回放 | LLM | ❌ 降级 |

**LLM 没配就自动降级成纯词典**——功能不残，只是少了增强层。

> **发音：服务器端 mp3 缓存（2026-11-04）**
>
> 演进：① 客户端直连微软 Edge-TTS（`dev.microsofttranslator.com` 取 token +
> `*.tts.speech.microsoft.com` 合成，带 HMAC 签名和 IndexedDB 缓存）——
> 2026-11 端点全断（token 405、`translate/auth` 404、readaloud WebSocket 401/403），
> 点图标只会静默失败；② 改用浏览器 `speechSynthesis` —— 能用，但每次都是现合成，
> 切口音要重念，音色随系统走；③ 现在是**服务器缓存**：`lib/tts.mjs` 用有道
> `dictvoice`（`type=1` 美音 / `type=2` 英音）拉一次 mp3 落盘，之后直接读文件。
>
> - 布局：`$DSH_HOME/dsh-word-learn/cache/tts/{us,uk}/<word>.mp3`（有道偶尔返回
>   WAV，按文件头存成 `.wav`，路由按真实格式给 `Content-Type`）。
> - 路由：`GET /tts?word=&accent=us|uk` 命中缓存直接吐文件（`Cache-Control: immutable`）；
>   `POST /tts-prepare` 批量准备，立即返回"命中/缺失"统计，补齐放后台（并发 2、间隔 120ms、
>   连续失败 12 次就停）。
> - 前端：学习页拉完队列就调 `/tts-prepare`（这一轮所有词 × 两个口音），并预取当前
>   和下两个词的音频；播放先走缓存 mp3，失败/超时才退回 `speechSynthesis`。
> - 安全：词必须匹配 `^[a-z][a-z'’-]{0,39}$`，文件名去掉非字母数字，杜绝路径穿越。
>
> **2026-11-05 变更：服务端发音整体下线。** 用户明确要求：单词都是前端用户操作触发、在前端反复使用，不需要任何外部发音 API，只用浏览器自带的免费语音（Windows/Edge 上即 Microsoft 音色），因此删掉 `lib/tts.mjs`（有道 dictvoice + 磁盘 mp3 缓存）、`GET /tts`、`POST /tts-prepare` 与学习页的预取链路，改为 `assets/voice.js`（speechSynthesis，零网络、离线可用）。`speechSynthesis` 的输出无法被浏览器录制，所以"缓存"的落点是音色选择与朗读参数（localStorage），换来的好处是零请求、无音源失效、无缓存文件损坏问题。下文 2026-11-04 的服务器缓存方案作为历史记录保留。
>
> **自动发音（2026-11-04）**：学习页里"单词出现 / 看答案 / 拼完单词"三个时机自动读一遍，
> 喇叭图标保留为手动重听。开关在 设置 → 发音偏好 → 自动发音（localStorage `dwl-auto-speak`，
> 默认开）。两条约束：① 写得出那条线在出题阶段不读（单词就是答案，读了等于泄题），
> 拼写结果出来后才读；② 自动播放失败静默忽略——浏览器拦自动播放不该变成弹窗打扰。
> 从设置页切回学习页时会重读口音和开关，避免"改了没生效"。
>
> **易混淆词的悬浮释义（2026-11-04）**：学习页"易混淆"和 AI 分析弹窗里的近义词/易混淆词
> 只给英文词本身，用户看不懂——改成 `HoverWord` 小标签（虚线），停留 280ms / 聚焦 / 点击
> 浮出释义卡（音标 + 前 3 条释义 + 加入生词本），和划词卡片同一套视觉。
> 关键取舍：**预览用 `save:false` 只看不记**，点「加入生词本」才写库，
> 否则鼠标扫过一排易混淆词就全进生词本；预览也不排 AI 分析队列，免得白烧模型额度。
> 卡片用 `position:fixed` 按 anchor 的 rect 定位并在视口内夹取，避免被弹窗的
> `overflow-y:auto` 裁掉；拿不到 rect（测试环境）时兜底左上角。
> 路由参数陷阱：GET 的 `save=false` 是字符串，判断必须认 `'false'`（踩过一次，
> `!== false` 把预览当成了写入）。

#### 表面 A 实现补充：划句子必须给译文（2026-10-30）

**踩到的问题**：P1 只实现了"拆词"，`runSplit` 调 `/save` 拿候选词就结束了，
**整句的译文从来没算过**。用户划一句话的动机是"这句没读懂"，
只给他一堆单词等于让他自己拼句意 —— 这是把功能做成了另一个功能。

**修法**：`lib/translate.mjs` 新增双后端翻译，前端译文块排在候选词**上面**。

| 后端 | 何时用 | 依据 |
|---|---|---|
| `ctx.llm`（DSH 自己的模型） | 优先 | 质量最好；实测技术语境更准 |
| MyMemory 公共接口 | 模型不可用时兜底 | 零配置零额度，总能给出东西 |

**实测质量差**（这就是为什么优先走模型）：

| 原文 | DSH 模型 | MyMemory |
|---|---|---|
| `Spaced repetition schedules reviews at increasing intervals.` | 间隔重复以不断增加的间隔安排**复习** ✓ | …安排**评论** ✗ |
| `The latent space of the model…` | 模型的**潜空间** ✓ | 模型的潜在空间 |
| `Each embedding is a dense vector…` | 每个**嵌入**都是…**稠密向量** ✓ | 每个嵌入… |

**`llm` 服务的用法（本机验证可用）**：

```js
const llm = ctx.get('llm')                                  // 不能写 ctx.llm，见下
const sel = ctx.get('agentDefaultModel').currentSelection()  // {provider, model}
const call = await llm.prepareCall({ ...sel, maxTokens }, signal, (c) => c)
for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
  if (chunk.type === 'text-delta') out += chunk.text
  else if (chunk.type === 'finish') finish = chunk.reason   // 失败/截断都在这里
}
```

**⚠️ 服务必须用 `ctx.get(name)` 取（2026-11-04 修的真 bug）**：插件是在
`root.inject(['webServer'], ctx => …)` 的回调里干活的，这个 ctx 只 inject 了
webServer。cordis 4 的属性访问只对本 fiber inject 过的服务放行，`ctx.llm`
会抛 `cannot get property "llm" without inject`；被 `try/catch` 吞掉之后
`llm` 就成了 null。ai-enrich.mjs 原来只试 `ctx[name]`，于是 **AI 分析在发请求
之前就返回 null**，界面永远是"AI 分析失败，可能是模型不可用"——选哪个模型都一样。
取法统一走 `lib/service.mjs` 的 `getService()`（先 `ctx.get`，再退回属性访问）。

**失败要说清楚（同一次修）**：`analyzeWord()` 现在抛 `AnalysisError`，带
`code`（`NO_LLM_SERVICE` / `NO_MODEL` / `PREPARE_FAILED` / `AUTH` / `RATE_LIMIT` /
`TRUNCATED` / `BAD_JSON` …）和一句人话；`/enrich-ai` 回 502 + 这句话，弹窗里直接显示。
适配器把失败放在终止块 `finish.reason.kind === 'error'` 里（不会 throw），
不读它就只剩空输出，只能报"模型不可用"。

**AI 分析选哪个模型（2026-11 改）**：翻译仍按上面的写法跟随会话默认模型；但
**AI 分析（词根/干扰项/记忆法）改成从 DSH 的模型目录里选**，默认取第一个：

```js
ctx.llm.listProviders()            // [{ id, name }]
await ctx.llm.listModels(id)       // [{ provider, id, name, inputModalities? }]
```

- 清单与 GUI 模型选择器同源，不自己维护模型名单；`inputModalities` 不含 `text`
  的模型（纯图像）排除。
- 默认 = `listProviders()` 顺序 × `listModels()` 顺序的第一个。
- 用户在设置页改的选择存 `user.db` 的 `settings` 表（key `ai_model`），
  每次分析时现解析，改完立刻生效；自选的模型从目录消失就静默退回第一个。
- 会话默认模型（`agentDefaultModel`）只作为"目录整个拿不到"时的兜底。

注意 **`messages` 必须是手搓的普通对象** `{role:'user', content:[{type:'text',text}]}`：
`@deepseek-ai/dsh-llm` 在插件目录里**解析不到**（插件 junction 到 D 盘的独立项目，
Node 按 realpath 向上找 `node_modules` 找不到），所以不能 `import { createUserMessage }`。
好在适配器只读 `role` / `content` / `source`，不读 `id` / `seq`（查 `dsh-llm-pi-ai` 源码确认）。

**为什么不复用官方 `ctx.translator`**：本机 profile 没启用它
（只有 `dsh-experimental-cot-translation-bundle` 提供，那个 bundle 默认禁用）。
依赖它等于"用户没装那个 bundle 就没译文"。官方 translator 的 Bing 后端也不可用：
`edge.microsoft.com/translate/auth` 实测 **404**，Bing 的 `ttranslatev3` 还要抓页面 token。

**失败姿态**：翻译失败**不设 `state.error`**（那是整卡错误，会把候选词一起吞掉），
只在译文位置画一行失败原因，词语照常给。
`/translate` 也回 **200 + `ok:false`** 而不是 500 —— 划词是交互路径，
500 会被前端当成网络故障。

### 表面 B：复习页（新 sidebar 面板）

- 到期词按 `due` 排前
- 题型对应能力维度：**认**（看词选义）、**写**（听音拼写）、**听**（听音辨词）、**读**（跟读对比）
- **操作即证据**：`view` = 弱信号，`hover`/`expand` = 中信号，答对 = 强信号，全部回写 `review_log`
- **每日上限**（新词数 / 复习数）——这是防积压的第一道闸
- **leech 机制**：失败 8 次打 tag 并暂停，提示改写或删除

#### 表面 B 重构：从"报表"改成"学习器"（2026-11-02）

第一版做成了**统计看板**：进来先看到 4 个大数字和 50 行复习列表。用户的原话是
「十来个单词就铺满全屏，看着就没有学习欲望」。复盘下来是四个错，都要认领：

| 错在哪 | 数字 | 改成 |
|---|---|---|
| 首屏在汇报**过去**（已复习 12 次、正确率 78%），没有"下一步做什么" | 4 个 26px 数字占满首屏 | **学习**视图一屏一词，进来立刻能开始 |
| 队列一次铺 50 行，释义就在单词下面 = **开卷考试**，没有回忆就没有记忆 | 700px 只看得到 9.5 个词 | 释义默认藏起，`Space` 揭晓，1–4 评分 |
| 每行 4 个按钮 | 50 行 × 4 = **200 个按钮**，每个约 26px | 一屏只有 4 个，高 **48px** |
| 报表占了 60% 的屏幕 | 14 天曲线 ×2 + 5 行画像 + 作答分布 | 全部搬进**数据**视图，首屏不出现 |

行高是量出来的，不是感觉：`.dwl-qrow` = padding 20 + 词行 24 + 释义行 21 + 边框 2 + 行距 7
= **74px / 词**；880px 的视口扣掉头部与 KPI 只剩约 700px，`700 ÷ 74 = 9.5`，
所以"十来个就满屏"是算术结果。

**三视图**：学习（默认）/ 词汇 / 数据。词汇页两列、每行 34px，一屏约 38 个词（原来 9.5 个）。

**两个实现约定**：

1. 复习用**游标**（`cursor`）而不是从数组里删行。评分只让游标 +1，队列本身不动 ——
   删行会让"还剩几个"和进度条跟着跳。
2. 键盘快捷键（`Space` / `1`–`4` / `J`）**必须真的绑上 `keydown`**。
   第一版的按钮 `title` 里写着"按 1"，但全文件 grep 不到任何 `keydown`，
   等于在承诺一个不存在的交互 —— 这类"承诺了但没做"比没有更伤。

**设计库里被否掉的一条**：`design_recommend` 把它归类成 Educational App，
推荐 Baloo 2 + Comic Neue 这类儿童字体。使用者是成年开发者，在 IDE 旁边背词，
用 Comic 系字体会降低"这件事值得认真对待"的感觉。**正文用系统 UI 字体，只有单词用衬线**
（`ui-serif / Georgia`）——词典与书籍的语感，大字号下才有分量。

**验证方式**：GUI 需要 `dsh web` 启动时打印的 token，拿不到，所以写了
`design/render-check.mjs` —— 用最小化的 React 替身把真实组件跑一遍，序列化成 HTML 再截图。
它验得到"组件不抛异常 / 数据形状 / 结构 / CSS 真的注入"，验不到真实的挂载时序与主题令牌实际色值。

### 表面 C：正文标注（参考 dsh-think-translate，风险最高）

**这里必须说清一个技术选择。** 参考仓库用了两种挂法，官方推荐的是后者：

| 挂法 | 位置 | 代价 |
|---|---|---|
| **A**（dsh-think-translate 用） | `conversation.chat.node` 的 `assistant-step` 键，`priority: -1` | 要自己接管整个助手渲染（markdown/图片/折叠），重 |
| **B**（官方 cot-translation 用） | `conversation.chat.reasoning.body` single 槽位 | 轻，跟得上上游，但只管思考正文 |

**DSH 官方自带思维链翻译插件**（`@deepseek-ai/dsh-experimental-cot-translation-bundle`，本机已装、默认禁用），
它用的就是 B。而 dsh-think-translate 作者自己在对比文档里承认：

> 后续结构性优化可将本插件的思考翻译迁到官方 `conversation.chat.reasoning.body`

**本方案选 B 起步**（先做思考正文标注），需要覆盖回答正文时再评估 A。

**关键约束（从参考仓库的坑里学到的）**：

1. **`priority: -1`**：官方在同 key 用 priority 0 注册，同 key 同 priority 会冲突报错。
2. **流式保护**：只处理"已完整、且离流式尾部还有 120 字符"的片段（参考仓库 `XL_STREAM_MARGIN = 120`、`XL_STREAM_MIN_BATCH = 24`），**永远不碰正在增长的那一段**。
3. **代码保护**：抄 `lib/text.js` 的 `protectedTextParts()`——把代码围栏、行内 `` `code` ``、缩进代码块挑出来原样保留。**这是"沉浸式替换"的安全底座**，否则会改坏代码块里的中文注释和字符串。
4. **三层保险丝**：块级边界（单块降级成原文）+ 整条级边界（回退成原文拼接）。参考仓库踩过：组件抛异常会让**整条回答被一行红字顶掉**，会话记录没丢但 UI 看不见了。
5. **不要 `require('@deepseek-ai/dsh-client-ui-primitives')`** 或其他 Client 包当模块用；样式只用 `--dsw-alias-*` 主题 token。

**冲突声明**：本插件与官方思考翻译**二选一**（同一块地）。装了本插件，就不能开官方思考翻译。

---

## 4. 排期算法

**`ts-fsrs@6.0.0` + 显式 FSRS-6（21 参数）**

- 不用 FSRS-7：形态未定稿、Anki 未合入（issue #5688 仍 open）、log loss 只差 2.6%
- `ts-fsrs` 不是零依赖：→ `@open-spaced-repetition/srs-kit@1.0.0`（BSD-3，自身零依赖），深度 1
- **硬性要求 Node ≥ 24**（本机 24.13.0 满足）
- FSRS-6 默认参数（三源交叉验证）：
  ```
  [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
   0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
   0.0912, 0.0658, 0.1542]
  ```
- **逐用户参数优化 > 追算法版本**，但优化器（`@open-spaced-repetition/binding`）需 WASI，成本高 → **先不做**，用默认参数。

**不要向用户承诺"减少 20-30% 复习次数"**——官方 wiki 自己标注该数字基于模拟，且官方 benchmark 结果表里根本没有 SM-2 行、三个指标从不测工作量。

### LLM 调参的介入点

LLM **不决定排期**，只做两件事：

1. **场景增强**（学习卡内容）：这个词在这句话里是什么意思、你的理解偏在哪
2. **画像修正**：从 `review_log` 里看出模式（哪些词总是认得出但写不出、哪个时段正确率高），
   调整**各维度的权重与 desired retention**，而不是直接改 `due`

**前期它没资格调**：数据不够（< 50 词、< 200 次交互）时不做任何调参。

---

## 5. 发音对比（成本最高的一项）

用户标准是"能写、**能听**"，且明确说"读也读不准"，并同意做对比。

### 5.1 关键结论：靶子错了，不是模型错了

调研（`pronunciation-alternatives-research.md`）推翻了初版方案的立足点。

**OpenPronounce 单词级精确率只有 0.20，根因不是模型差，是评分者口径太宽松——而这个口径恰好与用户需求相反。**
它的官方 benchmark 原文：

> Precision stays low in absolute terms because **the raters are lenient**: 90% of the words are rated 10/10,
> accent traits such as **ð→z, θ→s, ɪ→i or a dropped final consonant are almost never rated below 5**…

**它列举的"几乎从不被判错"的特征，正是中国学习者的高频错误。**

→ **所以"找精确率更高的方案"是在优化一个错的指标。越像人类评分者，对用户痛点越不敏感。**

**正确做法：保留 OpenPronounce 的音素级输出，换掉判定规则。**

- 0.3.0 起 `errors[]` 已带 `phones[]`（每音素 `expected` / `heard` / `confidence`）
- **直接消费这个，忽略它的词级 flag**
- 用自建「中式英语错误表」重判：`ð→z`、`θ→s`、`v→w`、`l↔r`、`ŋ→n`、`ɪ→i`、`æ→ɛ`、词尾辅音脱落、词尾加元音、重音位置
- **零新增依赖**

#### ⚠️ 实测修正（2026-10-29，见 `lab/VALIDATION.md`）

**上面"直接消费 `errors[]`"这一步是错的，实测发现它会漏报。**

`latent` 实测：分数 56.67（低分），但 `errors` 是**空数组**。
而 `expected_phones` / `heard_phones` 明明显示两处 `t→d`：

```
分数      : 56.67
errors    : []                                    <- 一个错都不报
expected_phones : [['l','eɪ','t','ə','n','t']]
heard_phones    : ['l','eɪ','d','ə','n','d']      <- 明明有两处偏差
```

**根因**：它的词级阈值是 `edits/length >= 0.4` 或 `edits >= 2`，
而 `t`/`d` 是清浊对，它的**近音成本只算 0.5**，够不着阈值。

→ **用户看到低分，却不知道该改什么。** 这比不给分更糟。

**正确做法：只用 `expected_phones` / `heard_phones`，自己做 Levenshtein 对齐。**
已实现在 `lab/scripts/zh_errors.py`（`analyze()` 完全不再读 `errors`）。

#### 错误表验证结果

用**最小对立对**做对照实验（合成真实错词、声明期望为目标词）：

- 实验组命中 **15/16 = 94%**
- 对照组误报 1/5

实验**抓到一个真 bug**：表里写的是 ASCII `"r"`，而模型 IPA 输出是 **`ɹ`（U+0279）**，
导致 `l→ɹ` 这条规则永远不命中——而这恰是中国学习者最经典的错误之一。
修复后 81% → 94%。**没有这个对照实验，这个 bug 会一直带到线上。**

剩余 1 例漏检（`seat`→模型把 `ɪ` 听成 `e`）与 1 例误报（`bad`→模型把标准 `æ` 听成 `ɛ`）
**都是模型的声学判断，不是错误表的问题**。合成音上的表现不能外推到真人。

### 5.2 方案分层

| 层 | 内容 | 许可 | 阶段 |
|---|---|---|---|
| 听标准音 | dictionaryapi.dev 真人音频；OpenPronounce `/tts` 整句（可离线 Piper/Kokoro） | MIT / 免费 | P1 |
| 粗筛门 | Web Speech API（**仅二值**，会把"读成另一个真实词"判对） | 浏览器 | P2 |
| **音素级诊断** | OpenPronounce 音素输出 + **自建中式错误表** | MIT | P4 |
| 元音可解释反馈 | formant F1/F2 对比（librosa ISC + 自写 LPC） | ISC | P4 |
| 可视化 | **CC0 剖面图 + Rhubarb MIT 口型图** | CC0 / MIT | P4 |

**"更准的开源方案"不存在**（逐一核实）：SpeechBrain 无发音评测 recipe（40 个 recipe 全查）、
icefall 无 GOP recipe（47 个 egs 全查）、PaddleSpeech 未发现相关模块、无基于 Whisper 的有基准项目。

**唯一许可干净的 GOP 是 Kaldi `egs/gop_speechocean762`（Apache-2.0）**，但需编译 Kaldi + TDNN 模型；
两个主流第三方实现（`tbright17/kaldi-dnn-ali-gop`、`jimbozhang/kaldi-gop`）**都是 GPL-2.0**。

### 5.3 素材许可（逐个实读 LICENSE 核实）

| 素材 | 许可 | 结论 |
|---|---|---|
| **Wikimedia `IPA * Sagittal Section.svg`（43 个，华盛顿大学 Richard Wright / Dan McCloy）** | **CC0**（`LicenseShortName: CC0`、`AttributionRequired: false`，逐文件实测） | ★**首选**，零法律风险，正是"舌位/发音部位图"，SVG 矢量 |
| **Rhubarb Lip Sync `img/lisa-A..H,X.png`（9 个）** | **MIT**，`LICENSE.md` 逐字声明 resources 也是宽松许可 | ★口型图首选 |
| ~~HunanBean CMU39（39 个音素级口型）~~ | **papagayo-ng 无 LICENSE，只有 `gpl.txt`（GPLv2）** | ❌ **不能用** |
| ~~Preston Blair 图集~~ | 受版权保护，无 PD/CC 版本 | ❌ |
| ~~Gary C. Martin 图集~~ | 站页脚 "no reproduction without author's prior written consent" | ❌ |
| ~~`Places of articulation.svg` / `Formants.jpg`~~ | CC BY-SA | ❌ share-alike 与 MIT 冲突 |

**重要提醒**：OpenPronounce 把这些许可不明的图**拷进了自己的 MIT 仓库**，且仓库内**无任何 NOTICE/CREDITS 文件**。
**MIT 只覆盖作者自己拥有版权的部分，不构成对下游的素材授权。所以"OpenPronounce 是 MIT"不能推出"里面的图也是 MIT"。**

**取舍**：CMU39 是 39 个音素级嘴型（`IY` 与 `IH` 分开），Rhubarb 只有 9 个口型级形状（两者会合并）。
**但 CMU39 是 GPL，Rhubarb 是 MIT。** 若只自用不发布，GPL 义务不触发；若发 npm/GitHub，须二选一。

### 5.4 工具链许可陷阱

- ❌ **Parselmouth = GPLv3、Praat = GPL** → 只能独立进程调用，不可打包
- ❌ **openSMILE = audEERING Research License，明确非商业**
- ⚠️ **phonemizer = GPL-3.0+**（OpenPronounce 的依赖）
- ✅ **librosa = ISC**、**pyworld/WORLD = BSD 三条款**、**gruut = MIT**、**g2p-en = Apache**

**架构含义**：P4 的 Python sidecar 要**独立进程**（`child_process`），**不做库级链接**，以隔离 GPL 依赖。

### 5.5 商业兜底（若自建不满意）

| 服务 | 能力 | 价格 |
|---|---|---|
| **Azure Speech** | 发音评估，文档原文 "costs the same as speech to text" | Free F0 **5 音频小时/月**；S1 **$1.00/hr** → 每天 50 词 ≈ 0.6 小时/月，**落在免费额度内 ≈ $0** |
| **SpeechSuper** | **明确有 "Single Word" 档** ★单词级最对口 | **$0.004/次**，$20/月最低 |
| **SpeechAce** | 明确含 Word Pronunciation Score + 音素级反馈 | Basic **$40/月**（5000×15s） |
| ELSA | — | **无公开 API**（developers 页 404，域名不解析） |

### 5.6 待标定的候选（不急于采用）

**`Jianshu001/wavlm-phoneme-scorer`**（HF，MIT，2026-03-31，5.29GiB，WavLM-Large 微调）：
音素错误精确率 **0.379→0.592**、F1 0.476→0.595、AUC 0.738→0.870。**但这是儿童语音 + 句子里的音素，不是词级。**
其 Docker 封装 `KenGrinder/wavlm-phoneme-validator` 的 README **自己警告**：

> An isolated phone is a different task again… **That is the case where this service is most attractive *and* least proven.**

→ **先录 30–50 个词自测 `pherr` 是否分离，再决定是否采用。**

---

## 6. 防积压（放弃率没有实证，只能靠工程手段）

调研明确：**没有任何同行评审研究给出"多数人放弃 Anki"或"卡片数 → 放弃率"的量化结论**。
唯一接近的是 Cureus 2022（70% 使用率、28-29% 完全不用，是**未使用率**不是放弃率）。

所以**自己埋点**（连续未复习天数、backlog 规模、流失点），并按优先级上这些闸：

1. **每日新词上限 + 每日复习上限**（最便宜、最有效）
2. **desired retention 别超 97%**（Anki 官方警告：接近 100% 工作量剧烈上升）
3. **backlog 期停新词**（backlog 会完全挡住新词）
4. **leech 检测 + 强制改写/删除**（默认 8 次失败，长尾卡吃掉不成比例的时间）
5. Load Balancing（把复习量摊平）

---

## 7. 架构

```
D:\projects\blog\dsh-plugins\dsh-word-learn\
├── package.json              ← 抄参考仓库，加 dsh.client
├── cordis.patch.yml          ← 抄，改 id/name
├── lib/
│   ├── index.js              ← 抄骨架：注入行 + 路由 + 信任栅栏 + 配置
│   ├── dict.mjs              ← 新写：ECDICT 查询 + 变形 + 词频
│   ├── enrich.mjs            ← 新写：LLM 场景增强（provider 接口照抄参考仓库形状）
│   ├── store.mjs             ← 新写：SQLite（Node 24 内置 node:sqlite，零依赖）
│   ├── srs.mjs               ← 新写：ts-fsrs 封装 + 两条线 + 毕业判定
│   └── text.js               ← 抄 dsh-think-translate 的代码保护
├── client.js                 ← 新写：划词卡片 + 复习页 + 正文标注
├── assets/                   ← 划词卡片前端（走 index-inject）
├── data/
│   ├── ecdict.db             ← ECDICT 转 SQLite（词频前 5 万 + 全部考纲词）
│   └── user.db               ← 用户熟练度数据
└── DESIGN.md                 ← 本文档
```

**两条注入通道都要用**：

1. `webserver/index-inject` → 划词浮卡（要覆盖任意页面内容，slot 做不到）
2. `dsh.client` 槽位注册 → 正文标注（`conversation.chat.reasoning.body`）+ 复习页

**明确不改的**：`makeFence` 信任栅栏、注入行写法、mtime 热重载、卡片 UI 全套。
**必须新建的**：落盘存储、复习页、熟练度模型、两条排期线。

---

## 8. 分期

| 期 | 内容 | 验证什么 | 风险 |
|---|---|---|---|
| **P1** | 划词卡片 + 拆词 + ECDICT 释义 + 发音 + 存库 | 愿不愿意天天用 | 低 |
| **P2** | 复习页 + FSRS-6 + 认/写/听题型 + 每日上限 + leech | "能写、能听"能否推进 | 低 |
| **P3** | 正文标注（`reasoning.body`，代码保护 + 流式保护 + 三层保险丝） | 沉浸式是否真增加接触量 | **中高** |
| **P4** | LLM 场景增强 + 画像修正 | "适应用户的脑子" | 中 |
| **P5** | 发音诊断（OpenPronounce 音素输出 + 中式错误表 + CC0 剖面图/口型图） | "读不准"能否真正修好 | **高（架构追加）** |

**P1 不做完不用看后面**——如果 P1 自己都不爱用，P2 之后全是浪费。

**P5 拆成两步，先便宜后贵**：

- **P5a（零架构成本）**：先装 OpenPronounce 独立跑，拿自己的声音试 30–50 个词，
  只消费 `expected_phones` / `heard_phones` + 中式错误表 + CC0 剖面图。
  **不写 sidecar，不集成。** 验证"音素级反馈对我到底有没有用"。
- **P5b（确认有用才做）**：集成 sidecar（独立进程）、加 formant 元音模块、口型动画。

### P1 完成（2026-10-30）

| 项 | 状态 |
|---|---|
| ECDICT 建库（59111 词 + 39053 变形，14.4 MB） | ✅ |
| 词形还原（`children→child`、`better→good` 走 lemma，不误报生词） | ✅ |
| 划词卡片（查词/释义/发音/例句/近义/收藏/入生词本） | ✅ |
| 拆词（选中整句 → 候选词，代码/URL/路径噪声已剔除） | ✅ |
| 7 条路由全部在真实宿主挂载并鉴权通过 | ✅ |
| 明暗主题跟随 DSH | ✅（见风险 13） |
| **"愿不愿意天天用"** | ⬜ **只有你能答，这是 P1 的唯一验收标准** |

验收口径：`DESIGN.md §8` 写明 P1 验证的是"愿不愿意天天用"，
这是使用意愿问题，**不是我能自测的技术指标**。技术侧已全部就绪，等你实际用几天。

自查过的边界：查不到的词 → 404 带中文提示；空词 → 400；500 字符词 → 404；
`a';DROP TABLE words;--` → 404 且库完好（全走参数化查询）。

### P2a 看板 + 排期（2026-10-30）

左栏上半部分新增「英语学习」入口，点开是整页学习面板。

| 项 | 状态 |
|---|---|
| FSRS-6 排期层（`lib/schedule.mjs`，ts-fsrs@6.0.0） | ✅ |
| 两条线（receptive / productive）独立排期 | ✅ |
| 左栏入口 `sidebar.panellist` + 整页 `main` | ✅ 已注册（**需重启宿主**才进 boot 清单） |
| 看板：今日/明日复习、未来 14 天预测、近 14 天活动 | ✅ |
| 报表：正确率、作答分布、最容易忘的词、最近遇到 | ✅ |
| 学习进度（分档堆叠条）+ 能力画像直方图 | ✅ |
| 评分（忘了/勉强/记得/太简单）→ 写回排期 | ✅ |
| 复习题型（看词选义 / 听音拼写） | ⬜ P2b |
| 每日新卡上限 / leech 挂起 | ✅ 逻辑已实现，界面暂未暴露开关 |

**口径说明（重要）**：看板上的"正确率"是**本插件自己定的** ——
「记得/太简单」算对。FSRS 官方不发布这个指标，别当成算法质量来读。

### P5a 进展（2026-10-29）

| 项 | 状态 |
|---|---|
| 环境（Python 3.12 venv + espeak-ng + 2 个模型 4.8GB） | ✅ 全在 D 盘，C 盘未增长 |
| 链路端到端跑通（8/8 样本） | ✅ |
| 绕开词级阈值、自建音素对齐 | ✅ 抓到它漏报的 `latent`/`throughput` |
| 中式错误表 + 最小对立对验证 | ✅ 命中 94%，并修掉 `l→ɹ` 漏检 bug |
| **真人录音自测（30–50 词）** | ⬜ **未做，这是 P5a 的真正目的** |
| P5a 结论 → 是否做 P5b | ⬜ 待定 |

工具已就绪：`record.py`（录音）+ `analyze.py`（分析）。
**下一步就是录自己的声音，判断"它报的错我认不认"。**
详见 `lab/VALIDATION.md`。

性能实测（CPU）：单次分析 **0.7–1s**（首次含加载 32s），常驻则只付一次 25s 加载。
→ 印证 P5b 的 sidecar **必须常驻进程**，否则每次 25s 不可接受。

---

## 9. 待定 / 风险

1. **P5 的 Python sidecar**：2.4GB 模型 + ffmpeg + espeak-ng，且 `phonemizer` 是 GPL-3.0+
   → **必须独立进程调用，不做库级链接**。接受则加架构，不接受则放弃音素级。
2. **P3 与官方思考翻译冲突**：二选一，不可叠加。
3. **`ctx.llm` 在插件里的可用性**：`ctx.llm.stream()` + `agentDefaultModel.currentSelection()` 已确认存在，
   但**尚未实测**从 Host 插件里调用。
4. **ECDICT 的 `audio` 字段官方标注"待添加"= 空的**，发音靠 dictionaryapi.dev。
5. **`node:sqlite` 是实验特性**（Node 24 会打 ExperimentalWarning），需确认可接受。
6. **desired retention 的具体数值**是本方案的推断，论文没给可执行参数，需要实测校准。
7. **口型素材的 GPL 取舍**：CMU39（39 音素级）是 GPL，Rhubarb（9 口型级）是 MIT。
   自用不发布则 GPL 义务不触发；发 npm/GitHub 则须二选一。
8. **HunanBean 的原始发布页未找到**（DuckDuckGo 触发验证码）——这是唯一可能改变第 7 条结论的因素。
   最低成本解法：直接问 GitHub `@Hunanbean`。
9. **P5a 的自测是前置门槛**：`wavlm-phoneme-validator` 作者自己承认"孤立音素是最没验证过的场景"，
   而这恰是本插件的场景。**不先自测就集成，是在赌。**
10. **【新增·实测】不能信任 OpenPronounce 的词级判定**：它会给低分但 `errors` 为空
    （`t`/`d` 这类清浊对的近音成本只有 0.5，够不着 `0.4` 阈值）。
    必须自己用 `expected_phones`/`heard_phones` 对齐。已实现。
11. **【新增·实测】IPA 符号必须用 U+0279 `ɹ`**：ASCII `r` 不会出现在模型输出里。
    错误表里两者都要写，否则 `l→ɹ`（中式最经典错误）静默漏检。
12. **【新增·实测】合成音实验不能外推真人**：espeak 的标准发音，模型仍会把 `æ` 听成 `ɛ`（误报）、
    把 `ɪ` 听成 `e`（漏检）。**真人自测是唯一有效的验收标准。**
13. **【新增·实测】DSH 的深色标记是 `body[data-ds-dark-theme]`，不是 `data-theme="dark"`**。
    我最初按后者写前端判断，而 DSH 根本不设这个属性 → 深色模式下卡片一直是浅色底，
    在深色界面里白得刺眼。真机实测才发现。
    **正确做法**：颜色优先取 DSH 的主题令牌 `--dsw-alias-*`（如 `--dsw-alias-bg-overlay`、
    `--dsw-alias-label-primary`），令牌缺失才用自带兜底值 —— 这样主题由 DSH 驱动，不用自己猜。
    深色兜底选择器写 `body[data-ds-dark-theme] .dwl-card`。
    另外**切主题不触发 `matchMedia`**（用户手动切时系统偏好没变），只监听 media query
    会漏掉最常用的切换路径，必须同时用 `MutationObserver` 盯 body 属性。

    **主题令牌真实取值**（从 `dsh-client-ui-theme/lib/client.js` 读出，2026-10-30）。
    要验对比度请查这张表，**不要凭感觉填色** —— 我曾把 tertiary 猜成 `#8a8a8a`，
    截图看着"偏暗"，差点白改代码；真值是 `#adb2b8`，对比度 7.36:1 完全达标。

    | 令牌 | 浅色 | 深色 |
    |---|---|---|
    | `bg-base` | `#ffffff` | `#151517` |
    | `bg-layer-1` | `#ffffff` | `#232324` |
    | `label-primary` | `#0f1115` | `#f9fafb` |
    | `label-secondary` | `#61666b` | `#cfd3d6` |
    | `label-tertiary` | `#81858c` | `#adb2b8` |
    | `border-l2` | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` |
    | `interactive-bg-hover` | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` |
    | `bg-skeleton` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.08)` |
    | `state-error-primary` | `#ec1313` | `#f25a5a` |
    | `state-business-primary` | `#4176e6` | `#7aaaff` |
    | `state-success/warn-primary` | `#22c55e` / `#f59e0b` | 同左 |

    **层级方向在两套主题里相反**：深色下 tertiary(`#adb2b8`) 比 secondary(`#cfd3d6`) 暗，
    浅色下反过来。照抄数值时别搞混。
    WCAG 对比度实测（对 `bg-layer-1`）：深色 15.03 / 10.42 / 7.36，全达标；
    浅色 18.90 / 5.80 / **3.71** —— 浅色 tertiary 只够大字，别放正文。
14. **【新增·实测】FSRS 的 `learning_steps` 必须存，否则排期静默失效**。
    它是"当前在第几个学习步"，是**调度状态的一部分**。丢掉它卡片会永远卡在
    `Learning`、永远毕业不到 `Review`，而且**不报错**——所有间隔恒为 0 天。
    实测（同一串 Good，间隔 0/0/0/1/3 天）：
    保留 → `Learning → 2天 → 3天 → 7天 → 20天`；丢掉 → 永远 `Learning`。
    P1 的 `cards` 表恰好没有这一列，所以升级时必须迁移（见 `store.mjs` 的 `migrate()`）。
15. **【新增·实测】看板进度不能拿"卡片数"除以"词数"**。
    一个词有两条线 = 2 张卡，所以"已开始的卡片数 / 词数"会超过 100%
    （实测造出 **135%**，最坏 200%）。分子分母必须同单位，用
    `COUNT(DISTINCT word_id)` 按词算。
16. **【新增·实测】Client 半边要重启宿主才生效，HMR 不管用**。
    `dsh-client-modules` 把"这个包不是 client 包"的**否定结论缓存在 `pkgMeta`** 里
    （按 loader specifier 缓存），而 HMR 只重跑 `processOne`，不刷新这个缓存。
    所以给已有插件**新增** `dsh.client` 段之后，必须重启宿主；
    重启后改 client.js 才恢复 mtime 热重载。
    2026-10-30 重启后确认生效：`__DSH_BOOT__.entries` 出现 `dsh-word-learn` 条目
    （共 79 条，我的在第 61 位），client.js 31722 B 正常返回。

    ⚠️ **取 client.js 必须用 boot 清单里的 `url` 字段，不要自己拼**。
    真实形态是 `/plugins/??<pkg>/client.js&rev=<hash>`（`??` 是模块加载器的分隔符）。
    我按直觉拼 `/plugins/dsh-word-learn/client.js` 得到 404，一度误判"重启也没生效" ——
    其实插件早就好了，是 **URL 拼错**。**判断是否生效只看 boot 清单里有没有自己的 id。**
17. **【新增·实测】侧栏 `label` 要写成函数，且必须先注册 locale 目录**。
    侧栏求值方式是 `resolveSlotLabel(options.label) ?? id`，并订阅了
    `ctx.locale.subscribe`，所以 `label: () => t('panel.title')` 会随语言切换刷新。
    但 `locale: NS` **本身只是声明**，不 `ctx.locale.register(NS, {...})` 的话
    `t()` 会**退回返回原始 key**（侧栏显示 "panel.title" 字样）。
    locale key 必须过 BCP 47 风格正则 `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$`，不合规会 throw。
    本机侧栏顺序实测：`dshmarket=1` → `schedule=10` → **`word-learn=15`** → `context=20` → `horon-web=20`，
    所以 15 落在左栏上半部分。
18. **【新增·真机踩到】划词会抓到「数值量级后缀」**（`≈62.3M` → 单词 `M`；`≈65.7k` → 单词 `k`）。
    前端剥掉选区首尾非字母后，`M`/`k` **形状上完全像一个单词**，于是被查了并写进生词本。
    两处漏网：`wordcard.js` 的 `isSingle` 只看字符形状；宿主 `/lookup` **只校验非空**。
    讽刺的是 `lib/text.js` 的 `looksLikeWord()` 本来就写对了（长度≥2、含元音、非全大写），
    但**这两条路径都没走它**。
    **修法**：前端 `isSingle` 补长度/元音/非全大写；宿主 `/lookup` 对**单 token**（不含空格）
    加 `looksLikeWord()` 闸 → 400，含空格的放行交给 `/save` 拆词（否则 `take effect` 被误杀）。
    **教训**：过滤逻辑写在工具函数里 ≠ 每条路径都调用了它。新增入口时要回头确认没绕过既有校验。
19. **【新增·真机核实】划词卡片只对对话正文生效**（用户要求：左栏、右栏、轨迹页都不管）。
    判定锚点用 **`[data-chat-flow]`** —— 这是 `dsh-client-ui-chat` 渲染 Chat 视图正文列时
    挂的标记（0.2.1-rc.2 的 `lib/client.js` 里 8 处，其中一处是 `data-chat-flow` 的空值写法）。

    **为什么不用看起来更"官方"的 `[data-conversation-content]`**：那是**整个对话面板**的根
    （`dsh-client-ui-conversation/lib/client.js:17865`），而**轨迹视图是作为
    `conversation.view` 槽位渲染在它内部的**（同一个 `DefaultConversationViews` 里按 viewId
    切换 Chat / Trajectory）。拿它当范围 = 轨迹页照样弹卡，正是用户要消掉的行为。
    左栏（`dsh-client-ui-sidebar`）、右栏（`dsh-client-ui-sidebar-right`）也都不带这个标记，
    所以这一个选择器同时排除了三者。

    **不能用「两端落在同一个 `data-chat-flow`」判定**：助手回复里的步骤过程区块
    （`data-step-process-content`）**自己也是一个 `data-chat-flow`**，嵌在外层之内
    （`dsh-client-ui-chat/lib/client.js:4239`）。跨它选中时两端会是不同元素，同一性判定会误杀。
    所以只要求两端**各自有**这样的祖先。

    **严格模式**：锚点找不到就完全不响应。DSH 升级换掉标记时卡片静默失效，
    而不是退回"全页面乱弹"。这是用户明确选的取舍。

    **可测性**：判定被抽成 `SCOPE_SELECTOR` + `inConversation(node)` 两个独立定义，
    `scripts/test-scope.mjs` 直接从 `wordcard.js` **切出这段真实源码**求值（不复制逻辑），
    用 DOM 桩覆盖「对话正文该生效 / 左栏·右栏·对话面板根不该生效 / 边界输入不抛错」。
    **改锚点必须让这个测试跟着改**，否则测试会因切不出片段而直接报错——这是故意的。

    ⚠️ **验收时的坑**：本机 DSH 只监听 `127.0.0.1:3080`，而 `dsh web` 的启动令牌
    （`?token=...`）是**每进程随机生成**的（`dsh-client-connection` 的 `processLaunchToken`），
    不在任何文件里。用 BrowserSkill 直接开 `http://100.115.120.50:3080/` 只会拿到
    401 "dsh web authentication required"。**验证要用用户自己已登录的那个浏览器窗口**
    （或让用户刷新页面），不要另开窗口去猜 URL。

---

## 10. 学习页「忘了」分支：补记循环（2026-11-04，P0 已落地）

现行「忘了」分支是**看释义 + 点「记住了，下一个」**：零提取、零产出、零复现，
而且只有「记得/模糊」才进选择题 —— 越不会的词练得越少。用户反馈「惩罚太低、
没兴趣内容、下次还是忘」，根因不是惩罚力度，是**失败路径里没有学习事件**。

完整研究、证据与状态机见 [`design/forgot-repair-loop.md`](design/forgot-repair-loop.md)，
可点开的原型见 [`design/forgot-repair-demo.html`](design/forgot-repair-demo.html)。

实现时的三条硬约束（写在这里，防止以后改跑偏）：

1. **评级只评「第一次无提示提取」。** 按「忘了」即记 Again(1)，补记循环里的成功
   写 `repair_log`，**不写回 `cards`**。补记后改评「记得」会让 FSRS 高估稳定性。
2. **不做扣分/掉血/断 streak。** 惩罚改成响应代价：R2 没成功之前不出现「下一个」。
   忘记不被定罪，跳过才要补 —— 否则用户会开始谎报评级，污染唯一的真值信号。
3. **唤醒绑在词义上，不绑在界面上。** 红闪、警报、倒计时会让注意窄化到 App；
   反差（「你以为是分辨率，这里是决心」）才是既抓注意又作用于词义的做法。
   趣味内容必须回答「它解释了哪个义项」，否则就是 seductive details（会降低学习）。

### P0 实现（2026-11-04）

| 改动 | 位置 |
|---|---|
| 队列项带最近一次原句（`contexts` 子查询） | `lib/schedule.mjs` `dueQueue()` |
| 「忘了」改为 `recall → reveal → spell → spell-ok` 四段 | `assets/dashboard.js` `StudyView` |
| 拼写阶段藏单词、藏音标、藏喇叭、藏跳过 | 同上（header / tail / phon） |
| 原句挖空与高亮（支持 -s/-ed/-ing） | `StudyView` 的 `sentenceSpot` |
| 连点提交防重复评分 | `spellLock` ref |

**与设计稿的偏差**：P0 没有做「四选一义项」——那需要 LLM 先判定「这句里是哪个义项」，
属于 P1 的 `senseMeta`。P0 用**自由回忆 + 拼写**替代：不依赖模型、离线可用，
而且自由回忆比重认更难，已经能堵住「看答案 + 点下一个」这个最大的漏。

**上线方式**：`lib/schedule.mjs` 改了 SQL，必须**重启宿主**；前端 `assets/dashboard.js`
是 mtime 热重载，刷新页面即可。

**验收（待用户实测）**：按「忘了」后，不完成一次正确拼写出不去；同一张卡仍只写一条
`rating=1` 的 `review_log`；原句缺失时降级为「看中文拼写」。

### P1 实现（2026-11-04）

P1 把 P0 的「自由回忆」升级成**义项判别**，并补上会话末复现与效果度量。

| 改动 | 位置 |
|---|---|
| `sense_meta` 表（按 word_id + sense_key 存归一化后的义项材料） | `lib/store.mjs` |
| `repair_log` / `repair_debt` 表与读写方法 | `lib/store.mjs` |
| `analyzeSense()`：按「词 + 原句」产出义项材料 | `lib/ai-enrich.mjs` |
| `normalizeSenseMeta()` 质量闸门（详见下） | `lib/ai-enrich.mjs` |
| 四选一选项由服务端用词典义项原子拼（不信任模型给的选项） | `normalizeSenseMeta` |
| 后台义项队列 `enqueueSenseAnalysis()`（与词级分析分队列） | `lib/ai-enrich.mjs` / `lib/index.js` |
| `GET /repair?cardId=`：原句 + senseMeta + 债 | `lib/index.js` |
| `POST /repair/log`、`POST /repair/clear`、`GET /repair/stats` | `lib/index.js` |
| 评 Again 时开债 | `/grade` → `store.openRepairDebt()` |
| `pick → reveal → spell` 三选一流程 | `StudyView` |
| 会话末 `RepairPass`：今天忘过的词再拼一次，拼对清债 | `RepairPass` |
| 统计页「补记循环」面板 | `StatsView` |
| 划词时取「词所在的那句话」存为原句 | `assets/wordcard.js` `sentenceAround()` |

`normalizeSenseMeta` 的闸门（模型最容易在这几处编造）：

- `sense_here` 必须能在词典义项里找到，否则整条丢弃；
- 例句必须含目标词、≤24 词，否则清空例句并记 `degraded`；
- 另一个义项的例句必须含目标词且不与本句同义，否则丢弃；
- 词源只在 `confidence === 'high'` 时保留 —— 编造词源比没有词源伤害大；
- 三个错误选项由 `likely_assumed`、另一义项、词典义项原子凑；凑不满四个就返回 null，
  前端退回 P0 的自由回忆。

**降级路径**：义项分析是后台串行跑的，第一次忘一个词时很可能还没算好 ——
`/repair` 返回 `senseMeta: null`，前端直接走 P0 的自由回忆，不阻塞。
义项分析失败只打 warn，不影响查词与复习。

**2026-11-04 补的坑**：划词卡片原来只把**选中文本**当原句存，
双击选一个词时原句就等于单词本身，`sense_meta` 一条都生成不出来
（实测：`contexts` 33 条里 20 条只有单词，`repair_log` 全是 `spell`、没有 `pick`）。
现在 `sentenceAround()` 会取词所在的那句话；改动只在 `assets/wordcard.js`，刷新页面即可。

**2026-11-04 用户实测卡住**：拼写阶段原来要两次没中才出现「看答案」，点过之后按钮按
`!spellAnswer` 消失，而红色提示还在写「点「看答案」」；再用错答案提交时界面没有任何
变化 —— 用户以为假死。改法：

- 第二次没中**自动**把答案摆出来（大号等宽字体），不再有会消失的按钮；
- 提示文案跟着状态变，不再指向不存在的按钮；
- 答案出现后给一个「过不去，先过这张」的出口（评级仍是 Again(1)，只是把
  「必须拼对」降级成「至少看一遍答案」）；
- `button:disabled` 补了可见的降级样式 —— 之前 `busy` 卡住时按钮和可点状一模一样。

**没有做的（留给 P2）**：R5 次日判别（把当天补记过的词在次日队列里再考一次）、
跨会话未清债务在队列开头的提示、词源/记忆法的更多内容。

### P2 实现（2026-11-04）：R5 次日回访 + 义项地图

P2 补的是「隔夜还记不记得」——P1 的所有失败模式（猜错义项、拼不出来）都只在**当天**
被验证；不看次日，就没法证明这套流程真的换来留存。

| 改动 | 位置 |
|---|---|
| `buildRecap()`：取昨天忘过/修过的词，出一批评判题 | `lib/r5.mjs` |
| `submitRecap()`：写 `repair_log(stage='tomorrow')`，答对清债、答错重开债 | `lib/r5.mjs` |
| `senseMap()`：该词见过的义项 + 每个义项的答对/答错状态 | `lib/r5.mjs` |
| `GET/POST /repair/recap`、`GET /sense-map` | `lib/index.js` |
| `RecapPass`：进学习页先做「昨日回访」，可跳过 | `assets/dashboard.js` |
| 词汇详情弹窗「义项」块 | `WordMetaModal` |

几个不显然但必须这么定的规则：

- **同义/异义各半**：异义句来自 `other_sense.sentence`，同义句来自 `personal_example`
  （同一义项的例句）。只用异义句的话答案恒为「不是」，等于没考。
- **s1 取「材料生成之前」最近的原句**：`sense_here` 属于生成材料那一刻的那句；
  若之后同词在新语境出现，拿最新句会出成自相矛盾的题。
- **排除今天已回访过的词**：答对清债后昨天那条 log 还在，不排除的话刷新会无限重复回访。
- **零 FSRS 污染**：回访只写 `repair_log` 与债，不调 `applyGrade`、不写 `review_log`。
  用单测对 `cards`/`review_log` 做前后快照断言。
- 凑不出两句话（没有 sense_meta / 没有可用原句）的词直接跳过，不硬凑。

**验收**：`node scripts/test-r5.mjs` → 133 项断言通过（配额、跳过规则、清债/开债、零污染）。
真实库副本回拨一天后出题正确；第二实例实测「回访 → 答对 → 清债 → 进主队列」全流程。

### P3 实现（2026-11-04）：对话内联标注

在 DSH 对话里，把**在学、有卡片**的词在已渲染的英文上做标记（虚线下划线 + 悬停小卡），
原文一个字不动、不翻译、不替换。详细架构与黑白名单见 `design/p3-inline-annotation.md`。

| 改动 | 位置 |
|---|---|
| 标注层（独立 IIFE，无 React） | `assets/annotate.js` |
| 目标词表 `{words:[{w,t,s,c}], rev}` | `lib/annotate.mjs` |
| `GET /annotate/words`、`GET /annotate.js`（no-store，改完刷新即生效） | `lib/index.js` |
| 注入行追加第二个 `<script>`（两脚本各自带 window 标记，互不拖累） | `INJECT_TEXT` |

硬约束与对应实现：

- **只在 DSH 对话内**：白名单根 `[data-chat-flow]`（顶层去重）；侧栏/轨迹/学习页在根外，天然不碰。
- **不处理流式输出**：`[data-streaming]` / `[hidden]`；没有这些属性时用
  「800ms 文本稳定 + 有 `[data-chat-running]` 时跳过 DOM 顺序最后一块」兜底。
- **折叠框只标标题**：`<details>` 未展开只标 `summary`；`[aria-expanded="false"]` 整棵跳过；
  展开时走 `toggle`/`click` 快速通道（30ms 直接重标，不等稳定窗）。
- **代码/文件名/URL/其它弹窗**：容器级黑名单（`pre`、`code`、`.md-code-block`、`a`、
  `[role=dialog]`、`button`、表格、`[data-ref-chip]`），再加 token 级过滤
  （邻接 `/ \ _ @ # $ % & = + < > ~ ^ :`、数字、驼峰、全大写、`word.js` 形态一律不标）。
- **性能**：只用 `IntersectionObserver` 处理可见块；单块 60 个上限、全局上限、
  文本节点上限；`MutationObserver` 只在对话区变化时重扫。

**开关**：`localStorage['dwl-annotate'] = 'off'` 关闭（默认开）；
运行期 `window.__dwlAnnotate.{enable,disable,refresh,clear,stats}`。

**验收**：`BSK_BROWSER=<browser-id> node scripts/test-annotate.mjs --browser` → 69/69。
第二实例实测（真实 DSH 页面，不是 fixture）：段落标注 7/7、悬停卡出「最近义项」、
代码/URL/路径容器零标注、关掉开关旧标注立即清空。

**成本注意**：悬停卡「收进复习」走现有 `POST /lookup`（save:true），会顺带入队 AI 义项分析。
将来如果嫌烧额度，可加 `POST /annotate/capture` 只写 `contexts`，标注层改一行路径即可。

截图存证：`design/qa-2026-11-04/recap.png`（昨日回访）、`design/qa-2026-11-04/annotate-hover.png`（悬停卡）。

**代码与交互审查（2026-11-04）**：[`design/review-2026-11-04.md`](design/review-2026-11-04.md)
—— 三条并行静态审查（路由层 / R5 与标注服务 / 两个前端脚本）+ design review + 深浅主题实测，
含已修项、待修清单与交互改进建议。本轮已修：注入器标志撞名（划词卡整卡失效）、浅色对比度 5 类、
wordcard 黑名单与 3 个竞态。

**2026-11-04 踩的坑：e2e 测试污染了真实用户库。**
`scripts/test-routes.mjs` 原来直接吃宿主导出的 `DSH_HOME`，跑一次就会真的给真实库
评级（`review_log` +1）、开补记债、写 `repair_log` —— 当天连跑两次，两张卡的 fsrs
排期被改了。原因是守卫写成「`DSH_HOME` 没设才用临时目录」，而宿主**总是**会设它。
已改为：默认 `mkdtemp` 一个临时 `DSH_HOME` 并在退出时删除，只有显式 `--allow-real-db`
才碰真实库。其它 `test-*.mjs`（r5 / annotate / model-routes）本来就是这么做的。
**以后加任何会写库的测试，先确认 `DSH_HOME` 被覆盖，别信"没设"这个判断。**

**2026-11-05 第三批（数据正确性 / 路由 / 标注 rev / 发音）**

- 路由层（`lib/index.js` + `scripts/test-routes.mjs`）：`safeSend` 统一出口 + `registerRoute` 兜底、`readJson` 断言对象、`/grade` 先响应后记债（记债失败不再 500 导致重复评分）、500 响应脱敏、`/list` 参数夹取、methods 白名单 405、`/tts-prepare` 互斥、删 `/stats`。test-routes 从"只打印"变成 27 条硬断言。
- 标注层（`lib/annotate.mjs` + `assets/annotate.js`）：rev 改内容投影（改释义/毕业/挂起会让前端重拉）；查询失败返回 `ok:false`，前端**保留旧标注**只重试，不再清屏。test-annotate 44/44、浏览器 96/96。
- 存储与队列（`lib/store.mjs` + `lib/ai-enrich.mjs`）：`open()` 不再一次失败永久熔断（10s 退避）；写库失败的 `/lookup` 响应带 `warnings`（词卡底栏显示）；AI 队列上限 200 + `disposeQueues()`。
- **发音（详见 [review 第 7 节](design/review-2026-11-04.md)）**：根因是缓存里一条 8 字节坏 mp3（早期 e2e 用真实 `DSH_HOME` 写的假音频）被当作"命中"永久返回；另一条是有道免费源对部分词/词组返回 500，回退 `speechSynthesis` 时 `getVoices()` 尚未就绪导致静默。现在：坏缓存自愈（<1KB 或头不对即删重拉）、支持词组/去变音符号/下划线、失败换口音重试、`?refresh=1` 供前端解码失败时自愈、词卡等待 voices 就绪且失败必显示原因。



