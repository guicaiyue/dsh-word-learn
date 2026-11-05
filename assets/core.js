/* dsh-word-learn —— 前端纯判定核心（core.js）。
 *
 * 为什么单独一个文件：生效范围 / 排除范围 / 语音降级这几组判定原先埋在
 * wordcard.js 里，测试只能靠"切字符串"去求值（结构一改测试就假红/假绿）。
 * 抽到这里之后，scripts/test-scope.mjs 用 vm 整文件加载，测试读的是真代码；
 * 注入顺序也能固定为 core.js → voice.js → wordcard.js → annotate.js。
 *
 * 约束：浏览器普通 <script>（IIFE），不许 import/require/Node API；
 * 不碰页面 DOM 结构（只用传入节点的 closest）、不写样式、不注册监听。
 * 换了这里的判定，wordcard.js 与测试会同时受影响 —— 这正是想要的口径唯一。
 */
;(function () {
  'use strict'
  if (window.__dwlCore) return

  // ------------------------------------------------------- 生效范围：只认对话正文
  //
  // 用户要求：划词卡片只对 DSH 的**对话页面**有效，左侧栏、右侧栏、轨迹
  // （Trajectory）页、英语学习看板等一律不管。
  //
  // 判定锚点用 `[data-chat-flow]` —— 这是 `dsh-client-ui-chat` 渲染 Chat 视图
  // 正文时挂的标记（0.2.1-rc.2 的 lib/client.js 里 8 处）。为什么不用看起来
  // 更"官方"的 `[data-conversation-content]`：那个是**整个对话面板**的根，
  // 轨迹视图作为 `conversation.view` 槽位渲染在它**内部**，用它当范围等于把
  // 轨迹页也放进来。`data-chat-flow` 只在 Chat 视图的正文列上，轨迹页没有。
  //
  // 严格模式：锚点找不到就完全不响应。DSH 升级换掉这个标记时，卡片会静默
  // 失效，而不是退回"全页面乱弹"——后者正是用户这次要消掉的行为。
  //
  // 注意不能用「两端落在同一个 data-chat-flow」判定：助手回复里的步骤过程
  // 区块（`data-step-process-content`）自己也是一个 data-chat-flow，嵌在外层
  // 之内，跨它选中时两端会是不同的元素。所以只要求两端各自**有**这样的祖先。
  const SCOPE_SELECTOR = '[data-chat-flow]'

  function inConversation(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement
    if (!el || !el.closest) return false
    return !!el.closest(SCOPE_SELECTOR)
  }

  // ------------------------------------------------------------ 排除范围
  //
  // 划词卡只服务自然语言。代码块、行内 code、链接文字、文件名芯片、表格、
  // 按钮、其它插件的弹窗里选中的"词"多半是标识符或 UI 文案，收进生词本只会污染。
  // 与 annotate.js 的容器黑名单保持一致（两边同一个判断口径）。
  const EXCLUDED_SELECTOR =
    'input,textarea,select,[contenteditable=""],[contenteditable="true"],.dwl-card,' +
    'pre,code,.md-code-block,a,button,table,[data-ref-chip],[role="dialog"],[role="menu"],[role="tooltip"]'

  function inEditable(el) {
    if (!el || !el.closest) return false
    return !!el.closest(EXCLUDED_SELECTOR)
  }

  // ------------------------------------------------------------ 发音降级
  //
  // 发音全部交给浏览器自带语音：注入的 voice.js 提供 window.__dwlVoice
  // （speechSynthesis，Windows 上就是系统里那套 Microsoft 音色）。
  //
  // 为什么不用服务端发音 / 有道：用户明确只要浏览器自带的免费前端语音 ——
  // 不需要 key、不需要网络，单词和整句都能读，非安全上下文（http://IP）也能用；
  // 服务端那套要网络 + 密钥 + 磁盘缓存，收益只是"跨浏览器音色一致"，不值得。
  //
  // 本文件只负责降级与失败提示；选音色、切句、取消、并发打断都在 voice.js 里。
  // 口音偏好（state.accent）留在 wordcard.js，调用时作为参数传进来。

  /** 语音模块没加载成功时的统一提示（注入失败 / 旧页面残留）。 */
  const VOICE_MISSING = '语音模块未加载，刷新页面重试'

  /** 取注入的语音模块；缺失或形状不对时返回 null（后续一律降级，不抛错）。 */
  function voiceModule() {
    const mod = typeof window !== 'undefined' ? window.__dwlVoice : null
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

  window.__dwlCore = {
    SCOPE_SELECTOR: SCOPE_SELECTOR,
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
})()
