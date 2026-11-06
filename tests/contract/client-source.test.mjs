// @vitest-environment node
// 产物源码级契约 —— 发音链路只许走浏览器自带 speechSynthesis，不许再回到服务端音频。
//
// 迁移自 `scripts/test-hoverword.mjs` 末尾的四条源码断言（原来靠 vm 加载 bundle 后
// 拿 `__source__` 做正则）。**这类断言 RTL 覆盖不到**：它测的不是渲染行为，而是
// "整包产物里允许出现哪些符号"—— 属于 ADR-0004 说的 contract 层。
//
// 为什么放在 tests/contract 且用 node:test：vitest.config.ts 的 include 目前只收
// `tests/component/**/*.test.{ts,tsx}`（本阶段不允许我改配置），写 .mjs 放这里可由
// `pnpm test:unit`（glob `tests/**/*.test.mjs`）立即跑到，不会变成"写了但没人跑"的
// 假覆盖。若以后把 vitest 扩到 contract 层，这个文件可以原样改成 vitest 断言。
//
// 注意不能只查 'tts' 字样：voice.js 里还保留着老 localStorage 键 `dwl-tts-accent`
// 的一次性迁移（数据迁移，不是服务端链路），所以只禁 `/tts` 路由与 `tts-prepare`。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'

import { BUNDLE_PATH, ROOT } from '../../scripts/check-artifact.mjs'

const bundlePath = path.join(ROOT, BUNDLE_PATH)
const source = fs.readFileSync(bundlePath, 'utf8')

test('发音链路契约：只用浏览器自带语音，不再引用服务端音频路由', () => {
  assert.ok(source.length > 10_000, `产物过小，疑似构建失败：${bundlePath}`)

  assert.ok(
    !/\/tts|tts-prepare/.test(source),
    '不应再引用服务端 /tts 音频路由（发音已全部改为浏览器语音）',
  )
  assert.ok(!/new Audio\s*\(/.test(source), '不应 new Audio（发音走 speechSynthesis）')
  assert.ok(source.includes('speechSynthesis'), '发音应走浏览器自带 speechSynthesis')
  assert.ok(source.includes('preload()'), '开始一轮应预热音色列表')
  assert.ok(/voiceModule\(\)/.test(source), '没有语音模块时要能降级')
})

test('产物自足契约：不引用注入脚本时期的 window.__dwl* 全局', () => {
  // 阶段 2 起逻辑/样式都是 bundle 自己的模块；残留全局读写说明回退了。
  assert.ok(
    !/window\.__dwlDashboard/.test(source),
    '产物不应再读写 window.__dwlDashboard*（阶段 2 已删除注入脚本）',
  )
})
