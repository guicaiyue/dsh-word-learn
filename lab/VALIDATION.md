# P5a 验证结果

日期：2026-10-29
环境：`lab/.venv`（Python 3.12），CPU 推理，模型全在 D 盘

---

## 一句话结论

**音素级反馈可用，但必须自己做对齐；错误表对中式典型错误命中 94%。**
瓶颈不在算法，在**模型对合成音的声学偏差**，这个只能靠真人录音来最终定论。

---

## 一、链路验证：通过

| 环节 | 结果 |
|---|---|
| espeak-ng + phonemizer | ✅ `hello developer` → `['həloʊ','dɪvələpɚ']` |
| OpenPronounce 导入 | ✅ 5 项检查全过 |
| ffmpeg | ✅ |
| wav2vec2-large-960h（315.5M 参数） | ✅ 离线加载 24.3s |
| wav2vec2-lv-60-espeak-cv-ft | ✅ 离线加载 |
| 端到端 `compare_audio_with_text` | ✅ 8/8 样本跑通，约 25s/词（CPU） |

模型共 4.8GB，全部在 `D:\dsh-cache\huggingface`。**C 盘全程未增长**（8.04 → 7.94 GB，
差额来自 venv 与日志，非模型）。

---

## 二、最重要的发现：它会「给低分但不说哪里错」

实测 `latent`：

```
转写      : LADENT
分数      : 56.67          <- 低分
errors    : []             <- 但一个错都不报！
expected_phones : [['l','eɪ','t','ə','n','t']]
heard_phones    : ['l','eɪ','d','ə','n','d']    <- 明明有两处 t→d
```

**根因**：它的词级阈值是 `edits/length >= 0.4` 或 `edits >= 2`，
而 `t`/`d` 是清浊对，它的**近音成本只算 0.5**，两处加起来正好够不着阈值。

于是 `errors` 为空 —— **用户看到 56.67 分，却不知道该改什么。**

`throughput`（56.67 分，errors 为空）、`measure` 同类现象。

> **结论：必须绕开它的词级判定，直接用 `expected_phones` / `heard_phones`
> 自己做 Levenshtein 对齐。** 这正是 `zh_errors.analyze()` 做的事。

---

## 三、错误表验证：最小对立对实验

### 为什么不用 espeak 的音素输入模式

第一版想用 `[[sINk]]` 直接喂音素制造错误。**实测这条路走不通**：

| 词 | 普通 TTS | 音素输入 |
|---|---|---|
| think | θɛŋk (90分) | tɪŋk (48分) |
| light | laɪt (100分) | laɪ (**丢了 t**) (36分) |
| sing | sɪŋ (100分) | sɪn (52分) |
| very | vɛɹi (100分) | vɛɹi (70分) |

音素模式绕过了同化/协同发音，**把标准发音都读坏了**，
它制造的"错误"混着合成伪影，测出的漏检无法归因。

### 改用最小对立对

合成**真实存在的错词**，声明期望为**目标词**。音频干净，错误确定已知。

### 结果

| 目标词 | 合成 | 期望检出 | 实际听到 | 检出 | 结果 |
|---|---|---|---|---|---|
| think | think | （对照） | θɛŋk | — | ✅ 正确未报 |
| very | very | （对照） | vɛɹi | — | ✅ 正确未报 |
| light | light | （对照） | laɪt | — | ✅ 正确未报 |
| sing | sing | （对照） | sɪŋ | — | ✅ 正确未报 |
| bad | bad | （对照） | bɛd | æ→ɛ | ⚠️ 误报 |
| think | sink | θ→s | sɪŋk | θ→s | ✅ 命中 |
| thin | fin | θ→f | fen | θ→f | ✅ 命中 |
| thin | tin | θ→t | tɪn | θ→t | ✅ 命中 |
| they | day | ð→d | de | ð→d | ✅ 命中 |
| vest | west | v→w | wɛst | v→w | ✅ 命中 |
| very | wery | v→w | wɛɹi | v→w | ✅ 命中 |
| light | right | l→ɹ | ɹaɪd | l→ɹ | ✅ 命中 |
| play | pray | l→ɹ | pɹeɪ | l→ɹ | ✅ 命中 |
| sing | sin | ŋ→n | sen | ŋ→n | ✅ 命中 |
| thing | thin | ŋ→n | fen | θ→f, ŋ→n | ✅ 命中 |
| sheep | ship | i→ɪ | ʃɪp | i→ɪ | ✅ 命中 |
| seat | sit | i→ɪ | **sed** | — | ❌ 漏检 |
| pull | pool | ʊ→u | puo | ʊ→u | ✅ 命中 |
| bad | bed | æ→ɛ | bɛd | æ→ɛ | ✅ 命中 |
| cold | coal | 词尾 d 脱落 | ko | l→(漏), d→(漏) | ✅ 命中 |
| desk | des | 词尾 k 脱落 | daɪ | s→(漏), k→(漏) | ✅ 命中 |

**实验组命中 15/16（94%）　对照组误报 1/5**

### 实验抓到的真 bug

第一轮只有 **81%（13/16）**，`light→right` 和 `play→pray` **都漏检**。

根因：错误表里写的是 ASCII `"r"`，而模型的 IPA 输出是 **`ɹ`（U+0279）**。
`("l","r")` 这条规则**永远不会命中**。

> 这恰恰是中国学习者最经典的错误之一（l/r 不分）。
> **如果没有这个对照实验，这个 bug 会一直带到线上。**

修复后 81% → 94%。

### 剩余 1 漏检 + 1 误报：都不是错误表的问题

```
seat(合成sit):  expected [s,i,t]   heard [s,e,d]
bad (对照)   :  expected [b,æ,d]   heard [b,ɛ,d]   score=86.67
```

- `seat`：模型把 `ɪ` 听成了 **`e`**，不是表里预期的 `ɪ`，规则无法匹配 → **声学混淆**
- `bad`：模型把标准 `æ` 听成 `ɛ` → **模型对合成音的固有偏差**

两者都是**模型的判断**，错误表只是忠实转述。

---

## 四、这说明了什么（重要）

1. **错误表可用**：θ/ð/v/l-r/ŋ/词尾脱落等中式高频错误，94% 能正确归类。

2. **合成音实验到此为止**。espeak 是"标准发音"，模型仍会把 `æ` 听成 `ɛ`。
   真人发音的声学特征远比合成音复杂，**合成音上的表现不能外推到真人**。

3. **必须做真人自测**（P5a 的真正目的）：
   - 录 30-50 个自己读的词
   - 看错误表报出的问题，**是不是我真实的问题**
   - 特别看：报出来的错，我承认吗？我真实读错的，它报了吗？

4. **`analyze.py` 已可日常使用**，用 `record.py` 录音后直接分析。

---

## 五、用法

```powershell
. 'D:\projects\blog\dsh-plugins\dsh-word-learn\lab\env.ps1'

# 录自己的音（3 秒）
lab\.venv\Scripts\python.exe lab\scripts\record.py thought

# 分析
lab\.venv\Scripts\python.exe lab\scripts\analyze.py lab\recordings\thought.wav thought

# 重跑最小对立对验证
lab\.venv\Scripts\python.exe lab\scripts\validate_minimal_pairs.py
```

---

## 六、性能与成本

| 项 | 实测 |
|---|---|
| 单次分析（CPU） | 首次 32s（含加载），之后 **0.7-1s** |
| 模型加载 | 约 25s（常驻进程内只付一次） |
| 磁盘 | 4.8GB（D 盘） |
| 内存 | 约 2-3GB（两个 315M 模型） |

> P5b 若做 sidecar，**必须常驻进程**（否则每次 25s 加载不可接受），
> 这也印证了设计文档里"独立进程 + 长驻"的选择。
