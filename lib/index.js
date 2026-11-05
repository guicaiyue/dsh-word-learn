// dsh-word-learn —— 宿主侧插件入口。
//
// 职责：
//   ① 往页面注入前端脚本（划词学习卡）
//   ② 提供本地查词接口：查词典 + 取发音例句 + 记进生词本
//
// 架构直接沿用 dsh-translate-on-select 验证过的做法（这是本机唯一可用的注入通道）：
//   - 注入行走 `webserver/index-inject`，且**必须尽早注册**（宿主启动时只收集一次）
//   - web 形态额外走 `tapIndex` 兜底
//   - 所有路由套一层信任栅栏，防跨站请求
//   - 前端脚本按 mtime 热重载，改完硬刷新即可生效
//
// 与参考实现的一个关键区别：**查询在本地完成**（ECDICT SQLite），
// 不依赖任何外部翻译接口，所以离线也能查词；外部只用于补发音和例句，
// 拿不到就降级，功能不残。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Dictionary } from './dict.mjs'
import { Store } from './store.mjs'
import { intParam, strParam } from './http.mjs'
import { enrich } from './enrich.mjs'
import { classifySelection, looksLikeWord, normalizeWord, pickBest, splitWords } from './text.js'
import { applyGrade, cardStates, dueQueue, scheduleStatus, warmSchedule } from './schedule.mjs'
import { translate, translateStatus } from './translate.mjs'
import {
  analyzeWord,
  disposeQueues,
  enqueueAnalysis,
  enqueueSenseAnalysis,
  generateQuiz,
} from './ai-enrich.mjs'
import {
  clearSavedSelection,
  listTextModels,
  publicSelection,
  resolveAiModel,
  saveSavedSelection,
  savedSelectionLost,
} from './models.mjs'
// P2：R5 次日回访 + 义项地图。逻辑全在 r5.mjs（不碰 FSRS 排期），这里只挂路由。
import { buildRecap, senseMap, submitRecap } from './r5.mjs'
// P3：对话内联标注的目标词表（只给在学、有卡片的词）。
import { annotateWordList } from './annotate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const CLIENT_PATH = '/dsh-word-learn/client.js'
// P3 标注层：独立 IIFE，和划词卡片一样走普通 script 注入（不进 React 客户端包，
// 免得为一个纯 DOM 功能重启宿主才能生效）。
const ANNOTATE_PATH = '/dsh-word-learn/annotate.js'
// 语音：纯前端 speechSynthesis（浏览器自带音色，零网络）。独立脚本 + no-store，
// 改完刷新页面即生效；不再有服务端拉音频/落盘缓存的链路。
const VOICE_PATH = '/dsh-word-learn/voice.js'
const API_LOOKUP = '/dsh-word-learn/lookup'
const API_SAVE = '/dsh-word-learn/save'
const API_LIST = '/dsh-word-learn/list'
const API_UPDATE = '/dsh-word-learn/update'
const API_REMOVE = '/dsh-word-learn/remove'
const API_DASHBOARD = '/dsh-word-learn/dashboard'
const API_QUEUE = '/dsh-word-learn/queue'
const API_GRADE = '/dsh-word-learn/grade'
const API_WORD = '/dsh-word-learn/word'
const API_TRANSLATE = '/dsh-word-learn/translate'
const API_ENRICH_AI = '/dsh-word-learn/enrich-ai'
const API_QUIZ = '/dsh-word-learn/quiz'
const API_REPAIR = '/dsh-word-learn/repair'
const API_REPAIR_LOG = '/dsh-word-learn/repair/log'
const API_REPAIR_CLEAR = '/dsh-word-learn/repair/clear'
const API_REPAIR_STATS = '/dsh-word-learn/repair/stats'
// P2：次日回访一次取一批题；提交时按词记日志（stage='tomorrow'）。
const API_RECAP = '/dsh-word-learn/repair/recap'
const API_SENSE_MAP = '/dsh-word-learn/sense-map'
// P3：标注层的目标词表（前端 GET 一次，按 rev 缓存）。
const API_ANNOTATE_WORDS = '/dsh-word-learn/annotate/words'
const API_MODEL_INFO = '/dsh-word-learn/model-info'
const API_MODELS = '/dsh-word-learn/models'
const API_MODEL = '/dsh-word-learn/model'

// 前端脚本候选位置（link 安装时 assets/ 与 lib/ 是兄弟目录）
const CLIENT_FILE_CANDIDATES = [
  path.join(HERE, '..', 'assets', 'wordcard.js'),
  path.join(HERE, 'wordcard.js'),
]

// 注入行必须是内联脚本（kind:'script'）。
// 页面侧对 kind:'script-src' 是"加载失败即 reject 整个 boot"——插件停用或
// 路由注销时会把整个应用拖死。内联行里自己建 <script src> 并吞掉 onerror，
// 路由在就正常加载，不在就静默失败，宿主永远不会因为我们起不来。
// 两个脚本各自带 window 标记：标注层坏了只影响标注，划词卡片照常工作。
//
// ⚠️ 注入器自己的"已注入"标志必须用独立名字（`__dshWordLearnBoot`）。
//    2026-11-04 踩过：这里用 `__dshWordLearn` 当标志，而 wordcard.js 第 18 行
//    `if (window.__dshWordLearn) return` 是它自己的初始化守卫 —— 标志先被置 1，
//    脚本一执行就 return，整个划词卡片（监听/卡片/入库）一个都不装。
//    注入器只负责"别注入两次"，脚本自己管自己的守卫。
const INJECT_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(window.__dshWordLearnBoot)return;window.__dshWordLearnBoot=1;' +
  'var load=function(src){var s=document.createElement("script");s.src=src;' +
  's.onerror=function(){};d.appendChild(s)};' +
  'load("' +
  VOICE_PATH +
  '");' +
  'load("' +
  CLIENT_PATH +
  '");' +
  'load("' +
  ANNOTATE_PATH +
  '")' +
  '}catch(e){}})()'

// 进程内单例：词典与用户库都要复用（打开 SQLite 有成本）
const dict = new Dictionary()
const store = new Store()

// 每次请求按 mtime 判断是否重读前端脚本
let clientCache = null
function loadClientJs() {
  for (const candidate of CLIENT_FILE_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate)
      if (clientCache && clientCache.mtimeMs === stat.mtimeMs) return clientCache.text
      const text = fs.readFileSync(candidate, 'utf8')
      clientCache = { text, mtimeMs: stat.mtimeMs }
      return text
    } catch (err) {
      /* 试下一个候选 */
    }
  }
  return clientCache ? clientCache.text : ''
}

// P3 标注层单独一个文件：改它不用重启宿主（和 client.js 同一套 mtime 缓存），
// 也不进 React 客户端包——纯 DOM 功能不需要 React，坏了也不会拖垮学习页。
const ANNOTATE_FILE_CANDIDATES = [
  path.join(HERE, '..', 'assets', 'annotate.js'),
  path.join(HERE, 'annotate.js'),
]
const VOICE_FILE_CANDIDATES = [
  path.join(HERE, '..', 'assets', 'voice.js'),
  path.join(HERE, 'voice.js'),
]
let voiceCache = null
function loadVoiceJs() {
  for (const candidate of VOICE_FILE_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate)
      if (voiceCache && voiceCache.mtimeMs === stat.mtimeMs) return voiceCache.text
      const text = fs.readFileSync(candidate, 'utf8')
      voiceCache = { text, mtimeMs: stat.mtimeMs }
      return text
    } catch (err) {
      /* 文件不在就返回空脚本：词卡会提示语音模块未加载 */
    }
  }
  return voiceCache ? voiceCache.text : ''
}
let annotateCache = null
function loadAnnotateJs() {
  for (const candidate of ANNOTATE_FILE_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate)
      if (annotateCache && annotateCache.mtimeMs === stat.mtimeMs) return annotateCache.text
      const text = fs.readFileSync(candidate, 'utf8')
      annotateCache = { text, mtimeMs: stat.mtimeMs }
      return text
    } catch (err) {
      /* 文件还没写（P3 未落地时）→ 返回空脚本，页面侧静默无标注 */
    }
  }
  return annotateCache ? annotateCache.text : ''
}

// ------------------------------------------------------------------ 信任栅栏
// 与 dsh-translate-on-select 同款：自身校验 → 宿主栅栏 → fail-closed。
function makeFence(ctx) {
  const trusted = String(process.env.DSH_WORD_LEARN_TRUSTED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  function isLoopbackHostname(hostname) {
    const h = String(hostname || '')
      .toLowerCase()
      .replace(/^\[/, '')
      .replace(/\]$/, '')
    if (!h) return false
    if (h === 'localhost' || h.endsWith('.localhost')) return true
    if (h === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
    if (!m || Number(m[1]) !== 127) return false
    return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
  }

  function connectionFence() {
    try {
      const conn = ctx.get('connection') || ctx.connection
      return conn && typeof conn.requestRejection === 'function' ? conn : null
    } catch (err) {
      return null
    }
  }

  return function rejection(req) {
    try {
      const headers = (req && req.headers) || {}
      // 跨站标记一律拒（防恶意网页借浏览器打本机接口）
      if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403

      let hostUrl = null
      try {
        hostUrl = new URL('http://' + String(headers.host || ''))
      } catch (err) {
        return 403
      }
      const authority = hostUrl.host.toLowerCase()

      const origin = headers.origin
      if (typeof origin === 'string' && origin && origin !== 'null') {
        let originUrl = null
        try {
          originUrl = new URL(origin)
        } catch (err) {
          return 403
        }
        if (originUrl.host.toLowerCase() !== authority) return 403
      }

      const conn = connectionFence()
      if (!conn) {
        if (!isLoopbackHostname(hostUrl.hostname)) {
          const ok = trusted.some((entry) =>
            entry.indexOf(':') >= 0
              ? entry === authority
              : entry === hostUrl.hostname.toLowerCase(),
          )
          if (!ok) return 403
        }
        return 0
      }
      let code
      try {
        code = conn.requestRejection(req)
      } catch (err) {
        return 403
      }
      if (code === undefined || code === null || code === false) return 0
      return typeof code === 'number' ? code : 403
    } catch (err) {
      return 403
    }
  }
}

/**
 * 唯一的响应出口：已发过就什么都不做，绝不二次写头。
 * 返回 true 表示这次真的发出去了。
 */
function safeSend(res, code, payload) {
  if (!res || res.headersSent || res.writableEnded) return false
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(payload))
    return true
  } catch (err) {
    // 头已经脏了（或连接断了）：别再试一次，直接断掉这条连接
    try {
      res.destroy()
    } catch (e) {}
    return false
  }
}

function sendJson(res, code, payload) {
  return safeSend(res, code, payload)
}

/**
 * 对外错误出口：只回稳定 code + 一句人话。
 * 原始 message 常带用户库的绝对路径，只能进日志，不能给浏览器。
 */
function fail(res, code, errorCode, message, err) {
  if (err !== undefined) {
    try {
      console.warn('[dsh-word-learn] ' + errorCode + '：' + ((err && err.message) || String(err)))
    } catch (e) {}
  }
  return safeSend(res, code, { ok: false, code: errorCode, error: message })
}

/** 用户库打不开时的统一响应（store.error 含绝对路径，不回给浏览器）。 */
function unavailable(res, storeLike) {
  try {
    console.warn('[dsh-word-learn] 用户库不可用：' + ((storeLike && storeLike.error) || '未知原因'))
  } catch (e) {}
  return safeSend(res, 500, { ok: false, code: 'DB_UNAVAILABLE', error: '用户库暂时不可用' })
}

/** GET query 的布尔值：'false'/'0'/0/false 都算 false（'false' !== false 踩过）。 */
function isFalse(v) {
  return v === false || v === 'false' || v === 0 || v === '0'
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const text = await readBody(req)
  const value = text.trim() ? JSON.parse(text) : null
  // 空 body / JSON null / 数组 / 标量都不是合法请求体：在这里就抛，
  // 让调用方现有的 400 分支接管；否则 payload.xxx 会变成 TypeError → 500。
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return value
}

/**
 * 查一个词的完整信息。
 * `withEnrich` 控制是否打外部接口（复习页批量取词时会关掉，避免慢）。
 */
async function lookupWord(word, { withEnrich = true, sentence = '', save = true } = {}) {
  const info = dict.lookup(word)
  if (!info) {
    return { ok: false, error: '词典里没有这个词', query: word }
  }

  let extra = { ok: false, examples: [], synonyms: [] }
  if (withEnrich) {
    extra = await enrich(info.word)
  }

  // 记进生词本（"我在这里遇见了它"）。
  // 学习页的悬浮预览传 save:false —— 鼠标扫过一串易混淆词不该把它们全塞进生词本，
  // 卡片里点「加入生词本」才会真正写库。
  const touched = save ? store.touch(info, sentence) : { isNew: false }
  const saved = store.get(info.word)
  // 写库失败不改变"查到了这个词"，但必须让用户知道"没存进去"。
  // 旧实现把 touch 的 error 丢掉，外面只看到 ok:true + saved:null，静默丢生词本。
  const warnings = []
  if (save && touched && touched.error) {
    warnings.push(`未能写入生词本：${touched.error}`)
  } else if (save && !saved) {
    warnings.push('未能写入生词本')
  }

  return {
    ok: true,
    dict: {
      word: info.word,
      query: info.query,
      matchedBy: info.matchedBy,
      asForm: info.asForm,
      phonetic: info.phonetic || extra.phonetic || '',
      senses: info.senses,
      definition: info.definition,
      forms: info.forms,
      tags: info.tags,
      frequency: info.frequency,
      collins: info.collins,
      oxford: info.oxford,
      // 用户的判断依据，不是自动过滤
      likelyKnown: dict.isLikelyKnown(info),
    },
    enrich: {
      ok: extra.ok,
      examples: extra.examples || [],
      synonyms: extra.synonyms || [],
      error: extra.error || '',
    },
    saved: saved
      ? {
          id: saved.id,
          seenCount: saved.seenCount,
          starred: saved.starred,
          ability: saved.ability,
          isNew: touched.isNew,
        }
      : null,
    warnings,
  }
}

/** /lookup 响应发出后的收尾副作用：AI 分析入队。失败只记日志，不影响已发出的响应。 */
function enqueueLookupFollowUps(ctx, store, result, payload) {
  if (!result.ok || !result.dict) return
  // 后台异步：首次遇见的词丢进 AI 分析队列（生成词根/干扰项/记忆方法）。
  // 义项材料：只有带着原句查词时才有意义。后台串行跑，不阻塞划词卡片；
  // 分析还没好的时候，补记卡退回自由回忆（P0 路径）。
  const savedRow = store.get(result.dict.word)
  enqueueSenseAnalysis(ctx, store, {
    word: result.dict.word,
    translation: (savedRow && savedRow.translation) || '',
    sentence: String(payload.sentence || '').slice(0, 2000),
  })
  enqueueAnalysis(
    ctx,
    store,
    result.dict.word,
    result.dict.senses.map((s) => (s.pos ? `${s.pos} ${s.text}` : s.text)).join('\n'),
    (result.dict.definition || []).join('\n'),
  )
}

export default {
  name: 'dsh-word-learn',
  apply(root) {
    const rowDisposers = []
    root.effect(() => () => {
      for (const dispose of rowDisposers) {
        try {
          dispose()
        } catch (err) {}
      }
      // 先让后台分析队列停手：否则它们会在 store 关掉之后继续开句柄、写库。
      disposeQueues()
      dict.close()
      store.close()
    })

    // ① 注入行必须**尽早**注册（宿主启动时一次性收集），且不依赖任何服务。
    rowDisposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === CLIENT_PATH) return
            if (
              row.kind === 'script' &&
              typeof row.text === 'string' &&
              row.text.includes(CLIENT_PATH)
            )
              return
          }
          table.push({ kind: 'script', placement: 'body', text: INJECT_TEXT })
        } catch (err) {}
      }),
    )

    // ② 其余逻辑等 webServer 就绪（局部等待，不阻塞 ①）
    root.inject(['webServer'], (ctx) => {
      const rejection = makeFence(ctx)
      const disposers = []

      function registerRoute(route) {
        const { methods: methodList, ...rest } = route || {}
        const inner = rest.handler
        const methods = Array.isArray(methodList) ? methodList : null
        return ctx.webServer.register({
          ...rest,
          handler: async (req, res) => {
            const code = rejection(req)
            if (code) {
              try {
                res.statusCode = code
                res.end()
              } catch (err) {}
              return
            }
            // 方法白名单：非白名单方法直接 405，别落进 GET 分支顺手把写操作做掉
            if (methods && !methods.includes(req.method)) {
              try {
                if (typeof res.setHeader === 'function') res.setHeader('Allow', methods.join(', '))
              } catch (err) {}
              fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 ' + methods.join('/') + ' 请求')
              return
            }
            // 统一兜底：新加路由忘了 try/catch 也不会变成未捕获异常
            try {
              await inner(req, res)
            } catch (err) {
              if (res.headersSent || res.writableEnded) {
                try {
                  res.destroy()
                } catch (e) {}
                return
              }
              fail(res, 500, 'INTERNAL_ERROR', '请求处理失败，请重试', err)
            }
          },
        })
      }

      // 清理注册必须早于任何 registerRoute：注册中途抛错时，已注册的路由也要能卸掉。
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (err) {}
        }
      })

      // 前端脚本
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: CLIENT_PATH,
          methods: ['GET'],
          handler: (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(loadClientJs())
          },
        }),
      )

      // 语音脚本（同样 no-store：改了刷新即生效）
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: VOICE_PATH,
          methods: ['GET'],
          handler: (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(loadVoiceJs())
          },
        }),
      )

      // P3 标注层脚本（同样 no-store：改了刷新即生效，不用重启宿主）
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: ANNOTATE_PATH,
          methods: ['GET'],
          handler: (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(loadAnnotateJs())
          },
        }),
      )

      // P3 标注层目标词表：只返回在学、有卡片的词（避免满屏标生词）。
      // rev 变了前端会清掉重标；空库也要 200 + 空数组，前端静默无标注。
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_ANNOTATE_WORDS,
          methods: ['GET'],
          handler: (req, res) => {
            const url = new URL(req.url, 'http://x')
            const limit = intParam(url, 'limit', { fallback: 2000, min: 1, max: 5000 })
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              const words = annotateWordList(store, { limit })
              // annotateWordList 失败时返回 { ok:false, error }（不带 words）。
              // 这里映射成 500：语义清楚，日志/监控能看到；前端已按 ok:false 处理并保留旧标注。
              if (words && words.ok === false) {
                sendJson(res, 500, words)
                return
              }
              sendJson(res, 200, { ok: true, ...words })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 查词
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_LOOKUP,
          methods: ['GET', 'POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload =
                req.method === 'POST'
                  ? await readJson(req)
                  : Object.fromEntries(new URL(req.url, 'http://x').searchParams)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            const word = String(payload.word || '').trim()
            if (!word) {
              sendJson(res, 400, { ok: false, error: '没有要查的词' })
              return
            }
            // 拒绝"看起来不像单词"的输入。
            //
            // 为什么加这道闸：前端划词已经过滤过一轮，但**路由是公开的**，
            // 而且实测漏进来过 —— 模型回答里的 `≈62.3M`、`≈65.7k` 被划中后
            // 把单位后缀 `M`、`k` 当成了单词存进生词本，两条噪音词条。
            // 过滤放在这里，无论调用方是谁都拦得住。
            // 注意只对"单个 token"的查询生效：查 `take effect` 这种短语
            // 由 /save 负责拆词，这里若整串丢进 looksLikeWord 会误杀。
            if (!/\s/.test(word) && !looksLikeWord(word)) {
              sendJson(res, 400, { ok: false, error: `「${word}」不像一个英文单词` })
              return
            }
            try {
              // GET 的 query 参数都是字符串，`save=false` 得按字符串认，
              // 只判 `!== false` 会把 'false' 当成 true（踩过一次）。
              const save = !isFalse(payload.save)
              const result = await lookupWord(word, {
                withEnrich: !isFalse(payload.enrich),
                sentence: String(payload.sentence || '').slice(0, 2000),
                save,
              })
              safeSend(res, result.ok ? 200 : 404, result)
              // 响应已发出：下面的入队是收尾副作用，出错只能记日志，
              // 绝不能改状态码（客户端会当失败重试，重复查词/重复入队）。
              try {
                if (save) enqueueLookupFollowUps(ctx, store, result, payload)
              } catch (err) {
                try {
                  console.warn(
                    '[dsh-word-learn] 查词后入队失败：' + ((err && err.message) || String(err)),
                  )
                } catch (e) {}
              }
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 翻译：把划中的一段话翻成简体中文。
      //
      // 这是"划句子"场景的主功能。拆词只是它下面的一行附加，
      // 不能拿拆词冒充翻译 —— 用户划一句话是因为没读懂，不是想收集生词。
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_TRANSLATE,
          methods: ['GET', 'POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload =
                req.method === 'POST'
                  ? await readJson(req)
                  : Object.fromEntries(new URL(req.url, 'http://x').searchParams)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            const text = String(payload.text || '').trim()
            if (!text) {
              sendJson(res, 400, { ok: false, error: '没有要翻译的内容' })
              return
            }
            // 划词浮层是交互路径：翻译失败也要回 200 + ok:false，
            // 让卡片画一行"翻译失败"就好，不要用 500 让前端当网络错误处理。
            const result = await translate(ctx, text.slice(0, 6000))
            sendJson(res, 200, { ...result, status: translateStatus() })
          },
        }),
      )

      // 拆词：把一个短语/句子拆成候选单词，并逐个给词典结果（不含外部增强）
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_SAVE,
          methods: ['POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload = await readJson(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            const text = String(payload.text || '').trim()
            if (!text) {
              sendJson(res, 400, { ok: false, error: '没有文本' })
              return
            }
            try {
              const classified = classifySelection(text)
              const words = classified.words.length ? classified.words : splitWords(text)
              const items = words.slice(0, 40).map((word) => {
                const info = dict.lookup(word)
                if (!info) return { word, found: false }
                return {
                  word: info.word,
                  found: true,
                  phonetic: info.phonetic,
                  brief: info.senses[0] ? info.senses[0].text.slice(0, 60) : '',
                  frequency: info.frequency,
                  tags: info.tags.map((t) => t.label),
                  likelyKnown: dict.isLikelyKnown(info),
                }
              })
              sendJson(res, 200, {
                ok: true,
                kind: classified.kind,
                best: pickBest(words),
                words: items,
              })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 生词本列表
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_LIST,
          methods: ['GET'],
          handler: (req, res) => {
            const url = new URL(req.url, 'http://x')
            // 负 limit 在 SQLite 里等于「不设上限」（会全表导出），必须夹住
            const result = store.list({
              limit: intParam(url, 'limit', { fallback: 200, min: 1, max: 500, floor: true }),
              offset: intParam(url, 'offset', { fallback: 0, min: 0, floor: true }),
              tier: strParam(url, 'tier'),
              starredOnly: url.searchParams.get('starred') === '1',
              order: strParam(url, 'order', 'recent'),
            })
            sendJson(res, 200, { ok: true, ...result })
          },
        }),
      )

      // 改画像 / 收藏 / 笔记
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_UPDATE,
          methods: ['POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload = await readJson(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            const ok = store.update(String(payload.word || ''), payload.patch || {})
            sendJson(res, ok ? 200 : 404, { ok })
          },
        }),
      )

      // 移除
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_REMOVE,
          methods: ['POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload = await readJson(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            sendJson(res, 200, { ok: store.remove(String(payload.word || '')) })
          },
        }),
      )

      // 学习页看板：一次拿到整个页面要的聚合数据
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_DASHBOARD,
          methods: ['GET'],
          handler: async (req, res) => {
            const url = new URL(req.url, 'http://x')
            const days = intParam(url, 'days', { fallback: 14, min: 3, max: 60 })
            try {
              const data = store.dashboard({ forecastDays: days })
              // 排期引擎是**懒加载**的：没人评过分时它还没被 import，
              // 直接问 scheduleStatus() 会得到 ok:false 的假警报
              // （界面显示"排期引擎不可用"，但实际能用）。
              // 这里先 await 一次预热，确保状态是真实的。
              await warmSchedule()
              sendJson(res, data.ok ? 200 : 500, { ...data, schedule: scheduleStatus() })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 待复习队列（今日到期），附带 word_meta
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_QUEUE,
          methods: ['GET'],
          handler: (req, res) => {
            const url = new URL(req.url, 'http://x')
            const limit = intParam(url, 'limit', { fallback: 200, min: 1, max: 500 })
            const track = strParam(url, 'track')
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              let items = dueQueue(store.db, { limit })
              if (track) items = items.filter((i) => i.track === track)

              // 批量取 word_meta，挂到每个 item 上
              const words = [...new Set(items.map((i) => i.word))]
              const metaMap = store.getMetaBatch(words)
              for (const item of items) {
                item.wordMeta = metaMap[item.word] || null
              }

              sendJson(res, 200, {
                ok: true,
                items,
                total: items.length,
                newCount: items.filter((i) => i.isNew).length,
                reviewCount: items.filter((i) => !i.isNew).length,
              })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 提交一次评分
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_GRADE,
          methods: ['POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload = await readJson(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            const cardId = Number(payload.cardId) || 0
            const rating = Number(payload.rating) || 0
            if (!cardId) {
              sendJson(res, 400, { ok: false, error: '缺少 cardId' })
              return
            }
            if (rating < 1 || rating > 4) {
              sendJson(res, 400, { ok: false, error: 'rating 必须是 1-4' })
              return
            }
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              const result = await applyGrade(store.db, cardId, rating)
              // 卡不存在是客户端问题（404），不是服务器故障（500）
              const code = result.ok ? 200 : result.code === 'not_found' ? 404 : 500
              // ⚠️ 先发响应，再做收尾副作用：applyGrade 已经写库，
              // 这里若因记债抛错回 500，客户端会重试 → 同一张卡评两次（FSRS 不可逆）。
              safeSend(res, code, result)
              if (result.ok && rating === 1) {
                try {
                  // 评「忘了」开一笔补记债：会话末要复现一次，清了才算还完。
                  // 注意这只是记账，不改变 FSRS 的任何字段。
                  store.openRepairDebt(cardId)
                } catch (err) {
                  try {
                    console.warn(
                      '[dsh-word-learn] 评分已写入但记债失败 cardId=' +
                        cardId +
                        '：' +
                        ((err && err.message) || String(err)),
                    )
                  } catch (e) {}
                }
              }
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 单词详情（含两条排期线的状态）
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_WORD,
          methods: ['GET'],
          handler: (req, res) => {
            const url = new URL(req.url, 'http://x')
            const word = String(url.searchParams.get('word') || '').trim()
            if (!word) {
              sendJson(res, 400, { ok: false, error: '没有要查的词' })
              return
            }
            try {
              const info = store.get(word)
              if (!info) {
                sendJson(res, 404, { ok: false, error: '生词本里没有这个词' })
                return
              }
              const dictInfo = dict.lookup(word)
              sendJson(res, 200, {
                ok: true,
                entry: info,
                dict: dictInfo || null,
                cards: cardStates(store.db, info.id),
              })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // AI 分析（手动触发 / 批量补分析）
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_ENRICH_AI,
          methods: ['POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload = await readJson(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            const word = String(payload.word || '')
              .trim()
              .toLowerCase()
            if (!word) {
              sendJson(res, 400, { ok: false, error: '缺少 word' })
              return
            }
            const force = !!payload.force
            const field = typeof payload.field === 'string' ? payload.field : ''
            const VALID_FIELDS = ['roots', 'synonyms', 'distractors', 'mnemonic', 'confusables']
            if (field && !VALID_FIELDS.includes(field)) {
              sendJson(res, 400, {
                ok: false,
                error: '无效的 field，可选：' + VALID_FIELDS.join(', '),
              })
              return
            }
            try {
              // 非强制、非单项 且已有完整结果 → 直接返回
              const existing = store.getMeta(word)
              if (!force && !field && existing && existing.analyzedAt) {
                sendJson(res, 200, { ok: true, meta: existing, cached: true })
                return
              }
              // 现场分析（同步等结果）
              const entry = store.get(word)
              const dictInfo = dict.lookup(word)
              const translation = entry
                ? entry.translation
                : dictInfo
                  ? dictInfo.senses.map((s) => s.text).join('\n')
                  : ''
              const definition = dictInfo ? (dictInfo.definition || []).join('\n') : ''
              const selection = await resolveAiModel(ctx, store)
              // 失败要说清楚原因：模型不可用、限流、返回的不是 JSON 都不一样，
              // 糊成一句"可能是模型不可用"只会让人换模型瞎试。
              let meta
              try {
                meta = await analyzeWord(ctx, word, translation, definition, selection)
              } catch (err) {
                const message = (err && err.message) || 'AI 分析失败'
                try {
                  console.warn('[dsh-word-learn] AI 分析失败 ' + word + '：' + message)
                } catch {}
                sendJson(res, 502, {
                  ok: false,
                  error: message,
                  code: (err && err.code) || 'ANALYSIS_FAILED',
                })
                return
              }
              let final = meta
              if (field && existing) {
                // 单字段更新：只替换指定字段，保留其他
                final = { ...existing, [field]: meta[field], analyzedAt: Date.now() }
              }
              store.setMeta(word, final)
              sendJson(res, 200, { ok: true, meta: final, cached: false })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 选择题数据
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_QUIZ,
          methods: ['GET'],
          handler: (req, res) => {
            const url = new URL(req.url, 'http://x')
            const word = String(url.searchParams.get('word') || '')
              .trim()
              .toLowerCase()
            if (!word) {
              sendJson(res, 400, { ok: false, error: '缺少 word' })
              return
            }
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              const entry = store.get(word)
              if (!entry) {
                sendJson(res, 404, { ok: false, error: '生词本里没有这个词' })
                return
              }
              const meta = store.getMeta(word)
              const quiz = generateQuiz(word, entry.translation, meta, store)
              if (!quiz) {
                sendJson(res, 200, { ok: false, error: '无法生成选择题（释义不足）' })
                return
              }
              sendJson(res, 200, { ok: true, quiz })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 补记卡：义项材料 + 原句 + 债。前端按「忘了」时才拉，不预热整轮队列。
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_REPAIR,
          methods: ['GET'],
          handler: (req, res) => {
            const url = new URL(req.url, 'http://x')
            const cardId = Number(url.searchParams.get('cardId')) || 0
            if (!cardId) {
              sendJson(res, 400, { ok: false, error: '缺少 cardId' })
              return
            }
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              const row = store.db
                .prepare(
                  `SELECT c.id AS card_id, c.word_id, c.track, w.word, w.translation, w.phonetic
                     FROM cards c JOIN words w ON w.id = c.word_id
                    WHERE c.id = ?`,
                )
                .get(cardId)
              if (!row) {
                sendJson(res, 404, { ok: false, error: '找不到这张卡' })
                return
              }
              const sentence = store.latestSentence(row.word)
              const senseMeta = store.getSenseMeta(row.word)
              if (!senseMeta && sentence) {
                // 第一次忘了这个词：现排一次分析，这次先用自由回忆顶上。
                enqueueSenseAnalysis(ctx, store, {
                  word: row.word,
                  translation: row.translation || '',
                  sentence,
                })
              }
              sendJson(res, 200, {
                ok: true,
                cardId,
                wordId: row.word_id,
                word: row.word,
                phonetic: row.phonetic || '',
                sentence,
                senseMeta,
                debt: store.getRepairDebt(row.word_id),
              })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 补记事件：只落 repair_log，不碰 FSRS 排期。
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_REPAIR_LOG,
          methods: ['POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload = await readJson(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            const cardId = Number(payload.cardId) || 0
            if (!cardId) {
              sendJson(res, 400, { ok: false, error: '缺少 cardId' })
              return
            }
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              const row = store.db.prepare('SELECT word_id FROM cards WHERE id = ?').get(cardId)
              if (!row) {
                sendJson(res, 404, { ok: false, error: '找不到这张卡' })
                return
              }
              store.logRepair({
                wordId: row.word_id,
                cardId,
                stage: payload.stage,
                ok: payload.ok,
                guess: payload.guess,
                elapsedMs: payload.elapsedMs,
              })
              sendJson(res, 200, { ok: true })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 清债：R4 也过了才调，重复调用无害。
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_REPAIR_CLEAR,
          methods: ['POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload = await readJson(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              let wordId = Number(payload.wordId) || 0
              const cardId = Number(payload.cardId) || 0
              if (!wordId && cardId) {
                const row = store.db.prepare('SELECT word_id FROM cards WHERE id = ?').get(cardId)
                wordId = row ? row.word_id : 0
              }
              if (!wordId) {
                sendJson(res, 400, { ok: false, error: '缺少 wordId 或 cardId' })
                return
              }
              store.clearRepairDebt(wordId)
              sendJson(res, 200, { ok: true })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // 补记效果统计：判断这个循环有没有用，而不是凭感觉。
      //
      // 关心三件事：忘了以后有多少人真的走完补记（tries）、
      // 义项判别首猜正确率（pick 的 ok）、以及债多久能清（debt）。
      // 全部读 repair_log / repair_debt，不碰 FSRS 的表。
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_REPAIR_STATS,
          methods: ['GET'],
          handler: (req, res) => {
            const url = new URL(req.url, 'http://x')
            const days = intParam(url, 'days', { fallback: 14, min: 1, max: 90 })
            const since = Date.now() - days * 86400000
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              const stages = store.db
                .prepare(
                  `SELECT stage, COUNT(*) AS n, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok
                     FROM repair_log WHERE created_at >= ? GROUP BY stage`,
                )
                .all(since)
              const debt = store.db
                .prepare(
                  `SELECT COUNT(*) AS opened,
                          SUM(CASE WHEN cleared_at IS NOT NULL THEN 1 ELSE 0 END) AS cleared
                     FROM repair_debt WHERE opened_at >= ?`,
                )
                .get(since)
              sendJson(res, 200, {
                ok: true,
                days,
                stages: stages.map((s) => ({
                  stage: s.stage,
                  n: Number(s.n) || 0,
                  ok: Number(s.ok) || 0,
                })),
                debt: {
                  opened: Number(debt && debt.opened) || 0,
                  cleared: Number(debt && debt.cleared) || 0,
                },
              })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // P2 · R5 次日回访：取一批「昨天忘过/修过」的词，换句判别同义/异义。
      // 只读 contexts/sense_meta，不动 FSRS —— 这是检验，不是复习。
      // GET 取题，POST 交卷（同一路径按 method 分流，与其它路由一致）。
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_RECAP,
          methods: ['GET', 'POST'],
          handler: async (req, res) => {
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              if (req.method === 'POST') {
                let payload
                try {
                  payload = await readJson(req)
                } catch (err) {
                  sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
                  return
                }
                if (!payload || !Number(payload.wordId)) {
                  sendJson(res, 400, { ok: false, error: '缺少 wordId' })
                  return
                }
                const result = submitRecap(store, payload)
                sendJson(res, 200, { ok: true, ...result })
                return
              }
              const url = new URL(req.url, 'http://x')
              const limit = intParam(url, 'limit', { fallback: 5, min: 1, max: 10 })
              sendJson(res, 200, { ok: true, ...buildRecap(store, { limit }) })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // P2 · 义项地图：这个词见过哪几个义项、各自答对过没有。
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_SENSE_MAP,
          methods: ['GET'],
          handler: (req, res) => {
            const url = new URL(req.url, 'http://x')
            const word = normalizeWord(url.searchParams.get('word') || '')
            if (!word) {
              sendJson(res, 400, { ok: false, error: '词不合法' })
              return
            }
            try {
              if (!store.open()) {
                unavailable(res, store)
                return
              }
              sendJson(res, 200, { ok: true, word, senses: senseMap(store, word) })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // AI 分析模型：DSH 模型目录里的文本模型清单 + 当前选择。
      //
      // 清单和 GUI 模型选择器同源（ctx.llm.listProviders/listModels），
      // 不自己维护模型名单；选择默认取目录第一个，用户自选后存进 user.db。
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_MODELS,
          methods: ['GET'],
          handler: async (req, res) => {
            try {
              const resolved = await resolveAiModel(ctx, store)
              sendJson(res, 200, {
                ok: true,
                models: resolved.models,
                failures: resolved.failures,
                selection: publicSelection(resolved),
                // 目录第一个，前端用来说明"默认就是这个"
                defaultSelection: resolved.models.length
                  ? {
                      provider: resolved.models[0].provider,
                      model: resolved.models[0].id,
                      name: resolved.models[0].name,
                      providerName: resolved.models[0].providerName,
                    }
                  : null,
                // 用户自选过、但现在目录里已经没有的模型（提示用）
                lostSelection: savedSelectionLost(store, resolved.models),
              })
            } catch (err) {
              try {
                console.warn(
                  '[dsh-word-learn] 模型目录不可用：' + ((err && err.message) || String(err)),
                )
              } catch (e) {}
              safeSend(res, 500, {
                ok: false,
                code: 'MODELS_UNAVAILABLE',
                error: '读不到模型目录，请稍后重试',
                models: [],
              })
            }
          },
        }),
      )

      // 保存 / 重置 AI 分析模型
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_MODEL,
          methods: ['POST'],
          handler: async (req, res) => {
            let payload
            try {
              payload = await readJson(req)
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            try {
              if (payload && payload.reset) {
                clearSavedSelection(store)
                const resolved = await resolveAiModel(ctx, store)
                sendJson(res, 200, { ok: true, selection: publicSelection(resolved) })
                return
              }
              const provider = String((payload && payload.provider) || '').trim()
              const model = String((payload && payload.model) || '').trim()
              if (!provider || !model) {
                sendJson(res, 400, { ok: false, error: '缺 provider 或 model' })
                return
              }
              // 只接受目录里真实存在、且还能用的模型，防止存进一个拼错的名字
              const catalog = await listTextModels(ctx)
              const hit = catalog.models.find((m) => m.provider === provider && m.id === model)
              if (!hit) {
                sendJson(res, 400, { ok: false, error: `模型不可用：${provider} / ${model}` })
                return
              }
              saveSavedSelection(store, provider, model)
              const resolved = await resolveAiModel(ctx, store, catalog)
              sendJson(res, 200, { ok: true, selection: publicSelection(resolved) })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // AI 模型信息（兼容旧接口：返回 AI 分析当前实际用的模型）
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_MODEL_INFO,
          methods: ['GET'],
          handler: async (req, res) => {
            try {
              const resolved = await resolveAiModel(ctx, store)
              sendJson(res, 200, {
                ok: true,
                provider: resolved.provider || null,
                model: resolved.model || null,
                name: resolved.name || '',
                source: resolved.source,
              })
            } catch (err) {
              fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', err)
            }
          },
        }),
      )

      // web 形态兜底（桌面端走不到这里）
      disposers.push(
        ctx.webServer.tapIndex((html) => {
          if (typeof html !== 'string' || html.includes(CLIENT_PATH)) return html
          const tag =
            '<script defer src="' +
            CLIENT_PATH +
            '"></script>' +
            '<script defer src="' +
            ANNOTATE_PATH +
            '"></script>'
          if (html.includes('</body>')) return html.replace('</body>', tag + '</body>')
          return html + tag
        }),
      )
    })
  },
}
