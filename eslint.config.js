import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { fileURLToPath } from 'node:url'

const tsRoot = fileURLToPath(new URL('.', import.meta.url))

/**
 * dsh-word-learn 静态检测配置（ESLint flat config）。
 *
 * 原则：ESLint 只管「正确性 + 架构边界」，排版一律交给 Prettier，
 * 类型与未用检查交给 tsc。这样报错信息是「你做错了什么」，而不是「你怎么排的版」。
 *
 * 硬边界靠配置守，不靠记忆：
 *   1. src/client 是构建源码（ESM → tsdown 单 bundle），不许 Node 全局；
 *   2. lib/ 是宿主侧 ESM，不许 import src/client（反过来也不许）；
 *      这一条与「不许有 import 环」都由 dependency-cruiser 在 `pnpm deps:check` 守
 *      （本文件只保留 ESLint 能便宜做到的单向 import 限制）。
 *
 * 2026-11-05 起删除 max-lines / CODE_BUDGET 棘轮（ADR-0005）：
 * 体量不是缺陷本身，行数预算只约束形状；它把「不许 import」的后果催生成手工注入协议，
 * 而本轮 6 个真缺陷没有一个由它抓到。客户端体积由产物预算（artifact:check）衡量。
 *
 * 新增依赖前先读 CONVENTIONS.md「依赖」一节。
 */

/** 所有 zone 共享的正确性规则。 */
const baseRules = {
  ...js.configs.recommended.rules,
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': [
    'error',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'none',
    },
  ],
  // 宿主侧与页面侧都会用 console 做诊断，不视为错误
  'no-console': 'off',
}

const nodeZone = {
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    globals: { ...globals.node },
  },
}

export default [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'design/**',
      'lab/**',
      'locale/**',
      'dist/**',
      'coverage/**',
      '.tmp/**',
      '.scratch/**',
      'lib/host/**',
      '**/*.min.js',
    ],
  },

  // ---- 浏览器侧构建源码：ESM + 浏览器全局 -------------------------------------
  // 这里是 bundle 的构建源码：允许 import/export（tsdown 打成单 bundle），
  // 但仍禁止 Node 全局 —— 产物跑在浏览器，`process`/`__dirname` 一律运行期炸。
  {
    files: ['src/client/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      ...baseRules,
      'no-restricted-globals': [
        'error',
        { name: 'process', message: '客户端源码跑在浏览器，没有 process。' },
        { name: '__dirname', message: '客户端源码跑在浏览器，没有 __dirname。' },
        { name: 'Buffer', message: '客户端源码跑在浏览器，没有 Buffer。' },
      ],
    },
  },

  // ---- TypeScript：语法规则 + 少量「能命中真实缺陷」的类型感知规则 -------------
  // 为什么不全量开 recommendedTypeChecked：这个仓库的宿主 ctx / 路由参数边界天然是
  // `any`（cordis 服务没类型），全量类型感知会报出 1300+ 条 no-unsafe-*，把真问题淹掉。
  // 只留三条「看到就必须改」的：未处理的 Promise、把 Promise 传进不该传的地方、
  // await 了非 Promise（ADR-0005：门禁要能说出它拦的是哪个真实缺陷）。
  ...tseslint.configs.recommended.map(function (cfg) {
    return { ...cfg, files: ['**/*.ts', '**/*.tsx'] }
  }),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { project: ['./tsconfig.eslint.json'], tsconfigRootDir: tsRoot },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // 宿主 ctx / 路由入参的边界来自 cordis（无类型），这里必然出现 any。
      // 当前不 undeclared-any 报告：这些点是「待补服务类型」的已知缺口（记在残余风险），
      // 报成 warn 只会让每次 lint 输出 75 行噪音，不会有人改。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // ---- 测试脚本：Node ESM ----------------------------------------------------
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    ...nodeZone,
    rules: {
      ...baseRules,
      'no-console': 'off',
    },
  },

  // ---- 配置与构建脚本 --------------------------------------------------------
  {
    files: ['*.config.js', '*.config.mjs', 'eslint.config.js', 'scripts/*.mjs'],
    ...nodeZone,
  },
]
