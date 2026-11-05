// routes/assets.mjs —— 前端注入脚本（核心判定 / 语音 / 词卡视图+样式 / 学习页逻辑+样式 / 标注层）
//
// 这些脚本都走 no-store：改完 assets 硬刷新页面即生效，不用重挂插件。
// 注入行本身在 index.js（宿主只在启动时收集一次），这里只负责按请求吐文件。

import {
  loadAnnotateJs,
  loadClientJs,
  loadCoreJs,
  loadDashboardLogicJs,
  loadDashboardStyleJs,
  loadVoiceJs,
  loadWordcardCardJs,
  loadWordcardStyleJs,
} from '../runtime.mjs'
import {
  ANNOTATE_PATH,
  CLIENT_PATH,
  CORE_PATH,
  DASHBOARD_LOGIC_PATH,
  DASHBOARD_STYLE_PATH,
  VOICE_PATH,
  WORDCARD_CARD_PATH,
  WORDCARD_STYLE_PATH,
} from './paths.mjs'

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

  // 词卡拆分出的两个脚本：样式常量（wordcard-card.js 从 window.__dwlWordcardStyle 取）
  // 与卡片视图（wordcard.js 从 window.__dwlWordcardCard 取）；注入顺序保证在前。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: WORDCARD_STYLE_PATH,
      methods: ['GET'],
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadWordcardStyleJs())
      },
    }),
  )

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: WORDCARD_CARD_PATH,
      methods: ['GET'],
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadWordcardCardJs())
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

  // 学习页逻辑（dashboard.js 消费 window.__dwlDashboardLogic）与样式（__dwlDashboardCSS）。
  // 都是普通 IIFE：无 React、无 Node API；注入顺序保证它们在 client.js 之前。

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: DASHBOARD_LOGIC_PATH,
      methods: ['GET'],
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadDashboardLogicJs())
      },
    }),
  )

  disposers.push(
    registerRoute({
      kind: 'exact',
      path: DASHBOARD_STYLE_PATH,
      methods: ['GET'],
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadDashboardStyleJs())
      },
    }),
  )

  return disposers
}
