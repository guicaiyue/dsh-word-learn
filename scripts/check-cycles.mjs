// check-cycles.mjs —— 静态检测 lib/ 内部（以及 tests/、scripts/ 对 lib 的引用）的 import 环。
//
// 为什么自己写：ESLint 10 下 eslint-plugin-import-x 的 no-cycle 实测不生效
// （造了 a.mjs ↔ b.mjs 的环，lint 依然全绿；v4.17.1 的 resolver-next 也没救）。
// 与其留一条假装在守的规则，不如用 30 行的图遍历：能自测、能报出完整环路径。
//
// 判据：node:test 里的 tests/unit/cycles.test.mjs 用假图验证了 findCycles 的正反例。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

/** 把相对 import 解析成仓库内绝对路径；解析不到（外部包）返回 null。 */
export function resolveImport(fromAbs, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromAbs), spec)
  const candidates = [base, base + '.mjs', base + '.js', path.join(base, 'index.mjs')]
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch (err) {
      /* 试下一个候选 */
    }
  }
  return null
}

/**
 * 抽出源码里的 import 说明符：静态 import（`import ... from 'x'` / `import 'x'`）
 * 和动态 `import('x')`。
 *
 * 动态 import 也算：运行时才会解析，但它同样构成依赖方向，
 * 环照样会让「谁依赖谁」失去方向（而且更难看出）。
 */
export function extractImports(code) {
  const specs = []
  const staticRe = /^\s*import\s+(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/gm
  let m
  while ((m = staticRe.exec(code))) specs.push(m[1])
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dynamicRe.exec(code))) specs.push(m[1])
  return specs
}

/**
 * 在「文件 → 依赖」图上找环。
 * @param {Map<string, string[]>} graph 绝对路径 → 依赖绝对路径数组
 * @returns {string[][]} 每个环一条路径（首尾同节点）
 */
export function findCycles(graph) {
  const cycles = []
  const seen = new Set()
  const visited = new Set()
  const stack = []
  const onStack = new Set()

  function dfs(node) {
    visited.add(node)
    stack.push(node)
    onStack.add(node)
    for (const next of graph.get(node) || []) {
      if (onStack.has(next)) {
        const at = stack.indexOf(next)
        const cycle = stack.slice(at).concat(next)
        // 同一个环从不同入口遍历出来是同一个环：按「去重后的节点集合」判重
        const key = [...new Set(cycle)].sort().join('|')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push(cycle)
        }
      } else if (!visited.has(next)) {
        dfs(next)
      }
    }
    stack.pop()
    onStack.delete(node)
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) dfs(node)
  }
  return cycles
}

/** 收集目录下所有源文件（默认 lib/，可传多个目录）。 */
export function collectFiles(dirs) {
  const files = []
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir)
    if (!fs.existsSync(abs)) continue
    for (const entry of fs.readdirSync(abs, { recursive: true })) {
      const p = path.join(abs, entry)
      if (/\.(mjs|js)$/.test(p) && fs.statSync(p).isFile()) files.push(p)
    }
  }
  return files
}

export function buildGraph(files) {
  const graph = new Map()
  for (const file of files) {
    const deps = []
    for (const spec of extractImports(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveImport(file, spec)
      if (resolved) deps.push(resolved)
    }
    graph.set(file, deps)
  }
  return graph
}

function main() {
  const files = collectFiles(['lib'])
  const graph = buildGraph(files)
  const cycles = findCycles(graph)
  if (!cycles.length) {
    console.log(`[cycles] ✓ ${files.length} 个 lib 文件无 import 环`)
    return
  }
  console.error(`[cycles] ✗ 发现 ${cycles.length} 个 import 环：`)
  for (const cycle of cycles) {
    console.error(
      '  ' + cycle.map((p) => path.relative(ROOT, p).split(path.sep).join('/')).join(' -> '),
    )
  }
  process.exitCode = 1
}

// 直接 `node scripts/check-cycles.mjs` 时跑全仓检查；被测试 import 时不执行。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
