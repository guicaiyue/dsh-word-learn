import js from '@eslint/js'
import globals from 'globals'

/**
 * dsh-word-learn 静态检测配置（ESLint flat config）。
 *
 * 原则：ESLint 只管「正确性 + 架构边界 + 体量预算」，排版一律交给 Prettier。
 * 这样 AI 改代码时，报错信息是「你做错了什么」，而不是「你怎么排的版」。
 *
 * 三条硬边界靠配置守，不靠记忆：
 *   1. assets/ 是注入页面的普通脚本（IIFE），不许 ESM、不许 import、不许 Node API；
 *   2. lib/ 是宿主侧 ESM，不许 import assets/（反过来 assets 也不许 import lib/）；
 *   3. 每个文件有代码行预算，新文件默认 400 行，超了应当拆模块，而不是把预算往上调；
 *   4. 模块之间不许出现 import 环：由 scripts/check-cycles.mjs 在 check 阶段守着（ESLint 10 下没有可靠的环检测插件）。
 *
 * 新增依赖前先读 CONVENTIONS.md「依赖」一节：本插件刻意保持零构建。
 */

/** 每个文件的代码行预算（去空行、去注释）。新增文件不写在这里就吃默认 400。 */
const CODE_BUDGET = {
  default: 400,
  files: {
    'lib/index.js': 210,
    'lib/store.mjs': 800,
    'lib/ai-enrich.mjs': 620,
    'lib/r5.mjs': 380,
    'lib/schedule.mjs': 300,
    'lib/dict.mjs': 260,
    'assets/dashboard.js': 3900,
    'assets/annotate.js': 1300,
    'assets/wordcard.js': 1220,
    'scripts/test-routes.mjs': 680,
    'scripts/test-r5.mjs': 590,
    'scripts/test-annotate.mjs': 590,
  },
}

/** max-lines 按「代码行」算：空行与注释不计，避免注释写多了就报警。 */
function budget(max) {
  return ['error', { max, skipBlankLines: true, skipComments: true }]
}

const budgetOverrides = Object.entries(CODE_BUDGET.files).map(([file, max]) => ({
  files: [file],
  rules: { 'max-lines': budget(max) },
}))

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

const browserZone = {
  languageOptions: {
    ecmaVersion: 'latest',
    // assets/ 是 <script> 直接注入的普通脚本，不是 ES 模块
    sourceType: 'script',
    globals: { ...globals.browser },
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
      'scripts/test-annotate-fixture/**',
      '**/*.min.js',
    ],
  },

  // ---- 宿主侧：Node ESM ------------------------------------------------------
  {
    files: ['lib/**/*.{js,mjs}'],
    ...nodeZone,
    rules: {
      ...baseRules,
      'max-lines': budget(CODE_BUDGET.default),
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/assets/**', '../assets/**', './assets/**'],
              message: '宿主侧不许 import assets/：那是注入页面的普通脚本（IIFE），不是模块。',
            },
          ],
        },
      ],
    },
  },

  // ---- 浏览器侧：注入页面的普通脚本 -------------------------------------------
  {
    files: ['assets/**/*.js'],
    ...browserZone,
    rules: {
      ...baseRules,
      'max-lines': budget(CODE_BUDGET.default),
      // script 模式下 import/export 本身就是语法错误；require 则是未定义全局
      'no-restricted-globals': [
        'error',
        { name: 'require', message: 'assets/ 是浏览器脚本，没有 require。' },
        { name: 'module', message: 'assets/ 是浏览器脚本，没有 CommonJS module。' },
        { name: 'process', message: 'assets/ 是浏览器脚本，没有 process。' },
      ],
    },
  },

  // ---- 测试脚本：Node ESM ----------------------------------------------------
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    ...nodeZone,
    rules: {
      ...baseRules,
      'max-lines': budget(CODE_BUDGET.default),
      'no-console': 'off',
    },
  },

  // ---- 配置与构建脚本 --------------------------------------------------------
  {
    files: ['*.config.js', '*.config.mjs', 'eslint.config.js', 'scripts/*.mjs'],
    ...nodeZone,
  },

  // ---- 单文件体量预算（覆盖上面的默认值） ------------------------------------
  ...budgetOverrides,
]
