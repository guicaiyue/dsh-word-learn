# 忘了之后：把失败路径改成学习事件

> 对象：`dsh-word-learn` 学习页的「忘了」分支
> 触发：用户反馈「忘了只给看意思，惩罚太低、没兴趣内容、拉不动注意力，下次还是忘」
> 日期：2026-11-04

---

## 0. 结论先说

1. **问题不是惩罚力度，是失败路径里没有任何学习事件。** 现在按「忘了」= 看释义 + 看提示 + 点「记住了，下一个」。这 3 秒里没有一次提取、没有一次产出、没有一次复现。惩罚再重，也只是在这 3 秒里加一层痛感，不产生记忆。
2. **最该练的词，练得最少。** 只有按「记得 / 模糊→想起来了」才会进选择题；按「忘了」直接跳过。你越不会，题目越少——练习分配是反的。
3. **你的真实缺口是义项，但所有题都是词级。** 选择题的正确答案是这个词的前 3 个义项，干扰项来自**别的词**。它问的是「这串中文是不是这个词的释义」，从来没问过「这句话里它是哪个意思」。而你自己说的缺口正是「一个词只掌握单一场景义项」。
4. **最强的「情绪唤醒」不是惩罚，是高信心错误被当场打脸。** 你看到 `resolution` 时脑子里蹦出「分辨率」——这是一个**高信心错误**。高信心错误被纠正后，记忆效果比低信心错误更好（hypercorrection）。把「你以为是 X，这里是 Y」做成卡片的核心节拍，比加红闪、扣分、断 streak 有用得多。
5. **「有趣内容」有个反效果陷阱。** 与词义无关的有趣细节会**降低**目标内容的学习（seductive details effect）。有趣必须是「关于这个词、关于你」的有趣，不是装饰。

一句话：**把「忘了」从「展示答案」改成「一次不可回避的提取 + 一次产出 + 两次复现」，并且让内容长在你的原句和你自己的领域上。**

---

## 1. 现在的失败路径到底发生了什么

对着代码走一遍（`assets/dashboard.js` 1709–2050）：

| 步骤 | 代码 | 实际发生的事 |
|---|---|---|
| 按「忘了」 | `handleBranch('forgot')` → `phase='forgot'` | 分支确定 |
| 展示 | `meaningBlock` + `MemoryHints` | 释义、词根、记忆法、易混淆词，全是**静态词典内容** |
| 唯一的按钮 | 「记住了，下一个」→ `forgotNext` → `onRate(1)` | 直接评 Again，进下一张 |
| 这个词还会出现吗 | `dueQueue` 规则 2：一个词一轮只出现一次 | 本轮**不会**再出现；下次要等 FSRS 的 10 分钟步进或明天 |

### 1.1 五个缺口

1. **零提取**：失败之后没有「再想一次」的机会。看答案 ≠ 提取。
2. **零产出**：不用写、不用说、不用造句。手指只点了一下按钮。
3. **零复现**：这个词本轮消失。FSRS 的 Again 确实排了 10 分钟，但用户做完这一轮就走了，10 分钟后那张卡没人碰。
4. **零个人相关性**：例句是词典的，提示是通用的，和你今天读的那段思维链、你写的代码没有任何关系。
5. **零义项训练**：`splitSenses` 只是把释义拆成「主释义 + 其余」，展示用；没有任何题目要求你区分义项。

### 1.2 一个更隐蔽的结构性 bug：练习分配是反的

```
记得   → 选择题（测验）
模糊   → 提示 → 想起来了 → 选择题
忘了   → 看答案 → 下一个
```

「记得」的人做测验，「忘了」的人看答案。**测验效应恰好作用在最不需要它的词上。** 这不是参数问题，是分支设计问题。

### 1.3 选择题测的也不是你要的东西

`generateQuiz()`（`lib/ai-enrich.mjs` 425）：

- 正确答案 = 这个词的**前 3 个义项**，全部标 `correct: true`；
- 干扰项 = AI 给的 distractors，不够时从**生词本里别的词**随机取；
- 全程不使用你遇见它的那句话。

所以它是一道「词—义项归属」题，不是「语境—义项判别」题。你能做对，可能只是因为你认得「分辨率」这三个字属于 `resolution`，而不是因为你看懂了这句话。

---

## 2. 为什么会「下次见面还是忘」

四个机制，按重要性排：

1. **再认 ≠ 提取。** 看词选义是再认（recognition），在真实阅读里你需要的是从语境里把意思**提取**出来（recall）。再认练得再熟，也不自动迁移成提取。
2. **流畅错觉。** 看到释义的瞬间「哦对，是这个意思」——这种流畅感被大脑记成「我会了」。点「记住了，下一个」正是把这个错觉固化下来的按钮。**你从来没有在不看答案的情况下成功过一次**，所以下次也没有可提取的东西。
3. **单次、单语境编码。** 一个词只在一种句子里见过一次，痕迹本来就弱；而且被那句特定的话绑死（编码特异性）。换个句子就提取不出来，表现就是「见过，但想不起来」。
4. **没有失败后的修复。** 失败本身不是问题——失败后的**纠正 + 再提取**才是学习发生的地方。现在这一步被一个按钮跳过了。

---

## 3. 证据：哪些杠杆真的有效，边界在哪

证据强度按「可重复性 × 与本场景的贴合度」粗分：强 / 中 / 弱 / 反向。

| 机制 | 证据 | 强度 | 边界与坑 | 在本插件里怎么用 |
|---|---|---|---|---|
| **提取练习**（testing effect） | 测验比重读更能带来延迟保持；延迟测验差距最大 [1][2] | 强 | 即时测验上重读常常更好看，别用当场表现判断效果 | 每次「忘了」必须包含一次真实提取，而不是看答案 |
| **失败后仍要提取**（unsuccessful retrieval） | 先猜错再看答案，比直接看答案记得更好 [3] | 强 | 需要**及时反馈**；猜完不给答案等于白猜 | 「忘了」第一步不是给释义，是强制猜一个义项 |
| **高信心错误纠正**（hypercorrection） | 越确信的错误，纠正后记得越牢 [4][5] | 强 | 一周后高信心错误会**回流**，必须再测一次 [6] | 让你先选「你以为是哪个意思」，再打脸；次日必须再判别一次 |
| **生成效应** | 自己产出的答案比读到的记得好 [7] | 强 | 产出太难会变成挫败；要给脚手架 | 完形填空、拼写、造句，而不是只点选项 |
| **自我参照** | 与自我相关的材料回忆更好，元分析支持 [8][9] | 强 | 需要真的相关，假「你」不算 | 用你的原句、你的工作场景、你上次选错的义项 |
| **编码特异性** | 提取线索与编码时匹配最有效 [10] | 强 | 只认原句会变成「只在这句里会」；要**换句复现** | 第一次用原句当线索，复现时换新句 |
| **间隔** | 分散练习优于集中 [11] | 强 | 间隔太长会忘光；FSRS 已在做 | 同会话内 2–4 张卡后复现，会话末再一次，次日再一次 |
| **情绪唤醒** | 唤醒增强**中心细节**的巩固，延迟测验更明显 [12][13] | 中 | 会窄化注意、损害边缘细节；**压力/皮质醇在提取阶段损害回忆** [14] | 唤醒绑在词义上（反差、场景），不绑在 App 的分数上 |
| **好奇 / 预测误差** | 好奇状态提升学习；预测误差驱动学习 [15] | 中 | 好奇要指向答案，不能指向无关花絮 | 先问「为什么一个词会有这两个相反的意思？」再揭晓 |
| **交错 / 判别** | 混合练习提升辨别力 | 中 | 初学阶段 block 更稳；你已经不是初学 | 次日做「这两句是同一个意思吗」 |
| **惩罚 / 扣分 / 断 streak** | 预期物质奖励削弱内在动机 [16]；威胁与焦虑损害提取 | 反向 | 会让用户**谎报**（按「记得」避免损失），污染唯一的排期信号 | 不用。代价用「不可回避的提取」来付 |
| **有趣但无关的细节** | seductive details 降低对目标内容的学习 [17] | 反向 | 「好玩」不等于「记得住」 | 趣味必须解释这个词，不能是段子 |

### 3.1 情绪那一条，要非常小心地用

「让大脑皮层兴奋」在神经科学上对应的是**唤醒（arousal）**，它通过杏仁核—海马通路增强**巩固**，尤其在一段时间延迟后更明显 [12][13]。但它有三个已知边界：

- **窄化注意**：唤醒让你记住「中心细节」，同时损害「边缘细节」[12]。如果唤醒来自 App（红闪、警报、倒计时），中心细节是 App，不是单词。
- **只增强巩固，不保证编码**：当场更兴奋 ≠ 当场记得更牢；效果常常在延迟测验才出现。
- **压力损害提取**：皮质醇升高会损害长时记忆的提取 [14]。用「惩罚」制造压力，恰好作用在你最需要的那一步——想起来。

**可用的做法**：让唤醒来自**词义本身的反差**（「你一直以为是分辨率，其实是决心」）、来自**你自己的场景**（on-call、review、线上事故）。这是「热的內容 + 冷的界面」，不是「热的界面」。

### 3.2 惩罚那一条，会反噬

- 预期中的外部奖惩会削弱内在动机 [16]。背单词本来就是你自发要做的事，加一套扣分体系是在替换动机。
- 更致命的是**信号污染**：如果「忘了」有代价，最理性的策略是**别按忘了**。你会开始按「模糊」或「记得」来避免损失，FSRS 收到的是假数据，排期从此失效。这个 App 唯一的真值来源就是你诚实的那一下。
- 焦虑占用工作记忆，直接降低提取成功率（attentional control theory）。越怕忘，越提取不出来。

**所以「惩罚」要改成「代价」：代价不是痛感，是不可回避的工作量。** 你不能跳过提取，但忘记本身不被定罪。

### 3.3 兴趣那一条，容易跑偏

Mayer 团队的 seductive details 研究结论很稳定：**有趣但与目标无关的细节，会降低对目标内容的学习** [17]。所以「多加段子、多加梗图」通常会让成绩更差。

有效的「有趣」只有三种：

1. **反差**：与你已有理解冲突的事实（高信心错误被打脸）。
2. **自指**：关于你、你的句子、你的项目。
3. **解释性洞见**：词源/多义网络**解释了**为什么一个词会有这些意思（不是「冷知识」，是「原来如此」）。

第三种对你尤其重要：你的问题不是记不住拼写，是**一个词被钉死在一个义项上**。词源恰好能把多个义项连成一张网——`charge` 的核心隐喻是 **load（装载）**：装载费用→收费，装载罪责→指控，装载电量→充电，装载责任→负责 [18]。这张网一旦建立，五个义项不再需要死记。

---

## 4. 设计：补记循环（Repair Loop）

### 4.1 目标

把一次「忘了」从 **3 秒的展示** 变成 **40–90 秒的修复**，且这 90 秒里至少有：

- 1 次带反馈的失败提取（猜义项）
- 1 次反差（预测误差）
- 1 次成功的产出（完形/拼写）
- 1 次换句复现（同会话）
- 1 次会话末复现
- 1 次次日判别

### 4.2 状态机

```
                    ┌──────────────────────────────────────────────┐
                    │  assess: 看到词，自评                          │
                    │  忘了 ─────────────────────────────┐          │
                    │  模糊 → 提示 → 想起来? ──否──┐      │          │
                    │  记得 → 选择题 ──────────────┼──────┼──→ 正常结算 │
                    └──────────────────────────────┼──────┘          │
                                                   ▼                 │
   ┌───────────────────────────────────────────────────────────┐    │
   │ R0 commit   不给答案。原句挖空 + 4 个义项（含"你上次以为的"） │    │
   │             必须选一个（"完全不记得"也算一次猜测）           │    │
   └───────────────────────────┬───────────────────────────────┘    │
                               ▼                                    │
   ┌───────────────────────────────────────────────────────────┐    │
   │ R1 contrast 你选 X / 本句是 Y / 一句话说明为什么容易混       │    │
   │             义项地图：这个词你已知 1 个，还有 3 个            │    │
   └───────────────────────────┬───────────────────────────────┘    │
                               ▼                                    │
   ┌───────────────────────────────────────────────────────────┐    │
   │ R2 produce  原句完形：把词拼出来（首字母→音标→逐字母 三级提示）│    │
   │             必须正确一次才能离开                              │    │
   └───────────────────────────┬───────────────────────────────┘    │
                               ▼                                    │
   ┌───────────────────────────────────────────────────────────┐    │
   │ R3 recheck  插到 2–4 张卡之后：换一句新句，再选一次义项       │    │
   │             对 → 清债；错 → 回 R2（同会话最多 2 轮）           │    │
   └───────────────────────────┬───────────────────────────────┘    │
                               ▼                                    │
   ┌───────────────────────────────────────────────────────────┐    │
   │ R4 session-end  本轮结束：今日所有"忘了"的词各一道完形        │    │
   └───────────────────────────┬───────────────────────────────┘    │
                               ▼                                    │
   ┌───────────────────────────────────────────────────────────┐    │
   │ R5 tomorrow   次日队列头部：换句 + "这两句同一个意思吗"判别    │    │
   └───────────────────────────────────────────────────────────┘    │
```

### 4.3 每一阶段的界面与文案

#### R0 commit（不许看答案）

```
┌──────────────────────────────────────────────┐
│  resolution                    /ˌrezəˈluːʃn/  │
│                                              │
│  After the third outage this week, she made  │
│  a ______ to stop deploying on Fridays.      │
│                                              │
│  这句话里，resolution 是什么意思？             │
│                                              │
│  ○ 分辨率      ○ 决心；决定                   │
│  ○ 解决方案    ○ 解析度                       │
│                                              │
│              [ 完全不记得 ]                   │
└──────────────────────────────────────────────┘
```

要点：

- **四个选项全部来自这个词自己的义项**（`splitSenses` 已经能拆），不是别的词的释义。这才是义项判别。
- 「完全不记得」也是一个合法答案，记为 `guess=null`——**不惩罚诚实**。
- 选项顺序随机；「你上次选错的那个」永远在选项里（高信心错误的复发点）。

#### R1 contrast（打脸要准）

```
┌──────────────────────────────────────────────┐
│  你选的是「分辨率」。                          │
│  这句话里是「决心；决定」。                    │
│                                              │
│  为什么容易混：技术文本里 resolution 几乎只    │
│  以「分辨率」出现，这条路径被反复加固了。       │
│                                              │
│  这个词你认识 1 / 4 个义项：                   │
│  ● 分辨率（你熟的）  ○ 决心  ○ 决议  ○ 解析    │
│                                              │
│              [ 继续 ]                         │
└──────────────────────────────────────────────┘
```

要点：

- 这个节拍是**整个流程的情绪中心**：意外 + 具体 + 与自己有关。不需要任何音效。
- 「为什么容易混」必须具体到你的处境（技术语境），不能是泛泛的「多义词」。
- 义项地图用 `words.known_senses`（表里已有这个字段，目前没被用起来）。

#### R2 produce（必须产出一次）

```
┌──────────────────────────────────────────────┐
│  After the third outage this week, she made  │
│  a r________ to stop deploying on Fridays.   │
│                                              │
│  [ 输入完整单词 ]                              │
│  提示：首字母 → 音标 → 逐字母（每次提示降一档） │
└──────────────────────────────────────────────┘
```

要点：

- 认得出线（receptive）到这里是**拼写**；写得出线（productive）本来就是拼写，可换成「用这个词说一件你工作里的事」。
- 提示是三级降档，不是直接给答案。**允许失败两次**，第三次给答案并要求抄写一遍。
- 这一阶段结束才算「离开这张卡」。

#### R3 recheck（同会话换句复现）

插入位置：当前卡之后第 2–4 张。新句子由 LLM 生成（或从 `contexts` 里取另一句），挖空 + 选义项。

- 对 → 清债，回到正常队列。
- 错 → 回 R2，最多 2 轮；仍错则保留债到会话末（不挂起、不羞辱）。

#### R4 session-end（会话末复现）

一轮结束时：

```
今日补记  3 / 7
┌──────────────────────────────────────────────┐
│  The battery ______ in 30 minutes.           │
│  [ 输入 ]                                     │
└──────────────────────────────────────────────┘
```

7 个词、每个 5 秒、一次过。这是同日的第二次间隔提取，成本很低，收益很高。

#### R5 tomorrow（次日判别）

次日队列头部，题目换成**判别**而不是回忆：

```
┌──────────────────────────────────────────────┐
│  A: she made a resolution to stop deploying   │
│  B: the image has a resolution of 4K          │
│                                              │
│  这两句里的 resolution 是同一个意思吗？        │
│  [ 相同 ]   [ 不同 ]                          │
│  不同的话，各自是什么意思？                    │
└──────────────────────────────────────────────┘
```

判别比回忆更难，正好是「desirable difficulty」；而且它直接训练你真正缺的能力——**在语境里区分义项**。

### 4.4 评分语义：补记循环不能污染 FSRS

这是整个设计里最容易做错的一处。

- **FSRS 的评级只反映「第一次无提示提取」的结果。** 按「忘了」→ 立刻记 Again(1)，并且**之后不再改**。
- 补记循环里的成功/失败写入独立表 `repair_log`，**不写回 `cards`**。它的用途是选内容、算指标、判断这个词该不该进「顽固词」清单。
- 如果你在补记 3 次成功之后评「记得」，FSRS 会以为这个词很稳，把间隔拉长——下次真忘得更惨。**别用「刚才练会了」骗排期器。**

FSRS 自己的 relearning 步进（Again 后约 10 分钟）继续照常工作；补记循环是它之外的同会话加练，两者不冲突。

### 4.5 代价机制：债，不是分

- 每个「忘了」的词生成 1 笔**补记债**，清债条件 = R3 成功 + R4 成功（次日 R5 失败则重新计债）。
- 顶部常驻一个很小的指示器：`补记 3/7`。它不闪、不红、不扣分。
- **不能跳过**：R2 没成功之前，「下一个」按钮不出现。这是唯一的「惩罚」——响应代价（response cost）。
- **不做的后果**是这句话明天再说一遍，而不是丢分。忘记不被定罪，跳过才要补。

### 4.6 时长与放弃率

- 单张补记卡上限 90 秒；超时降级为「看答案 + 抄写一遍」，债保留到会话末。
- 每日补记债上限 10 笔；超出的自动顺延到明天（防积压优先于完美修复）。
- 连续 3 次在补记里也失败的词 → 进「顽固词」清单，要求你**自己造一个句子**才能解封。这是产出，不是惩罚。

---

## 5. 内容引擎：senseMeta

现在的 `word_meta` 是**词级**的（词根、记忆法、易混淆词、干扰项）。补记循环需要**义项级**的内容，新增 `sense_meta`。

### 5.1 数据结构

```json
{
  "word": "resolution",
  "sense_key": "n. 决心；决定",
  "sense_here": "决心；决定",
  "likely_assumed": "分辨率",
  "why_confusable": "技术文本里几乎只出现『分辨率』，这条路径被反复加固。",
  "contrast": "你以为是分辨率，这句里是决心。",
  "personal_example": "After the third outage this week, she made a resolution to stop deploying on Fridays.",
  "cloze": "After the third outage this week, she made a ______ to stop deploying on Fridays.",
  "other_sense": {
    "sentence": "The image has a resolution of 4K.",
    "gloss": "分辨率"
  },
  "etymology_note": "re-（再）+ solvere（松开）→ 把结解开：解开图像 → 解析度；解开犹豫 → 决心。",
  "micro_question": "为什么『下决心』和『分辨率』会是同一个词？",
  "confidence": "high"
}
```

### 5.2 生成 prompt（要点）

```
你在为一个中国开发者做「义项修复卡」。他只在这个词的一个义项上见过它，
现在在另一个义项上卡住了。

给定：word、这句话、这个词的全部义项（ECDICT）、他的职业背景（AI/后端开发）。
输出严格 JSON，字段见 schema。

硬约束：
1. sense_here 必须来自给定的义项列表，不许自己造。
2. likely_assumed 是他最可能误认的那个义项；必须和 sense_here 不同。
3. why_confusable 用一句话说明"为什么他会这么以为"，必须提到技术语境或中文译法。
4. personal_example 8–20 词，必须包含原词（可变形），必须是软件/工程场景，
   必须让目标义项在句子里**无歧义**，不许出现真实人名/公司名。
5. cloze 是 personal_example 把目标词挖空，其余逐字不变。
6. other_sense 用同一个词的**另一个**义项造一句，用于次日判别。
7. etymology_note 只在词源**能解释多义**时才写，否则空字符串。
   不许编造词源；不确定就留空。
8. 语气克制，不写段子，不写"老铁"这类词。有趣来自反差，不来自俏皮。
9. confidence: high 表示义项和例句你都确定；low 表示需要人工确认。
```

### 5.3 质量闸门（落库前）

- `personal_example` 不含目标词 → 丢弃重试一次，再失败降级到 ECDICT 例句。
- `sense_here` 不在义项列表里 → 丢弃。
- `other_sense.sentence` 与 `personal_example` 义项相同 → 丢弃。
- 例句长度 > 24 词或含专有名词 → 降级。
- `etymology_note` 非空但 `confidence != high` → 清空（宁可没有，不可编造）。
- 所有字段落库时带 `model` 与 `created_at`，方便回滚与对比。

### 5.4 三个已经验证好用的示例

| 词 | 他以为 | 本句义 | 词源网（解释多义） |
|---|---|---|---|
| `resolution` | 分辨率 | 决心 | re- + solvere「松开」：解开图像=解析度，解开犹豫=决心，解开争议=决议 |
| `charge` | 收费 | 充电 | 拉丁 carrus「车」→ 装载：装费用=收费，装罪责=指控，装电=充电，装责任=负责 |
| `latent` | 潜空间（名词） | 潜在的（形容词） | 拉丁 latere「隐藏」：latent 是「隐而未现的」，`latent space` 整体译作「潜空间」 |

第三条尤其值得注意：`latent` 的问题不是词义，是**词性**。你把一个形容词当成了名词短语的一部分。这类错误靠「看释义」永远修不好，只能靠「在句子里判断它修饰谁」。

---

## 6. 任务阶梯：同一个词，越练越难

不要每次都用同一种题。按「提取难度」排梯子，每成功一次上一级：

| 轮次 | 时间 | 题型 | 练什么 |
|---|---|---|---|
| 1 | 当场 | 猜义项 → 反差 → 完形 | 预测误差 + 产出 |
| 2 | 同会话 2–4 张后 | 换句挖空，选义项 | 迁移到新语境 |
| 3 | 会话末 | 换句完形（拼写） | 形式—意义绑定 |
| 4 | 次日 | 两句判别「同义/不同义」 | 义项分辨 |
| 5 | 3 天后 | 造句：用这个词说一件你工作里的事 | 产出性使用 |
| 6 | 之后 | 阅读中自然复现（正文标注 P3） | 真实迁移 |

这张表同时是「desirable difficulty」的落地：难度递增，但每一级都在能力边缘（成功率约 70–90%）。

---

## 7. 数据与代码改动

### 7.1 表

```sql
-- 义项级内容（LLM 生成，按 word+sense 缓存）
CREATE TABLE IF NOT EXISTS sense_meta (
  id         INTEGER PRIMARY KEY,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_key  TEXT NOT NULL,
  json       TEXT NOT NULL,
  model      TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(word_id, sense_key)
);

-- 补记事件（不参与 FSRS 排期）
CREATE TABLE IF NOT EXISTS repair_log (
  id          INTEGER PRIMARY KEY,
  word_id     INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  card_id     INTEGER,
  stage       TEXT NOT NULL,      -- commit|contrast|produce|recheck|session_end|tomorrow
  ok          INTEGER,            -- 0/1，commit 阶段为 NULL
  guess_sense TEXT DEFAULT '',    -- 他选了什么（R0）
  hint_level  INTEGER DEFAULT 0,  -- 用了几级提示
  elapsed_ms  INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 债：每个"忘了"一笔
CREATE TABLE IF NOT EXISTS repair_debt (
  word_id    INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
  card_id    INTEGER,
  track      TEXT NOT NULL,
  opened_at  INTEGER NOT NULL,
  cleared_at INTEGER,
  tries      INTEGER DEFAULT 0
);
```

### 7.2 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-word-learn/repair?cardId=` | 取这个词的补记数据：原句、义项列表、sense_meta（缺则同步生成）、债状态 |
| POST | `/dsh-word-learn/repair/answer` | 提交 R0/R3/R5 的选择或填空，返回对错与反馈 |
| POST | `/dsh-word-learn/repair/clear` | 清债（R3+R4 都成功时） |
| GET | `/dsh-word-learn/sense-map?word=` | 义项地图：已知/半熟/未接触，附每条的例句 |
| GET | `/dsh-word-learn/metrics/retention` | 只读指标（见 §8） |

### 7.3 队列

`dueQueue()` 要把原句带出来：

```sql
LEFT JOIN (
  SELECT word_id, sentence,
         ROW_NUMBER() OVER (PARTITION BY word_id ORDER BY created_at DESC) AS rn
    FROM contexts
) ctx ON ctx.word_id = c.word_id AND ctx.rn = 1
```

并在 `out.push` 里加 `sentence`、`senseMeta`（懒加载，没有就 null）。

### 7.4 前端

`StudyView` 的状态机加 `commit | contrast | produce | recheck` 四个 phase；`forgot` 直接走 `commit`，不再渲染 `meaningBlock`。

关键改动点：

- `handleBranch('forgot')`：不 `setPhase('forgot')`，改为 `setPhase('commit')` + `loadRepair()`。
- `forgotNext` 删除。R2 成功后才调用 `onRate(1)`。
- `MemoryHints` 保留，但只在 R1 之后作为「补充」，不再当主菜。
- 队列渲染加「补记债」指示与插入逻辑（R3 插在第 2–4 张之后）。

### 7.5 评分

`applyGrade` 不动。补记写 `repair_log` / `repair_debt`，**不调用 `applyGrade`**。

---

## 8. 度量：怎么知道它真的有用

### 8.1 主指标

**p7_forgot_retention**：首次评 Again 之后，下一次间隔 ≥ 3 天的复习里评 ≥ 3 的比例。

```sql
WITH first_again AS (
  SELECT card_id, MIN(created_at) AS t0
  FROM review_log
  WHERE rating = 1 AND evidence = 'answer'
  GROUP BY card_id
),
nxt AS (
  SELECT fa.card_id, fa.t0,
         (SELECT r.rating FROM review_log r
           WHERE r.card_id = fa.card_id
             AND r.created_at > fa.t0 + 3*86400000
           ORDER BY r.created_at LIMIT 1) AS next_rating
  FROM first_again fa
)
SELECT COUNT(*) AS n,
       ROUND(AVG(CASE WHEN next_rating >= 3 THEN 1.0 ELSE 0 END), 3) AS p7
FROM nxt
WHERE next_rating IS NOT NULL;
```

### 8.2 副指标

| 指标 | 口径 | 看什么 |
|---|---|---|
| 补记完成率 | `cleared_at` 非空 / `opened_at` 当日总数 | 流程是否太重 |
| 补记内二次失败率 | `repair_log.stage='recheck' AND ok=0` / 全部 recheck | 难度是否过高 |
| 自评分布偏移 | `rating=3/4` 占比 | 加代价后是否开始谎报（应基本不变） |
| 会话放弃率 | 开始但未完成的比例 | 90 秒是否太长 |
| 词均耗时 | `repair_log.elapsed_ms` 合计 | 成本是否可接受 |

### 8.3 实验设计

n=1，只能做**词级随机对照**：

- 按 `ABS(word_id * 2654435761) % 2` 分两臂：A 走旧流程，B 走补记循环。
- 同一用户、同一时期、同一词频档位，减少混淆。
- 每臂至少 100 次「忘了」事件再看 p7；提前看会骗自己。
- 预注册判据：**B 的 p7 至少高 10 个百分点，且补记完成率 > 60%、会话放弃率不超过基线 +5pp**。达不到就回滚，不要「感觉变好了」。

---

## 9. 风险与反模式

| 风险 | 表现 | 对策 |
|---|---|---|
| 循环太长 | 一次忘了要 90 秒，做 20 个词就崩 | 90 秒硬上限；每日债上限 10；超时降级为抄写 |
| LLM 编词源 | 「charge 来自古英语 ceorl」这种 | 词源非 high confidence 一律留空；只允许「能解释多义」时使用 |
| LLM 例句歧义 | 一句话里目标义项说不清 | 质量闸门 + 人工抽检 + 失败降级到 ECDICT 例句 |
| 评分污染 | 补记成功后评「记得」，FSRS 高估 | 只评首次；补记写独立表 |
| 焦虑上升 | 开始躲「忘了」按钮 | 无倒计时、无扣分、无排行；「完全不记得」是合法答案 |
| 兴趣变噪音 | 段子比词义多 | 相关性闸门：每条附加内容必须回答「它解释了哪个义项」 |
| 只认原句 | 换个句子就不会 | R3/R5 强制换句；原句只在 R0/R2 用一次 |

### 明确不做

- ❌ 扣分、掉血、断 streak、排行榜。
- ❌ 红闪、警报音、震动惩罚。
- ❌ 「再错就挂起」的威胁式文案（leech 已经存在，作为机制安静工作即可）。
- ❌ 与词义无关的梗图、段子、彩蛋。

---

## 10. 落地顺序

### P0（半天，先止血）✅ 2026-11-04 已落地

1. 「忘了」不再直接展示释义：先自由回忆（写中文），再对照释义和原句。
   **偏差**：原计划是「原句挖空 + 4 个本词义项」，但「这句用的是哪个义项」需要 LLM 判定
   （P1 的 `senseMeta`）。P0 改成自由回忆 + 拼写，零模型依赖，且提取难度更高。
2. R1 对照 + R2 拼写，拼对后才允许 `onRate(1)`；评级仍是 Again(1)。
3. 队列项带 `sentence`（`dueQueue` 相关子查询取 `contexts` 最新一句）。
4. 验收：按「忘了」后，不完成一次正确拼写就出不去；`review_log` 里 Again 数量不变。
   （用户实测待做；原句缺失时降级为「看中文拼写」。）

### P1（1–2 天，把循环闭合）✅ 2026-11-04 已落地（R3 除外）

5. `sense_meta` + `analyzeSense()` + `repair_log` / `repair_debt` —— 已在
   `lib/ai-enrich.mjs` / `lib/store.mjs` 实现；义项材料由后台串行队列生成，
   归一化闸门见 `normalizeSenseMeta()`。
6. R3 同会话复现（插入队列第 2–4 张）—— **未做**。当前用 R4 会话末补记替代；
   R3 会让同一张卡在队列里出现两次，与"一架卡只评一次"的游标模型冲突，留到 P2 重做队列。
7. R4 会话末补记页 —— 已实现 `RepairPass`：今天评过 Again 的词再拼一次，
   拼对调 `/repair/clear` 清债；`/grade` 在 Again 时开债。
8. 验收：今日 7 个忘了的词，会话末全部复现一次；补记完成率 > 60%。
   （用户实测待做；`GET /repair/stats` 与统计页面板给出首猜命中率、拼写通过率、债清偿数。）

### P2（2–3 天，让它变聪明）

9. R5 次日判别 + 任务阶梯。
10. 义项地图（`known_senses` 真正用起来）。
11. `/metrics/retention` + 词级 A/B。
12. 验收：p7 相对基线 +10pp，或明确证伪后回滚。

---

## 11. 参考资料

一手文献（按文中编号）：

1. Roediger, H. L., & Karpicke, J. D. (2006). Test-enhanced learning: Taking memory tests improves long-term retention. *Psychological Science*, 17(3), 249–255.
2. Dunlosky, J., Rawson, K. A., Marsh, E. J., Nathan, M. J., & Willingham, D. T. (2013). Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest*, 14(1), 4–58.
3. Kornell, N., Hays, M. J., & Bjork, R. A. (2009). Unsuccessful retrieval attempts enhance subsequent learning. *JEP: Learning, Memory, and Cognition*, 35(4), 989–998.
4. Butterfield, B., & Metcalfe, J. (2001). Errors committed with high confidence are hypercorrected. *JEP: LMC*, 27(6), 1491–1494. https://doi.org/10.1037/0278-7393.27.6.1491
5. Metcalfe, J. (2017). Learning from errors. *Annual Review of Psychology*, 68, 465–489. https://doi.org/10.1146/annurev-psych-010416-044022
6. Butler, A. C., Fazio, L. K., & Marsh, E. J. (2011). The hypercorrection effect persists over a week, but high-confidence errors return. *Psychonomic Bulletin & Review*, 18(6), 1238–1244. https://doi.org/10.3758/s13423-011-0173-y
7. Slamecka, N. J., & Graf, P. (1978). The generation effect: Delineation of a phenomenon. *JEP: Human Learning and Memory*, 4(6), 592–604.
8. Rogers, T. B., Kuiper, N. A., & Kirker, W. S. (1977). Self-reference and the encoding of personal information. *JPSP*, 35(9), 677–688.
9. Symons, C. S., & Johnson, B. T. (1997). The self-reference effect in memory: A meta-analysis. *Psychological Bulletin*, 121(3), 371–394.
10. Tulving, E., & Thomson, D. M. (1973). Encoding specificity and retrieval processes in episodic memory. *Psychological Review*, 80(5), 352–373.
11. Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). Distributed practice in verbal recall tasks: A review and quantitative synthesis. *Psychological Bulletin*, 132(3), 354–380.
12. McGaugh, J. L. (2004). The amygdala modulates the consolidation of memories of emotionally arousing experiences. *Annual Review of Neuroscience*, 27, 1–28.
13. Cahill, L., & McGaugh, J. L. (1998). Mechanisms of emotional arousal and lasting declarative memory. *Trends in Neurosciences*, 21(7), 294–299.
14. de Quervain, D. J.-F., Roozendaal, B., Nitsch, R. M., McGaugh, J. L., & Hock, C. (2000). Acute cortisone administration impairs retrieval of long-term declarative memory in humans. *Nature Neuroscience*, 3(4), 313–314.
15. Gruber, M. J., Gelman, B. D., & Ranganath, C. (2014). States of curiosity modulate hippocampus-dependent learning via the dopaminergic circuit. *Neuron*, 84(2), 486–496.
16. Deci, E. L., Koestner, R., & Ryan, R. M. (1999). A meta-analytic review of experiments examining the effects of extrinsic rewards on intrinsic motivation. *Psychological Bulletin*, 125(6), 627–668.
17. Harp, S. F., & Mayer, R. E. (1998). How seductive details do their damage: A theory of cognitive interest in science learning. *Journal of Educational Psychology*, 90(3), 414–434.
18. 词源说明（charge / resolution / latent）：Online Etymology Dictionary，https://www.etymonline.com/word/charge

二手条目（便于快速核对）：

- Testing effect — https://en.wikipedia.org/wiki/Testing_effect
- Hypercorrection (psychology) — https://en.wikipedia.org/wiki/Hypercorrection_(psychology)
- Self-reference effect — https://en.wikipedia.org/wiki/Self-reference_effect
- Emotion and memory — https://en.wikipedia.org/wiki/Emotion_and_memory
- Desirable difficulty — https://en.wikipedia.org/wiki/Desirable_difficulty

> 说明：第 1–17 条按作者—年份—期刊列出，未逐条抓取全文；其中 hypercorrection 三条的 DOI 与结论取自英文维基条目所引原文，其余为领域内标准引用。第 18 条词源属常识性考证，落库前仍应人工确认。
