# ADR-0001：解除「零构建」限制，改为构建产物 + 源码分层

- 状态：提议（等待用户批准）
- 日期：2026-11-05
- 相关：ADR-0002、ADR-0003、ADR-0005、ADR-0006、ADR-0007

## 背景

`AGENTS.md §3`、`CONVENTIONS.md §2.3` 把「不许引入构建步骤」写成硬约束，理由只有三条运维担忧：改完要 build、mtime 热重载失效、堆栈对不上源码。这条规则不是 DSH 平台规定。实测证据：

1. DSH 官方插件开发参考原文（`dsh-agent-preset/skills/cordis-plugin-development/references/ui-plugin.md`）：
   > For compiled sources, use the deployment's Client build tooling to emit this format; declare non-baseline runtime imports in `dsh.client.external`.
2. DSH 客户端加载器 `@deepseek-ai/dsh-client-modules/lib/index.js:165` 常量注释原文：
   > Source-map trailer emitted by tsdown at the end of every client bundle.
   > 即平台自己的客户端构建工具就是 **tsdown**，加载器专门识别/剥离 tsdown 的 `sourceMappingURL` 尾部。
3. 本机 profile 里 8 个社区插件（dsh-armory、dsh-context、@anionex/dsh-vision-toolkit 等）都带构建步骤，产物 `lib/client.js` 已入库，形态是 `window.__ModuleLoader__.load({id, factory})`。

「零构建」在本仓库造成的实际后果：不能 `import` → 只能把代码塞进单文件（`assets/dashboard.js` 曾 3758 行、`lib/store.mjs` 859 行）；拆模块只能靠 `window.__dwl*` 全局 + 手工注入顺序协议（8 段、`s.async=false`、`dwl:assets-ready`、`whenAssetsReady` 轮询、`assetOf` 使用时读、「正在加载」守门）。这些不是架构，是给「没有模块系统」打的补丁（审计报告 §2 给出量化）。

## 决策

1. **浏览器侧允许并默认使用构建**：TS/React 源码 → 单文件客户端 bundle（`dist/client.js`），`dsh.client` 仍只有一个 `./client`。
2. **宿主侧统一 TypeScript**，`tsc` 产出 `dist/host/`（Node ESM，保留文件结构、不打包）；门面 `main` 指向 `dist/host/index.js`。
   - 迁移分阶段：阶段 1–2 宿主仍跑 `.mjs` 源码；阶段 3 逐模块迁 TS 并切 main。切换前用 `tsc --noEmit --checkJs` 对 `.mjs` 做类型检查。
3. **源码层与产物层分离**：`src/host/**`、`src/client/**` 是唯一人工编辑面；`dist/**` 是构建产物、**不入库**（`.gitignore`）。
4. 原三条担忧的处置：
   - 「改完要 build」→ `pnpm dev` 双 watch（tsdown + tsc）；客户端产物变化由 `dsh-client-hmr` 自动重载（实测：touch 客户端产物后浏览器自动以新 rev 重新拉取并重挂，见审计报告 §3）。
   - 「mtime 热重载失效」→ 客户端改为「构建产物 mtime 变化 → 平台 HMR」，比自建 mtime loader 更可靠；宿主改为「tsc watch + profile patch 探针重挂」。
   - 「堆栈对不上源码」→ 平台按 tsdown sourcemap 契约自动服务 `.map`（`dsh-client-modules` 读取 `<clientPath>.map` 并重定位到 combo URL），DevTools 可定位到 `src/**`。

## 后果

- `pnpm verify` 增加 build + typecheck 段；`dist/` 缺失时 DSH 激活会报 `client bundle not found; run pnpm run build before launch`（平台原文），因此本地开发必须先 build，CI 必须 build。
- 发布物（npm tarball / GitHub Release）包含 `dist/`，源码仓库不包含。
- 桌面端注入兜底（`tapIndex`）随注入协议一起删除；插件明确只支持 Web（`dsh.client.platform: "web"`）。这是有意的能力收窄，记录在 ADR-0003。
- 首次把 `exports['./client']` 指向新路径时，若平台「非 client 包」否定缓存命中，需要重启一次 dsh（阶段 1 的停机点，见计划）。

## 备选方案

- **保持零构建**：成本是继续维护注入顺序协议与手工全局；已被本轮 5 个真缺陷证伪（0 个由静态门禁抓到）。
- **只加类型不加构建**（宿主 TS + 客户端 JSDoc）：不能解决客户端模块边界问题，dashboard 仍是单文件。
- **客户端保留多入口多文件、由宿主拼接**：即现状的变体，仍是自研加载器，不采用。

## 复审条件

- 若 DSH 平台移除客户端构建契约或 tsdown sourcemap 支持，重评本条。
- 若构建后客户端 HMR 在真机连续 3 次失效，回滚到「assets 注入 + mtime loader」（保留阶段 1 之前的 tag）。
