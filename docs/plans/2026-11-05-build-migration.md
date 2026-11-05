# dsh-word-learn 构建化迁移计划（阶段 0 产出）

- 状态：提议，等待用户批准
- 日期：2026-11-05
- 基线：`662f6f4`（工作树干净）；`pnpm verify` 全绿 37s（单测 110 / 回归 11 / 无 build、无 typecheck、无 CI）
- 相关 ADR：0001–0007；审计报告：`docs/audit/2026-11-05-static-gates-audit.md`

## 总原则

1. 每个阶段一个可回滚 commit（必要时带子 commit），阶段末打 tag：`phase-1-base`、`phase-2-bundle`、`phase-3-host-ts`、`phase-4-release`。
2. 每阶段验收 = `pnpm verify` 绿 + 真机浏览器证据（截图/JSON/console）+ 提交推送。
3. 只有「必须重启 dsh」时才停下叫用户；其余生效方式在阶段内自己完成（见 ADR-0007）。
4. 红线不变：不碰 `data/ecdict.db`、不改 `DESIGN.md` 结论、不写真实用户库、测试不发真网络、路由必走 `registerRoute` + `makeFence`、locale 双语键一致、颜色只走 `--dsw-alias-*`、profile patch 探针字节级还原。
5. 任何门禁变绿都不得靠 `eslint-disable` / 调预算 / 删断言。迁移测试允许换框架，断言覆盖不得减少。

## 阶段 1：构建/类型/测试基座（不改业务行为）

**目标**：`dist/client.js` 能构建、能被 DSH 加载、能被真机使用；`pnpm verify` 新链路（build → type → lint → format → deps → test → artifact）跑通。注入脚本暂保留。

步骤：

1. 工具链：
   - devDeps：`tsdown`、`typescript`、`@types/node`、`vitest`、`@vitest/coverage-v8`、`jsdom`、`@testing-library/react`、`react`/`react-dom`（dev 侧）、`dependency-cruiser`。
   - `tsconfig.json`（base）+ `tsconfig.host.json`（阶段 1 仅 `allowJs/checkJs` 检查 `.mjs`，`noEmit`）+ `tsconfig.client.json`。
   - `tsdown.config.ts`：单入口 `src/client/entry.ts`，CJS + banner/footer 包装成 `__ModuleLoader__.load({id:'dsh-word-learn', factory})`，`external: ['react']`，sourcemap。
2. 源码搬运（机械、行为等价）：
   - `git mv assets/dashboard.js src/client/plugin.js`，去掉外层 `window.__ModuleLoader__.load(...)` 包装，保留 `factory(require)` 函数体；`src/client/entry.ts` 负责注册。
   - 物化验证：`dist/client.js` 与旧 `assets/dashboard.js` 在真机上行为一致（四 tab、样式、HMR 重挂）。
3. `package.json`：`exports['./client'] → ./dist/client.js`、`files` 加 `dist`、`main` 仍 `lib/index.js`（阶段 3 再切）、新增 scripts：`build`、`dev`、`typecheck`、`deps:check`、`artifact:check`；`verify = build && typecheck && lint && format:check && deps:check && test:unit && test:unit:coverage && test:legacy && artifact:check`。
4. 先落 3 类新测试（不撤旧测试）：
   - `tests/contract/client-bundle.test.mjs`：读 `dist/client.js`，断言单 `__ModuleLoader__.load`、id=包名、factory 参数为 `require`、返回 `{inject, apply}`、无 `node:`、size ≤ 预算。
   - `tests/contract/locale.test.mjs`：zh/en 键一致。
   - `tests/component/` 1–2 个 RTL 示例（真实 React 渲染现有组件），证明 jsdom 基础设施可用。
5. `.gitignore` 加 `dist/`；`README` 增补「开发需先 `pnpm build`」。
6. 真机验证：
   - patch 探针重挂（profile `cordis.patch.yml` 备份 → 追加注释 → sha256 校验还原），确认 `__DSH_BOOT__.entries` 的 rev 变化、学习页四 tab、划词、标注、普通刷新 ×5。
   - `touch dist/client.js` 验证平台 HMR 自动重载（审计已预验证同类路径）。
7. 回滚点：`git revert` 阶段 1 commit；把 `exports['./client']` 指回 `assets/dashboard.js` 并重挂插件。

**风险/停机点**：若平台对「`./client` 路径变化」有否定缓存或解析缓存，需重启一次 dsh（预期一次；届时停下告知用户）。

## 阶段 2：前端模块化（删除注入协议与 mtime loader）

**目标**：8 个注入脚本 + dashboard 收敛为单 bundle 内的真实 ESM import；删除 `s.async=false`、`dwl:assets-ready`、`whenAssetsReady`、`assetOf`、加载态守门、8 段注入链、mtime loader、`tapIndex`。

顺序（每步真机验证后再下一步）：

1. `core.js` → `src/client/features/wordcard/selection.ts`（纯判定，零 DOM），`wordcard.js` 改为直接 import。
2. `wordcard-style.js` / `wordcard-card.js` → `features/wordcard/{style.ts,card.ts}`。
3. `voice.js` → `features/voice/voice.ts`（保留 `speechSynthesis` 降级与偏好持久化）。
4. `annotate.js` → `features/annotate/annotate.ts`（1278 行，先机械搬，再按 tokenize/流式/折叠框拆子模块）。
5. `dashboard-logic.js` → `dashboard/logic/*`；`dashboard-style.js` → `dashboard/styles.ts`；`dashboard.js` → `dashboard/{page,views,components}`。
6. `src/client/plugin.ts` 的 `apply()` 里 `installXxx(ctx)`，全部返回 dispose，用 `ctx.effect` 管理；删除所有 `window.__dwl*`。
7. 删除：`lib/routes/assets.mjs`（8 条路由）、`lib/runtime.mjs` 的 8 个 loader、`INJECT_TEXT`/`SCRIPT_PATHS`/`tapIndex`、`lib/routes/paths.mjs` 的 8 个常量、`tests/unit/inject-order.test.mjs`、`tests/unit/dashboard-refresh.test.mjs`、`assets/` 目录。
8. 用新测试替代旧契约：`tests/component/plugin-apply.test.mjs`（重复 apply/dispose 不叠加监听与样式；`install→dispose→install` 幂等）、`tests/integration/hmr-reload.test.mjs`（模拟模块重载后旧监听已清理）。
9. 真机验收清单（每项截图/JSON）：
   - 普通刷新 ×5（不再需要「正在加载」兜底，无白屏）
   - 硬刷新
   - 划词卡片：选词/整句/代码块排除/收藏/发音
   - 学习页四 tab：学习（评分/键盘 1-4/S）、词汇（筛选/搜索/加载更多）、数据（KPI/曲线/分布）、设置（模型选择/主题）
   - 标注：对话正文 token 标注、悬停小卡、流式追加
   - HMR：改一个组件文件 → `tsdown --watch` → 浏览器模块自动重载且无重复监听（选词一次只弹一张卡）
   - console 0 error
10. 回滚点：阶段 2 按 feature 子 commit；任一交互回归可单独 revert 该 feature 并恢复对应注入脚本。

## 阶段 3：宿主分层/TS 化 + 测试迁移

**目标**：`lib/**` 迁到 `src/host/**`，`tsc` 产出 `dist/host/`，`main` 切到 dist；依赖注入替代全局单例；legacy 脚本与 vm 替身删除。

顺序：

1. `src/shared` + `src/host/domain`（schedule/r5/annotate/text/params）先迁，纯函数测试同步迁 vitest。
2. `src/host/infra`（dict/llm）+ `store`（schema/words/review/settings/store），类型化 `Store` 接口；迁移测试用真实临时 SQLite。
3. `src/host/http` + `routes`：`registerRoute` 包装、fence、respond 拆分；routes 接收 deps（不再 import 单例）。
4. `src/host/composition.ts`：`createRuntime(ctx)`；`entry.ts` 组装；`package.json main → dist/host/index.js`；`tsc -p tsconfig.host.json` 产出 + `tsc --noEmit` 类型门槛。
5. 测试迁移（按审计报告 7–9 人天估算，可分批）：
   - 110 单测 → vitest（机械）；删除 `tests/helpers/dashboard.mjs`、`tmp-home.mjs`（由 setup 替代）。
   - 11 个 legacy 脚本 → `tests/integration/*`（路由/DB/R5/模型）与 `tests/component/*`（前端），删除 `scripts/test-*.mjs`、`scripts/test-all.mjs`。
   - 全局 setup：**无条件** `DSH_HOME=mkdtemp`（不写「没设才临时」），金丝雀断言 `DB_FILE` 前缀、真实 user.db 前后 mtime/size 不变。
   - 覆盖率阈值按 ADR-0004 落地；CI 上传。
6. 真机验收：全部 API 契约（22 条路由方法/栅栏/错误码）、老库迁移、HMR 重挂、AI 队列重武装。

## 阶段 4：CI/发布/文档/门禁收口

1. GitHub Actions：
   - `.github/workflows/ci.yml`：push/PR → node 24 + pnpm → frozen install → `pnpm verify`（含 build/type/deps/test/coverage/artifact）→ 上传 coverage。
   - `.github/workflows/release.yml`：tag `v*` → verify → `npm publish --provenance`（需 `NPM_TOKEN`）→ `npm pack` 产物上传 GitHub Release（含 sha256）。
2. changesets + conventional commits；`CHANGELOG.md` 自动生成；`prepublishOnly: pnpm verify`。
3. 发布策略：`dist/` 不入库，tarball 含 `dist`；本地 link 安装需 `pnpm build`（README/AGENTS 写清）；`package.json files` 校验用 `npm pack --dry-run`。
4. 文档重写：
   - `AGENTS.md`：删「不许引入构建步骤」「CODE_BUDGET」「8 段注入链」「禁止模块期快照」；改为新目录表、依赖方向、dev 回路、生效方式、真机清单。
   - `CONVENTIONS.md`：删预算表/注入顺序/环检测自研说明；改为分层规则、构建约定、测试纪律、覆盖率口径。
   - `README.md`：新命令表、开发流程、安装方式、发布版本。
   - `prompts/*`：5 个模板按新架构重写。
   - `DESIGN.md`：不动历史结论；新增章节只指向 ADR。
   - 新 `docs/architecture.md`（由依赖图生成/半生成，避免手写行号漂移）。
5. 门禁按审计结论重建（ADR-0005），删除自研预算/环检测/3 文件覆盖率/注入链测试。
6. 最终验收：`pnpm verify` 全绿 + 真机全清单 + 发布 dry-run。

## 生效方式（构建后如何让运行中的 dsh 用上新产物）

| 改动                                                   | 生效方式                                                                                                                     | 需要重启 dsh？ |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `src/client/**`                                        | `tsdown --watch` 产出 `dist/client.js` → 平台 `client-hmr` 500ms 轮询发现变化 → SSE `rebuilt` → 浏览器重载模块并重跑 `apply` | 否             |
| `src/host/**`（阶段 1–2 的 `lib/**`）                  | `tsc -w` 产出 `dist/host/` → 往 profile `cordis.patch.yml` 追加一行注释（备份 → 改 → sha256 还原）触发重挂，约 6–8s          | 否             |
| `dsh.client` 声明 / `exports['./client']` 路径首次变化 | 平台有「非 client 包」否定缓存，可能需重启一次                                                                               | 可能一次       |
| `data/ecdict.db`                                       | 重建后重挂插件（dict 在 open 时读取）                                                                                        | 否             |
| `locale/*.json`                                        | 重挂插件 + 页面刷新                                                                                                          | 否             |

## 剩余风险（详见审计报告 §7）

- 前端脚本并入 client bundle 后，划词/标注的监听时机从「页面一加载」变为「client 模块物化」；`immediately: true` 下差异极小，但需真机验证首屏立刻划词。
- HMR 重载会重复执行 `apply`；清理函数写漏就会双弹卡/双标注。用测试 + 真机重复 HMR 验证。
- bundle 体积预算（≤ 300KB raw / 100KB gzip）需在阶段 2 后复测；超了先做代码分割/懒加载评估，不调预算。
- 宿主 TS 化会引入 `dist/host` 构建延迟（<1s），但改变了「改完即可重挂」的路径，需文档写清 `pnpm dev` 常驻。
- CI 需要用户提供 npm token 才能自动发布；无 token 时 Release tarball 流程仍可用。

## 进度记录

- **2026-11-05 · 阶段 2 完成（待重启验收）**：`assets/` 全数并入 `src/client/**`
  （`features/core.js`、`features/voice.js`、`features/wordcard/{index,card,style}.js`、
  `features/annotate/{index,config,tokenize}.js`、`dashboard/{logic,styles}.js`），
  `apply()` 用 `ctx.effect(installWordcard/installAnnotate)` 装卸；宿主侧删除 `INJECT_TEXT`/
  `SCRIPT_PATHS`/`index-inject`/`tapIndex`/`lib/routes/assets.mjs` 与 `runtime.mjs` 的 mtime loader；
  迁移 3 个 vm 旧脚本到 `tests/features/*.test.mjs`，删除 `tests/unit/inject-order.test.mjs`。
  验证：`pnpm verify` 全绿（artifact 16/16、tsc 0、lint 0、format 0、depcruise 50 modules/99 deps 0 违规、
  node --test 197/197、vitest 7/7、legacy 8/8）。真机验收等 dsh 重启后做（注入代码已删，必须重启才生效）。
