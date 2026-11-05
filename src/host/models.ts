// models.mjs —— AI 分析用哪个模型：复用 DSH 自己的模型目录，默认取第一个。
//
// 为什么不用 ctx.agentDefaultModel：
//   那是"会话当前默认"（在对话页顶部切换的那个）。用户想在英语学习里固定用
//   便宜/快的模型，同时会话继续用大模型，这两个选择就该分开。原来的实现直接
//   复用 agentDefaultModel，导致在这里没法选、也没法看全 DSH 里有哪些模型。
//
// 模型清单从 DSH 的注册表来，和 GUI 的模型选择器同源：
//   ctx.llm.listProviders() → [{ id, name }]
//   ctx.llm.listModels(provider.id) → [{ provider, id, name, description?, inputModalities? }]
// 不自己维护一份模型名单——DSH 里配了什么适配器，这里就列得出什么，
// 装了新适配器不用改插件代码。
//
// 默认值：模型目录里的第一个（listProviders 的注册顺序 × listModels 的顺序）。
// 这个顺序由适配器决定；对单适配器部署就是第一个可用模型。
// 用户自选的模型存在 user.db 的 settings 表里；自选的模型在目录里消失了
// （换了适配器 / 删了模型）就自动退回第一个，不让插件卡在不可用的选择上。

import { getService, type ServiceHost } from './service.js'

/** 设置读写用到的最小能力子集（lib/store.mjs 的 Store 满足它）。 */
export interface ModelSettingsStore {
  getSetting?(key: string): string | null | undefined
  setSetting?(key: string, value: string): boolean
  deleteSetting?(key: string): boolean
}

/** DSH 模型服务的最小接口；返回值形态由 DSH 决定，逐项窄化（外部未类型化边界）。 */
interface LlmService {
  listProviders(): unknown
  listModels(provider: string): Promise<unknown>
}

/** 会话默认模型服务的最小接口（外部服务边界）。 */
interface AgentDefaultModelService {
  currentSelection?(): { provider?: string; model?: string } | null
}

/** DSH 模型目录里的适配器条目（外部未类型化输入，逐字段读取后窄化）。 */
interface DshProviderEntry {
  id?: unknown
  name?: unknown
}

/** DSH 模型目录里的模型条目（外部未类型化输入，逐字段读取后窄化）。 */
interface DshModelEntry {
  id?: unknown
  name?: unknown
  description?: unknown
  inputModalities?: unknown
}

/** 目录里一个可用的文本模型。 */
export interface TextModelInfo {
  provider: string
  providerName: string
  id: string
  name: string
  description: string
}

/** 拉目录失败的适配器。 */
export interface ModelFailure {
  provider: string
  error: string
}

/** 一次目录快照：可用模型 + 失败适配器。 */
export interface TextModelCatalog {
  models: TextModelInfo[]
  failures: ModelFailure[]
}

/** 用户自选的模型（settings 里 ai_model 的解析结果）。 */
export interface SavedModelSelection {
  provider: string
  model: string
}

/** resolveAiModel 的完整结果（source 表示这次是从哪条路选出来的）。 */
export interface ResolvedAiModel {
  provider: string
  model: string
  name: string
  providerName: string
  source: 'custom' | 'default' | 'agent' | 'none'
  saved: boolean
  models: TextModelInfo[]
  failures: ModelFailure[]
}

/** 给前端的精简结果（不重复带整张模型表）。 */
export interface PublicModelSelection {
  provider: string
  model: string
  name: string
  providerName: string
  source: string
}

/** settings 表里存自选模型的键；值是一个 JSON 字符串 { provider, model }。 */
const SETTING_KEY = 'ai_model'

/** 从 cordis 上下文里取服务（取法见 service.mjs：服务只在 ctx.get 上）。 */
function service(ctx: ServiceHost | null | undefined, name: string): unknown {
  return getService(ctx, name) || undefined
}

/**
 * 这个模型能不能吃文本输入。
 *
 * `inputModalities` 缺省表示"适配器没声明"，按可用算（目录本来就以对话模型为主）；
 * 显式声明了但不含 text（例如纯图像模型）才排除。判断放到这里而不是算在调用方，
 * 是因为"文本模型列表"是这个模块的对外承诺。
 */
function isTextModel(model: unknown): boolean {
  const modalities =
    model && typeof model === 'object'
      ? (model as { inputModalities?: unknown }).inputModalities
      : model
  if (!Array.isArray(modalities) || modalities.length === 0) return true
  return modalities.includes('text')
}

/**
 * 拉一份 DSH 当前的文本模型清单。
 *
 * 单个适配器报错不拖垮整张表：把它记进 `failures`，其它适配器的模型照列。
 *
 * @returns {Promise<{models: Array<{provider,providerName,id,name,description}>, failures: Array<{provider,error}>}>}
 */
export async function listTextModels(
  ctx: ServiceHost | null | undefined,
): Promise<TextModelCatalog> {
  const llm = service(ctx, 'llm') as LlmService | null
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { models: [], failures: [{ provider: '', error: 'DSH 模型服务不可用（ctx.llm 缺失）' }] }
  }

  let providers: unknown
  try {
    providers = llm.listProviders()
  } catch (err: any) {
    return { models: [], failures: [{ provider: '', error: (err && err.message) || String(err) }] }
  }
  if (!Array.isArray(providers)) providers = []

  const models: TextModelInfo[] = []
  const failures: ModelFailure[] = []

  for (const provider of providers as DshProviderEntry[]) {
    const providerId = String((provider && provider.id) || '')
    if (!providerId) continue
    try {
      const list = await llm.listModels(providerId)
      for (const model of (Array.isArray(list) ? list : []) as DshModelEntry[]) {
        if (!model || typeof model.id !== 'string' || !model.id) continue
        if (!isTextModel(model)) continue
        models.push({
          provider: providerId,
          providerName: String((provider && provider.name) || providerId),
          id: model.id,
          name: String(model.name || model.id),
          description: typeof model.description === 'string' ? model.description : '',
        })
      }
    } catch (err: any) {
      failures.push({ provider: providerId, error: (err && err.message) || String(err) })
    }
  }

  return { models, failures }
}

/** 读用户自选的模型。返回 `{ provider, model }` 或 null（没选过／库坏了）。 */
export function readSavedSelection(
  store: ModelSettingsStore | null | undefined,
): SavedModelSelection | null {
  if (!store || typeof store.getSetting !== 'function') return null
  const raw = store.getSetting(SETTING_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.provider !== 'string' || typeof parsed.model !== 'string')
      return null
    if (!parsed.provider || !parsed.model) return null
    return { provider: parsed.provider, model: parsed.model }
  } catch (err) {
    return null
  }
}

/** 存用户自选的模型。 */
export function saveSavedSelection(
  store: ModelSettingsStore | null | undefined,
  provider: unknown,
  model: unknown,
): boolean {
  if (!store || typeof store.setSetting !== 'function') return false
  return store.setSetting(
    SETTING_KEY,
    JSON.stringify({ provider: String(provider), model: String(model) }),
  )
}

/** 清掉自选模型，回到"目录里第一个"。 */
export function clearSavedSelection(store: ModelSettingsStore | null | undefined): boolean {
  if (!store || typeof store.deleteSetting !== 'function') return false
  return store.deleteSetting(SETTING_KEY)
}

/**
 * 决定这次 AI 分析用哪个模型。
 *
 * 优先级：
 *   1. 用户自选，且它仍在模型的目录里；
 *   2. 目录里第一个（**默认**）；
 *   3. 目录整个拿不到时，退回 agentDefaultModel 的当前选择 ——
 *      至少还能分析，不让设置页的显示变成空。
 *
 * @param ctx - 插件上下文
 * @param store - 用户库（读 self 选设置；可为 null）
 * @param catalog - 可选的已拉取目录（避免同一次请求里拉两遍）
 * @returns {Promise<{provider,model,name,providerName,source,models,failures,saved}>}
 *   source: 'custom' 自选 | 'default' 目录第一个 | 'agent' 退回会话默认 | 'none' 无可用模型
 */
export async function resolveAiModel(
  ctx: ServiceHost | null | undefined,
  store: ModelSettingsStore | null | undefined,
  catalog?: TextModelCatalog,
): Promise<ResolvedAiModel> {
  const list = catalog || (await listTextModels(ctx))
  const models = list.models || []
  const failures = list.failures || []
  const saved = readSavedSelection(store)

  if (saved) {
    const hit = models.find((m) => m.provider === saved.provider && m.id === saved.model)
    if (hit) {
      return {
        provider: hit.provider,
        model: hit.id,
        name: hit.name,
        providerName: hit.providerName,
        source: 'custom',
        saved: true,
        models,
        failures,
      }
    }
  }

  if (models.length) {
    const first = models[0]
    return {
      provider: first.provider,
      model: first.id,
      name: first.name,
      providerName: first.providerName,
      source: 'default',
      saved: false,
      models,
      failures,
    }
  }

  // 目录不可用：退回会话默认模型，只为了"还能分析"
  const defaults = service(ctx, 'agentDefaultModel') as AgentDefaultModelService | null
  let selection: { provider?: string; model?: string } | null = null
  if (defaults && typeof defaults.currentSelection === 'function') {
    try {
      selection = defaults.currentSelection()
    } catch (err) {
      selection = null
    }
  }
  if (selection && selection.provider && selection.model) {
    return {
      provider: selection.provider,
      model: selection.model,
      name: selection.model,
      providerName: selection.provider,
      source: 'agent',
      saved: false,
      models,
      failures,
    }
  }

  return {
    provider: '',
    model: '',
    name: '',
    providerName: '',
    source: 'none',
    saved: false,
    models,
    failures,
  }
}

/** 把解析结果裁成前端需要的形状（不重复带整张模型表）。 */
export function publicSelection(resolved: ResolvedAiModel): PublicModelSelection {
  return {
    provider: resolved.provider || '',
    model: resolved.model || '',
    name: resolved.name || '',
    providerName: resolved.providerName || '',
    source: resolved.source || 'none',
  }
}

/** 自选模型是否仍在目录里——设置页用它提示"你选的模型没了，已退回默认"。 */
export function savedSelectionLost(
  store: ModelSettingsStore | null | undefined,
  models: TextModelInfo[] | null | undefined,
): SavedModelSelection | null {
  const saved = readSavedSelection(store)
  if (!saved) return null
  const hit = (models || []).some((m) => m.provider === saved.provider && m.id === saved.model)
  return hit ? null : saved
}
