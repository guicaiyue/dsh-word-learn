// voice.js —— P3 前端发音层：只用浏览器自带 speechSynthesis，零网络。
//
// 为什么不用服务端 TTS（用户原话 + 工程取舍）：
//   - 用户明确要求"不需要有道 API，只用微软/浏览器自带的免费前端语音"；
//   - Windows / Edge / Chrome 上的 Microsoft 音色是系统本地合成：免费、离线、无延迟；
//   - 服务端 TTS 要网络 + 密钥 + 磁盘缓存 + 路由，收益只是"跨浏览器音色一致"，
//     对个人学习工具不值，所以整套服务端 TTS 要删掉。
//
// 关于"缓存"（诚实说明，不骗自己）：
//   浏览器**不允许**把 speechSynthesis 的输出录成音频（没有公开 API 拿到音频流），
//   所以这里不可能缓存音频。能持久化的只有：
//     1) 音色偏好：localStorage['dwl-voice-pref:us' | 'dwl-voice-pref:uk']；
//     2) 朗读参数：localStorage['dwl-voice-rate' | 'dwl-voice-pitch']。
//   每次发音都由系统语音引擎在本地实时合成，**这个文件不发任何网络请求**。
//
// 踩过的浏览器坑（实现里都有对策）：
//   - getVoices() 首次常返回空数组 → 等 voiceschanged（最多 2s），等不到就继续；
//   - Chromium 在 cancel() 紧接 speak() 时可能既没有 onend 也没有 onerror →
//     watchdog 超时 reject TIMEOUT（按文本长度估时，最短 1.5s）；
//   - 并发 speak：先停掉旧的，旧 Promise reject ABORTED；
//   - 长文本（例句/整段）> 240 字符按句切分依次朗读，任何一段失败整体 reject。
;(function () {
  'use strict'

  // 幂等：宿主可能重复注入。用只属于本脚本的标志，别蹭 __dshWordLearn 之类共用的。
  if (window.__dwlVoice) return

  const CONFIG = {
    VERSION: '1.0.0',
    PREF_PREFIX: 'dwl-voice-pref:',
    RATE_KEY: 'dwl-voice-rate',
    PITCH_KEY: 'dwl-voice-pitch',
    VOICES_TIMEOUT_MS: 2000,
    CHUNK_MAX: 240,
    WATCHDOG_MIN_MS: 1500,
    WATCHDOG_PER_CHAR_MS: 120,
    DEFAULT_ACCENT: 'us',
    // 音色优先级：本地/在线 natural 音色明显比旧 SAPI 好听，命中即用。
    NATURAL_HINTS: ['natural', 'online', 'aria', 'guy', 'sonia', 'jenny', 'google us english'],
  }

  const ACCENT_LANG = { us: 'en-us', uk: 'en-gb' }

  let synth = window.speechSynthesis || null
  let UtteranceCtor = window.SpeechSynthesisUtterance || null
  // 当前正在朗读的 token（并发 speak 用它判断"自己是否已被取代"）。
  let current = null
  let seq = 0

  function fail(code, message) {
    const err = new Error(message || code)
    err.code = code
    return err
  }

  // ---- localStorage（隐私模式下可能抛错：全部静默降级）----
  function safeGet(key) {
    try {
      return window.localStorage ? window.localStorage.getItem(key) : null
    } catch (err) {
      return null
    }
  }
  function safeSet(key, value) {
    try {
      if (window.localStorage) window.localStorage.setItem(key, value)
    } catch (err) {
      /* 忽略：偏好存不下不影响发音 */
    }
  }

  // 2026-11-05：发音从"服务端 mp3 缓存"切成"本机 speechSynthesis"，口音偏好键
  // 从 dwl-tts-accent 改名为 dwl-voice-accent。这里做一次性迁移，别让老用户的
  // 美音/英音选择被重置成默认值（只在原地改键，值只有 us/uk 两种）。
  ;(function migrateAccentKey() {
    try {
      if (safeGet('dwl-voice-accent')) return
      const old = safeGet('dwl-tts-accent')
      if (old === 'us' || old === 'uk') {
        safeSet('dwl-voice-accent', old)
        window.localStorage.removeItem('dwl-tts-accent')
      }
    } catch (err) {
      /* 忽略 */
    }
  })()

  function supported() {
    return !!synth && typeof UtteranceCtor === 'function'
  }

  function getVoices() {
    if (!synth) return []
    try {
      const list = synth.getVoices ? synth.getVoices() : []
      return list && typeof list.length === 'number' ? Array.prototype.slice.call(list) : []
    } catch (err) {
      return []
    }
  }

  function langOf(voice) {
    return String((voice && voice.lang) || '').toLowerCase()
  }

  function isEnglish(voice) {
    return langOf(voice).indexOf('en') === 0
  }

  function isNatural(name) {
    const lower = String(name || '').toLowerCase()
    for (let i = 0; i < CONFIG.NATURAL_HINTS.length; i += 1) {
      if (lower.indexOf(CONFIG.NATURAL_HINTS[i]) >= 0) return true
    }
    return false
  }

  function accentPool(accent) {
    const voices = getVoices()
    const want = ACCENT_LANG[accent === 'uk' ? 'uk' : 'us']
    let pool = voices.filter((voice) => langOf(voice).indexOf(want) === 0)
    if (!pool.length) pool = voices.filter(isEnglish)
    return pool
  }

  /**
   * 选音色：localStorage 里的偏好 > natural 音色 > 池里第一个。
   * 一个英文音色都没有时返回 null（调用方 reject NO_VOICE）。
   */
  function pickVoice(accent) {
    const key = accent === 'uk' ? 'uk' : 'us'
    const pool = accentPool(key)
    if (!pool.length) return null
    const savedName = safeGet(CONFIG.PREF_PREFIX + key)
    let picked = null
    if (savedName) {
      picked = pool.filter((voice) => voice.name === savedName)[0] || null
    }
    if (!picked) picked = pool.filter((voice) => isNatural(voice.name))[0] || null
    if (!picked) picked = pool[0]
    // 把最终选择写回 localStorage：这就是本文件唯一能做的"缓存"（偏好，不是音频）。
    if (picked && picked.name && picked.name !== savedName)
      safeSet(CONFIG.PREF_PREFIX + key, picked.name)
    return picked
  }

  function addVoicesListener(handler) {
    if (!synth) return function () {}
    if (typeof synth.addEventListener === 'function') {
      try {
        synth.addEventListener('voiceschanged', handler)
        return function () {
          try {
            synth.removeEventListener('voiceschanged', handler)
          } catch (err) {
            /* 忽略 */
          }
        }
      } catch (err) {
        /* 落到 onvoiceschanged */
      }
    }
    const prev = synth.onvoiceschanged
    synth.onvoiceschanged = handler
    return function () {
      try {
        synth.onvoiceschanged = prev || null
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  /**
   * 等音色就绪（最多 2s）。返回音色数；等不到就返回当前值（可能是 0），不 reject。
   * 首次 getVoices() 为空是常态，不是错误。
   */
  function ensureVoices() {
    return new Promise((resolve) => {
      const first = getVoices()
      if (first.length) {
        resolve(first.length)
        return
      }
      let done = false
      let timer = 0
      let removeListener = function () {}
      const finish = function () {
        if (done) return
        done = true
        if (timer) window.clearTimeout(timer)
        removeListener()
        resolve(getVoices().length)
      }
      const onChanged = function () {
        if (getVoices().length) finish()
      }
      removeListener = addVoicesListener(onChanged)
      timer = window.setTimeout(finish, CONFIG.VOICES_TIMEOUT_MS)
    })
  }

  /** preload：预热音色列表，返回 {voices:number}（不抛错）。 */
  function preload() {
    return ensureVoices().then(function (count) {
      return { voices: count }
    })
  }

  function rateOf(value) {
    if (value === undefined || value === null || value === '')
      return readNum(CONFIG.RATE_KEY, 1, 0.1, 10)
    const n = clampNum(Number(value), 0.1, 10, 1)
    safeSet(CONFIG.RATE_KEY, String(n))
    return n
  }

  function pitchOf(value) {
    if (value === undefined || value === null || value === '')
      return readNum(CONFIG.PITCH_KEY, 1, 0, 2)
    const n = clampNum(Number(value), 0, 2, 1)
    safeSet(CONFIG.PITCH_KEY, String(n))
    return n
  }

  function clampNum(n, min, max, fallback) {
    if (!Number.isFinite(n)) return fallback
    return Math.min(Math.max(n, min), max)
  }

  function readNum(key, fallback, min, max) {
    const raw = safeGet(key)
    // 没存过（null）/空串用默认值；存过才 Number 再 clamp。
    // （Number(null) 是 0，直接 clamp 会把缺省的 rate 变成 0.1、pitch 变成 0。）
    if (raw === null || raw === '') return fallback
    return clampNum(Number(raw), min, max, fallback)
  }

  /** 长文本按句切分；单片超过 240 字符时按空格硬切。 */
  function splitText(text) {
    const full = String(text || '')
    if (full.length <= CONFIG.CHUNK_MAX) return full ? [full] : []
    const sentences = []
    let buf = ''
    for (let i = 0; i < full.length; i += 1) {
      const ch = full.charAt(i)
      buf += ch
      if (ch === '\n') {
        sentences.push(buf.trim())
        buf = ''
      } else if (ch === '.' || ch === '!' || ch === '?' || ch === ';') {
        const next = i + 1 < full.length ? full.charAt(i + 1) : ' '
        if (next === ' ' || next === '\n') {
          sentences.push(buf.trim())
          buf = ''
        }
      }
    }
    if (buf.trim()) sentences.push(buf.trim())
    const chunks = []
    let cur = ''
    for (let i = 0; i < sentences.length; i += 1) {
      let sentence = sentences[i]
      while (sentence.length > CONFIG.CHUNK_MAX) {
        let cut = sentence.lastIndexOf(' ', CONFIG.CHUNK_MAX)
        if (cut <= 0) cut = CONFIG.CHUNK_MAX
        chunks.push(sentence.slice(0, cut).trim())
        sentence = sentence.slice(cut).trim()
      }
      if (!sentence) continue
      if (!cur) cur = sentence
      else if (cur.length + 1 + sentence.length <= CONFIG.CHUNK_MAX) cur += ' ' + sentence
      else {
        chunks.push(cur)
        cur = sentence
      }
    }
    if (cur) chunks.push(cur)
    return chunks.length ? chunks : [full]
  }

  function humanError(event) {
    const code = String((event && event.error) || '').toLowerCase()
    if (code === 'not-allowed') return '浏览器拦下了发音，先点一下页面再试'
    if (code === 'interrupted') return '发音被打断了，再点一次'
    if (code === 'audio-busy') return '音频设备忙，稍后再试'
    if (code === 'network') return '系统语音需要联网，检查网络或换本地音色'
    if (code === 'synthesis-failed' || code === 'synthesis-unavailable')
      return '系统语音合成失败，检查系统语音包'
    if (code === 'language-unavailable' || code === 'voice-unavailable')
      return '系统没有这个语言/音色的语音包'
    return '系统语音出错，再试一次'
  }

  function errorCode(event) {
    const raw = String((event && event.error) || 'synthesis-failed').toUpperCase()
    return raw.replace(/-/g, '_')
  }

  function clearTimer(token) {
    if (token.timer) {
      window.clearTimeout(token.timer)
      token.timer = 0
    }
  }

  /** 打断当前朗读：旧 Promise reject ABORTED，并尽量 cancel 引擎。 */
  function abortCurrent(err) {
    const token = current
    if (!token) return
    current = null
    clearTimer(token)
    if (token.detach) token.detach()
    if (typeof token.reject === 'function') token.reject(err || fail('ABORTED', '已取消'))
  }

  function stop() {
    try {
      if (synth && typeof synth.cancel === 'function') synth.cancel()
    } catch (err) {
      /* 忽略：cancel 在部分浏览器会抛 */
    }
    abortCurrent(fail('ABORTED', '已停止朗读'))
  }

  function speak(text, opts) {
    const options = opts || {}
    return new Promise((resolve, reject) => {
      if (!supported()) {
        reject(fail('UNSUPPORTED', '这个浏览器没有 speechSynthesis，无法朗读'))
        return
      }
      const full = String(text === undefined || text === null ? '' : text).trim()
      if (!full) {
        reject(fail('EMPTY_TEXT', '没有可朗读的文本'))
        return
      }
      if (options.signal && options.signal.aborted) {
        reject(fail('ABORTED', '已取消'))
        return
      }
      // 并发：新的朗读先打断旧的，旧 Promise 收 ABORTED。
      abortCurrent(fail('ABORTED', '被新的朗读请求打断'))

      const id = seq + 1
      seq = id
      const token = { id, reject, timer: 0, detach: null, utter: null }
      current = token

      const accented = options.accent === 'uk' ? 'uk' : CONFIG.DEFAULT_ACCENT
      const rate = rateOf(options.rate)
      const pitch = pitchOf(options.pitch)

      function finish(err) {
        if (current !== token) return
        current = null
        clearTimer(token)
        if (token.detach) token.detach()
        if (err) reject(err)
        else resolve()
      }

      if (options.signal && typeof options.signal.addEventListener === 'function') {
        const onAbort = function () {
          abortCurrent(fail('ABORTED', '已取消'))
        }
        options.signal.addEventListener('abort', onAbort)
        token.detach = function () {
          try {
            options.signal.removeEventListener('abort', onAbort)
          } catch (err) {
            /* 忽略 */
          }
        }
      }

      ensureVoices().then(function () {
        if (current !== token) return
        const voice = pickVoice(accented)
        if (!voice) {
          finish(
            fail(
              'NO_VOICE',
              '浏览器没有可用的英文音色，检查系统语音包（设置 → 时间和语言 → 语音）',
            ),
          )
          return
        }
        const chunks = splitText(full)
        let index = 0

        function speakChunk(chunk) {
          let utter
          try {
            utter = new UtteranceCtor(chunk)
          } catch (err) {
            finish(fail('SYNTH_FAILED', '创建语音对象失败'))
            return
          }
          utter.lang = voice.lang || (accented === 'uk' ? 'en-GB' : 'en-US')
          try {
            utter.voice = voice
          } catch (err) {
            /* 某些实现只读：忽略 */
          }
          utter.rate = rate
          utter.pitch = pitch
          token.utter = utter
          utter.onstart = function () {
            armWatchdog(token, chunk.length, finish)
          }
          utter.onend = function () {
            if (current !== token) return
            clearTimer(token)
            next()
          }
          utter.onerror = function (event) {
            finish(fail(errorCode(event), humanError(event)))
          }
          // 立刻起表：Chromium 的 cancel()+speak() 可能连 onstart 都不触发。
          armWatchdog(token, chunk.length, finish)
          try {
            synth.speak(utter)
          } catch (err) {
            finish(fail('SYNTH_FAILED', '调用系统语音失败'))
          }
        }

        function next() {
          if (current !== token) return
          if (index >= chunks.length) {
            finish(null)
            return
          }
          const chunk = chunks[index]
          index += 1
          speakChunk(chunk)
        }

        next()
      })
    })
  }

  /** watchdog：按文本长度估时，超时 reject TIMEOUT（清除上一段的表）。 */
  function armWatchdog(token, textLength, finish) {
    clearTimer(token)
    const delay = Math.max(CONFIG.WATCHDOG_MIN_MS, textLength * CONFIG.WATCHDOG_PER_CHAR_MS)
    token.timer = window.setTimeout(function () {
      token.timer = 0
      finish(fail('TIMEOUT', '系统语音没有响应，再点一次试试'))
    }, delay)
  }

  function info() {
    const voices = getVoices()
    const chosen = { us: null, uk: null }
    if (voices.length) {
      const us = pickVoice('us')
      const uk = pickVoice('uk')
      chosen.us = us ? us.name : null
      chosen.uk = uk ? uk.name : null
    }
    return { supported: supported(), voices: voices.length, chosen, engine: 'speechSynthesis' }
  }

  /** 测试钩子：注入假的 speechSynthesis（可选同时注入 Utterance 构造器）。 */
  function setSynth(fake, ctor) {
    stop()
    synth = fake || null
    if (typeof ctor === 'function') UtteranceCtor = ctor
  }

  window.__dwlVoice = {
    version: CONFIG.VERSION,
    preload,
    info,
    speak,
    stop,
    __setSynth: setSynth,
  }
})()
