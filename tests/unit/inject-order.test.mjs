// 测什么：lib/index.js 的「注入链」静态契约 —— 脚本顺序 + async=false +
// paths.mjs 常量归口 + tapIndex 兜底。
//
// 为什么是静态读源码、不 import：lib/index.js 在模块顶层就 import 了
// runtime.mjs（打开词典/用户库单例），单测里 import 它等于把真实库摸一遍。
// 而这里要守的是「文本层面的顺序与写法」，读源码正好，也跑得最快。
//
// 为什么要有这道守卫（2026-11-05 真机事故）：动态 append 的 <script> 默认
// async=true，41KB 的 dashboard-style.js 可能晚于 client.js 执行，于是
// dashboard.js 的工厂拿到空的 window.__dwlDashboardCSS —— 页面完全没样式。
// 单测/回归脚本都是同步按序加载，天然发现不了这类顺序错误，只有真实浏览器会。
// 所以这里把「谁在谁前面」和「loader 必须 async=false」钉死。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = path.join(import.meta.dirname, '..', '..')
const INDEX_SRC = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
const PATHS_SRC = readFileSync(path.join(ROOT, 'lib', 'routes', 'paths.mjs'), 'utf8')

/** 取 `const NAME = ...` 这一段（到下一个空行为止），用于解析单段常量声明。 */
function declaration(src, name) {
  const start = src.indexOf(`const ${name} =`)
  assert.notEqual(start, -1, `lib/index.js 里找不到 \`const ${name}\` 声明，注入链可能被重写了`)
  const end = src.indexOf('\n\n', start)
  return src.slice(start, end === -1 ? src.length : end)
}

/** SCRIPT_PATHS 数组里的常量名，按声明顺序。 */
function scriptPathNames() {
  const block = declaration(INDEX_SRC, 'SCRIPT_PATHS')
  const names = block.match(/[A-Z][A-Z0-9_]*_PATH(?![A-Z_])/g) || []
  assert.ok(names.length >= 6, `SCRIPT_PATHS 至少应含 6 个脚本，实际解析到 ${names.join('、')}`)
  return names
}

/** paths.mjs 的 `export const X_PATH = '...'` 全量映射。 */
function pathConstants() {
  const map = {}
  for (const m of PATHS_SRC.matchAll(/export const ([A-Z][A-Z0-9_]*_PATH) = '([^']+)'/g)) {
    map[m[1]] = m[2]
  }
  return map
}

/** 顺序断言：失败时直接把当前完整顺序打出来，一眼看出谁排错了。 */
function assertBefore(list, first, second) {
  const a = list.indexOf(first)
  const b = list.indexOf(second)
  assert.ok(
    a !== -1 && b !== -1,
    `注入顺序缺少脚本：${a === -1 ? first : ''}${a === -1 && b === -1 ? ' 与 ' : ''}${b === -1 ? second : ''}（当前顺序：${list.join(' → ')}）`,
  )
  assert.ok(a < b, `注入顺序错误：${first} 应排在 ${second} 之前（当前顺序：${list.join(' → ')}）`)
}

describe('注入链（lib/index.js 静态契约）', () => {
  test('loader 显式 async=false：动态插入的脚本必须按插入顺序执行', () => {
    const inject = declaration(INDEX_SRC, 'INJECT_TEXT')
    assert.match(
      inject,
      /\.async=false/,
      '注入 loader 必须设置 s.async=false：动态插入的 <script> 默认 async=true，' +
        '大脚本（dashboard-style.js）可能晚于 client.js 执行，dashboard.js 会拿到空 CSS。',
    )
    assert.ok(!/\.async=true/.test(inject), '不允许把 .async 显式设回 true')
    // 设置顺序：先 src 再 async 再 onerror —— async 必须在 append 之前赋值才生效。
    assert.match(inject, /createElement\("script"\)/, 'loader 应动态创建 script 元素')
    assert.match(inject, /\.src=src/, 'loader 应设置 script.src')
    const srcAt = inject.indexOf('.src=src')
    const asyncAt = inject.indexOf('.async=false')
    const onerrorAt = inject.indexOf('.onerror')
    assert.ok(srcAt !== -1 && srcAt < asyncAt, 'async=false 必须在设置 src 之后赋值')
    assert.ok(
      asyncAt < onerrorAt,
      'async=false 应在挂 onerror 之前赋值（顺序不影响语义，但别打乱）',
    )
    assert.match(inject, /appendChild/, 'loader 应把 script 挂到文档上，否则不会加载')
  })

  test('INJECT_TEXT 按 SCRIPT_PATHS 的顺序逐条 load，不写死文件名、不另起清单', () => {
    const inject = declaration(INDEX_SRC, 'INJECT_TEXT')
    assert.match(
      inject,
      /SCRIPT_PATHS\.map\(/,
      'INJECT_TEXT 必须遍历 SCRIPT_PATHS 生成加载语句；否则「数组顺序」就不再等于「注入顺序」',
    )
    assert.match(
      inject,
      /load\("' \+ p \+ '"\)/,
      '每条脚本都必须走同一个 load()，不允许单独 append',
    )
    assert.equal(
      (inject.match(/SCRIPT_PATHS\.map\(/g) || []).length,
      1,
      'INJECT_TEXT 里只该有一份加载清单（SCRIPT_PATHS.map）；第二份清单会绕过顺序守卫',
    )
    assert.ok(
      !/\.js["']/.test(inject),
      'INJECT_TEXT 里不应出现写死的 .js 文件名：路径必须来自 paths.mjs 常量',
    )
  })

  test('关键脚本相对顺序：core → voice → dashboard-logic → dashboard-style → client → annotate', () => {
    const order = scriptPathNames()
    assert.equal(order[0], 'CORE_PATH', `core.js 必须最先注入（当前：${order.join(' → ')}）`)
    assert.equal(order[1], 'VOICE_PATH', `voice.js 应紧随 core.js（当前：${order.join(' → ')}）`)
    assertBefore(order, 'CORE_PATH', 'VOICE_PATH')
    assertBefore(order, 'VOICE_PATH', 'DASHBOARD_LOGIC_PATH')
    assertBefore(order, 'DASHBOARD_LOGIC_PATH', 'DASHBOARD_STYLE_PATH')
    assertBefore(order, 'DASHBOARD_STYLE_PATH', 'CLIENT_PATH')
    assertBefore(order, 'CLIENT_PATH', 'ANNOTATE_PATH')
  })

  test('注入脚本都能在 lib/routes/paths.mjs 找到同值常量（路径唯一出口）', () => {
    const order = scriptPathNames()
    const constants = pathConstants()
    const expected = {
      CORE_PATH: 'core.js',
      VOICE_PATH: 'voice.js',
      DASHBOARD_LOGIC_PATH: 'dashboard-logic.js',
      DASHBOARD_STYLE_PATH: 'dashboard-style.js',
      CLIENT_PATH: 'client.js',
      ANNOTATE_PATH: 'annotate.js',
    }
    for (const [name, file] of Object.entries(expected)) {
      assert.ok(order.includes(name), `SCRIPT_PATHS 缺少 ${name}（当前：${order.join(' → ')}）`)
      assert.equal(
        constants[name],
        `/dsh-word-learn/${file}`,
        `paths.mjs 的 ${name} 应指向 /dsh-word-learn/${file}，实际 ${constants[name]}`,
      )
    }
    // 以后新增脚本（如 wordcard 拆分）也必须走常量，不允许在 index.js 里拼字符串
    for (const name of order) {
      assert.ok(
        constants[name],
        `${name} 没有在 lib/routes/paths.mjs 里导出（注入脚本路径必须归口）`,
      )
    }
  })

  test('tapIndex 兜底：去掉 voice、条数与顺序继承 SCRIPT_PATHS', () => {
    const order = scriptPathNames()
    assert.ok(order.includes('VOICE_PATH'), 'SCRIPT_PATHS 应含 VOICE_PATH，兜底才谈得上"排除它"')
    const indexBlock = declaration(INDEX_SRC, 'INDEX_SCRIPT_PATHS')
    assert.match(
      indexBlock,
      /SCRIPT_PATHS\.filter\(\(p\) => p !== VOICE_PATH\)/,
      'tapIndex 兜底路径必须是 SCRIPT_PATHS 过滤掉 VOICE_PATH；手写数组会和注入链漂移',
    )
    const fallback = order.filter((name) => name !== 'VOICE_PATH')
    assert.equal(fallback.length, order.length - 1, '兜底条数必须比注入链少且仅少 voice')
    assert.deepEqual(
      fallback.slice(-2),
      ['CLIENT_PATH', 'ANNOTATE_PATH'],
      '兜底最后两条应是 client → annotate',
    )

    const tapAt = INDEX_SRC.indexOf('tapIndex(')
    assert.notEqual(tapAt, -1, 'lib/index.js 里找不到 tapIndex 兜底分支')
    const tap = INDEX_SRC.slice(tapAt)
    assert.match(
      tap,
      /INDEX_SCRIPT_PATHS\.map\(/,
      '兜底应遍历 INDEX_SCRIPT_PATHS，而不是自己再写一份',
    )
    assert.match(
      tap,
      /<script defer src="/,
      '兜底应输出 <script defer src>，defer 保证按文档顺序执行',
    )
    assert.match(
      tap,
      /html\.includes\(CLIENT_PATH\)/,
      '兜底应先用 CLIENT_PATH 判断页面是否已注入，避免重复加载',
    )
    assert.ok(!/VOICE_PATH/.test(tap), 'tapIndex 兜底历史上不含 voice.js，不要把排除项加回来')
  })
})
