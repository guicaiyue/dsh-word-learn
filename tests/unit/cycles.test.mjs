// cycles.test.mjs —— import 环检测器的正反例。
//
// 背景：ESLint 10 下没有可靠的 no-cycle 插件（eslint-plugin-import-x 4.17.1 实测
// 对故意造出的环不报错），所以环检测由 scripts/check-cycles.mjs 承担。
// 这个单测保证「它真的会报环」，否则门禁就是摆设。
import assert from 'node:assert/strict'
import test from 'node:test'

import { extractImports, findCycles } from '../../scripts/check-cycles.mjs'

test('无环图返回空数组', () => {
  const graph = new Map([
    ['/a', ['/b']],
    ['/b', ['/c']],
    ['/c', []],
  ])
  assert.deepEqual(findCycles(graph), [])
})

test('两节点环能被发现，且首尾同节点', () => {
  const graph = new Map([
    ['/a', ['/b']],
    ['/b', ['/a']],
  ])
  const cycles = findCycles(graph)
  assert.equal(cycles.length, 1)
  assert.equal(cycles[0][0], cycles[0][cycles[0].length - 1])
  assert.deepEqual(new Set(cycles[0]), new Set(['/a', '/b']))
})

test('三节点环能被发现', () => {
  const graph = new Map([
    ['/a', ['/b']],
    ['/b', ['/c']],
    ['/c', ['/a']],
  ])
  assert.equal(findCycles(graph).length, 1)
})

test('两个独立的环各报一条', () => {
  const graph = new Map([
    ['/a', ['/b']],
    ['/b', ['/a']],
    ['/x', ['/y']],
    ['/y', ['/x']],
  ])
  assert.equal(findCycles(graph).length, 2)
})

test('菱形依赖不算环', () => {
  const graph = new Map([
    ['/a', ['/b', '/c']],
    ['/b', ['/d']],
    ['/c', ['/d']],
    ['/d', []],
  ])
  assert.deepEqual(findCycles(graph), [])
})

test('自引用（文件 import 自己）算环', () => {
  const graph = new Map([['/a', ['/a']]])
  assert.equal(findCycles(graph).length, 1)
})

test('extractImports 支持命名 / 默认 / 副作用 / 多行 import', () => {
  const code = [
    "import fs from 'node:fs'",
    "import { a, b } from './a.mjs'",
    "import './side-effect.mjs'",
    "import {\n  x,\n  y,\n} from './multi.mjs'",
    "const dyn = await import('./dyn.mjs')",
  ].join('\n')
  assert.deepEqual(extractImports(code), [
    'node:fs',
    './a.mjs',
    './side-effect.mjs',
    './multi.mjs',
    './dyn.mjs',
  ])
})
