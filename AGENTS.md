# AGENTS.md —— 改这个插件前的守则

给下一次接手改代码的 AI。读完这一页再动手；它比你的直觉优先，也比参考仓库的写法优先。

## 0. 必读顺序

1. 本文件（约束 + 定位）；
2. `CONVENTIONS.md`（为什么 + 契约 + 测试纪律）；
3. `README.md` 的「开发」节（命令、生效方式、真机验证方法）；
4. 改到哪块，就读 `DESIGN.md` 对应章节的历史结论（§2 数据模型、§4 排期、§9 风险）。

`DESIGN.md` 是历史决策记录，**没有"更新它"的任务就不要改它的结论**。它记的坑都是实测过的。

## 1. 三条命令（其余都是补充）

```bash
pnpm build         # 双产物：src/client/** -> dist/client.js（tsdown）；src/host/** -> lib/host/**（tsc）
pnpm verify        # 交付前的唯一验收：build + artifact + tarball + typecheck + lint + format + deps + 单测 + 组件/集成测试
pnpm lint:fix      # 先修可自动修的
pnpm format        # 再统一排版
```

顺序：改完 → `pnpm lint:fix` → `pnpm format` → `pnpm verify`。
`pnpm verify` 不绿就不要说"改好了"。绿了也要把输出贴进交付说明。

单跑集成测试：`npx vitest run tests/integration`（真实 `ctx` 桩 + 临时 `DSH_HOME`，不碰真实库）。

`pnpm deps:check`（dependency-cruiser）带跑环检测与分层方向；测试全部由 vitest 一个 runner 跑：
`pnpm test:unit`（unit/features/contract，node 环境）、`pnpm test:component`（jsdom+RTL）、
`pnpm test:integration`（真实 ctx 桩 + 临时 DSH_HOME）、`pnpm test`（全量 + 覆盖率门槛）。

## 2. 改 X 去哪里

| 要改的东西                             | 文件                                    | 备注                                                                                                                                                 |
| -------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 划词卡片装配、请求、状态机             | `src/client/features/wordcard/index.js` | `installWordcard()` 装监听/建卡、返回 dispose；判定用 `../core.js`、视图用 `./card.js`、CSS 用 `./style.js`（全部 import，无 window 全局）           |
| 划词卡片视图（DOM/渲染/定位）          | `src/client/features/wordcard/card.js`  | 不注册事件、不持有状态；DOM 句柄由 index.js 传入                                                                                                     |
| 划词卡片样式（CSS 字符串）             | `src/client/features/wordcard/style.js` | 只导出 `CSS` 字符串，不碰 DOM                                                                                                                        |
| 划词纯判定 + 排除范围单一来源          | `src/client/features/core.js`           | `BLOCKED_ELEMENTS`/`blockedSelector` 只在这里维护，wordcard/annotate 都 import 它；改判定必跑 `tests/features/scope.test.mjs`                        |
| 学习页四个视图、侧栏入口、客户端文案   | `src/client/plugin.js`                  | React 客户端源码，经 tsdown 打成 `dist/client.js`；改完 `pnpm build`（watch 用 `pnpm dev`）；单测入口 `__test__`；**禁止模块期快照 `window.__dwl*`** |
| 学习页纯逻辑 / 常量（无 React）        | `src/client/dashboard/logic.js`         | 不监听事件、不写样式；`plugin.js` 通过 `assetOf(name)` 读它                                                                                          |
| 学习页样式（CSS 模板串）               | `src/client/dashboard/styles.js`        | `export const CSS`；apply 时写进 `<style data-plugin="dsh-word-learn">`                                                                              |
| 对话内联标注、悬停小卡                 | `src/client/features/annotate/`         | `installAnnotate()` 装 observer/监听，返回 dispose；只在 `[data-chat-flow]` 内动                                                                     |
| 新增/改一条路由的 handler              | `src/host/routes/{组}.ts`               | 组：study/review/ai/repair/annotate；只解析参数，业务往下走                                                                                          |
| 路由路径字符串                         | `src/host/routes/paths.ts`              | 常量唯一出口，别在 handler 里写死路径                                                                                                                |
| 响应出口（safeSend / fail / readJson） | `src/host/routes/shared.ts`             | 响应只从 safeSend 出；错误只回稳定 code + 人话                                                                                                       |
| 信任栅栏、registerRoute 包装           | `src/host/index.ts`                     | 入口只做挂载与卸载；**阶段 2 起不再往页面注入任何脚本**                                                                                              |
| 词典/用户库单例                        | `src/host/runtime.ts`                   | 进程级状态；路由模块只消费                                                                                                                           |
| 查词结果组装（lookupWord）             | `src/host/lookup.ts`                    | /lookup、/word、/translate 共用                                                                                                                      |
| 路由 query / body 参数读值/钳制        | `src/host/http.ts`                      | query 数字过 `intParam`、body 数字过 `clampInt`；别裸写 `Number`                                                                                     |
| 排期、FSRS 映射、队列、毕业/leech      | `src/host/schedule.ts`                  | 别在路由里直接算 FSRS                                                                                                                                |
| 用户库生命周期（打开/重试/关闭/委托）  | `src/host/store.ts`                     | 门面：open/退避重试/close + 25 个薄委托，别往里堆逻辑                                                                                                |
| SCHEMA 与迁移                          | `src/host/store/schema.ts`              | 表结构/索引/`migrate()`；schema 变更见 CONVENTIONS §6.3                                                                                              |
| 生词本、卡片、义项材料读写             | `src/host/store/words.ts`               | SQL 归口之一；函数第一参数是 Store 实例                                                                                                              |
| 统计、看板、补记债                     | `src/host/store/review.ts`              | 函数第一参数是 Store 实例                                                                                                                            |
| 设置读写                               | `src/host/store/settings.ts`            | 函数第一参数是 Store 实例                                                                                                                            |
| 发音（前端语音合成、音色选择）         | `src/client/features/voice.js`          | 零网络：只用浏览器自带音色，缓存的是偏好不是音频                                                                                                     |
| 整句翻译、降级链                       | `src/host/translate.ts`                 | 交互路径：失败回 200 + `ok:false`                                                                                                                    |
| AI 分析、义项材料、出题、队列          | `src/host/enrich/*.ts`                  | `ai-enrich.ts` 只做再导出；队列 dispose 后靠下次 enqueue 重新武装（`rearmIfDisposed`）                                                               |
| AI 分析用哪个模型                      | `src/host/models.ts`                    | 复用 DSH 模型目录，不自己维护名单                                                                                                                    |
| 词典查询、变形回退、词频分级           | `src/host/dict.ts`                      | 只读 `data/ecdict.db`                                                                                                                                |
| 回访（R5）、义项地图                   | `src/host/r5.ts`                        | 只记日志，不动 FSRS                                                                                                                                  |
| 标注目标词表                           | `src/host/annotate.ts`                  | 只返回在学、有卡片的词                                                                                                                               |
| 文本判断（是不是单词、拆词、代码过滤） | `src/host/text.ts`                      | 纯函数，改这里先跑 `tests/features/scope.test.mjs` 与 `tests/integration/routes.test.ts`                                                             |
| 取 cordis 服务                         | `src/host/service.ts`                   | 用 `ctx.get(name)`；`ctx.llm` 会抛                                                                                                                   |
| 包级文案                               | `locale/zh.json`、`locale/en.json`      | 两份键必须一致                                                                                                                                       |

## 3. 硬约束（违反即算失败，不讨论）

- **不许改 `data/`**：词典是构建产物，要重生成走 `scripts/build_dict.py`，不是手改 `.db`。
- **不许碰真实用户库**：`$DSH_HOME/dsh-word-learn/user.db` 不可再生。
  任何会写库的测试/脚本必须先 `mkdtemp` 临时 `DSH_HOME`（见 CONVENTIONS §9.2）。
- **不许改 `DESIGN.md` 的历史结论**：那是决策与实测记录。新结论只能追加，并注明日期。
- **不许为过 lint 加 `eslint-disable`**。确需例外时，必须写原因 + 到期条件，并说明为什么规则不适用。
  TS/TSX 也进 ESLint（`typescript-eslint`，`parserOptions.project` 指向 `tsconfig.eslint.json`）：
  类型感知只开三条能命中真缺陷的规则（`no-floating-promises` / `no-misused-promises` / `await-thenable`），
  `no-explicit-any` 关着 —— 宿主 ctx 边界来自 cordis、没有类型，是已知缺口。
- **不许制造 import 环**：`pnpm deps:check`（dependency-cruiser 的 `no-circular`，挂在 `pnpm check`/`verify` 里）会打印完整环路径。
- **不许改 `cordis.patch.yml` 的语义**（id/name/insert 结构）。它只是挂载声明；
  改它触发 HMR 是运维手段，不要把语义改掉。
- **构建是唯一入口**：客户端产物只能由 `pnpm build`（tsdown）从 `src/client/**` 生成，`dist/` 不入库；
  产物壳/`id`/externals 由 `tsdown.config.ts` 定义，**不许手改 `dist/client.js`**（`pnpm artifact:check` 会校验）。
  宿主源码只有 `src/host/**`（TypeScript），`lib/host/**` 是 `tsc -p tsconfig.host.json` 的产物（gitignore），
  **不许手改 `lib/host/**`**；`package.json` 的 `main`/`exports` 必须指向产物入口。
- **客户端产物只许 `require` 宿主模块表**（11 个 baseline seed，见 `tsdown.config.ts`）：多 require 一个包就是运行期
  `missed the module table`；运行时依赖（如 `ts-fsrs`）留在宿主侧，不进客户端。
- **不许在 `src/client/**` 里 import Node 内建或 `process`/`__dirname`**：产物跑在浏览器。
- **不许写死颜色**：颜色只走 `--dsw-alias-*` 令牌（深层判断用 `.dwl-page`/`isDark()` 那套）。
- **前端模块不许在顶层产生副作用**（监听/observer/appendChild）：一律收进 `installXxx()`，返回 dispose，
  由 `apply()` 的 `ctx.effect` 装卸 —— HMR 重挂才不会叠监听。
- **不许把真实网络写进测试**：LLM/翻译/TTS/例句一律 stub，或只用已落盘缓存。
- **不许绕过 `registerRoute`** 直接 `ctx.webServer.register`；不许绕过 `makeFence`。
- **不许手改 `pnpm-lock.yaml`**，不许用 npm/yarn 装包。

## 4. 工作流

1. **先定位，再改**：用 §2 的表找到文件；读文件头注释（每个文件开头都写了它为什么存在、踩过什么坑）。
2. **改前先想测试**：改行为先加一条会红/会绿的断言；修 bug 先补回归（CONVENTIONS §9.3）。
3. **只改必要的**：不顺手重构无关代码，不批量改注释格式，不重排 import。
4. **改完自检**：`pnpm lint:fix && pnpm format && pnpm verify`。
5. **说清生效方式**：前端全部在 `src/client/**` —— 改完 `pnpm build`（或 `pnpm dev` 常驻）重建
   `dist/client.js`，平台 client-hmr 会拉新产物并重挂模块（**不用刷新、不用重启**）；但重挂会重建插件的
   面板，当前打开的学习页会退回首页，重新点侧栏「英语学习」即可看到新代码。
   **宿主侧（`src/host/**`）没有热重载**：改完同样要 `pnpm build`（tsc 出 `lib/host/**`），然后**重启 dsh**。
   2026-11-06 实测：宿主改动后触发插件重挂，进程里跑的还是旧模块（Node ESM 缓存）；
   重启后才加载新入口 `lib/host/index.js` 与新逻辑。
   改完前端要告诉人"怎么看到效果"。

## 5. 交付说明必须包含

- **改了哪些文件 + 为什么**（每个文件一句话，说动机不说 diff）。
- **`pnpm verify` 的实际结果**（命令 + 通过/失败；失败要贴关键报错）。
- **剩余风险 / 未覆盖点**：没测到的分支、依赖外部服务的路径、需要真机验证的交互。
- 行为变了就写**生效方式**；接口变了就确认 README「接口」表已更新。

不要用"已按要求完成"代替这三项。

## 6. 常见任务 → 照着做

| 任务                         | 提示词模板                   |
| ---------------------------- | ---------------------------- |
| 修一个 bug（含回归）         | `prompts/fix-bug.md`         |
| 新增/修改一条路由            | `prompts/add-route.md`       |
| 改前端（划词卡/学习页/标注） | `prompts/edit-frontend.md`   |
| 从大文件里拆模块             | `prompts/refactor-module.md` |
| 补测试 / 迁移 legacy 脚本    | `prompts/write-test.md`      |

模板里写了精确的"先读哪几段"，直接复制粘贴给 AI，把 `{{...}}` 换成实际内容。

## 7. 卡住时不要猜

- 不确定某段代码为什么这么写：先看文件头注释和 `DESIGN.md` §9 的风险编号；
  两者都没有，说明是历史债，**保守改**并留注释。
- 不确定改动是否生效：前端看 `__DSH_BOOT__.entries` 里有没有 `dsh-word-learn`（权威信号）；
  宿主侧改动是否生效看「重启后」的接口行为（客户端 bundle 热重载不会更新宿主模块），
  不要自己拼 `/plugins/...` URL（一定 404）。步骤见 README「开发」节。
- 不确定预算/边界：跑 `pnpm lint`，报错信息就是规则原文；看不懂再回 `CONVENTIONS.md`。
- 文档里的行号是写文档那一刻的快照；找不到就用函数名/常量名/报错文案搜，别死认行号。
