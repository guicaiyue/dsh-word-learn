// store/schema.mjs —— 用户库的路径、表结构与迁移。
//
// 与词典分开：词典是只读的共享资源（data/ecdict.db，可重新生成），
// 用户数据是**不可再生**的，放 $DSH_HOME 下，跟其它 DSH 插件数据一致。
//
// 为什么单独一层：SCHEMA 与 migrate() 回答「库长什么样」，
// 而 lib/store/words.mjs 等回答「怎么读写」。schema 变更规则见 CONVENTIONS §6.3：
//   - CREATE TABLE IF NOT EXISTS 只对新库生效，老库必须靠 migrate() 补齐；
//   - 迁移必须幂等：老库 / 新库 / 半新库跑同一段代码得到同一结构；
//   - 禁止 DROP TABLE、重建库、改列类型、在迁移里写业务逻辑。
//
// ⚠️ SCHEMA 与 migrate() 的内容和顺序都不许改语义：迁移顺序本身是历史债。
import os from 'node:os'
import path from 'node:path'
import { ensureCards } from '../host/schedule.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const DATA_DIR = path.join(DSH_HOME, 'dsh-word-learn')
export const DB_FILE = path.join(DATA_DIR, 'user.db')

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 生词本：一个词一行
CREATE TABLE IF NOT EXISTS words (
  id            INTEGER PRIMARY KEY,
  word          TEXT NOT NULL UNIQUE,   -- 原形，小写
  phonetic      TEXT,
  translation   TEXT,
  pos           TEXT,
  tag           TEXT,
  frq           INTEGER DEFAULT 0,
  bnc           INTEGER DEFAULT 0,
  collins       INTEGER DEFAULT 0,
  freq_tier     TEXT,                   -- 入册时的词频档位，用于分级展示
  -- 五维能力画像（0-5）。只影响"出什么题"和"是否毕业"，不单独排期。
  k_recognize   INTEGER DEFAULT 0,      -- 认得
  k_meaning     INTEGER DEFAULT 0,      -- 意思
  k_write       INTEGER DEFAULT 0,      -- 能写
  k_listen      INTEGER DEFAULT 0,      -- 能听
  k_pronounce   INTEGER DEFAULT 0,      -- 能读准
  known_senses  TEXT DEFAULT '[]',      -- 已知义项 JSON 数组
  note          TEXT DEFAULT '',        -- 用户自己的笔记
  starred       INTEGER DEFAULT 0,      -- 手动收藏
  graduated     INTEGER DEFAULT 0,      -- 1 = 五维全满，永久不再出现
  seen_count    INTEGER DEFAULT 0,      -- 累计遇见次数
  created_at    INTEGER NOT NULL,
  seen_at       INTEGER                 -- 最近一次遇见
);

-- 遇见它的原句与出处（用户的语境资产）
CREATE TABLE IF NOT EXISTS contexts (
  id         INTEGER PRIMARY KEY,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sentence   TEXT NOT NULL,
  source     TEXT DEFAULT '',           -- 来自哪个界面/会话
  created_at INTEGER NOT NULL
);

-- 排期线：一个词最多两条（receptive / productive）。P2 起写入。
--
-- ⚠️ learning_steps 是**调度状态的一部分，不是装饰**：
-- 它是"当前在第几个学习步"。丢掉它卡片会永远卡在 Learning 状态，
-- 永远毕业不到 Review，而且**不报错**（所有间隔恒为 0 天）。
-- 详见 lib/schedule.mjs 顶部注释里的实测对照。
CREATE TABLE IF NOT EXISTS cards (
  id             INTEGER PRIMARY KEY,
  word_id        INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  track          TEXT NOT NULL,          -- 'receptive' | 'productive'
  due            INTEGER,
  stability      REAL,
  difficulty     REAL,
  elapsed_days   INTEGER DEFAULT 0,
  scheduled_days INTEGER DEFAULT 0,
  reps           INTEGER DEFAULT 0,
  lapses         INTEGER DEFAULT 0,
  state          INTEGER DEFAULT 0,      -- 0新 1学习中 2复习中 3重学中
  learning_steps INTEGER DEFAULT 0,      -- 见上方警告：不能省
  last_review    INTEGER,
  leech_count    INTEGER DEFAULT 0,
  suspended      INTEGER DEFAULT 0,      -- 1 = leech 挂起，不再进队列
  UNIQUE(word_id, track)
);

-- 每次交互。P1 只记 view 类弱信号，P2 起记答题。
CREATE TABLE IF NOT EXISTS review_log (
  id         INTEGER PRIMARY KEY,
  card_id    INTEGER,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  rating     INTEGER,                    -- 1=Again 2=Hard 3=Good 4=Easy
  kind       TEXT NOT NULL,              -- 题型
  evidence   TEXT DEFAULT '',            -- view|hover|expand|answer
  elapsed_ms INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 插件设置（键值对）。目前只存 AI 分析模型的选择。
-- 为什么放这里而不是插件 config：模型要在设置页里随时改，改完立刻生效，
-- 而 config 只能改 cordis.patch.yml 再重启；用户数据本来就是随插件走的。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 义项级学习材料（P1）。一个词可以有多条，按句子的语境义项区分。
-- 为什么单独一张表：word_meta 是词级的（词根/记忆法），回答不了
-- "这句话里是哪个义项"；补记卡需要的正是后者。
CREATE TABLE IF NOT EXISTS sense_meta (
  id         INTEGER PRIMARY KEY,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_key  TEXT NOT NULL,
  json       TEXT NOT NULL,
  model      TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(word_id, sense_key)
);

-- 补记事件（回忆/对照/拼写/复现）。只用于选内容和算指标，不参与 FSRS 排期。
CREATE TABLE IF NOT EXISTS repair_log (
  id         INTEGER PRIMARY KEY,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  card_id    INTEGER,
  stage      TEXT NOT NULL,       -- pick|reveal|spell|session_end|tomorrow
  ok         INTEGER,             -- 0/1；pick 阶段为猜对/猜错
  guess      TEXT DEFAULT '',     -- 他选了什么
  elapsed_ms INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 补记债：每按一次「忘了」开一笔，R3+R4 都成功才清。
-- 用"债"而不是扣分：忘记不定罪，跳过才要补。
CREATE TABLE IF NOT EXISTS repair_debt (
  word_id    INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
  card_id    INTEGER,
  track      TEXT NOT NULL,
  opened_at  INTEGER NOT NULL,
  cleared_at INTEGER,
  tries      INTEGER DEFAULT 0
);
`

/**
 * 索引：**必须在 migrate() 之后建**。
 *
 * 为什么单独拆出来：SCHEMA 里的 CREATE INDEX 会在 CREATE TABLE 之后立刻执行，
 * 而老库（P1 时代建的）的 words 表可能还没有 freq_tier 列 ——
 * 对不存在的列建索引会直接抛 "no such column: freq_tier"，
 * open() 整个失败、migrate() 根本没机会补列。实测症状是插件每 10s 报
 * "打不开用户数据库"，所有接口 500，只能重启宿主。
 * 现在顺序固定为：建表（IF NOT EXISTS）→ migrate 补列 → 建索引（IF NOT EXISTS）。
 */
export const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_words_seen ON words(seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_words_tier ON words(freq_tier);
CREATE INDEX IF NOT EXISTS idx_ctx_word ON contexts(word_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_log_word ON review_log(word_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sense_word ON sense_meta(word_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repair_word ON repair_log(word_id, created_at DESC);
`

/**
 * 把老库补齐到当前 schema。
 *
 * 为什么必须有：`CREATE TABLE IF NOT EXISTS` 对**已存在**的表什么都不做，
 * 所以给 cards 加列不会自动生效。本地那个库是 P1 建的（没有
 * learning_steps / suspended），不迁移的话排期会静默失效 ——
 * 正是 schedule.mjs 里警告的那个"所有间隔恒为 0 天"的故障。
 *
 * 用 PRAGMA table_info 逐列检查，缺什么补什么；已经是对的库走一遍
 * 只是几条查询，代价可忽略。
 */
export function migrate(db) {
  const cols = (table) => {
    try {
      return db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => r.name)
    } catch (err) {
      return []
    }
  }

  const cardCols = cols('cards')
  if (cardCols.length) {
    for (const [name, decl] of [
      ['learning_steps', 'INTEGER DEFAULT 0'],
      ['suspended', 'INTEGER DEFAULT 0'],
      ['leech_count', 'INTEGER DEFAULT 0'],
      ['elapsed_days', 'INTEGER DEFAULT 0'],
      ['scheduled_days', 'INTEGER DEFAULT 0'],
      ['stability', 'REAL'],
      ['difficulty', 'REAL'],
      ['last_review', 'INTEGER'],
    ]) {
      if (cardCols.includes(name)) continue
      try {
        db.exec(`ALTER TABLE cards ADD COLUMN ${name} ${decl}`)
      } catch (err) {
        /* 并发或已存在，忽略 */
      }
    }
  }

  const wordCols = cols('words')
  if (wordCols.length) {
    for (const [name, decl] of [
      ['known_senses', "TEXT DEFAULT '[]'"],
      ['note', "TEXT DEFAULT ''"],
      ['graduated', 'INTEGER DEFAULT 0'],
      ['lemma', 'TEXT'],
      ['freq_tier', 'TEXT'],
      ['word_meta', "TEXT DEFAULT ''"],
    ]) {
      if (wordCols.includes(name)) continue
      try {
        db.exec(`ALTER TABLE words ADD COLUMN ${name} ${decl}`)
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  // 补建缺失的排期卡。
  //
  // P1 的词是在 ensureCards 存在之前入册的，所以老库里的词**一张卡都没有**
  // —— 表现为学习页"已开始学习 0"，而词明明在库里。
  // 这里给所有没卡的词补上，让升级后立刻能排期。
  try {
    const orphans = db
      .prepare('SELECT id FROM words WHERE id NOT IN (SELECT DISTINCT word_id FROM cards)')
      .all()
    for (const row of orphans) ensureCards(db, row.id, Date.now())
  } catch (err) {
    /* 表结构异常时跳过，不影响打开 */
  }
}
