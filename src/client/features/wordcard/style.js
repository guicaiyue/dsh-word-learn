/* dsh-word-learn —— 划词学习卡的样式常量（构建源码，ESM）。
 *
 * 为什么单独一个文件：卡片样式是 160 多行 CSS 字符串，属于"样式常量"而不是
 * 视图逻辑；拆开后 card.js 只管 DOM、index.js 只管装配，三块各自都读得下去。
 *
 * 原 assets/wordcard-style.js：IIFE 把字符串挂到一个 window 全局上，
 * 由后注入的 wordcard-card.js / wordcard.js 从 window 取 —— 那是「禁止 import」
 * 逼出来的传递方式。阶段 2 起它就是本 bundle 的一个模块：card.js 直接
 * `import { CSS as WORDCARD_CSS } from './style.js'`，构建期绑定，没有"到没到齐"这回事。
 *
 * 约束：只有数据 —— 不注册事件、不碰 DOM、不读 core。
 * **CSS 内容与原注入脚本逐字节一致**（只换外壳），改样式只动字符串内部。
 */

/** 卡片样式。行数组 + join：与原脚本的字符串构造方式保持一致，避免手抄漂移。 */
export const CSS = [
  '.dwl-card{',
  '  --dwl-bg:var(--dsw-alias-bg-overlay,#ffffff);',
  '  --dwl-fg:var(--dsw-alias-label-primary,#1f2328);',
  '  --dwl-muted:var(--dsw-alias-label-tertiary,#6b7280);',
  '  --dwl-muted2:var(--dsw-alias-label-secondary,#4b5563);',
  '  --dwl-border:var(--dsw-alias-border-l2,rgba(15,23,42,.15));',
  '  --dwl-hover:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.08));',
  '  --dwl-accent:var(--dsw-alias-brand-primary,#2563eb);',
  '  --dwl-accent-soft:var(--dsw-alias-interactive-bg-hover-accent,rgba(37,99,235,.10));',
  '  --dwl-skel:var(--dsw-alias-bg-skeleton,rgba(15,23,42,.07));',
  '  --dwl-err:var(--dsw-alias-state-error-primary,#dc2626);',
  '  --dwl-ok:var(--dsw-alias-state-success-primary,#16a34a);',
  '  --dwl-warn:var(--dsw-alias-state-warn-primary,#d97706);',
  '  --dwl-shadow:var(--dsw-shadow-lv3,0 12px 32px -10px rgba(15,23,42,.28),0 2px 8px -2px rgba(15,23,42,.12));',
  '  --dwl-radius:var(--dsw-radius-l,14px);',
  '  position:fixed;z-index:2147483000;box-sizing:border-box;',
  '  width:max-content;min-width:280px;max-width:min(560px,calc(100vw - 24px));',
  '  font-family:var(--dsw-font-family,var(--dsh-font-family-text,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif));',
  '  font-size:13.5px;line-height:1.62;text-align:left;color:var(--dwl-fg);',
  '  background:var(--dwl-bg);border:1px solid var(--dwl-border);border-radius:var(--dwl-radius);',
  '  box-shadow:var(--dwl-shadow);overflow:hidden;',
  '  animation:dwlIn .16s cubic-bezier(.2,.8,.2,1);',
  '}',
  // 深色兜底：DSH 用 body[data-ds-dark-theme] 标记深色（令牌已自动翻转，
  // 这里只是给"令牌缺失"的情况一套深色兜底值）。两个选择器都写，
  // 后者兼容脱离 DSH 的独立预览页。
  'body[data-ds-dark-theme] .dwl-card,.dwl-card[data-theme="dark"]{',
  '  --dwl-bg:var(--dsw-alias-bg-layer-3,#1c1f26);',
  '  --dwl-fg:var(--dsw-alias-label-primary,#e6e8eb);',
  '  --dwl-muted:var(--dsw-alias-label-tertiary,#98a1ae);',
  '  --dwl-muted2:var(--dsw-alias-label-secondary,#b6bdc7);',
  '  --dwl-border:var(--dsw-alias-border-l2,rgba(255,255,255,.13));',
  '  --dwl-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.10));',
  '  --dwl-accent:var(--dsw-alias-brand-primary,#7aa2f7);',
  '  --dwl-accent-soft:var(--dsw-alias-interactive-bg-hover-accent,rgba(122,162,247,.16));',
  '  --dwl-skel:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.09));',
  '  --dwl-err:var(--dsw-static-red-100,#f87171);',
  '  --dwl-ok:var(--dsw-alias-state-success-primary,#4ade80);',
  '  --dwl-warn:var(--dsw-alias-state-warn-primary,#fbbf24);',
  '  --dwl-shadow:var(--dsw-shadow-lv3,0 16px 40px -12px rgba(0,0,0,.62),0 2px 10px -2px rgba(0,0,0,.42));',
  '}',
  '@keyframes dwlIn{from{opacity:0;transform:translateY(-5px) scale(.985)}to{opacity:1;transform:none}}',
  '@keyframes dwlShimmer{0%{background-position:100% 0}100%{background-position:0 0}}',
  '@keyframes dwlPop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}',
  '@media (prefers-reduced-motion:reduce){.dwl-card{animation:none}.dwlk-skel i{animation:none}}',

  // 头部
  '.dwl-head{display:flex;align-items:flex-start;gap:8px;padding:10px 8px 8px 13px;border-bottom:1px solid var(--dwl-border)}',
  '.dwl-headmain{flex:1 1 auto;min-width:0}',
  '.dwlk-word{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}',
  '.dwlk-word b{font-size:16px;font-weight:650;letter-spacing:.01em}',
  '.dwlk-phon{font-size:12.5px;color:var(--dwl-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
  '.dwl-from{font-size:11px;color:var(--dwl-muted)}',
  '.dwlk-btn{',
  '  flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:4px;',
  '  height:32px;min-width:32px;padding:0 7px;border:0;border-radius:7px;cursor:pointer;',
  '  background:transparent;color:var(--dwl-muted);font-size:11.5px;font-family:inherit;',
  '  transition:background .14s ease,color .14s ease;',
  '}',
  '.dwlk-btn:hover{background:var(--dwl-hover);color:var(--dwl-fg)}',
  '.dwlk-btn:active{transform:translateY(.5px)}',
  '.dwlk-btn:focus-visible{outline:2px solid var(--dwl-accent);outline-offset:1px;border-radius:7px}',
  '.dwlk-btn svg{width:14px;height:14px;display:block}',
  '.dwlk-btn[data-done="1"]{color:var(--dwl-ok)}',
  '.dwlk-btn[data-on="1"]{color:var(--dwl-accent)}',
  '.dwlk-btn[data-done="1"] svg{animation:dwlPop .28s ease}',
  '.dwl-acc{min-width:34px;padding:0 6px;font-size:10.5px;font-weight:650;letter-spacing:.04em}',
  '.dwl-acc:hover{color:var(--dwl-accent)}',
  '.dwlk-btn[data-busy="1"]{cursor:progress;opacity:.65}',
  '@keyframes dwlPulse{0%,100%{opacity:.25}50%{opacity:1}}',
  '.dwlk-btn[data-busy="1"] svg{animation:dwlPulse .9s ease-in-out infinite}',
  '@media (prefers-reduced-motion:reduce){.dwlk-btn[data-busy="1"] svg{animation:none}}',

  // 分级条
  '.dwl-tiers{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 13px 0}',
  '.dwlk-chip{',
  '  display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;',
  '  border-radius:5px;font-size:10.5px;line-height:1;white-space:nowrap;',
  '  background:var(--dwl-hover);color:var(--dwl-muted);',
  '}',
  '.dwlk-chip[data-tone="known"]{background:var(--dwl-accent-soft);color:var(--dwl-accent)}',
  '.dwlk-chip[data-tone="exam"]{background:rgba(217,119,6,.12);color:var(--dwl-warn)}',
  '.dwlk-chip[data-tone="star"]{background:rgba(22,163,74,.12);color:var(--dwl-ok)}',
  '.dwl-hint{font-size:11px;color:var(--dwl-muted);padding:5px 13px 0}',

  // 正文
  '.dwlk-body{padding:8px 13px 11px;max-height:min(48vh,400px);overflow:auto}',
  '.dwlk-body::-webkit-scrollbar{width:8px;height:8px}',
  '.dwlk-body::-webkit-scrollbar-thumb{background:var(--dwl-hover);border-radius:4px}',
  '.dwlk-body::-webkit-scrollbar-track{background:transparent}',
  '.dwlk-sense{display:flex;gap:7px;padding:2.5px 0}',
  '.dwlk-pos{',
  '  flex:0 0 auto;min-width:30px;font-size:11px;color:var(--dwl-accent);',
  '  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding-top:1.5px;',
  '}',
  '.dwl-text{flex:1 1 auto;word-break:break-word;overflow-wrap:anywhere}',
  '.dwl-sect{margin-top:9px;padding-top:8px;border-top:1px dashed var(--dwl-border)}',
  '.dwl-sect h5{margin:0 0 5px;font-size:11px;font-weight:600;color:var(--dwl-muted);letter-spacing:.03em;display:flex;align-items:center;gap:6px}',
  '.dwl-forms{display:flex;flex-wrap:wrap;gap:5px}',
  '.dwl-form{font-size:11.5px;padding:1px 6px;border-radius:5px;background:var(--dwl-hover)}',
  '.dwl-form i{font-style:normal;color:var(--dwl-muted);margin-right:3px}',
  '.dwl-ex{padding:2.5px 0;font-size:12.5px}',
  '.dwl-ex em{font-style:normal;color:var(--dwl-muted);font-size:11px;margin-right:5px}',
  '.dwl-syn{display:flex;flex-wrap:wrap;gap:5px}',
  '.dwl-syn span{font-size:11.5px;padding:1px 6px;border-radius:5px;background:var(--dwl-hover);cursor:pointer}',
  '.dwl-syn span:hover{background:var(--dwl-accent-soft);color:var(--dwl-accent)}',
  '.dwl-syn span:focus-visible{outline:2px solid var(--dwl-accent);outline-offset:1px}',
  '.dwl-cand:focus-visible{outline:2px solid var(--dwl-accent);outline-offset:1px}',
  '.dwlk-err{color:var(--dwl-err)}',
  '.dwl-warnbox{color:var(--dwl-warn);font-size:12px}',

  // 译文（短语/整句场景的主内容）
  '.dwl-tr{padding:2px 0 8px;border-bottom:1px solid var(--dwl-border);margin-bottom:8px}',
  '.dwl-tr-label{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dwl-muted);margin-bottom:4px}',
  '.dwl-tr-body{font-size:13.5px;line-height:1.62;color:var(--dwl-fg);white-space:pre-wrap;word-break:break-word}',
  '.dwl-tr-src{padding:0 5px;border-radius:5px;background:var(--dwl-hover);font-size:10.5px}',
  '.dwl-tr-body[data-pending="1"]{color:var(--dwl-muted)}',
  '.dwl-tr-fail{font-size:12px;color:var(--dwl-warn);line-height:1.5}',
  // 整句朗读按钮：就放在"译文"这一行的右侧 —— 划句子的人第一眼就在这儿
  '.dwl-tr-act{',
  '  margin-left:auto;flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;',
  '  height:20px;padding:0 7px;border:0;border-radius:6px;cursor:pointer;font:inherit;',
  '  font-size:10.5px;background:var(--dwl-hover);color:var(--dwl-muted);',
  '  transition:background .14s ease,color .14s ease;',
  '}',
  '.dwl-tr-act:hover{background:var(--dwl-accent-soft);color:var(--dwl-accent)}',
  '.dwl-tr-act svg{width:11px;height:11px;display:block}',
  '.dwl-tr-act[data-busy="1"]{cursor:progress;opacity:.65}',
  '.dwl-tr-act[data-busy="1"] svg{animation:dwlPulse .9s ease-in-out infinite}',
  '.dwl-tr-act[data-done="1"]{color:var(--dwl-ok)}',

  // 候选词（短语场景）
  '.dwl-cands{display:flex;flex-wrap:wrap;gap:5px;padding:2px 0}',
  '.dwl-cand{',
  '  display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:7px;',
  '  background:var(--dwl-hover);cursor:pointer;font-size:12.5px;border:1px solid transparent;',
  '}',
  '.dwl-cand:hover{background:var(--dwl-accent-soft);color:var(--dwl-accent)}',
  '.dwl-cand[data-known="1"]{opacity:.6}',
  '.dwl-cand s{font-size:10.5px;color:var(--dwl-muted);text-decoration:none}',
  '.dwl-cand[data-best="1"]{border-color:var(--dwl-accent);background:var(--dwl-accent-soft)}',

  // 骨架屏
  '.dwlk-skel{display:flex;flex-direction:column;gap:9px;padding:2px 0}',
  '.dwlk-skel i{',
  '  display:block;height:9px;border-radius:5px;',
  '  background:linear-gradient(90deg,var(--dwl-skel) 25%,transparent 37%,var(--dwl-skel) 63%);',
  '  background-size:400% 100%;animation:dwlShimmer 1.25s ease-in-out infinite;',
  '}',

  // 底栏
  '.dwl-foot{display:flex;align-items:center;gap:6px;padding:0 13px 9px;font-size:11px;color:var(--dwl-muted)}',
  '.dwlk-dot{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.55;flex:0 0 auto}',
].join('\n')
