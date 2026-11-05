// tests/integration/support/ctx-stub.ts —— 宿主 `ctx` / `req` / `res` 的语义桩。
//
// 迁移自 scripts/test-routes.mjs / test-model-routes.mjs 里现成的桩，并补上
// `services` 注入（ai-model 测试要假 llm / agentDefaultModel）。桩的目标不是"够用"，
// 是**别把真 bug 盖住**：
//   - res.statusCode 必须可写：信任栅栏直接 `res.statusCode = 403`，用只读桩会把 403 记成 0；
//   - res 要有 headersSent / writableEnded / setHeader / destroy：二次写头、超时 destroy
//     这类 bug 只有桩足够像真的时候才测得出；
//   - req 用真实 Readable：路由里 `readJson(req)` 是按流读 body 的。
//
// ctx 的取服务方式与真实 cordis 一致：只走 `ctx.get(name)`，属性访问不算数
// （把服务同时挂属性上会盖住"只试 ctx[name]"那一类 bug，见 test-ai-model.mjs 头注释）。
import { Readable } from 'node:stream'

export interface RouteDefinition {
  path: string
  handler: (req: FakeRequest, res: FakeResponse) => unknown
  methods?: string[]
  [key: string]: unknown
}

export interface FakeRequest extends Readable {
  url: string
  method: string
  headers: Record<string, string>
}

export interface ResSnapshot {
  code: number
  body: unknown
  headers: Record<string, string | number | string[]>
  ends: number
  writes: number
  destroyed: boolean
  doubleSend: boolean
}

export interface FakeResponse {
  writeHead(code: number, headers?: Record<string, string | number | string[]>): void
  setHeader(key: string, value: string | number | string[]): void
  end(body?: unknown): void
  destroy(): void
  readonly headersSent: boolean
  readonly writableEnded: boolean
  readonly result: ResSnapshot
  statusCode: number
}

export interface CallOptions {
  method?: string
  body?: string | Buffer
  /** 覆盖 req.url（例如路由 path 与真实请求 URL 不同）。 */
  url?: string
  headers?: Record<string, string>
}

export interface CallResult {
  code: number
  json: unknown
  raw: Buffer | null
  headers: Record<string, string | number | string[]>
  ends: number
  writes: number
  doubleSend: boolean
  destroyed: boolean
}

export interface RouteHarnessOptions {
  /** 通过 ctx.get(name) 暴露的服务（llm / agentDefaultModel / connection …）。 */
  services?: Record<string, unknown>
}

export interface RouteHarness {
  routes: Map<string, RouteDefinition>
  routeDefs: RouteDefinition[]
  taps: Array<(table: unknown) => unknown>
  injects: Array<(table: unknown) => unknown>
  table: unknown[]
  ctx: {
    get(name: string): unknown
    connection: unknown
    webServer: {
      register(route: RouteDefinition): () => void
      tapIndex(fn: (table: unknown) => unknown): () => void
    }
    effect(fn: () => unknown): () => void
  }
  root: {
    effect(fn: () => unknown): () => void
    on(event: string, fn: (table: unknown) => unknown): () => void
    inject(deps: string[], fn: (ctx: unknown) => unknown): unknown
  }
  call(path: string, options?: CallOptions): Promise<CallResult>
}

/** 造一个与 test-routes.mjs 等价的路由 harness（插件 apply 后即可 call）。 */
export function createRouteHarness(options: RouteHarnessOptions = {}): RouteHarness {
  const services: Record<string, unknown> = { ...options.services }
  const routes = new Map<string, RouteDefinition>()
  const routeDefs: RouteDefinition[] = []
  const taps: Array<(table: unknown) => unknown> = []
  const injects: Array<(table: unknown) => unknown> = []
  const table: unknown[] = []

  const ctx = {
    get(name: string) {
      return services[name] ?? null
    },
    connection: services.connection ?? null,
    webServer: {
      register(route: RouteDefinition) {
        routes.set(route.path, route)
        routeDefs.push(route)
        return () => {
          routes.delete(route.path)
        }
      },
      tapIndex(fn: (table: unknown) => unknown) {
        taps.push(fn)
        return () => {}
      },
    },
    effect(_fn: () => unknown) {
      return () => {}
    },
  }

  const root = {
    effect(_fn: () => unknown) {
      return () => {}
    },
    on(event: string, fn: (table: unknown) => unknown) {
      if (event === 'webserver/index-inject') injects.push(fn)
      return () => {}
    },
    inject(_deps: string[], fn: (ctx: unknown) => unknown) {
      return fn(ctx)
    },
  }

  function mkRes(): FakeResponse {
    const out: ResSnapshot = {
      code: 0,
      body: '',
      headers: {},
      ends: 0,
      writes: 0,
      destroyed: false,
      doubleSend: false,
    }
    const res: FakeResponse = {
      writeHead(code, headers) {
        if (out.writes > 0 || out.ends > 0) out.doubleSend = true
        out.writes++
        out.code = code
        if (headers) out.headers = { ...out.headers, ...headers }
      },
      setHeader(key, value) {
        out.headers[key] = value
      },
      end(body) {
        out.ends++
        if (!out.code) out.code = res.statusCode || 0
        out.body = body === undefined || body === null ? '' : body
      },
      destroy() {
        out.destroyed = true
      },
      get headersSent() {
        return out.writes > 0
      },
      get writableEnded() {
        return out.ends > 0
      },
      get result() {
        return out
      },
      statusCode: 0,
    }
    Object.defineProperty(res, 'statusCode', {
      get: () => out.code,
      set: (v: number) => {
        out.code = v
      },
    })
    return res
  }

  function mkReq(url: string, method = 'GET', body?: string | Buffer, headers = {}): FakeRequest {
    const stream = Readable.from(
      body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)],
    ) as FakeRequest
    stream.url = url
    stream.method = method
    stream.headers = { host: '127.0.0.1:3080', ...headers }
    return stream
  }

  async function call(path: string, callOptions: CallOptions = {}): Promise<CallResult> {
    const definition = routes.get(path)
    if (!definition) throw new Error(`路由不存在: ${path}`)
    const res = mkRes()
    const req = mkReq(
      callOptions.url || path,
      callOptions.method || 'GET',
      callOptions.body,
      callOptions.headers,
    )
    await definition.handler(req, res)
    const rawBody = res.result.body
    let json: unknown
    try {
      json = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody))
    } catch {
      json = Buffer.isBuffer(rawBody) ? null : rawBody
    }
    return {
      code: res.result.code,
      json,
      raw: Buffer.isBuffer(rawBody) ? rawBody : null,
      headers: res.result.headers || {},
      ends: res.result.ends,
      writes: res.result.writes,
      doubleSend: res.result.doubleSend,
      destroyed: res.result.destroyed,
    }
  }

  return {
    routes,
    routeDefs,
    taps,
    injects,
    table,
    ctx,
    root,
    call,
  }
}
