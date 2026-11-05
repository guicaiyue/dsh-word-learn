// runtime.mjs —— 进程内单例与前端脚本加载。
//
// 为什么单独拆出来：`lib/index.js` 原来同时管路由、栅栏、响应出口和这几个
// 单例/加载器，导致「谁都能改、谁都不敢动」。单例（词典、用户库）与 assets
// 的 mtime 缓存是进程级状态，路由模块只消费它们，不拥有它们。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Dictionary } from './dict.mjs'
import { Store } from './store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 进程内单例：词典与用户库都要复用（打开 SQLite 有成本）
export const dict = new Dictionary()
export const store = new Store()

// 每次请求按 mtime 判断是否重读前端脚本：改了文件硬刷新即生效，不用重挂插件。
// 多个脚本共用同一套缓存逻辑（原先四份复制粘贴，新增 core.js 时抽成工厂，
// 免得再复制出第四份，也保证"文件不在 → 返回空脚本"的降级口径一致）。
function makeJsLoader(fileName) {
  const candidates = [path.join(HERE, '..', 'assets', fileName), path.join(HERE, fileName)]
  let cache = null
  return function load() {
    for (const candidate of candidates) {
      try {
        const stat = fs.statSync(candidate)
        if (cache && cache.mtimeMs === stat.mtimeMs) return cache.text
        const text = fs.readFileSync(candidate, 'utf8')
        cache = { text, mtimeMs: stat.mtimeMs }
        return text
      } catch (err) {
        /* 试下一个候选；文件不存在时用缓存兜底，再不行返回空脚本让页面降级 */
      }
    }
    return cache ? cache.text : ''
  }
}

// 词卡主脚本（从 window.__dwlCore 取判定，注入行里 core.js 必须排在它前面）
export const loadClientJs = makeJsLoader('wordcard.js')
// 词卡样式常量（wordcard-card.js 从 window.__dwlWordcardStyle 取）
export const loadWordcardStyleJs = makeJsLoader('wordcard-style.js')
// 词卡卡片视图（wordcard.js 从 window.__dwlWordcardCard 取）
export const loadWordcardCardJs = makeJsLoader('wordcard-card.js')
// 纯判定核心（生效范围 / 排除范围 / 语音降级），wordcard 与 test-scope 共用同一份口径
export const loadCoreJs = makeJsLoader('core.js')
// 语音模块（浏览器自带 speechSynthesis）
export const loadVoiceJs = makeJsLoader('voice.js')
// P3 标注层：纯 DOM 功能，坏了也不拖垮学习页
export const loadAnnotateJs = makeJsLoader('annotate.js')
