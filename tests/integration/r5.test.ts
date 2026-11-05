// @vitest-environment node
// 迁移自 scripts/test-r5.mjs（706 行）—— R5 次日回访 + 义项地图集成测试。
//
// 测什么（原脚本头注释的 7 条验收，全部保留）：
//   1. buildRecap 同义/异义各占一半，跳过没有义项材料 / 没有可用原句的词；
//   2. **R5 不再自我续期**：昨天答对且债已清 → 不再出题；昨天答错 → 继续出；
//      昨天答对但今天主队列又评 Again → 今天不问、明天继续出；
//   3. submitRecap 答对只清「昨天及更早开的」债，今天新开的债不动；
//   4. submitRecap 幂等 + 事务：重复提交不新增日志、不刷新债务；
//   5. senseMap 的 pick 归属按时间就近匹配，pick.ok=NULL 归 seen；
//   6. limit 参数：缺省 5、数字 floor + 夹到 1–20、非法值走缺省；
//   7. 全程不产生 review_log、不动 cards 表（不污染 FSRS）。
//
// 与旧脚本的差异：临时 DSH_HOME / Store / 动态 import 时序搬进 support/（db.ts、
// tmp-home.ts）；断言逐条保留，只是换成 vitest 的 expect（对照表见交付报告）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTempStore } from './support/db.js'
import type { TempStore } from './support/db.js'

// 断言助手：与原脚本同名同参，方便逐条对照（ok/eq 的 message 同时是失败信息）。
function ok(cond: unknown, message?: string): void {
  expect(cond, message).toBe(true)
}
function eq(actual: unknown, expected: unknown, message?: string): void {
  expect(actual, message).toBe(expected)
}

type R5Module = typeof import('../../../lib/host/r5.js')
type ScheduleModule = typeof import('../../../lib/host/schedule.js')

let temp: TempStore
let store: TempStore['store']
let db: any
let r5: R5Module
let schedule: ScheduleModule

const HOUR = 3600000
const DAY = 86400000
const now = Date.now()
let Y = 0
let Y_LATE = 0
let TODAY = 0
let TOMORROW = 0

// 造数据工具（原脚本同名同签名）
function addWord(word: string, translation?: string) {
  const info = db
    .prepare(
      `INSERT INTO words (word, translation, phonetic, created_at, seen_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(word, translation || `n. ${word} 的释义`, '', now, now)
  const wordId = Number(info.lastInsertRowid)
  const card = db
    .prepare(
      `INSERT INTO cards (word_id, track, due, state, reps)
       VALUES (?,?,?,?,?)`,
    )
    .run(wordId, 'receptive', now, 0, 0)
  return { wordId, cardId: Number(card.lastInsertRowid) }
}

function addContext(wordId: number, sentence: string, createdAt?: number) {
  db.prepare(
    `INSERT INTO contexts (word_id, sentence, source, created_at)
     VALUES (?,?,?,?)`,
  ).run(wordId, sentence, 'test', createdAt == null ? now : createdAt)
}

/** 造一条 sense_meta；otherSentence 传 null 模拟「没有异义句」的材料。 */
function addSense(wordId: number, o: any, createdAt?: number) {
  // 第三参允许覆盖时间：senseMap 的「按时间就近归属」要用到不同的材料时刻
  const at = createdAt == null ? (o.createdAt == null ? now : o.createdAt) : createdAt
  const json = {
    sense_here: o.senseHere,
    likely_assumed: o.likelyAssumed || '你以为的那个义项',
    why_confusable: '技术语境里更常见的是另一个义项。',
    contrast: '',
    options: [
      { text: o.senseHere, correct: true },
      { text: o.likelyAssumed || '干扰项甲', correct: false },
      { text: '干扰项乙', correct: false },
      { text: '干扰项丙', correct: false },
    ],
    personal_example: o.personal,
    cloze: '',
    other_sense:
      o.otherSentence == null
        ? null
        : { sentence: o.otherSentence, gloss: o.otherGloss || '另一个义项' },
    etymology_note: '',
    confidence: 'high',
    analyzedAt: at,
  }
  db.prepare(
    `INSERT INTO sense_meta (word_id, sense_key, json, model, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(wordId, o.senseHere, JSON.stringify(json), 'test-model', at)
}

function addLog(wordId: number, cardId: number, stage: string, ok_: any, createdAt: number) {
  db.prepare(
    `INSERT INTO repair_log (word_id, card_id, stage, ok, guess, elapsed_ms, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(wordId, cardId, stage, ok_ == null ? null : ok_ ? 1 : 0, '', 0, createdAt)
}

function addDebt(wordId: number, cardId: number, openedAt: number, clearedAt?: number | null) {
  db.prepare(
    `INSERT INTO repair_debt (word_id, card_id, track, opened_at, cleared_at, tries)
     VALUES (?,?,?,?,?,?)`,
  ).run(wordId, cardId, 'receptive', openedAt, clearedAt == null ? null : clearedAt, 0)
}

// ---------------------------------------------------------------- 数据（原脚本逐字保留）

/** 每个词一句话，方便断言 s1 取自这里。 */
const SENTENCE: Record<string, string> = {
  resolution: 'The team made a resolution to ship on Monday.',
  charge: 'Please charge the phone before the meeting.',
  latent: 'The problem stayed hidden in the codebase.',
  figure: 'We need to figure out why the latency doubled.',
  address: 'Let us address the failing test first.',
  match: 'The log pattern does not match the expected output.',
  run: 'The migration will run once the lock is released.',
  reask: 'We should reask the same question in the next review.',
  renew: 'The certificate will renew automatically next month.',
  again: 'Please run the failing test again after the fix.',
  freshdebt: 'The freshdebt sentence keeps the word inside the line.',
  // bareword / nosibling 故意不放句子：它们要模拟「检查不通过」的老数据
  todayonly: 'The todayonly sentence is here.',
  answered: 'The answered sentence is here.',
}

/** 义项材料。latest 是这个词「最近一份」材料，R5 用它配题。 */
const SENSE: Record<string, any> = {
  resolution: {
    senseHere: 'n. 决心；决定',
    likelyAssumed: 'n. 分辨率',
    personal: 'She made a resolution to stop deploying on Fridays.',
    otherSentence: 'The image has a resolution of 4K.',
    otherGloss: '分辨率',
  },
  charge: {
    senseHere: 'v. 充电',
    likelyAssumed: 'v. 收费',
    personal: 'Remember to charge the laptop before the call.',
    otherSentence: 'The police decided to charge him with theft.',
    otherGloss: '指控',
  },
  // latent 有两份义项材料：旧的 senseHere「潜在的」，新的「潜伏的」
  latentOld: {
    senseHere: 'a. 潜在的',
    likelyAssumed: 'n. 潜空间',
    personal: 'The regression was latent for three releases.',
    otherSentence: 'The encoder maps it into a latent space.',
    otherGloss: '潜空间',
  },
  latentNew: {
    senseHere: 'a. 潜伏的',
    likelyAssumed: 'n. 潜空间',
    personal: 'A latent bug woke up after the upgrade.',
    otherSentence: 'The model keeps it in a latent space.',
    otherGloss: '潜空间',
  },
  figure: {
    senseHere: 'v. 弄明白',
    likelyAssumed: 'n. 数字；图表',
    personal: 'We could not figure out the root cause.',
    otherSentence: 'The figure in the report is wrong.',
    otherGloss: '数字',
  },
  address: {
    senseHere: 'v. 处理；解决',
    likelyAssumed: 'n. 地址',
    personal: 'We should address the flaky test this sprint.',
    otherSentence: 'Send it to my email address.',
    otherGloss: '地址',
  },
  match: {
    senseHere: 'v. 匹配',
    likelyAssumed: 'n. 比赛',
    personal: 'The regex does not match the new header.',
    otherSentence: 'They watched the final match together.',
    otherGloss: '比赛',
  },
  run: {
    senseHere: 'v. 运行',
    likelyAssumed: 'v. 跑；跑步',
    personal: 'The job will run every night at two.',
    otherSentence: 'She likes to run in the morning.',
    otherGloss: '跑步',
  },
  reask: {
    senseHere: 'v. 重新询问',
    likelyAssumed: 'v. 追问',
    personal: 'The bot will reask the question if the answer is unclear.',
    otherSentence: 'She had to reask him twice.',
    otherGloss: '再问一次',
  },
  renew: {
    senseHere: 'v. 续期',
    likelyAssumed: 'v. 重来',
    personal: 'The token will renew every hour.',
    otherSentence: 'They decided to renew the contract.',
    otherGloss: '续签',
  },
  again: {
    senseHere: 'adv. 再一次',
    likelyAssumed: 'adv. 另外',
    personal: 'Run the job again once the lock is gone.',
    otherSentence: 'Once again the build failed.',
    otherGloss: '又一次',
  },
  freshdebt: {
    senseHere: 'n. 今日新债',
    likelyAssumed: 'n. 旧债',
    personal: 'The freshdebt example keeps the word inside.',
    otherSentence: 'Another freshdebt sentence for contrast.',
    otherGloss: '旧债',
  },
  bareword: {
    senseHere: 'n. 裸词测试',
    likelyAssumed: 'n. 另一义',
    personal: 'The bareword example needs the word inside.',
    otherSentence: 'Another bareword sense sentence.',
    otherGloss: '另一义',
  },
  nosibling: {
    senseHere: 'a. 没有异义句的',
    likelyAssumed: 'n. 干扰',
    personal: 'This nosibling example cannot be paired.',
    otherSentence: null,
    otherGloss: '',
  },
  todayonly: {
    senseHere: 'n. 今天的词',
    likelyAssumed: 'n. 干扰',
    personal: 'The todayonly example is here.',
    otherSentence: 'Another todayonly sentence.',
    otherGloss: '另一义',
  },
  answered: {
    senseHere: 'n. 今天已回访',
    likelyAssumed: 'n. 干扰',
    personal: 'The answered example is here.',
    otherSentence: 'Another answered sentence.',
    otherGloss: '另一义',
  },
}

// 各类 id 在 beforeAll 里填
let resolution: any
let charge: any
let latent: any
let figure: any
let addressWord: any
let runWord: any
let reask: any
let match: any
let renew: any
let again: any
let freshdebt: any
let bareword: any
let nosense: any
let nosibling: any
let todayonly: any
let answered: any
let dup: any
let dupwrong: any
let noanswer: any
let nullpick: any

let ELIGIBLE_IDS: Set<number>
let SKIP_IDS: Set<number>

/** 造一个词：词 + 卡 + 原句 + 义项材料。 */
function seed(word: string, senseKey?: string) {
  const ids = addWord(word)
  if (SENTENCE[word]) addContext(ids.wordId, SENTENCE[word], Y_LATE)
  const s = SENSE[senseKey || word]
  if (s) addSense(ids.wordId, s)
  return ids
}

/** trials 里同义/异义各几道。 */
function countSame(trials: any[]) {
  let same = 0
  for (const t of trials) if (t.same) same += 1
  return { same, diff: trials.length - same }
}

/** 记录 FSRS 侧快照：submitRecap 前后必须一模一样。 */
function fsrsSnapshot() {
  return JSON.stringify({
    reviewLog: db.prepare('SELECT COUNT(*) AS n FROM review_log').get().n,
    cards: db.prepare('SELECT * FROM cards ORDER BY id').all(),
  })
}

/** 某个词今天有几条 stage='tomorrow' 的日志。 */
function tomorrowLogCount(wordId: number) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM repair_log
        WHERE word_id = ? AND stage = 'tomorrow' AND created_at >= ?`,
    )
    .get(wordId, schedule.dayStart(0, now)).n
}

beforeAll(async () => {
  temp = await openTempStore('dwl-int-r5-')
  store = temp.store
  db = store.db
  r5 = await import('../../../lib/host/r5.js')
  schedule = await import('../../../lib/host/schedule.js')

  // 「昨天」的本地时区窗口，和 r5.js 用同一套 dayStart
  Y = schedule.dayStart(-1, now) + 2 * HOUR // 昨天 02:00
  Y_LATE = Y + 10 * HOUR // 昨天 12:00
  TODAY = schedule.dayStart(0, now) + 1000 // 今天 00:00:01
  TOMORROW = now + DAY // 把时间拨到明天，用来测「明天还会不会出」

  // —— 昨天有补记证据、材料齐全的 7 个词（真正的候选池）
  resolution = seed('resolution')
  addLog(resolution.wordId, resolution.cardId, 'spell', 1, Y)

  charge = seed('charge')
  addDebt(charge.wordId, charge.cardId, Y, null)

  latent = seed('latent')
  addSense(latent.wordId, SENSE.latentOld, Y) // 旧材料
  addSense(latent.wordId, SENSE.latentNew, Y + 5 * HOUR) // 新材料（R5 用它）
  addLog(latent.wordId, latent.cardId, 'pick', 0, Y)

  figure = seed('figure')
  addLog(figure.wordId, figure.cardId, 'session_end', null, Y)
  // 材料生成之后，这个词又在别的语境里出现了一次（新原句）。
  // R5 仍必须拿「材料生成时」那条原句，否则 senseHere 和 s1 的义项对不上。
  addContext(figure.wordId, 'We need to figure out the deploy order tonight.', now + 2)

  addressWord = seed('address')
  addDebt(addressWord.wordId, addressWord.cardId, Y, Y + HOUR) // 昨天开债、昨天已清

  runWord = seed('run')
  addLog(runWord.wordId, runWord.cardId, 'pick', 1, Y)

  // 昨天回访答错了：还要继续追问（task-5 用例 2）
  reask = seed('reask')
  addLog(reask.wordId, reask.cardId, 'tomorrow', 0, Y)

  const ELIGIBLE = [resolution, charge, latent, figure, addressWord, runWord, reask]
  ELIGIBLE_IDS = new Set(ELIGIBLE.map((x) => x.wordId))

  // —— 昨天答对且债已清：R5 必须终止，不再每天出题（task-5 用例 1）
  match = seed('match')
  addLog(match.wordId, match.cardId, 'tomorrow', 1, Y) // 昨天回访答对，没有债

  renew = seed('renew')
  addDebt(renew.wordId, renew.cardId, Y, Y + HOUR) // 债昨天开了又清
  addLog(renew.wordId, renew.cardId, 'tomorrow', 1, Y) // 昨天回访也答对

  // —— 昨天答对，但今天主队列又评了 Again（task-5 用例 3）：
  //     今天不追问（那是今天主队列的账），明天的新回访里继续出。
  again = seed('again')
  addLog(again.wordId, again.cardId, 'tomorrow', 1, Y) // 昨天回访答对了
  addDebt(again.wordId, again.cardId, TODAY, null) // 今天主队列 Again 开的债（未清）

  // —— 只有今天开的债：今天不是「昨天回访」的候选，明天才会
  freshdebt = seed('freshdebt')
  addDebt(freshdebt.wordId, freshdebt.cardId, TODAY, null)

  // —— 材料/证据不全，不出题
  bareword = seed('bareword')
  addContext(bareword.wordId, 'bareword', Y) // 最新原句就是单词本身
  addLog(bareword.wordId, bareword.cardId, 'spell', 1, Y)

  nosense = addWord('nosense')
  addContext(nosense.wordId, 'The nosense word has a real sentence here.', Y)
  addLog(nosense.wordId, nosense.cardId, 'spell', 0, Y)

  nosibling = seed('nosibling')
  addLog(nosibling.wordId, nosibling.cardId, 'spell', 0, Y)

  todayonly = seed('todayonly')
  addLog(todayonly.wordId, todayonly.cardId, 'spell', 1, TODAY) // 今天才忘的

  answered = seed('answered')
  addLog(answered.wordId, answered.cardId, 'spell', 1, Y) // 昨天忘过
  addLog(answered.wordId, answered.cardId, 'tomorrow', 1, TODAY) // 今天已经回访过

  // —— submitRecap 专用词（不参与候选池断言）
  dup = addWord('dup') // 昨天开的债，用来测「重复提交不多写日志」
  addDebt(dup.wordId, dup.cardId, Y, null)

  dupwrong = addWord('dupwrong') // 没有债，用来测「重复答错不刷新债务」

  // 只看没答（ok=null）用：昨天开的债，提交时不该被清
  noanswer = addWord('noanswer')
  addDebt(noanswer.wordId, noanswer.cardId, Y, null)

  nullpick = addWord('nullpick') // pick 只看了没答（ok=NULL）
  addSense(nullpick.wordId, {
    senseHere: 'n. 没答的义项',
    personal: 'The nullpick example is here.',
    otherSentence: 'Another nullpick sentence.',
    otherGloss: '另一义',
  })
  addLog(nullpick.wordId, nullpick.cardId, 'pick', null, now)

  SKIP_IDS = new Set([
    match.wordId,
    renew.wordId,
    again.wordId, // 今天不追问，明天才出
    freshdebt.wordId,
    bareword.wordId,
    nosense.wordId,
    nosibling.wordId,
    todayonly.wordId,
    answered.wordId,
  ])
})

afterAll(() => {
  temp.cleanup()
})

describe('模块导出', () => {
  it('buildRecap / submitRecap / senseMap 都是函数', () => {
    eq(typeof r5.buildRecap, 'function', 'buildRecap 应该是函数')
    eq(typeof r5.submitRecap, 'function', 'submitRecap 应该是函数')
    eq(typeof r5.senseMap, 'function', 'senseMap 应该是函数')
  })
})

describe('buildRecap', () => {
  it('7 个候选全部出题，同义/异义配额 4/3，一个词只出一道', () => {
    const recap7 = r5.buildRecap(store, { limit: 10 })
    eq(recap7.trials.length, 7, 'limit=10 时 7 个候选词应该全部出题')
    eq(countSame(recap7.trials).same, 4, '7 题应该 4 道同义')
    eq(countSame(recap7.trials).diff, 3, '7 题应该 3 道异义')

    const ids = new Set(recap7.trials.map((t) => t.wordId))
    eq(ids.size, 7, '同一个词不能出两道题')
    for (const id of ELIGIBLE_IDS) ok(ids.has(id), '候选词 ' + id + ' 应该出题')
    for (const id of SKIP_IDS) ok(!ids.has(id), '不该出题的词 ' + id + ' 出现在回访里')
  })

  it('终止条件：答对且债清不再出、答错继续、今天新债不算', () => {
    const recap7 = r5.buildRecap(store, { limit: 10 })
    const ids = new Set<number>(recap7.trials.map((t) => t.wordId))
    // R5 终止条件（task-5 的核心修复）
    ok(!ids.has(match.wordId), '昨天答对且无债 → 今天不该再出题（终止）')
    ok(!ids.has(renew.wordId), '债已清 + 昨天答对 → 终止，不该再出题')
    ok(ids.has(reask.wordId), '昨天回访答错 → 今天还应该出题')
    ok(!ids.has(again.wordId), '今天主队列才 Again 开的债，不该算今天的回访理由')
    ok(!ids.has(freshdebt.wordId), '只有今天开的债 → 今天不出题，明天才出')
    ok(ids.has(charge.wordId), '昨天开债且仍未清 → 应该出题')
    ok(ids.has(addressWord.wordId), '昨天开债、昨天补完 → 应该出题（次日检查）')
  })

  it('每题字段与义项材料正确（s1/s2/senseHere/otherGloss）', () => {
    const recap7 = r5.buildRecap(store, { limit: 10 })
    const byWord: Record<string, any> = {
      resolution,
      charge,
      latent,
      figure,
      address: addressWord,
      run: runWord,
      reask,
    }
    const WORD_OF_ID: Record<number, string> = {}
    for (const name of Object.keys(byWord)) WORD_OF_ID[byWord[name].wordId] = name
    const SENSE_OF_WORD: Record<string, any> = {
      resolution: SENSE.resolution,
      charge: SENSE.charge,
      latent: SENSE.latentNew,
      figure: SENSE.figure,
      address: SENSE.address,
      run: SENSE.run,
      reask: SENSE.reask,
    }

    for (const t of recap7.trials) {
      const name = WORD_OF_ID[t.wordId]
      const s = SENSE_OF_WORD[name]
      ok(!!name, '出现了未知 wordId：' + t.wordId)
      eq(t.word, name, 'word 字段应该是对应单词')
      ok(t.cardId > 0, name + ' 的 cardId 应该 > 0')
      eq(t.s1, SENTENCE[name], name + ' 的 s1 应该取原句')
      eq(t.s2, t.same ? s.personal : s.otherSentence, name + ' 的 s2 取错了义项句')
      eq(t.senseHere, s.senseHere, name + ' 的 senseHere 应该来自最新一份材料')
      eq(t.otherGloss, s.otherGloss, name + ' 的 otherGloss 应该来自 other_sense')
      ok(t.s1 !== t.s2, name + ' 的两句话不能一模一样')
    }
  })

  it('latent 取最新那份义项材料', () => {
    const recap7 = r5.buildRecap(store, { limit: 10 })
    const latentTrial = recap7.trials.find((t) => t.wordId === latent.wordId)
    ok(!!latentTrial, 'latent 应该出题')
    eq(
      latentTrial && latentTrial.senseHere,
      SENSE.latentNew.senseHere,
      'latent 应取最新的那份义项材料',
    )
  })

  it('配额与洗牌：连跑 5 次，题数/同义数必须稳定', () => {
    // 配额与洗牌：连跑 5 次，题数/同义数必须稳定（随机只打散顺序与选词）
    for (let round = 0; round < 5; round += 1) {
      const r = r5.buildRecap(store, { limit: 10 })
      eq(r.trials.length, 7, '第 ' + (round + 1) + ' 次 limit=10 题数应该稳定')
      eq(countSame(r.trials).same, 4, '第 ' + (round + 1) + ' 次同义配额应该稳定')
    }
  })

  it('limit=5/4/1 的题数与同义配额', () => {
    const recap5 = r5.buildRecap(store, { limit: 5 })
    eq(recap5.trials.length, 5, 'limit=5 应该出 5 道')
    eq(countSame(recap5.trials).same, 3, '5 题应该 3 道同义（奇数时同义多一题）')
    eq(countSame(recap5.trials).diff, 2, '5 题应该 2 道异义')

    const recap4 = r5.buildRecap(store, { limit: 4 })
    eq(countSame(recap4.trials).same, 2, '4 题应该 2 道同义')
    eq(countSame(recap4.trials).diff, 2, '4 题应该 2 道异义')

    const recap1 = r5.buildRecap(store, { limit: 1 })
    eq(recap1.trials.length, 1, 'limit=1 只出 1 道')
    eq(countSame(recap1.trials).same, 1, '只有 1 道时同义优先')
  })

  it('limit 参数解析：缺省 5、floor、夹到 1–20、非法值走缺省', () => {
    // limit 参数解析：缺省 5、数字 floor + 夹到 1–20、非法值走缺省（task-5 第 5 条）
    eq(r5.buildRecap(store, { limit: 0 }).trials.length, 1, 'limit=0 夹到 1，不能当缺省')
    eq(r5.buildRecap(store, { limit: -3 }).trials.length, 1, 'limit=-3 夹到 1')
    eq(r5.buildRecap(store, { limit: 2.9 }).trials.length, 2, 'limit=2.9 应该 floor 到 2')
    eq(r5.buildRecap(store, {}).trials.length, 5, 'limit 缺省是 5')
    eq(r5.buildRecap(store, { limit: 'abc' }).trials.length, 5, 'limit 非法值走缺省 5')
    eq(r5.buildRecap(store, { limit: 99 }).trials.length, 7, 'limit=99 夹到 20，仍受候选数限制')
  })
})

describe('submitRecap', () => {
  // 原脚本在第一次 submitRecap 之前取 FSRS 快照，所有提交之后再比较。
  let fsrsBefore = ''

  // 原脚本在 submitRecap 之前断言「review_log 是空的」；放到这一节的开头。
  it('造完数据后 review_log 应该是空的', () => {
    fsrsBefore = fsrsSnapshot()
    eq(
      db.prepare('SELECT COUNT(*) AS n FROM review_log').get().n,
      0,
      '造完数据后 review_log 应该是空的',
    )
  })

  it('答对：清掉昨天开的债，并落一条 stage=tomorrow 的日志', () => {
    const chargeBefore = store.getRepairDebt(charge.wordId)
    ok(chargeBefore && chargeBefore.cleared_at == null, 'charge 应该有一笔未清的债')
    const correctResult = r5.submitRecap(
      store as never,
      {
        wordId: charge.wordId,
        cardId: charge.cardId,
        ok: true,
        guess: 'same',
        elapsedMs: 1234,
      } as never,
    )
    eq(correctResult.logged, true, '答对应该写进 repair_log')
    eq(correctResult.cleared, true, '答对应该清债')
    eq(correctResult.opened, false, '答对不应该开债')
    eq(correctResult.duplicate, false, '第一次提交不是重复')
    const chargeAfter = store.getRepairDebt(charge.wordId)
    ok(chargeAfter && chargeAfter.cleared_at != null, '答对后 charge 的债应该 cleared_at 非空')
    const chargeLog = db
      .prepare(
        `SELECT * FROM repair_log WHERE word_id = ? AND stage = 'tomorrow'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(charge.wordId)
    ok(!!chargeLog, '答对应该落一条 stage=tomorrow 的 repair_log')
    eq(chargeLog.stage, 'tomorrow', '日志 stage 应该是 tomorrow')
    eq(chargeLog.ok, 1, '答对时 ok 应该是 1')
    eq(chargeLog.guess, 'same', 'guess 应该原样记下 same')
    eq(chargeLog.elapsed_ms, 1234, 'elapsedMs 应该透传')
  })

  it('今天主队列刚开的债不能被回访清掉', () => {
    const freshDebtBefore = store.getRepairDebt(freshdebt.wordId)
    ok(freshDebtBefore && freshDebtBefore.cleared_at == null, 'freshdebt 应该有一笔今天开的未清债')
    const freshResult = r5.submitRecap(
      store as never,
      {
        wordId: freshdebt.wordId,
        cardId: freshdebt.cardId,
        ok: true,
        guess: 'same',
      } as never,
    )
    eq(freshResult.logged, true, '今天开的债也要记日志')
    eq(freshResult.cleared, false, '今天主队列刚开的债不能被回访清掉')
    const freshDebtAfter = store.getRepairDebt(freshdebt.wordId)
    ok(freshDebtAfter && freshDebtAfter.cleared_at == null, 'freshdebt 的债必须还开着')
    eq(
      Number(freshDebtAfter.opened_at),
      Number(freshDebtBefore.opened_at),
      '今天开的债 opened_at 不能被改',
    )
  })

  it('幂等：重复提交不新增日志、不刷新债务', () => {
    const dupFirst = r5.submitRecap(
      store as never,
      {
        wordId: dup.wordId,
        cardId: dup.cardId,
        ok: true,
        guess: 'same',
      } as never,
    )
    eq(dupFirst.logged, true, 'dup 第一次提交应该成功')
    eq(dupFirst.cleared, true, 'dup 昨天开的债应该被清')
    eq(dupFirst.duplicate, false, 'dup 第一次不是重复')
    const dupClearedAt = store.getRepairDebt(dup.wordId).cleared_at
    eq(tomorrowLogCount(dup.wordId), 1, 'dup 第一次提交只应有一行日志')
    const dupSecond = r5.submitRecap(
      store as never,
      {
        wordId: dup.wordId,
        cardId: dup.cardId,
        ok: true,
        guess: 'same',
      } as never,
    )
    eq(dupSecond.logged, true, 'dup 第二次提交也算已记录')
    eq(dupSecond.duplicate, true, 'dup 第二次应该命中幂等路径')
    eq(dupSecond.cleared, false, '重复提交不再动债')
    eq(tomorrowLogCount(dup.wordId), 1, '重复提交不能多写一行日志')
    eq(
      Number(store.getRepairDebt(dup.wordId).cleared_at),
      Number(dupClearedAt),
      '重复提交不改变 cleared_at',
    )
  })

  it('答错：首次开债，重复提交走幂等且不刷新 opened_at/tries', () => {
    const dupWrongFirst = r5.submitRecap(
      store as never,
      {
        wordId: dupwrong.wordId,
        cardId: dupwrong.cardId,
        ok: false,
        guess: 'diff',
      } as never,
    )
    eq(dupWrongFirst.opened, true, '答错第一次应该开债')
    const dupWrongDebt = store.getRepairDebt(dupwrong.wordId)
    const dupWrongOpenedAt = Number(dupWrongDebt.opened_at)
    const dupWrongTries = Number(dupWrongDebt.tries)
    const dupWrongSecond = r5.submitRecap(
      store as never,
      {
        wordId: dupwrong.wordId,
        cardId: dupwrong.cardId,
        ok: false,
        guess: 'diff',
      } as never,
    )
    eq(dupWrongSecond.duplicate, true, '答错重复提交也应该走幂等')
    eq(dupWrongSecond.opened, false, '重复提交不再开债')
    eq(tomorrowLogCount(dupwrong.wordId), 1, '答错重复提交不能多写日志')
    const dupWrongDebt2 = store.getRepairDebt(dupwrong.wordId)
    eq(Number(dupWrongDebt2.opened_at), dupWrongOpenedAt, '重复提交不能刷新 opened_at')
    eq(Number(dupWrongDebt2.tries), dupWrongTries, '重复提交不能刷新 tries')
  })

  it('日志写失败时整体回滚：不动债、不多写半行日志', () => {
    const logCountBeforeBad = db.prepare('SELECT COUNT(*) AS n FROM repair_log').get().n
    const badWordResult = r5.submitRecap(
      store as never,
      {
        wordId: 999999,
        cardId: charge.cardId,
        ok: true,
        guess: 'same',
      } as never,
    )
    eq(badWordResult.logged, false, '日志写不进去时 submitRecap 应该失败')
    eq(badWordResult.cleared, false, '日志失败时不能动债')
    eq(badWordResult.opened, false, '日志失败时不能开债')
    eq(
      db.prepare('SELECT COUNT(*) AS n FROM repair_log').get().n,
      logCountBeforeBad,
      '日志失败时 repair_log 不能多出半行',
    )
  })

  it('缺 wordId 直接失败返回，结构仍然完整', () => {
    const badResult = r5.submitRecap(store as never, {} as never)
    eq(badResult.logged, false, '缺 wordId 应该直接失败返回')
    eq(badResult.duplicate, false, '失败时 duplicate 也是 false')
    eq(typeof badResult.cleared, 'boolean', '失败时返回结构仍然完整')
  })

  it('ok=null（只看没答）只写日志不动债', () => {
    const noAnswerResult = r5.submitRecap(
      store as never,
      {
        wordId: noanswer.wordId,
        cardId: noanswer.cardId,
      } as never,
    )
    eq(noAnswerResult.logged, true, 'ok=null 也要记日志')
    eq(noAnswerResult.cleared, false, 'ok=null 不能清债')
    eq(noAnswerResult.opened, false, 'ok=null 不能开债')
    ok(store.getRepairDebt(noanswer.wordId).cleared_at == null, 'ok=null 后债应该还开着')
  })

  it('FSRS 侧零污染：submitRecap 不改 review_log 或 cards 表', () => {
    // fsrsBefore 在第一节（任何 submitRecap 之前）取；这里比较所有提交之后的状态。
    eq(fsrsSnapshot(), fsrsBefore, 'submitRecap 不能改 review_log 或 cards 表')
  })

  it('今天已回访的词不再出题，答错过的词继续出', () => {
    const recapAfterAnswer = r5.buildRecap(store, { limit: 10 })
    eq(recapAfterAnswer.trials.length, 6, '答过 charge 后应该只剩 6 道题')
    ok(
      !recapAfterAnswer.trials.some((t) => t.wordId === charge.wordId),
      'charge 今天已经回访过，不该再出题',
    )
    ok(
      recapAfterAnswer.trials.some((t) => t.wordId === reask.wordId),
      '答错过的词明天（=下一次回访）还应该继续出',
    )
  })
})

describe('明天还会不会出', () => {
  it('拨到明天：again/freshdebt/todayonly 继续出，终止与过期窗口退出', () => {
    // 把时间拨到明天：今天变成「昨天」。
    // again：昨天答对、今天主队列 Again → 明天继续出（task-5 用例 3）
    // freshdebt：今天开的债 → 明天变成「昨天开的债」，继续出
    // todayonly：今天才忘 → 明天变成「昨天补记过」，继续出
    // resolution 等昨天（=今天-2）活动的词应该退出候选（窗口是按天的）
    const tomorrowRecap = r5.buildRecap(store, { limit: 50, now: TOMORROW })
    const tomorrowIds = new Set(tomorrowRecap.trials.map((t) => t.wordId))
    ok(tomorrowIds.has(again.wordId), '昨天答对但今天又评 Again → 明天必须继续出')
    ok(tomorrowIds.has(freshdebt.wordId), '今天开的债 → 明天应该作为「昨天开的债」出题')
    ok(tomorrowIds.has(todayonly.wordId), '今天才忘的词 → 明天应该回访')
    ok(!tomorrowIds.has(match.wordId), '昨天答对且无债 → 明天仍然不出（终止是永久的）')
    ok(!tomorrowIds.has(renew.wordId), '债已清 + 答对 → 明天仍然不出')
    ok(!tomorrowIds.has(resolution.wordId), '前天/昨天以前的补记活动不该跨天重复出题')
    eq(tomorrowRecap.trials.length, 3, '拨到明天后应该正好 3 道题（again / freshdebt / todayonly）')
    eq(countSame(tomorrowRecap.trials).same, 2, '3 题应该 2 道同义')
  })
})

describe('senseMap', () => {
  it('义项按时间排序，pick 按时间就近归属材料', () => {
    const latentMap = r5.senseMap(store as never, 'latent' as never)
    eq(latentMap.length, 2, 'latent 应该有两个义项')
    eq(latentMap[0].senseKey, SENSE.latentNew.senseHere, '最新义项排在第一个')
    eq(latentMap[0].gloss, SENSE.latentNew.senseHere, 'gloss 取 sense_here')
    eq(latentMap[1].senseKey, SENSE.latentOld.senseHere, '旧义项排在后面')
    // pick 发生在旧材料那个时候（Y），不能算到之后生成的新材料上
    eq(latentMap[0].status, 'seen', 'pick 早于该材料生成 → 不能算到新义项上')
    eq(latentMap[1].status, 'wrong', 'pick 的成败应该归给当时最近的那份材料')

    // 再答对一次（时间在最新材料之后）：归属最新材料，状态 right
    addLog(latent.wordId, latent.cardId, 'pick', 1, now + 1)
    const latentMap2 = r5.senseMap(store as never, 'latent' as never)
    eq(latentMap2[0].status, 'right', '再答对后当前义项应该变成 right')
    eq(latentMap2[1].status, 'seen', '旧义项不再带判别状态')
  })

  it('pick.ok=NULL 归 seen，没有 pick 记录也归 seen', () => {
    // pick.ok = NULL（只看了没答）→ seen，不是 wrong
    const nullpickMap = r5.senseMap(store as never, 'nullpick' as never)
    eq(nullpickMap.length, 1, 'nullpick 有一个义项')
    eq(nullpickMap[0].status, 'seen', 'pick.ok=NULL 归 seen，不能算答错')

    const resolutionMap = r5.senseMap(store as never, 'resolution' as never)
    eq(resolutionMap.length, 1, 'resolution 只有一个义项')
    eq(resolutionMap[0].status, 'seen', '没有 pick 记录时是 seen')
  })

  it('入参与空值返回：word_id 字符串、无材料词、不存在的词、空串', () => {
    // 传 word_id 也能用（调试口子）
    eq(
      r5.senseMap(store as never, String(latent.wordId) as never).length,
      2,
      'senseMap 支持直接传 word_id',
    )
    eq(r5.senseMap(store as never, 'nosense' as never).length, 0, '没有 sense_meta 的词返回空数组')
    eq(r5.senseMap(store as never, 'not-a-word' as never).length, 0, '不存在的词返回空数组')
    eq(r5.senseMap(store as never, '' as never).length, 0, '空单词返回空数组')
  })
})
