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

import { disposeQueues } from './ai-enrich.mjs'
import { dict, store } from './runtime.mjs'
import {
  ANNOTATE_PATH,
  CLIENT_PATH,
  CORE_PATH,
  VOICE_PATH,
  WORDCARD_CARD_PATH,
  WORDCARD_STYLE_PATH,
} from './routes/paths.mjs'
import { fail } from './routes/shared.mjs'
import { registerAssetRoutes } from './routes/assets.mjs'
import { registerStudyRoutes } from './routes/study.mjs'
import { registerReviewRoutes } from './routes/review.mjs'
import { registerAiRoutes } from './routes/ai.mjs'
import { registerRepairRoutes } from './routes/repair.mjs'
import { registerAnnotateRoutes } from './routes/annotate.mjs'
// P2：R5 次日回访 + 义项地图。逻辑全在 r5.mjs（不碰 FSRS 排期），这里只挂路由。
// P3：对话内联标注的目标词表（只给在学、有卡片的词）。

// 前端脚本候选位置（link 安装时 assets/ 与 lib/ 是兄弟目录）
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
// 注入顺序有依赖（脚本 append 后依次加载，且显式 async=false）：
//   core（纯判定，wordcard 从 window.__dwlCore 取）→ voice →
//   wordcard-style / wordcard-card（wordcard 消费 window.__dwlWordcard*）→
//   client → annotate。
// 注意：client 产物本身是单 bundle，dashboard 的学习页逻辑/样式已并入 bundle（阶段 2）；
// 仍在注入的 assets 是划词/标注那一层，它们要跑在任何页面、与 client 生命周期无关。
const SCRIPT_PATHS = [
  CORE_PATH,
  VOICE_PATH,
  WORDCARD_STYLE_PATH,
  WORDCARD_CARD_PATH,
  CLIENT_PATH,
  ANNOTATE_PATH,
]

// web 形态的 tapIndex 兜底（桌面端走不到）：历史上没有 voice.js，行为保持不变；
// 词卡/学习页拆出的脚本按同样的相对顺序补在这里。
const INDEX_SCRIPT_PATHS = SCRIPT_PATHS.filter((p) => p !== VOICE_PATH)

const INJECT_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(window.__dshWordLearnBoot)return;window.__dshWordLearnBoot=1;' +
  // 动态插入的脚本默认 async=true：大脚本完全可能晚于 client.js 执行，于是 client 的
  // factory 拿到空的依赖（2026-11-05 事故：dashboard-style 的 CSS 迟到 → 整页没样式）。
  // 显式 async=false 恢复「按插入顺序依次执行」，与上面的依赖顺序注释一致。
  'var load=function(src){var s=document.createElement("script");s.src=src;s.async=false;' +
  's.onerror=function(){};d.appendChild(s)};' +
  SCRIPT_PATHS.map(function (p) {
    return 'load("' + p + '");'
  }).join('') +
  '}catch(e){}})()'

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

      disposers.push(...registerAssetRoutes(registerRoute, ctx))
      disposers.push(...registerStudyRoutes(registerRoute, ctx))
      disposers.push(...registerReviewRoutes(registerRoute, ctx))
      disposers.push(...registerAiRoutes(registerRoute, ctx))
      disposers.push(...registerRepairRoutes(registerRoute, ctx))
      disposers.push(...registerAnnotateRoutes(registerRoute, ctx))

      // web 形态兜底（桌面端走不到这里）
      disposers.push(
        ctx.webServer.tapIndex((html) => {
          if (typeof html !== 'string' || html.includes(CLIENT_PATH)) return html
          const tag = INDEX_SCRIPT_PATHS.map((p) => '<script defer src="' + p + '"></script>').join(
            '',
          )
          if (html.includes('</body>')) return html.replace('</body>', tag + '</body>')
          return html + tag
        }),
      )
    })
  },
}
