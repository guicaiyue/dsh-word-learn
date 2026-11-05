// 产物契约测试 —— 保证 dist/client.js 真的满足 DSH 客户端加载契约。
//
// 为什么不在这里重写一遍检查逻辑：断言只在 scripts/check-artifact.mjs 里维护一份
// （CI 跑脚本，单测跑同一批断言的返回结果），避免「脚本绿、测试没覆盖」或两份真相
// 慢慢漂移。再用合成坏样本证明检查器真的会红 —— 否则检查器自己假绿，CI 绿得毫无意义。
//
// 与 tests/unit 的分工：unit 测源码行为；contract 测**构建产物形态**。产物形态不对时，
// 单测再绿插件也加载不起来（例如多打了一份 React、或出现顶层 import）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  BUNDLE_PATH,
  CHECK_NAMES,
  ROOT,
  checkClientBundle,
  collectRequires,
  findTopLevelEsm,
  parseLoaderShell,
} from '../../scripts/check-artifact.mjs'

const { checks, stats } = checkClientBundle()
const bundleCode = fs.readFileSync(path.join(ROOT, BUNDLE_PATH), 'utf8')

/** 断言某条契约检查存在且为绿；名字写错也要红，防止静默跳过。 */
function expectOk(name) {
  const item = checks.find((entry) => entry.name === name)
  assert.ok(item, `检查器里没有断言 ${name}`)
  assert.equal(item.ok, true, `${name} 失败：${item.detail}`)
  return item
}

/** 取某条断言在合成样本上的结果。 */
function resultOf(items, name) {
  const item = items.find((entry) => entry.name === name)
  assert.ok(item, `检查器里没有断言 ${name}`)
  return item
}

test('契约断言清单与 CHECK_NAMES 一致', () => {
  assert.deepEqual(
    checks.map((item) => item.name),
    CHECK_NAMES,
  )
})

test('产物只登记一个 window.__ModuleLoader__.load 模块壳', () => {
  const item = expectOk('loader-call-single')
  assert.match(item.detail, /^1 /)
})

test('模块 id 等于 package.json 的 name', () => {
  const item = expectOk('module-id-matches-package-name')
  assert.equal(item.detail, 'id = dsh-word-learn')
})

test('factory 形参名是 require', () => {
  expectOk('factory-param-require')
  assert.deepEqual(parseLoaderShell(bundleCode), {
    id: 'dsh-word-learn',
    factoryParam: 'require',
  })
})

test('产物存在 require("react")，且只 require baseline seed', () => {
  expectOk('require-react')
  expectOk('requires-only-baseline-seeds')
  assert.ok(stats.requires.includes('react'))
  for (const id of collectRequires(bundleCode)) {
    assert.ok(id === 'react', `多出的 require：${id}`)
  }
})

test('产物不含 node: 说明符与顶层 import/export', () => {
  expectOk('no-node-specifier')
  expectOk('no-top-level-esm')
  assert.equal(bundleCode.includes('node:'), false)
  assert.deepEqual(findTopLevelEsm(bundleCode), [])
})

test('产物末尾标注外置 sourcemap，且 map 是合法 v3 并覆盖 plugin.js', () => {
  expectOk('sourcemap-annotation')
  expectOk('sourcemap-external-v3')
  expectOk('sourcemap-covers-required-sources')
  expectOk('sourcemap-sources-usable')
})

test('产物体积在预算内（≤400KB raw / ≤100KB gzip）', () => {
  const item = expectOk('size-budget')
  assert.match(item.detail, /raw \/ .* gzip$/)
  assert.ok(stats.raw <= 400 * 1024)
  assert.ok(stats.gzip <= 100 * 1024)
})

test('用 vm 以 seed 桩调用 factory：apply 是函数、inject 是数组', () => {
  expectOk('runtime-factory')
})

// ---- 反向样本：证明检查器真的会红（否则等于没检查） -------------------------

test('多一个 load 调用会被抓到', () => {
  const { checks } = checkClientBundle({
    code: `${bundleCode}\nwindow.__ModuleLoader__.load({ id: 'x', factory: () => ({}) });\n`,
  })
  assert.equal(resultOf(checks, 'loader-call-single').ok, false)
})

test('id 与 package.json 不一致会被抓到', () => {
  const { checks } = checkClientBundle({ pkgName: 'other-plugin' })
  assert.equal(resultOf(checks, 'module-id-matches-package-name').ok, false)
})

test('require 了非 baseline seed 会被抓到', () => {
  const { checks } = checkClientBundle({ code: `${bundleCode}\nrequire("lodash");\n` })
  const item = resultOf(checks, 'requires-only-baseline-seeds')
  assert.equal(item.ok, false)
  assert.match(item.detail, /lodash/)
})

test('顶层 export 会被抓到', () => {
  const { checks } = checkClientBundle({ code: `export const leaked = 1\n${bundleCode}` })
  assert.equal(resultOf(checks, 'no-top-level-esm').ok, false)
})

test('体积超预算会被抓到', () => {
  const { checks } = checkClientBundle({ code: `${bundleCode}${'x'.repeat(400 * 1024)}` })
  assert.equal(resultOf(checks, 'size-budget').ok, false)
})

test('sourcemap 版本不对会被抓到', () => {
  const { checks } = checkClientBundle({
    mapText: JSON.stringify({ version: 2, sources: ['../src/client/plugin.js'] }),
  })
  assert.equal(resultOf(checks, 'sourcemap-external-v3').ok, false)
})

test('sourcemap 缺 sourcesContent 且文件不存在会被抓到', () => {
  const { checks } = checkClientBundle({
    mapText: JSON.stringify({ version: 3, sources: ['../src/client/missing.js'] }),
  })
  assert.equal(resultOf(checks, 'sourcemap-sources-usable').ok, false)
})

test('factory 返回体缺 apply 会被抓到', () => {
  const { checks } = checkClientBundle({ code: bundleCode.replace('exports.apply = apply;', '') })
  const item = resultOf(checks, 'runtime-factory')
  assert.equal(item.ok, false)
  assert.match(item.detail, /apply/)
})
