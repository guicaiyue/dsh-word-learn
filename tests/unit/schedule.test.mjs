// 测什么：lib/schedule.mjs 里可纯算的部分（本地日界、DB ↔ FSRS 字段映射、
// productive 上线闸门、常量）。DB 相关的 dueQueue/applyGrade/forecast 不在这里硬造，
// 它们已由 legacy 的 test-schedule.mjs 用临时 Store 覆盖。
// 为什么放单测：这些函数无 I/O，边界（时区零点、learning_steps 丢失、数字字符串）
// 用单测断言更精确，也防止排期映射在重构时静默漂移。

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DAILY_NEW_LIMIT,
  DAILY_REVIEW_LIMIT,
  FSRS6_DEFAULT_W,
  LEECH_THRESHOLD,
  RATING,
  RATING_LABEL,
  TRACK_LABEL,
  TRACKS,
  cardToRow,
  dayStart,
  productiveReady,
  rowToCard,
  scheduleStatus,
  startOfLocalDay,
} from '../../lib/schedule.mjs'

const HOUR_MS = 60 * 60 * 1000
/** 一个固定的本地时刻：2026-11-05 15:30:45.123（避开 UTC 零点，能测出时区错误）。 */
const LOCAL_TS = new Date(2026, 10, 5, 15, 30, 45, 123).getTime()

describe('startOfLocalDay / dayStart', () => {
  test('startOfLocalDay 落在本地零点，且保持同一天', () => {
    const mid = startOfLocalDay(LOCAL_TS)
    const d = new Date(mid)
    assert.equal(d.getHours(), 0)
    assert.equal(d.getMinutes(), 0)
    assert.equal(d.getSeconds(), 0)
    assert.equal(d.getMilliseconds(), 0)
    assert.equal(d.getDate(), 5, '跨时区错误会表现成日期偏移')
    assert.equal(d.getMonth(), 10)
  })

  test('startOfLocalDay 幂等，且零点输入原样返回', () => {
    const mid = startOfLocalDay(LOCAL_TS)
    assert.equal(startOfLocalDay(mid), mid)
  })

  test('dayStart(0) 等于今天零点；正负天数按日历推进', () => {
    assert.equal(dayStart(0, LOCAL_TS), startOfLocalDay(LOCAL_TS))
    const yesterday = dayStart(-1, LOCAL_TS)
    const tomorrow = dayStart(1, LOCAL_TS)
    assert.ok(yesterday < startOfLocalDay(LOCAL_TS))
    assert.ok(tomorrow > startOfLocalDay(LOCAL_TS))
    assert.ok(dayStart(3, LOCAL_TS) === dayStart(1, dayStart(2, LOCAL_TS)), '天数应可叠加')
  })

  test('相邻两天相差 24h 左右（容忍夏令时切换的 23/25h）', () => {
    const diff = dayStart(1, LOCAL_TS) - dayStart(0, LOCAL_TS)
    assert.ok(diff >= 23 * HOUR_MS && diff <= 25 * HOUR_MS, `实际差 ${diff}ms`)
  })
})

describe('rowToCard（数据库行 → FSRS 卡片）', () => {
  test('缺字段给默认值，due 兜到 now', () => {
    const now = 1700000000000
    const card = rowToCard({}, now)
    assert.equal(card.due.getTime(), now)
    assert.equal(card.stability, 0)
    assert.equal(card.difficulty, 0)
    assert.equal(card.reps, 0)
    assert.equal(card.state, 0)
    assert.equal(card.learning_steps, 0)
    assert.equal(card.last_review, undefined, '从没评过分时 last_review 应为 undefined')
  })

  test('learning_steps 必须带上（丢了会永远卡在 Learning，且不报错）', () => {
    const card = rowToCard({ due: 1700000000000, learning_steps: 2, reps: 3 }, 1700000000000)
    assert.equal(card.learning_steps, 2)
    assert.equal(card.reps, 3)
    assert.equal(card.due.getTime(), 1700000000000)
  })

  test('时间戳与数字字符串都能转换', () => {
    const card = rowToCard(
      { due: 1700000000000, last_review: 1690000000000, stability: '2.5', state: '1' },
      1700000000000,
    )
    assert.equal(card.last_review.getTime(), 1690000000000)
    assert.equal(card.stability, 2.5)
    assert.equal(card.state, 1)
  })
})

describe('cardToRow（FSRS 卡片 → 数据库行）', () => {
  test('Date 转毫秒，缺字段兜到 now / 0', () => {
    const now = 1700000000000
    const row = cardToRow({}, now)
    assert.equal(row.due, now)
    assert.equal(row.last_review, now)
    assert.equal(row.learning_steps, 0)
    assert.equal(row.reps, 0)
  })

  test('learning_steps 与 last_review 原样写回', () => {
    const row = cardToRow(
      {
        due: new Date(1000),
        last_review: new Date(2000),
        learning_steps: 2,
        stability: 1.5,
        state: 2,
      },
      9999,
    )
    assert.equal(row.due, 1000)
    assert.equal(row.last_review, 2000)
    assert.equal(row.learning_steps, 2)
    assert.equal(row.stability, 1.5)
    assert.equal(row.state, 2)
  })

  test('rowToCard → cardToRow 往返不丢排期字段', () => {
    const source = {
      due: 1700000000000,
      stability: 1.25,
      difficulty: 4.5,
      elapsed_days: 3,
      scheduled_days: 7,
      reps: 5,
      lapses: 1,
      state: 2,
      learning_steps: 1,
      last_review: 1699000000000,
    }
    const row = cardToRow(rowToCard(source, 1700000000000), 1700000000000)
    assert.deepEqual(row, source)
  })
})

describe('productiveReady（认得出稳了才上线写得出）', () => {
  test('没有 receptive 卡 / 状态不够都返回 false', () => {
    assert.equal(productiveReady(null), false)
    assert.equal(productiveReady(undefined), false)
    assert.equal(productiveReady({}), false)
    assert.equal(productiveReady({ state: 1, reps: 9 }), false, '还在 Learning 不该上线')
    assert.equal(productiveReady({ state: 2, reps: 1 }), false, '只评过 1 次还不够')
  })

  test('进入复习态且至少评过 2 次才 true（数字字符串也认）', () => {
    assert.equal(productiveReady({ state: 2, reps: 2 }), true)
    assert.equal(productiveReady({ state: 3, reps: 5 }), true)
    assert.equal(productiveReady({ state: '2', reps: '2' }), true)
  })
})

describe('常量与引擎状态', () => {
  test('两条排期线、评分档位、leech 阈值与日上限', () => {
    assert.deepEqual(TRACKS, ['receptive', 'productive'])
    assert.deepEqual(RATING, { Again: 1, Hard: 2, Good: 3, Easy: 4 })
    assert.equal(TRACK_LABEL.productive, '写得出')
    assert.equal(RATING_LABEL[1], '忘了')
    assert.equal(LEECH_THRESHOLD, 8)
    assert.equal(DAILY_NEW_LIMIT, 20)
    assert.equal(DAILY_REVIEW_LIMIT, 200)
  })

  test('FSRS-6 默认参数是 21 个有限数字', () => {
    assert.equal(FSRS6_DEFAULT_W.length, 21)
    assert.ok(FSRS6_DEFAULT_W.every((w) => Number.isFinite(w)))
  })

  test('懒加载未触发时 scheduleStatus 报 ok:false 但不报错', () => {
    assert.deepEqual(scheduleStatus(), { ok: false, error: '' })
  })
})
