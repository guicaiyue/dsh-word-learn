# 提示词模板：改前端（划词卡 / 学习页 / 内联标注）

## 适用场景

要改页面上看得见的东西：{{目标，例如"划词卡片加一个'再听一遍'按钮"}}。
先判断改哪一半，选错文件会白改：

| 要改的东西                            | 文件                  | 生效方式                                                      |
| ------------------------------------- | --------------------- | ------------------------------------------------------------- |
| 划词卡片、选区判定、浮层样式          | `assets/wordcard.js`  | 硬刷新页面（按 mtime 重读）                                   |
| 划词纯判定（生效/排除范围、语音降级） | `assets/core.js`      | 硬刷新页面（mtime 重读）                                      |
| 学习页四个视图、侧栏入口、客户端文案  | `assets/dashboard.js` | **重新激活插件**（改 `cordis.patch.yml` 触发 HMR 或重启宿主） |
| 对话内联标注、悬停小卡                | `assets/annotate.js`  | 硬刷新页面（no-store）                                        |

## 先读什么（别跳）

| 文件                  | 行区                                                       | 为什么                                               |
| --------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| 目标文件头注释        | 1–45                                                       | 四个页面侧脚本各自写了它为什么是这个形态             |
| `assets/wordcard.js`  | 21–47 取用 `window.__dwlCore` + `API` 常量表               | 判定逻辑已搬到 core.js，这里只消费                   |
| `assets/core.js`      | 33–50 `SCOPE_SELECTOR`/`EXCLUDED_SELECTOR`；132–144 导出面 | 划词生效范围/排除范围的唯一实现；改它必跑 test-scope |
| `assets/annotate.js`  | 24–60 `CONFIG`                                             | 排除规则、流式保护、限额都集中在这里                 |
| `assets/dashboard.js` | 78–114 NS/API/TABS；4362–4436 `DICT` 与 `__test__`         | 侧栏 id 必须与面板 key 一致；locale 必须先注册       |
| `DESIGN.md`           | §9 风险 13（主题令牌）·680–710                             | 颜色只能从这张表取，别凭感觉填                       |
| `CONVENTIONS.md`      | §2.2 主题令牌、§7 前端约定                                 | `dwl-` 前缀、aria、不碰页面 DOM                      |

## 步骤

1. **确认作用范围没变**：划词只认 `[data-chat-flow]`；标注只在该根内动，
   排除代码块/行内代码/文件名/URL/链接/流式内容/折叠内容/其它插件弹窗。改判定要同步跑测试。
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
- `dashboard.js` 预算是 3900 代码行（现 3728），新加功能优先抽组件/抽函数，别继续往单文件堆。
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

改了哪一半：{{wordcard / dashboard / annotate}}，为什么是它

改动：
- {{文件}}:{{行区}} —— {{结构/样式/请求}}
- 颜色令牌：{{用了哪些，兜底值是什么}}

测试：{{test-scope / test-annotate 结果}}；pnpm verify → {{结果}}

生效方式：{{硬刷新 / 重新激活插件 / 重挂插件}}
真机确认：{{做了哪几步，看到什么}}

剩余风险：{{未覆盖的浏览态（折叠/流式/暗色/窄屏）/ 需人工确认的视觉}}
```
