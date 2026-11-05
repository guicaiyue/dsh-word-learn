/* dsh-word-learn —— 学习页纯逻辑（构建源码，ESM）。
 *
 * 原来是一段注入页面的 IIFE（assets/dashboard-logic.js），由 dashboard.js 从
 * window.__dwlDashboardLogic 消费，靠 20×50ms 轮询 + dwl:assets-ready 事件等它到齐 ——
 * 那是「禁止 import」逼出来的就绪协议。阶段 2 起它是本 bundle 的一个模块：直接 import，
 * 构建期就绑好，不存在「晚到」。
 *
 * 约束：纯函数/常量，不碰 DOM 结构、不注册监听、不写样式（localStorage 偏好除外）。
 */
/** 宿主侧路由前缀。 */
const API = '/dsh-word-learn'

/** 记住上次停在哪个视图（只影响体验，读不到就退回默认值）。 */
const VIEW_KEY = 'dsh-word-learn:view'

/** localStorage key：美音 / 英音偏好。与 wordcard.js 共享。 */
const ACCENT_KEY = 'dwl-voice-accent'

/**
 * localStorage key：R5「昨日回访」今天已经跳过了。
 *
 * 为什么放在前端：跳过不该有任何副作用（不清债、不写库），但同一个页面
 * 刷新后不能又把同一批题怼回来 —— 那是骚扰，不是复习。按**本地日期**存，
 * 换一天自动失效，不用清理。
 */
const RECAP_SKIP_KEY = 'dsh-word-learn:recap-skip'

/**
 * 义项地图的状态文案。
 * 状态码来自 lib/r5.mjs 的 senseMap()：seen / right / wrong。
 */
const SENSE_STATUS_LABEL = { seen: '见过', right: '答对过', wrong: '答错过' }

/** 三个视图。顺序即标签顺序。 */
const TABS = [
  { key: 'study', label: '学习' },
  { key: 'vocab', label: '词汇' },
  { key: 'stats', label: '数据' },
  { key: 'settings', label: '设置' },
]

/** 词频档位的中文名与颜色。颜色只用于堆叠条与图例。 */
const TIERS = [
  { key: 'top1k', label: '最高频 1000', color: 'var(--dsw-alias-state-success-primary)' },
  { key: 'top3k', label: '高频 3000', color: 'var(--dsw-alias-state-business-primary)' },
  { key: 'top8k', label: '常用 8000', color: 'var(--dwl-accent)' },
  { key: 'rare', label: '低频 / 专业', color: 'var(--dsw-alias-state-warn-primary)' },
  { key: 'unknown', label: '未分级', color: 'var(--dsw-alias-label-tertiary)' },
]

/** 五维画像的中文名。顺序即展示顺序。 */
const ABILITIES = [
  { key: 'recognize', label: '认得', hint: '看到词形能想起意思' },
  { key: 'meaning', label: '意思', hint: '知道它在句子里的确切含义' },
  { key: 'write', label: '能写', hint: '能主动拼写出来' },
  { key: 'listen', label: '能听', hint: '听到能反应过来' },
  { key: 'pronounce', label: '读准', hint: '发音能被识别' },
]

/**
 * 评分按钮。数字与 ts-fsrs 的 Rating 一致。
 *
 * `tone` 只影响 hover 描边色，不写死背景 —— 深色主题下才不会糊成一片。
 */
const RATINGS = [
  { value: 1, label: '忘了', key: '1', tone: 'again' },
  { value: 2, label: '勉强', key: '2', tone: 'hard' },
  { value: 3, label: '记得', key: '3', tone: 'good' },
  { value: 4, label: '太简单', key: '4', tone: 'easy' },
]

/**
 * 三分支自评选项。
 * FSRS 映射：forgot→1(Again)  fuzzy+fail→2(Hard)  fuzzy+pass→3(Good)  remember+pass→4(Easy)
 */
const BRANCHES = [
  { key: 'forgot', label: '忘了', desc: '完全想不起来', tone: 'again' },
  { key: 'fuzzy', label: '模糊', desc: '有点印象', tone: 'hard' },
  { key: 'remember', label: '记得', desc: '我知道', tone: 'good' },
]

// ---------------------------------------------------------------- 工具

/** 取 JSON；非 2xx 也把 body 读出来，因为宿主的错误信息在里面。 */
async function api(path, options = {}) {
  const res = await fetch(API + path, {
    method: options.method || 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
  })
  let json
  try {
    json = await res.json()
  } catch (err) {
    json = { ok: false, error: `HTTP ${res.status}` }
  }
  return json
}

/** 相对时间，给"最近加入"和复习时间用。 */
function relTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 月/日，图表横轴用。 */
function fmtMD(ts) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * 本地日期键（YYYY-MM-DD）。
 *
 * 为什么不用 toISOString().slice(0,10)：那是 **UTC** 日期，东八区早上 8 点
 * 之前会算成昨天，「今天已跳过回访」就会在早上莫名失效。与 dayStart 同口径。
 */
function localDayKey(date) {
  const d = date || new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 今天的「昨日回访」是不是已经跳过了。localStorage 读不到就当没跳过。 */
function recapSkippedToday() {
  try {
    return window.localStorage.getItem(RECAP_SKIP_KEY) === localDayKey()
  } catch (err) {
    return false
  }
}

/** 记下「今天跳过回访」。写不进去也不影响功能。 */
function markRecapSkipped() {
  try {
    window.localStorage.setItem(RECAP_SKIP_KEY, localDayKey())
  } catch (err) {}
}

/**
 * 释义拆成「主释义 + 其余义项」。
 *
 * ECDICT 的 translation 是换行分隔的多条义项，原来整段塞进一行里截断，
 * 用户只看到第一个分号前面那半句。这里拆开，第一条放大，其余降一级。
 */
function splitSenses(translation) {
  const lines = String(translation || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!lines.length) return { lead: '', rest: [] }
  return { lead: lines[0], rest: lines.slice(1, 4) }
}

/**
 * 在句子里定位目标词，只截取词附近一段（原句可能来自很长的思维链）。
 *
 * 不用正则转义：队列里的词都是词典词条（纯字母），不会有元字符。
 * 允许 -s/-ed/-ing 这类变形；找不到返回 null，调用方降级。
 */
function wordSpot(sentence, word) {
  const s = String(sentence || '')
  const w = String(word || '').toLowerCase()
  if (!s || !w) return null
  const re = new RegExp('(^|[^a-zA-Z])(' + w + '[a-z]{0,4})(?![a-zA-Z])', 'i')
  const m = re.exec(s)
  if (!m) return null
  const token = m[2]
  const at = m.index + m[1].length
  const from = Math.max(0, at - 90)
  const to = Math.min(s.length, at + token.length + 110)
  return {
    before: (from > 0 ? '…' : '') + s.slice(from, at),
    token,
    after: s.slice(at + token.length, to) + (to < s.length ? '…' : ''),
  }
}

// ---------------------------------------------------------------- 发音
//
// 发音交给浏览器自带语音（注入的 voice.js 提供 window.__dwlVoice，
// Windows 上就是系统里的 Microsoft 音色）：零网络、无密钥、离线可用。
//
// 为什么不用服务端发音 / 有道：用户明确只要浏览器自带的免费前端语音。
// 本文件只管按钮状态与失败提示；选音色、切句、取消、并发打断都在 voice.js 里。

/** 语音模块没加载成功时的统一提示。 */
const VOICE_MISSING = '语音模块未加载，刷新页面重试'

/** 取注入的语音模块；缺失时返回 null，调用方一律降级。 */
function voiceModule() {
  return (typeof window !== 'undefined' && window.__dwlVoice) || null
}

/** 把 voice.js 的失败码翻成一句人话（它抛的 Error 带 code）。 */
function voiceErrorText(err) {
  const code = String((err && err.code) || '').toUpperCase()
  if (code === 'UNSUPPORTED') return '这个浏览器不支持语音合成'
  if (code === 'NO_VOICE') return '系统里没有可用的英文音色，检查系统语音包'
  if (code === 'EMPTY_TEXT') return '没有要读的内容'
  if (code === 'TIMEOUT') return '系统语音没有响应，再点一次试试'
  if (code === 'SYNTH_FAILED') return '系统语音调用失败，请重试'
  return (err && err.message) || '语音合成失败'
}

/** 被"重新点一次 / 切词"打断不算失败。 */
function isAbort(err) {
  if (!err) return false
  const code = String(err.code || '').toUpperCase()
  return code === 'ABORTED' || code === 'interrupted' || code === 'canceled'
}

/** 朗读一个单词。读完 resolve；模块缺失/不支持时 reject（带一句人话）。 */
function playWord(word, accent) {
  const text = String(word || '').trim()
  if (!text) return Promise.reject(new Error('没有要读的内容'))
  const mod = voiceModule()
  if (!mod || typeof mod.speak !== 'function') {
    return Promise.reject(new Error(VOICE_MISSING))
  }
  // 重播先停上一条（voice.js 内部也会打断，但显式一点更稳）
  try {
    if (typeof mod.stop === 'function') mod.stop()
  } catch (err) {}
  try {
    return Promise.resolve(mod.speak(text, { accent: accent === 'uk' ? 'uk' : 'us' }))
  } catch (err) {
    return Promise.reject(err)
  }
}

// ---- 学习时的自动发音开关（跟着浏览器走，和口音偏好的存法一致）----
const AUTO_SPEAK_KEY = 'dwl-auto-speak'

/** 默认开：进页面、看答案、拼完单词都自动读一遍。 */
function loadAutoSpeak() {
  try {
    return window.localStorage.getItem(AUTO_SPEAK_KEY) !== '0'
  } catch (err) {
    return true
  }
}
function saveAutoSpeak(on) {
  try {
    window.localStorage.setItem(AUTO_SPEAK_KEY, on ? '1' : '0')
  } catch (err) {}
}

// ---- 口音偏好读写（与 wordcard.js 共用同一个 localStorage key）----
function loadAccent() {
  try {
    return window.localStorage.getItem(ACCENT_KEY) === 'uk' ? 'uk' : 'us'
  } catch (_) {
    return 'us'
  }
}
function saveAccent(v) {
  try {
    window.localStorage.setItem(ACCENT_KEY, v)
  } catch (_) {}
}

/** 读上次的视图。localStorage 在隐私模式下会抛，所以包一层。 */
function readView() {
  try {
    const v = window.localStorage.getItem(VIEW_KEY)
    if (v === 'study' || v === 'vocab' || v === 'stats') return v
  } catch (err) {}
  return 'study'
}

function saveView(v) {
  try {
    window.localStorage.setItem(VIEW_KEY, v)
  } catch (err) {}
}

/** 估算剩余时间：一个词大约 8 秒（回忆 + 评分）。 */
function estimateMinutes(n) {
  if (n <= 0) return '0 分钟'
  const sec = n * 8
  if (sec < 60) return '不到 1 分钟'
  return `约 ${Math.round(sec / 60)} 分钟`
}

/** 去掉大小写、空格和标点，只留字母。 */
function normalizeSpelling(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
}

/** 编辑距离（Levenshtein）。只用来容忍一两个字母的笔误。 */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99
  let prev = []
  for (let j = 0; j <= b.length; j++) prev.push(j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * 比对拼写。返回 { state, distance }：
 *   exact —— 完全一致
 *   close —— 一两个字母的笔误（长词放宽到 2 个字符，且首字母必须对——
 *            否则 "patent" / "latent" 这种"拼成另一个真词"会被算成对）
 *   miss  —— 没写对
 */
function spellCheck(input, word) {
  const a = normalizeSpelling(input)
  const b = normalizeSpelling(word)
  if (!a || !b) return { state: 'miss', distance: 99 }
  const d = editDistance(a, b)
  if (d === 0) return { state: 'exact', distance: 0 }
  const tolerance = b.length >= 8 ? 2 : 1
  if (d <= tolerance && a[0] === b[0]) return { state: 'close', distance: d }
  return { state: 'miss', distance: d }
}

// ------------------------------------------------------------ 组件内纯算术 / 纯映射
//
// 这些原来散在各 React 组件里（StatsView 的取数、VocabView 的过滤、SettingsView 的
// 模型分组、StudyView 的评级映射）。搬到这里的理由：口径只留一份，组件只负责渲染；
// 以后改算法不用钻进 JSX 里找。

/** 评分按钮 tone → 主题令牌（作答分布条上色用；颜色只走令牌，不写死）。 */
const TONE_COLOR = {
  again: 'var(--dsw-alias-state-error-primary)',
  hard: 'var(--dsw-alias-state-warn-primary)',
  good: 'var(--dsw-alias-state-success-primary)',
  easy: 'var(--dsw-alias-state-business-primary)',
}

/**
 * 数据页需要的全部派生值（KPI / 14 天曲线 / 能力画像 / 作答分布）。
 * 返回对象直接被 StatsView 解构，算术不进 JSX。
 */
function statsViewModel(data) {
  const w = data.words || {}
  const c = data.cards || {}
  const q = data.queue || {}
  const acc = data.accuracy || { dist: {}, total: 0, rate: 0 }
  const started = c.started || 0
  const tierParts = TIERS.map((t) => ({
    label: t.label,
    value: (w.byTier || []).find((x) => x.tier === t.key)?.n || 0,
    color: t.color,
  }))
  const abMax = Math.max(1, ...Object.values(data.ability || {}).flatMap((b) => b || []))
  return {
    w,
    c,
    q,
    acc,
    started,
    tierParts,
    abMax,
    repair: data.repair ? repairKpis(data.repair) : null,
    dist: answerDistribution(acc),
  }
}

/** 补记循环的三块 KPI：义项首猜命中率 / 拼写通过率 / 补记债已清。 */
function repairKpis(repair) {
  const stages = repair.stages || []
  const pick = stages.find((s) => s.stage === 'pick') || { n: 0, ok: 0 }
  const spell = stages.find((s) => s.stage === 'spell') || { n: 0, ok: 0 }
  const debt = repair.debt || { opened: 0, cleared: 0 }
  return {
    pickRate: pick.n ? Math.round((pick.ok / pick.n) * 100) + '%' : '—',
    pickN: pick.n,
    spellRate: spell.n ? Math.round((spell.ok / spell.n) * 100) + '%' : '—',
    spellN: spell.n,
    debtText: debt.opened ? debt.cleared + '/' + debt.opened : '—',
  }
}

/** 能力分桶（0–5 分）的平均分文案。空桶与原来一致：均 0.0。 */
function abilityAverage(bucket) {
  const b = bucket || []
  const tot = b.reduce((s, n) => s + n, 0) || 1
  const avg = b.reduce((s, n, i) => s + n * i, 0) / tot
  return '均 ' + avg.toFixed(1)
}

/** 作答分布（按 1–4 评分）：次数 / 百分比 / tone，JSX 只负责画。 */
function answerDistribution(acc) {
  if (!acc || !acc.total) return []
  return RATINGS.map((r) => {
    const n = (acc.dist || {})[r.value] || 0
    return {
      value: r.value,
      label: r.label,
      n: n,
      pct: (n / acc.total) * 100,
      color: TONE_COLOR[r.tone],
    }
  })
}

/** 词汇页搜索：服务端没有搜索参数，只在**已加载集合**内过滤。 */
function filterLoadedItems(items, keyword) {
  if (!keyword) return items
  return items.filter(
    (x) =>
      String(x.word || '')
        .toLowerCase()
        .includes(keyword) ||
      String(x.translation || '')
        .toLowerCase()
        .includes(keyword),
  )
}

/** 词频档位缩写（列表一行放不下全称，全称走 title）。未分级返回空串。 */
const TIER_BADGE = { top1k: '1k', top3k: '3k', top8k: '8k', rare: '低频' }

function tierBadgeOf(key) {
  return TIER_BADGE[key] || ''
}

function tierLabelOf(key) {
  return (TIERS.find((x) => x.key === key) || {}).label || ''
}

/** 设置页模型目录 → 下拉需要的形状（按 provider 分组、选中下标）。 */
function modelCatalogView(catalog) {
  const models = (catalog && catalog.models) || []
  const selection = (catalog && catalog.selection) || null
  // select 的 value 用下标而不是 "provider/model"：模型 id 里可能带斜杠，
  // 拼字符串再拆会在那种模型上选错。
  const currentIndex = selection
    ? models.findIndex((m) => m.provider === selection.provider && m.id === selection.model)
    : -1
  const groups = []
  const byProvider = new Map()
  models.forEach((m, i) => {
    let g = byProvider.get(m.provider)
    if (!g) {
      g = { id: m.provider, name: m.providerName || m.provider, items: [] }
      byProvider.set(m.provider, g)
      groups.push(g)
    }
    g.items.push({ index: i, model: m })
  })
  return { models, selection, currentIndex, groups }
}

/** 「当前生效：provider · 模型名（默认：列表第一个）」那句文案。 */
function selectionText(selection) {
  if (!selection) return '无'
  const name =
    (selection.providerName || selection.provider) + ' · ' + (selection.name || selection.model)
  return name + (selection.source === 'custom' ? '' : '（默认：列表第一个）')
}

/** 模型目录为空时的提示（分「跟随会话默认模型」与「还没配模型」两种）。 */
function catalogEmptyHint(selection) {
  const follow = selection && selection.model
  return (
    'DSH 里还没有可用的文本模型，' +
    (follow
      ? '暂时跟随会话默认模型（' + (selection.name || selection.model) + '）。'
      : '请先在 DSH 设置里配置模型提供方。')
  )
}

/**
 * 选择题结算 → FSRS 评级（0 表示不评）。
 * 模糊分支答对 → Good(3)；记得分支 ≥80% → Easy(4)，否则 Good(3)。
 */
function quizRating(branch, score) {
  if (branch === 'fuzzy') return 3
  if (branch === 'remember') return score >= 0.8 ? 4 : 3
  return 0
}

/** 拼写结算 → FSRS 评级。模糊分支里 miss 记 Hard(2)，其余 Good(3)。 */
function writeRating(branch, state) {
  if (branch === 'fuzzy') return state === 'miss' ? 2 : 3
  if (state === 'exact') return 4
  if (state === 'close') return 3
  return 1
}

/**
 * 悬浮释义卡的固定坐标：词下方放不下就翻到上方，左右夹在视口内。
 * 拿不到元素（还没挂载 / 测试环境）也要能显示，给左上角兜底。
 */
function hoverPlacement(el, vw, vh) {
  const width = 300
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    return { left: 8, top: 8, width }
  }
  const r = el.getBoundingClientRect()
  const left = Math.max(8, Math.min(r.left, vw - width - 8))
  const below = vh - r.bottom > 200
  return { left, top: below ? r.bottom + 6 : Math.max(8, r.top - 196), width }
}

// ------------------------------------------------------------ 导出
// dashboard.js 只从这一个对象消费；名字即契约（改这里要同步 dashboard 的解构）。
const LOGIC = {
  api,
  relTime,
  fmtMD,
  splitSenses,
  wordSpot,
  voiceModule,
  voiceErrorText,
  isAbort,
  playWord,
  loadAutoSpeak,
  saveAutoSpeak,
  loadAccent,
  saveAccent,
  readView,
  saveView,
  estimateMinutes,
  normalizeSpelling,
  editDistance,
  spellCheck,
  TABS,
  TIERS,
  ABILITIES,
  RATINGS,
  BRANCHES,
  SENSE_STATUS_LABEL,
  recapSkippedToday,
  markRecapSkipped,
  statsViewModel,
  abilityAverage,
  filterLoadedItems,
  tierBadgeOf,
  tierLabelOf,
  modelCatalogView,
  selectionText,
  catalogEmptyHint,
  quizRating,
  writeRating,
  hoverPlacement,
}

export default LOGIC
