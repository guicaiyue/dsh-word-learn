// @vitest-environment node
// 测什么：clampInt —— 写操作请求体里的数字字段钳制口。
//
// 归口：实现在 `lib/http.mjs`（与 intParam 同一模块），`lib/routes/shared.mjs` 只再导出；
// 这里按 handler 的用法从 shared 取，顺带断言"再导出就是同一个函数"，防止哪天两边分叉。
//
// 为什么放单测：它是 intParam 的 body 版本，边界（缺省/空串/0/NaN/负数/小数/
// Infinity/min·max）用 legacy 端到端脚本覆盖成本太高，而且端到端只能证明
// "某个路由碰巧对了"。这里把"与旧写法 Number(payload.x) || 0 等价"也钉成断言，
// 防止以后有人改钳制口时把 0 → fallback 这条语义弄丢。
//
// 不涉及 I/O、ctx、用户库：http.mjs / shared.mjs 都是纯函数模块，import 无副作用。

import { readFileSync } from 'node:fs'
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'

import { clampInt as clampIntFromHttp } from '../../lib/host/http.js'
import { clampInt } from '../../lib/host/routes/shared.js'

describe('clampInt', () => {
  test('实现归口在 lib/http.mjs，shared.mjs 的再导出是同一个函数', () => {
    assert.equal(
      clampInt,
      clampIntFromHttp,
      'shared.mjs 应再导出 http.mjs 的 clampInt，而不是另抄一份',
    )
  })

  test('缺省 / 空串 / 非数字 / 0 都回落 fallback（与 Number(x) || fallback 等价）', () => {
    assert.equal(clampInt(undefined), 0, '缺省默认 fallback 是 0')
    assert.equal(clampInt(null), 0)
    assert.equal(clampInt(''), 0, '空串按缺省处理')
    assert.equal(clampInt('abc'), 0)
    assert.equal(clampInt('NaN'), 0)
    assert.equal(clampInt(0), 0, '0 也回落 fallback（旧写法 Number(x) || fallback 的语义）')
    assert.equal(clampInt(undefined, { fallback: 7 }), 7, '自定义 fallback')
    assert.equal(clampInt(NaN, { fallback: 7 }), 7)
    assert.equal(clampInt(null, { fallback: 7 }), 7)
  })

  test('数字与数字字符串原样通过；小数不取整（取整只属于分页类参数）', () => {
    assert.equal(clampInt(12), 12)
    assert.equal(clampInt('12'), 12, 'JSON body 里的字符串数字也要能读')
    assert.equal(clampInt(3.9), 3.9, 'clampInt 不 floor，1-4 这类业务校验仍留给 handler')
    assert.equal(clampInt(-5), -5, '没有 min 时负数原样保留')
    assert.equal(clampInt(true), 1, 'Number(true) === 1，与旧写法一致')
  })

  test('超过 max / 低于 min 都被钳制', () => {
    assert.equal(clampInt(900, { max: 500 }), 500)
    assert.equal(clampInt(-3, { min: 1 }), 1)
    assert.equal(clampInt(3.9, { min: 1, max: 3 }), 3)
    assert.equal(clampInt(0, { min: 1 }), 1, '先回落 fallback(0) 再夹到 min，与 intParam 一致')
    assert.equal(clampInt(undefined, { min: 1, max: 5, fallback: 2 }), 2)
  })

  test('Infinity 被夹进安全整数区间（比裸 Number 更安全，且不影响 400 判定）', () => {
    assert.equal(clampInt(Infinity), Number.MAX_SAFE_INTEGER)
    assert.equal(clampInt(-Infinity), Number.MIN_SAFE_INTEGER)
    // 旧写法会得到 Infinity；对 cardId/rating 而言两者都是"非 0 的非法值"，
    // 后续 !cardId / rating 1-4 校验的结果一致，不会把 400 变成 200。
    assert.ok(clampInt(Infinity), 'Infinity 仍是 truthy，不会误判成"缺少字段"')
  })

  test('对旧写法做等价性抽样：clampInt 无上下限时 === Number(value) || 0', () => {
    const values = [undefined, null, '', 'abc', '0', 0, '7', 7, -2, 2.5, true, false, [], {}]
    for (const value of values) {
      assert.equal(
        clampInt(value),
        Number(value) || 0,
        `clampInt(${JSON.stringify(value)}) 应与旧写法 Number(x) || 0 等价`,
      )
    }
  })
})

// 收编守卫：POST body 的数字字段必须全部走 clampInt。谁只改一处忘另一处
// （比如改了 repair/review 忘了 r5，或反过来只改 r5）这条会红。
describe('body 数字字段全部收编（含 lib/r5.mjs）', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  test('repair / review / r5 都不再裸写 Number(payload.x)', () => {
    for (const rel of ['../../src/host/routes/repair.ts', '../../src/host/routes/review.ts']) {
      const hits = read(rel).match(/Number\(payload\./g) || []
      assert.equal(hits.length, 0, `${rel} 里还有裸 Number(payload.x)，应改用 clampInt`)
    }
    // r5.mjs 唯一豁免：payload.now 是时间戳，走 isFinite/正数守卫回落 Date.now()；
    // clampInt 会把 ±Infinity 夹成安全整数边界，反而造出一个假的"现在"。
    const r5 = read('../../src/host/r5.ts')
    const hits = r5.match(/Number\(payload\./g) || []
    assert.equal(hits.length, 1, 'r5.mjs 只允许保留 payload.now 这一处 Number()')
    assert.equal((r5.match(/Number\(payload\.now\)/g) || []).length, 1)
    // 这一处必须紧跟 isFinite/正数守卫（buildRecap 里还有一处同型守卫，所以只查 payload.now 附近）
    const nowAt = r5.indexOf('Number(payload.now)')
    assert.match(
      r5.slice(nowAt, nowAt + 200),
      /Number\.isFinite\(rawNow\) && rawNow > 0/,
      'r5.mjs 保留的 Number(payload.now) 必须紧跟 isFinite 守卫，不能裸用',
    )
  })

  test('r5 的 wordId / cardId / elapsedMs 换算与旧写法逐值一致', () => {
    const oldWrite = (value) => Number(value) || 0
    for (const value of [undefined, null, '', 'abc', '12', 12, 0, -3, 2.5, true]) {
      assert.equal(
        clampInt(value),
        oldWrite(value),
        `wordId/cardId 口径: clampInt(${JSON.stringify(value)}) 应等于旧写法`,
      )
    }
    // elapsedMs 旧写法是 Math.max(0, Number(value) || 0)
    for (const value of [undefined, null, '', 'abc', 0, -3, 5, 2.5]) {
      assert.equal(Math.max(0, clampInt(value)), Math.max(0, oldWrite(value)))
    }
  })
})
