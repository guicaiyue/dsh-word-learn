#!/usr/bin/env node
/**
 * 排期单测：同一个词在同一轮里只出现一次 + productive 线要等 receptive 稳了才上线。
 *
 *   node --no-warnings scripts/test-schedule.mjs
 *
 * 用临时 DSH_HOME，不碰真实词库。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dwl-sched-'))
process.env.DSH_HOME = home

const { Store } = await import('../lib/store.mjs')
const { dueQueue, applyGrade, productiveReady, dayStart } = await import('../lib/host/schedule.js')

let fails = 0
function ok(cond, label, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    fails++
    console.log(`  ✗ ${label}${extra ? ' —— ' + extra : ''}`)
  }
}

const store = new Store()
if (!store.open()) {
  console.log('  ✗ 打不开临时库：' + store.error)
  process.exit(1)
}
const db = store.db
const now = Date.now()
const MIN = 60 * 1000

console.log('\n=== 建卡：两条线都要有，但只有 receptive 进队列 ===')
store.touch({
  word: 'alpha',
  phonetic: '/ˈælfə/',
  senses: [{ pos: 'n.', text: '第一个' }],
  frequency: { rank: 900, tier: 'high' },
  tags: [],
})
const alpha = db.prepare("SELECT id FROM words WHERE word = 'alpha'").get()
ok(!!alpha, '词写进库了')
const cards = db
  .prepare('SELECT id, track, reps, state, due FROM cards WHERE word_id = ? ORDER BY id')
  .all(alpha.id)
ok(cards.length === 2, '建了两张卡（结构要在）', `实际 ${cards.length}`)
ok(
  cards.every((c) => c.reps === 0 && c.state === 0),
  '两张都是新卡',
)

let q = dueQueue(db, { now, limit: 50 })
ok(q.length === 1, '队列里只有一个词', `实际 ${q.length}`)
ok(q[0] && q[0].track === 'receptive', '出来的是认得出那条线', q[0] && q[0].track)
ok(q[0] && q[0].isNew === true, '标成新词')

console.log('\n=== 反复评分，直到 receptive 稳下来 ===')
const recCard = cards.find((c) => c.track === 'receptive')
let t = now
let rec = null
for (let i = 0; i < 8; i++) {
  const r = await applyGrade(db, recCard.id, 3, { now: t })
  if (!r.ok) {
    ok(false, '评分失败：' + r.error)
    break
  }
  rec = db.prepare('SELECT state, reps FROM cards WHERE id = ?').get(recCard.id)
  if (productiveReady(rec)) break
  t += 10 * MIN
}
ok(
  productiveReady(rec),
  'receptive 进入复习态且评过 2 次以上',
  rec && `state=${rec.state} reps=${rec.reps}`,
)

const prod = db
  .prepare('SELECT id, due, reps FROM cards WHERE word_id = ? AND track = ?')
  .get(alpha.id, 'productive')
ok(prod.reps === 0, 'productive 还没被评过')
ok(
  prod.due === dayStart(1, t),
  '解锁时把 productive 排到明天，而不是停在建卡时的旧 due',
  `due=${new Date(prod.due).toISOString()}`,
)

console.log('\n=== 两条线同一天到期 → 一轮只出一次 ===')
db.prepare('UPDATE cards SET due = ? WHERE word_id = ?').run(now, alpha.id)
q = dueQueue(db, { now, limit: 50 })
ok(q.length === 1, '一个词只出一条卡', `实际 ${q.length}`)
ok(q[0] && q[0].track === 'receptive', '同 due 时先做认得出')

console.log('\n=== receptive 不在期 → productive 顶上 ===')
db.prepare("UPDATE cards SET due = ? WHERE word_id = ? AND track = 'receptive'").run(
  now + 30 * 86400000,
  alpha.id,
)
db.prepare("UPDATE cards SET due = ? WHERE word_id = ? AND track = 'productive'").run(now, alpha.id)
q = dueQueue(db, { now, limit: 50 })
ok(q.length === 1, '一个词只出一条卡', `实际 ${q.length}`)
ok(q[0] && q[0].track === 'productive', '出来的是写得出那条线', q[0] && q[0].track)
ok(q[0] && q[0].isNew === false, '解锁的 productive 卡不标"新词"', q[0] && String(q[0].isNew))

console.log('\n=== 没稳的词：productive 卡到期也不进队列 ===')
store.touch({
  word: 'beta',
  phonetic: '/ˈbiːtə/',
  senses: [{ pos: 'n.', text: '第二个' }],
  frequency: { rank: 901, tier: 'high' },
  tags: [],
})
const beta = db.prepare("SELECT id FROM words WHERE word = 'beta'").get()
db.prepare('UPDATE cards SET due = ? WHERE word_id = ?').run(now, beta.id)
q = dueQueue(db, { now, limit: 50 })
const betaItems = q.filter((it) => it.wordId === beta.id)
ok(betaItems.length === 1, 'beta 只出现一次', `实际 ${betaItems.length}`)
ok(betaItems[0] && betaItems[0].track === 'receptive', '还没稳，只练认得出')

console.log('\n=== 队列上限仍然生效 ===')
q = dueQueue(db, { now, limit: 1 })
ok(q.length === 1, 'limit=1 只返回一条', `实际 ${q.length}`)

store.close?.()
try {
  fs.rmSync(home, { recursive: true, force: true })
} catch (err) {
  /* 临时目录清不掉不影响结论 */
}

console.log(fails === 0 ? '\n全部通过 ✓' : `\n${fails} 项失败 ✗`)
process.exit(fails === 0 ? 0 : 1)
