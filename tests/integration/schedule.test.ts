// @vitest-environment node
// 迁移自 scripts/test-schedule.mjs（137 行）—— 排期集成测试。
//
// 测什么：同一个词在同一轮里只出现一次 + productive 线要等 receptive 稳了才上线。
// 与旧脚本的区别只有载体：真实临时 DSH_HOME + 真实 Store/FSRS（见 support/db.ts），
// 断言逐条保留（对照表见交付报告）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTempStore } from './support/db.js'
import type { TempStore } from './support/db.js'

// 宿主模块在 import 期读取 DSH_HOME，所以只能放在 openTempStore 之后动态加载。
type ScheduleModule = typeof import('../../../lib/host/schedule.js')

let temp: TempStore
let store: TempStore['store']
let db: any
let schedule: ScheduleModule

const now = Date.now()
const MIN = 60 * 1000

let alpha: any
let cards: any[]
let t = now
let rec: any = null

beforeAll(async () => {
  temp = await openTempStore('dwl-int-schedule-')
  store = temp.store
  db = store.db
  schedule = await import('../../../lib/host/schedule.js')

  // 建卡：两条线都要有，但只有 receptive 进队列
  store.touch({
    word: 'alpha',
    phonetic: '/ˈælfə/',
    senses: [{ pos: 'n.', text: '第一个' }],
    frequency: { rank: 900, tier: 'high' },
    tags: [],
  } as never)
  alpha = db.prepare("SELECT id FROM words WHERE word = 'alpha'").get()
  cards = db
    .prepare('SELECT id, track, reps, state, due FROM cards WHERE word_id = ? ORDER BY id')
    .all(alpha.id)
})

afterAll(() => {
  temp.cleanup()
})

describe('建卡与队列', () => {
  it('建卡：两条线都要有，但只有 receptive 进队列', () => {
    expect(Boolean(alpha), '词写进库了').toBe(true)
    expect(cards.length, `有两张卡（实际 ${cards.length}）`).toBe(2)
    expect(
      cards.every((c: any) => c.reps === 0 && c.state === 0),
      '两张都是新卡',
    ).toBe(true)

    const q = schedule.dueQueue(db, { now, limit: 50 })
    expect(q.length, `队列里只有一个词（实际 ${q.length}）`).toBe(1)
    expect(q[0] && q[0].track, '出来的是认得出那条线').toBe('receptive')
    expect(q[0] && q[0].isNew, '标成新词').toBe(true)
  })
})

describe('receptive 稳下来之后 productive 才解锁', () => {
  it('反复评分直到 receptive 稳下来', async () => {
    const recCard = cards.find((c: any) => c.track === 'receptive')
    for (let i = 0; i < 8; i++) {
      const r = await schedule.applyGrade(db, recCard.id, 3, { now: t })
      if (!r.ok) expect.fail('评分失败：' + r.error)
      rec = db.prepare('SELECT state, reps FROM cards WHERE id = ?').get(recCard.id)
      if (schedule.productiveReady(rec)) break
      t += 10 * MIN
    }
    expect(
      schedule.productiveReady(rec),
      `receptive 进入复习态且评过 2 次以上（state=${rec && rec.state} reps=${rec && rec.reps}）`,
    ).toBe(true)
  })

  it('解锁时把 productive 排到明天，而不是停在建卡时的旧 due', () => {
    const prod = db
      .prepare('SELECT id, due, reps FROM cards WHERE word_id = ? AND track = ?')
      .get(alpha.id, 'productive')
    expect(prod.reps, 'productive 还没被评过').toBe(0)
    expect(
      prod.due,
      `解锁时把 productive 排到明天（due=${new Date(prod.due).toISOString()}）`,
    ).toBe(schedule.dayStart(1, t))
  })
})

describe('一轮一个词只出一条卡', () => {
  it('两条线同一天到期 → 一轮只出一次', () => {
    db.prepare('UPDATE cards SET due = ? WHERE word_id = ?').run(now, alpha.id)
    const q = schedule.dueQueue(db, { now, limit: 50 })
    expect(q.length, `一个词只出一条卡（实际 ${q.length}）`).toBe(1)
    expect(q[0] && q[0].track, '同 due 时先做认得出').toBe('receptive')
  })

  it('receptive 不在期 → productive 顶上', () => {
    db.prepare("UPDATE cards SET due = ? WHERE word_id = ? AND track = 'receptive'").run(
      now + 30 * 86400000,
      alpha.id,
    )
    db.prepare("UPDATE cards SET due = ? WHERE word_id = ? AND track = 'productive'").run(
      now,
      alpha.id,
    )
    const q = schedule.dueQueue(db, { now, limit: 50 })
    expect(q.length, `一个词只出一条卡（实际 ${q.length}）`).toBe(1)
    expect(q[0] && q[0].track, '出来的是写得出那条线').toBe('productive')
    expect(q[0] && q[0].isNew, '解锁的 productive 卡不标"新词"').toBe(false)
  })

  it('没稳的词：productive 卡到期也不进队列', () => {
    store.touch({
      word: 'beta',
      phonetic: '/ˈbiːtə/',
      senses: [{ pos: 'n.', text: '第二个' }],
      frequency: { rank: 901, tier: 'high' },
      tags: [],
    } as never)
    const beta = db.prepare("SELECT id FROM words WHERE word = 'beta'").get()
    db.prepare('UPDATE cards SET due = ? WHERE word_id = ?').run(now, beta.id)
    const q = schedule.dueQueue(db, { now, limit: 50 })
    const betaItems = q.filter((item: any) => item.wordId === beta.id)
    expect(betaItems.length, `beta 只出现一次（实际 ${betaItems.length}）`).toBe(1)
    expect(betaItems[0] && betaItems[0].track, '还没稳，只练认得出').toBe('receptive')
  })

  it('队列上限仍然生效', () => {
    const q = schedule.dueQueue(db, { now, limit: 1 })
    expect(q.length, `limit=1 只返回一条（实际 ${q.length}）`).toBe(1)
  })
})
