/* dsh-word-learn —— 标注层的配置与常量（构建源码，ESM）。
 *
 * 原先在注入脚本 assets/annotate.js 里的 CONFIG 字面量与 mergeConfig()。拆成独立模块
 * 只为一件事：./tokenize.js（纯函数）和 ./index.js（DOM 层）共用同一份配置。
 *
 * 约束：只放常量与纯函数，不碰 DOM、不注册监听。排除范围的共同项只从 ../core.js
 * import（BLOCKED_ELEMENTS），绝不在这里另抄一份名单 —— 改一边两边同时生效。
 */
import CORE from '../core.js'

export const CONFIG = {
  VERSION: '1.0.0',

  // 开关：localStorage['dwl-annotate'] === 'off' 关闭；缺省/其它值 = 开。
  STORAGE_KEY: 'dwl-annotate',
  STORAGE_OFF: 'off',

  // ---- 范围发现（白名单）----
  // DSH 的对话流锚点。wordcard.js 的 SCOPE_SELECTOR 也是它（划词卡片与标注层共用同一根）。
  ROOT_SELECTOR: '[data-chat-flow]',
  // 一条消息/一个步骤 = 一个块。块是"分类 + 限额 + 可见性"的最小单位。
  // 两个选择器是同一批节点：真实 DOM 里 flowItem 同时带 data-chat-node-key；
  // 保留类名兜底是为了 DSH 换版本后属性丢了也能工作（Lead 在第二实例上确认了类名）。
  BLOCK_SELECTOR: '[data-chat-node-key], .EvIC1a_flowItem',
  KIND_ATTR: 'data-chat-flow-kind',
  GROUP_PART_ATTR: 'data-chat-group-part',
  // 助手回答/用户消息的正文容器（slot 是语义标识，不是哈希类名，跨版本稳定）。
  CONTENT_SLOT: '[data-slot="conversation.chat.node"]',
  // 思考块：data-variant=think，展开后才有 data-expanded。
  REASONING_SELECTOR: '[data-variant="think"]',
  REASONING_EXPANDED: '[data-variant="think"][data-expanded]',

  // 标的类型白名单：只标自然语言消息。
  // 为什么排除 tool-call / context / compaction / turn-process / turn-tail：
  // 它们是工具调用、上下文压缩提示、耗时行 —— 内容由命令、路径、JSON 组成，
  // 既不是"阅读材料"，hover 卡也会打断操作。
  ALLOWED_KINDS: ['user', 'assistant-step'],

  // ---- 黑名单（容器级）----
  // 命中即整棵子树跳过。顺序无所谓，合成一个选择器后交给 closest()/matches()。
  // 共同项（pre / code / .md-code-block / a / [data-ref-chip] / button / table）
  // 只在 core.js 的 BLOCKED_ELEMENTS 里维护；这里只列标注层特有项，避免双口径。
  BLACKLIST: CORE.BLOCKED_ELEMENTS.concat([
    // 工具/文件预览里的代码容器（pre / code 在共同项里，不重复列）。
    '[data-code-wrap]',
    '[data-code-block-banner]',
    // 交互控件：原生 button 在共同项里。
    // 注意**不能**黑名单 [role="button"]：DSH 的思考/过程折叠行是
    // div[role="button"][data-disclosure-row]，它的文本正是"折叠框标题"
    // （要求：未展开的折叠框只处理标题），黑掉它等于真实页面上一律 0 标注。
    // 表格：table 在共同项里；.md-table-wide 是标注层额外的保守排除
    // （v1 悬停卡在密集表格里容易挡视线，后续可配置放开）。
    '.md-table-wide',
    // 流式与折叠：DSH 用 hidden="until-found" 藏起未展开的 process 组；
    // [data-streaming] 是 AssistantMarkdown / 思考摘要的流式标记。
    '[hidden]',
    '[data-streaming]',
    '[data-chat-running]',
    // 折叠框：**不黑名单** [aria-expanded="false"] / [data-disclosure-header] /
    // [data-variant="think"]:not([data-expanded])。
    // 真实 DOM 里折叠行本身（aria-expanded=false 的 role=button 行、disclosure header、
    // data-variant=think 的预览行）装的就是"标题"；折叠的正文由 [hidden] /
    // 未渲染的 panel 兜住。黑名单只保留 [hidden]。
    // 原生 <details>（其它插件/未来 DSH 可能用）：未展开时只留 summary 可标。
    'details:not([open]) > :not(summary)',
    // 其它插件弹窗 / 内联交互卡（审批、提问、计划评审）、输入区、任务面板。
    '[data-composer-seat]',
    '[data-composer-card]',
    '[data-testid="todo-panel"]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="tooltip"]',
    '[data-approval-key]',
    '[data-question-key]',
    '[data-plan-review-key]',
    // 我们自己的产物（重扫时不要钻进自己的 span/卡片）。
    '.dwl-anno',
    '.dwlac',
  ]),

  // ---- 流式/稳定性 ----
  // 三重判定（保守优先）：
  //   1. 权威标记 [data-streaming]（DSH 源码里 AssistantMarkdown 流式时会挂）；
  //   2. 本块文本 800ms 无变化（MutationObserver 会不断把变化重排进稳定性判定）；
  //   3. 页面正在跑（有 [data-chat-running]）时，当前回合 DOM 里的最后一块一律跳过
  //      —— 对应 Lead 实测的"最后一条消息还在增长"。
  STABLE_MS: 800,
  DEBOUNCE_MS: 250,

  // ---- 性能限额 ----
  PER_BLOCK_MAX: 60, // 单块最多标多少个词
  GLOBAL_MAX: 800, // 整页最多多少个 span
  BLOCK_TEXT_MAX: 12000, // 超过这个长度的块根本不扫（长表格/长日志）
  MAX_TEXT_NODES: 600, // 单块最多扫多少个文本节点
  MIN_WORD_LEN: 2,
  MAX_WORD_LEN: 32,
  IO_ROOT_MARGIN: '400px 0px',

  // ---- 数据接口 ----
  // 词表：Lead 在 index.js 挂。首选插件命名空间下的路径；万一挂的是短路径也能自愈。
  WORDS_PATHS: ['/dsh-word-learn/annotate/words', '/annotate/words'],
  // 入库/收进复习：复用已有的查词路由（POST JSON { word, sentence, save, enrich }）。
  CAPTURE_PATH: '/dsh-word-learn/lookup',
  WORDS_TIMEOUT_MS: 4000,
  WORDS_TTL_MS: 5 * 60 * 1000,
  WORDS_RETRY_BASE_MS: 20000,
  WORDS_RETRY_MAX_MS: 5 * 60 * 1000,
}

// 允许外部（测试/宿主）在脚本加载后微调，再调用 refresh 生效。
export function mergeConfig(overrides) {
  if (!overrides || typeof overrides !== 'object') return
  for (const key in overrides) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue
    if (key === 'BLACKLIST' || key === 'ALLOWED_KINDS' || key === 'WORDS_PATHS') continue
    CONFIG[key] = overrides[key]
  }
}

/**
 * 合并后的容器黑名单选择器。
 *
 * BLACKLIST 不允许被 mergeConfig() 覆盖（见上面 mergeConfig 的守卫），所以可以在
 * 模块期算一次；选择器顺序与逐条 matches 等价，不影响行为。
 */
export const BLACKLIST_SEL = CONFIG.BLACKLIST.join(',')
