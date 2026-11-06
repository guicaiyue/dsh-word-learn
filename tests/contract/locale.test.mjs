// @vitest-environment node
// locale 契约测试 —— 中英两份文案的键集合必须完全相同，且没有空字符串。
//
// 为什么值得单列：locale 缺键不会报错，只会在英文界面里显示原始 key（`panel.title`）
// 或空白，属于「构建全绿、界面丢字」的静默故障。这里把两份 JSON 深度展平后逐键比对，
// 并且用合成样本证明检查器会红。
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { checkLocale, flattenLocale } from '../../scripts/check-artifact.mjs'

const { checks } = checkLocale()

/** 断言某条 locale 契约检查存在且为绿。 */
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

test('zh.json 与 en.json 都是合法 JSON 对象', () => {
  expectOk('locale-files-parse')
})

test('深度展平后 zh / en 键集合完全相同', () => {
  const item = expectOk('locale-key-sets-equal')
  assert.match(item.detail, /^\d+ 个键两端一致$/)
})

test('两份文案都没有空字符串值', () => {
  expectOk('locale-no-empty-values')
})

test('flattenLocale 支持嵌套路径与叶子值', () => {
  const flat = [...flattenLocale({ meta: { title: '标题' }, top: '值' })]
  assert.deepEqual(flat, [
    ['meta.title', '标题'],
    ['top', '值'],
  ])
})

// ---- 反向样本：证明检查器真的会红 ------------------------------------------

test('缺一个键会被抓到', () => {
  const { checks } = checkLocale({ zh: { meta: { title: '标题' } }, en: { meta: {} } })
  const item = resultOf(checks, 'locale-key-sets-equal')
  assert.equal(item.ok, false)
  assert.match(item.detail, /meta\.title/)
})

test('空字符串值会被抓到', () => {
  const { checks } = checkLocale({ zh: { meta: { title: '' } }, en: { meta: { title: 'Title' } } })
  assert.equal(resultOf(checks, 'locale-no-empty-values').ok, false)
})

test('非法 JSON 会被抓到', () => {
  const { checks } = checkLocale({ zh: '{ not json', en: {} })
  assert.equal(resultOf(checks, 'locale-files-parse').ok, false)
})
