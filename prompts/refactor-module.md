# 提示词模板：从大文件里拆模块

## 适用场景

目标文件：{{文件路径，例如 src/client/plugin.js}}。
触发原因通常是：一个文件多职责、改一处要动三个不相邻区域、某段逻辑想单独测试却只能整文件跑、
同一份契约在 `src/host/` 与 `src/client/` 各有一份且开始不一致。
**纯搬迁，不改行为**；改行为另开任务（用 `fix-bug.md` / `add-route.md`）。

行数不再设门禁（ADR-0005 删了 `CODE_BUDGET`/`max-lines`）：拆分的理由是职责与耦合，
不是"文件超过 N 行"。唯一体量约束是客户端产物预算（`pnpm artifact:check`）。

## 先读什么（别跳）

| 文件                      | 位置（按符号搜）                                | 为什么                                      |
| ------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `CONVENTIONS.md`          | §4 模块与拆分                                   | 拆分判据、抽纯函数的顺序、禁止事项          |
| `.dependency-cruiser.cjs` | `forbidden` 四条                                | 拆完不能新增环/跨边界；配置本身不许改来放行 |
| 目标文件                  | 文件头 + 全部导出/入口                          | 先看清它对外承诺了什么                      |
| 目标文件                  | 你要拆的那段及其调用点                          | 用 grep 找全部引用，别漏动态 import         |
| 相关测试                  | `tests/*/*.test.mjs`、`*.test.tsx`、`*.test.ts` | 拆完这些必须仍绿，它们是"行为不变"的证据    |
| `AGENTS.md`               | §2 定位表、§3 硬约束                            | 拆完同步定位表（不写行号）                  |

## 步骤

1. **先量体积，写进交付说明**：`wc -l` 粗看 + 看这个文件是不是明显承担了两个职责。
   不追行数指标，只记录拆前拆后的职责边界。
2. **画依赖，定切法**：列"输入 → 输出"清单。优先抽满足以下条件的部分：
   纯函数（无 `ctx`、无 IO）、被多处调用、改得最频繁。
   给新文件起职责名（`schedule.ts`、`ai-enrich.ts`、`wordcard/card.js` 这种），不要 `utils.mjs`。
3. **先加测试再搬**：如果这段逻辑现在没有测试，先补一条能过的断言（证明基线）。
   搬完同一条断言必须仍绿——这是"行为没变"的唯一证据。
4. **搬代码**：
   - 宿主模块：新建 `src/host/<职责>.ts`（或子目录），命名导出；原文件改为 `import`/薄委托。
     拆 store 这类有状态模块：子模块函数**第一个参数是 Store 实例**，门面只留 open/close 与薄委托
     （CONVENTIONS §6.2），别让两个模块各判一次「库开没开」。
   - 前端模块：新文件放在 `src/client/features/` 或 `src/client/dashboard/` 下；装配仍留
     `installXxx()`（返回 dispose），纯判定/纯函数独立成文件、样式只导出 CSS 字符串。
     **不要**新建 `window.__dwl*` 全局来给拆出来的模块传值——用 `import`；跨模块共享的状态留在
     调用方闭包里。
   - 调用点一处一处改，不要一次全改完再跑。
5. **同步文档**：`AGENTS.md` §2 定位表、`CONVENTIONS.md` 相关节（不写行号）。
   新建/搬迁模块要保证文件头注释里「为什么在这」仍然成立。
6. **跑验证**，绿了再继续下一刀；一次只拆一个模块。

## 硬约束

- 不跨边界搬：`src/client/**` 不 import `src/host/**`，反之亦然（dependency-cruiser 守）。
- 不改 `.dependency-cruiser.cjs` 放行新环；环就是要修的信号，不是配置问题。
- 不改变对外契约：路由路径、响应字段、导出的函数名与返回值都不能变。
- 不把纯 DOM/React 组件抽成"通用组件库"——目前只有一个消费方。
- 不在搬迁里顺手改逻辑、改注释口吻、重排 import 分组之外的格式。
- 拆完别留死代码（旧函数、旧常量、不再使用的 import）。
- 不手改 `dist/**`、`lib/host/**`；拆完要 `pnpm build` 让产物与源码一致。
- 提交分开：`refactor:` 一次，逻辑改动另一次。

## 必须执行的验证

```bash
pnpm build                 # vitest 读 dist/client.js 与 lib/host/**，先重建
pnpm typecheck             # 双投影：src/** 类型 + 宿主编译
pnpm deps:check            # 确认没有新环/新跨边界
pnpm test:unit             # node:test：unit/features/contract 仍绿
pnpm test:component        # vitest：component + integration 仍绿
pnpm verify                # 唯一验收
git diff --stat            # 确认改动面与预期一致，没有意外文件
```

如果拆的是排期/存储：额外跑 `tests/unit/schedule.test.mjs` / `tests/integration/routes.test.ts`。

## 交付输出模板

```text
目标文件与职责：{{文件}} —— 拆前承担 {{职责1+职责2}}，物理 {{N}} 行

切法：{{原文件的一等职责清单}} → {{新文件1}}、{{新文件2}}，各自职责一句话

改动：
- {{新文件}} —— 承载 {{职责}}
- {{原文件}} —— 改为 import/调用，删掉 {{N}} 行
- {{AGENTS.md / CONVENTIONS.md}} —— 同步了哪节定位/判据

行为不变证据：{{测试名}} 搬迁前后均绿；响应/导出契约未变

验证：pnpm verify → {{结果}}；git diff --stat → {{改动面}}

剩余风险：{{下一次该拆哪块 / 仍然存在的耦合点}}
```
