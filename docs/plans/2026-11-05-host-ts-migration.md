# 阶段 3：宿主侧 TypeScript 迁移配方（2026-11-05）

目标：`lib/**` 全部变成 `src/host/**` 的 TypeScript 源码，`tsc -p tsconfig.host.json` 产出
`lib/host/**`（构建产物，已 gitignore）；`package.json` 的 `main`/`exports["."]` 最终指向
`lib/host/index.js`。迁移期间保持 `pnpm verify` 全绿、宿主行为逐字不变（本阶段只做类型化，不做分层重构）。

## 已落地的管道（试点：lib/text.js → src/host/text.ts）

- `tsconfig.host.json`：`rootDir: src` → `outDir: lib`，`module/moduleResolution: NodeNext`，
  产物落在 `lib/host/`；`allowJs: false`。
- `pnpm build` = `tsdown && tsc -p tsconfig.host.json`；`pnpm build:host` 单独编译宿主。
- `pnpm typecheck` = `tsc --noEmit && tsc -p tsconfig.host.json --noEmit`。
- 覆盖率门槛里的文件路径改成编译产物（如 `lib/host/text.js`），与源码 1:1。

## 迁移配方（每个文件一步，必须保持 verify 绿）

1. `git mv lib/<name>.mjs src/host/<name>.ts`（`lib/store/x.mjs` → `src/host/store/x.ts`，
   `lib/routes/x.mjs` → `src/host/routes/x.ts`），保留文件头注释。
2. 只加类型，不改逻辑：
   - 每个导出函数补参数/返回类型；导出 `interface` / `type` 描述跨模块数据结构。
   - `any` 只允许出现在「外部未类型化输入」边界（如 `req`/`res`、JSON body），并加注释说明。
   - 用 `unknown` + 窄化代替 `any`；禁用 `// @ts-ignore`。
3. import 说明符：**只允许指向已迁移模块**，写成 `./x.js` / `../store/y.js`（NodeNext 要 `.js` 后缀）。
   未迁移的模块不允许被 TS import —— 这就是迁移顺序必须按依赖从叶子往上走的原因。
4. 更新导入点：外部（未迁移的 `.mjs`）import 迁移后的模块时写 `../host/x.js`；
   `tests/**` 里对应测试改成 `lib/host/x.js`。测试断言一条都不许改/删。
5. 跑 `pnpm build:host && pnpm verify`，必须全绿再提交。一个文件一个 commit（可合并同批多个文件）。

## 迁移顺序（按依赖从叶子往上）

1. 纯函数/无依赖：`r5.mjs`、`models.mjs`、`http.mjs`、`annotate.mjs`、`schedule.mjs`
2. 存储层：`store/schema.mjs` → `store/words.mjs` / `store/review.mjs` / `store/settings.mjs` → `store.mjs`
3. 服务层：`dict.mjs`、`translate.mjs`、`lookup.mjs`、`enrich/*.mjs`、`enrich.mjs`、`ai-enrich.mjs`、`service.mjs`
4. 组合层：`routes/*.mjs` → `runtime.mjs` → `index.js`
5. 收尾：`package.json` 的 `main`/`exports["."]` → `./lib/host/index.js`；
   eslint/depcruise 忽略 `lib/host/**`（构建产物不 lint）；删除 `tsconfig.json` 里对 lib 的排除说明。

## 完成判据

- `lib/*.mjs` 与 `lib/**/*.mjs` 全部消失（只剩构建产物 `lib/host/**`）。
- `pnpm verify` 全绿，`pnpm typecheck` 覆盖宿主 TS，`node --test` 数量不减少。
- 宿主 API 行为不变：22 条路由的 `scripts/test-*.mjs` 全通过（真机验收见阶段 3 收尾）。
