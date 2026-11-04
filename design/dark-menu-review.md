# dsh-word-learn 菜单在暗色主题下的表现（实测）

> 对象：`assets/dashboard.js` 的顶部视图菜单（`.dwl-tabs` / `.dwl-tab`）、右侧「今日已复习 N 次」胶囊（`.dwl-pill`）、词表筛选 chips（`.dwl-chips`）、设置页原生 `select`，以及受同一套 token 影响的统计图（`.dwl-bars` / `.dwl-prog`）。
> 方法：真机 DSH Web（`http://127.0.0.1:3080/`，默认已是深色）+ Chrome 截图像素取样 + DSH 主题 token 推导（`@deepseek-ai/dsh-client-ui-theme`）。参考 `design_review`（Theming｜Light/Dark Contrast、Accessibility）与 `design_search`（深色配色令牌）。
> 日期：2026-11-04

## 一句话结论

**暗色下「读」没问题，「认」有问题。** 文字对比度全部达标（弱化文字 8.5:1，比浅色主题的 3.7:1 还好），但**区分状态与控件边界**全靠同一档"极淡的白色叠层"：选中态 1.15:1、hover 1.24:1、控件描边 1.74:1。同时因为 **DSH 的 `--dsw-alias-brand-primary` 在深色主题里就是近白色**，插件把它当强调色用，导致图表柱、进度条、「常用 8000」图例在暗底上变成刺眼的白色实心块。

## 实测数据（像素取样，非推算）

页面底 `#151517`，卡片底 `#232324`，选中底 `#222224`。

| 元素 | 实测颜色 | 对比度 | 判定 |
| --- | --- | --- | --- |
| 未选中 tab 文字 | `#ADB2B8` on `#151517` | **8.54:1** | ✅ 远超 4.5 |
| 选中 tab 文字 | `#F9FAFB` on `#222224` | **15.20:1** | ✅ |
| 选中 tab 底色 vs 页面底 | `#222224` vs `#151517` | **1.15:1** | ❌ 低于 3:1（状态指示） |
| hover 底色 vs 页面底 | `#28282A` vs `#151517` | **1.24:1** | ❌ hover 几乎看不出 |
| 控件描边（select / kbd / 次级按钮） | `rgba(255,255,255,.18)`→`#3F3F41` | **1.74:1**（对卡片 1.49） | ❌ 低于 3:1（唯一可点边界） |
| 卡片面 vs 页面底 | `#232324` vs `#151517` | **1.16:1** | ⚠️ 靠 1.74:1 描边才读得出来 |
| 今日胶囊文字 / 数字 | `#CFD3D6` / `#F59E0B` on `#222224` | 10.54:1 / 7.39:1 | ✅ |
| 图表柱 / 进度条白段 | `#D2D3D4`（brand 82% 透明） | **10.47:1**（对卡片） | ⚠️ 反了：数据被画成"占位块" |

对照（浅色主题，按 token 计算）：未选中 tab 文字 3.71:1（**低于 4.5**）、选中底 1.10:1。
→ **暗色比浅色更清楚**，两侧共同的短板是"层级/状态"而不是"文字"。

## 问题清单（按严重度）

### 1〔高〕筛选 chips / tab 的选中态只差 1.15:1
`background: var(--dwl-tint)`（深色 = `rgba(255,255,255,.055)`）。在 `#151517` 上合成出 `#222224`，几乎与背景同色；实际辨识完全依赖"文字变白 + 加粗"。低视力用户看到的是四个一样重的标签。

```css
/* 选中态补一条与文字同强度的指示条，不依赖颜色深浅 */
.dwl-tab{position:relative}
.dwl-tab[aria-selected="true"]::after{
  content:'';position:absolute;left:12px;right:12px;bottom:1px;height:2px;
  border-radius:2px;background:var(--dsw-alias-brand-primary)}
```
chips 同理：`.dwl-chip[aria-pressed="true"]` 加 `box-shadow:inset 0 0 0 1px var(--dsw-alias-label-primary)`。

### 2〔高〕控件描边 1.74:1，点击边界在暗底上读不出
`--dwl-btn-border: rgba(255,255,255,.18)`，且 select 背景是 `var(--dsw-alias-surface-primary)`——**这个 token 在 DSH 主题里不存在**，于是 select 实际是"全透明 + 一圈淡边"，形状全靠这圈 1.74:1 的线。

```css
body[data-ds-dark-theme] .dwl-page{--dwl-btn-border:rgba(255,255,255,.34)} /* 合成 ≈ 3.2:1 */
.dwl-settings-row select{background:var(--dsw-alias-bg-layer-1)}           /* 换掉不存在的 surface-primary */
```

### 3〔高〕`brand-primary` 在深色是白色 → 图表变成白色实心块
`--dsw-alias-brand-primary` 在 DSH 深色主题解析为 **`#F9FAFB`**（浅色主题是 `#0F1115`）。插件里 `var(--dsw-alias-brand-primary,#0d9488)` 的青色 fallback 永远不会命中，所以：
- `.dwl-bars i`（opacity .82）= 白色柱，`10.47:1`，视觉上像骨架屏占位块；
- `StackedProgress` 的「常用 8000」图例（第 99 行）取 brand → 进度条中间一大段纯白；
- 同一张图里「忘了/勉强/记得/太简单」用的是 state 色，反而清楚得多。

```js
// 第 99 行：别再拿 brand 当有彩色
{ key:'top8k', label:'常用 8000', color:'var(--dsw-alias-state-business-primary)' }
```
```css
.dwl-bars i{opacity:1}  /* 深色下 .82 的透明叠加没有必要，直接实色 */
```

### 4〔中〕ARIA tabs 只做了一半
`role="tablist"` + `role="tab"` + `aria-selected` 有了，但缺 `aria-controls`、面板缺 `role="tabpanel"`/`aria-labelledby`，也没有 ←/→ 键切换。屏幕阅读器读得到"标签页"却跳不到对应面板，键盘用户要按 4 次 Tab 逐个过。

### 5〔低〕吸顶栏没有分隔，滚动内容在栏下"硬切"
`.dwl-top` 用不透明 `--dsw-alias-bg-base`，与页面同色；滚动时卡片直接从栏底被切断。深色下阴影又不可见（`--dwl-shadow` 是纯黑），建议加一条 `border-bottom:1px solid var(--dsw-alias-border-l2)` 或 1px `rgba(255,255,255,.08)`。

### 附：尺寸
tab 实测 50×32px（`6px` 上下内边距 + 13px 字号）。满足 WCAG 2.5.8 的 24×24，但低于 44/48 的触控建议值——桌面端可接受，做成移动端同款时需放大。

## 做得对的地方

- 深色适配选择器用对了 `body[data-ds-dark-theme]`（实测在 `127.0.0.1:3080` 下命中），不是 `data-theme="dark"`；
- 未选中 tab 用 `label-tertiary` 而非"浅色主题的灰"——这正是 `design_review` 里 Theming/Light-Dark Contrast 要求的做法，暗色侧因此拿到 8.54:1；
- 聚焦环 `outline:2px solid brand` 在深色下解析为白色 2px，对比 17.45:1，可见性没问题；
- 禁用态、错误态用 `state-*` 语义令牌，没有逐屏硬编码。

## 改动顺序建议

1. 第 3 条（图表白色块）——视觉冲击最大，改 1 行颜色；
2. 第 2 条（描边 3:1）——影响所有次级控件；
3. 第 1 条（选中态指示条）——菜单本身；
4. 第 4 条（ARIA 补全）——一次改完，配键盘 ←/→。

## 补充（2026-11-04 11:20）：弹窗里的白底白字 —— 已修并复验

用户实测反馈：词汇详情弹窗（`.dwl-modal`）里「重新分析全部」整块白色、字看不见。复现确认是同一类问题里最严重的一档：

**成因**：`background: var(--dsw-alias-brand-primary)` + `color: #fff`。深色主题下 brand = `#F9FAFB`，于是白底白字，实测 **1.02:1**；标题旁的「AI 生成」胶囊（`.dwl-ai-pill`）同样中招。

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `.dwl-modal-actions button.primary` | `#fff` on `#F9FAFB` → **1.02:1** | `var(--dsw-alias-bg-base)` on `#F9FAFB` → **17.45:1** |
| `.dwl-ai-pill` | 同上 | 17.45:1 |
| `.dwl-action-row button.primary`（选择题页） | 同上 | 17.45:1 |

改法：把"反色文字"统一成 `var(--dsw-alias-bg-base)`（浅色主题下仍是白字，深色下自动变 `#151517`）。`.dwl-btn.primary` 本来就这么写，其余三处没跟上。

顺带修掉四个**在 DSH 主题里根本不存在**的 token（渲染时静默失效或走 fallback）：

| 错用 | 实际效果 | 改为 |
| --- | --- | --- |
| `--dsw-alias-surface-primary` | 未定义 → 透明/走 fallback #fff | `--dsw-alias-bg-layer-1`（弹窗）/ `bg-layer-2`（控件） |
| `--dsw-alias-surface-secondary` | 未定义 → 空态区块没有背景，弹窗里"没有 AI 分析数据"那块是平的 | `--dsw-alias-bg-layer-2`（实测 `#2C2C2E`，与弹窗 `#232324` 拉开层级） |
| `--dsw-alias-border-secondary` | 未定义 → `border` 整条声明失效，标签没边框 | `--dsw-alias-border-l2` |
| `--dsw-alias-state-danger-primary` | 未定义 → 走 fallback #e53935 | `--dsw-alias-state-error-primary` |

复验：`dark-modal-before.png` → `dark-modal-fixed.png`（按钮 17.45:1、空态区块有了底色、胶囊文字可读）。

**划词卡片（wordcard.js）静态核对**：它只用 brand 做文字强调（`--dwl-accent`）、底色用 `bg-overlay`，没有"brand 底 + 反色字"的填充按钮，因此不会出现同类白底白字；真实对话里划词的截图还没做。

## 证据图


- `design/shots/live/dark-live.png` — 学习页（菜单 + 胶囊）
- `design/shots/live/menu-zoom.png` — 菜单 5× 放大
- `design/shots/live/dark-vocab.png` / `chips-zoom.png` — 词表 chips
- `design/shots/live/dark-settings.png` / `select-zoom.png` — 设置页 select
- `design/shots/live/dark-stats.png` — 统计页（白色柱、白色进度段）
- `design/shots/live/dark-modal-before.png` / `dark-modal-fixed.png` — 词汇详情弹窗修复前后
- `design/shots/live/modal-buttons-zoom.png` — 修后按钮 4× 放大
- `design/shots/live/after-learn.png` / `after-stats.png` / `after-settings.png` — 第二轮改动后的三个视图
- `design/shots/live/menu-after-zoom.png` — 修后菜单（选中态指示条）
- `design/shots/live/wordcard-zoom-before.png` / `wordcard-zoom-after.png` — 划词卡片真实划词，修复前后

## 第二轮（2026-11-04 11:40，用户确认后）：三处结构性修正 + 划词卡片实测

### 1. 图表不再是白色块 —— 改用插件自己的强调色

DSH 的 `--dsw-alias-brand-primary` 在深色是 `#F9FAFB`、浅色是 `#0F1115`，本质是**单色**，不能当有彩色用。新增插件自己的强调色变量：

| | 浅色 | 深色 |
| --- | --- | --- |
| `--dwl-accent` | `#0d9488` | `#2dd4bf` |

`.dwl-bars i`、`.dwl-abrow .hist i`、`TIERS` 里的「常用 8000」全部切到 `--dwl-accent`；柱子 opacity `.82 → .9`。
实测柱色 `#2CC2B0`，对卡片底 8.44:1 —— 是"数据"而不是"占位块"。

### 2. 控件描边 1.74:1 → 3.91:1

深色块里 `--dwl-btn-border: rgba(255,255,255,.18)` → `.34`。实测设置页 select 描边 `#747475`，对页面底 **3.91:1**；同时 select 的 `background` 从失效的 `surface-primary` 换成 `bg-layer-2`，控件从"全透明 + 一根淡线"变成"有面色 + 可读描边"。

### 3. 选中态：加一条与文字同强度的指示条

```css
.dwl-tab[aria-selected="true"]::after{content:"";position:absolute;left:12px;right:12px;
  bottom:1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.dwl-chip[aria-pressed="true"]{box-shadow:inset 0 0 0 1px var(--dsw-alias-label-primary)}
```
底色仍是 1.15:1，但状态不再只靠"底色深浅"——视觉上多了一条 17:1 的白线 / 一圈同色环。

### 4. 划词卡片（真实划词，不是静态核对了）

在会话里真实选中 `writableTenant` 触发卡片，暴露出两个真问题：

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 卡片底色 | `bg-overlay` → `#61666B`（中灰，比周围亮一档） | `bg-layer-3` → `#353638` |
| 「词典里没有这个词」 | `state-error-primary` #F25A5A on #61666B = **1.76:1** | `red-100` #FEE2E2 on #353638 = **9.90:1** |
| 标题文字 | 5.55:1 | **11.57:1** |
| 次要文字 | — | 5.67:1 |

之前"静态核对无同类白底白字"的结论没错，但**只核对 token 不够**——`bg-overlay` 在深色下是个中灰，把红字压到 1.76:1，只有真划一次才看得见。这条教训记在 Horon 节点 44。

