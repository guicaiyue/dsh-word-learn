// 设置页「AI 分析模型」的渲染测试。
//
// 整文件加载 assets/dashboard.js（见 tests/helpers/dashboard.mjs），不再切源码：
// 用最小 React 运行时渲染真实 SettingsView，再对元素树做断言。
// 为什么要这么测：宿主重启前看不到真页面，而这段 JSX 一旦写错
// （select 的 value 对不上、空态分支漏了）只有打开设置页才会炸。
import assert from 'node:assert/strict'

import { findAll, loadDashboard, textOf } from '../tests/helpers/dashboard.mjs'

const module = loadDashboard()
const { SettingsView } = module.__test__
const { mount } = module.__helpers__

/** 每个用例一套新的组件实例：状态互不污染。 */
async function render(api) {
  const handle = mount(SettingsView, { api })
  return handle.settle()
}

const CATALOG = {
  ok: true,
  models: [
    {
      provider: 'deepseek-official',
      providerName: 'DeepSeek 官方',
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
    },
    {
      provider: 'deepseek-official',
      providerName: 'DeepSeek 官方',
      id: 'deepseek-v4',
      name: 'DeepSeek V4',
    },
    { provider: 'other', providerName: '别家', id: 'other-large', name: 'Other Large' },
  ],
  selection: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    providerName: 'DeepSeek 官方',
    source: 'default',
  },
  defaultSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  lostSelection: null,
}

// ── 1. 默认态：下拉选中第一个，说明里写清"默认：列表第一个"
let calls = []
let tree = await render(async (p, opt) => {
  calls.push({ p, opt })
  return CATALOG
})
let select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dwl-model-select')
assert.equal(select.length, 1, '应渲染出模型下拉框')
assert.equal(select[0].props.value, '0', '默认应选中列表第一个（下标 0）')

const options = findAll(select[0], (n) => n.type === 'option')
assert.equal(options.length, 3, '三个模型应有三个 option')
assert.equal(textOf(options[0]), 'DeepSeek V4 Flash（deepseek-v4-flash）')
const groups = findAll(tree, (n) => n.type === 'optgroup')
assert.equal(groups.length, 2, '应按 provider 分成两个 optgroup')
assert.match(textOf(tree), /当前生效：DeepSeek 官方 · DeepSeek V4 Flash（默认：列表第一个）/)
assert.equal(findAll(tree, (n) => n.type === 'button' && textOf(n).includes('恢复默认')).length, 0)
// 自动发音开关：默认开，且关掉后说明文字会变
const autoInput = findAll(tree, (n) => n.type === 'input' && n.props.id === 'dwl-auto-speak')
assert.equal(autoInput.length, 1, '应有"自动发音"开关')
assert.equal(autoInput[0].props.type, 'checkbox', '开关是 checkbox')
assert.equal(autoInput[0].props.checked, true, '默认开启自动发音')
assert.match(textOf(tree), /自动发音/)
assert.match(textOf(tree), /都会自动读一遍/)
console.log('✓ 默认态：下拉选中第一个，标注"默认：列表第一个"，没有恢复按钮；自动发音默认开')

// ── 2. 自选态：选中自定义模型，出现"恢复默认"
const custom = {
  ...CATALOG,
  selection: {
    provider: 'other',
    model: 'other-large',
    name: 'Other Large',
    providerName: '别家',
    source: 'custom',
  },
}
tree = await render(async () => custom)
select = findAll(tree, (n) => n.props.id === 'dwl-model-select')[0]
assert.equal(select.props.value, '2', '自选第三个模型时下拉应指向下标 2')
assert.match(textOf(tree), /当前生效：别家 · Other Large/)
assert.equal(findAll(tree, (n) => n.type === 'button' && textOf(n).includes('恢复默认')).length, 1)
console.log('✓ 自选态：下拉指向自选模型，出现"恢复默认（第一个）"')

// ── 3. 改选：onChange 发 POST /model，成功后界面跟着变
calls = []
const apiAfter = async (p, opt) => {
  calls.push({ p, opt })
  if (p === '/models') return CATALOG
  if (p === '/model') return { ok: true, selection: { ...CATALOG.models[1], source: 'custom' } }
  throw new Error('意外请求 ' + p)
}
const handle = mount(SettingsView, { api: apiAfter })
tree = await handle.settle()
select = findAll(tree, (n) => n.props.id === 'dwl-model-select')[0]
await select.props.onChange({ target: { value: '1' } })
await handle.settle()
const post = calls.find((c) => c.p === '/model')
assert.ok(post, '改选应发 POST /model')
// post.opt.body 来自 vm 沙箱（跨 realm 的对象原型不同），展开成本地对象再比
assert.deepEqual(
  { ...post.opt.body },
  { provider: 'deepseek-official', model: 'deepseek-v4' },
  'POST 要带 provider/model',
)
console.log('✓ 改选：onChange -> POST /model {provider, model}')

// ── 4. 空目录 / 错误 / 模型丢失三种分支
tree = await render(async () => ({
  ok: true,
  models: [],
  selection: { provider: 'agent', model: 'agent-model', name: 'Agent', source: 'agent' },
}))
assert.match(textOf(tree), /还没有可用的文本模型.*暂时跟随会话默认模型（Agent）/)
assert.equal(
  findAll(tree, (n) => n.type === 'select' && n.props.id === 'dwl-model-select').length,
  0,
)
console.log('✓ 空目录：说明跟随会话默认模型，不渲染空下拉')

tree = await render(async () => ({ ok: false, error: 'DSH 模型服务不可用（ctx.llm 缺失）' }))
assert.match(textOf(tree), /DSH 模型服务不可用/)
console.log('✓ 读取失败：直接显示错误，不白屏')

tree = await render(async () => ({
  ...CATALOG,
  lostSelection: { provider: 'deepseek-official', model: 'retired-model' },
}))
assert.match(textOf(tree), /retired-model 已不在 DSH 模型目录里/)
console.log('✓ 模型丢失：提示旧选择已失效、现按默认第一个')

// ── 5. 加载中
tree = await render(() => new Promise(() => {}))
assert.match(textOf(tree), /读取 DSH 模型列表…/)
console.log('✓ 加载中：显示"读取 DSH 模型列表…"')

console.log('\nUI 分支全部通过')
