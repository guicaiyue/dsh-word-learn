// scripts/test-all.mjs —— 全部手工回归脚本的唯一入口。
//
// 为什么要有它：scripts/test-*.mjs 原来是"记得哪个跑哪个"，没人一次跑全过；
// 而且这些脚本都会写 $DSH_HOME 下的用户库，串行 + 每个脚本独立临时 DSH_HOME
// 才是安全的跑法（并行会抢同一个库，真实用户库更不可碰）。
//
// 用法：
//   node scripts/test-all.mjs                 # 发现并串行跑全部
//   node scripts/test-all.mjs --filter r5     # 只跑文件名含 r5 的
//   node scripts/test-all.mjs --bail          # 首个失败立即停
//   node scripts/test-all.mjs --list          # 只列脚本，不跑
//
// 每个脚本自己也会设 DSH_HOME（幂等）；这里设的那份是给"忘了设"的脚本兜底，
// 进程退出后临时目录即删，不会留下第二份用户库。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SELF = path.basename(fileURLToPath(import.meta.url))
const TIMEOUT_MS = 240_000
const TAIL_LINES = 20

function usage(message) {
  if (message) console.error(`错误：${message}`)
  console.error('用法：node scripts/test-all.mjs [--filter <子串>] [--bail] [--list]')
}

/** 解析参数；非法输入直接抛错，由调用方打印用法。 */
function parseArgs(argv) {
  const options = { filter: '', bail: false, list: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bail') options.bail = true
    else if (arg === '--list') options.list = true
    else if (arg === '--filter' || arg.startsWith('--filter=')) {
      options.filter = arg === '--filter' ? argv[++i] || '' : arg.slice('--filter='.length)
      if (!options.filter) throw new Error('--filter 需要一个子串参数')
    } else {
      throw new Error(`未知参数 ${arg}`)
    }
  }
  return options
}

/** 发现所有 test-*.mjs（排除自己）；排序保证输出稳定、便于 diff。 */
function discover() {
  return fs
    .readdirSync(HERE)
    .filter((name) => name.startsWith('test-') && name.endsWith('.mjs') && name !== SELF)
    .sort()
}

function formatMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 只打失败脚本的尾部：完整输出动辄几百行，会淹掉汇总。 */
function printTail(output) {
  const lines = output.replace(/\r\n/g, '\n').trimEnd().split('\n')
  const tail = lines.slice(-TAIL_LINES)
  if (lines.length > tail.length) console.log(`  …（省略前 ${lines.length - tail.length} 行）`)
  for (const line of tail) console.log(`  │ ${line}`)
}

/** 跑一个脚本：独立临时 DSH_HOME + 240s 超时；返回退出码、耗时、合并输出。 */
function runScript(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-all-'))
  const started = Date.now()
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    const child = spawn(process.execPath, [path.join(HERE, name)], {
      cwd: ROOT,
      env: { ...process.env, DSH_HOME: home, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    const finish = (code, extra = '') => {
      clearTimeout(timer)
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        /* Windows 偶发句柄未释放：临时目录留给系统清理，不影响判定 */
      }
      resolve({ name, code, timedOut, ms: Date.now() - started, output: output + extra })
    }
    child.on('error', (err) => finish(1, String(err)))
    child.on('close', (code) => finish(code == null ? 1 : code))
  })
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (err) {
  usage(err.message)
  process.exit(1)
}

const needle = options.filter.toLowerCase()
const scripts = discover().filter((name) => !needle || name.toLowerCase().includes(needle))

if (options.list) {
  scripts.forEach((name, i) => console.log(`${String(i + 1).padStart(2, ' ')}. ${name}`))
  console.log(`共 ${scripts.length} 个脚本（--filter ${options.filter || '（无）'}）`)
  process.exit(0)
}

if (!scripts.length) {
  console.error(`没有匹配的 scripts/test-*.mjs（--filter ${options.filter || '（无）'}）`)
  process.exit(1)
}

console.log(`发现 ${scripts.length} 个回归脚本，串行执行（每个独立临时 DSH_HOME）\n`)

const results = []
for (let i = 0; i < scripts.length; i++) {
  const name = scripts[i]
  console.log(`[${i + 1}/${scripts.length}] ${name} …`)
  const result = await runScript(name)
  results.push(result)
  const label = result.code === 0 ? 'PASS' : 'FAIL'
  console.log(`[${i + 1}/${scripts.length}] ${name} ${label}（${formatMs(result.ms)}）`)
  if (result.code !== 0) {
    if (result.timedOut) console.log(`  ✗ 超过 ${TIMEOUT_MS / 1000}s，已被终止`)
    printTail(result.output)
    if (options.bail) {
      console.log('\n--bail：首个失败即停，剩余脚本未执行')
      break
    }
  }
}

const passed = results.filter((r) => r.code === 0).length
const failed = results.length - passed
const totalMs = results.reduce((sum, r) => sum + r.ms, 0)

console.log('\n=== 汇总 ===')
for (const r of results) {
  const label = r.code === 0 ? 'PASS' : 'FAIL'
  console.log(`${label}  ${formatMs(r.ms).padStart(7)}  ${r.name}`)
}
console.log(
  failed
    ? `\n${passed} 个通过，${failed} 个失败，总耗时 ${formatMs(totalMs)}`
    : `\n全部通过：${passed} 个脚本，总耗时 ${formatMs(totalMs)}`,
)
if (failed) process.exitCode = 1
