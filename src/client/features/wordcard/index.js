/* dsh-word-learn —— 前端划词学习卡（构建源码，ESM）。
 *
 * 行为：鼠标选中英文 → 浮出学习卡，就地显示音标、释义、变形、词频分级、
 *       语音朗读按钮（浏览器 Web Speech API，见下方 speakText）；选中一段话则先给整句译文
 *       + 朗读整句，再列出候选词让用户挑。
 *
 * 纯原生实现，不依赖 DSH 内部模块（硬约束：不许 require 客户端包）。
 * 样式常量在 ./style.js，卡片视图（DOM/渲染/定位）在 ./card.js；颜色只走主题变量
 * + 自带明暗两套。
 *
 * 原 assets/wordcard.js：注入页面的 IIFE，加载即注册全部监听（顶层副作用），
 * 判定 / 视图 / 样式分别靠三个先注入的脚本挂在 window 上传递，防重靠一个共用的
 * window 标志。阶段 2 起它是 bundle 内的模块：CORE / CARD 都是 import，监听与卡片
 * DOM 都挪进 installWordcard()，卸载走它返回的 dispose() ——
 * 「注入顺序 + window 防重」整套协议不再需要。
 *
 * 交互设计的两条依据（来自用户的实际处境）：
 *   1. 用户说"感觉全是生词，但又好像没那么生词" → 卡片必须**给出分级**，
 *      让用户自己判断，而不是替他决定收不收。
 *   2. 用户抱怨现有划词翻译"慢、会改格式、导致前端崩溃" → 卡片全程
 *      position:fixed 独立浮层，**绝不修改页面 DOM**，且任何异常都吞掉。
 */
import CORE from '../core.js'
import CARD from './card.js'

const { inConversation, inEditable, voiceErrorText, isAbort, stopSpeaking, speakText } = CORE

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
// 卡片的全部 CSS 是 ./style.js 的常量，由 ./card.js 的 mount() 负责挂到 <style>；
// 本文件不持有样式常量（原来这里是"等更早注入的脚本把它挂到 window"）。

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
  accent: 'us', // 'us' | 'uk'，发音口音（installWordcard() 里从偏好读一次）
}
let inflight = null

// 卡片只画不绑：DOM/markup/定位/渲染在 ./card.js，这里只负责装配 ——
// mount 建卡、绑事件、syncAccent 补口音文案。
function buildCard() {
  const mounted = CARD.mount()
  card = mounted.card
  els = mounted.els
  syncAccentButton()

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

  return card
}

function ensureCard() {
  if (card && card.isConnected) return card
  card = null
  els = null
  return buildCard()
}

// 渲染/定位是纯视图操作，实现在 wordcard-card.js。契约：render 只读 state，
// 写状态只发生在本文件（state 传引用，不拷贝）。
function render() {
  if (!card || !els) return
  CARD.render(card, els, state)
}

function place(rect) {
  if (!card) return
  CARD.place(card, rect)
}

function show(text, rect, sentence) {
  ensureCard()
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
// 的判定都在 core.js；共同排除项（BLOCKED_ELEMENTS）与 annotate.js 共用一份，
// 这里不再重复实现。

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

// ------------------------------------------------------------ 安装 / 卸载
//
// 原来这些监听是脚本注入那一刻就注册的（IIFE 顶层副作用），防重靠一个共用的
// window 标志。阶段 2 起它们属于 installWordcard()：plugin.js 的 apply() 装、
// 卸载时调 dispose()；装两次不叠加（模块级 installed 代替原来的 window 防重，
// 第二次直接返回同一个 dispose）。

/** 装着的时候收集所有可撤销句柄，dispose 一次清干净。 */
let installed = false
let currentDispose = null

/** 装 document / window 上的划词监听，返回卸载函数。 */
function installWindowListeners() {
  // 鼠标一松就查（防抖）：用户可能还在拖选，mouseup 才是"选完了"。
  function onMouseUp(event) {
    if (card && card.contains(event.target)) return
    schedule()
  }

  // 键盘选词：Shift+方向键 / Ctrl+A。只在这几种情况下才值得重算一次。
  function onKeyUp(event) {
    if (
      event.key === 'Shift' ||
      event.shiftKey ||
      (event.ctrlKey && (event.key === 'a' || event.key === 'A'))
    ) {
      schedule()
    }
  }

  // 点别处就收起（点卡片内部不收起，否则按钮点不到）。
  function onMouseDown(event) {
    if (card && card.contains(event.target)) return
    if (state.visible) hide()
  }

  // Esc 关闭。
  function onKeyDown(event) {
    if (event.key === 'Escape' && state.visible) hide()
  }

  // 滚动/缩放会让卡片错位，直接收起最不容易看起来出错；但卡片自己内部滚动不算
  function onScroll(event) {
    if (card && event.target && card.contains(event.target)) return
    if (state.visible) hide()
  }

  function onResize() {
    if (state.visible) hide()
  }

  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('keyup', onKeyUp, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)

  return function removeWindowListeners() {
    document.removeEventListener('mouseup', onMouseUp, true)
    document.removeEventListener('keyup', onKeyUp, true)
    document.removeEventListener('mousedown', onMouseDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', onResize)
  }
}

/**
 * 主题切换时重画卡片，返回卸载函数。
 *
 * DSH 切主题只改 body 上的属性/变量，**不触发** matchMedia（用户手动切
 * 明暗时系统偏好没变）。所以光监听 media query 会漏掉最常用的一种切换。
 * 这里额外盯 body 的属性变化，两者都监听。
 */
function installThemeWatch() {
  let observer = null
  try {
    if (window.MutationObserver && document.body) {
      observer = new MutationObserver(function () {
        if (state.visible) render()
      })
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
      })
    }
  } catch (err) {}

  let mq = null
  let onTheme = null
  if (window.matchMedia) {
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)')
      onTheme = function () {
        if (state.visible) render()
      }
      if (mq.addEventListener) mq.addEventListener('change', onTheme)
      else if (mq.addListener) mq.addListener(onTheme)
    } catch (err) {
      mq = null
    }
  }

  return function removeThemeWatch() {
    try {
      if (observer) observer.disconnect()
    } catch (err) {
      /* 忽略：卸载不该因为某一项失败而中断 */
    }
    try {
      if (!mq || !onTheme) return
      if (mq.removeEventListener) mq.removeEventListener('change', onTheme)
      else if (mq.removeListener) mq.removeListener(onTheme)
    } catch (err) {
      /* 忽略 */
    }
  }
}

/** 摘掉卡片 DOM 与卡片样式（样式由 ./card.js 的 mount() 挂，这里按 id 找回来）。 */
function unmountCard() {
  if (card && card.parentNode) card.parentNode.removeChild(card)
  card = null
  els = null
  const style = document.getElementById('dwl-style')
  if (style && style.parentNode) style.parentNode.removeChild(style)
}

/**
 * 装划词卡：建卡（含样式注入）+ 挂监听。返回 dispose()。
 *
 * 幂等：重复调用不会叠第二套监听/样式/DOM，直接返回同一个 dispose ——
 * 对应原注入脚本那个共用的 window 防重标志。
 */
export function installWordcard() {
  if (installed) return currentDispose
  installed = true

  // 口音偏好是卡片私有状态（localStorage 里只有 us / uk 两种，读不到就用美音）。
  state.accent = loadAccent()

  // 建卡：markup + 样式 + 卡片内部事件都在 CARD.mount() 里。原脚本是首次划词才建，
  // 这里装的时候就建好（dispose 才有东西可摘）；body 还没解析出来时退回首次划词再建。
  if (document.body) ensureCard()

  const teardown = [installWindowListeners(), installThemeWatch(), unmountCard]

  currentDispose = function dispose() {
    if (!installed) return
    installed = false
    currentDispose = null
    // 先掐掉待触发的防抖检查，否则装完刚划的词会在卸载后又弹出来。
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    // 收起卡片：停朗读、放弃在途请求、藏起 DOM。
    hide()
    for (let i = teardown.length - 1; i >= 0; i -= 1) {
      try {
        teardown[i]()
      } catch (err) {
        /* 忽略：某一项卸载失败不该让其余项留着 */
      }
    }
  }
  return currentDispose
}
