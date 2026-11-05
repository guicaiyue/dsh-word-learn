/* assets/wordcard-card.js —— 划词学习卡的卡片视图模块（window.__dwlWordcardCard）。
 *
 * 职责：卡片 DOM 构建（markup）、渲染（把状态画成 DOM）、定位（place）、
 *       主题判定（isDark）、HTML 转义（escapeHtml）。**不注册任何事件**，
 *       事件绑定/请求/状态机全在 wordcard.js。
 *
 * 无状态契约（重要）：本模块不持有 card/els/state 任何模块级变量，DOM 句柄
 * 一律由调用方传入 —— mount() 返回 { card, els }，render(card, els, state) /
 * place(card, rect) 显式接收。这样卡片的生命周期（React 冲掉后重建、contains
 * 判定、显示/隐藏）仍只由 wordcard.js 掌管，不会变成"DOM 藏在视图模块里"。
 *
 * 只读契约：render 只**读** state，绝不写；state 是 wordcard.js 的可变单例，
 * 传引用（不拷贝），写操作只发生在 wordcard.js。
 *
 * 依赖（注入顺序保证在前）：core.js（语音按钮契约）→ wordcard-style.js（CSS）。
 * 拿不到 core / style 就静默降级，不拖垮页面。
 */
;(function () {
  'use strict'
  if (window.__dwlWordcardCard) return

  const CORE = window.__dwlCore
  if (!CORE || typeof CORE.voiceButtonAttrs !== 'function') return
  const { VOICE_MISSING, voiceModule, voiceButtonAttrs } = CORE

  // 样式来自更早注入的 wordcard-style.js；拿不到就跳过（卡片不炸，只是没样式）。
  function ensureStyle() {
    if (document.getElementById('dwl-style')) return
    const css = window.__dwlWordcardStyle
    if (!css) return
    const style = document.createElement('style')
    style.id = 'dwl-style'
    style.textContent = css
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

  function renderTranslation(tr) {
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

  function render(card, els, state) {
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
        renderTranslation(state.translation) +
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

  function place(card, rect) {
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

  /** 建卡：注入样式 → 建 DOM → 缓存句柄 → 隐藏并挂到 body。返回 { card, els }。 */
  function mount() {
    ensureStyle()
    const card = document.createElement('div')
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
    const els = {
      word: card.querySelector('.dwlk-word'),
      tiers: card.querySelector('.dwl-tiers'),
      hint: card.querySelector('.dwl-hint'),
      body: card.querySelector('.dwlk-body'),
      foot: card.querySelector('.dwl-foot'),
      sound: card.querySelector('[data-act="sound"]'),
      accent: card.querySelector('[data-act="accent"]'),
      star: card.querySelector('[data-act="star"]'),
    }
    card.style.display = 'none'
    document.body.appendChild(card)
    return { card, els }
  }

  window.__dwlWordcardCard = {
    mount,
    render,
    place,
    isDark,
    escapeHtml,
  }
})()
