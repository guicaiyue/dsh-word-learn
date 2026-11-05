import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-word-learn'

/**
 * DSH 浏览器模块表（baseline externals）。
 *
 * 来源：`dsh-web-frontend/dist/assets/index-*.js` 的 staticModules 种子表（11 个）。
 * 这些模块只能从宿主 `require` 取，绝不能打进产物 —— 打进去就是第二份 React，
 * 上下文/插槽全部对不上。
 *
 * `dsh.client.external` 只声明**非 baseline** 的其它插件客户端包，不是这些。
 */
const BASELINE_EXTERNALS = [
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

// 与 dsh-client-modules/lib/client.js:1-7 的官方壳逐字同形。
// 产物是**经典 script + 单个 lazy CJS factory**，不是 ESM：宿主按 `;\n` 拼接多个
// bundle，出现顶层 import/export 会直接把后续脚本全部带崩。
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
  // CJS：产物形态是「工厂壳 + 经典脚本」，format 必须是 cjs（见上）。
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // 宿主只认外置 `<clientPath>.map`（v3，带 sourcesContent）；inline 无效。
  sourcemap: true,
  // 保持可读 + sourcemap 行号稳定；体积靠预算而不是压缩。
  minify: false,
  clean: true,
  dts: false,
  // tsdown/tsup 会把 package.json dependencies 自动 external 化 —— 客户端一旦
  // 误 require 了非 seed 的包，运行期就是 `missed the module table`。这里显式
  // 只外置 11 个 seed，其余一律打进产物。
  deps: { neverBundle: BASELINE_EXTERNALS },
  // cjs 格式默认按 Node 处理，会把 browser 平台判断覆盖掉；显式声明仍是浏览器。
  inputOptions: { platform: 'browser' },
  // package "type": "module" 下默认会出 .cjs，必须显式要 .js。
  outExtensions: () => ({ js: '.js' }),
  banner,
  footer,
})
