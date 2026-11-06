// routes/shared.mjs —— 路由层的公共出口与入参工具。
//
// 三条硬约束（都是踩过的坑）：
//   1. 响应只从这里出：`safeSend` 已发过就什么都不做，绝不二次写头；
//   2. 错误只回稳定 code + 中文人话，原始 message 常带用户库绝对路径，只能进日志；
//   3. 请求体必须是 JSON 对象（空 body / 数组 / 标量在 readJson 就抛，交给 400 分支）；
//   4. 数字只从一个口子进：query 走 `http.mjs` 的 `intParam`，请求体走 `http.mjs` 的
//      `clampInt`（同语义，入参是值）。`clampInt` 归口在 http.mjs（零依赖纯函数），
//      本文只再导出，业务模块（如 r5.ts）直接 import `../http.js`，不许依赖 routes 层。
//
// 公共出口保持不变：`import { clampInt } from './shared.mjs'` 照旧可用。
// 实现与语义说明见 `../http.ts`（与 intParam 同归口）。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServiceHost } from '../service.js'

export { clampInt } from '../http.js'

/** 路由处理器收到的请求/响应（DSH webServer 透传的 node http 对象）。 */
export interface WebRequest extends IncomingMessage {
  url: string
}
export type WebResponse = ServerResponse

/** 宿主 ctx 的 connection 服务里本插件用到的部分。 */
export interface ConnectionFence {
  requestRejection(req: WebRequest): unknown
}

/** 宿主 ctx 里本插件用到的部分（外部边界，逐项窄化）。 */
export interface HostContext extends ServiceHost {
  connection?: ConnectionFence | null
  effect(fn: () => () => void): void
  webServer: {
    register(route: Record<string, unknown>): () => void
  }
  inject(names: string[], fn: (ctx: HostContext) => void): void
}

/** 路由模块拿到的 ctx（只需要取服务）。 */
export type RouteContext = ServiceHost

/** registerRoute 的入参：路径 + 方法白名单 + 处理器。 */
export interface RouteSpec {
  kind?: string
  path: string
  methods?: string[]
  handler: (req: WebRequest, res: WebResponse) => unknown
}

/** 带栅栏 / 方法白名单 / 500 兜底的注册器（index.ts 提供）。 */
export type RegisterRoute = (route: RouteSpec) => () => void

/**
 * 唯一的响应出口：已发过就什么都不做，绝不二次写头。
 * 返回 true 表示这次真的发出去了。
 */
export function safeSend(
  res: WebResponse | null | undefined,
  code: number,
  payload: unknown,
): boolean {
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

export function sendJson(res: WebResponse, code: number, payload: unknown): boolean {
  return safeSend(res, code, payload)
}

/**
 * 对外错误出口：只回稳定 code + 一句人话。
 * 原始 message 常带用户库的绝对路径，只能进日志，不能给浏览器。
 */
export function fail(
  res: WebResponse,
  code: number,
  errorCode: string,
  message: string,
  err?: unknown,
): boolean {
  if (err !== undefined) {
    try {
      const cause = err as { message?: unknown } | null
      console.warn(
        '[dsh-word-learn] ' + errorCode + '：' + ((cause && cause.message) || String(err)),
      )
    } catch (e) {}
  }
  return safeSend(res, code, { ok: false, code: errorCode, error: message })
}

/** 用户库打不开时的统一响应（store.error 含绝对路径，不回给浏览器）。 */
export function unavailable(
  res: WebResponse,
  storeLike: { error?: unknown } | null | undefined,
): boolean {
  try {
    console.warn(
      '[dsh-word-learn] 用户库不可用：' + String((storeLike && storeLike.error) || '未知原因'),
    )
  } catch (e) {}
  return safeSend(res, 500, { ok: false, code: 'DB_UNAVAILABLE', error: '用户库暂时不可用' })
}

/** GET query 的布尔值：'false'/'0'/0/false 都算 false（'false' !== false 踩过）。 */
export function isFalse(v: unknown): boolean {
  return v === false || v === 'false' || v === 0 || v === '0'
}

export function readBody(req: WebRequest, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
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

export async function readJson(req: WebRequest): Promise<Record<string, unknown>> {
  const text = await readBody(req)
  const value = text.trim() ? JSON.parse(text) : null
  // 空 body / JSON null / 数组 / 标量都不是合法请求体：在这里就抛，
  // 让调用方现有的 400 分支接管；否则 payload.xxx 会变成 TypeError → 500。
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}
