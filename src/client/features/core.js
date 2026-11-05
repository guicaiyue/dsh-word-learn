/* dsh-word-learn —— 划词卡纯判定核心（构建源码，ESM）。
 *
 * 生效范围 / 排除范围 / 语音降级这几组判定，原先埋在用 vm 加载的注入脚本
 * assets/core.js 里，靠 window.__dwlCore 被 wordcard / annotate 消费。
 * 阶段 2 起它是 bundle 内的模块：直接 import，判断口径只有一份。
 *
 * 约束：纯判定 + 浏览器能力探测，不碰页面结构（只用传入节点的 closest）、
 * 不写样式、不注册监听。
 */
import VOICE from './voice.js'

export const SCOPE_SELECTOR = '[data-chat-flow]'

function inConversation(node) {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement
  if (!el || !el.closest) return false
  return !!el.closest(SCOPE_SELECTOR)
}

// ------------------------------------------------------------ 排除范围（单一来源）
//
// 划词卡片与标注层共用这份"容器级排除"名单：这里只放两边共同排除的项，
// 各自场景特有的项由各自文件追加。改这里两边同时生效，不会再出现
// "改了一边、忘了另一边"的双口径。最终选择器由 blockedSelector() 拼出，
// test-scope 有一致性断言，只改一边会红。
//
// 划词卡只服务自然语言。代码块、行内 code、链接文字、文件名芯片、表格、
// 按钮里选中的"词"多半是标识符或 UI 文案，收进生词本只会污染。
const BLOCKED_ELEMENTS = [
  'pre',
  'code',
  '.md-code-block',
  'a',
  'button',
  'table',
  '[data-ref-chip]',
]

/** 拼最终排除选择器：共同项在前，场景特有项（extra）在后。 */
function blockedSelector(extra) {
  const parts = BLOCKED_ELEMENTS.slice()
  if (Array.isArray(extra)) {
    for (let i = 0; i < extra.length; i += 1) parts.push(extra[i])
  }
  return parts.join(',')
}

// wordcard 场景特有项：输入区 / 我们自己的卡片 / 其它插件的弹窗。
// 分前后两段拼是为了让最终字符串与拆分前逐字节一致（选择器顺序无行为差异）。
const WORDCARD_PREFIX = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '.dwl-card',
]
const WORDCARD_SUFFIX = ['[role="dialog"]', '[role="menu"]', '[role="tooltip"]']
const EXCLUDED_SELECTOR = WORDCARD_PREFIX.concat(BLOCKED_ELEMENTS, WORDCARD_SUFFIX).join(',')

function inEditable(el) {
  if (!el || !el.closest) return false
  return !!el.closest(EXCLUDED_SELECTOR)
}

// ------------------------------------------------------------ 发音降级
//
// 发音全部交给浏览器自带语音：./voice.js 就是 speechSynthesis 的封装
// （speechSynthesis，Windows 上就是系统里那套 Microsoft 音色）。
//
// 为什么不用服务端发音 / 有道：用户明确只要浏览器自带的免费前端语音 ——
// 不需要 key、不需要网络，单词和整句都能读，非安全上下文（http://IP）也能用；
// 服务端那套要网络 + 密钥 + 磁盘缓存，收益只是"跨浏览器音色一致"，不值得。
//
// 本文件只负责降级与失败提示；选音色、切句、取消、并发打断都在 voice.js 里。
// 口音偏好（state.accent）留在 wordcard.js，调用时作为参数传进来。

/** 语音模块不可用时的统一提示（浏览器不支持 / 系统无英文音色）。 */
const VOICE_MISSING = '语音模块未加载，刷新页面重试'

/** 取语音模块；形状不对时返回 null（后续一律降级，不抛错）。 */
function voiceModule() {
  const mod = VOICE
  return mod && typeof mod.speak === 'function' ? mod : null
}

/** 给按钮加 title / disabled：语音不可用时置灰，别让用户点了没反应。 */
function voiceButtonAttrs(title) {
  if (voiceModule()) return ' title="' + title + '"'
  return ' title="' + VOICE_MISSING + '" disabled aria-disabled="true"'
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

/** 被"重新点一次 / 换词"打断不算失败，不要弹错误提示。 */
function isAbort(err) {
  if (!err) return false
  const code = String(err.code || '').toUpperCase()
  return code === 'ABORTED' || code === 'interrupted' || code === 'canceled'
}

/** 停掉当前朗读（模块缺失时静默）。 */
function stopSpeaking() {
  const mod = voiceModule()
  if (!mod || typeof mod.stop !== 'function') return
  try {
    mod.stop()
  } catch (err) {}
}

/** 朗读一段英文，读完 resolve；失败 reject（带 code，便于提示）。 */
function speakText(text, accent) {
  const content = String(text || '').trim()
  if (!content) {
    const err = new Error('没有要读的内容')
    err.code = 'EMPTY_TEXT'
    return Promise.reject(err)
  }
  const mod = voiceModule()
  if (!mod) {
    const err = new Error(VOICE_MISSING)
    err.code = 'NO_MODULE'
    return Promise.reject(err)
  }
  // 播放中再点一次 / 换词：先停上一条再读，避免两条叠在一起
  stopSpeaking()
  try {
    return Promise.resolve(mod.speak(content, { accent: accent === 'uk' ? 'uk' : 'us' }))
  } catch (err) {
    return Promise.reject(err)
  }
}

const CORE = {
  SCOPE_SELECTOR: SCOPE_SELECTOR,
  BLOCKED_ELEMENTS: BLOCKED_ELEMENTS,
  blockedSelector: blockedSelector,
  EXCLUDED_SELECTOR: EXCLUDED_SELECTOR,
  inConversation: inConversation,
  inEditable: inEditable,
  VOICE_MISSING: VOICE_MISSING,
  voiceModule: voiceModule,
  voiceButtonAttrs: voiceButtonAttrs,
  voiceErrorText: voiceErrorText,
  isAbort: isAbort,
  stopSpeaking: stopSpeaking,
  speakText: speakText,
}

export default CORE
