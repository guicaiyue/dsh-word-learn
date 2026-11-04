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
pnpm verify        # 交付前的唯一验收：lint + format:check + 单测 + 回归脚本
pnpm lint:fix      # 先修可自动修的
pnpm format        # 再统一排版
```

顺序：改完 → `pnpm lint:fix` → `pnpm format` → `pnpm verify`。
`pnpm verify` 不绿就不要说"改好了"。绿了也要把输出贴进交付说明。

单跑某个回归脚本：`node scripts/test-routes.mjs`（脚本自己造临时 `DSH_HOME`，不碰真实库）。

## 2. 改 X 去哪里

| 要改的东西                             | 文件                               | 备注                                             |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| 划词卡片、选区判定、浮层样式           | `assets/wordcard.js`               | 普通 IIFE；`SCOPE_SELECTOR` 在文件末尾附近       |
| 学习页四个视图、侧栏入口、客户端文案   | `assets/dashboard.js`              | React 客户端模块；改完要**重新激活插件**         |
| 对话内联标注、悬停小卡                 | `assets/annotate.js`               | 普通 IIFE；只在 `[data-chat-flow]` 内动          |
| 路由、注入行、信任栅栏、响应出口       | `lib/index.js`                     | handler 只解析参数，业务往下走                   |
| 路由 query 参数读值/钳制               | `lib/http.mjs`                     | 数字参数必须过 `intParam`，别裸写 `Number`       |
| 排期、FSRS 映射、队列、毕业/leech      | `lib/schedule.mjs`                 | 别在路由里直接算 FSRS                            |
| 用户库 schema、读写、迁移              | `lib/store.mjs`                    | SQL 主要归口；schema 变更见 CONVENTIONS §6.3     |
| 发音（前端语音合成、音色选择）         | `assets/voice.js`                  | 零网络：只用浏览器自带音色，缓存的是偏好不是音频 |
| 整句翻译、降级链                       | `lib/translate.mjs`                | 交互路径：失败回 200 + `ok:false`                |
| AI 分析、义项材料、出题、队列          | `lib/ai-enrich.mjs`                | 服务获取走 `service.mjs`                         |
| AI 分析用哪个模型                      | `lib/models.mjs`                   | 复用 DSH 模型目录，不自己维护名单                |
| 词典查询、变形回退、词频分级           | `lib/dict.mjs`                     | 只读 `data/ecdict.db`                            |
| 回访（R5）、义项地图                   | `lib/r5.mjs`                       | 只记日志，不动 FSRS                              |
| 标注目标词表                           | `lib/annotate.mjs`                 | 只返回在学、有卡片的词                           |
| 文本判断（是不是单词、拆词、代码过滤） | `lib/text.js`                      | 纯函数，改这里先看 `test-scope`/`test-routes`    |
| 取 cordis 服务                         | `lib/service.mjs`                  | 用 `ctx.get(name)`；`ctx.llm` 会抛               |
| 包级文案                               | `locale/zh.json`、`locale/en.json` | 两份键必须一致                                   |

## 3. 硬约束（违反即算失败，不讨论）

- **不许改 `data/`**：词典是构建产物，要重生成走 `scripts/build_dict.py`，不是手改 `.db`。
- **不许碰真实用户库**：`$DSH_HOME/dsh-word-learn/user.db` 不可再生。
  任何会写库的测试/脚本必须先 `mkdtemp` 临时 `DSH_HOME`（见 CONVENTIONS §9.2）。
- **不许改 `DESIGN.md` 的历史结论**：那是决策与实测记录。新结论只能追加，并注明日期。
- **不许为过 lint 加 `eslint-disable`**。确需例外时，必须写原因 + 到期条件，并说明为什么规则不适用。
- **不许调大 `eslint.config.js` 的 `CODE_BUDGET`** 来让检查变绿。超预算就拆模块。
- **不许改 `cordis.patch.yml` 的语义**（id/name/insert 结构）。它只是挂载声明；
  改它触发 HMR 是运维手段，不要把语义改掉。
- **不许引入构建步骤**：不加 TS、bundler、CSS 预处理器（CONVENTIONS §2.3）。
- **不许在 `assets/` 里 import/require Node**（唯一例外是 `dashboard.js` 的 `require('react')`）。
- **不许在 `assets/` 里判 `data-theme="dark"` 或写死颜色**：颜色只走 `--dsw-alias-*` 令牌。
- **不许把真实网络写进测试**：LLM/翻译/TTS/例句一律 stub，或只用已落盘缓存。
- **不许绕过 `registerRoute`** 直接 `ctx.webServer.register`；不许绕过 `makeFence`。
- **不许手改 `pnpm-lock.yaml`**，不许用 npm/yarn 装包。

## 4. 工作流

1. **先定位，再改**：用 §2 的表找到文件；读文件头注释（每个文件开头都写了它为什么存在、踩过什么坑）。
2. **改前先想测试**：改行为先加一条会红/会绿的断言；修 bug 先补回归（CONVENTIONS §9.3）。
3. **只改必要的**：不顺手重构无关代码，不批量改注释格式，不重排 import。
4. **改完自检**：`pnpm lint:fix && pnpm format && pnpm verify`。
5. **说清生效方式**：`assets/wordcard.js`/`annotate.js` 硬刷新；`assets/dashboard.js`
   要重新激活插件；`lib/*` 重挂插件即可。改完前端要告诉人"怎么看到效果"。

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
- 不确定改动是否生效：看 `__DSH_BOOT__.entries` 里有没有 `dsh-word-learn`（权威信号），
  不要自己拼 `/plugins/...` URL（一定 404）。步骤见 README「开发」节。
- 不确定预算/边界：跑 `pnpm lint`，报错信息就是规则原文；看不懂再回 `CONVENTIONS.md`。
- 文档里的行号是写文档那一刻的快照；找不到就用函数名/常量名/报错文案搜，别死认行号。
