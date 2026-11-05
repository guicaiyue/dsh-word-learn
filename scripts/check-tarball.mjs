// scripts/check-tarball.mjs —— 发布前检查「打出来的包里到底有什么」。
//
// 为什么需要它：`pnpm verify` 只证明**工作区**是对的，证明不了 tarball 是对的。
// 这个插件最容易在发布时坏掉的两个点恰好都在打包边界上：
//   1. 客户端产物 `dist/client.js` 与宿主编译产物 `lib/host/**` 都是构建产物，`files` 漏了就是
//      装上后白屏/插件加载失败（而且本地怎么跑都是绿的）；
//   2. 开发文件（tests/ src/ prompts/ .scratch/）混进包会让体积翻倍，还可能带出测试数据。
//
// 做法：真的 `pnpm pack` 出一个 tgz，列内容做断言，然后删掉。不发网络、不写用户库。
//
// 用法：node scripts/check-tarball.mjs            # 打包并检查
//       node scripts/check-tarball.mjs --keep     # 保留 tgz 便于人工解包看
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const keep = process.argv.includes('--keep')

/** 打包到临时目录，返回 tgz 路径。 */
function pack() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-pack-'))
  // Windows 上 pnpm 是 .cmd，只能经 shell 调（Node 会打印一条 DEP0190 告警，无副作用）。
  const res = spawnSync('pnpm', ['pack', '--pack-destination', out], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (res.status !== 0) {
    console.error('[tarball] pnpm pack 失败：')
    console.error(res.stdout || '', res.stderr || '')
    process.exit(1)
  }
  const tgz = fs.readdirSync(out).find((n) => n.endsWith('.tgz'))
  if (!tgz) {
    console.error('[tarball] pnpm pack 没有产出 .tgz')
    process.exit(1)
  }
  return { dir: out, tgz: path.join(out, tgz) }
}

/** 用 tar 列出包内文件（tar 在 Windows 10+ / Linux / macOS 都是现成的）。 */
function listing(tgz) {
  // 用 cwd + 文件名：Windows 的 bsdtar 会把 `C:\...` 当成「远程主机 C」，必须给相对路径。
  const res = spawnSync('tar', ['-tzf', path.basename(tgz)], {
    cwd: path.dirname(tgz),
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    console.error('[tarball] tar 解不开产物：', res.stderr || res.stdout)
    process.exit(1)
  }
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^package\//, ''))
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const { dir, tgz } = pack()
  const files = listing(tgz)
  const set = new Set(files)

  const failures = []
  const check = (ok, why) => {
    console.log(`[tarball] ${ok ? '✓' : '✗'} ${why}`)
    if (!ok) failures.push(why)
  }

  // 1) 入口必须存在，且与 package.json 声明一致（main 指向的文件真在包里）
  const entries = [pkg.main, ...Object.values(pkg.exports || {})].filter(
    (p) => typeof p === 'string' && !p.includes('*'),
  )
  for (const entry of new Set(entries.map((p) => p.replace(/^\.\//, '')))) {
    check(set.has(entry), `entry 在包里：${entry}`)
  }

  // 2) 客户端产物必须在（白屏第一嫌疑）
  check(set.has('dist/client.js'), '客户端产物 dist/client.js')
  check(
    files.some((f) => f.startsWith('dist/client.js.map')),
    '客户端 sourcemap（外部 v3，DSH 允许的唯一形式）',
  )

  // 3) 宿主侧至少要有一个编译产物或源码入口（阶段 3 迁移中两者之一）
  check(
    files.some((f) => f.startsWith('lib/')) || files.some((f) => f.startsWith('src/host/')),
    '宿主入口（lib/** 或 src/host/**）',
  )

  // 4) 运行时资源
  check(set.has('cordis.patch.yml'), '挂载声明 cordis.patch.yml')
  check(set.has('icon.svg'), '图标 icon.svg')
  check(set.has('data/ecdict.db'), '词典 data/ecdict.db')
  check(
    ['locale/zh.json', 'locale/en.json'].every((f) => set.has(f)),
    '语言包 locale/{zh,en}.json',
  )

  // 5) 开发文件不许混进来（体积 + 数据泄漏）
  for (const bad of ['tests/', 'src/', 'scripts/', 'prompts/', '.scratch/', 'docs/']) {
    check(!files.some((f) => f.startsWith(bad)), `不含开发目录 ${bad}`)
  }

  // 6) 体积上限：产物预算已在 artifact:check 管；这里只兜「整包畸大」（15M 词典 + 约 1M 产物）
  const sizeMb = fs.statSync(tgz).size / 1024 / 1024
  check(sizeMb < 60, `整包体积 ${sizeMb.toFixed(1)}MB < 60MB`)

  console.log(
    `\n[tarball] ${failures.length ? `✗ ${failures.length} 项失败` : `✓ ${files.length} 个文件，全部检查通过`}`,
  )
  if (keep) console.log(`[tarball] 保留产物：${tgz}`)
  else fs.rmSync(dir, { recursive: true, force: true })
  if (failures.length) process.exit(1)
}

main()
