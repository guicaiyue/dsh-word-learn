/* 生效范围（只认对话正文）的回归测试。
 *
 * 不重复实现被测逻辑：直接从 assets/wordcard.js 里**切出真实源码**的
 * SCOPE_SELECTOR / inConversation 两个定义来求值，再用一个极小的 DOM 桩
 * 跑断言。改了前端判定而忘了改这里，测试会立刻红。
 *
 * 跑法：node scripts/test-scope.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'assets', 'wordcard.js'), 'utf8')

// ---- 从真实源码里切出被测定义 -------------------------------------------
function slice(startMarker, endMarker, label) {
  const start = SRC.indexOf(startMarker)
  if (start < 0) throw new Error(`找不到 ${label} 的起点，源码结构变了`)
  const end = SRC.indexOf(endMarker, start)
  if (end < 0) throw new Error(`找不到 ${label} 的终点，源码结构变了`)
  return SRC.slice(start, end)
}

const scopeSrc =
  slice('const SCOPE_SELECTOR', '/** 选区是否', 'SCOPE_SELECTOR + inConversation') +
  '\nreturn { SCOPE_SELECTOR, inConversation }'

const { SCOPE_SELECTOR, inConversation } = new Function(scopeSrc)()

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
const exSrc =
  slice(
    'const EXCLUDED_SELECTOR',
    '  // ------------------------------------------------------- 生效范围',
    'EXCLUDED_SELECTOR + inEditable',
  ) + '\nreturn { EXCLUDED_SELECTOR, inEditable }'
const { EXCLUDED_SELECTOR, inEditable } = new Function(exSrc)()
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
for (const t of ['pre', 'code', 'a', 'button', 'table', 'input', 'textarea']) {
  check(`<${t}> 里不弹卡`, inEditable(tagged(t)), true)
}
check('普通段落仍然弹卡', inEditable(tagged('p')), false)
check('inEditable(null) 不抛错', inEditable(null), false)

console.log('语音模块（voice.js）对接')
// 直接从真实源码里切出语音辅助函数求值：改了 wordcard 的降级逻辑这里会立刻红。
const voiceSrc =
  slice(
    "const VOICE_MISSING = '语音模块未加载，刷新页面重试'",
    'function wantAccent() {',
    '语音对接辅助函数',
  ) +
  '\nreturn { VOICE_MISSING, voiceModule, voiceButtonAttrs, voiceErrorText, isAbort, stopSpeaking, speakText }'

function makeVoiceApi(win, els) {
  return new Function('window', 'els', voiceSrc)(win, els)
}

// —— 没有 __dwlVoice（注入失败 / 旧页面）：一律降级，不抛异常，按钮禁用
{
  const els = { sound: { disabled: false } }
  const api = makeVoiceApi({}, els)
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
  const api = makeVoiceApi({ __dwlVoice: fake }, {})
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

// —— 静态检查：服务端发音链路已经删干净
check('wordcard 不再引用服务端发音路由', /tts/i.test(SRC), false)
check('wordcard 不再自己 new Audio', /new Audio\(/.test(SRC), false)
check('wordcard 用 __dwlVoice 朗读', SRC.includes('__dwlVoice'), true)

console.log('')
if (failed) {
  console.log(`${failed} 条断言失败`)
  process.exit(1)
}
console.log('全部通过')
