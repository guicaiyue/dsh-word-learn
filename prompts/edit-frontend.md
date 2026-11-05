# 提示词模板：改前端（划词卡 / 学习页 / 内联标注）

## 适用场景

要改页面上看得见的东西：{{目标，例如"划词卡片加一个'再听一遍'按钮"}}。
先判断改哪一半，选错文件会白改：

| 要改的东西                           | 文件                        | 生效方式                                                      |
| ------------------------------------ | --------------------------- | ------------------------------------------------------------- |
| 划词卡片装配、请求、状态机           | `assets/wordcard.js`        | 硬刷新页面（按 mtime 重读）                                   |
| 划词卡片视图（DOM/渲染/定位）        | `assets/wordcard-card.js`   | 硬刷新页面（同上）                                            |
| 划词卡片样式（CSS 字符串）           | `assets/wordcard-style.js`  | 硬刷新页面（同上）                                            |
| 划词纯判定 + 排除范围唯一来源        | `assets/core.js`            | 硬刷新页面（mtime 重读）                                      |
| 学习页纯逻辑/常量（无 React）        | `assets/dashboard-logic.js` | 硬刷新页面（同上；就绪前页面显示「正在加载」）                |
| 学习页样式（CSS 模板串）             | `assets/dashboard-style.js` | 硬刷新页面（同上）                                            |
| 学习页四个视图、侧栏入口、客户端文案 | `assets/dashboard.js`       | **重新激活插件**（改 `cordis.patch.yml` 触发 HMR 或重启宿主） |
| 对话内联标注、悬停小卡               | `assets/annotate.js`        | 硬刷新页面（no-store）                                        |

## 先读什么（别跳）

| 文件                        | 行区                                                       | 为什么                                             |
| --------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| 目标文件头注释              | 1–45                                                       | 八个注入脚本各自写了它为什么是这个形态             |
| `assets/wordcard.js`        | 22–38 取 `window.__dwlCore`/`__dwlWordcardCard` + `API` 表 | 只做装配/请求/状态机，别在这里写判定或 DOM 构建    |
| `assets/wordcard-card.js`   | 11–30 无状态契约；`mount/render/place` 签名；464 导出      | 视图模块不注册事件、不持有状态；DOM 句柄调用方传入 |
| `assets/wordcard-style.js`  | 6–15 CSS 导出契约                                          | 只挂 `window.__dwlWordcardStyle` 字符串            |
| `assets/core.js`            | 45–80 `BLOCKED_ELEMENTS`/`blockedSelector`；164–176 导出面 | 排除范围唯一来源；改它必跑 test-scope              |
| `assets/annotate.js`        | 25–35 取 core、拿不到就跳过；`CONFIG` 在 31 起             | 标注只列本层特有排除项，别抄 core 的名单           |
| `assets/dashboard.js`       | 82–129 `assetOf`/`whenAssetsReady`；3526–3538 `__test__`   | 禁止模块期快照全局；侧栏 id 必须与面板 key 一致    |
| `assets/dashboard-logic.js` | 528–572 导出面；571 发 `dwl:assets-ready`                  | 纯逻辑/常量，无 React、不监听、不写样式            |
| `assets/dashboard-style.js` | 533–535 挂 CSS + 发就绪事件                                | 只导出字符串，别在这里写 DOM 逻辑                  |
| `DESIGN.md`                 | §9 风险 13（主题令牌）·680–710                             | 颜色只能从这张表取，别凭感觉填                     |
| `CONVENTIONS.md`            | §2.2 主题令牌、§7 前端约定                                 | `dwl-` 前缀、aria、不碰页面 DOM                    |

## 步骤

1. **确认作用范围没变**：划词只认 `[data-chat-flow]`；标注只在该根内动，
   排除代码块/行内代码/文件名/URL/链接/流式内容/折叠内容/其它插件弹窗。
   排除项名单只在 `assets/core.js` 的 `BLOCKED_ELEMENTS` 维护，标注层只列自己特有的项。改判定要同步跑测试。
2. **改 UI 结构**：类名一律 `dwl-` 前缀，选择器限定在自己的根节点下；不写全局选择器、
   不用 `!important` 盖宿主样式。可点元素用 `<button type="button">`，图标按钮给 `aria-label`，
   动态区域给 `aria-live="polite"`。
3. **改颜色**：只写 `var(--dsw-alias-xxx, 兜底值)`。不许判 `data-theme="dark"`，
   深色兜底选择器是 `body[data-ds-dark-theme]`；不许只监听 `matchMedia`。
4. **改请求**：路径走文件里的 `API` 常量表；失败分支要让界面画一行提示，不要静默无反应
   （交互路径服务端已经保证 `200 + ok:false`，前端要读 `ok:false` 的 `error`）。
5. **改文案**：`dashboard.js` 的标题走 `t('panel.title')`，键要同时加进 `DICT.zh` 与 `DICT.en`。
6. **跑测试与真机验证**（见下），并在交付说明里写清"怎么看到效果"。

## 硬约束

- 不许 `import`/`require`/`process`（`dashboard.js` 的 `require('react')` 是唯一例外）。
- 不许修改页面正文 DOM：卡片只追加自己的浮层（`position: fixed`），标注只包裹目标词节点。
- 不许写死颜色、不许判 `data-theme="dark"`、不许猜令牌值。
- 不许引入构建步骤、不加 npm 前端依赖（React 是加载器给的）。
- 不许碰其它插件的节点与弹窗；标注遇到就跳过。
- 拆分后的预算：`dashboard.js` 3000（现 2990）、`dashboard-style.js` 509（现 500）、
  `dashboard-logic.js` 默认 400（现 398）；`wordcard.js` 540（现 520）、`wordcard-card.js` 380、
  `wordcard-style.js` 141。新功能优先抽组件/抽函数，别把大文件再堆起来。
- 不许在模块工厂 / `apply()` 期快照 `window.__dwl*`：用 `assetOf()` 使用时读、`whenAssetsReady`
  等 `dwl:assets-ready` 后再渲染，未就绪渲染「正在加载」而不是崩页。
- 前端脚本的任何异常必须吞掉（带注释说明），划词/标注坏了不能拖垮页面。

## 必须执行的验证

```bash
node scripts/test-scope.mjs        # 改划词范围判定时必跑（vm 整文件加载 assets/core.js 求值）
node scripts/test-annotate.mjs     # 改标注层时必跑
node scripts/test-settings-ui.mjs  # 改设置页渲染分支时
pnpm lint:fix
pnpm format
pnpm verify
```

真机验证（README「开发」节有完整步骤）：

- 划词：左栏划一次应**不弹卡**，对话正文划一次应**弹卡**；
- 标注：展开折叠内容后才补标；流式生成中不标；
- 主题：明暗各切一次，颜色跟随、不重启；
- `dashboard.js` 改动后确认 `__DSH_BOOT__.entries` 里有 `dsh-word-learn`，用清单里的 `url` 取脚本。

## 交付输出模板

```text
目标：{{用户看到的变化}}

改了哪一半：{{wordcard / wordcard-card / wordcard-style / core / dashboard / dashboard-logic / dashboard-style / annotate}}，为什么是它

改动：
- {{文件}}:{{行区}} —— {{结构/样式/请求}}
- 颜色令牌：{{用了哪些，兜底值是什么}}

测试：{{test-scope / test-annotate 结果}}；pnpm verify → {{结果}}

生效方式：{{硬刷新 / 重新激活插件 / 重挂插件}}
真机确认：{{做了哪几步，看到什么}}

剩余风险：{{未覆盖的浏览态（折叠/流式/暗色/窄屏）/ 需人工确认的视觉}}
```
