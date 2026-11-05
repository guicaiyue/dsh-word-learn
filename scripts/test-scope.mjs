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

// ---- 用 vm 整文件加载 core.js（浏览器 IIFE）-------------------------------
/** core.js 只依赖 window（语音模块走 window.__dwlVoice）；document 留空桩。 */
function loadCore(win = {}) {
  const sandbox = { window: win, document: {}, console }
  vm.createContext(sandbox)
  vm.runInContext(CORE_SRC, sandbox, { filename: 'assets/core.js' })
  if (!win.__dwlCore) throw new Error('core.js 没有暴露 window.__dwlCore')
  return win.__dwlCore
}

const { SCOPE_SELECTOR, EXCLUDED_SELECTOR, inConversation, inEditable } = loadCore()

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
for (const t of ['pre', 'code', 'a', 'button', 'table', 'input', 'textarea']) {
  check(`<${t}> 里不弹卡`, inEditable(tagged(t)), true)
}
check('普通段落仍然弹卡', inEditable(tagged('p')), false)
check('inEditable(null) 不抛错', inEditable(null), false)

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

console.log('')
if (failed) {
  console.log(`${failed} 条断言失败`)
  process.exit(1)
}
console.log('全部通过')
