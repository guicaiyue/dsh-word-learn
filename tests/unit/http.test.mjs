// 测什么：lib/http.mjs 的 intParam / strParam —— 路由 query 参数的读值与钳制。
// 为什么放单测：纯函数、无 I/O、无 ctx，边界（缺省/空串/0/负数/小数/max/min）
// 用 legacy 端到端脚本覆盖成本太高，而且 legacy 只能证明"某个路由碰巧对了"。

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { intParam, strParam } from '../../lib/host/http.js'

/** 两种入参形态必须等价：路由里既可能拿到 URL，也可能直接传 searchParams。 */
const urlWith = (query) => new URL(`http://localhost/api?${query}`)
const paramsWith = (query) => new URLSearchParams(query)

describe('intParam', () => {
  test('缺省、空串、非数字都回落 fallback', () => {
    assert.equal(intParam(urlWith(''), 'limit'), 0, '默认 fallback 是 0')
    assert.equal(intParam(urlWith(''), 'limit', { fallback: 200 }), 200)
    assert.equal(intParam(urlWith('limit='), 'limit', { fallback: 200 }), 200, '空串按缺省处理')
    assert.equal(intParam(urlWith('limit=abc'), 'limit', { fallback: 200 }), 200)
    assert.equal(intParam(urlWith('limit=NaN'), 'limit', { fallback: 7 }), 7)
  })

  test('0 也回落 fallback（与旧写法 Number(x) || fallback 等价）', () => {
    assert.equal(intParam(urlWith('limit=0'), 'limit', { fallback: 200 }), 200)
  })

  test('负数在没有 min 时原样保留，有 min 时被夹住', () => {
    assert.equal(intParam(urlWith('limit=-5'), 'limit'), -5, '默认 min 是 MIN_SAFE_INTEGER')
    assert.equal(intParam(urlWith('limit=-5'), 'limit', { min: 1 }), 1)
  })

  test('小数：默认保留，floor:true 取整（分页参数必须取整）', () => {
    assert.equal(intParam(urlWith('limit=3.9'), 'limit'), 3.9)
    assert.equal(intParam(urlWith('limit=3.9'), 'limit', { floor: true }), 3)
    assert.equal(intParam(urlWith('limit=-2.9'), 'limit', { floor: true }), -3, 'floor 是向下取整')
  })

  test('超过 max / 低于 min 都被钳制', () => {
    assert.equal(intParam(urlWith('limit=900'), 'limit', { max: 500 }), 500)
    assert.equal(intParam(urlWith('limit=0.5'), 'limit', { min: 1 }), 1)
    assert.equal(intParam(urlWith('limit=3.9'), 'limit', { min: 1, max: 3 }), 3, '先 floor 后钳制')
  })

  test('fallback 本身也会被钳制（调用方给的默认值不等于豁免）', () => {
    assert.equal(intParam(urlWith(''), 'limit', { fallback: 5, min: 10 }), 10)
    assert.equal(intParam(urlWith(''), 'limit', { fallback: 900, max: 500 }), 500)
    assert.equal(
      intParam(urlWith(''), 'limit', { fallback: 2.7, floor: true }),
      2,
      'fallback 也 floor',
    )
  })

  test('URL 对象与 URLSearchParams 结果一致', () => {
    const options = { fallback: 20, min: 1, max: 100, floor: true }
    for (const query of ['limit=42', 'limit=', 'limit=abc', 'limit=0', 'limit=3.9', 'limit=999']) {
      assert.equal(
        intParam(urlWith(query), 'limit', options),
        intParam(paramsWith(query), 'limit', options),
        `query=${query} 两种入参应等价`,
      )
    }
  })

  test('参数名不存在与其他参数共存时不串值', () => {
    assert.equal(intParam(urlWith('offset=10'), 'limit', { fallback: 5 }), 5)
    assert.equal(intParam(urlWith('offset=10&limit=30'), 'limit'), 30)
  })

  test('极端大的值落到 max，而不是 NaN 或 Infinity', () => {
    assert.equal(intParam(urlWith('limit=1e999'), 'limit', { max: 500 }), 500)
    assert.equal(intParam(urlWith('limit=1e9'), 'limit'), 1e9, '未给 max 时保留有限值')
  })
})

describe('strParam', () => {
  test('缺失 / 空串回落 fallback，默认 fallback 是空串', () => {
    assert.equal(strParam(urlWith(''), 'word'), '')
    assert.equal(strParam(urlWith(''), 'word', '默认'), '默认')
    assert.equal(strParam(urlWith('word='), 'word', '默认'), '默认', '空串按缺省处理')
  })

  test('正常值原样返回，不做 trim', () => {
    assert.equal(strParam(urlWith('word=latent'), 'word'), 'latent')
    assert.equal(strParam(urlWith('word=%20'), 'word'), ' ', '空白是调用方的事，这里不擅自裁剪')
    assert.equal(strParam(urlWith('word=0'), 'word'), '0', '字符串 "0" 不是空串')
  })

  test('URL 对象与 URLSearchParams 结果一致', () => {
    for (const query of ['word=latent', 'word=', '']) {
      assert.equal(strParam(urlWith(query), 'word', 'x'), strParam(paramsWith(query), 'word', 'x'))
    }
  })

  test('重复参数取第一个（与 URLSearchParams.get 语义一致）', () => {
    assert.equal(strParam(urlWith('word=first&word=second'), 'word'), 'first')
  })
})
