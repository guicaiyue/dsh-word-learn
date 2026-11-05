// enrich/llm.mjs —— 模型调用层：超时、重试、把适配器失败翻译成人话。
//
// 从 ai-enrich.mjs 拆出来的（2026-11-05，原文件超 CODE_BUDGET）。这里只管
// 「怎么问模型、怎么把失败说清楚」，不关心问的是词义还是义项：
//   - analysis.mjs / sense.mjs 各自传 system + prompt 进来；
//   - 返回**原始 JSON 对象**，字段校验在各自的 normalize 里（见 runModel 注释）。
//
// 为什么单独一层：AnalysisError / FAILURE_HINTS / reason 是分析、义项、队列共用的
// 错误语义。放回任一业务文件，另一个就得 import 业务文件——那正是要避免的方向。
import { getService } from '../host/service.js'
import { resolveAiModel } from '../host/models.js'

/** 单次分析的超时。够慢模型跑完，又不至于让「重新分析」按钮一直转。 */
const ANALYSIS_TIMEOUT_MS = 45000

/** 分析失败。code 给调用方分流，message 直接给用户看。 */
export class AnalysisError extends Error {
  constructor(message, code = 'ANALYSIS_FAILED') {
    super(message)
    this.name = 'AnalysisError'
    this.code = code
  }
}

/** 模型失败码 → 人话。没列到的码直接把原始 message 给出去。 */
const FAILURE_HINTS = {
  NO_ADAPTER: '模型路由没注册（provider 名对不上）',
  MISSING_CREDENTIAL: '没有配置 API Key',
  INVALID_CREDENTIAL: 'API Key 格式不合法',
  AUTH: '认证失败（API Key 无效或过期）',
  RATE_LIMIT: '被模型服务限流',
  QUOTA: '模型额度已用完',
  ACCOUNT_QUOTA: '账户余额不足',
  CONTEXT_WINDOW_EXCEEDED: '上下文超出模型的窗口',
  TIMEOUT: '请求超时',
  TRANSPORT: '网络不通',
  INVALID_REQUEST: '请求被模型服务拒绝',
}

/** 单次生成的输出上限。1500 对带思考的模型不够——思考 token 也算在 maxTokens 里。 */
const MAX_OUTPUT_TOKENS = 4000
/** 截断/空响应时重试一次的更高上限。 */
const RETRY_OUTPUT_TOKENS = 8000
/** 这两类失败换更大预算重试一次有意义；鉴权、限流、非 JSON 重试没用。 */
const RETRYABLE = new Set(['TRUNCATED', 'EMPTY_RESPONSE'])

/**
 * 跑一次模型调用（含重试与超时），返回**原始 JSON 对象**。
 *
 * word_meta 与 sense_meta 共用这一层；各自的字段校验放在自己的 normalize 里。
 * 为什么分开：`parseResponse` 过去顺手把结果归一化成 word_meta，义项分析
 * 用同一套字段校验会被直接判成"不是合法 JSON"。
 */
export async function runModel(ctx, { system, prompt, selection }) {
  const llm = getService(ctx, 'llm')
  if (!llm || typeof llm.prepareCall !== 'function') {
    throw new AnalysisError(
      'DSH 的模型服务不可用（插件拿不到 ctx.llm），AI 分析没法发起',
      'NO_LLM_SERVICE',
    )
  }

  const chosen = selection || (await resolveAiModel(ctx, null))
  if (!chosen || !chosen.provider || !chosen.model) {
    throw new AnalysisError('没有可用的模型：DSH 模型目录为空，会话也没有默认模型', 'NO_MODEL')
  }

  const state = { timedOut: false }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    state.timedOut = true
    controller.abort()
  }, ANALYSIS_TIMEOUT_MS)

  try {
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await runAttempt({
          llm,
          chosen,
          system,
          prompt,
          signal: controller.signal,
          maxTokens: attempt === 0 ? MAX_OUTPUT_TOKENS : RETRY_OUTPUT_TOKENS,
          state,
        })
      } catch (err) {
        lastError = err
        // 只对"被截断 / 空响应"再试一次，别的失败（鉴权、限流、坏 JSON）重试也没用
        if (!(err instanceof AnalysisError) || !RETRYABLE.has(err.code)) throw err
      }
    }
    throw lastError
  } finally {
    clearTimeout(timer)
  }
}

/** 跑一次完整的模型调用：准备 → 流式收文本 → 解析出原始 JSON。 */
async function runAttempt({ llm, chosen, system, prompt, signal, maxTokens, state }) {
  let call
  try {
    call = await llm.prepareCall(
      { provider: chosen.provider, model: chosen.model, maxTokens },
      signal,
      (controls) => controls,
    )
  } catch (err) {
    if (state.timedOut) throw timeoutError(chosen)
    throw new AnalysisError(`模型 ${label(chosen)} 调用准备失败：${reason(err)}`, 'PREPARE_FAILED')
  }
  if (!call || typeof call.stream !== 'function') {
    throw new AnalysisError(`模型 ${label(chosen)} 没有返回可用的调用句柄`, 'NO_STREAM')
  }

  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const options = {
    ...call.config,
    messages,
    system,
    signal,
  }

  let out = ''
  let finish = null
  try {
    for await (const chunk of call.stream(options)) {
      if (!chunk) continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      // 终止块：适配器把失败放在 reason 里，不读它就只剩空输出
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (err) {
    if (state.timedOut) throw timeoutError(chosen)
    throw new AnalysisError(`模型 ${label(chosen)} 调用失败：${reason(err)}`, 'STREAM_FAILED')
  }

  if (finish && finish.kind === 'error') throw failureError(finish.failure, chosen)
  if (finish && finish.kind === 'aborted') {
    if (state.timedOut) throw timeoutError(chosen)
    throw new AnalysisError(`模型 ${label(chosen)} 的调用被中止`, 'ABORTED')
  }

  const text = out.trim()
  if (!text) {
    throw new AnalysisError(`模型 ${label(chosen)} 没有返回任何内容`, 'EMPTY_RESPONSE')
  }

  const parsed = extractJson(text)
  if (!parsed) {
    const truncated = finish && finish.kind === 'max-tokens'
    throw new AnalysisError(
      (truncated
        ? `模型 ${label(chosen)} 的输出被截断（maxTokens 不够），不是完整 JSON`
        : `模型 ${label(chosen)} 返回的不是合法 JSON`) + `：${preview(text)}`,
      truncated ? 'TRUNCATED' : 'BAD_JSON',
    )
  }

  parsed._provider = chosen.provider
  parsed._model = chosen.model
  return parsed
}

function timeoutError(chosen) {
  return new AnalysisError(
    `模型 ${label(chosen)} 超过 ${Math.round(ANALYSIS_TIMEOUT_MS / 1000)} 秒没返回，已中止`,
    'TIMEOUT',
  )
}

// ---------------------------------------------------------------- 内部

function label(chosen) {
  return `${chosen.provider}/${chosen.model}`
}

export function reason(err) {
  return (err && (err.message || String(err))) || '未知错误'
}

/** 把 LLM 的终止失败翻译成人话。 */
function failureError(failure, chosen) {
  const f = failure || {}
  const code = String(f.code || 'LLM_ERROR')
  const hint = FAILURE_HINTS[code] || f.message || '模型调用失败'
  const raw = f.message && f.message !== hint ? `：${f.message}` : ''
  const meta = [f.status ? 'HTTP ' + f.status : '', code].filter(Boolean).join('，')
  return new AnalysisError(`模型 ${label(chosen)} 调用失败：${hint}${raw}（${meta}）`, code)
}

/** 截断回显，用来判断模型到底吐了什么。 */
function preview(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine
}

/** 从模型输出里抠出原始 JSON 对象（不做字段校验）。 */
export function extractJson(text) {
  if (!text) return null

  const raw = String(text).trim()

  // 1. 先按原文解析（模型听话时的快路径）
  const direct = parseJson(raw)
  if (direct) return direct

  // 2. 去掉 markdown 代码块再试
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw)
  if (fence) {
    const fromFence = parseJson(fence[1].trim())
    if (fromFence) return fromFence
  }

  // 3. 前后有解释文字：抠第一个配平的 {...}
  const embedded = extractFirstObject(raw)
  if (embedded) {
    const fromEmbedded = parseJson(embedded)
    if (fromEmbedded) return fromEmbedded
  }

  return null
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 从任意文本里抠出第一个括号配平的 JSON 对象；跳过字符串里的括号与转义。 */
function extractFirstObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
