/* dsh-word-learn —— 前端划词学习卡。
 *
 * 行为：鼠标选中英文 → 浮出学习卡，就地显示音标、释义、变形、词频分级、
 *       语音朗读按钮（浏览器 Web Speech API，见下方 speakText）；选中一段话则先给整句译文
 *       + 朗读整句，再列出候选词让用户挑。
 *
 * 纯原生实现，不依赖 DSH 内部模块（硬约束：不许 require 客户端包）。
 * 样式全部收在下面的 CSS 字符串里，颜色只走主题变量 + 自带明暗两套。
 *
 * 交互设计的两条依据（来自用户的实际处境）：
 *   1. 用户说"感觉全是生词，但又好像没那么生词" → 卡片必须**给出分级**，
 *      让用户自己判断，而不是替他决定收不收。
 *   2. 用户抱怨现有划词翻译"慢、会改格式、导致前端崩溃" → 卡片全程
 *      position:fixed 独立浮层，**绝不修改页面 DOM**，且任何异常都吞掉。
 */
;(function () {
  'use strict'
  if (window.__dshWordLearn) return
  window.__dshWordLearn = true

  // 生效范围 / 排除范围 / 语音降级这些纯判定集中在 core.js（注入行里排在前面）。
  // 万一顺序异常（旧页面缓存了旧注入行）就静默不装卡片：页面其它功能不受影响，
  // 硬刷新拿到新注入行即恢复 —— 绝不在这里重复实现一份判定，避免口径漂移。
  const core = window.__dwlCore
  if (!core) return
  const {
    inConversation,
    inEditable,
    VOICE_MISSING,
    voiceModule,
    voiceButtonAttrs,
    voiceErrorText,
    isAbort,
    stopSpeaking,
    speakText,
  } = core

  const API = {
    lookup: '/dsh-word-learn/lookup',
    save: '/dsh-word-learn/save',
    list: '/dsh-word-learn/list',
    update: '/dsh-word-learn/update',
    remove: '/dsh-word-learn/remove',
    translate: '/dsh-word-learn/translate',
  }

  const MIN_CHARS = 2
  const MAX_CHARS = 2000
  const DEBOUNCE_MS = 220
  const CACHE_MAX = 120
  // 整句朗读的长度上限。太长时合成/播放的等待明显变长，收益也低。
  const SPEAK_TEXT_MAX = 600

  // ------------------------------------------------------------ 样式
  //
  // 颜色一律优先取 DSH 自己的主题令牌（--dsw-alias-*），拿不到才用自带兜底值。
  //
  // 为什么必须这样：DSH 的主题是**运行时把令牌写成 body 上的 CSS 变量**实现的，
  // 而且深色模式的标记是 body[data-ds-dark-theme]（不是 data-theme="dark"）。
  // 我最初按 data-theme 判断，结果深色模式下卡片仍然是浅色底 —— 在深色界面里
  // 会白得刺眼。改用令牌后，主题切换由 DSH 自己驱动，我不需要跟着猜。
  //
  // 兜底值分两套（浅/深），只在令牌缺失时生效（例如脱离 DSH 单独看预览页）。
  const CSS = [
    '.dwl-card{',
    '  --dwl-bg:var(--dsw-alias-bg-overlay,#ffffff);',
    '  --dwl-fg:var(--dsw-alias-label-primary,#1f2328);',
    '  --dwl-muted:var(--dsw-alias-label-tertiary,#6b7280);',
    '  --dwl-muted2:var(--dsw-alias-label-secondary,#4b5563);',
    '  --dwl-border:var(--dsw-alias-border-l2,rgba(15,23,42,.15));',
    '  --dwl-hover:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.08));',
    '  --dwl-accent:var(--dsw-alias-brand-primary,#2563eb);',
    '  --dwl-accent-soft:var(--dsw-alias-interactive-bg-hover-accent,rgba(37,99,235,.10));',
    '  --dwl-skel:var(--dsw-alias-bg-skeleton,rgba(15,23,42,.07));',
    '  --dwl-err:var(--dsw-alias-state-error-primary,#dc2626);',
    '  --dwl-ok:var(--dsw-alias-state-success-primary,#16a34a);',
    '  --dwl-warn:var(--dsw-alias-state-warn-primary,#d97706);',
    '  --dwl-shadow:var(--dsw-shadow-lv3,0 12px 32px -10px rgba(15,23,42,.28),0 2px 8px -2px rgba(15,23,42,.12));',
    '  --dwl-radius:var(--dsw-radius-l,14px);',
    '  position:fixed;z-index:2147483000;box-sizing:border-box;',
    '  width:max-content;min-width:280px;max-width:min(560px,calc(100vw - 24px));',
    '  font-family:var(--dsw-font-family,var(--dsh-font-family-text,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif));',
    '  font-size:13.5px;line-height:1.62;text-align:left;color:var(--dwl-fg);',
    '  background:var(--dwl-bg);border:1px solid var(--dwl-border);border-radius:var(--dwl-radius);',
    '  box-shadow:var(--dwl-shadow);overflow:hidden;',
    '  animation:dwlIn .16s cubic-bezier(.2,.8,.2,1);',
    '}',
    // 深色兜底：DSH 用 body[data-ds-dark-theme] 标记深色（令牌已自动翻转，
    // 这里只是给"令牌缺失"的情况一套深色兜底值）。两个选择器都写，
    // 后者兼容脱离 DSH 的独立预览页。
    'body[data-ds-dark-theme] .dwl-card,.dwl-card[data-theme="dark"]{',
    '  --dwl-bg:var(--dsw-alias-bg-layer-3,#1c1f26);',
    '  --dwl-fg:var(--dsw-alias-label-primary,#e6e8eb);',
    '  --dwl-muted:var(--dsw-alias-label-tertiary,#98a1ae);',
    '  --dwl-muted2:var(--dsw-alias-label-secondary,#b6bdc7);',
    '  --dwl-border:var(--dsw-alias-border-l2,rgba(255,255,255,.13));',
    '  --dwl-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.10));',
    '  --dwl-accent:var(--dsw-alias-brand-primary,#7aa2f7);',
    '  --dwl-accent-soft:var(--dsw-alias-interactive-bg-hover-accent,rgba(122,162,247,.16));',
    '  --dwl-skel:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.09));',
    '  --dwl-err:var(--dsw-static-red-100,#f87171);',
    '  --dwl-ok:var(--dsw-alias-state-success-primary,#4ade80);',
    '  --dwl-warn:var(--dsw-alias-state-warn-primary,#fbbf24);',
    '  --dwl-shadow:var(--dsw-shadow-lv3,0 16px 40px -12px rgba(0,0,0,.62),0 2px 10px -2px rgba(0,0,0,.42));',
    '}',
    '@keyframes dwlIn{from{opacity:0;transform:translateY(-5px) scale(.985)}to{opacity:1;transform:none}}',
    '@keyframes dwlShimmer{0%{background-position:100% 0}100%{background-position:0 0}}',
    '@keyframes dwlPop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.dwl-card{animation:none}.dwlk-skel i{animation:none}}',

    // 头部
    '.dwl-head{display:flex;align-items:flex-start;gap:8px;padding:10px 8px 8px 13px;border-bottom:1px solid var(--dwl-border)}',
    '.dwl-headmain{flex:1 1 auto;min-width:0}',
    '.dwlk-word{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}',
    '.dwlk-word b{font-size:16px;font-weight:650;letter-spacing:.01em}',
    '.dwlk-phon{font-size:12.5px;color:var(--dwl-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.dwl-from{font-size:11px;color:var(--dwl-muted)}',
    '.dwlk-btn{',
    '  flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:4px;',
    '  height:32px;min-width:32px;padding:0 7px;border:0;border-radius:7px;cursor:pointer;',
    '  background:transparent;color:var(--dwl-muted);font-size:11.5px;font-family:inherit;',
    '  transition:background .14s ease,color .14s ease;',
    '}',
    '.dwlk-btn:hover{background:var(--dwl-hover);color:var(--dwl-fg)}',
    '.dwlk-btn:active{transform:translateY(.5px)}',
    '.dwlk-btn:focus-visible{outline:2px solid var(--dwl-accent);outline-offset:1px;border-radius:7px}',
    '.dwlk-btn svg{width:14px;height:14px;display:block}',
    '.dwlk-btn[data-done="1"]{color:var(--dwl-ok)}',
    '.dwlk-btn[data-on="1"]{color:var(--dwl-accent)}',
    '.dwlk-btn[data-done="1"] svg{animation:dwlPop .28s ease}',
    '.dwl-acc{min-width:34px;padding:0 6px;font-size:10.5px;font-weight:650;letter-spacing:.04em}',
    '.dwl-acc:hover{color:var(--dwl-accent)}',
    '.dwlk-btn[data-busy="1"]{cursor:progress;opacity:.65}',
    '@keyframes dwlPulse{0%,100%{opacity:.25}50%{opacity:1}}',
    '.dwlk-btn[data-busy="1"] svg{animation:dwlPulse .9s ease-in-out infinite}',
    '@media (prefers-reduced-motion:reduce){.dwlk-btn[data-busy="1"] svg{animation:none}}',

    // 分级条
    '.dwl-tiers{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 13px 0}',
    '.dwlk-chip{',
    '  display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;',
    '  border-radius:5px;font-size:10.5px;line-height:1;white-space:nowrap;',
    '  background:var(--dwl-hover);color:var(--dwl-muted);',
    '}',
    '.dwlk-chip[data-tone="known"]{background:var(--dwl-accent-soft);color:var(--dwl-accent)}',
    '.dwlk-chip[data-tone="exam"]{background:rgba(217,119,6,.12);color:var(--dwl-warn)}',
    '.dwlk-chip[data-tone="star"]{background:rgba(22,163,74,.12);color:var(--dwl-ok)}',
    '.dwl-hint{font-size:11px;color:var(--dwl-muted);padding:5px 13px 0}',

    // 正文
    '.dwlk-body{padding:8px 13px 11px;max-height:min(48vh,400px);overflow:auto}',
    '.dwlk-body::-webkit-scrollbar{width:8px;height:8px}',
    '.dwlk-body::-webkit-scrollbar-thumb{background:var(--dwl-hover);border-radius:4px}',
    '.dwlk-body::-webkit-scrollbar-track{background:transparent}',
    '.dwlk-sense{display:flex;gap:7px;padding:2.5px 0}',
    '.dwlk-pos{',
    '  flex:0 0 auto;min-width:30px;font-size:11px;color:var(--dwl-accent);',
    '  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding-top:1.5px;',
    '}',
    '.dwl-text{flex:1 1 auto;word-break:break-word;overflow-wrap:anywhere}',
    '.dwl-sect{margin-top:9px;padding-top:8px;border-top:1px dashed var(--dwl-border)}',
    '.dwl-sect h5{margin:0 0 5px;font-size:11px;font-weight:600;color:var(--dwl-muted);letter-spacing:.03em;display:flex;align-items:center;gap:6px}',
    '.dwl-forms{display:flex;flex-wrap:wrap;gap:5px}',
    '.dwl-form{font-size:11.5px;padding:1px 6px;border-radius:5px;background:var(--dwl-hover)}',
    '.dwl-form i{font-style:normal;color:var(--dwl-muted);margin-right:3px}',
    '.dwl-ex{padding:2.5px 0;font-size:12.5px}',
    '.dwl-ex em{font-style:normal;color:var(--dwl-muted);font-size:11px;margin-right:5px}',
    '.dwl-syn{display:flex;flex-wrap:wrap;gap:5px}',
    '.dwl-syn span{font-size:11.5px;padding:1px 6px;border-radius:5px;background:var(--dwl-hover);cursor:pointer}',
    '.dwl-syn span:hover{background:var(--dwl-accent-soft);color:var(--dwl-accent)}',
    '.dwl-syn span:focus-visible{outline:2px solid var(--dwl-accent);outline-offset:1px}',
    '.dwl-cand:focus-visible{outline:2px solid var(--dwl-accent);outline-offset:1px}',
    '.dwlk-err{color:var(--dwl-err)}',
    '.dwl-warnbox{color:var(--dwl-warn);font-size:12px}',

    // 译文（短语/整句场景的主内容）
    '.dwl-tr{padding:2px 0 8px;border-bottom:1px solid var(--dwl-border);margin-bottom:8px}',
    '.dwl-tr-label{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dwl-muted);margin-bottom:4px}',
    '.dwl-tr-body{font-size:13.5px;line-height:1.62;color:var(--dwl-fg);white-space:pre-wrap;word-break:break-word}',
    '.dwl-tr-src{padding:0 5px;border-radius:5px;background:var(--dwl-hover);font-size:10.5px}',
    '.dwl-tr-body[data-pending="1"]{color:var(--dwl-muted)}',
    '.dwl-tr-fail{font-size:12px;color:var(--dwl-warn);line-height:1.5}',
    // 整句朗读按钮：就放在"译文"这一行的右侧 —— 划句子的人第一眼就在这儿
    '.dwl-tr-act{',
    '  margin-left:auto;flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;',
    '  height:20px;padding:0 7px;border:0;border-radius:6px;cursor:pointer;font:inherit;',
    '  font-size:10.5px;background:var(--dwl-hover);color:var(--dwl-muted);',
    '  transition:background .14s ease,color .14s ease;',
    '}',
    '.dwl-tr-act:hover{background:var(--dwl-accent-soft);color:var(--dwl-accent)}',
    '.dwl-tr-act svg{width:11px;height:11px;display:block}',
    '.dwl-tr-act[data-busy="1"]{cursor:progress;opacity:.65}',
    '.dwl-tr-act[data-busy="1"] svg{animation:dwlPulse .9s ease-in-out infinite}',
    '.dwl-tr-act[data-done="1"]{color:var(--dwl-ok)}',

    // 候选词（短语场景）
    '.dwl-cands{display:flex;flex-wrap:wrap;gap:5px;padding:2px 0}',
    '.dwl-cand{',
    '  display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:7px;',
    '  background:var(--dwl-hover);cursor:pointer;font-size:12.5px;border:1px solid transparent;',
    '}',
    '.dwl-cand:hover{background:var(--dwl-accent-soft);color:var(--dwl-accent)}',
    '.dwl-cand[data-known="1"]{opacity:.6}',
    '.dwl-cand s{font-size:10.5px;color:var(--dwl-muted);text-decoration:none}',
    '.dwl-cand[data-best="1"]{border-color:var(--dwl-accent);background:var(--dwl-accent-soft)}',

    // 骨架屏
    '.dwlk-skel{display:flex;flex-direction:column;gap:9px;padding:2px 0}',
    '.dwlk-skel i{',
    '  display:block;height:9px;border-radius:5px;',
    '  background:linear-gradient(90deg,var(--dwl-skel) 25%,transparent 37%,var(--dwl-skel) 63%);',
    '  background-size:400% 100%;animation:dwlShimmer 1.25s ease-in-out infinite;',
    '}',

    // 底栏
    '.dwl-foot{display:flex;align-items:center;gap:6px;padding:0 13px 9px;font-size:11px;color:var(--dwl-muted)}',
    '.dwlk-dot{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.55;flex:0 0 auto}',
  ].join('\n')

  const SVG = {
    sound:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
    starFill:
      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  }

  function ensureStyle() {
    if (document.getElementById('dwl-style')) return
    const style = document.createElement('style')
    style.id = 'dwl-style'
    style.textContent = CSS
    ;(document.head || document.documentElement).appendChild(style)
  }

  // ------------------------------------------------------------ 工具
  /**
   * 当前是不是深色主题。
   *
   * **判据来自 DSH 自己的实现**（dsh-client-ui-layout 的 ThemePresenter）：
   *   - 深色时给 body 加 `data-ds-dark-theme`（空字符串属性）
   *   - 同时给 html 设 `data-ds-theme-source` = 'light' | 'dark' | 'system'
   *   - 并把 `color-scheme` 写到 documentElement.style
   *
   * 我最初只认 `data-theme="dark"`，DSH 根本不设这个属性，所以深色模式下
   * 卡片一直是浅色底 —— 在深色界面里白得刺眼。这里按真实属性判断。
   *
   * 最后的 `matchMedia` 只是脱离 DSH 时的兜底（例如独立预览页）。
   */
  function isDark() {
    try {
      const body = document.body
      // ① DSH 的正式标记
      if (body && body.hasAttribute('data-ds-dark-theme')) return true
      // ② DSH 发布的主题来源
      const source = String(
        document.documentElement.getAttribute('data-ds-theme-source') || '',
      ).toLowerCase()
      if (source === 'dark') return true
      if (source === 'light') return false
      // ③ 计算样式里的 color-scheme（DSH 也会设它）
      try {
        const scheme = window.getComputedStyle(document.documentElement).colorScheme || ''
        if (scheme.indexOf('dark') >= 0 && scheme.indexOf('light') < 0) return true
      } catch (err) {}
      // ④ 兼容其它可能写法 + 脱离 DSH 的兜底
      const attr = String(document.documentElement.getAttribute('data-theme') || '').toLowerCase()
      if (attr.indexOf('dark') >= 0) return true
      if (attr.indexOf('light') >= 0) return false
      if (
        body &&
        typeof body.className === 'string' &&
        /(^|\s)(dark|theme-dark)(\s|$)/.test(body.className)
      )
        return true
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    } catch (err) {
      return false
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  const cache = new Map()
  function cacheGet(key) {
    return cache.get(key)
  }
  function cacheSet(key, value) {
    cache.set(key, value)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  }

  // ------------------------------------------------------------ 状态
  let card = null
  let els = null
  const state = {
    visible: false,
    text: '',
    data: null,
    error: '',
    candidates: null, // 短语场景的候选词
    translation: null, // 短语场景的译文 {pending, ok, text, source, error}
    token: 0,
    accent: loadAccent(), // 'us' | 'uk'，发音口音
  }
  let inflight = null
  let hideTimer = null

  function buildCard() {
    ensureStyle()
    card = document.createElement('div')
    card.className = 'dwl-card'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', '单词学习卡')
    card.innerHTML =
      '<div class="dwl-head">' +
      '  <div class="dwl-headmain"><div class="dwlk-word"></div></div>' +
      '  <button class="dwlk-btn" data-act="sound"' +
      voiceButtonAttrs('朗读（浏览器语音）') +
      '>' +
      SVG.sound +
      '</button>' +
      '  <button class="dwlk-btn dwl-acc" data-act="accent" title="切换英音/美音"></button>' +
      '  <button class="dwlk-btn" data-act="star" title="收藏">' +
      SVG.star +
      '</button>' +
      '  <button class="dwlk-btn" data-act="close" title="关闭 (Esc)">' +
      SVG.close +
      '</button>' +
      '</div>' +
      '<div class="dwl-tiers"></div>' +
      '<div class="dwl-hint"></div>' +
      '<div class="dwlk-body"></div>' +
      '<div class="dwl-foot"></div>'

    els = {
      word: card.querySelector('.dwlk-word'),
      tiers: card.querySelector('.dwl-tiers'),
      hint: card.querySelector('.dwl-hint'),
      body: card.querySelector('.dwlk-body'),
      foot: card.querySelector('.dwl-foot'),
      sound: card.querySelector('[data-act="sound"]'),
      accent: card.querySelector('[data-act="accent"]'),
      star: card.querySelector('[data-act="star"]'),
    }

    if (els.accent) {
      els.accent.textContent = state.accent.toUpperCase()
      els.accent.title = state.accent === 'uk' ? '当前英音，点击切美音' : '当前美音，点击切英音'
    }

    card.addEventListener('click', function (event) {
      const target = event.target
      const cand = target && target.closest ? target.closest('.dwl-cand') : null
      if (cand) {
        const word = cand.getAttribute('data-word')
        if (word) runLookup(word, state.text)
        return
      }
      const syn = target && target.closest ? target.closest('.dwl-syn span') : null
      if (syn) {
        runLookup(syn.textContent.trim(), '')
        return
      }
      const btn = target && target.closest ? target.closest('[data-act]') : null
      if (!btn) return
      const act = btn.getAttribute('data-act')
      if (act === 'close') hide()
      else if (act === 'sound') playAudio()
      else if (act === 'speak-sentence') playSentence(btn)
      else if (act === 'accent') toggleAccent()
      else if (act === 'star') toggleStar()
    })

    // 键盘支持：Enter / Space 触发候选词和近义词
    card.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const target = event.target
      const cand = target && target.closest ? target.closest('.dwl-cand') : null
      if (cand) {
        event.preventDefault()
        const word = cand.getAttribute('data-word')
        if (word) runLookup(word, state.text)
        return
      }
      const syn = target && target.closest ? target.closest('.dwl-syn span') : null
      if (syn) {
        event.preventDefault()
        runLookup(syn.textContent.trim(), '')
      }
    })

    card.style.display = 'none'
    document.body.appendChild(card)
    return card
  }

  function ensureCard() {
    if (card && card.isConnected) return card
    card = null
    els = null
    return buildCard()
  }

  /**
   * 短语/整句场景的译文块。
   *
   * 这是"划句子"的主内容 —— 用户划一句是因为没读懂，译文必须排在最上面，
   * 拆词只是它下面的一行附加。
   */
  function renderTranslation() {
    const tr = state.translation
    if (!tr) return ''
    let label = '<div class="dwl-tr-label"><b>译文</b>'
    if (tr.ok && tr.source) {
      const srcName = tr.source === 'llm' ? 'DSH 模型' : 'MyMemory'
      label += '<span class="dwl-tr-src">' + srcName + '</span>'
      if (tr.cached) label += '<span class="dwl-tr-src">缓存</span>'
    }
    // 整句朗读：整句场景的发音入口就在译文这一行。
    //
    // 为什么不复用头部的喇叭按钮：那个按钮读的是 state.data.dict.word，
    // 整句场景根本没有 data（只有 candidates），按钮被显式隐藏了 ——
    // 划一整句时用户压根没有能读整句的地方。
    label +=
      '<button class="dwl-tr-act" data-act="speak-sentence"' +
      voiceButtonAttrs('朗读整句（浏览器语音）') +
      '>' +
      SVG.sound +
      '<span>读整句</span></button>'
    label += '</div>'

    if (tr.pending) {
      return (
        '<div class="dwl-tr">' +
        label +
        '<div class="dwl-tr-body" data-pending="1">翻译中…</div>' +
        '</div>'
      )
    }
    if (!tr.ok) {
      return (
        '<div class="dwl-tr">' +
        label +
        '<div class="dwl-tr-fail">' +
        escapeHtml(tr.error || '翻译失败') +
        '</div></div>'
      )
    }
    return (
      '<div class="dwl-tr">' +
      label +
      '<div class="dwl-tr-body">' +
      escapeHtml(tr.text) +
      '</div></div>'
    )
  }

  function renderSkeleton() {
    const widths = ['58%', '92%', '80%', '42%']
    let html = '<div class="dwlk-skel">'
    for (let i = 0; i < widths.length; i++) html += '<i style="width:' + widths[i] + '"></i>'
    return html + '</div>'
  }

  function toneOf(tier) {
    if (tier === 'top1k') return 'known'
    if (tier === 'top3k') return 'known'
    return ''
  }

  function render() {
    if (!card) return
    card.setAttribute('data-theme', isDark() ? 'dark' : 'light')

    // ---- 错误
    if (state.error) {
      els.word.innerHTML = '<b>' + escapeHtml(state.text.slice(0, 32)) + '</b>'
      els.tiers.innerHTML = ''
      els.hint.textContent = ''
      els.body.innerHTML = '<div class="dwlk-err">' + escapeHtml(state.error) + '</div>'
      els.foot.textContent = ''
      els.sound.style.display = 'none'
      els.star.style.display = 'none'
      return
    }

    // ---- 译文 / 候选词列表（短语场景）
    //
    // 条件带上 `state.translation`：译文可能比拆词先回来。
    // 若只等 candidates，用户在拆词期间看到的还是一张空骨架，
    // 而他要的译文其实已经到了。
    if (state.candidates || state.translation) {
      const cands = state.candidates
      if (cands) {
        els.word.innerHTML =
          '<b>选一个词</b><span class="dwl-from">共 ' + cands.length + ' 个候选</span>'
        els.tiers.innerHTML = ''
        els.hint.textContent = '点任意一个词查看释义；灰掉的是高频词，多半你已经认识'
      } else {
        els.word.innerHTML = '<b>' + escapeHtml(state.text.slice(0, 40)) + '</b>'
        els.tiers.innerHTML = ''
        els.hint.textContent = '正在挑出值得学的词…'
      }
      els.body.innerHTML =
        renderTranslation() +
        (cands
          ? '<div class="dwl-cands">' +
            cands
              .map(function (item) {
                if (!item.found) {
                  return (
                    '<span class="dwl-cand" data-known="1" aria-disabled="true"><s>' +
                    escapeHtml(item.word) +
                    '</s></span>'
                  )
                }
                const cls = item.likelyKnown ? '1' : '0'
                const best = item.word === cands.best ? '1' : '0'
                return (
                  '<span class="dwl-cand" role="button" tabindex="0" data-word="' +
                  escapeHtml(item.word) +
                  '" data-known="' +
                  cls +
                  '" data-best="' +
                  best +
                  '">' +
                  escapeHtml(item.word) +
                  (item.brief ? '<s>' + escapeHtml(item.brief.slice(0, 14)) + '</s>' : '') +
                  '</span>'
                )
              })
              .join('') +
            '</div>'
          : '')
      els.foot.textContent = ''
      els.sound.style.display = 'none'
      els.star.style.display = 'none'
      return
    }

    // ---- 加载中
    if (!state.data) {
      els.word.innerHTML = '<b>' + escapeHtml(state.text) + '</b>'
      els.tiers.innerHTML = ''
      els.hint.textContent = ''
      els.body.innerHTML = renderSkeleton()
      els.foot.textContent = ''
      els.sound.style.display = 'none'
      els.star.style.display = 'none'
      return
    }

    // ---- 正常结果
    const d = state.data.dict
    const ex = state.data.enrich || {}
    const saved = state.data.saved || {}

    let head = '<b>' + escapeHtml(d.word) + '</b>'
    if (d.phonetic)
      head +=
        '<span class="dwlk-phon">/' + escapeHtml(d.phonetic.replace(/^\/|\/$/g, '')) + '</span>'
    if (d.matchedBy === 'lemma' && d.asForm) {
      head += '<span class="dwl-from">← ' + escapeHtml(d.asForm.word) + '</span>'
    } else if (d.matchedBy === 'form') {
      head += '<span class="dwl-from">← ' + escapeHtml(d.query) + ' 的原形</span>'
    }
    els.word.innerHTML = head

    // 分级 chips
    const chips = []
    if (d.frequency && d.frequency.label) {
      chips.push(
        '<span class="dwlk-chip" data-tone="' +
          toneOf(d.frequency.tier) +
          '">' +
          escapeHtml(d.frequency.label) +
          '</span>',
      )
    }
    if (d.collins > 0) chips.push('<span class="dwlk-chip">柯林斯 ' + d.collins + ' 星</span>')
    if (d.oxford) chips.push('<span class="dwlk-chip">牛津核心</span>')
    ;(d.tags || []).forEach(function (tag) {
      chips.push('<span class="dwlk-chip" data-tone="exam">' + escapeHtml(tag.label) + '</span>')
    })
    if (saved.starred) chips.push('<span class="dwlk-chip" data-tone="star">已收藏</span>')
    els.tiers.innerHTML = chips.join('')

    // 提示：分级结论
    if (d.likelyKnown) {
      els.hint.innerHTML =
        '<span style="color:var(--dwl-muted)">这词很常见，你多半已经认识 —— 已记入生词本，可在复习页删掉</span>'
    } else {
      els.hint.innerHTML =
        '<span style="color:var(--dwl-muted)">已记入生词本' +
        (saved.seenCount > 1 ? '（第 ' + saved.seenCount + ' 次遇见）' : '') +
        '</span>'
    }

    // 正文
    let html = ''
    ;(d.senses || []).slice(0, 6).forEach(function (sense) {
      const pos = sense.pos || (sense.domain ? '[' + sense.domain + ']' : '')
      html +=
        '<div class="dwlk-sense"><span class="dwlk-pos">' +
        escapeHtml(pos) +
        '</span><span class="dwl-text">' +
        escapeHtml(sense.text) +
        '</span></div>'
    })
    if (!d.senses || !d.senses.length) html += '<div class="dwlk-sense">（无中文释义）</div>'

    // 变形
    if (d.forms && d.forms.length) {
      html +=
        '<div class="dwl-sect"><h5>词形变化</h5><div class="dwl-forms">' +
        d.forms
          .slice(0, 10)
          .map(function (f) {
            return (
              '<span class="dwl-form"><i>' +
              escapeHtml(f.label) +
              '</i>' +
              escapeHtml(f.value) +
              '</span>'
            )
          })
          .join('') +
        '</div></div>'
    }

    // 例句
    if (ex.examples && ex.examples.length) {
      html +=
        '<div class="dwl-sect"><h5>例句</h5>' +
        ex.examples
          .slice(0, 3)
          .map(function (e) {
            return (
              '<div class="dwl-ex">' +
              (e.pos ? '<em>' + escapeHtml(e.pos) + '</em>' : '') +
              escapeHtml(e.text) +
              '</div>'
            )
          })
          .join('') +
        '</div>'
    }

    // 同义词
    if (ex.synonyms && ex.synonyms.length) {
      html +=
        '<div class="dwl-sect"><h5>近义词（点击可查）</h5><div class="dwl-syn">' +
        ex.synonyms
          .slice(0, 8)
          .map(function (s) {
            return '<span role="button" tabindex="0">' + escapeHtml(s) + '</span>'
          })
          .join('') +
        '</div></div>'
    }

    // 原句回放（带整句朗读 —— 查完单词往往想再听一遍原句）
    if (state.sentence && state.sentence !== d.word) {
      html +=
        '<div class="dwl-sect"><h5>你在这里遇到它' +
        '<button class="dwl-tr-act" data-act="speak-sentence"' +
        voiceButtonAttrs('朗读原句（浏览器语音）') +
        '>' +
        SVG.sound +
        '<span>读整句</span></button>' +
        '</h5><div class="dwl-ex">' +
        escapeHtml(state.sentence.slice(0, 220)) +
        '</div></div>'
    }

    els.body.innerHTML = html

    // 底栏
    const parts = []
    if (d.frequency && d.frequency.rank) parts.push('词频 #' + d.frequency.rank)
    if (state.warnings && state.warnings.length) parts.push('⚠ ' + state.warnings.join('；'))
    if (!voiceModule()) parts.unshift(VOICE_MISSING)
    parts.push('Esc 关闭')
    els.foot.innerHTML = parts
      .map(function (p) {
        return escapeHtml(p)
      })
      .join('<span class="dwlk-dot"></span>')

    // 按钮状态：语音由 voice.js（浏览器自带音色）提供，不依赖外部 mp3。
    // 模块可能晚一步注入，所以每次渲染都按当前可用性刷新一次，避免按钮一直灰着。
    els.sound.style.display = ''
    const voiceReady = !!voiceModule()
    els.sound.disabled = !voiceReady
    if (voiceReady) els.sound.removeAttribute('aria-disabled')
    else els.sound.setAttribute('aria-disabled', 'true')
    els.star.style.display = ''
    if (saved.starred) {
      els.star.setAttribute('data-on', '1')
      els.star.innerHTML = SVG.starFill
    } else {
      els.star.removeAttribute('data-on')
      els.star.innerHTML = SVG.star
    }
  }

  function place(rect) {
    if (!card) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 8

    card.style.visibility = 'hidden'
    card.style.display = 'block'
    const w = card.offsetWidth || 0
    const h = card.offsetHeight || 0

    let top = rect.bottom + gap
    if (top + h > vh - 8) {
      const above = rect.top - h - gap
      top = above >= 8 ? above : Math.max(8, vh - h - 8)
    }
    let left = rect.left
    left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8))

    card.style.top = Math.round(top) + 'px'
    card.style.left = Math.round(left) + 'px'
    card.style.visibility = ''
  }

  function show(text, rect, sentence) {
    ensureCard()
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (text !== state.text) {
      state.data = null
      state.error = ''
      state.candidates = null
    }
    state.visible = true
    state.text = text
    state.sentence = sentence || text
    card.style.display = 'block'
    render()
    place(rect)
  }

  function hide() {
    if (!card) return
    // 关卡片就停朗读：用户已经不看这个词了，别在后台继续读
    stopSpeaking()
    state.visible = false
    state.text = ''
    state.data = null
    state.error = ''
    state.candidates = null
    state.token++
    if (inflight) {
      try {
        inflight.abort()
      } catch (err) {}
      inflight = null
    }
    card.style.display = 'none'
  }

  // ------------------------------------------------------------ 发音
  // 降级辅助（voiceModule / speakText / 失败提示）在 core.js，与 voice.js 的契约
  // 只维护一处；这里只剩"当前口音"这种卡片私有状态。

  function wantAccent() {
    return state.accent === 'uk' ? 'uk' : 'us'
  }
  function loadAccent() {
    try {
      return window.localStorage.getItem('dwl-voice-accent') === 'uk' ? 'uk' : 'us'
    } catch (err) {
      return 'us'
    }
  }
  function saveAccent(v) {
    try {
      window.localStorage.setItem('dwl-voice-accent', v)
    } catch (err) {}
  }
  function syncAccentButton() {
    if (!els || !els.accent) return
    els.accent.textContent = state.accent.toUpperCase()
    els.accent.title = state.accent === 'uk' ? '当前英音，点击切美音' : '当前美音，点击切英音'
  }
  function flashSound(ok) {
    if (!els || !els.sound) return
    els.sound.removeAttribute('data-busy')
    if (!ok) return
    els.sound.setAttribute('data-done', '1')
    setTimeout(function () {
      if (els && els.sound) els.sound.removeAttribute('data-done')
    }, 900)
  }

  function playAudio() {
    const d = state.data && state.data.dict
    if (!d || !d.word || !els || !els.sound) return
    // 播放中再点一次 = 重播：先停上一条，不要当成"忙，忽略"
    els.sound.removeAttribute('data-done')
    els.sound.setAttribute('data-busy', '1')

    speakText(d.word, wantAccent())
      .then(function () {
        flashSound(true)
      })
      .catch(function (err) {
        flashSound(false)
        if (isAbort(err)) return
        if (els && els.foot) {
          els.foot.textContent = '发音失败：' + voiceErrorText(err)
        }
      })
  }

  /**
   * 朗读整句。
   *
   * 目标文本取 `state.sentence`（用户实际划中的那段），而不是
   * `state.data.dict.word` —— 后者在整句场景里根本不存在。
   * 口音偏好与单词发音共用 localStorage。
   */
  function playSentence(btn) {
    const text = String(state.sentence || state.text || '').trim()
    if (!text) return
    if (btn) {
      btn.removeAttribute('data-done')
      btn.setAttribute('data-busy', '1')
    }

    speakText(text.slice(0, SPEAK_TEXT_MAX), wantAccent())
      .then(function () {
        if (!btn) return
        btn.removeAttribute('data-busy')
        btn.setAttribute('data-done', '1')
        setTimeout(function () {
          if (btn.isConnected) btn.removeAttribute('data-done')
        }, 900)
      })
      .catch(function (err) {
        if (btn) btn.removeAttribute('data-busy')
        if (isAbort(err)) return
        if (els && els.foot) {
          els.foot.textContent = '朗读失败：' + voiceErrorText(err)
        }
      })
  }

  function toggleAccent() {
    state.accent = state.accent === 'uk' ? 'us' : 'uk'
    saveAccent(state.accent)
    syncAccentButton()
    // 换口音后当前那条已经用旧音色读了，停掉；下一次点喇叭才用新音色
    stopSpeaking()
  }
  function toggleStar() {
    const saved = state.data && state.data.saved
    const d = state.data && state.data.dict
    if (!d) return
    const next = !(saved && saved.starred)
    fetch(API.update, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ word: d.word, patch: { starred: next } }),
    })
      .then(function (r) {
        return r.json()
      })
      .then(function () {
        // 请求期间用户可能已经划到别的词：只有卡片还停在同一个词上才回写状态
        if (state.data && state.data.dict && state.data.dict.word === d.word && state.data.saved) {
          state.data.saved.starred = next
          render()
        }
      })
      .catch(function () {})
  }

  // ------------------------------------------------------------ 取数据
  function runLookup(word, sentence) {
    state.data = null
    state.candidates = null
    // 单词语义上不需要译文，顺手清掉，免得从短语切过来时残留旧译文
    state.translation = null
    state.error = ''
    state.text = word
    if (state.visible) render()

    // token 必须在缓存命中之前推进：先选 A（请求在途）再选 B（B 命中缓存）时，
    // A 的响应会带着旧 token 回来，把 B 的卡片内容换成 A 的词典数据。
    state.token++
    const token = state.token
    if (inflight) {
      try {
        inflight.abort()
      } catch (err) {}
      inflight = null
    }

    const hit = cacheGet(word)
    if (hit) {
      state.data = hit
      if (state.visible) render()
      return
    }
    const params = new URLSearchParams({ word: word })
    if (sentence) params.set('sentence', sentence.slice(0, 1000))

    if (inflight) {
      try {
        inflight.abort()
      } catch (err) {}
    }
    const controller = new AbortController()
    inflight = controller

    fetch(API.lookup + '?' + params.toString(), {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(function (r) {
        return r.json()
      })
      .then(function (json) {
        if (token !== state.token) return
        inflight = null
        if (json && json.ok) {
          cacheSet(word, json)
          state.data = json
          // 服务端写库失败（生词本没存进去）会带 warnings，必须让用户看见
          state.warnings = Array.isArray(json.warnings) ? json.warnings : []
        } else {
          state.error = (json && json.error) || '查不到这个词'
        }
        if (state.visible) render()
      })
      .catch(function (err) {
        if (token !== state.token) return
        inflight = null
        if (err && err.name === 'AbortError') return
        state.error = '查询失败：' + ((err && err.message) || '未知错误')
        if (state.visible) render()
      })
  }

  /**
   * 取译文。与拆词并行发出，回来了就立刻重绘。
   *
   * 失败不设 state.error —— 那是整卡错误，会把拆词结果也吞掉。
   * 翻译失败只画一行提示，词语该给还是要给。
   */
  function runTranslate(text, token) {
    fetch(API.translate, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: text.slice(0, 5900) }),
    })
      .then(function (r) {
        return r.json()
      })
      .then(function (json) {
        if (token !== state.token) return
        if (json && json.ok) {
          state.translation = {
            ok: true,
            text: json.text || '',
            source: json.source || '',
            cached: !!json.cached,
          }
        } else {
          state.translation = { ok: false, error: (json && json.error) || '翻译失败' }
        }
        if (state.visible) render()
      })
      .catch(function (err) {
        if (token !== state.token) return
        if (err && err.name === 'AbortError') return
        state.translation = {
          ok: false,
          error: '翻译失败：' + ((err && err.message) || '未知错误'),
        }
        if (state.visible) render()
      })
  }

  function runSplit(text) {
    state.data = null
    state.error = ''
    state.candidates = null
    state.translation = { pending: true }
    state.token++
    const token = state.token

    // 两件事同时发：翻译（主内容）和拆词（附加）。
    // 不串行 —— 串行会让用户多等一个来回。
    runTranslate(text, token)

    fetch(API.save, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: text }),
    })
      .then(function (r) {
        return r.json()
      })
      .then(function (json) {
        if (token !== state.token) return
        if (json && json.ok) {
          const words = json.words || []
          words.best = json.best || ''
          if (words.length === 1 && words[0].found) {
            // 只有一个词，直接展示它的详情
            runLookup(words[0].word, text)
            return
          }
          state.candidates = words
        } else {
          state.error = (json && json.error) || '拆词失败'
        }
        if (state.visible) render()
      })
      .catch(function (err) {
        if (token !== state.token) return
        state.error = '拆词失败：' + ((err && err.message) || '未知错误')
        if (state.visible) render()
      })
  }

  // ------------------------------------------------------------ 选区监听
  let timer = null

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(check, DEBOUNCE_MS)
  }

  // 排除范围（代码块 / 链接 / 表格 / 按钮…）与生效范围（只认 data-chat-flow）
  // 的判定都在 core.js：wordcard 与测试共用同一份口径，这里不再重复实现。

  /** 选区是否"像英文内容"：至少有一个拉丁字母，且不是纯中文。 */
  function looksEnglish(text) {
    const latin = (text.match(/[A-Za-z]/g) || []).length
    if (!latin) return false
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
    // 中文比英文还多，说明用户想翻译中文，不是学单词
    return latin >= cjk
  }

  // 句末标点：中英都算。不用正则字面量，避开这里历史遗留的转义坑。
  const SENTENCE_MARKS = '.!?。！？'

  /**
   * 取「这个词所在的那句话」。
   *
   * 为什么需要：P1 的义项判别问的是「**这句里**它是哪个意思」，没有原句就只剩
   * 「这个词有几个意思」——那又变回选择题了。之前只把选中文本当 sentence 存，
   * 双击选一个词时原句就等于单词本身，义项分析自然跑不出材料。
   *
   * 失败一律返回 ''（调用方退回只存单词），不影响划词卡片本身。
   */
  function sentenceAround(range, word) {
    try {
      const node = range.startContainer
      const el = node && node.nodeType === 1 ? node : node && node.parentElement
      if (!el || !el.closest) return ''
      let block = el.closest('p,li,td,blockquote,h1,h2,h3,h4,h5,h6')
      if (!block) block = el.closest('[data-chat-flow]')
      if (!block) return ''
      const full = block.textContent || ''
      if (!full) return ''

      // 选区起点在整块文本里的偏移
      const pre = document.createRange()
      pre.selectNodeContents(block)
      try {
        pre.setEnd(range.startContainer, range.startOffset)
      } catch (err) {
        return ''
      }
      const at = pre.toString().length

      // 往前找句末（最多 260 字，避免把整段吞进来）
      let start = 0
      for (let i = at - 1; i >= Math.max(0, at - 260); i--) {
        if (SENTENCE_MARKS.indexOf(full[i]) >= 0 || full[i] === '\n') {
          start = i + 1
          break
        }
      }
      // 往后找句末
      let end = full.length
      const limit = Math.min(full.length, at + 300)
      for (let j = at + word.length; j < limit; j++) {
        if (SENTENCE_MARKS.indexOf(full[j]) >= 0 || full[j] === '\n') {
          end = j + 1
          break
        }
      }

      const s = full.slice(start, end).trim()
      if (!s || s.length < word.length) return ''
      if (s.toLowerCase().indexOf(word.toLowerCase()) < 0) return ''
      return s.slice(0, 600)
    } catch (err) {
      return ''
    }
  }

  function check() {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const raw = sel.toString()
    if (!raw) return
    const text = raw.replace(/^\s+|\s+$/g, '')
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) return

    const range = sel.getRangeAt(0)
    const node = range.startContainer
    const el = node && node.nodeType === 1 ? node : node && node.parentElement
    if (inEditable(el)) return
    // 生效范围：选区**两端**都必须落在对话正文里。左栏、右栏、轨迹页、
    // 学习看板都没有 data-chat-flow 祖先，在这里被挡掉。
    if (!inConversation(range.startContainer) || !inConversation(range.endContainer)) return
    if (!looksEnglish(text)) return

    // Ctrl+A 全选整页不该弹卡片
    try {
      const bodyText = (
        document.body && document.body.innerText ? document.body.innerText : ''
      ).replace(/^\s+|\s+$/g, '')
      if (bodyText && text === bodyText) return
    } catch (err) {}

    const rects = range.getClientRects ? range.getClientRects() : null
    let rect = null
    if (rects && rects.length) rect = rects[rects.length - 1]
    if (!rect || (!rect.width && !rect.height)) rect = range.getBoundingClientRect()
    if (!rect || (!rect.width && !rect.height)) return

    // 判断是单词还是短语。
    //
    // 注意这里**不能只看字符形状**。`≈62.3M`、`≈65.7k` 这类数值量级后缀
    // 剥掉前后非字母后会剩下 `M` / `k`，形状上完全像"一个单词"，
    // 于是被当单词查了 —— 实测就是这样把 `m`、`k` 两条噪音存进了生词本。
    // 所以额外要求：长度 >= 2、含元音、不是全大写缩写。
    const bare = text.replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, '')
    const isSingle =
      /^[A-Za-z][A-Za-z'’-]*$/.test(bare) &&
      bare.length >= 2 &&
      /[aeiouy]/i.test(bare) &&
      !(bare.length >= 2 && bare === bare.toUpperCase())

    // 单个词：把词所在的那句话一起存下来（P1 义项判别需要语境）。
    // 选中的是一段话时，它本身就是原句，不用再扩。
    let ctx = text
    if (isSingle) {
      const around = sentenceAround(range, bare)
      if (around) ctx = around
    }

    show(text, rect, ctx)
    if (isSingle) runLookup(bare.toLowerCase(), ctx)
    else runSplit(text)
  }

  document.addEventListener(
    'mouseup',
    function (event) {
      if (card && card.contains(event.target)) return
      schedule()
    },
    true,
  )

  document.addEventListener(
    'keyup',
    function (event) {
      if (
        event.key === 'Shift' ||
        event.shiftKey ||
        (event.ctrlKey && (event.key === 'a' || event.key === 'A'))
      ) {
        schedule()
      }
    },
    true,
  )

  document.addEventListener(
    'mousedown',
    function (event) {
      if (card && card.contains(event.target)) return
      if (state.visible) hide()
    },
    true,
  )

  document.addEventListener(
    'keydown',
    function (event) {
      if (event.key === 'Escape' && state.visible) hide()
    },
    true,
  )

  // 滚动/缩放会让卡片错位，直接收起最不容易看起来出错；但卡片自己内部滚动不算
  window.addEventListener(
    'scroll',
    function (event) {
      if (card && event.target && card.contains(event.target)) return
      if (state.visible) hide()
    },
    true,
  )
  window.addEventListener('resize', function () {
    if (state.visible) hide()
  })

  // 主题切换时重画卡片。
  //
  // DSH 切主题只改 body 上的属性/变量，**不触发** matchMedia（用户手动切
  // 明暗时系统偏好没变）。所以光监听 media query 会漏掉最常用的一种切换。
  // 这里额外盯 body 的属性变化，两者都监听。
  try {
    if (window.MutationObserver && document.body) {
      const themeObserver = new MutationObserver(function () {
        if (state.visible) render()
      })
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
      })
    }
  } catch (err) {}

  if (window.matchMedia) {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onTheme = function () {
        if (state.visible) render()
      }
      if (mq.addEventListener) mq.addEventListener('change', onTheme)
      else if (mq.addListener) mq.addListener(onTheme)
    } catch (err) {}
  }
})()
