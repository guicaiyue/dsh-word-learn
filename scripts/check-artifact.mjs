// check-artifact.mjs —— 校验构建产物是否满足 DSH 客户端加载契约（CI / `pnpm verify` 用）。
//
// 为什么要有这一层：产物契约（单模块壳、只 require 宿主 seed、外置 sourcemap、
// 体积预算、运行期导出面）靠读源码确认不了。打包器一升级、external 配错一处，
// 就可能把第二份 React 打进产物，或者把产物变成 ESM —— 在浏览器里表现为
// `missed the module table` 或整段脚本带崩，而且构建本身是绿的。
//
// 所以契约写成可执行断言：
//   * `node scripts/check-artifact.mjs` 失败退出码 1，打印失败的具体断言名；
//   * tests/contract/client-bundle.test.mjs 复用同一批断言，并用合成坏样本验证
//     检查器真的会红（防止检查器自己假绿）。
//
// 断言对应 CONVENTIONS.md「客户端构建」：先加断言，再改产物。

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.join(HERE, '..')

/** 客户端产物及其外置 sourcemap（相对仓库根）。 */
export const BUNDLE_PATH = 'dist/client.js'
export const SOURCEMAP_PATH = 'dist/client.js.map'

/**
 * 宿主模块表的 11 个 baseline seed。
 *
 * 来源：dsh-web-frontend 产物里的 staticModules 种子表。客户端产物只能从这里
 * require；多一个就是运行期 `missed the module table`，少一个（被打进产物）就是
 * 第二份 React —— 上下文/插槽全对不上。
 */
export const BASELINE_SEEDS = [
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

/** 体积预算：超了先查是不是 seed 被打进来了，而不是直接调预算。 */
export const SIZE_BUDGET = { raw: 400 * 1024, gzip: 100 * 1024 }

/**
 * sourcemap sources 必须覆盖的源文件。
 *
 * 为什么不要求 `src/client/entry.ts`：entry 只做 re-export（见 src/client/entry.ts），
 * rolldown 不为其生成任何代码，因此 sources 里只有真正产出代码的 `plugin.js`。
 * 这是构建的正确行为，不是产物违约；要让 entry 进 map 得让它本身有语句。
 */
export const REQUIRED_SOURCES = ['src/client/plugin.js']

/** 契约断言的固定名字：失败信息、测试名、文档都用这一份。 */
export const CHECK_NAMES = [
  'loader-call-single',
  'module-id-matches-package-name',
  'factory-param-require',
  'require-react',
  'requires-only-baseline-seeds',
  'no-node-specifier',
  'no-top-level-esm',
  'sourcemap-annotation',
  'sourcemap-external-v3',
  'sourcemap-covers-required-sources',
  'sourcemap-sources-usable',
  'size-budget',
  'runtime-factory',
]

const LOADER_CALL = /window\.__ModuleLoader__\.load\(/g
const REQUIRE_CALL = /require\(\s*['"]([^'"]+)['"]\s*\)/g

function fail(message) {
  throw new Error(message)
}

/** 跑一条断言，把结果收进 results；fn 抛错 = 断言失败。 */
function check(results, name, fn) {
  try {
    results.push({ name, ok: true, detail: fn() || '' })
  } catch (err) {
    results.push({ name, ok: false, detail: err.message })
  }
}

function readText(root, rel) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) fail(`缺少 ${rel}（先跑 pnpm build）`)
  return fs.readFileSync(abs, 'utf8')
}

/** 抽产物里所有 `require("x")` 的 x（按出现顺序，保留重复）。 */
export function collectRequires(code) {
  return [...code.matchAll(REQUIRE_CALL)].map((match) => match[1])
}

/** 找行首的顶层 `import ` / `export `：经典 script 里出现就是语法错误。 */
export function findTopLevelEsm(code) {
  const bad = []
  code.split('\n').forEach((line, i) => {
    if (/^(?:import|export)\s/.test(line)) bad.push(`第 ${i + 1} 行：${line.trim().slice(0, 60)}`)
  })
  return bad
}

/** 从模块壳里取 id 与 factory 形参名；只解析 banner 部分。 */
export function parseLoaderShell(code) {
  const calls = [...code.matchAll(LOADER_CALL)]
  if (calls.length !== 1) {
    fail(`window.__ModuleLoader__.load( 出现 ${calls.length} 次，期望恰好 1 次`)
  }
  const head = code.slice(calls[0].index, calls[0].index + 2000)
  const id = /\bid:\s*['"]([^'"]+)['"]/.exec(head)
  if (!id) fail('模块壳里找不到 id')
  const factory = /factory:\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/.exec(head)
  if (!factory) fail('模块壳里找不到 factory: (require) => ...')
  return { id: id[1], factoryParam: factory[1] }
}

/**
 * 造一个 seed require 桩：baseline id 返回 React 替身，其余 id 按宿主行为抛错。
 * 只用不执行 render 的模块初始化，所以替身给最常用的几个钩子即可。
 */
export function makeSeedRequire() {
  const react = new Proxy(function reactStub() {}, {
    get(_target, key) {
      if (key === 'default') return react
      if (key === '__esModule') return true
      return () => undefined
    },
  })
  const seeds = new Map(BASELINE_SEEDS.map((id) => [id, react]))
  return function requireSeed(id) {
    if (!seeds.has(id)) throw new Error(`missed the module table: ${id}`)
    return seeds.get(id)
  }
}

/** 在假 window 里执行产物，返回登记给 __ModuleLoader__ 的那个模块描述。 */
function loadRegistration(code) {
  const registered = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registered.push(registration) } },
  }
  vm.runInNewContext(code, sandbox, { filename: BUNDLE_PATH, timeout: 10_000 })
  if (registered.length !== 1) fail(`产物执行后登记了 ${registered.length} 个模块，期望 1 个`)
  return registered[0]
}

/**
 * client-bundle 契约。
 *
 * @param {object} [input]
 * @param {string} [input.root] 仓库根
 * @param {string} [input.code] 覆盖产物文本（测试传合成坏样本）
 * @param {string} [input.mapText] 覆盖 sourcemap 文本
 * @param {string} [input.pkgName] 覆盖 package.json name
 * @returns {{checks: {name: string, ok: boolean, detail: string}[], stats: object}}
 */
export function checkClientBundle(input = {}) {
  const root = input.root || ROOT
  const code = input.code ?? readText(root, BUNDLE_PATH)
  const results = []
  const stats = {
    raw: Buffer.byteLength(code, 'utf8'),
    gzip: zlib.gzipSync(Buffer.from(code, 'utf8')).length,
    requires: collectRequires(code),
  }

  const packageName = () => {
    if (input.pkgName) return input.pkgName
    return JSON.parse(readText(root, 'package.json')).name
  }

  const readMap = () => {
    const text = input.mapText ?? readText(root, SOURCEMAP_PATH)
    let map
    try {
      map = JSON.parse(text)
    } catch (err) {
      fail(`${SOURCEMAP_PATH} 不是合法 JSON：${err.message}`)
    }
    if (!map || typeof map !== 'object' || !Array.isArray(map.sources)) {
      fail(`${SOURCEMAP_PATH} 不是合法的 v3 sourcemap（缺 sources 数组）`)
    }
    return map
  }

  check(results, 'loader-call-single', () => {
    const count = [...code.matchAll(LOADER_CALL)].length
    if (count !== 1) fail(`window.__ModuleLoader__.load( 出现 ${count} 次，期望恰好 1 次`)
    return '1 个模块壳'
  })

  check(results, 'module-id-matches-package-name', () => {
    const { id } = parseLoaderShell(code)
    const expected = packageName()
    if (id !== expected) fail(`产物 id = ${JSON.stringify(id)}，package.json name = ${expected}`)
    return `id = ${id}`
  })

  check(results, 'factory-param-require', () => {
    const { factoryParam } = parseLoaderShell(code)
    if (factoryParam !== 'require') fail(`factory 形参名是 ${factoryParam}，期望 require`)
    return 'factory: (require) => ...'
  })

  check(results, 'require-react', () => {
    const requires = collectRequires(code)
    if (!requires.includes('react')) {
      fail(`没有 require("react")（实际 require：${requires.join(', ') || '无'}）`)
    }
    return `require("react") ${requires.filter((id) => id === 'react').length} 处`
  })

  check(results, 'requires-only-baseline-seeds', () => {
    const bad = collectRequires(code).filter((id) => !BASELINE_SEEDS.includes(id))
    if (bad.length) fail(`require 了非 baseline seed：${[...new Set(bad)].join(', ')}`)
    return `require 仅涉及 baseline seed（${new Set(stats.requires).size} 种）`
  })

  check(results, 'no-node-specifier', () => {
    if (code.includes('node:')) fail('产物里出现 node: 说明符（客户端不加载 Node 内置模块）')
    return '无 node: 说明符'
  })

  check(results, 'no-top-level-esm', () => {
    const bad = findTopLevelEsm(code)
    if (bad.length) fail(`产物含顶层 import/export：${bad.join('；')}`)
    return '无顶层 import/export'
  })

  check(results, 'sourcemap-annotation', () => {
    const tail = code.trimEnd().split('\n').at(-1) || ''
    if (tail !== '//# sourceMappingURL=client.js.map') {
      fail(`末行不是 //# sourceMappingURL=client.js.map（实际：${tail.slice(0, 80)}）`)
    }
    return tail
  })

  check(results, 'sourcemap-external-v3', () => {
    const map = readMap()
    if (map.version !== 3) fail(`sourcemap version = ${map.version}，期望 3`)
    if (map.sources.length === 0) fail('sourcemap sources 为空')
    return `v${map.version}，${map.sources.length} 个 source`
  })

  check(results, 'sourcemap-covers-required-sources', () => {
    const map = readMap()
    const normalized = map.sources.map((source) => String(source).replaceAll('\\', '/'))
    const missing = REQUIRED_SOURCES.filter(
      (required) =>
        !normalized.some((source) => source === required || source.endsWith(`/${required}`)),
    )
    if (missing.length) fail(`sourcemap 未覆盖：${missing.join(', ')}`)
    return normalized.join(', ')
  })

  check(results, 'sourcemap-sources-usable', () => {
    const map = readMap()
    const mapDir = path.dirname(path.join(root, SOURCEMAP_PATH))
    const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : []
    const broken = []
    map.sources.forEach((source, i) => {
      const raw = String(source)
      // sourcesContent 已内嵌源码时，宿主不需要再取文件；否则必须能找到真实文件。
      if (typeof contents[i] === 'string' && contents[i]) return
      const abs = path.resolve(mapDir, raw)
      if (!fs.existsSync(abs)) broken.push(raw)
    })
    if (broken.length)
      fail(`sourcemap 里这些 source 既无 sourcesContent 也找不到文件：${broken.join(', ')}`)
    return `${map.sources.length} 个 source 可解析`
  })

  check(results, 'size-budget', () => {
    const over = []
    if (stats.raw > SIZE_BUDGET.raw) over.push(`raw ${stats.raw}B > ${SIZE_BUDGET.raw}B`)
    if (stats.gzip > SIZE_BUDGET.gzip) over.push(`gzip ${stats.gzip}B > ${SIZE_BUDGET.gzip}B`)
    if (over.length) fail(`体积超预算：${over.join('，')}`)
    return `${stats.raw}B raw / ${stats.gzip}B gzip`
  })

  check(results, 'runtime-factory', () => {
    const registration = loadRegistration(code)
    if (typeof registration.factory !== 'function') fail('登记的 factory 不是函数')
    let moduleExports
    try {
      moduleExports = registration.factory(makeSeedRequire())
    } catch (err) {
      fail(`factory 用 seed 桩调用时抛错：${err.message}`)
    }
    if (
      !moduleExports ||
      (typeof moduleExports !== 'object' && typeof moduleExports !== 'function')
    ) {
      fail('factory 没有返回 module.exports 对象')
    }
    if (typeof moduleExports.apply !== 'function') {
      fail(`exports.apply 不是函数（实际 ${typeof moduleExports.apply}）`)
    }
    if (!Array.isArray(moduleExports.inject)) {
      fail(`exports.inject 不是数组（实际 ${typeof moduleExports.inject}）`)
    }
    return `apply(函数) / inject(${moduleExports.inject.length} 项) 就绪`
  })

  return { checks: results, stats }
}

const LOCALE_FILES = ['locale/zh.json', 'locale/en.json']

/** 深度展平成 `a.b.c` → 叶子值；数组视作叶子。 */
export function flattenLocale(value, prefix = '', out = new Map()) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenLocale(child, prefix ? `${prefix}.${key}` : key, out)
    }
  } else {
    out.set(prefix, value)
  }
  return out
}

/**
 * locale 契约：中英键集合完全一致，且没有空字符串文案（空串在界面上就是「消失」）。
 *
 * @param {object} [input]
 * @param {string} [input.root] 仓库根
 * @param {string|object} [input.zh] 覆盖 zh.json
 * @param {string|object} [input.en] 覆盖 en.json
 */
export function checkLocale(input = {}) {
  const root = input.root || ROOT
  const results = []

  const parse = (rel) => {
    const given = rel === LOCALE_FILES[0] ? input.zh : input.en
    if (given !== undefined && typeof given === 'object' && given !== null) return given
    const text = typeof given === 'string' ? given : readText(root, rel)
    try {
      return JSON.parse(text)
    } catch (err) {
      fail(`${rel} 不是合法 JSON：${err.message}`)
    }
  }

  check(results, 'locale-files-parse', () => {
    for (const rel of LOCALE_FILES) {
      const data = parse(rel)
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail(`${rel} 不是 JSON 对象`)
    }
    return `${LOCALE_FILES.join(' / ')} 可解析`
  })

  const flattened = () =>
    new Map([
      [LOCALE_FILES[0], flattenLocale(parse(LOCALE_FILES[0]))],
      [LOCALE_FILES[1], flattenLocale(parse(LOCALE_FILES[1]))],
    ])

  check(results, 'locale-key-sets-equal', () => {
    const [zh, en] = [...flattened().values()]
    const zhKeys = [...zh.keys()].sort()
    const enKeys = [...en.keys()].sort()
    const missingEn = zhKeys.filter((key) => !en.has(key))
    const missingZh = enKeys.filter((key) => !zh.has(key))
    if (missingEn.length || missingZh.length) {
      const parts = []
      if (missingEn.length) parts.push(`en 缺 ${missingEn.join(', ')}`)
      if (missingZh.length) parts.push(`zh 缺 ${missingZh.join(', ')}`)
      fail(`键集合不一致：${parts.join('；')}`)
    }
    if (zhKeys.length === 0) fail('locale 展平后没有任何键')
    return `${zhKeys.length} 个键两端一致`
  })

  check(results, 'locale-no-empty-values', () => {
    const empty = []
    for (const [rel, flat] of flattened()) {
      for (const [key, value] of flat) {
        if (typeof value === 'string' && value.trim() === '') empty.push(`${rel}#${key}`)
      }
    }
    if (empty.length) fail(`存在空字符串文案：${empty.join(', ')}`)
    return '无空字符串值'
  })

  return { checks: results }
}

/** 跑全部契约检查（CI 入口；测试里也用它保证「脚本与单测同一份真相」）。 */
export function runArtifactChecks(root = ROOT) {
  const bundle = checkClientBundle({ root })
  const locale = checkLocale({ root })
  return { bundle, locale, all: [...bundle.checks, ...locale.checks] }
}

function formatBytes(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`
}

function main() {
  const { bundle, all } = runArtifactChecks()
  console.log(
    `[artifact] ${BUNDLE_PATH}：${formatBytes(bundle.stats.raw)} raw / ${formatBytes(bundle.stats.gzip)} gzip` +
      `（预算 ${formatBytes(SIZE_BUDGET.raw)} / ${formatBytes(SIZE_BUDGET.gzip)}）`,
  )
  console.log(`[artifact] require：[${[...new Set(bundle.stats.requires)].join(', ')}]`)
  for (const item of all) {
    if (item.ok) {
      console.log(`[artifact] ✓ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
    } else {
      console.error(`[artifact] ✗ ${item.name} — ${item.detail}`)
    }
  }
  const failed = all.filter((item) => !item.ok)
  if (failed.length) {
    console.error(
      `[artifact] ✗ ${failed.length}/${all.length} 项契约失败：${failed.map((item) => item.name).join(', ')}`,
    )
    process.exitCode = 1
    return
  }
  console.log(`[artifact] ✓ ${all.length}/${all.length} 项契约检查通过`)
}

// 直接 `node scripts/check-artifact.mjs` 时跑全部检查；被测试 import 时不执行。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
