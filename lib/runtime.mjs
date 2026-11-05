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

// 每次请求按 mtime 判断是否重读前端脚本
const CLIENT_FILE_CANDIDATES = [
  path.join(HERE, '..', 'assets', 'wordcard.js'),
  path.join(HERE, 'wordcard.js'),
]
const ANNOTATE_FILE_CANDIDATES = [
  path.join(HERE, '..', 'assets', 'annotate.js'),
  path.join(HERE, 'annotate.js'),
]
const VOICE_FILE_CANDIDATES = [
  path.join(HERE, '..', 'assets', 'voice.js'),
  path.join(HERE, 'voice.js'),
]

let clientCache = null
export function loadClientJs() {
  for (const candidate of CLIENT_FILE_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate)
      if (clientCache && clientCache.mtimeMs === stat.mtimeMs) return clientCache.text
      const text = fs.readFileSync(candidate, 'utf8')
      clientCache = { text, mtimeMs: stat.mtimeMs }
      return text
    } catch (err) {
      /* 试下一个候选 */
    }
  }
  return clientCache ? clientCache.text : ''
}

// P3 标注层单独一个文件：改它不用重启宿主（和 client.js 同一套 mtime 缓存），
// 也不进 React 客户端包——纯 DOM 功能不需要 React，坏了也不会拖垮学习页。
let annotateCache = null
export function loadAnnotateJs() {
  for (const candidate of ANNOTATE_FILE_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate)
      if (annotateCache && annotateCache.mtimeMs === stat.mtimeMs) return annotateCache.text
      const text = fs.readFileSync(candidate, 'utf8')
      annotateCache = { text, mtimeMs: stat.mtimeMs }
      return text
    } catch (err) {
      /* 文件还没写（P3 未落地时）→ 返回空脚本，页面侧静默无标注 */
    }
  }
  return annotateCache ? annotateCache.text : ''
}

let voiceCache = null
export function loadVoiceJs() {
  for (const candidate of VOICE_FILE_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate)
      if (voiceCache && voiceCache.mtimeMs === stat.mtimeMs) return voiceCache.text
      const text = fs.readFileSync(candidate, 'utf8')
      voiceCache = { text, mtimeMs: stat.mtimeMs }
      return text
    } catch (err) {
      /* 文件不在就返回空脚本：词卡会提示语音模块未加载 */
    }
  }
  return voiceCache ? voiceCache.text : ''
}
