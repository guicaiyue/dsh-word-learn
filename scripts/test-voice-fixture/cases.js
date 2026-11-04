// cases.js —— voice.js 的行为用例集（同一份代码在两种环境跑）。
//
//   - node：scripts/test-voice.mjs 用 vm 造一个假 window（localStorage + 假
//     speechSynthesis + 假 SpeechSynthesisUtterance），加载 assets/voice.js 后
//     再加载本文件，然后调用 window.__voiceCaseDefs.run()。
//   - 浏览器：scripts/test-voice-fixture/index.html 依次加载 voice.js 和本文件，
//     测试脚本 evaluate window.runVoiceTests()。
//
// 所有用例都通过 __setSynth 注入假 synth，**不依赖真实音色**，所以结果确定。
// 返回 [{name, ok, detail}]；失败时 detail 是一句人话的失败原因。
;(function (global) {
  'use strict'

  // ---- 假音色 ----
  const EN_US_PLAIN = {
    name: 'Microsoft David - English (United States)',
    lang: 'en-US',
    localService: true,
    voiceURI: 'david',
  }
  const EN_US_NATURAL = {
    name: 'Microsoft Aria Online (Natural) - English (United States)',
    lang: 'en-US',
    localService: false,
    voiceURI: 'aria',
  }
  const EN_GB_PLAIN = {
    name: 'Microsoft Hazel - English (Great Britain)',
    lang: 'en-GB',
    localService: true,
    voiceURI: 'hazel',
  }
  const EN_GB_NATURAL = {
    name: 'Microsoft Sonia Online (Natural) - English (Great Britain)',
    lang: 'en-GB',
    localService: false,
    voiceURI: 'sonia',
  }
  const ZH_CN = { name: 'Microsoft Huihui - Chinese (Simplified)', lang: 'zh-CN' }
  const ZH_TW = { name: 'Microsoft Hanhan - Chinese (Traditional)', lang: 'zh-TW' }

  /**
   * 可编程假 synth。mode:
   *   auto   —— speak 后异步触发 onstart → onend（默认）
   *   error  —— speak 后触发 onerror（errorCode 可配）
   *   silent —— 什么事件都不触发（用来测 watchdog）
   *   manual —— 只记录，不触发任何事件；用例自己调 __endAll()
   */
  function makeSynth(options) {
    const opts = options || {}
    const state = {
      voices: (opts.voices || []).slice(),
      speakCalls: [],
      cancelCalls: 0,
      listeners: [],
      mode: opts.mode || 'auto',
      errorCode: opts.errorCode || 'synthesis-failed',
    }
    const synth = {
      getVoices: function () {
        return state.voices.slice()
      },
      speak: function (utter) {
        state.speakCalls.push(utter)
        if (state.mode === 'silent' || state.mode === 'manual') return
        if (state.mode === 'error') {
          global.setTimeout(function () {
            if (utter.onerror) utter.onerror({ error: state.errorCode })
          }, 0)
          return
        }
        global.setTimeout(function () {
          if (utter.onstart) utter.onstart()
          global.setTimeout(function () {
            if (utter.onend) utter.onend()
          }, 0)
        }, 0)
      },
      cancel: function () {
        state.cancelCalls += 1
      },
      addEventListener: function (type, fn) {
        if (type === 'voiceschanged') state.listeners.push(fn)
      },
      removeEventListener: function (type, fn) {
        const i = state.listeners.indexOf(fn)
        if (i >= 0) state.listeners.splice(i, 1)
      },
    }
    synth.__state = state
    synth.__addVoices = function (list) {
      state.voices = list.slice()
      state.listeners.slice().forEach(function (fn) {
        fn()
      })
    }
    synth.__endAll = function () {
      state.speakCalls.forEach(function (utter) {
        if (utter.__ended) return
        utter.__ended = true
        if (utter.onend) utter.onend()
      })
    }
    return synth
  }

  function makeStorage() {
    const map = new Map()
    return {
      getItem: function (key) {
        return map.has(key) ? map.get(key) : null
      },
      setItem: function (key, value) {
        map.set(key, String(value))
      },
      removeItem: function (key) {
        map.delete(key)
      },
      clear: function () {
        map.clear()
      },
      key: function (i) {
        return Array.from(map.keys())[i] || null
      },
      get length() {
        return map.size
      },
    }
  }

  /**
   * 假 utterance 构造器。
   *
   * 为什么不用真实 SpeechSynthesisUtterance：真实 Chromium 的 utter.voice 是
   * SpeechSynthesisVoice 实例字段，塞普通对象进去会被忽略（读回来是 null），
   * 断言就没法验证"选了哪个音色"。这里通过 __setSynth(fake, FakeUtter) 把
   * 构造器也换掉，属性就是普通字段，node / 浏览器行为一致。
   */
  function FakeUtter(text) {
    this.text = text
    this.lang = ''
    this.rate = 1
    this.pitch = 1
    this.voice = null
    this.onstart = null
    this.onend = null
    this.onerror = null
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      global.setTimeout(resolve, ms)
    })
  }

  function must(cond, msg) {
    if (!cond) throw new Error(msg)
  }

  function codeOf(err) {
    return String((err && err.code) || 'NO_CODE')
  }

  function rejectsCode(promise, code) {
    return promise.then(
      function () {
        return 'resolved'
      },
      function (err) {
        return codeOf(err) === code
          ? ''
          : 'code=' + codeOf(err) + ' (' + String(err && err.message) + ')'
      },
    )
  }

  async function run() {
    const api = global.__dwlVoice
    const out = []
    function record(name, ok, detail) {
      out.push({ name: name, ok: !!ok, detail: ok ? undefined : detail })
    }
    async function check(name, fn) {
      try {
        const detail = await fn()
        if (detail === undefined || detail === null || detail === true) record(name, true)
        else record(name, false, String(detail))
      } catch (err) {
        record(name, false, String((err && err.message) || err))
      }
    }
    function use(synth) {
      // 假 synth + 假 utterance 构造器一起注入：断言看到的就是普通字段。
      api.__setSynth(synth, FakeUtter)
    }
    function reset() {
      // 清掉上一用例的播放/偏好，保证每个用例从干净状态开始。
      api.stop()
      try {
        global.localStorage.clear()
      } catch (err) {
        /* 隐私模式：忽略 */
      }
      api.__setSynth(null, FakeUtter)
    }

    await check('API 形状：preload/info/speak/stop/__setSynth + version', async () => {
      reset()
      must(api && typeof api === 'object', 'window.__dwlVoice 缺失')
      const fns = ['preload', 'info', 'speak', 'stop', '__setSynth']
      for (let i = 0; i < fns.length; i += 1) {
        must(typeof api[fns[i]] === 'function', fns[i] + ' 不是函数')
      }
      must(typeof api.version === 'string' && api.version.length > 0, 'version 缺失')
    })

    await check('info()：注入假 synth 后 supported=true / engine=speechSynthesis', async () => {
      reset()
      const synth = makeSynth({ voices: [EN_US_PLAIN] })
      api.__setSynth(synth, FakeUtter)
      const info = api.info()
      must(info.supported === true, 'supported=' + info.supported)
      must(info.engine === 'speechSynthesis', 'engine=' + info.engine)
      must(info.voices === 1, 'voices=' + info.voices)
    })

    await check('音色优先级：natural 音色 > 池里第一个', async () => {
      reset()
      use(makeSynth({ voices: [EN_US_PLAIN, EN_US_NATURAL] }))
      const info = api.info()
      must(info.chosen.us === EN_US_NATURAL.name, 'chosen.us=' + info.chosen.us)
      must(
        global.localStorage.getItem('dwl-voice-pref:us') === EN_US_NATURAL.name,
        '偏好没有写进 localStorage',
      )
    })

    await check('localStorage 偏好优先于 natural（下次生效）', async () => {
      reset()
      try {
        global.localStorage.setItem('dwl-voice-pref:us', EN_US_PLAIN.name)
      } catch (err) {
        throw new Error('localStorage 不可用: ' + err.message)
      }
      use(makeSynth({ voices: [EN_US_PLAIN, EN_US_NATURAL] }))
      const info = api.info()
      must(info.chosen.us === EN_US_PLAIN.name, 'chosen.us=' + info.chosen.us)
    })

    await check('英式池：chosen.uk 取 en-GB 音色', async () => {
      reset()
      use(makeSynth({ voices: [EN_US_PLAIN, EN_GB_PLAIN, EN_GB_NATURAL] }))
      const info = api.info()
      must(info.chosen.uk === EN_GB_NATURAL.name, 'chosen.uk=' + info.chosen.uk)
    })

    await check('没有 en-GB 时 uk 回退到任意英文音色', async () => {
      reset()
      use(makeSynth({ voices: [EN_US_PLAIN] }))
      const info = api.info()
      must(info.chosen.uk === EN_US_PLAIN.name, 'chosen.uk=' + info.chosen.uk)
    })

    await check('只有中文音色时 chosen 为 null', async () => {
      reset()
      use(makeSynth({ voices: [ZH_CN, ZH_TW] }))
      const info = api.info()
      must(info.chosen.us === null, 'chosen.us=' + info.chosen.us)
      must(info.chosen.uk === null, 'chosen.uk=' + info.chosen.uk)
    })

    await check('没有英文音色：speak reject NO_VOICE 且提示人话', async () => {
      reset()
      use(makeSynth({ voices: [ZH_CN] }))
      let err = null
      try {
        await api.speak('charge')
      } catch (e) {
        err = e
      }
      must(err, '居然 resolve 了')
      must(codeOf(err) === 'NO_VOICE', 'code=' + codeOf(err))
      must(/音色/.test(String(err.message)), 'message 不是人话: ' + err.message)
    })

    await check('没有 speechSynthesis：speak reject UNSUPPORTED', async () => {
      reset()
      api.__setSynth(null, FakeUtter)
      must(api.info().supported === false, 'supported 应为 false')
      let err = null
      try {
        await api.speak('charge')
      } catch (e) {
        err = e
      }
      must(err && codeOf(err) === 'UNSUPPORTED', 'code=' + codeOf(err))
    })

    await check('空文本 reject EMPTY_TEXT 且不调 synth.speak', async () => {
      reset()
      const synth = makeSynth({ voices: [EN_US_NATURAL] })
      api.__setSynth(synth, FakeUtter)
      const r = await rejectsCode(api.speak('   '), 'EMPTY_TEXT')
      must(!r, r)
      must(synth.__state.speakCalls.length === 0, '不该调用 speak')
    })

    await check('正常朗读：onend 后 resolve，参数落到 utterance', async () => {
      reset()
      const synth = makeSynth({ voices: [EN_US_NATURAL] })
      api.__setSynth(synth, FakeUtter)
      await api.speak('charge')
      const utter = synth.__state.speakCalls[0]
      must(utter, '没有 speak 调用')
      must(utter.text === 'charge', 'text=' + utter.text)
      must(utter.lang === 'en-US', 'lang=' + utter.lang)
      must(utter.voice && utter.voice.name === EN_US_NATURAL.name, 'voice 不对')
      must(utter.rate === 1 && utter.pitch === 1, 'rate/pitch 默认不对')
    })

    await check('rate/pitch 持久化：下次不带参数沿用上次的值', async () => {
      reset()
      const synth = makeSynth({ voices: [EN_US_NATURAL] })
      api.__setSynth(synth, FakeUtter)
      await api.speak('one', { rate: 1.4, pitch: 1.2 })
      must(global.localStorage.getItem('dwl-voice-rate') === '1.4', 'rate 没持久化')
      must(global.localStorage.getItem('dwl-voice-pitch') === '1.2', 'pitch 没持久化')
      await api.speak('two')
      const utter = synth.__state.speakCalls[1]
      // 真实 Chromium 会把 rate 存成 float32（1.4 → 1.3999999…），比较给点容差。
      must(Math.abs(utter.rate - 1.4) < 0.01, 'rate=' + utter.rate)
      must(Math.abs(utter.pitch - 1.2) < 0.01, 'pitch=' + utter.pitch)
    })

    await check('英式发音：accent=uk 用 en-GB 音色', async () => {
      reset()
      const synth = makeSynth({ voices: [EN_US_PLAIN, EN_GB_NATURAL] })
      api.__setSynth(synth, FakeUtter)
      await api.speak('colour', { accent: 'uk' })
      const utter = synth.__state.speakCalls[0]
      must(utter.lang === 'en-GB', 'lang=' + utter.lang)
      must(utter.voice.name === EN_GB_NATURAL.name, 'voice=' + utter.voice.name)
    })

    await check('synth 报错：reject 带 code 与人话 message', async () => {
      reset()
      use(makeSynth({ voices: [EN_US_NATURAL], mode: 'error' }))
      let err = null
      try {
        await api.speak('charge')
      } catch (e) {
        err = e
      }
      must(err, '居然 resolve 了')
      must(codeOf(err) === 'SYNTHESIS_FAILED', 'code=' + codeOf(err))
      must(/语音/.test(String(err.message)), 'message 不是人话: ' + err.message)
    })

    await check('watchdog：silent synth 超时 reject TIMEOUT', async () => {
      reset()
      use(makeSynth({ voices: [EN_US_NATURAL], mode: 'silent' }))
      const startedAt = Date.now()
      const r = await rejectsCode(api.speak('charge'), 'TIMEOUT')
      must(!r, r)
      must(Date.now() - startedAt >= 1400, '超时来得太早: ' + (Date.now() - startedAt) + 'ms')
    })

    await check('并发 speak：旧的 Promise reject ABORTED', async () => {
      reset()
      const synth = makeSynth({ voices: [EN_US_NATURAL], mode: 'manual' })
      api.__setSynth(synth, FakeUtter)
      const first = api.speak('first')
      await sleep(20)
      const second = api.speak('second')
      const r = await rejectsCode(first, 'ABORTED')
      must(!r, r)
      synth.__endAll()
      await second
      must(synth.__state.speakCalls.length === 2, 'speak 次数=' + synth.__state.speakCalls.length)
    })

    await check('stop()：pending 的 Promise reject ABORTED 并 cancel 引擎', async () => {
      reset()
      const synth = makeSynth({ voices: [EN_US_NATURAL], mode: 'manual' })
      api.__setSynth(synth, FakeUtter)
      const pending = api.speak('charge')
      await sleep(20)
      api.stop()
      const r = await rejectsCode(pending, 'ABORTED')
      must(!r, r)
      must(synth.__state.cancelCalls >= 1, '没有调用 synth.cancel')
    })

    await check('stop() 之后可以重新朗读', async () => {
      reset()
      use(makeSynth({ voices: [EN_US_NATURAL], mode: 'manual' }))
      const pending = api.speak('first')
      await sleep(20)
      api.stop()
      const r = await rejectsCode(pending, 'ABORTED')
      must(!r, r)
      const synth2 = makeSynth({ voices: [EN_US_NATURAL] })
      api.__setSynth(synth2, FakeUtter)
      await api.speak('again')
      must(synth2.__state.speakCalls.length === 1, '没有重新朗读')
    })

    await check('长文本按句切分：一次 speak 调用多个 utterance', async () => {
      reset()
      const synth = makeSynth({ voices: [EN_US_NATURAL] })
      api.__setSynth(synth, FakeUtter)
      const long =
        'The charge model token summary explains how tokens are billed. ' +
        'A token is the smallest unit of text the model reads. ' +
        'Charges are computed per token, so longer prompts cost more money. ' +
        'Keep an eye on the token budget when you write long prompts. ' +
        'This sentence exists only to push the total well past two hundred and forty characters.'
      must(long.length > 240, '测试文本不够长: ' + long.length)
      await api.speak(long)
      must(synth.__state.speakCalls.length >= 2, 'speak 次数=' + synth.__state.speakCalls.length)
      synth.__state.speakCalls.forEach(function (utter) {
        must(utter.text.length <= 240, '单片超过 240 字符: ' + utter.text.length)
      })
    })

    await check('signal 已中止：直接 reject ABORTED，不发声音', async () => {
      reset()
      const synth = makeSynth({ voices: [EN_US_NATURAL] })
      api.__setSynth(synth, FakeUtter)
      const ac = new AbortController()
      ac.abort()
      const r = await rejectsCode(api.speak('charge', { signal: ac.signal }), 'ABORTED')
      must(!r, r)
      must(synth.__state.speakCalls.length === 0, '不该调用 speak')
    })

    await check('signal 朗读中中止：reject ABORTED', async () => {
      reset()
      use(makeSynth({ voices: [EN_US_NATURAL], mode: 'manual' }))
      const ac = new AbortController()
      const pending = api.speak('charge', { signal: ac.signal })
      await sleep(20)
      ac.abort()
      const r = await rejectsCode(pending, 'ABORTED')
      must(!r, r)
    })

    await check('preload：音色已就绪时立即 resolve', async () => {
      reset()
      use(makeSynth({ voices: [EN_US_PLAIN, EN_US_NATURAL] }))
      const r = await api.preload()
      must(r && r.voices === 2, 'voices=' + (r && r.voices))
    })

    await check('preload：首次为空时等 voiceschanged（race 后仍 resolve）', async () => {
      reset()
      const synth = makeSynth({ voices: [] })
      api.__setSynth(synth, FakeUtter)
      const startedAt = Date.now()
      const pending = api.preload()
      await sleep(40)
      synth.__addVoices([EN_US_PLAIN, EN_US_NATURAL])
      const r = await pending
      must(r && r.voices === 2, 'voices=' + (r && r.voices))
      must(Date.now() - startedAt >= 30, '没有等待 voiceschanged')
    })

    await check('错误对象形状：code 是稳定枚举、message 是人话', async () => {
      reset()
      use(makeSynth({ voices: [ZH_CN] }))
      let err = null
      try {
        await api.speak('charge')
      } catch (e) {
        err = e
      }
      must(err instanceof Error, '不是 Error 实例')
      must(typeof err.code === 'string' && err.code.length > 0, 'code 缺失')
      must(typeof err.message === 'string' && err.message.length > 0, 'message 缺失')
    })

    return out
  }

  global.__voiceCaseDefs = { makeSynth: makeSynth, makeStorage: makeStorage, run: run }
  if (global === global.window || typeof global.window === 'undefined') {
    // 浏览器里再挂一个直接可调的入口，测试脚本 evaluate 它即可。
    global.runVoiceTests = function () {
      return run()
    }
  }
})(typeof window !== 'undefined' ? window : this)
