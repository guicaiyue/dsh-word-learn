// 测什么：src/client/features/voice.js（原注入脚本 assets/voice.js）—— 发音协议与稳健性。
//
// 迁移来源：scripts/test-voice.mjs + scripts/test-voice-fixture/cases.js 里的那批
// 行为用例。旧版用 vm 造一个假 window，把 assets/voice.js 当普通脚本跑完再调
// window 全局后由 core.js 取；构建化后模块直接 import，那套加载代码整段消失。
// 断言逐条保留（同一批用例，只是从「results 数组 + 自造 equal/truthy」换成
// node:test + assert/strict），没有删减，也没有放宽。
//
// 为什么不在 node 里跑真音色：node 没有 speechSynthesis，真机音色也因系统而异；
// 这里只验证协议与稳健性（音色选择、降级、watchdog、并发、分句、持久化）。
// 所有用例都通过 __setSynth 注入假 synth，**不依赖真实音色**，所以结果确定。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import VOICE, {
  version,
  preload,
  info,
  speak,
  stop,
  __setSynth,
} from '../../src/client/features/voice.js'

// ---------------------------------------------------------------- 环境
//
// 模块本身在 import 期不碰任何全局（零顶层副作用），所以上面先 import 再装假的
// window 也没问题 —— 这也是「构建化后模块可以直接 import」的一条自证。

/** 假 utterance：属性是普通字段，断言才看得到"选了哪个音色"。 */
class FakeUtterance {
  constructor(text) {
    this.text = text
    this.lang = ''
    this.rate = 1
    this.pitch = 1
    this.voice = null
    this.onstart = null
    this.onend = null
    this.onerror = null
  }
}

/** 假 localStorage（隐私模式下可能抛错，模块对此已做静默降级，这里给可用的）。 */
function makeStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] || null,
    get length() {
      return map.size
    },
  }
}

const windowStub = {
  localStorage: makeStorage(),
  setTimeout,
  clearTimeout,
  speechSynthesis: null,
  SpeechSynthesisUtterance: FakeUtterance,
}
globalThis.window = windowStub

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
    getVoices: () => state.voices.slice(),
    speak(utter) {
      state.speakCalls.push(utter)
      if (state.mode === 'silent' || state.mode === 'manual') return
      if (state.mode === 'error') {
        setTimeout(() => {
          if (utter.onerror) utter.onerror({ error: state.errorCode })
        }, 0)
        return
      }
      setTimeout(() => {
        if (utter.onstart) utter.onstart()
        setTimeout(() => {
          if (utter.onend) utter.onend()
        }, 0)
      }, 0)
    },
    cancel() {
      state.cancelCalls += 1
    },
    addEventListener(type, fn) {
      if (type === 'voiceschanged') state.listeners.push(fn)
    },
    removeEventListener(type, fn) {
      const i = state.listeners.indexOf(fn)
      if (i >= 0) state.listeners.splice(i, 1)
    },
  }
  synth.__state = state
  synth.__addVoices = (list) => {
    state.voices = list.slice()
    state.listeners.slice().forEach((fn) => fn())
  }
  synth.__endAll = () => {
    state.speakCalls.forEach((utter) => {
      if (utter.__ended) return
      utter.__ended = true
      if (utter.onend) utter.onend()
    })
  }
  return synth
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const codeOf = (err) => String((err && err.code) || 'NO_CODE')

/** 注入假 synth + 假 utterance 构造器：断言看到的就是普通字段。 */
function use(synth) {
  __setSynth(synth, FakeUtterance)
}

/** 清掉上一用例的播放/偏好，保证每个用例从干净状态开始。 */
function reset() {
  stop()
  try {
    windowStub.localStorage.clear()
  } catch (err) {
    /* 隐私模式：忽略 */
  }
  __setSynth(null, FakeUtterance)
}

/** 断言 promise 以指定 code reject；resolve 或 code 不符时给出人话。 */
async function assertRejectsCode(promise, code) {
  let err = null
  try {
    await promise
  } catch (e) {
    err = e
  }
  assert.ok(err, 'Promise 居然 resolve 了，期望 reject ' + code)
  assert.equal(codeOf(err), code, 'reject code 不对：' + String(err && err.message))
  return err
}

// ================================================================ 用例

test('API 形状：preload/info/speak/stop/__setSynth + version', () => {
  reset()
  assert.equal(typeof VOICE, 'object')
  const fns = [
    ['preload', preload],
    ['info', info],
    ['speak', speak],
    ['stop', stop],
    ['__setSynth', __setSynth],
  ]
  for (const [name, fn] of fns) {
    assert.equal(typeof fn, 'function', name + ' 不是函数')
    assert.equal(VOICE[name], fn, '默认导出与具名导出不是同一个 ' + name)
  }
  assert.equal(typeof version, 'string')
  assert.ok(version.length > 0, 'version 缺失')
  assert.equal(VOICE.version, version, '默认导出的 version 与具名导出一致')
})

test('模块单例：重复 import 拿到的还是同一个实例，且不再往 window 上挂全局', async () => {
  reset()
  const again = await import('../../src/client/features/voice.js')
  assert.equal(again.default, VOICE, '重复 import 应是同一个模块实例')
  assert.equal(again.speak, speak)
  // 原注入脚本靠 window 上的专用标志防重；模块化之后页面里不该再有这个全局。
  assert.equal('__dwlVoice' in windowStub, false, '模块不该再往 window 上挂全局')
})

test('info()：注入假 synth 后 supported=true / engine=speechSynthesis', () => {
  reset()
  use(makeSynth({ voices: [EN_US_PLAIN] }))
  const got = info()
  assert.equal(got.supported, true)
  assert.equal(got.engine, 'speechSynthesis')
  assert.equal(got.voices, 1)
})

test('音色优先级：natural 音色 > 池里第一个，并把选择写进偏好', () => {
  reset()
  use(makeSynth({ voices: [EN_US_PLAIN, EN_US_NATURAL] }))
  const got = info()
  assert.equal(got.chosen.us, EN_US_NATURAL.name)
  assert.equal(windowStub.localStorage.getItem('dwl-voice-pref:us'), EN_US_NATURAL.name)
})

test('localStorage 偏好优先于 natural（下次生效）', () => {
  reset()
  windowStub.localStorage.setItem('dwl-voice-pref:us', EN_US_PLAIN.name)
  use(makeSynth({ voices: [EN_US_PLAIN, EN_US_NATURAL] }))
  assert.equal(info().chosen.us, EN_US_PLAIN.name)
})

test('英式池：chosen.uk 取 en-GB 音色', () => {
  reset()
  use(makeSynth({ voices: [EN_US_PLAIN, EN_GB_PLAIN, EN_GB_NATURAL] }))
  assert.equal(info().chosen.uk, EN_GB_NATURAL.name)
})

test('没有 en-GB 时 uk 回退到任意英文音色', () => {
  reset()
  use(makeSynth({ voices: [EN_US_PLAIN] }))
  assert.equal(info().chosen.uk, EN_US_PLAIN.name)
})

test('只有中文音色时 chosen 为 null', () => {
  reset()
  use(makeSynth({ voices: [ZH_CN, ZH_TW] }))
  const got = info()
  assert.equal(got.chosen.us, null)
  assert.equal(got.chosen.uk, null)
})

test('没有英文音色：speak reject NO_VOICE 且提示人话', async () => {
  reset()
  use(makeSynth({ voices: [ZH_CN] }))
  const err = await assertRejectsCode(speak('charge'), 'NO_VOICE')
  assert.match(String(err.message), /音色/, 'message 不是人话: ' + err.message)
})

test('没有 speechSynthesis：speak reject UNSUPPORTED', async () => {
  reset()
  __setSynth(null, FakeUtterance)
  assert.equal(info().supported, false)
  await assertRejectsCode(speak('charge'), 'UNSUPPORTED')
})

test('空文本 reject EMPTY_TEXT 且不调 synth.speak', async () => {
  reset()
  const synth = makeSynth({ voices: [EN_US_NATURAL] })
  __setSynth(synth, FakeUtterance)
  await assertRejectsCode(speak('   '), 'EMPTY_TEXT')
  assert.equal(synth.__state.speakCalls.length, 0, '不该调用 speak')
})

test('正常朗读：onend 后 resolve，参数落到 utterance', async () => {
  reset()
  const synth = makeSynth({ voices: [EN_US_NATURAL] })
  __setSynth(synth, FakeUtterance)
  await speak('charge')
  const utter = synth.__state.speakCalls[0]
  assert.ok(utter, '没有 speak 调用')
  assert.equal(utter.text, 'charge')
  assert.equal(utter.lang, 'en-US')
  assert.equal(utter.voice.name, EN_US_NATURAL.name)
  assert.equal(utter.rate, 1)
  assert.equal(utter.pitch, 1)
})

test('rate/pitch 持久化：下次不带参数沿用上次的值', async () => {
  reset()
  const synth = makeSynth({ voices: [EN_US_NATURAL] })
  __setSynth(synth, FakeUtterance)
  await speak('one', { rate: 1.4, pitch: 1.2 })
  assert.equal(windowStub.localStorage.getItem('dwl-voice-rate'), '1.4', 'rate 没持久化')
  assert.equal(windowStub.localStorage.getItem('dwl-voice-pitch'), '1.2', 'pitch 没持久化')
  await speak('two')
  const utter = synth.__state.speakCalls[1]
  // 真实 Chromium 会把 rate 存成 float32（1.4 → 1.3999999…），比较给点容差。
  assert.ok(Math.abs(utter.rate - 1.4) < 0.01, 'rate=' + utter.rate)
  assert.ok(Math.abs(utter.pitch - 1.2) < 0.01, 'pitch=' + utter.pitch)
})

test('英式发音：accent=uk 用 en-GB 音色', async () => {
  reset()
  const synth = makeSynth({ voices: [EN_US_PLAIN, EN_GB_NATURAL] })
  __setSynth(synth, FakeUtterance)
  await speak('colour', { accent: 'uk' })
  const utter = synth.__state.speakCalls[0]
  assert.equal(utter.lang, 'en-GB')
  assert.equal(utter.voice.name, EN_GB_NATURAL.name)
})

test('synth 报错：reject 带 code 与人话 message', async () => {
  reset()
  use(makeSynth({ voices: [EN_US_NATURAL], mode: 'error' }))
  const err = await assertRejectsCode(speak('charge'), 'SYNTHESIS_FAILED')
  assert.match(String(err.message), /语音/, 'message 不是人话: ' + err.message)
})

test('watchdog：silent synth 超时 reject TIMEOUT', async () => {
  reset()
  use(makeSynth({ voices: [EN_US_NATURAL], mode: 'silent' }))
  const startedAt = Date.now()
  await assertRejectsCode(speak('charge'), 'TIMEOUT')
  assert.ok(Date.now() - startedAt >= 1400, '超时来得太早: ' + (Date.now() - startedAt) + 'ms')
})

test('并发 speak：旧的 Promise reject ABORTED', async () => {
  reset()
  const synth = makeSynth({ voices: [EN_US_NATURAL], mode: 'manual' })
  __setSynth(synth, FakeUtterance)
  const first = speak('first')
  await sleep(20)
  const second = speak('second')
  await assertRejectsCode(first, 'ABORTED')
  synth.__endAll()
  await second
  assert.equal(synth.__state.speakCalls.length, 2)
})

test('stop()：pending 的 Promise reject ABORTED 并 cancel 引擎', async () => {
  reset()
  const synth = makeSynth({ voices: [EN_US_NATURAL], mode: 'manual' })
  __setSynth(synth, FakeUtterance)
  const pending = speak('charge')
  await sleep(20)
  stop()
  await assertRejectsCode(pending, 'ABORTED')
  assert.ok(synth.__state.cancelCalls >= 1, '没有调用 synth.cancel')
})

test('stop() 之后可以重新朗读', async () => {
  reset()
  use(makeSynth({ voices: [EN_US_NATURAL], mode: 'manual' }))
  const pending = speak('first')
  await sleep(20)
  stop()
  await assertRejectsCode(pending, 'ABORTED')
  const synth2 = makeSynth({ voices: [EN_US_NATURAL] })
  __setSynth(synth2, FakeUtterance)
  await speak('again')
  assert.equal(synth2.__state.speakCalls.length, 1, '没有重新朗读')
})

test('长文本按句切分：一次 speak 调用多个 utterance', async () => {
  reset()
  const synth = makeSynth({ voices: [EN_US_NATURAL] })
  __setSynth(synth, FakeUtterance)
  const long =
    'The charge model token summary explains how tokens are billed. ' +
    'A token is the smallest unit of text the model reads. ' +
    'Charges are computed per token, so longer prompts cost more money. ' +
    'Keep an eye on the token budget when you write long prompts. ' +
    'This sentence exists only to push the total well past two hundred and forty characters.'
  assert.ok(long.length > 240, '测试文本不够长: ' + long.length)
  await speak(long)
  assert.ok(synth.__state.speakCalls.length >= 2, 'speak 次数=' + synth.__state.speakCalls.length)
  synth.__state.speakCalls.forEach((utter) => {
    assert.ok(utter.text.length <= 240, '单片超过 240 字符: ' + utter.text.length)
  })
})

test('signal 已中止：直接 reject ABORTED，不发声音', async () => {
  reset()
  const synth = makeSynth({ voices: [EN_US_NATURAL] })
  __setSynth(synth, FakeUtterance)
  const ac = new AbortController()
  ac.abort()
  await assertRejectsCode(speak('charge', { signal: ac.signal }), 'ABORTED')
  assert.equal(synth.__state.speakCalls.length, 0, '不该调用 speak')
})

test('signal 朗读中中止：reject ABORTED', async () => {
  reset()
  use(makeSynth({ voices: [EN_US_NATURAL], mode: 'manual' }))
  const ac = new AbortController()
  const pending = speak('charge', { signal: ac.signal })
  await sleep(20)
  ac.abort()
  await assertRejectsCode(pending, 'ABORTED')
})

test('preload：音色已就绪时立即 resolve', async () => {
  reset()
  use(makeSynth({ voices: [EN_US_PLAIN, EN_US_NATURAL] }))
  const r = await preload()
  assert.ok(r && r.voices === 2, 'voices=' + (r && r.voices))
})

test('preload：首次为空时等 voiceschanged（race 后仍 resolve）', async () => {
  reset()
  const synth = makeSynth({ voices: [] })
  __setSynth(synth, FakeUtterance)
  const startedAt = Date.now()
  const pending = preload()
  await sleep(40)
  synth.__addVoices([EN_US_PLAIN, EN_US_NATURAL])
  const r = await pending
  assert.ok(r && r.voices === 2, 'voices=' + (r && r.voices))
  assert.ok(Date.now() - startedAt >= 30, '没有等待 voiceschanged')
})

test('错误对象形状：code 是稳定枚举、message 是人话', async () => {
  reset()
  use(makeSynth({ voices: [ZH_CN] }))
  const err = await assertRejectsCode(speak('charge'), 'NO_VOICE')
  assert.ok(err instanceof Error, '不是 Error 实例')
  assert.ok(typeof err.code === 'string' && err.code.length > 0, 'code 缺失')
  assert.ok(typeof err.message === 'string' && err.message.length > 0, 'message 缺失')
})
