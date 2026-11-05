/* 生效范围（只认对话正文）、排除范围、语音降级的回归测试。
 *
 * 不重复实现被测逻辑：用 vm 整文件加载 assets/core.js（浏览器 IIFE），从
 * window.__dwlCore 取真实函数，再用极小的 DOM 桩跑断言。改了 core.js 而忘了
 * 改这里，测试会立刻红；wordcard.js 是否仍从 core.js 取用也有静态断言兜着。
 *
 * 跑法：node scripts/test-scope.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE_SRC = fs.readFileSync(path.join(HERE, '..', 'assets', 'core.js'), 'utf8')
const CARD_SRC = fs.readFileSync(path.join(HERE, '..', 'assets', 'wordcard.js'), 'utf8')
const ANNOTATE_SRC = fs.readFileSync(path.join(HERE, '..', 'assets', 'annotate.js'), 'utf8')
const CARD_VIEW_SRC = fs.readFileSync(path.join(HERE, '..', 'assets', 'wordcard-card.js'), 'utf8')
const CARD_STYLE_SRC = fs.readFileSync(path.join(HERE, '..', 'assets', 'wordcard-style.js'), 'utf8')

// ---- 用 vm 整文件加载 core.js / annotate.js（浏览器 IIFE）----------------
/** core.js 只依赖 window（语音模块走 window.__dwlVoice）；document 留空桩。 */
function loadCore(win = {}) {
  const sandbox = { window: win, document: {}, console }
  vm.createContext(sandbox)
  vm.runInContext(CORE_SRC, sandbox, { filename: 'assets/core.js' })
  if (!win.__dwlCore) throw new Error('core.js 没有暴露 window.__dwlCore')
  return win.__dwlCore
}

/**
 * 加载 annotate.js。无 DOM（document 空桩）时它只暴露 _config/_internals 就返回，
 * 正好能核对"共同黑名单是否真的来自 core"。
 */
function loadAnnotate(withCore) {
  const win = {}
  const sandbox = { window: win, document: {}, console }
  vm.createContext(sandbox)
  if (withCore) vm.runInContext(CORE_SRC, sandbox, { filename: 'assets/core.js' })
  vm.runInContext(ANNOTATE_SRC, sandbox, { filename: 'assets/annotate.js' })
  return win
}

const core = loadCore()
const {
  SCOPE_SELECTOR,
  BLOCKED_ELEMENTS,
  blockedSelector,
  EXCLUDED_SELECTOR,
  inConversation,
  inEditable,
} = core

// ---- 极小的 DOM 桩 -------------------------------------------------------
/** 造一个元素；attrs 是它自己带的 data 属性集合。 */
function el(name, attrs = {}, parent = null) {
  const node = {
    nodeType: 1,
    name,
    attrs,
    parentElement: parent,
    closest(selector) {
      // 只支持本测试用到的两种选择器
      const key = /^\[([a-z-]+)\]$/.exec(selector)
      if (!key) throw new Error('桩不支持的选择器: ' + selector)
      let cur = this
      while (cur) {
        if (Object.prototype.hasOwnProperty.call(cur.attrs, key[1])) return cur
        cur = cur.parentElement
      }
      return null
    },
  }
  return node
}

/** 文本节点（nodeType 3）：只有 parentElement，没有 closest。 */
function text(parent) {
  return { nodeType: 3, parentElement: parent }
}

// ---- 断言 ---------------------------------------------------------------
let failed = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `  (期望 ${expected}，实际 ${actual})`}`,
  )
}

// 真实结构（取自 dsh 0.2.1-rc.2 的官方前端包）：
//   body
//   ├─ aside 左栏                      （无 data-chat-flow）
//   ├─ div[data-conversation-content]  （整个对话面板）
//   │   └─ div[data-chat-flow]         （Chat 视图正文列）
//   │       └─ div[data-step-process-content][data-chat-flow]  （助手步骤过程，嵌套）
//   └─ aside 右栏                      （无 data-chat-flow）
const body = el('body')
const leftbar = el('aside', {}, body)
const rightbar = el('aside', {}, body)
const convContent = el('div', { 'data-conversation-content': '' }, body)
const chatFlow = el('div', { 'data-chat-flow': '' }, convContent)
const stepProcess = el('div', { 'data-step-process-content': '', 'data-chat-flow': '' }, chatFlow)
const stepText = text(stepProcess)
const msgText = text(chatFlow)
const leftText = text(leftbar)
const rightText = text(rightbar)

console.log('锚点')
check('SCOPE_SELECTOR 就是 data-chat-flow', SCOPE_SELECTOR, '[data-chat-flow]')

console.log('应当生效（对话正文）')
check('对话正文里的文本节点', inConversation(msgText), true)
check('对话正文元素自身', inConversation(chatFlow), true)
check('助手步骤过程里的文本节点（嵌套的第二个 data-chat-flow）', inConversation(stepText), true)

console.log('不应生效（左栏 / 右栏 / 面板外）')
check('左侧栏文本节点', inConversation(leftText), false)
check('右侧栏文本节点', inConversation(rightText), false)
check('对话面板根（轨迹页也挂在它下面，故意不认）', inConversation(convContent), false)
check('body 自身', inConversation(body), false)

console.log('边界输入不应抛错')
check('null', inConversation(null), false)
check('undefined', inConversation(undefined), false)
check('裸对象（无 parentElement / closest）', inConversation({ nodeType: 3 }), false)

console.log('划词排除范围（代码 / 链接 / 表格 / 按钮）')
// 2026-11-04 审查修复：这些容器里划词以前会照常入库，把标识符与 UI 文案塞进生词本。
function tagged(tag) {
  return {
    nodeType: 1,
    closest(sel) {
      if (sel !== EXCLUDED_SELECTOR) throw new Error('桩只接受 EXCLUDED_SELECTOR')
      return sel
        .split(',')
        .map((s) => s.trim())
        .includes(tag)
        ? this
        : null
    },
  }
}
for (const t of ['pre', 'code', 'a', 'button', 'table', '[data-ref-chip]', 'input', 'textarea']) {
  check(`<${t}> 里不弹卡`, inEditable(tagged(t)), true)
}
check('普通段落仍然弹卡', inEditable(tagged('p')), false)
check('inEditable(null) 不抛错', inEditable(null), false)

console.log('排除范围单一来源（core.BLOCKED_ELEMENTS）')
// 共同项只有一份；wordcard 的最终选择器 = 特有项 + BLOCKED_ELEMENTS + 特有项。
// 下面锁死"逐项等价"：只增删任何一项都会红。
const EXPECTED_BLOCKED = [
  'pre',
  'code',
  '.md-code-block',
  'a',
  'button',
  'table',
  '[data-ref-chip]',
]
check('BLOCKED_ELEMENTS 就是这 7 项', BLOCKED_ELEMENTS.join('|'), EXPECTED_BLOCKED.join('|'))
check(
  'blockedSelector(extra) = 共同项 + 特有项',
  blockedSelector(['.x']),
  EXPECTED_BLOCKED.concat(['.x']).join(','),
)

const OLD_WORDCARD = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '.dwl-card',
  'pre',
  'code',
  '.md-code-block',
  'a',
  'button',
  'table',
  '[data-ref-chip]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="tooltip"]',
]
const wcItems = EXCLUDED_SELECTOR.split(',').map((s) => s.trim())
check('wordcard 排除选择器恰好 16 项', wcItems.length, OLD_WORDCARD.length)
check(
  'wordcard 排除选择器逐项等价',
  [...wcItems].sort().join('|'),
  [...OLD_WORDCARD].sort().join('|'),
)
check(
  'wordcard 排除选择器含全部 BLOCKED_ELEMENTS',
  BLOCKED_ELEMENTS.every((x) => wcItems.includes(x)),
  true,
)

console.log('标注层与划词共用同一份排除名单')
const OLD_ANNOTATE = [
  'pre',
  'code',
  '.md-code-block',
  '[data-code-wrap]',
  '[data-code-block-banner]',
  'a',
  '[data-ref-chip]',
  'button',
  'table',
  '.md-table-wide',
  '[hidden]',
  '[data-streaming]',
  '[data-chat-running]',
  'details:not([open]) > :not(summary)',
  '[data-composer-seat]',
  '[data-composer-card]',
  '[data-testid="todo-panel"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[data-approval-key]',
  '[data-question-key]',
  '[data-plan-review-key]',
  '.dwl-anno',
  '.dwlac',
]
const withCore = loadAnnotate(true)
const annotateBlacklist = (withCore.__dwlAnnotate && withCore.__dwlAnnotate._config.BLACKLIST) || []
check('有 core 时 annotate 正常安装', !!withCore.__dwlAnnotate, true)
check(
  'annotate 黑名单以 BLOCKED_ELEMENTS 开头（同一份数据）',
  annotateBlacklist.slice(0, BLOCKED_ELEMENTS.length).join('|'),
  BLOCKED_ELEMENTS.join('|'),
)
check(
  'annotate 黑名单含全部 BLOCKED_ELEMENTS',
  BLOCKED_ELEMENTS.every((x) => annotateBlacklist.includes(x)),
  true,
)
check(
  'annotate 黑名单逐项等价',
  [...annotateBlacklist].sort().join('|'),
  [...OLD_ANNOTATE].sort().join('|'),
)
check('annotate 黑名单不含普通段落', annotateBlacklist.includes('p'), false)
// 只改一边就红：annotate 不许另抄名单，拿不到 core 时必须整体跳过。
check(
  'annotate 源码消费 core.BLOCKED_ELEMENTS',
  /__dwlCore/.test(ANNOTATE_SRC) && ANNOTATE_SRC.includes('BLOCKED_ELEMENTS'),
  true,
)
const withoutCore = loadAnnotate(false)
check('缺 core 时 annotate 跳过标注（不另抄名单）', withoutCore.__dwlAnnotate, undefined)

console.log('语音模块（voice.js）对接')
// 直接从 core.js 取降级函数求值：改了语音降级逻辑这里会立刻红。

// —— 没有 __dwlVoice（注入失败 / 旧页面）：一律降级，不抛异常，按钮禁用
{
  const api = loadCore()
  const noModuleProbe = api.speakText('adapt', 'us')
  check('没有模块时 speakText 返回 Promise', typeof noModuleProbe.then, 'function')
  let rejected = null
  await noModuleProbe.then(
    () => {
      rejected = 'resolved'
    },
    (err) => {
      rejected = err && err.message
    },
  )
  check('没有模块时 reject 一句人话', rejected, '语音模块未加载，刷新页面重试')
  check('没有模块时按钮属性带 disabled', api.voiceButtonAttrs('朗读').includes('disabled'), true)
  let stopThrew = false
  try {
    api.stopSpeaking()
  } catch (err) {
    stopThrew = true
  }
  check('没有模块时 stopSpeaking 不抛错', stopThrew, false)
  const emptyProbe = api.speakText('  ').then(
    () => 'resolved',
    (err) => (err && err.message) || 'rejected',
  )
  check('空文本也走 reject 而不是抛错', await emptyProbe, '没有要读的内容')
}

// —— 有 __dwlVoice：点一次喇叭只调用一次 speak，重播前先 stop
{
  const calls = { speak: 0, stop: 0, args: null }
  const fake = {
    speak(text, opts) {
      calls.speak += 1
      calls.args = { text, opts }
      return Promise.resolve()
    },
    stop() {
      calls.stop += 1
    },
  }
  const api = loadCore({ __dwlVoice: fake })
  let ok = false
  await api.speakText('adapt', 'uk').then(() => {
    ok = true
  })
  check('有模块时 speakText resolve', ok, true)
  check('只调用一次 speak', calls.speak, 1)
  check('口音原样传给模块', calls.args && calls.args.opts.accent, 'uk')
  check('读之前先停上一条', calls.stop >= 1, true)
  check('有模块时按钮不置灰', api.voiceButtonAttrs('朗读').includes('disabled'), false)
}

// —— 幂等守卫：同一页面重复注入不重建 core（已持有的引用不会失效）
{
  const win = {}
  const once = loadCore(win)
  const twice = loadCore(win)
  check('重复注入复用同一个 __dwlCore', once === twice, true)
}

// —— 静态检查：判定/语音只维护一份，wordcard 从 core.js 取用
check('wordcard 不再引用服务端发音路由', /tts/i.test(CARD_SRC), false)
check('wordcard 不再自己 new Audio', /new Audio\(/.test(CARD_SRC), false)
check('core.js 用 __dwlVoice 朗读', CORE_SRC.includes('__dwlVoice'), true)
check('wordcard 从 window.__dwlCore 取判定', CARD_SRC.includes('window.__dwlCore'), true)
check('wordcard 不再重复实现 inConversation', /function inConversation/.test(CARD_SRC), false)
check('wordcard 不再重复实现 inEditable', /function inEditable/.test(CARD_SRC), false)

// —— 卡片视图/样式拆分后的契约（wordcard.js 装配，card 只画，style 只存 CSS）
console.log('卡片视图拆分契约（wordcard-card / wordcard-style）')
// 阶段 2 已接线：wordcard.js 必须从 card 模块取视图，不许自己再画。
check(
  'wordcard.js 从 window.__dwlWordcardCard 取卡片视图',
  CARD_SRC.includes('__dwlWordcardCard'),
  true,
)
check('wordcard.js 不再持有 CSS 常量', CARD_SRC.includes("'.dwl-card{'"), false)
check('card 模块只挂 __dwlWordcardCard', CARD_VIEW_SRC.includes('window.__dwlWordcardCard'), true)
check('card 模块从 core 取语音按钮契约', CARD_VIEW_SRC.includes('__dwlCore'), true)
check('card 模块不重复实现 inConversation', /function inConversation/.test(CARD_VIEW_SRC), false)
check('card 模块不重复实现 inEditable', /function inEditable/.test(CARD_VIEW_SRC), false)
// 无状态契约：view 不许有模块级 card/els/state 变量，也不许自己绑定事件/发请求。
check(
  'card 模块无模块级状态变量',
  /^ {2}(let|var)\s+(card|els|state)\b/m.test(CARD_VIEW_SRC),
  false,
)
check('card 模块不注册事件', /addEventListener/.test(CARD_VIEW_SRC), false)
check('card 模块不发请求', /fetch\(/.test(CARD_VIEW_SRC), false)
check('card 模块不写 state', /state\.\w+\s*=[^=]/.test(CARD_VIEW_SRC), false)
check(
  'render 签名显式收 card/els/state',
  /function render\(card, els, state\)/.test(CARD_VIEW_SRC),
  true,
)
check(
  'render 只读 state（传参不拷贝）',
  CARD_VIEW_SRC.includes('renderTranslation(state.translation)'),
  true,
)
check('place 签名显式收 card/rect', /function place\(card, rect\)/.test(CARD_VIEW_SRC), true)
check(
  'style 模块只挂 __dwlWordcardStyle',
  CARD_STYLE_SRC.includes('window.__dwlWordcardStyle'),
  true,
)
check(
  'style 模块不含 DOM 操作',
  /createElement|appendChild|getElementById/.test(CARD_STYLE_SRC),
  false,
)
check('style 模块含卡片根选择器', CARD_STYLE_SRC.includes("'.dwl-card{'"), true)
check(
  'style 模块导出 CSS 字符串（与 wordcard 旧 CSS 同量级）',
  /window\.__dwlWordcardStyle = [[.]/m.test(CARD_STYLE_SRC),
  true,
)

// —— 注入顺序/async 契约（lib/index.js 静态守；运行时顺序由浏览器复验再确认一次）
const INDEX_SRC = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
const SCRIPT_PATHS_SRC = (INDEX_SRC.match(/const SCRIPT_PATHS = \[([\s\S]*?)\n\]/) || [])[1] || ''
const ORDER_NAMES = [
  'CORE_PATH',
  'VOICE_PATH',
  'WORDCARD_STYLE_PATH',
  'WORDCARD_CARD_PATH',
  'CLIENT_PATH',
  'ANNOTATE_PATH',
]
const orderPos = ORDER_NAMES.map((name) => SCRIPT_PATHS_SRC.indexOf(name))
check(
  '注入顺序 core→voice→wordcard-style→wordcard-card→client→annotate',
  orderPos.every((v, i) => v >= 0 && (i === 0 || v > orderPos[i - 1])),
  true,
)
check(
  '注入行显式 async=false（大脚本晚于 client 执行过真机 bug）',
  INDEX_SRC.includes('s.async=false'),
  true,
)
check(
  'tapIndex 兜底仍排除 voice.js',
  INDEX_SRC.includes('SCRIPT_PATHS.filter((p) => p !== VOICE_PATH)'),
  true,
)
const PATHS_SRC = fs.readFileSync(path.join(HERE, '..', 'lib', 'routes', 'paths.mjs'), 'utf8')
check(
  '新脚本在 paths.mjs 有路径常量',
  PATHS_SRC.includes("'/dsh-word-learn/wordcard-style.js'") &&
    PATHS_SRC.includes("'/dsh-word-learn/wordcard-card.js'"),
  true,
)

console.log('')
if (failed) {
  console.log(`${failed} 条断言失败`)
  process.exit(1)
}
console.log('全部通过')
