// dsh-word-learn —— 宿主侧插件入口。
//
// 职责：
//   ① 往页面注入前端脚本（划词学习卡）
//   ② 提供本地查词接口：查词典 + 取发音例句 + 记进生词本
//
// 架构演进（阶段 2）：前端（划词卡/标注/学习页）已全部并入 bundle `dist/client.js`，
// 由宿主按 package.json 的 `exports["./client"]` 加载 —— 不再往页面注入任何脚本，
// 也就不再需要 index-inject 行、tapIndex 兜底和 8 条静态资源路由。
// 这里只剩数据面：本地查词/写库/发音路由，全部套一层信任栅栏，防跨站请求。
//
// 与参考实现的一个关键区别：**查询在本地完成**（ECDICT SQLite），
// 不依赖任何外部翻译接口，所以离线也能查词；外部只用于补发音和例句，
// 拿不到就降级，功能不残。

import { disposeQueues } from './ai-enrich.js'
import { dict, store } from './runtime.js'
import { fail } from './routes/shared.js'
import type {
  ConnectionFence,
  HostContext,
  RegisterRoute,
  RouteSpec,
  WebRequest,
  WebResponse,
} from './routes/shared.js'
import { registerStudyRoutes } from './routes/study.js'
import { registerReviewRoutes } from './routes/review.js'
import { registerAiRoutes } from './routes/ai.js'
import { registerRepairRoutes } from './routes/repair.js'
import { registerAnnotateRoutes } from './routes/annotate.js'
// P2：R5 次日回访 + 义项地图。逻辑全在 r5.mjs（不碰 FSRS 排期），这里只挂路由。
// P3：对话内联标注的目标词表（只给在学、有卡片的词）。

// ------------------------------------------------------------------ 信任栅栏
// 与 dsh-translate-on-select 同款：自身校验 → 宿主栅栏 → fail-closed。
function makeFence(ctx: HostContext): (req: WebRequest) => number {
  const trusted = String(process.env.DSH_WORD_LEARN_TRUSTED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  function isLoopbackHostname(hostname: unknown): boolean {
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

  function connectionFence(): ConnectionFence | null {
    try {
      const get = ctx.get as (name: string) => unknown
      const conn = (get('connection') || ctx.connection) as ConnectionFence | null | undefined
      return conn && typeof conn.requestRejection === 'function' ? conn : null
    } catch (err) {
      return null
    }
  }

  return function rejection(req: WebRequest): number {
    try {
      const headers = (req && req.headers) || {}
      // 跨站标记一律拒（防恶意网页借浏览器打本机接口）
      if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403

      let hostUrl: URL | null = null
      try {
        hostUrl = new URL('http://' + String(headers.host || ''))
      } catch (err) {
        return 403
      }
      const authority = hostUrl.host.toLowerCase()

      const origin = headers.origin
      if (typeof origin === 'string' && origin && origin !== 'null') {
        let originUrl: URL | null = null
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
      let code: unknown
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

/** cordis 插件入口拿到的宿主 root（外部边界，逐项窄化）。 */
interface HostPluginRoot extends HostContext {
  inject(names: string[], fn: (ctx: HostContext) => void): void
}

export default {
  name: 'dsh-word-learn',
  apply(root: HostPluginRoot): void {
    root.effect(() => () => {
      // 先让后台分析队列停手：否则它们会在 store 关掉之后继续开句柄、写库。
      disposeQueues()
      dict.close()
      store.close()
    })

    // 等 webServer 就绪再挂路由（局部等待，不阻塞插件加载）
    root.inject(['webServer'], (ctx: HostContext) => {
      const rejection = makeFence(ctx)
      const disposers: Array<() => void> = []

      const registerRoute: RegisterRoute = (route: RouteSpec) => {
        const { methods: methodList, ...rest } = route || {}
        const inner = rest.handler
        const methods = Array.isArray(methodList) ? methodList : null
        return ctx.webServer.register({
          ...rest,
          handler: async (req: WebRequest, res: WebResponse) => {
            const code = rejection(req)
            if (code) {
              try {
                res.statusCode = code
                res.end()
              } catch (err) {}
              return
            }
            // 方法白名单：非白名单方法直接 405，别落进 GET 分支顺手把写操作做掉
            if (methods && !methods.includes(req.method as string)) {
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

      disposers.push(...registerStudyRoutes(registerRoute, ctx))
      disposers.push(...registerReviewRoutes(registerRoute, ctx))
      disposers.push(...registerAiRoutes(registerRoute, ctx))
      disposers.push(...registerRepairRoutes(registerRoute, ctx))
      disposers.push(...registerAnnotateRoutes(registerRoute, ctx))
    })
  },
}
