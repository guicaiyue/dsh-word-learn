// text.js —— 划词文本处理：判断选中的是"一个词"还是"一段话"，并拆出单词。
//
// 这个模块的规则直接来自用户的实际使用场景，不是通用 NLP：
//
//   1. 用户在看模型回答时划词，划到的可能是：
//        - 单个词          -> 直接进学习卡
//        - 短语 / 整句      -> 先给译文，卡片上多一行"拆词学习"
//   2. **代码不能当英文拆**：模型回答里大量行内代码、路径、标识符，
//      把它们当单词查会得到一堆噪音（`getElementById` 查不到，还会污染生词本）。
//   3. **大小写与所有格要归一**：`Model's`、`Models`、`models` 都该归到 `model`。
//   4. 划词常带上标点：`(latent)`、`"throughput,"` —— 前后要剥掉。

/** 单词的最小长度。低于这个长度的英文片段（a, an, of, to, in）不值得建卡。 */
export const MIN_WORD_LEN = 2

/**
 * 把"代码片段"从文本里挖掉，返回剩下的自然语言部分。
 *
 * 为什么必须做：模型回答里到处是代码。实测 `src/lib/index.js` 会被拆成
 * `src`、`lib`、`index`、`js` 四个"单词"，`config_path` 被拆成 `config`+`path`
 * —— 这些都是噪音，查出来没意义，还会污染生词本。
 *
 * 挖掉的东西：
 *   - 围栏代码块与行内代码
 *   - URL、文件路径（含 / 或 \ 的片段）
 *   - 下划线/点号连接的标识符  config_path、obj.method
 *   - 版本号                   3.12、v24.13.0
 */
export function stripCode(text) {
  let out = String(text || '')
  out = out.replace(/```[\s\S]*?```/g, ' ') // 围栏代码块（最大，先处理）
  out = out.replace(/`[^`]*`/g, ' ') // 行内代码
  out = out.replace(/\bhttps?:\/\/\S+/gi, ' ') // URL
  out = out.replace(/\S*[/\\]\S*/g, ' ') // 路径（含 / 或 \）
  out = out.replace(/\b[A-Za-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+)+\b/g, ' ') // 标识符
  out = out.replace(/\bv?\d+(?:\.\d+)+\b/g, ' ') // 版本号
  return out
}

/**
 * 判断一个 token 像不像"值得查的英文单词"。
 *
 * 排除的东西（都是实测会污染生词本的）：
 *   - 纯数字 / 版本号      3.12、v24
 *   - 含下划线的标识符      get_word_id
 *   - 驼峰 / 全大写缩写     getElementById、HTTP、API
 *   - 文件路径与域名        src/lib/index.js、api.example.com
 *   - 单个字母             a、I
 */
export function looksLikeWord(token) {
  if (!token) return false
  const word = String(token).trim()
  if (word.length < MIN_WORD_LEN || word.length > 32) return false

  // 只允许字母，可含内部连字符和撇号
  if (!/^[A-Za-z][A-Za-z'’-]*$/.test(word)) return false

  // 全大写（2 字母以上）通常是缩写：API、HTTP、LLM
  if (word.length >= 2 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)) return false

  // 驼峰：内部有大写字母
  if (/[a-z][A-Z]/.test(word)) return false

  // 至少含一个元音，否则多半是缩写或噪音（如 "nm"、"xyz"）
  if (!/[aeiouy]/i.test(word)) return false

  return true
}

/** 归一化一个词：去首尾标点、小写、统一撇号、去所有格。 */
export function normalizeWord(token) {
  let word = String(token || '').trim()
  // 统一各种撇号字符（模型输出里 ' 和 ' 都会出现）
  word = word.replace(/[\u2018\u2019\u02BC]/g, "'")
  // 去掉首尾非字母
  word = word.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z'’-]+$/, '')
  word = word.toLowerCase()
  // 所有格：model's -> model；复数所有格 models' -> models
  word = word.replace(/'s$/, '').replace(/'$/, '')
  // 连字符在词尾通常是断行，去掉
  word = word.replace(/-+$/, '')
  return word
}

/**
 * 从一段文本里拆出候选单词（去重、保持出现顺序）。
 * `limit` 防止把一整段回答拆出几百个词。
 */
export function splitWords(text, limit = 60) {
  // 先挖掉代码，否则 src/lib/index.js 会变成 src/lib/index/js 四个假词
  const raw = stripCode(text)
  const tokens = raw.match(/[A-Za-z][A-Za-z'’-]*/g) || []
  const seen = new Set()
  const out = []
  for (const token of tokens) {
    if (!looksLikeWord(token)) continue
    const word = normalizeWord(token)
    if (!word || word.length < MIN_WORD_LEN || seen.has(word)) continue
    seen.add(word)
    out.push(word)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 判断划中的内容是不是"单个词"。
 *
 * 规则：整个选区只含一个英文 token（允许首尾标点），且它像单词。
 * 这样 `latent`、`(latent)`、`"latent,"` 都算单词，
 * 而 `latent space`、`the latent` 算短语。
 */
export function classifySelection(text) {
  const raw = String(text || '').trim()
  if (!raw) return { kind: 'empty', word: '', words: [] }

  // 先挖掉代码：划中 `config_path` 不该被当成单词
  const cleaned = stripCode(raw)

  // 选区里的英文 token
  const tokens = cleaned.match(/[A-Za-z][A-Za-z'’-]*/g) || []
  const words = splitWords(raw)

  // 去掉英文 token 和标点/空白后还有没有别的东西（比如中文）
  const residue = cleaned.replace(/[A-Za-z][A-Za-z'’-]*/g, '').replace(/[\s\p{P}\p{S}]/gu, '')

  if (tokens.length === 1 && !residue && looksLikeWord(tokens[0])) {
    const word = normalizeWord(tokens[0])
    if (word.length >= MIN_WORD_LEN) return { kind: 'word', word, words: [word] }
  }

  if (words.length) return { kind: 'phrase', word: '', words }
  return { kind: 'other', word: '', words: [] }
}

/**
 * 从选区里挑出"最值得查的那个词"（用于短语场景的默认推荐）。
 *
 * 策略：取最长的词。理由是在技术文本里，用户划中一段话通常是因为
 * **其中一个不认识的词**，而那个词往往比周围的虚词更长。
 * 这是启发式，前端会把候选全列出来让用户自己选。
 */
export function pickBest(words) {
  if (!Array.isArray(words) || !words.length) return ''
  return words.reduce((best, w) => (w.length > best.length ? w : best), '')
}

export { MIN_WORD_LEN as MIN_LEN }
