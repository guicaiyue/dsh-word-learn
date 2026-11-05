// ai-enrich.mjs —— AI 分析（词级/义项）、出题、后台队列的**门面**。
//
// 在用户第一次遇见一个词时（touch），后台异步调用 LLM 分析：
//   - 词根词缀拆解 / 近义词 / 干扰项（看起来像对的但其实不是这个词的意思）
//   - 记忆方法 / 关联场景 / 易混淆词
// 结果写入 words.word_meta（JSON），供复习时的选择题和记忆提示使用。
//
// 2026-11-05 按职责拆到 lib/enrich/（拆分前 589 代码行，超 CODE_BUDGET 620）：
//   queue.mjs     后台队列：串行调度、去重、上限、disposeQueues、enqueue*
//   analysis.mjs  词级分析：提示词、JSON 解析容错、归一化成 word_meta（含 _provider/_model）
//   sense.mjs     义项分析：提示词、质量闸门、normalizeSenseMeta
//   llm.mjs       模型调用：超时/重试/失败翻译、AnalysisError
//   quiz.mjs      选择题生成（正确项取词典、干扰项取 word_meta/生词本）
//   text.mjs      共用纯函数：拆释义、忽略空白的包含比对、洗牌
//
// **本文件只做再导出**：现有 import 路径与导出名一律不变
// （index.js / lookup.mjs / routes/ai.mjs / routes/repair.mjs / test-ai-model 都从这里取）。
// 新增能力请加到对应子模块，再在这里补一行；不要在这里写业务逻辑。
//
// 设计约束（拆分时原样保留）：
//   1. AI 分析是**增强**，不是前置条件。分析失败/还没跑完时，
//      复习流程降级为纯释义展示，功能不残。
//   2. 每个词只分析一次（word_meta 非空就跳过），节省 token。
//   3. 用进程内队列串行执行，避免并发打爆模型配额。
//   4. 用哪个模型由 models.mjs 决定（DSH 模型目录里用户选的那个，默认第一个），
//      不再跟随会话的默认模型。
//   5. 失败必须说清楚为什么（见 AnalysisError）：界面上的
//      "AI 分析失败，可能是模型不可用" 曾经把「拿不到 llm 服务」「JSON 没解析出来」
//      「限流」「没配 API Key」全糊成一句话，排查只能靠猜。
//
// 服务取法见 service.mjs —— 必须用 ctx.get('llm')，属性访问 ctx.llm 拿不到。
export { AnalysisError, extractJson } from './enrich/llm.mjs'
export { analyzeWord, parseResponse } from './enrich/analysis.mjs'
export { analyzeSense, normalizeSenseMeta } from './enrich/sense.mjs'
export { disposeQueues, enqueueAnalysis, enqueueSenseAnalysis } from './enrich/queue.mjs'
export { generateQuiz } from './enrich/quiz.mjs'
