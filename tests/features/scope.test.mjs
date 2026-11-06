// @vitest-environment node
// 测什么：标注层「生效范围 / 排除范围」的单一来源 —— core.js 的范围判定与共同排除名单、
// annotate 模块如何消费这份名单，以及标注自己的白名单根 / 块类型 / 黑名单边界。
//
// 为什么重要：范围判错两头都伤 —— 标到侧栏、输入框、弹窗（骚扰），或标进代码、链接、
// 路径、网址（污染）。这些容器名单以前在 assets/core.js 与 assets/annotate.js 里各写一份，
// 改一边忘一边就会双口径；阶段 2 起两者都是 bundle 内模块，annotate 只 import core 的那一份。
//
// 迁移自 scripts/test-scope.mjs 的「锚点 / 应当生效 / 不应生效 / 划词排除范围 /
// 排除范围单一来源 / 标注层与划词共用同一份排除名单」几段。voice、wordcard、注入顺序
// 属于别的模块或别的迁移任务（注入顺序已由 bundle 的 import 图取代），不在本文件。
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import CORE from '../../src/client/features/core.js'
import { annotate, internals } from '../../src/client/features/annotate/index.js'

const { BLACKLIST_SEL, CONFIG } = internals
const ANNOTATE_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'client',
  'features',
  'annotate',
)

/** annotate 目录下各模块的源码（静态契约断言用）。 */
function annotateSources() {
  return fs
    .readdirSync(ANNOTATE_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(ANNOTATE_DIR, f), 'utf8') }))
}

// ---- 极小的 DOM 桩（只实现本站断言用到的 closest）----------------------------
/** 造一个元素；attrs 是它自己带的属性集合。 */
function el(name, attrs = {}, parent = null) {
  return {
    nodeType: 1,
    name,
    attrs,
    parentElement: parent,
    closest(selector) {
      const key = /^\[([a-z-]+)\]$/.exec(selector)
      if (!key) throw new Error('桩不支持的选择器: ' + selector)
      let cur = this
      while (cur) {
        if (Object.prototype.hasOwnProperty.call(cur.attrs, key[1])) return cur
        cur = cur.parentElement
      }
      return null
    },
  }
}

/** 文本节点（nodeType 3）：只有 parentElement，没有 closest。 */
function text(parent) {
  return { nodeType: 3, parentElement: parent }
}

// 真实结构（取自 dsh 0.2.1-rc.2 的官方前端包）：
//   body
//   ├─ aside 左栏                      （无 data-chat-flow）
//   ├─ div[data-conversation-content]  （整个对话面板）
//   │   └─ div[data-chat-flow]         （Chat 视图正文列）
//   │       └─ div[data-step-process-content][data-chat-flow]  （助手步骤过程，嵌套）
//   └─ aside 右栏                      （无 data-chat-flow）
const body = el('body')
const leftbar = el('aside', {}, body)
const rightbar = el('aside', {}, body)
const convContent = el('div', { 'data-conversation-content': '' }, body)
const chatFlow = el('div', { 'data-chat-flow': '' }, convContent)
const stepProcess = el('div', { 'data-step-process-content': '', 'data-chat-flow': '' }, chatFlow)
const stepText = text(stepProcess)
const msgText = text(chatFlow)
const leftText = text(leftbar)
const rightText = text(rightbar)

describe('生效范围：只认对话正文 [data-chat-flow]', () => {
  test('锚点就是 data-chat-flow', () => {
    assert.equal(CORE.SCOPE_SELECTOR, '[data-chat-flow]')
    // 标注层的白名单根必须与划词卡同一根（两个选择器各写一份，改一个就红）。
    assert.equal(
      CONFIG.ROOT_SELECTOR,
      CORE.SCOPE_SELECTOR,
      'annotate 的 ROOT_SELECTOR 应与 core 的 SCOPE_SELECTOR 一致',
    )
  })

  test('对话正文里（含嵌套的第二个 data-chat-flow）应当生效', () => {
    assert.equal(CORE.inConversation(msgText), true, '对话正文里的文本节点')
    assert.equal(CORE.inConversation(chatFlow), true, '对话正文元素自身')
    assert.equal(
      CORE.inConversation(stepText),
      true,
      '助手步骤过程里的文本节点（嵌套的第二个 data-chat-flow）',
    )
  })

  test('左栏 / 右栏 / 对话面板根 / body 不应生效', () => {
    assert.equal(CORE.inConversation(leftText), false, '左侧栏文本节点')
    assert.equal(CORE.inConversation(rightText), false, '右侧栏文本节点')
    assert.equal(
      CORE.inConversation(convContent),
      false,
      '对话面板根（轨迹页也挂在它下面，故意不认）',
    )
    assert.equal(CORE.inConversation(body), false, 'body 自身')
  })

  test('边界输入不抛错', () => {
    assert.equal(CORE.inConversation(null), false, 'null')
    assert.equal(CORE.inConversation(undefined), false, 'undefined')
    assert.equal(
      CORE.inConversation({ nodeType: 3 }),
      false,
      '裸对象（无 parentElement / closest）',
    )
  })
})

describe('排除范围：划词卡（inEditable）', () => {
  /** 造一个「自己命中某个排除选择器」的元素桩（只回 EXCLUDED_SELECTOR 的判定）。 */
  function tagged(tag) {
    return {
      nodeType: 1,
      closest(selector) {
        if (selector !== CORE.EXCLUDED_SELECTOR) throw new Error('桩只接受 EXCLUDED_SELECTOR')
        return selector
          .split(',')
          .map((s) => s.trim())
          .includes(tag)
          ? this
          : null
      },
    }
  }

  test('代码 / 链接 / 表格 / 按钮 / 输入框里不弹卡', () => {
    for (const tag of [
      'pre',
      'code',
      'a',
      'button',
      'table',
      '[data-ref-chip]',
      'input',
      'textarea',
    ]) {
      assert.equal(CORE.inEditable(tagged(tag)), true, `<${tag}> 里不弹卡`)
    }
  })

  test('普通段落仍然弹卡；null 不抛错', () => {
    assert.equal(CORE.inEditable(tagged('p')), false, '普通段落仍然弹卡')
    assert.equal(CORE.inEditable(null), false, 'inEditable(null) 不抛错')
  })

  test('共同排除名单就是这 7 项，blockedSelector 只在其后追加场景特有项', () => {
    const EXPECTED_BLOCKED = [
      'pre',
      'code',
      '.md-code-block',
      'a',
      'button',
      'table',
      '[data-ref-chip]',
    ]
    assert.equal(
      CORE.BLOCKED_ELEMENTS.join('|'),
      EXPECTED_BLOCKED.join('|'),
      'BLOCKED_ELEMENTS 就是这 7 项',
    )
    assert.equal(
      CORE.blockedSelector(['.x']),
      EXPECTED_BLOCKED.concat(['.x']).join(','),
      'blockedSelector(extra) = 共同项 + 特有项',
    )
  })

  test('wordcard 的最终选择器逐项等价（16 项，含全部共同项）', () => {
    const OLD_WORDCARD = [
      'input',
      'textarea',
      'select',
      '[contenteditable=""]',
      '[contenteditable="true"]',
      '.dwl-card',
      'pre',
      'code',
      '.md-code-block',
      'a',
      'button',
      'table',
      '[data-ref-chip]',
      '[role="dialog"]',
      '[role="menu"]',
      '[role="tooltip"]',
    ]
    const items = CORE.EXCLUDED_SELECTOR.split(',').map((s) => s.trim())
    assert.equal(items.length, OLD_WORDCARD.length, 'wordcard 排除选择器恰好 16 项')
    assert.equal(
      [...items].sort().join('|'),
      [...OLD_WORDCARD].sort().join('|'),
      'wordcard 排除选择器逐项等价',
    )
    assert.equal(
      CORE.BLOCKED_ELEMENTS.every((x) => items.includes(x)),
      true,
      'wordcard 排除选择器含全部 BLOCKED_ELEMENTS',
    )
  })
})

describe('标注层与划词共用同一份排除名单', () => {
  // 标注层自己的黑名单额外项（顺序与 config.js 里一致；这里锁死逐项等价）。
  const OLD_ANNOTATE = [
    'pre',
    'code',
    '.md-code-block',
    '[data-code-wrap]',
    '[data-code-block-banner]',
    'a',
    '[data-ref-chip]',
    'button',
    'table',
    '.md-table-wide',
    '[hidden]',
    '[data-streaming]',
    '[data-chat-running]',
    'details:not([open]) > :not(summary)',
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
    '.dwl-anno',
    '.dwlac',
  ]

  test('黑名单以 BLOCKED_ELEMENTS 开头，且含全部共同项', () => {
    assert.equal(
      CONFIG.BLACKLIST.slice(0, CORE.BLOCKED_ELEMENTS.length).join('|'),
      CORE.BLOCKED_ELEMENTS.join('|'),
      'annotate 黑名单以 BLOCKED_ELEMENTS 开头（同一份数据）',
    )
    assert.equal(
      CORE.BLOCKED_ELEMENTS.every((x) => CONFIG.BLACKLIST.includes(x)),
      true,
      'annotate 黑名单含全部 BLOCKED_ELEMENTS',
    )
  })

  test('黑名单逐项等价（只增删任何一项都会红）', () => {
    assert.equal(
      [...CONFIG.BLACKLIST].sort().join('|'),
      [...OLD_ANNOTATE].sort().join('|'),
      'annotate 黑名单逐项等价',
    )
    assert.equal(CONFIG.BLACKLIST.includes('p'), false, 'annotate 黑名单不含普通段落')
    assert.equal(
      BLACKLIST_SEL,
      CONFIG.BLACKLIST.join(','),
      '真正交给 matches() 的选择器与 BLACKLIST 同源',
    )
  })

  test('单一口径：annotate 从 core 模块 import 共同项，不另抄名单', () => {
    const config = annotateSources().find((f) => f.name === 'config.js')
    assert.ok(config, 'annotate/config.js 应存在（配置与共同名单的消费点）')
    assert.match(config.text, /import CORE from '\.\.\/core\.js'/, 'config.js 应 import core 模块')
    assert.ok(
      config.text.includes('CORE.BLOCKED_ELEMENTS'),
      'annotate 黑名单必须由 CORE.BLOCKED_ELEMENTS 拼出',
    )
    for (const { name, text } of annotateSources()) {
      assert.ok(!/window\.__dwl/.test(text), `${name} 不应再读写 window.__dwl* 全局`)
    }
  })

  test('黑名单不可被 mergeConfig 覆盖（否则双口径会从运行时回来）', () => {
    const before = CONFIG.BLACKLIST
    const kinds = CONFIG.ALLOWED_KINDS
    const paths = CONFIG.WORDS_PATHS
    annotate._mergeConfig({
      BLACKLIST: ['div'],
      ALLOWED_KINDS: ['tool-call'],
      WORDS_PATHS: ['/x'],
    })
    assert.equal(CONFIG.BLACKLIST, before, 'BLACKLIST 不允许被覆盖')
    assert.equal(CONFIG.ALLOWED_KINDS, kinds, 'ALLOWED_KINDS 不允许被覆盖')
    assert.equal(CONFIG.WORDS_PATHS, paths, 'WORDS_PATHS 不允许被覆盖')
  })
})

describe('标注层自己的生效范围与排除边界', () => {
  test('只标自然语言消息：块类型白名单不含工具/上下文/耗时行', () => {
    assert.equal(CONFIG.BLOCK_SELECTOR, '[data-chat-node-key], .EvIC1a_flowItem')
    assert.deepEqual(CONFIG.ALLOWED_KINDS, ['user', 'assistant-step'])
    for (const kind of ['tool-call', 'context', 'compaction', 'turn-process', 'turn-tail']) {
      assert.equal(CONFIG.ALLOWED_KINDS.includes(kind), false, `${kind} 不应被标`)
    }
  })

  test('折叠行的标题必须能标：不黑名单 role=button / aria-expanded / disclosure header', () => {
    // 真实 DOM 里思考/过程折叠行是 div[role=button][data-disclosure-row][aria-expanded=false]，
    // 它装的就是"标题"。黑掉它等于真实页面上一律 0 标注（这是踩过的坑）。
    assert.equal(
      CONFIG.BLACKLIST.includes('[role="button"]'),
      false,
      '[role="button"] 不能进黑名单',
    )
    assert.equal(
      CONFIG.BLACKLIST.includes('[aria-expanded="false"]'),
      false,
      '[aria-expanded="false"] 不能进黑名单',
    )
    assert.equal(
      CONFIG.BLACKLIST.includes('[data-disclosure-header]'),
      false,
      '[data-disclosure-header] 不能进黑名单',
    )
    // 折叠的正文由 [hidden] / 未渲染的 panel / 未展开的 details 兜住。
    assert.ok(CONFIG.BLACKLIST.includes('[hidden]'), '折叠正文靠 [hidden] 排除')
    assert.ok(
      CONFIG.BLACKLIST.includes('details:not([open]) > :not(summary)'),
      '未展开的原生 <details> 只留 summary 可标',
    )
  })

  test('流式内容与自己的产物都在黑名单里', () => {
    assert.ok(CONFIG.BLACKLIST.includes('[data-streaming]'), '流式标记应排除')
    assert.ok(CONFIG.BLACKLIST.includes('[data-chat-running]'), '运行指示器应排除')
    assert.ok(CONFIG.BLACKLIST.includes('.dwl-anno'), '重扫不应钻进自己的 span')
    assert.ok(CONFIG.BLACKLIST.includes('.dwlac'), '重扫不应钻进自己的悬停卡')
  })
})
