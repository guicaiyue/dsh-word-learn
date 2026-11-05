// routes/assets.mjs —— 前端三段脚本（词卡 / 语音 / 标注层）
//
// 三个脚本都走 no-store：改完 assets 硬刷新页面即生效，不用重挂插件。
// 注入行本身在 index.js（宿主只在启动时收集一次），这里只负责按请求吐文件。

import { loadAnnotateJs, loadClientJs, loadCoreJs, loadVoiceJs } from '../runtime.mjs'
import { ANNOTATE_PATH, CLIENT_PATH, CORE_PATH, VOICE_PATH } from './paths.mjs'

/**
 * @param {Function} registerRoute 带栅栏 / methods 白名单 / 500 兜底的注册器
 * @returns {Array<Function>} 卸载函数
 */
export function registerAssetRoutes(registerRoute) {
  const disposers = []
  // 前端脚本

  // 纯判定核心（生效范围 / 排除范围 / 语音降级）：必须排在 wordcard.js 之前加载
  disposers.push(
    registerRoute({
      kind: 'exact',
      path: CORE_PATH,
      methods: ['GET'],
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadCoreJs())
      },
    }),
  )

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: CLIENT_PATH,
      methods: ['GET'],
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadClientJs())
      },
    }),
  )

  // 语音脚本（同样 no-store：改了刷新即生效）

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: VOICE_PATH,
      methods: ['GET'],
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadVoiceJs())
      },
    }),
  )

  // P3 标注层脚本（同样 no-store：改了刷新即生效，不用重启宿主）

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: ANNOTATE_PATH,
      methods: ['GET'],
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadAnnotateJs())
      },
    }),
  )

  return disposers
}
