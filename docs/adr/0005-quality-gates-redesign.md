# ADR-0005：质量门禁重设计 —— 删除「形状门禁」，改用类型/依赖/产物/行为

- 状态：提议（等待用户批准；审计数据见审计报告）
- 日期：2026-11-05
- 相关：ADR-0001、ADR-0002、ADR-0003、ADR-0004

## 背景

本轮静态门禁 = ESLint 三区 + `CODE_BUDGET` max-lines 棘轮 + 自写 `check-cycles.mjs` + 只卡 3 个文件的覆盖率门槛 + 两条为注入协议而生的测试（`inject-order`、`dashboard-refresh`）。审计结论（量化见审计报告）：

- 本轮 5 个真缺陷 **0 个**由这些门禁抓到；真机 2 个、真实老库迁移测试 1 个、人工 review 2 个。
- 预算门禁的真实作用是「逼拆文件」；拆出来的 31 个 lib 模块反过来逼出了手工注入顺序协议（约 600 行协议代码 + 文档 + 2 个测试）。
- 环检测上线后 **0 次**真实告警（lib 从未成环）；且只扫 `lib/`，与文档声称的「tests/scripts 对 lib 的引用也查」不一致。
- 覆盖率只卡 3 个文件（恰好 100%），是现状快照；全量单测口径 lib 69.3%、17/33 个 lib 文件从未被加载、assets 8283 行计量为 0。
- 文档漂移没有机制：12 个 commit 里 3 个是纯文档对齐（25%），预算表/行号每次拆文件就过期。

## 决策

### 删除

| 门禁/产物                                                                   | 原因                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODE_BUDGET` 与 `max-lines` 棘轮（含 12 条单文件预算）                     | 行数不是缺陷；它制造「贴上限」与「为拆而拆」。文件职责由依赖方向与测试约束，不由行数                                                                                                                                               |
| `scripts/check-cycles.mjs` + `tests/unit/cycles.test.mjs`                   | 由 `dependency-cruiser` 的 `no-circular` 取代（实测 15/15 形态检出 vs 自研 9/15；自研版在真实仓库漏 6 条 `export ... from` 边）。附带更正：前任「import-x 在 ESLint 10 下不工作」是配置错误，实测可用，但能力/速度仍不如 depcruise |
| 覆盖率 `--test-coverage-include` 3 文件清单                                 | 被 vitest coverage 的全局 + 关键模块阈值取代                                                                                                                                                                                       |
| `tests/unit/inject-order.test.mjs`、`tests/unit/dashboard-refresh.test.mjs` | 协议本身被删除（ADR-0003）；用「重复 apply/dispose 幂等」组件测试替代                                                                                                                                                              |
| `pnpm test:legacy`（11 个手写脚本）                                         | 迁入 vitest integration/component（ADR-0004）                                                                                                                                                                                      |
| 文档中的预算表、注入顺序、逐文件行号                                        | 不可维护；改为架构规则 + 依赖图生成物                                                                                                                                                                                              |

### 保留

| 门禁                 | 说明                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint（正确性）     | `@eslint/js` + typescript-eslint recommended（非 type-checked，stage 后可加）+ 少量项目规则（禁 `node:*` 进 client、禁 `eslint-disable` 无理由）        |
| Prettier             | 排版唯一出口，不变                                                                                                                                      |
| `tsc --noEmit`       | **新增**，最强的一道：类型/接口/契约错误在编译期暴露                                                                                                    |
| `dependency-cruiser` | **新增**：`no-circular`、分层方向（ADR-0003 铁律 1–7）、orphan、client 纯度（禁 node:*）、禁止 host↔client 互引                                         |
| vitest + coverage    | **新增**：unit/component/integration/contract 四类；全局阈值 + 关键模块 per-file                                                                        |
| 产物契约检查         | **新增**：`scripts/check-artifact.mjs` — 单 `__ModuleLoader__.load`、id=包名、factory 参数 `require`、返回 `{inject, apply}`、无 `node:`、gzip 体积预算 |
| locale 键一致检查    | 从人工纪律升级为测试（zh/en 键差集为空）                                                                                                                |
| 路由不变量检查       | 22 条路由 methods 白名单、fence 存在、错误响应形状（integration 测试断言）                                                                              |

### 新增体积预算（唯一保留的预算类门禁）

只保留**一个**：客户端 bundle 体积 `raw ≤ 400 KB` 且 `gzip ≤ 100 KB`。基线：用 203 KB 源输入（与现有 8 段注入脚本体量相同）实测 tsdown 产物 304.3 KB raw / 28.9 KB gzip；现有零构建形态是 8 个文件共约 200 KB 未压缩、无 gzip。理由：这是真实的浏览器加载成本，不是「复杂度代理」。超了就分析后决定分割或删功能，并**修预算必须写 ADR/提交说明**，不许偷偷调。

### 新 `pnpm verify` 链路

```
build → typecheck → lint → format:check → deps:check
      → test(unit+component+integration) → coverage → artifact:check → pack:check
```

（阶段 1 先从「build → typecheck → lint → format → deps → 旧测试 → artifact」起步，阶段 3 完成测试迁移后收敛到上表；`pack:check` = `npm pack --dry-run` 文件清单断言。）

## 后果

- 自研门禁代码从约 977 行降到约 0（dependency-cruiser 配置约 60 行 + artifact 检查约 80 行 + locale 测试约 30 行）。
- 门禁从「约束形状」变为「约束契约」：类型、依赖方向、产物形态、行为断言、体积。
- 误报预期：环/分层规则在迁移期会有历史债告警（`store→schedule` 等），采用「先登记 baseline，再逐条还」的方式，禁止全局 disable；每月新增误报预计 ≤ 2 条（来自分层规则的合法例外），由 ADR/说明登记。
- 文档漂移：AGENTS/CONVENTIONS 不再写行号与预算表；`docs/architecture.md` 的目录/依赖图由脚本生成，CI 校验生成物与提交物一致。

## 备选方案

| 方案                          | 结论                                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| 保留现有门禁 + 加类型/构建    | 保留的是维护成本与错误方向；不采用                                |
| 只加 vitest，不动 ESLint/预算 | 不能解决「文件大 = 拆」的伪信号；不采用                           |
| 用 Biome 取代 ESLint+Prettier | 可评估，但 typescript-eslint 规则面/生态仍占优；阶段 4 可再做 ADR |

## 复审条件

- 若 dependency-cruiser 在 TS 项目上出现漏报（用 fixture 单测验证），回退到 `import-x/no-cycle` + 自写分层脚本。
- 若 bundle 预算在功能增长后确需调整，按「先测量、再分割、最后才调」的顺序，且每次调整必须有数据。
