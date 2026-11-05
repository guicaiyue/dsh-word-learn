# ADR-0003：目录分层与依赖方向（前端单 bundle、宿主分层）

- 状态：提议（等待用户批准）
- 日期：2026-11-05
- 相关：ADR-0001、ADR-0002、ADR-0005

## 背景

当前结构按「文件大小」切分，而不是按职责与依赖方向：

- 宿主：`lib/routes/*` 直接 import `lib/runtime.mjs` 的进程级单例；`lib/lookup.mjs`（领域）反向 import `runtime`/`enrich`；`store/review.mjs` 与 `store/schema.mjs` import `schedule.mjs`。能用，但依赖方向没有声明，测试只能靠模块级 mock。
- 前端：`assets/` 里 8 个 IIFE 通过 `window.__dwl*` 互相消费，依赖关系只存在于注释和 `lib/index.js` 的 `SCRIPT_PATHS` 数组里；`dashboard.js` 里 20+ 处 `assetOf()` 在使用时读全局，等待 `dwl:assets-ready`。构建化后这些全局与顺序协议必须消失，改为真实 import。

## 决策

### 目标目录

```
src/
  shared/                 # 同构纯函数与类型：无 node、无 DOM、无 React
    types.ts
    text.ts               # 是不是单词/拆词/代码过滤
    params.ts             # clampInt / intParam / strParam 的纯实现
  host/
    entry.ts              # 插件 apply：栅栏 + registerRoute + 路由挂载 + dispose
    http/                 # fence.ts / register-route.ts / respond.ts / read-json.ts
    domain/               # schedule.ts / r5.ts / annotate-targets.ts（纯业务规则）
    store/                # schema.ts / words.ts / review.ts / settings.ts / store.ts
    infra/                # dict.ts（ecdict） / llm.ts（ctx.llm 适配）
    services/             # lookup.ts / translate.ts / models.ts / enrich/*
    routes/               # study / review / ai / repair / annotate（不再是 assets）
    composition.ts        # createRuntime(ctx)：组装 dict/store/queues，显式注入
  client/
    entry.ts              # 构建入口：导出 { inject, apply }
    plugin.ts             # apply：注册 slots + 安装 features + 样式 + 清理
    shared/               # dom.ts / events.ts / storage.ts / theme.ts
    features/
      wordcard/           # selection.ts(原 core) / card.ts(原 wordcard-card) / style.ts / index.ts
      annotate/           # annotate.ts / style.ts
      voice/              # voice.ts
    dashboard/
      page.ts             # slot 注册 + 页面装配
      views/              # study / vocab / stats / settings
      components/         # hover-word / write-panel / 通用 UI
      logic/              # 纯逻辑（原 dashboard-logic）
      styles.ts           # CSS 模板串（原 dashboard-style）
    api/                  # 仅此处 fetch；返回类型来自 shared/types
tests/
  unit/ component/ integration/ contract/
```

### 依赖方向（机器校验）

```
shared  ←  host/domain  ←  host/store  ←  host/services  ←  host/routes  ←  host/composition  ←  host/entry
shared  ←  client/shared ← client/api / client/features / client/dashboard ← client/plugin ← client/entry
```

铁律（`dependency-cruiser` + ESLint 双保险）：

1. `shared/**` 不 import 任何东西（除 type-only），不含 `node:*`、DOM、React。
2. `host/**` 与 `client/**` 互不 import。
3. `client/**` 不得 import `node:*` / `fs` / `path` / `node:sqlite`；不得读另一个插件的 DOM/组件。
4. `host/routes/**` 不得 import `composition` 单例；依赖由 `registerXxxRoutes(registerRoute, deps)` 传入（可测试性）。
5. `host/domain/**` 不得 import `store`/`routes`/`infra`；只依赖 `shared`。
6. 任何目录不得有 import 环（含 type-only 环、动态 import）。
7. `assets/` 目录在阶段 2 结束后删除，`lib/` 在阶段 3 结束后删除（迁移期允许两者共存，但新代码只写 `src/`）。

### 前端收敛方式

- 8 个注入脚本 → 8 个 ESM 模块，`client/plugin.ts` 的 `apply()` 里依次 `install(ctx)`，每个 install 返回 dispose；不再有 `window.__dwl*`、`s.async=false`、`assets-ready`、`whenAssetsReady`、`assetOf`、「正在加载」守门。React 组件直接 `import` 逻辑与样式模块。
- `lib/routes/assets.mjs` 的 8 条脚本路由、`lib/runtime.mjs` 的 mtime loader、`tapIndex` 兜底全部删除。30 条路由 → 22 条 API 路由。
- 能力收窄：`dsh.client.platform` 为 `web`，本插件只支持 Web；桌面端注入兜底随协议删除（记录于此，不在 README 里假装还支持）。

## 后果

- 阶段 2 是最大的一次机械搬运（约 5.3k 行前端），但每一步都可独立验证：每搬一个 feature，真机验证一次对应交互（划词/标注/学习页/语音），失败可单文件回滚。
- 宿主在阶段 3 前仍保留 `lib/**` 与 `runtime` 单例；`src/host` 目录在阶段 3 才出现，避免阶段 1–2 同时动宿主。
- 依赖规则先在阶段 1 以「最小集」上线（禁环 + client 纯度），随目录迁移逐步收紧，避免一次性全红。

## 备选方案

- **只做前端 bundle、宿主维持现状**：可行但达不到「分层」目标；作为阶段 2 的中间态保留。
- **按领域分包（host/client 各自多入口）**：DSH 客户端只允许一个 lazy factory，前端不可能多入口；宿主多入口没有收益。
- **保留 `lib/` 命名只加 `src/` 别名**：两套名字会长期漂移，不采用。
