// test-voice.mjs —— assets/voice.js 的回归测试。
//
// 两种模式：
//   node scripts/test-voice.mjs            无浏览器：vm 造一个假 window（localStorage +
//                                          假 speechSynthesis + 假 SpeechSynthesisUtterance），
//                                          加载 voice.js + fixture/cases.js，跑同一批用例。
//   BSK_BROWSER=<id> node scripts/test-voice.mjs --browser
//                                          真实 Chromium（bsk）+ 本地静态 fixture：
//                                          先跑同一批假 synth 用例（确定性），再加两条
//                                          真实环境软断言（supported / preload 能 resolve）。
//
// 为什么不在 node 里跑真音色：node 没有 speechSynthesis，真机音色也因系统而异；
// 这里只验证协议与稳健性（音色选择、降级、watchdog、并发、分句、持久化）。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.dirname(HERE)
const VOICE_JS = path.join(PLUGIN_DIR, 'assets', 'voice.js')
const FIXTURE_DIR = path.join(HERE, 'test-voice-fixture')
const CASES_JS = path.join(FIXTURE_DIR, 'cases.js')

// ---------------------------------------------------------------- 断言
const results = []
function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, detail: ok ? undefined : { actual, expected } })
}
function truthy(name, actual, detail) {
  const ok = !!actual
  results.push({ name, ok, detail: ok ? undefined : detail === undefined ? { actual } : detail })
}
function pushCase(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: ok ? undefined : detail })
}
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// ---------------------------------------------------------------- 1. 无浏览器
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

function makeVmContext() {
  const win = {
    setTimeout,
    clearTimeout,
    console,
    speechSynthesis: null,
    localStorage: null,
    SpeechSynthesisUtterance: FakeUtterance,
  }
  win.window = win
  const context = vm.createContext({
    window: win,
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    Promise,
  })
  return { win, context }
}

async function testNode() {
  console.log('== 1. 无浏览器（vm + 假 synth） ==')
  const { win, context } = makeVmContext()
  vm.runInContext(fs.readFileSync(CASES_JS, 'utf8'), context, { filename: 'cases.js' })
  const defs = win.__voiceCaseDefs
  if (!defs) throw new Error('cases.js 没有导出 __voiceCaseDefs')
  win.localStorage = defs.makeStorage()
  vm.runInContext(fs.readFileSync(VOICE_JS, 'utf8'), context, { filename: 'voice.js' })
  const api = win.__dwlVoice
  truthy('node :: 注入后暴露 window.__dwlVoice', api && typeof api.speak === 'function')

  const cases = await defs.run()
  for (const item of cases) pushCase('node :: ' + item.name, item.ok, item.detail)

  // 幂等守卫：重复注入不能重建实例（否则页面里已持有的引用会失效）。
  let rethrow = null
  try {
    vm.runInContext(fs.readFileSync(VOICE_JS, 'utf8'), context, { filename: 'voice.js#again' })
  } catch (err) {
    rethrow = err
  }
  truthy('node :: 重复注入不抛错', !rethrow, rethrow && String(rethrow.message))
  equal('node :: 重复注入后 __dwlVoice 仍是同一个对象', win.__dwlVoice === api, true)

  return cases.length
}

// ---------------------------------------------------------------- 2. 浏览器端到端
const serverState = { port: 0 }
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = String(req.url || '/').split('?')[0]
      function send(status, type, body) {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
        res.end(body)
      }
      try {
        if (urlPath === '/' || urlPath === '/index.html') {
          send(
            200,
            'text/html; charset=utf-8',
            fs.readFileSync(path.join(FIXTURE_DIR, 'index.html')),
          )
          return
        }
        if (urlPath === '/cases.js') {
          send(200, 'text/javascript; charset=utf-8', fs.readFileSync(CASES_JS))
          return
        }
        if (urlPath === '/assets/voice.js') {
          send(200, 'text/javascript; charset=utf-8', fs.readFileSync(VOICE_JS))
          return
        }
        send(404, 'text/plain; charset=utf-8', 'not found')
      } catch (err) {
        send(500, 'text/plain; charset=utf-8', String((err && err.message) || err))
      }
    })
    server.listen(0, '127.0.0.1', () => {
      serverState.port = server.address().port
      resolve(server)
    })
  })
}

const BSK = process.env.BSK_BIN || 'bsk'
function bsk(args) {
  return execFileSync(BSK, args, {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { BSK_AUTO_START: '0' }),
    timeout: 90000,
  })
}
function bskSoft(args) {
  try {
    return { ok: true, stdout: bsk(args) }
  } catch (err) {
    return {
      ok: false,
      stdout: String((err && err.stdout) || ''),
      stderr: String((err && err.stderr) || ''),
      message: String((err && err.message) || err),
    }
  }
}
function parseJson(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('bsk 输出不是 JSON: ' + raw.slice(0, 200))
  return JSON.parse(raw.slice(start, end + 1))
}
function bskSessionStart(browserId) {
  const out = bsk(['session', 'start', '--browser', browserId, '--json'])
  const json = parseJson(out)
  if (!json.session_id) throw new Error('session start 没有返回 session_id')
  return json.session_id
}
function bskEvaluate(sessionId, expression) {
  let lastErr = ''
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sync = parseJson(bsk(['cooperate', 'sync', '--session', sessionId, '--json']))
    const args = [
      'evaluate',
      '--json',
      '--session',
      sessionId,
      '--context',
      sync.context_id,
      '--observation',
      sync.observation_id,
      expression,
    ]
    const out = bsk(args)
    const json = parseJson(out)
    if (json.code === 'permission_denied') {
      lastErr = json.message || 'permission_denied'
      continue
    }
    if (json.ok === false) throw new Error('evaluate 失败: ' + JSON.stringify(json).slice(0, 300))
    return json.value
  }
  throw new Error('evaluate 连续失败: ' + lastErr)
}

async function testBrowser(browserId) {
  console.log('== 2. 端到端（bsk + fixture，真实 Chromium） ==')
  const server = await startServer()
  const base = 'http://127.0.0.1:' + serverState.port + '/'
  let sessionId = ''
  try {
    sessionId = bskSessionStart(browserId)
    console.log('session:', sessionId, 'url:', base)
    await sleep(1200)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nav = bskSoft(['navigate', '--session', sessionId, base, '--json'])
      if (nav.ok) break
      if (attempt === 2) console.log('navigate 软失败（继续，后续用 evaluate 验证）:', nav.message)
      await sleep(1500)
    }
    // 页面脚本是 <script> 同步加载的，但 Agent Window 扩展链路慢，轮询确认已就绪。
    let ready = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(400)
      const probe = bskEvaluate(sessionId, 'typeof window.runVoiceTests === "function"')
      if (probe === true) {
        ready = true
        break
      }
    }
    truthy('浏览器 :: fixture 已加载（voice.js + cases.js）', ready)

    if (ready) {
      const cases = bskEvaluate(sessionId, 'window.runVoiceTests()')
      for (const item of cases) pushCase('浏览器 :: ' + item.name, item.ok, item.detail)

      // 真实环境软断言：假 synth 换回真 speechSynthesis，只看 supported 与 preload 不炸。
      bskEvaluate(
        sessionId,
        'window.__dwlVoice.__setSynth(window.speechSynthesis, window.SpeechSynthesisUtterance)',
      )
      const info = bskEvaluate(sessionId, 'window.__dwlVoice.info()')
      equal('浏览器 :: 真实环境 info().supported', info.supported, true)
      equal('浏览器 :: 真实环境 engine', info.engine, 'speechSynthesis')
      const pre = bskEvaluate(sessionId, 'window.__dwlVoice.preload()')
      truthy(
        '浏览器 :: 真实 preload 能 resolve（音色数允许 0）',
        pre && typeof pre.voices === 'number',
      )
    }
  } finally {
    if (sessionId) {
      const stop = bskSoft(['session', 'stop', sessionId])
      if (!stop.ok) console.log('session stop 失败（忽略）:', stop.message)
    }
    server.close()
  }
}

// ---------------------------------------------------------------- main
async function main() {
  try {
    const nodeCases = await testNode()
    console.log('node 用例数:', nodeCases)

    const browserId = process.env.BSK_BROWSER || ''
    const wantBrowser = process.argv.indexOf('--browser') >= 0 || !!browserId
    if (wantBrowser) {
      if (!browserId) {
        console.log('跳过端到端：没有 BSK_BROWSER（浏览器实例 id）')
      } else {
        await testBrowser(browserId)
      }
    } else {
      console.log('（跳过端到端；加 --browser 且设 BSK_BROWSER=<实例id> 可跑）')
    }

    const failed = results.filter((r) => !r.ok)
    console.log('')
    console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' 通过')
    if (failed.length) {
      console.log('失败项：')
      for (const f of failed) console.log('  - ' + f.name + ' ' + JSON.stringify(f.detail))
      process.exitCode = 1
    }
  } catch (err) {
    console.error('测试异常:', err)
    process.exitCode = 1
  }
}

main()
