// annotate.js —— P3：DSH 对话正文内的生词标注层。
//
// 形态：独立 IIFE（排除范围的共同项从更早注入的 core.js 取），不依赖 React，
// 由宿主 index.js 以普通 <script> 注入（window.__dwlAnnotate 防重）。
// 坏了只影响标注，不拖垮划词卡片和学习页。
//
// 为什么是 DOM 标注而不是 React slot（v1 的技术选择，见 design/p3-inline-annotation.md）：
//   - 宿主已经注入普通 script，改这个文件不需要重启宿主；
//   - 进 React 客户端包要么重启宿主、要么接管整个助手渲染（priority:-1），代价高且脆。
//
// 三条铁律（用户原话）：
//   1. 只在 DSH 对话正文内加工：白名单根 [data-chat-flow]，其余页面一律不碰。
//   2. 流式输出一律不处理：靠 DSH 自己的 [data-streaming] 标记 + 文本稳定 600ms 双保险。
//   3. 代码/行内代码/文件名/URL/其它插件弹窗一律排除：容器黑名单 + token 邻接字符判断。
//
// 分层：范围发现 → 块分类 → 折叠/流式判定 → tokenize → 匹配 → 渲染 → 悬停卡。
// 全部配置集中在下方 CONFIG，方便长期演进；失败一律静默降级（不 throw、不刷 console）。

;(function () {
  'use strict'

  // 防重复注入：宿主两个 script 标签、或 HMR 重放都可能再来一次。
  if (window.__dwlAnnotate && window.__dwlAnnotate.version) return

  // 排除范围的共同项只有一份：core.js 的 BLOCKED_ELEMENTS（注入行保证 core 在前）。
  // 拿不到 core 就整体跳过标注 —— 这是最小兜底，绝不在本文件另抄一份名单。
  const CORE = window.__dwlCore
  if (!CORE || !Array.isArray(CORE.BLOCKED_ELEMENTS)) return

  const CONFIG = {
    VERSION: '1.0.0',

    // 开关：localStorage['dwl-annotate'] === 'off' 关闭；缺省/其它值 = 开。
    STORAGE_KEY: 'dwl-annotate',
    STORAGE_OFF: 'off',

    // ---- 范围发现（白名单）----
    // DSH 的对话流锚点。wordcard.js 的 SCOPE_SELECTOR 也是它（划词卡片与标注层共用同一根）。
    ROOT_SELECTOR: '[data-chat-flow]',
    // 一条消息/一个步骤 = 一个块。块是"分类 + 限额 + 可见性"的最小单位。
    // 两个选择器是同一批节点：真实 DOM 里 flowItem 同时带 data-chat-node-key；
    // 保留类名兜底是为了 DSH 换版本后属性丢了也能工作（Lead 在第二实例上确认了类名）。
    BLOCK_SELECTOR: '[data-chat-node-key], .EvIC1a_flowItem',
    KIND_ATTR: 'data-chat-flow-kind',
    GROUP_PART_ATTR: 'data-chat-group-part',
    // 助手回答/用户消息的正文容器（slot 是语义标识，不是哈希类名，跨版本稳定）。
    CONTENT_SLOT: '[data-slot="conversation.chat.node"]',
    // 思考块：data-variant=think，展开后才有 data-expanded。
    REASONING_SELECTOR: '[data-variant="think"]',
    REASONING_EXPANDED: '[data-variant="think"][data-expanded]',

    // 标的类型白名单：只标自然语言消息。
    // 为什么排除 tool-call / context / compaction / turn-process / turn-tail：
    // 它们是工具调用、上下文压缩提示、耗时行 —— 内容由命令、路径、JSON 组成，
    // 既不是"阅读材料"，hover 卡也会打断操作。
    ALLOWED_KINDS: ['user', 'assistant-step'],

    // ---- 黑名单（容器级）----
    // 命中即整棵子树跳过。顺序无所谓，合成一个选择器后交给 closest()/matches()。
    // 共同项（pre / code / .md-code-block / a / [data-ref-chip] / button / table）
    // 只在 core.js 的 BLOCKED_ELEMENTS 里维护；这里只列标注层特有项，避免双口径。
    BLACKLIST: CORE.BLOCKED_ELEMENTS.concat([
      // 工具/文件预览里的代码容器（pre / code 在共同项里，不重复列）。
      '[data-code-wrap]',
      '[data-code-block-banner]',
      // 交互控件：原生 button 在共同项里。
      // 注意**不能**黑名单 [role="button"]：DSH 的思考/过程折叠行是
      // div[role="button"][data-disclosure-row]，它的文本正是"折叠框标题"
      // （要求：未展开的折叠框只处理标题），黑掉它等于真实页面上一律 0 标注。
      // 表格：table 在共同项里；.md-table-wide 是标注层额外的保守排除
      // （v1 悬停卡在密集表格里容易挡视线，后续可配置放开）。
      '.md-table-wide',
      // 流式与折叠：DSH 用 hidden="until-found" 藏起未展开的 process 组；
      // [data-streaming] 是 AssistantMarkdown / 思考摘要的流式标记。
      '[hidden]',
      '[data-streaming]',
      '[data-chat-running]',
      // 折叠框：**不黑名单** [aria-expanded="false"] / [data-disclosure-header] /
      // [data-variant="think"]:not([data-expanded])。
      // 真实 DOM 里折叠行本身（aria-expanded=false 的 role=button 行、disclosure header、
      // data-variant=think 的预览行）装的就是"标题"；折叠的正文由 [hidden] /
      // 未渲染的 panel 兜住。黑名单只保留 [hidden]。
      // 原生 <details>（其它插件/未来 DSH 可能用）：未展开时只留 summary 可标。
      'details:not([open]) > :not(summary)',
      // 其它插件弹窗 / 内联交互卡（审批、提问、计划评审）、输入区、任务面板。
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
      // 我们自己的产物（重扫时不要钻进自己的 span/卡片）。
      '.dwl-anno',
      '.dwlac',
    ]),

    // ---- 流式/稳定性 ----
    // 三重判定（保守优先）：
    //   1. 权威标记 [data-streaming]（DSH 源码里 AssistantMarkdown 流式时会挂）；
    //   2. 本块文本 800ms 无变化（MutationObserver 会不断把变化重排进稳定性判定）；
    //   3. 页面正在跑（有 [data-chat-running]）时，当前回合 DOM 里的最后一块一律跳过
    //      —— 对应 Lead 实测的"最后一条消息还在增长"。
    STABLE_MS: 800,
    DEBOUNCE_MS: 250,

    // ---- 性能限额 ----
    PER_BLOCK_MAX: 60, // 单块最多标多少个词
    GLOBAL_MAX: 800, // 整页最多多少个 span
    BLOCK_TEXT_MAX: 12000, // 超过这个长度的块根本不扫（长表格/长日志）
    MAX_TEXT_NODES: 600, // 单块最多扫多少个文本节点
    MIN_WORD_LEN: 2,
    MAX_WORD_LEN: 32,
    IO_ROOT_MARGIN: '400px 0px',

    // ---- 数据接口 ----
    // 词表：Lead 在 index.js 挂。首选插件命名空间下的路径；万一挂的是短路径也能自愈。
    WORDS_PATHS: ['/dsh-word-learn/annotate/words', '/annotate/words'],
    // 入库/收进复习：复用已有的查词路由（POST JSON { word, sentence, save, enrich }）。
    CAPTURE_PATH: '/dsh-word-learn/lookup',
    WORDS_TIMEOUT_MS: 4000,
    WORDS_TTL_MS: 5 * 60 * 1000,
    WORDS_RETRY_BASE_MS: 20000,
    WORDS_RETRY_MAX_MS: 5 * 60 * 1000,
  }

  // 允许外部（测试/宿主）在脚本加载后微调，再调用 refresh 生效。
  function mergeConfig(overrides) {
    if (!overrides || typeof overrides !== 'object') return
    for (const key in overrides) {
      if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue
      if (key === 'BLACKLIST' || key === 'ALLOWED_KINDS' || key === 'WORDS_PATHS') continue
      CONFIG[key] = overrides[key]
    }
  }

  // ======================================================================
  // 第一部分：纯函数（无 DOM，可单测）
  // ======================================================================

  function isUpperCode(code) {
    return code >= 65 && code <= 90
  }
  function isLowerCode(code) {
    return code >= 97 && code <= 122
  }
  function isLetterCode(code) {
    return isUpperCode(code) || isLowerCode(code)
  }
  function isDigitCode(code) {
    return code >= 48 && code <= 57
  }

  // 撇号：' (39) 与 ’ (8217)。不用正则/转义，直接比码点。
  const APOSTROPHE_1 = 39
  const APOSTROPHE_2 = 8217

  /**
   * 把一段纯文本切成"英文 token"。
   *
   * 为什么手写扫描而不是正则 split：这个项目里正则字面量的反斜杠已经出过事故
   * （工具把 \n 写成 \\n），而这里只是"字母 + 撇号"的连续段，手写更稳、可控。
   * 撇号只在后面还跟字母时才并进 token（don't / model's 不拆）。
   */
  // 非 ASCII 的"字母"：拉丁扩展（résumé、naïve）、希腊/西里尔、组合音标等。
  // 用来识别"这个词只是某个非 ASCII 单词被切出来的一截"。
  // CJK（>= 0x4E00）不算：中文紧贴英文（这是model）是常见排版，不能因此跳过英文词。
  // 标点/空白也不算：不换行空格、软连字符、— – “ ” 等邻接不能把正常英文词判成残片。
  function isNonAsciiLetter(code) {
    if (code <= 127) return false
    if (code === 160 || code === 173) return false // NBSP / soft hyphen
    if (code >= 0x2000 && code <= 0x206f) return false // 通用标点（含 — – “ ” ‘ ’）
    if (code >= 0x2e00 && code <= 0x2e7f) return false // 补充标点
    return code < 0x2e80
  }

  // 撇号归一化：U+2019 与 U+02BC 统一成 ASCII 单引号，保证 "don't" 能命中词表。
  function normalizeApostrophes(text) {
    let out = ''
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      out += code === 8217 || code === 700 ? String.fromCharCode(39) : text.charAt(i)
    }
    return out
  }

  function tokenize(text) {
    const out = []
    const n = text.length
    let i = 0
    while (i < n) {
      const code = text.charCodeAt(i)
      if (!isLetterCode(code)) {
        i += 1
        continue
      }
      let j = i + 1
      let camel = false
      while (j < n) {
        const c = text.charCodeAt(j)
        if (isLetterCode(c)) {
          if (isUpperCode(c) && isLowerCode(text.charCodeAt(j - 1))) camel = true
          j += 1
          continue
        }
        if (c === APOSTROPHE_1 || c === APOSTROPHE_2) {
          const next = j + 1 < n ? text.charCodeAt(j + 1) : 0
          if (isLetterCode(next)) {
            j += 1
            continue
          }
        }
        break
      }
      const before = i > 0 ? text.charCodeAt(i - 1) : 0
      const after = j < n ? text.charCodeAt(j) : 0
      out.push({
        start: i,
        end: j,
        raw: text.slice(i, j),
        camel: camel,
        foreign: isNonAsciiLetter(before) || isNonAsciiLetter(after),
      })
      i = j
    }
    return out
  }

  /**
   * 一个 token 可能的原形候选（用于匹配"有卡片"的词）。
   *
   * v1 只做规则化词形还原：复数/过去式/进行时/所有格/副词。
   * 为什么敢做：候选只是"拿去查词表"，查不到就没有任何副作用；
   * 而漏掉 charged/charges 会让标注覆盖率明显变差。
   */
  function lemmaCandidates(lower) {
    // 弯撇号先归一化：don’t 与 don't 必须命中同一张词表。
    const normalized = normalizeApostrophes(String(lower || ''))
    const out = [normalized]
    let word = normalized
    // 所有格：model's -> model
    if (word.length > 2) {
      const tail2 = word.slice(-2)
      if (tail2 === "'s" || tail2 === String.fromCharCode(8217) + 's') {
        word = word.slice(0, -2)
        out.push(word)
      }
    }
    if (word.length > 2) {
      const last = word.charAt(word.length - 1)
      if (last === 's') {
        out.push(word.slice(0, -1))
        if (word.length > 3 && word.slice(-2) === 'es') out.push(word.slice(0, -2))
        if (word.length > 3 && word.slice(-3) === 'ies') out.push(word.slice(0, -3) + 'y')
      }
      if (word.slice(-2) === 'ed') {
        out.push(word.slice(0, -2))
        out.push(word.slice(0, -1))
        const doubled = word.slice(0, -2)
        if (
          doubled.length > 1 &&
          doubled.charAt(doubled.length - 1) === doubled.charAt(doubled.length - 2)
        ) {
          out.push(doubled.slice(0, -1))
        }
      }
      if (word.slice(-3) === 'ing') {
        out.push(word.slice(0, -3))
        const stem = word.slice(0, -3)
        if (stem.length > 1 && stem.charAt(stem.length - 1) === stem.charAt(stem.length - 2)) {
          out.push(stem.slice(0, -1))
        }
        out.push(word.slice(0, -3) + 'e')
      }
      if (word.slice(-2) === 'ly') out.push(word.slice(0, -2))
      if (word.slice(-2) === 'er') out.push(word.slice(0, -2))
      if (word.slice(-3) === 'est') out.push(word.slice(0, -3))
    }
    // 去重 + 长度门槛
    const seen = {}
    const deduped = []
    for (let i = 0; i < out.length; i += 1) {
      const cand = out[i]
      if (!cand || cand.length < CONFIG.MIN_WORD_LEN || cand.length > CONFIG.MAX_WORD_LEN) continue
      if (seen[cand]) continue
      seen[cand] = 1
      deduped.push(cand)
    }
    return deduped
  }

  // token 两侧的"标识符邻接字符"：这些字符紧贴 token 时说明它在一个
  // 路径/URL/标识符/版本号里，不是自然语言单词。
  const GLUE_BEFORE = [47, 92, 95, 64, 35, 36, 37, 38, 61, 43, 60, 62, 126, 94, 58]
  function isGlueCode(code) {
    if (isDigitCode(code)) return true
    return GLUE_BEFORE.indexOf(code) >= 0
  }

  /**
   * token 是否像"自然语言里的一个词"（不是代码/路径/URL 的一部分）。
   *
   * 这里只做"邻接字符 + 形状"判断，不做词典判断：真正的门槛是"在用户的卡片词表里"。
   * 规则逐条对应已知噪音来源：
   *   - src/lib/index.js → index 前后是 / 和 .，跳过
   *   - https://api.example.com → 前后是 : / .，跳过
   *   - config_path → 下划线邻接，跳过
   *   - getElementById → 驼峰，跳过
   *   - API / HTTP → 全大写，跳过
   *   - v24.13.0 → 数字邻接，跳过
   *   - v24 / 3D → 数字邻接，跳过
   */
  function isPlainWord(text, token) {
    const raw = token.raw
    if (raw.length < CONFIG.MIN_WORD_LEN || raw.length > CONFIG.MAX_WORD_LEN) return false
    if (token.camel) return false
    // 残缺词：紧邻非 ASCII 字母（résumé 里被切出的 "sum"），绝不能当英文单词标。
    if (token.foreign) return false
    // 全大写（长度 >= 2）多半是缩写
    const letters = raw.replace(/[^A-Za-z]/g, '')
    if (letters.length >= 2 && letters === letters.toUpperCase()) return false
    const n = text.length
    const before = token.start > 0 ? text.charCodeAt(token.start - 1) : 0
    const after = token.end < n ? text.charCodeAt(token.end) : 0
    if (before && isGlueCode(before)) return false
    if (after && isGlueCode(after)) return false
    // 句点邻接：word. 后面跟空白是句号（允许）；后面跟字母是文件名（跳过）。
    if (after === 46) {
      const nextCode = token.end + 1 < n ? text.charCodeAt(token.end + 1) : 0
      if (isLetterCode(nextCode) || isDigitCode(nextCode)) return false
    }
    if (before === 46) {
      const prevCode = token.start - 2 >= 0 ? text.charCodeAt(token.start - 2) : 0
      if (isLetterCode(prevCode) || isDigitCode(prevCode)) return false
    }
    // 连字符邻接：dsh-word-learn 里的 word/learn 跳过。
    // 代价是 well-known 这类复合词也会跳过 —— 保守方向正确（宁可少标）。
    if (before === 45 || after === 45) return false
    return true
  }

  /**
   * 在 text 里找出所有"命中词表"的词。
   * @param {string} text
   * @param {Set<string>} wordSet 小写原形集合
   * @returns {Array<{start:number,end:number,raw:string,lemma:string}>}
   */
  function matchText(text, wordSet) {
    const out = []
    if (!text || !wordSet || !wordSet.size) return out
    const tokens = tokenize(text)
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]
      if (!isPlainWord(text, token)) continue
      const cands = lemmaCandidates(token.raw.toLowerCase())
      for (let j = 0; j < cands.length; j += 1) {
        if (wordSet.has(cands[j])) {
          out.push({ start: token.start, end: token.end, raw: token.raw, lemma: cands[j] })
          break
        }
      }
    }
    return out
  }

  /** 轻量文本指纹：用来判断"这个块的内容有没有变过"。 */
  function hashText(text) {
    let h = 5381
    const n = text.length
    // 只采样前 4000 字符 + 长度，足够发现"内容变了"，又不会在长块上卡住。
    const limit = n > 4000 ? 4000 : n
    for (let i = 0; i < limit; i += 1) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0
    }
    return String(h) + ':' + String(n)
  }

  /**
   * 从一段文本里截"包含 [start,end) 的那句话"。
   * 句末标点：中英问号/叹号/句号/换行。句点要排除小数与缩写（. 后跟字母/数字就不算断句）。
   */
  function sentenceAround(text, start, end) {
    const n = text.length
    let left = start
    while (left > 0) {
      const c = text.charCodeAt(left - 1)
      if (c === 10 || c === 13) break
      if (c === 33 || c === 63 || c === 12290 || c === 65281 || c === 65311) break
      if (c === 46) {
        // 小数（3.5）不断句；其余句点（word. Next）断。
        const prev = left - 2 >= 0 ? text.charCodeAt(left - 2) : 0
        const afterDot = left < n ? text.charCodeAt(left) : 0
        if (!(isDigitCode(prev) && isDigitCode(afterDot))) break
      }
      left -= 1
    }
    let right = end
    while (right < n) {
      const d = text.charCodeAt(right)
      if (d === 10 || d === 13) break
      if (d === 33 || d === 63 || d === 12290 || d === 65281 || d === 65311) {
        right += 1
        break
      }
      if (d === 46) {
        const before = right - 1 >= 0 ? text.charCodeAt(right - 1) : 0
        const next = right + 1 < n ? text.charCodeAt(right + 1) : 0
        if (!(isDigitCode(before) && isDigitCode(next))) {
          right += 1
          break
        }
      }
      right += 1
    }
    let out = text.slice(left, right).trim()
    if (out.length > 400) out = out.slice(0, 400)
    return out
  }

  // 测试/调试用：Node 里没有 DOM 时也能访问纯函数（scripts/test-annotate.mjs 会用）。
  const internals = {
    tokenize: tokenize,
    lemmaCandidates: lemmaCandidates,
    isPlainWord: isPlainWord,
    matchText: matchText,
    hashText: hashText,
    sentenceAround: sentenceAround,
  }

  // ======================================================================
  // 第二部分：DOM 层（范围发现 → 分类 → 判定 → 渲染）
  // ======================================================================

  const hasDom =
    typeof document !== 'undefined' && document && typeof document.querySelectorAll === 'function'

  const api = {
    version: CONFIG.VERSION,
    _internals: internals,
    _config: CONFIG,
    enable: enable,
    disable: disable,
    refresh: refresh,
    clear: clearAnnotations,
    stats: function () {
      const spans = document.querySelectorAll('.dwl-anno')
      let blocks = 0
      const seen = []
      for (let i = 0; i < spans.length; i += 1) {
        const b = blockOf(spans[i])
        if (b && seen.indexOf(b) < 0) {
          seen.push(b)
          blocks += 1
        }
      }
      return {
        enabled: isEnabled(),
        running: state.running,
        words: state.words.size,
        rev: state.rev,
        total: state.total,
        truncated: state.truncated,
        blocks: blocks,
        spans: spans.length,
      }
    },
  }
  window.__dwlAnnotate = api

  // Node/非浏览器环境（单测）：只暴露纯函数就返回，绝不碰 DOM。
  if (!hasDom) {
    api._noDom = true
    return
  }

  // ---- 运行时状态 ----
  const state = {
    running: false,
    words: new Map(), // lemma -> { t, s, c }
    rev: '',
    total: 0, // 服务端命中过滤的总词数（不受 limit 影响）
    truncated: false, // true = 只拿到了最近 limit 个在学词
    fetchedAt: 0,
    loading: false,
    fetchFailures: 0,
    retryTimer: 0,
    // 标注计数不再自己累加（React 重渲染会把 span 冲掉，累加值只增不减会永久停摆），
    // 统一用 DOM 实时值：spanCountNow() / blockSpanCount()。
    doneHash: new WeakMap(), // block -> 指纹（文本 + 折叠状态 + 本块 span 数）
    stability: new WeakMap(), // block -> { h, at }
    blockTimers: new WeakMap(), // block -> 稳定窗 timer id（每块只留一个）
    timerIds: new Set(), // 全部在跑的块 timer，stop 时统一清
    dirty: new WeakSet(), // 本轮 mutation 命中的块：scan 只重算这些
    observed: new WeakSet(),
    observer: null,
    io: null,
    flushTimer: 0,
    cardEl: null,
    cardSpan: null,
    cardInfo: null,
    cardRect: { w: 0, h: 0 },
    scrollRaf: 0,
    hideTimer: 0,
    showTimer: 0,
    started: false,
  }

  const BLACKLIST_SEL = CONFIG.BLACKLIST.join(',')

  function isEnabled() {
    try {
      return window.localStorage.getItem(CONFIG.STORAGE_KEY) !== CONFIG.STORAGE_OFF
    } catch (err) {
      // localStorage 被禁用（隐私模式/iframe 策略）时默认开，功能不因此消失
      return true
    }
  }

  // ---- 样式（颜色全部走宿主主题令牌 --dsw-alias-*）----
  const STYLE_ID = 'dwl-anno-style'
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return
    const css = [
      '.dwl-anno{',
      '  text-decoration:none;',
      '  border-bottom:1px dashed var(--dsw-alias-brand-primary,#2563eb);',
      '  cursor:help;border-radius:2px;',
      '  transition:background-color .12s ease;',
      '}',
      '.dwl-anno:hover,.dwl-anno:focus{',
      '  background:var(--dsw-alias-interactive-bg-hover-accent,rgba(37,99,235,.12));',
      '}',
      '.dwl-anno:focus-visible{',
      '  outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px;',
      '}',
      '.dwlac{',
      '  position:fixed;left:0;top:0;will-change:transform;',
      '  z-index:2147483000;box-sizing:border-box;',
      '  min-width:180px;max-width:min(340px,calc(100vw - 24px));',
      '  padding:10px 12px;border-radius:var(--dsw-radius-l,12px);',
      '  background:var(--dsw-alias-bg-overlay,#fff);',
      '  color:var(--dsw-alias-label-primary,#1f2328);',
      '  border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.15));',
      '  box-shadow:var(--dsw-shadow-lv3,0 12px 32px -10px rgba(15,23,42,.28));',
      '  font:400 13px/1.5 var(--ds-font-family-ui,system-ui,-apple-system,"Segoe UI",sans-serif);',
      '  text-align:left;display:none;',
      '}',
      '.dwlac[data-open="1"]{display:block}',
      'body[data-ds-dark-theme] .dwlac{',
      '  background:var(--dsw-alias-bg-layer-3,#1c1f26);',
      '  color:var(--dsw-alias-label-primary,#e6e8eb);',
      '  border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.13));',
      '}',
      '.dwlac-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dwlac-w{font-weight:650;font-size:15px;font-family:ui-serif,Georgia,serif;',
      '  color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dwlac-tag{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6b7280);',
      '  border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.15));',
      '  border-radius:999px;padding:0 6px;line-height:16px}',
      '.dwlac-s{margin-top:6px;color:var(--dsw-alias-label-secondary,#4b5563);',
      '  word-break:break-word;overflow-wrap:anywhere}',
      '.dwlac-row{display:flex;align-items:center;gap:8px;margin-top:9px}',
      '.dwlac-btn{',
      '  font:inherit;font-size:12px;line-height:24px;padding:0 10px;',
      '  color:var(--dsw-alias-brand-primary,#2563eb);',
      '  background:var(--dsw-alias-interactive-bg-hover-accent,rgba(37,99,235,.10));',
      '  border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.15));',
      '  border-radius:var(--dsw-radius-md,8px);cursor:pointer;',
      '}',
      '.dwlac-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.08))}',
      '.dwlac-btn[data-done="1"]{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dwlac-btn:disabled{opacity:.65;cursor:default}',
      '.dwlac-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280);margin-left:auto}',
      '@media (prefers-reduced-motion:reduce){.dwl-anno{transition:none}}',
    ].join('')
    const tag = document.createElement('style')
    tag.id = STYLE_ID
    tag.textContent = css
    ;(document.head || document.documentElement).appendChild(tag)
  }

  // ---- 范围发现：顶层 [data-chat-flow] ----
  // 嵌套的 [data-chat-flow]（process 组的 O_Ebla_content）只扫一次，避免重复标注。
  function collectRoots() {
    const all = document.querySelectorAll(CONFIG.ROOT_SELECTOR)
    const roots = []
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i]
      if (el.parentElement && el.parentElement.closest(CONFIG.ROOT_SELECTOR)) continue
      roots.push(el)
    }
    return roots
  }

  function blockOf(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement
    if (!el || !el.closest) return null
    return el.closest(CONFIG.BLOCK_SELECTOR)
  }

  function kindOf(block) {
    if (!block) return ''
    const kind = block.getAttribute(CONFIG.KIND_ATTR)
    // 兜底：属性在旧版/改版里可能缺失。只有确认是消息行（flowItem）才假定为回答；
    // 其余未知节点一律不标（宁可少标，不能标到工具行/折叠标题上）。
    if (!kind && block.matches && block.matches('.EvIC1a_flowItem')) return 'assistant-step'
    return kind || ''
  }

  function isAllowedKind(kind) {
    return CONFIG.ALLOWED_KINDS.indexOf(kind) >= 0
  }

  /** 页面是否正在跑一个回合（有运行指示器）。每轮 scan 只调用一次。 */
  function hasRunningIndicator() {
    return (
      !!document.querySelector('[data-chat-running]') ||
      !!document.querySelector('[aria-busy="true"]')
    )
  }

  /** 当前 DOM 顺序上最后一个"可标块"；没有就返回 null。每轮 scan 只调用一次。 */
  function findTailBlock() {
    const all = document.querySelectorAll(CONFIG.BLOCK_SELECTOR)
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (isAllowedKind(kindOf(all[i]))) return all[i]
    }
    return null
  }

  /**
   * 是否是"当前回合里 DOM 顺序上的最后一块"。
   *
   * 为什么需要：DSH 没有给每条消息稳定的 streaming 属性（Lead 在第二实例实测
   * data-streaming/aria-busy 都是 0）。运行指示器 + 最后一块 = 正在增长的那条，
   * 一律先跳过，等回合结束（指示器消失）或下一轮 mutation 再处理。
   *
   * ctx 由 scan 算一次后下传（pageRunning/tailBlock），避免每个块做两次全文档查询。
   */
  function isActiveTail(block, ctx) {
    const running = ctx ? ctx.pageRunning : hasRunningIndicator()
    if (!running) return false
    const tail = ctx ? ctx.tailBlock : findTailBlock()
    return !!tail && tail === block
  }

  /** 块内是否还有流式中的部分（块本身可能在 process 组里，标记在子节点上）。 */
  function hasStreaming(block) {
    if (!block) return false
    if (block.hasAttribute('data-streaming')) return true
    return !!block.querySelector('[data-streaming]')
  }

  /** 整页实时 span 数（不用累加值：React 重渲染会冲掉 span，累加会只增不减）。 */
  function spanCountNow() {
    return document.querySelectorAll('.dwl-anno').length
  }

  /** 本块实时 span 数（进指纹，用来发现"被 React 冲掉了"）。 */
  function blockSpanCount(block) {
    if (!block || !block.querySelectorAll) return 0
    return block.querySelectorAll('.dwl-anno').length
  }

  /**
   * 从文本节点往上找"第一个命中的黑名单容器"。
   *
   * 旧实现对每个文本节点把 30+ 条选择器 matches 一遍（每条都要走一遍祖先链），
   * 是标注阶段的大头开销。这里改为：每个文本节点只爬一次祖先链，
   * 沿途用 closest 缓存不了（祖先不同），但可以按"最近的容器"短路——
   * 命中即返回，且用 el.matches(BLACKLIST_SEL) 一次性判断（浏览器内部合成匹配，比逐条快）。
   * 另外把"是否命中"按祖先元素缓存进 WeakMap：同一段正文里大量文本节点共享祖先，
   * 缓存命中后 O(1)。
   */
  let blockedCache = new WeakMap() // element -> true/false（相对整棵文档）
  function isBlocked(node, stopAt) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement
    while (el && el !== stopAt) {
      const cached = blockedCache.get(el)
      if (cached === true) return true
      if (el.nodeType !== 1) {
        el = el.parentElement
        continue
      }
      const hit = el.matches(BLACKLIST_SEL)
      blockedCache.set(el, hit)
      if (hit) return true
      el = el.parentElement
    }
    // stopAt 自身也要判：内容根自己可能就是折叠面板/黑名单容器。
    if (stopAt && stopAt.nodeType === 1) {
      const cachedRoot = blockedCache.get(stopAt)
      if (cachedRoot === true) return true
      const rootHit = stopAt.matches(BLACKLIST_SEL)
      blockedCache.set(stopAt, rootHit)
      if (rootHit) return true
    }
    return false
  }

  /**
   * 块内可标注的正文根。
   *
   * - 普通消息/回答：走 slot conversation.chat.node（语义标识，非哈希类名）。
   * - 思考步骤（group-part=reasoning）：只取"已展开"的思考块；未展开时正文不在 DOM，
   *   折叠标题是中文"思考"，不标。
   */
  function contentRoots(block) {
    // 真实 DSH 的思考/过程折叠行也是 assistant-step + slot 包裹，
    // 折叠态的正文由 [hidden]（process 组）或"未渲染的 panel"天然排除；
    // **不能**像旧版那样对 part=reasoning 直接返回 []（那样连标题都不标）。
    // 旧 DOM 的 data-variant=think 展开体仍按展开态处理。
    const part = block.getAttribute(CONFIG.GROUP_PART_ATTR) || ''
    if (part === 'reasoning') {
      const expanded = block.querySelectorAll(CONFIG.REASONING_EXPANDED)
      if (expanded.length) return Array.prototype.slice.call(expanded)
    }
    const nodes = block.querySelectorAll(CONFIG.CONTENT_SLOT)
    if (nodes.length) return Array.prototype.slice.call(nodes)
    return [block]
  }

  // ---- 渲染：给命中的词加 span，原文一个字不改 ----
  function makeSpan(match, info) {
    const span = document.createElement('span')
    span.className = 'dwl-anno'
    span.setAttribute('data-w', match.lemma)
    span.setAttribute('tabindex', '0')
    if (info && info.s) span.setAttribute('data-has-sense', '1')
    // 文本原样放回：不替换、不翻译、不改大小写
    span.textContent = match.raw
    return span
  }

  /** 把一个文本节点按 matches 拆成 [文本, span, 文本, span, 文本] 插回原处。 */
  function applyMatches(textNode, matches, wordMap) {
    const text = textNode.nodeValue || ''
    const parent = textNode.parentNode
    if (!parent || !matches.length) return 0
    const frag = document.createDocumentFragment()
    let cursor = 0
    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i]
      if (m.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, m.start)))
      frag.appendChild(makeSpan(m, wordMap.get(m.lemma)))
      cursor = m.end
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
    parent.replaceChild(frag, textNode)
    return matches.length
  }

  /**
   * 标注一个块。
   *
   * 幂等：调用方用 doneHash 保证内容没变就不再进来；这里再按块限额兜底。
   * 失败静默：任何异常都只记在 block 上，不向 console 抛。
   */
  function annotateBlock(block) {
    if (!state.words.size) return 0
    const kind = kindOf(block)
    if (!isAllowedKind(kind)) return 0
    if (block.hidden) return 0
    if (hasStreaming(block)) return 0
    const blockText = block.textContent || ''
    if (!blockText || blockText.length > CONFIG.BLOCK_TEXT_MAX) return 0
    // 全局限额用实时值：不清零的累加值会被 React 重渲染冲掉的旧 span 卡死（审查报告 A 批第 1 条）。
    if (spanCountNow() >= CONFIG.GLOBAL_MAX) return 0
    const existing = blockSpanCount(block)
    if (existing >= CONFIG.PER_BLOCK_MAX) return 0

    // 黑名单缓存只在本轮有效：hidden / aria-expanded 会变化，跨轮缓存会误判。
    blockedCache = new WeakMap()
    const roots = contentRoots(block)
    let budget = CONFIG.PER_BLOCK_MAX - existing
    let added = 0
    for (let r = 0; r < roots.length && budget > 0; r += 1) {
      const root = roots[r]
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      const nodes = []
      let node = walker.nextNode()
      while (node) {
        nodes.push(node)
        if (nodes.length >= CONFIG.MAX_TEXT_NODES) break
        node = walker.nextNode()
      }
      for (let i = 0; i < nodes.length && budget > 0; i += 1) {
        const textNode = nodes[i]
        const value = textNode.nodeValue || ''
        if (!value || !value.trim()) continue
        if (textNode.parentElement && textNode.parentElement.classList.contains('dwl-anno'))
          continue
        if (isBlocked(textNode, root)) continue
        let matches = matchText(value, wordSet())
        if (!matches.length) continue
        if (matches.length > budget) matches = matches.slice(0, budget)
        const n = applyMatches(textNode, matches, state.words)
        added += n
        budget -= n
        if (spanCountNow() >= CONFIG.GLOBAL_MAX) {
          budget = 0
          break
        }
      }
    }
    return added
  }

  // 词表 Set 的缓存（每次 fetch 重建，避免每轮 match 都建 Set）
  let wordSetCache = { rev: '', set: new Set() }
  function wordSet() {
    if (wordSetCache.rev !== state.rev) {
      wordSetCache = { rev: state.rev, set: new Set(state.words.keys()) }
    }
    return wordSetCache.set
  }

  // ---- 标注/回滚 ----
  /**
   * 把一个 span 还原成纯文本节点。
   *
   * 不调用 parent.normalize()：normalize 会把相邻文本节点合并，而 React 可能正持有
   * 其中某个文本节点的引用（fiber 的 text content 指针），合并后引用变成孤儿，
   * 后续 React 更新会写到一个已不在 DOM 里的节点上 —— 表现为"改了字但页面不更新"。
   * 格式上相邻文本节点完全等价，多余的文本节点无副作用。
   */
  function unwrapSpan(span) {
    const parent = span.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(span.textContent || ''), span)
  }

  /** 撤销全部标注（开关关闭、词表版本变化、tests 用）。 */
  function clearAnnotations() {
    const spans = document.querySelectorAll('.dwl-anno')
    for (let i = 0; i < spans.length; i += 1) unwrapSpan(spans[i])
    state.doneHash = new WeakMap()
    state.stability = new WeakMap()
    clearBlockTimers()
    hideCard(true)
  }

  /**
   * 块的可观察状态指纹：文本 + 折叠/展开状态 + 本块 span 数。
   *
   * 为什么必须把折叠状态算进去：<details> 未展开时 textContent 里**已经包含**
   * 折叠体文本，只比文本会得到"内容没变"，于是展开后永远不会补标。
   * DSH 的 hidden="until-found" / data-expanded 同理。
   *
   * 为什么必须把 span 数算进去：React 重渲染会把我们的 span 冲掉、但文本一字不变，
   * 只比文本会认为"已标注完"，于是永远不补标（审查报告 A 批第 2 条）。
   */
  function foldSignature(block) {
    let sig = ''
    if (block.hidden) sig += 'b1.'
    sig += String(block.querySelectorAll('details[open]').length) + '.'
    sig += String(block.querySelectorAll('[data-expanded]').length) + '.'
    sig += String(block.querySelectorAll('summary').length) + '.'
    sig += String(block.querySelectorAll('[hidden]').length)
    return sig
  }

  function fingerprintOf(block) {
    return (
      hashText(block.textContent || '') +
      '#' +
      foldSignature(block) +
      '#' +
      String(blockSpanCount(block))
    )
  }

  // ---- 稳定性判定：流式标记 + 800ms 文本不变 + 活动回合尾块跳过 ----
  /** 每块只留一个稳定窗 timer；重新调度/清理时先把旧的 clear 掉。 */
  function clearBlockTimers() {
    state.timerIds.forEach(function (id) {
      window.clearTimeout(id)
    })
    state.timerIds.clear()
    state.blockTimers = new WeakMap()
  }

  function armBlockTimer(block, delay, ctx) {
    const prev = state.blockTimers.get(block)
    if (prev) {
      window.clearTimeout(prev)
      state.timerIds.delete(prev)
    }
    const id = window.setTimeout(function () {
      state.timerIds.delete(id)
      state.blockTimers.delete(block)
      scheduleBlock(block, ctx)
    }, delay)
    state.blockTimers.set(block, id)
    state.timerIds.add(id)
  }

  function scheduleBlock(block, ctx) {
    if (!state.running || !isEnabled() || !state.words.size) return
    if (!block || !block.isConnected) return
    if (!isAllowedKind(kindOf(block))) return
    if (hasStreaming(block)) return
    // 回合仍在跑时，最后一块可能正在增长：先不标，等下一轮 mutation 重排。
    if (isActiveTail(block, ctx)) return
    const text = block.textContent || ''
    if (!text.length || text.length > CONFIG.BLOCK_TEXT_MAX) return
    const h = fingerprintOf(block)
    const done = state.doneHash.get(block)
    if (done && done === h) return
    const prev = state.stability.get(block)
    const now = Date.now()
    if (!prev || prev.h !== h) {
      state.stability.set(block, { h: h, at: now })
      armBlockTimer(block, CONFIG.STABLE_MS + 40, ctx)
      return
    }
    if (now - prev.at < CONFIG.STABLE_MS) {
      armBlockTimer(block, CONFIG.STABLE_MS, ctx)
      return
    }
    try {
      annotateBlock(block)
      // 指纹要在标注之后取：它包含本块 span 数，标注前算的指纹永远和下一轮对不上。
      state.doneHash.set(block, fingerprintOf(block))
      state.stability.delete(block)
    } catch (err) {
      // 静默降级：这一块标不了就标不了，不影响下一块。
    }
  }

  // ---- 扫描：把新块交给 IntersectionObserver（只处理可见块）----
  function ensureObserver() {
    if (state.io) return
    if (typeof IntersectionObserver !== 'function') return
    state.io = new IntersectionObserver(
      function (entries) {
        // 一个回调可能带多个可见块：运行指示器/最后一块整批只算一次。
        const ctx = { pageRunning: hasRunningIndicator(), tailBlock: null }
        if (ctx.pageRunning) ctx.tailBlock = findTailBlock()
        for (let i = 0; i < entries.length; i += 1) {
          const entry = entries[i]
          if (!entry.isIntersecting) continue
          const block = entry.target
          if (state.io) state.io.unobserve(block)
          state.observed.delete(block)
          scheduleBlock(block, ctx)
        }
      },
      { root: null, rootMargin: CONFIG.IO_ROOT_MARGIN, threshold: 0 },
    )
  }

  /**
   * 块是否（大致）在可视区内。
   * 只作为 IntersectionObserver 的兜底：页面在后台标签页时 IO 不给 isIntersecting，
   * 但布局仍然存在，用 rect 判断照样能标 —— 不影响"只处理可见块"的性能语义。
   */
  function inViewport(block) {
    try {
      const rect = block.getBoundingClientRect()
      const h = window.innerHeight || document.documentElement.clientHeight || 0
      return rect.width > 0 && rect.bottom > -400 && rect.top < h + 400
    } catch (err) {
      return false
    }
  }

  /**
   * 扫描并调度块。
   *
   * full === false：只处理 mutation 标脏的块（流式/重渲染期间每 250ms 一次的开销从
   * O(全部块) 降到 O(变化块)）；full 为 true 或省略：全量（启动、词表加载、可见性恢复、
   * 折叠切换、手动 refresh）。
   * 运行指示器与"最后一块"每轮只算一次，通过 ctx 下传（审查报告 A 批第 4 条）。
   */
  function scan(full) {
    if (!state.running || !isEnabled() || !state.words.size) return
    const roots = collectRoots()
    if (!roots.length) return
    ensureObserver()
    const dirtyOnly = full === false
    const ctx = { pageRunning: hasRunningIndicator(), tailBlock: null }
    if (ctx.pageRunning) ctx.tailBlock = findTailBlock()
    // 后台标签页里 IO 不会触发，直接按 rect 兜底。
    // 关键是：一旦不可见，就把 IO 断掉并清空 observed —— 否则在"页面可见时被 observe、
    // 随后标签页转到后台"的块永远等不到回调，会一直被当成"已在等 IO"而永远不标
    // （真实页面 0 标注的第二个根因）。
    const useIO = !!(state.io && document.visibilityState === 'visible')
    if (!useIO && state.io) {
      state.io.disconnect()
      state.io = null
    }
    if (!useIO) state.observed = new WeakSet()
    for (let i = 0; i < roots.length; i += 1) {
      const blocks = roots[i].querySelectorAll(CONFIG.BLOCK_SELECTOR)
      for (let j = 0; j < blocks.length; j += 1) {
        const block = blocks[j]
        if (!isAllowedKind(kindOf(block))) continue
        if (dirtyOnly && !state.dirty.has(block)) continue
        state.dirty.delete(block)
        // 已标过的块：内容/折叠状态/span 数没变就不再进 IO；变了就重标。
        const done = state.doneHash.get(block)
        if (done) {
          if (done === fingerprintOf(block)) continue
          state.doneHash.delete(block)
          scheduleBlock(block, ctx)
          continue
        }
        if (state.observed.has(block)) {
          // IO 还没回调；脏块直接进稳定窗，未脏的等 IO。
          if (dirtyOnly) scheduleBlock(block, ctx)
          continue
        }
        if (useIO) {
          state.observed.add(block)
          state.io.observe(block)
        } else if (inViewport(block)) {
          // 页面不可见：可见性用 rect 自己判。
          scheduleBlock(block, ctx)
        }
      }
    }
  }

  // ---- 词表加载 ----
  function fetchJson(url) {
    return new Promise(function (resolve, reject) {
      let done = false
      const timer = window.setTimeout(function () {
        if (done) return
        done = true
        reject(new Error('timeout'))
      }, CONFIG.WORDS_TIMEOUT_MS)
      try {
        window
          .fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('http ' + res.status)
            return res.json()
          })
          .then(function (json) {
            if (done) return
            done = true
            window.clearTimeout(timer)
            resolve(json)
          })
          .catch(function (err) {
            if (done) return
            done = true
            window.clearTimeout(timer)
            reject(err)
          })
      } catch (err) {
        if (done) return
        done = true
        window.clearTimeout(timer)
        reject(err)
      }
    })
  }

  /**
   * 采纳一份词表响应。
   *
   * 只有"明确成功"才允许改状态（审查报告 2026-11-04 第 3 节第 2 条）：
   *   - ok === false：服务端查询失败（瞬时 SQL 错误），必须返回 false 走重试；
   *     绝对不能当空词表处理 —— 那会 clearAnnotations() + detachObserver()，
   *     一次抖动就把整页标注清空 60s。
   *   - words 不是数组：同上。
   * 空数组合法是"服务端确认当前没有在学词"，仍然按空表走（清标注）。
   */
  function adoptWords(json) {
    if (!json || json.ok === false || !Array.isArray(json.words)) return false
    const list = json.words
    const next = new Map()
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i]
      if (!item || typeof item !== 'object') continue
      const w = String(item.w || '').toLowerCase()
      if (w.length < CONFIG.MIN_WORD_LEN || w.length > CONFIG.MAX_WORD_LEN) continue
      next.set(w, {
        t: String(item.t || ''),
        s: String(item.s || ''),
        c: Number(item.c) || 0,
      })
    }
    const rev = String((json && json.rev) || '')
    const total = Number(json.total)
    const changed = rev !== state.rev || next.size !== state.words.size
    state.words = next
    state.rev = rev
    state.total = Number.isFinite(total) && total >= 0 ? total : next.size
    state.truncated = !!json.truncated
    state.fetchedAt = Date.now()
    state.fetchFailures = 0
    if (changed || next.size === 0) clearAnnotations()
    return true
  }

  function scheduleRetry(delay) {
    if (state.retryTimer) window.clearTimeout(state.retryTimer)
    state.retryTimer = window.setTimeout(function () {
      state.retryTimer = 0
      loadWords(false)
    }, delay)
  }

  function loadWords(force) {
    if (!state.running) return
    if (state.loading) return
    if (!force && state.fetchedAt && Date.now() - state.fetchedAt < CONFIG.WORDS_TTL_MS) return
    state.loading = true
    let idx = 0
    function attempt() {
      if (idx >= CONFIG.WORDS_PATHS.length) throw new Error('all paths failed')
      const url = CONFIG.WORDS_PATHS[idx]
      idx += 1
      return fetchJson(url)
        .then(function (json) {
          if (!adoptWords(json)) throw new Error('bad payload')
          return true
        })
        .catch(function () {
          return attempt()
        })
    }
    attempt()
      .then(function () {
        state.loading = false
        if (!state.words.size) {
          // 目标词集合为空：立刻撤掉已有标注、停止观察 DOM，60s 后再看一眼。
          // 只 clear 不 detach 的话，旧标注会留在页面上（Lead 实测抓到的 bug）。
          clearAnnotations()
          detachObserver()
          scheduleRetry(60000)
          return
        }
        attachObserver()
        scan(true)
      })
      .catch(function () {
        state.loading = false
        state.fetchFailures += 1
        const delay = Math.min(
          CONFIG.WORDS_RETRY_MAX_MS,
          CONFIG.WORDS_RETRY_BASE_MS * Math.pow(2, state.fetchFailures - 1),
        )
        scheduleRetry(delay)
      })
  }

  // ---- 悬停卡 ----
  function ensureCard() {
    if (state.cardEl) return state.cardEl
    const card = document.createElement('div')
    card.className = 'dwlac'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', '生词小卡')
    card.innerHTML =
      '<div class="dwlac-head"><span class="dwlac-w"></span><span class="dwlac-tag">在学</span></div>' +
      '<div class="dwlac-s"></div>' +
      '<div class="dwlac-row"><button type="button" class="dwlac-btn">收进复习</button>' +
      '<span class="dwlac-hint"></span></div>'
    card.addEventListener('mouseenter', function () {
      if (state.hideTimer) {
        window.clearTimeout(state.hideTimer)
        state.hideTimer = 0
      }
    })
    card.addEventListener('mouseleave', function () {
      hideSoon()
    })
    const btn = card.querySelector('.dwlac-btn')
    btn.addEventListener('click', function () {
      onCapture(btn)
    })
    ;(document.body || document.documentElement).appendChild(card)
    state.cardEl = card
    return card
  }

  function hideSoon() {
    if (state.hideTimer) window.clearTimeout(state.hideTimer)
    state.hideTimer = window.setTimeout(function () {
      hideCard(false)
    }, 200)
  }

  function hideCard(immediate) {
    if (state.hideTimer) {
      window.clearTimeout(state.hideTimer)
      state.hideTimer = 0
    }
    if (state.showTimer) {
      window.clearTimeout(state.showTimer)
      state.showTimer = 0
    }
    if (!immediate) {
      if (state.cardEl) state.cardEl.setAttribute('data-open', '0')
      state.cardSpan = null
      state.cardInfo = null
      return
    }
    if (state.cardEl) {
      const b = state.cardEl.parentNode
      if (b) b.removeChild(state.cardEl)
    }
    state.cardEl = null
    state.cardSpan = null
    state.cardInfo = null
  }

  /**
   * 把卡片放到 span 下方/上方。
   *
   * 开销控制（审查报告 A 批第 8 条）：
   * - 宽高在 showCard 里量一次并缓存（内容只有 showCard 会改），滚动时只读 span 的 rect；
   * - 用 transform 写入，避免 left/top 触发重排；
   * - 滚动/缩放统一走 onScroll 的 rAF 合并，一帧最多一次。
   */
  function positionCard(span) {
    const card = state.cardEl
    if (!card) return
    const rect = span.getBoundingClientRect()
    const vw = window.innerWidth || document.documentElement.clientWidth || 0
    const vh = window.innerHeight || document.documentElement.clientHeight || 0
    const cw = state.cardRect.w || 240
    const ch = state.cardRect.h || 90
    let left = rect.left
    if (left + cw > vw - 8) left = Math.max(8, vw - cw - 8)
    if (left < 8) left = 8
    let top = rect.bottom + 8
    if (top + ch > vh - 8) top = Math.max(8, rect.top - ch - 8)
    card.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)'
  }

  function showCard(span, force) {
    const word = span.getAttribute('data-w') || ''
    if (!word) return
    const info = state.words.get(word) || { t: '', s: '', c: 0 }
    const card = ensureCard()
    if (state.cardSpan === span && card.getAttribute('data-open') === '1') return
    if (state.hideTimer) {
      window.clearTimeout(state.hideTimer)
      state.hideTimer = 0
    }
    const sense = info.s || info.t
    card.querySelector('.dwlac-w').textContent = word
    card.querySelector('.dwlac-tag').textContent = info.s ? '最近义项' : info.t ? '首义' : '在学'
    card.querySelector('.dwlac-s').textContent = sense || '（暂无义项）'
    const btn = card.querySelector('.dwlac-btn')
    btn.textContent = '收进复习'
    btn.disabled = false
    btn.setAttribute('data-done', '0')
    card.querySelector('.dwlac-hint').textContent = ''
    card.setAttribute('data-open', '1')
    state.cardSpan = span
    state.cardInfo = { word: word, sentence: '', info: info }
    // 内容定了再量一次尺寸（此时 display:block 才能量到真实宽高）。
    state.cardRect.w = card.offsetWidth || 0
    state.cardRect.h = card.offsetHeight || 0
    positionCard(span)
    if (force) {
      try {
        btn.focus({ preventScroll: true })
      } catch (err) {
        /* 老浏览器没有 focus options */
      }
    }
  }

  /** 取 span 所在的那句话（用于入库的 context）。 */
  function sentenceFor(span) {
    try {
      const prose = span.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,dd,dt')
      let container = prose
      if (!container) {
        const block = blockOf(span)
        container = block || span.parentElement
      }
      if (!container) return ''
      const text = container.textContent || ''
      const range = document.createRange()
      range.setStart(container, 0)
      range.setEndBefore(span)
      const offset = range.toString().length
      const word = span.textContent || ''
      return sentenceAround(text, offset, offset + word.length)
    } catch (err) {
      return ''
    }
  }

  function onCapture(btn) {
    if (!state.cardInfo) return
    const word = state.cardInfo.word
    const sentence = sentenceFor(state.cardSpan)
    btn.disabled = true
    btn.textContent = '收进中…'
    const hint = state.cardEl ? state.cardEl.querySelector('.dwlac-hint') : null
    if (hint) hint.textContent = ''
    try {
      // 6s 超时：宿主/服务端卡住时按钮不能永远停在"收进中…"（审查报告 A 批第 8 条）。
      const opts = {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ word: word, sentence: sentence, save: true, enrich: false }),
      }
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        opts.signal = AbortSignal.timeout(6000)
      }
      window
        .fetch(CONFIG.CAPTURE_PATH, opts)
        .then(function (res) {
          return res.json()
        })
        .then(function (json) {
          if (json && json.ok) {
            btn.setAttribute('data-done', '1')
            btn.textContent = '已收进复习'
            if (hint) hint.textContent = '把这句话记进语境'
          } else {
            btn.disabled = false
            btn.textContent = '重试'
            if (hint) hint.textContent = '没成功，稍后再试'
          }
        })
        .catch(function () {
          btn.disabled = false
          btn.textContent = '重试'
          if (hint) hint.textContent = '网络不通'
        })
    } catch (err) {
      btn.disabled = false
      btn.textContent = '重试'
    }
  }

  // ---- 事件：委托到 document，避免给每个 span 加监听（性能）----
  function onMouseOver(event) {
    const target = event.target
    if (!target || target.nodeType !== 1) return
    const span = target.closest ? target.closest('.dwl-anno') : null
    if (!span) return
    if (state.showTimer) window.clearTimeout(state.showTimer)
    state.showTimer = window.setTimeout(function () {
      state.showTimer = 0
      showCard(span, false)
    }, 90)
  }

  function onMouseOut(event) {
    const target = event.target
    if (!target || target.nodeType !== 1) return
    const span = target.closest ? target.closest('.dwl-anno') : null
    if (!span) return
    const related = event.relatedTarget
    if (related && state.cardEl && state.cardEl.contains(related)) return
    hideSoon()
  }

  function onFocusIn(event) {
    const target = event.target
    if (!target || target.nodeType !== 1) return
    const span = target.closest ? target.closest('.dwl-anno') : null
    if (span) showCard(span, false)
  }

  function onFocusOut(event) {
    const target = event.target
    if (!target || target.nodeType !== 1) return
    const span = target.closest ? target.closest('.dwl-anno') : null
    if (!span) return
    const related = event.relatedTarget
    if (related && state.cardEl && state.cardEl.contains(related)) return
    hideSoon()
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      hideCard(false)
      return
    }
    const target = event.target
    if (!target || target.nodeType !== 1) return
    const span = target.closest ? target.closest('.dwl-anno') : null
    if (!span) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      showCard(span, true)
    }
  }

  /**
   * 滚动/缩放时跟随卡片。
   *
   * 用 rAF 合并：一次滚动可能派发几十个 scroll 事件，旧实现每个事件都读 span rect
   * 再写卡片 left/top，滚动期间持续强制布局（审查报告 A 批第 8 条）。
   */
  function onScroll() {
    if (state.scrollRaf) return
    state.scrollRaf = window.requestAnimationFrame(function () {
      state.scrollRaf = 0
      if (state.cardSpan && state.cardEl && state.cardEl.getAttribute('data-open') === '1') {
        positionCard(state.cardSpan)
      }
    })
  }

  // ---- 观察器 ----
  /**
   * 折叠/展开后立即重标一个块。
   *
   * 为什么不走 800ms 稳定性窗口：展开是用户主动操作，内容已确定，
   * 等 800ms 会变成"点开半秒后下划线才慢慢冒出来"。这里直接重算，
   * 只对"用户刚操作的块"生效，不会破坏流式保护。
   */
  function restateBlock(target) {
    const block = blockOf(target)
    if (!block || !isAllowedKind(kindOf(block))) return
    window.setTimeout(function () {
      if (!state.running || !state.words.size) return
      if (hasStreaming(block) || isActiveTail(block)) return
      state.doneHash.delete(block)
      state.stability.delete(block)
      try {
        annotateBlock(block)
        state.doneHash.set(block, fingerprintOf(block))
      } catch (err) {
        /* 静默 */
      }
    }, 30)
  }

  function onToggle(event) {
    const target = event.target
    if (target && target.nodeType === 1 && target.tagName === 'DETAILS') restateBlock(target)
  }

  function onExpandClick(event) {
    const target = event.target
    if (!target || target.nodeType !== 1 || !target.closest) return
    const trigger = target.closest('[aria-expanded]')
    if (trigger) restateBlock(trigger)
  }

  // 有变化的块进 dirty 集合，flush 时只重算这些块（审查报告 A 批第 3 条）。
  // 运行指示器/aria-busy 变化时没有具体块可标脏，置 fullScanNeeded 让下一轮全量扫。
  let fullScanNeeded = false

  function markDirty(node) {
    if (!node) return false
    if (node.nodeType === 3) {
      const tb = blockOf(node.parentElement)
      if (tb) {
        state.dirty.add(tb)
        return true
      }
      return false
    }
    if (node.nodeType !== 1) return false
    // 自己产物的内部变化一律忽略（span 内的文本、悬停卡）。
    if (node.closest && (node.closest('.dwl-anno') || node.closest('.dwlac'))) return false
    let marked = false
    const b = blockOf(node)
    if (b) {
      state.dirty.add(b)
      marked = true
    }
    if (node.querySelectorAll) {
      const inner = node.querySelectorAll(CONFIG.BLOCK_SELECTOR)
      for (let k = 0; k < inner.length; k += 1) {
        const ib = blockOf(inner[k])
        if (ib) {
          state.dirty.add(ib)
          marked = true
        }
      }
    }
    return marked
  }

  function onMutations() {
    if (state.flushTimer) return
    state.flushTimer = window.setTimeout(function () {
      state.flushTimer = 0
      const full = fullScanNeeded
      fullScanNeeded = false
      // full 为 true 时全量扫，否则只重算脏块。
      scan(full)
    }, CONFIG.DEBOUNCE_MS)
  }

  function attachObserver() {
    if (state.observer || typeof MutationObserver !== 'function') return
    state.observer = new MutationObserver(function (records) {
      // 只在 DSH 对话区有变化时才重扫；其它页面（侧栏/学习页）不触发。
      let relevant = false
      for (let i = 0; i < records.length; i += 1) {
        const rec = records[i]
        if (rec.type === 'attributes') {
          const attr = rec.attributeName || ''
          if (attr === 'data-chat-running' || attr === 'aria-busy') fullScanNeeded = true
          if (markDirty(rec.target)) relevant = true
          continue
        }
        if (markDirty(rec.target)) relevant = true
        const added = rec.addedNodes || []
        for (let j = 0; j < added.length; j += 1) {
          if (markDirty(added[j])) relevant = true
        }
      }
      if (relevant || fullScanNeeded) onMutations()
    })
    const target = document.body || document.documentElement
    // attributes 必须观察：<details open> / data-expanded / hidden / aria-expanded 的切换
    // 不会产生 childList 变化（内容本来就在 DOM），只靠 childList 会漏掉"展开后补标"。
    // data-chat-running 也要观察：回合结束时只摘指示器、不改文本，否则尾块可能长期不标。
    state.observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'open',
        'data-expanded',
        'hidden',
        'aria-expanded',
        'data-streaming',
        'data-chat-running',
        'aria-busy',
      ],
    })
  }

  function detachObserver() {
    if (state.observer) {
      state.observer.disconnect()
      state.observer = null
    }
    if (state.io) {
      state.io.disconnect()
      state.io = null
    }
    state.observed = new WeakSet()
  }

  // ---- 启停 ----
  function start() {
    if (state.running) return
    state.running = true
    state.started = true
    ensureStyles()
    attachObserver()
    document.addEventListener('mouseover', onMouseOver, true)
    document.addEventListener('mouseout', onMouseOut, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('toggle', onToggle, true)
    document.addEventListener('click', onExpandClick, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll, true)
    loadWords(true)
    scan(true)
  }

  function stop() {
    if (!state.running) return
    state.running = false
    detachObserver()
    document.removeEventListener('mouseover', onMouseOver, true)
    document.removeEventListener('mouseout', onMouseOut, true)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('focusout', onFocusOut, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('toggle', onToggle, true)
    document.removeEventListener('click', onExpandClick, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', onScroll, true)
    if (state.retryTimer) {
      window.clearTimeout(state.retryTimer)
      state.retryTimer = 0
    }
    if (state.flushTimer) {
      window.clearTimeout(state.flushTimer)
      state.flushTimer = 0
    }
    if (state.scrollRaf) {
      window.cancelAnimationFrame(state.scrollRaf)
      state.scrollRaf = 0
    }
    clearBlockTimers()
    state.dirty = new WeakSet()
    clearAnnotations()
  }

  function enable() {
    try {
      window.localStorage.removeItem(CONFIG.STORAGE_KEY)
    } catch (err) {
      /* ignore */
    }
    start()
  }

  function disable() {
    try {
      window.localStorage.setItem(CONFIG.STORAGE_KEY, CONFIG.STORAGE_OFF)
    } catch (err) {
      /* ignore */
    }
    stop()
  }

  function refresh() {
    state.fetchedAt = 0
    if (!state.running) start()
    else loadWords(true)
  }

  // 其它标签页/宿主面板切换开关时同步
  function onStorage(event) {
    if (!event || event.key !== CONFIG.STORAGE_KEY) return
    if (isEnabled()) start()
    else stop()
  }

  // 页面长时间在后台再回来：词表可能过期
  function onVisibility() {
    if (document.visibilityState !== 'visible') {
      // 后台标签页 IO 不触发：断开并清 observed，回到可见时再重建，
      // 避免"可见时 observe、转后台后永远等不到回调"的块永久卡住。
      if (state.io) {
        state.io.disconnect()
        state.io = null
      }
      state.observed = new WeakSet()
      return
    }
    if (!state.running) return
    if (Date.now() - state.fetchedAt > CONFIG.WORDS_TTL_MS) loadWords(true)
    else scan(true)
  }

  window.addEventListener('storage', onStorage)
  document.addEventListener('visibilitychange', onVisibility)

  // 对外开关事件（宿主/控制台/未来设置页都可以用）
  window.addEventListener('dwl-annotate:toggle', function (event) {
    const detail = event && event.detail
    if (detail && detail.enabled === false) disable()
    else enable()
  })

  // 启动
  if (isEnabled()) start()

  // 供测试/控制台调试
  api._mergeConfig = mergeConfig
})()
