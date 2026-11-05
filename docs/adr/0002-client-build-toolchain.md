# ADR-0002：客户端构建工具选型 —— tsdown

- 状态：提议（等待用户批准；实测数据见 `docs/audit/2026-11-05-static-gates-audit.md` §5 与 `.scratch/audit/build.md`）
- 日期：2026-11-05
- 相关：ADR-0001、ADR-0003、ADR-0006

## 背景

解除零构建后需要选一个工具，产出 DSH 客户端加载器接受的单一 lazy factory，并满足 sourcemap、React external、watch 增量等要求。

平台契约（源码证据）：

- `@deepseek-ai/dsh-client-modules/lib/index.js:165`：注释原文「Source-map trailer emitted by tsdown at the end of every client bundle」；`:271-282` 读取 `<clientPath>.map` 并校验 Source Map v3；`:343-367` 合成为 indexed map 后按 combo URL 提供。**只认外置 map，inline 无效。**
- `:463-481` 引导协议：`window.__ModuleLoader__.load({id, factory})`，factory 惰性物化，React 从模块表 `require('react')` 取；宿主按 `;\n` 拼接多个 bundle，**产物不能有顶层 ESM**。
- baseline externals 共 11 个（`dsh-web-frontend/dist/assets/index-BXV-oxvX.js:190`）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
- `dsh.client.external` 只声明**非 baseline 的其它插件客户端包**，不是 React。
- 官方模板 `templates/decoration/client.js` 与社区产物（dsh-armory/dsh-context）同形。

平台自身的构建工具就是 tsdown：**77/77** 个带 bundle 脚本的官方客户端包都用它。

## 决策

客户端用 **tsdown** 构建 `src/client/entry.ts` → `dist/client.js` + `dist/client.js.map`；宿主用 **tsc**（`src/host/**` → `dist/host/**`，保留文件结构、不打包），理由见 ADR-0001。

```ts
// tsdown.config.ts（阶段 1 落地）
import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-word-learn'

/** DSH 浏览器模块表（baseline externals）：只能从宿主取，绝不能打进产物。 */
const BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

// 与 dsh-client-modules/lib/client.js:1-7 的官方壳逐字同形
const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PLUGIN_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const footer = `\t\treturn module.exports;
\t}
});
`

export default defineConfig({
  entry: { client: 'src/client/entry.ts' },
  outDir: 'dist',
  format: 'cjs', // 关键：产物是「工厂壳 + 经典脚本」，不是 ESM
  platform: 'browser',
  target: 'es2022',
  sourcemap: true, // 产出 dist/client.js.map（宿主只认外置 map）
  minify: false, // 保持可读 + sourcemap 行号稳定
  clean: true,
  dts: false,
  external: BASELINE, // 只外置 seed
  noExternal: ['ts-fsrs'], // 见下：客户端若真要用运行时依赖，必须显式收进来
  outExtensions: () => ({ js: '.js' }), // package type=module 时默认会出 .cjs
  banner,
  footer,
})
```

`src/client/entry.ts` 只写 `export { inject, apply }`（或 `export default { inject, apply }`），**不写 `__ModuleLoader__` 壳**；壳由 banner/footer 生成。现有 `assets/dashboard.js` 已手写壳（`:70`），阶段 1 搬运时必须删除，否则「壳套壳」→ factory 返回 undefined → loader 端 `exports.apply` 缺失。

`package.json`：

```jsonc
{
  "exports": { "./client": "./dist/client.js" },
  "files": [
    "lib",
    "dist",
    "assets",
    "data",
    "locale/*.json",
    "icon.svg",
    "cordis.patch.yml",
    "README.md",
  ],
  "scripts": { "build": "tsdown && tsc -p tsconfig.host.json", "dev": "tsdown --watch" },
}
```

## 实测依据（203 KB 输入、8 模块 + 双入口、各 3 次取中位）

| 工具               |    冷构建 |                watch | raw / gzip      | 契约              |
| ------------------ | --------: | -------------------: | --------------- | ----------------- |
| **tsdown 0.15.12** |  929.5 ms |               296 ms | 304.3 / 28.9 KB | ✅ 16 项全过      |
| tsup 8.5.1         | 1913.8 ms | 331 ms（吞首次编辑） | 310.7 / 28.8 KB | ✅                |
| esbuild 0.25.12    |  541.7 ms |               188 ms | 310.7 / 28.8 KB | ✅（需自写壳/尾） |
| vite 7.3.7         |   3956 ms | 734 ms（全量重打包） | 295.2 / 21.4 KB | ✅（壳被改名）    |

选 tsdown 的理由不是「最快」，而是**与部署工具链同源**：壳、map 尾部格式与官方 77 个包零漂移；且只有它的 DSH 共享 preset 能产出 `require.async("./client.<name>.js")` 分块协议（未来拆大页面不必换工具）。HMR 端到端下限是 500ms 轮询，296ms vs 188ms 的差距用户无感。

## 关键陷阱（实测）

1. **tsdown/tsup 会自动把 `dependencies` external 化**：第一次跑产物里出现 `require("ts-fsrs")`，而 ts-fsrs 不在 seed 表 → 运行期 `missed the module table`。必须 `external` 只列 11 个 seed，并用 `noExternal` 把需要的运行时依赖收进来。
2. **`ts-fsrs` 不应进客户端**（+82 KB raw / +18.4 KB gzip）：排期计算只发生在宿主侧，客户端只消费服务端算好的队列。
3. banner/footer 里的 `require` 形参名不保证稳定（vite/rollup 会改写成 `require2` 并同步改 body）——tsdown 保持原样；产物检查脚本要断言 factory 形参与 body 的 external 调用同名。

## 后果

- 产物必须是单文件；`dsh.client.external` 保持不声明。
- `pnpm build` 失败/缺失时 DSH 激活会明确报错（平台原文 `run pnpm run build before launch`），不会静默坏掉。
- `scripts/check-artifact.mjs`（阶段 1）校验：仅一个 `__ModuleLoader__.load`、id=包名、factory 形参 `require`、返回 `{inject, apply}`、无 `node:`、gzip ≤ 100 KB。

## 备选方案

- **esbuild**：性能最好（541ms / 188ms），但壳与 map 尾部要自维护、无分块协议、官方格式一旦微调就得跟。若 tsdown 不可用，它是唯一能打的备选。
- **tsup**：能力等价但慢一倍、watch 有「吞首次编辑」缺陷，已被 tsdown 取代。
- **vite**：应用型工具，lib 模式做「经典脚本 + 手写壳」是逆着用（两趟进程、4s 冷构建、全量 rebuild）。

## 复审条件

- tsdown 大版本变更导致 sourcemap 尾部格式变化时，先验证加载器仍能剥离；不能则锁版本并在 CI 增加契约测试。
- 若客户端需要超过 1 个 chunk，评估 `require.async` 协议后再决定，不得回到多入口手拼。
