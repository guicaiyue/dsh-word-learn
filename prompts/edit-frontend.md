# 提示词模板：改前端（划词卡 / 学习页 / 内联标注）

## 适用场景

要改页面上看得见的东西：{{目标，例如"划词卡片加一个'再听一遍'按钮"}}。
先判断改哪一块，选错文件会白改：

| 要改的东西                           | 文件                                                                    | 备注                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 划词卡片装配、请求、状态机           | `src/client/features/wordcard/index.js`                                 | `installWordcard()` 装监听/建卡、返回 dispose                                    |
| 划词卡片视图（DOM/渲染/定位）        | `src/client/features/wordcard/card.js`                                  | 不注册事件、不持有状态；DOM 句柄由 index.js 传入                                 |
| 划词卡片样式（CSS 字符串）           | `src/client/features/wordcard/style.js`                                 | 只导出 `CSS` 字符串，不碰 DOM                                                    |
| 划词/标注的范围判定与排除名单        | `src/client/features/core.js`                                           | 单一来源；改判定必跑 `tests/features/scope.test.mjs`                             |
| 学习页四个视图、侧栏入口、客户端文案 | `src/client/plugin.js`                                                  | React；`__test__` 是组件测试入口；`apply()` 在这里组装                           |
| 学习页纯逻辑 / 常量（无 React）      | `src/client/dashboard/logic.js`                                         | 不监听事件、不写样式；`plugin.js` import 后透传给视图                            |
| 学习页样式（CSS 模板串）             | `src/client/dashboard/styles.js`                                        | `export const CSS`；`apply()` 写进 `<style data-plugin>`                         |
| 对话内联标注、悬停小卡               | `src/client/features/annotate/`（`index.js`/`tokenize.js`/`config.js`） | `installAnnotate()` 装 observer/监听，返回 dispose；只在 `[data-chat-flow]` 内动 |

## 先读什么（别跳）

| 文件                                     | 位置（按符号搜）                                | 为什么                                           |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| 目标文件头注释                           | 文件头                                          | 模块为什是这个形态、踩过什么坑                   |
| `src/client/plugin.js`                   | `apply`（locale → slots → effects 的顺序）      | 注册顺序错一个，侧栏标题/面板就空                |
| `src/client/features/wordcard/index.js`  | `API` 常量表 + `installWordcard`                | 请求路径只在这里；装配与判定/视图分离            |
| `src/client/features/wordcard/card.js`   | 导出签名（mount/render/place）                  | 视图模块不注册事件、不持有状态                   |
| `src/client/features/core.js`            | `BLOCKED_ELEMENTS` / `blockedSelector` / 导出面 | 排除范围唯一来源；标注层与划词卡都消费它         |
| `src/client/features/annotate/config.js` | `CONFIG` 与 `mergeConfig`                       | 标注只列本层特有排除项，别抄 core 的名单         |
| `src/client/dashboard/logic.js`          | 导出面（`LOGIC` 被 `__test__` 暴露）            | 纯逻辑/常量，无 React、不监听、不写样式          |
| `DESIGN.md`                              | §9 风险 13（主题令牌）                          | 颜色只能从令牌表取，别凭感觉填                   |
| `CONVENTIONS.md`                         | §2.2 主题令牌、§7 前端约定                      | `dwl-` 前缀、aria、不碰页面 DOM、install/dispose |
| `tests/support/load-bundle.ts`           | 全文                                            | 组件测试怎么拿到真实产物里的组件（`__test__`）   |

## 步骤

1. **确认作用范围没变**：划词只认 `[data-chat-flow]`；标注只在该根内动，
   排除代码块/行内代码/文件名/URL/链接/流式内容/折叠内容/其它插件弹窗。
   排除项名单只在 `src/client/features/core.js` 维护。改判定要同步跑 `tests/features/scope.test.mjs`
   与 `tests/features/annotate.test.mjs`。
2. **改 UI 结构**：类名一律 `dwl-` 前缀，选择器限定在自己的根节点下；不写全局选择器、
   不用 `!important` 盖宿主样式。可点元素用 `<button type="button">`，图标按钮给 `aria-label`，
   动态区域给 `aria-live="polite"`；行内 `aria-label` 只放一行摘要，别把多行释义塞进去。
3. **改颜色**：只写 `var(--dsw-alias-xxx, 兜底值)`。不许判 `data-theme="dark"`，
   深色兜底选择器是 `body[data-ds-dark-theme]`；不许只监听 `matchMedia`。
4. **改请求**：路径走调用点的 `API` 常量表（见上表）；失败分支要让界面画一行提示，不要静默无反应
   （交互路径服务端已经保证 `200 + ok:false`，前端要读 `ok:false` 的 `error`）。
5. **改文案**：标题/侧栏文案走 `src/client/plugin.js` 的 `DICT`，键要同时加进 `DICT.zh` 与 `DICT.en`；
   包级 `meta.*` 在 `locale/{zh,en}.json`（两份键必须一致）。
6. **保持模块可装卸**：监听/observer/appendChild 收进 `installXxx()` 并返回 `dispose`；
   不给新模块加 `window.__dwl*` 全局或 `CustomEvent` 就绪协议（那是零构建时代的注入面，已删）。
7. **跑测试与真机验证**（见下），并在交付说明里写清"怎么看到效果"。

## 硬约束

- `src/client/**` 是 ESM 构建源码：**可以** `import`/`export`，但**不许** import Node 内建或
  使用 `process`/`__dirname`/`Buffer`；React 用真实 `import React from 'react'`，
  tsdown 会把它 external 成宿主的 `require('react')`。
- 不许改页面正文 DOM：卡片只追加自己的浮层（`position: fixed`），标注只包裹目标词节点。
- 不许写死颜色、不许判 `data-theme="dark"`、不许猜令牌值。
- 不加 npm 前端依赖；React 等 11 个 baseline seed 由宿主模块表提供，打进产物就是第二份 React。
- 不许碰其它插件的节点与弹窗；标注遇到就跳过。
- 体积约束只有产物预算（`pnpm artifact:check`：raw ≤ 400 KB / gzip ≤ 100 KB）：
  新功能优先抽组件/抽函数，别让 bundle 无声膨胀。
- 前端脚本的任何异常必须吞掉（带注释说明），划词/标注坏了不能拖垮页面。

## 必须执行的验证

```bash
pnpm build                          # 产物重建；组件测试读 dist/client.js
npx vitest run tests/component/views.test.tsx   # 先单跑本层
pnpm test:unit                      # features/*.test.mjs（纯函数与 install 生命周期）
pnpm lint:fix
pnpm format
pnpm verify                         # 唯一验收
```

真机验证（README「开发」节有完整步骤）：

- 划词：左栏划一次应**不弹卡**，对话正文划一次应**弹卡**；
- 标注：展开折叠内容后才补标；流式生成中不标；
- 主题：明暗各切一次，颜色跟随、不重启；
- 生效：`pnpm build` 后平台 client-hmr 自动重载（不用刷新/重启）；面板会重挂，学习页退回首页，
  重点侧栏「英语学习」看新代码。

## 交付输出模板

```text
目标：{{用户看到的变化}}

改了哪一块：{{wordcard / card / style / core / annotate / plugin / logic / styles}}，为什么是它

改动：
- {{文件}}（{{函数/组件}}）—— {{结构/样式/请求}}
- 颜色令牌：{{用了哪些，兜底值是什么}}
- 文案：{{DICT/locale 键是否两处同步}}

测试：{{tests/features 结果}}；npx vitest run ... → {{结果}}；pnpm verify → {{结果}}

生效方式：{{pnpm build / pnpm dev + HMR；宿主侧需重挂}}
真机确认：{{做了哪几步，看到什么}}

剩余风险：{{未覆盖的浏览态（折叠/流式/暗色/窄屏）/ 需人工确认的视觉}}
```
