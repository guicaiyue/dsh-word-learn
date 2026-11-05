/* dsh-word-learn —— 学习页样式（dashboard-style.js）。
 *
 * 为什么单独一个文件：CSS 是纯字符串常量，跟 React 组件混在 dashboard.js 里
 * 占了约 500 行，改组件时每次都要跨过整段样式。抽成注入脚本后 dashboard.js 只剩
 * 组件；dashboard.js 从 window.__dwlDashboardCSS 取字符串（取不到退化为空，不抛错）。
 * 注入顺序：core.js → voice.js → dashboard-logic.js → dashboard-style.js → client.js → annotate.js。
 *
 * 约束：浏览器普通 <script>（IIFE），不许 import/require/Node API；只挂一个字符串，
 * 不碰 DOM、不注册监听。**CSS 内容必须与拆分前逐字节一致**（对比脚本见任务报告），
 * 改样式时只改模板串内部，不要动缩进/换行。
 */
;(function () {
  'use strict'
  if (window.__dwlDashboardCSS) return

  const CSS = `
.dwl-page{
  --dwl-shadow:0 1px 2px rgba(24,24,20,.05),0 14px 30px -20px rgba(24,24,20,.42);
  --dwl-tint:rgba(17,17,17,.045);
  --dwl-btn-bg:var(--dsw-alias-bg-layer-1,#ffffff);
  --dwl-btn-border:var(--dsw-alias-border-l2,rgba(15,23,42,.18));
  --dwl-error-bg:rgba(229,57,53,.08);--dwl-accent:#0d9488;
  /* 判分按钮的文字色：状态令牌本身就是"点缀色"，直接当 13px 文字用会不达标
     （浅色下 warn #f59e0b 对白底只有 2.2:1，success #22c55e 只有 2.4:1）。
     这里给两套"文字专用"色：浅色取 700 级，深色取 400/300 级。实测见 DESIGN.md。 */
  --dwl-again-text:#b91c1c;--dwl-hard-text:#b45309;
  --dwl-good-text:#15803d;--dwl-easy-text:#1d4ed8;
  height:100%;overflow:auto;box-sizing:border-box;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-size:13.5px;line-height:1.6;-webkit-font-smoothing:antialiased;
}
body[data-ds-dark-theme] .dwl-page{
  --dwl-shadow:0 1px 2px rgba(0,0,0,.5),0 14px 30px -20px rgba(0,0,0,1);
  --dwl-tint:rgba(255,255,255,.055);
  --dwl-btn-bg:rgba(255,255,255,.08);
  --dwl-btn-border:rgba(255,255,255,.34);
  --dwl-error-bg:rgba(229,57,53,.16);--dwl-accent:#2dd4bf;
  --dwl-again-text:#f87171;--dwl-hard-text:#fbbf24;
  --dwl-good-text:#4ade80;--dwl-easy-text:#93c5fd;
  color-scheme:dark;
}
.dwl-page *{box-sizing:border-box}
.dwl-page :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0d9488);outline-offset:2px;border-radius:8px}
.dwl-wrap{max-width:760px;margin:0 auto;padding:0 24px 56px;min-height:100%;display:flex;flex-direction:column}

/* 顶部：视图切换 */
.dwl-top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;height:52px;flex:none;
  background:var(--dsw-alias-bg-base)}
.dwl-tabs{display:flex;gap:2px;margin-right:auto}
.dwl-tab{position:relative;font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:0;background:transparent;
  color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .15s ease,color .15s ease}
.dwl-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dwl-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dwl-tint)}
.dwl-tab[aria-selected="true"]::after{content:"";position:absolute;left:12px;right:12px;bottom:1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.dwl-pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);
  padding:4px 10px;border-radius:99px;background:var(--dwl-tint);flex:none}
.dwl-pill b{color:var(--dsw-alias-state-warn-primary);font-variant-numeric:tabular-nums}

/* 今日进度 */
.dwl-meter{margin-top:4px;flex:none}
.dwl-track{height:3px;border-radius:2px;background:var(--dsw-alias-bg-skeleton);overflow:hidden}
.dwl-track i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary);
  transition:width .45s cubic-bezier(.22,1,.36,1)}
.dwl-legend-line{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
  margin-top:9px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dwl-legend-line b{color:var(--dsw-alias-label-primary);font-size:14px;font-variant-numeric:tabular-nums}

/* 一屏一词 */
.dwl-study{flex:1;display:flex;flex-direction:column;justify-content:center;padding:8px 0 0}
.dwl-focus{display:flex;flex-direction:column;align-items:center;text-align:center;animation:dwl-in .22s ease}
@keyframes dwl-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dwl-word{font-family:ui-serif,Georgia,"Songti SC",serif;font-size:clamp(34px,5.8vw,50px);
  line-height:1.12;font-weight:600;letter-spacing:-.015em;word-break:break-word;max-width:100%}
.dwl-phon{margin-top:14px;display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;
  font-size:13px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dwl-pos{font-family:-apple-system,sans-serif;font-style:normal;font-size:11.5px;padding:1px 7px;
  border-radius:5px;background:var(--dwl-tint);color:var(--dsw-alias-label-secondary)}
.dwl-flag{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);font-family:-apple-system,sans-serif}

/* 发音按钮 + 口音切换 */
.dwl-speak{display:inline-flex;align-items:center;gap:0;margin-left:2px}
.dwl-speak-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border:0;background:transparent;cursor:pointer;border-radius:6px;padding:0;
  color:var(--dsw-alias-label-tertiary);transition:color .15s ease,background .15s ease}
.dwl-speak-btn:hover{color:var(--dsw-alias-brand-primary);background:var(--dwl-tint)}
.dwl-speak-btn[data-busy="1"]{pointer-events:none;opacity:.5}
.dwl-speak-btn[data-done="1"]{color:var(--dsw-alias-state-success-primary)}
.dwl-speak-btn svg{width:16px;height:16px;fill:currentColor}
.dwl-accent{font:inherit;font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 6px;
  border:1px solid var(--dwl-btn-border);border-radius:5px;background:var(--dwl-btn-bg);
  color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:color .15s ease,border-color .15s ease}
.dwl-accent:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}

/* 先藏后揭 */
.dwl-reveal{margin-top:24px;min-height:150px;width:100%;display:flex;flex-direction:column;
  align-items:center;justify-content:center}
.dwl-veil{display:inline-flex;align-items:center;gap:8px;border:1.5px dashed var(--dsw-alias-brand-primary,#0d9488);
  background:var(--dwl-tint);border-radius:10px;padding:10px 16px;cursor:pointer;font:inherit;font-size:12.5px;
  color:var(--dsw-alias-label-secondary);transition:background .15s ease,border-color .15s ease}
.dwl-veil:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary)}
.dwl-body{display:none;width:100%}
.dwl-reveal[data-on="1"] .dwl-veil{display:none}
.dwl-reveal[data-on="1"] .dwl-body{display:block;animation:dwl-fade .2s ease}
@keyframes dwl-fade{from{opacity:0}to{opacity:1}}
.dwl-meaning{font-size:17px;line-height:1.55}
.dwl-meaning .lead{color:var(--dsw-alias-brand-primary)}
.dwl-sense{margin-top:6px;font-size:13.5px;color:var(--dsw-alias-label-secondary)}
.dwl-hintline{margin-top:14px;font-size:12px;color:var(--dsw-alias-label-secondary)}

/* 补记：回忆 → 对照 → 拼写 */
.dwl-sentence{margin-top:16px;width:100%;text-align:left;font-size:15px;line-height:1.7;
  color:var(--dsw-alias-label-secondary);word-break:break-word}
.dwl-sentence mark{background:rgba(13,148,136,.14);color:inherit;border-radius:3px;padding:0 2px}
.dwl-blank{color:var(--dsw-alias-brand-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.04em}
.dwl-recall{width:100%;margin-top:14px}
.dwl-recall textarea{width:100%;min-height:62px;resize:vertical;font:inherit;font-size:14px;
  padding:10px 12px;border-radius:10px;color:inherit;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dwl-btn-border)}
.dwl-recall textarea:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.dwl-compare{margin-top:4px;padding:10px 14px;border-radius:9px;background:var(--dwl-tint);text-align:left}
.dwl-compare .k{font-size:11px;letter-spacing:.05em;color:var(--dsw-alias-label-secondary)}
.dwl-compare .v{font-size:15px;margin-top:2px}
.dwl-cloze-input{width:100%;margin-top:14px;padding:10px 12px;border-radius:10px;font:inherit;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:.04em;
  color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dwl-btn-border)}
.dwl-cloze-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.dwl-answerline{display:flex;align-items:baseline;justify-content:center;gap:8px;margin-top:12px;
  font-size:15px;color:var(--dsw-alias-label-primary)}
.dwl-answerline .k{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dwl-answerline b{font-size:20px;letter-spacing:.03em;color:var(--dsw-alias-brand-primary);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dwl-action-row button:disabled{opacity:.5;cursor:default}
.dwl-pick{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;margin-top:14px}
.dwl-pick-btn{min-height:44px;padding:8px 10px;border-radius:10px;font:inherit;font-size:14px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dwl-btn-border);cursor:pointer;transition:border-color .14s ease,background .14s ease}
.dwl-pick-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);background:var(--dwl-tint)}
.dwl-pick-btn:disabled{opacity:.6;cursor:default}
.dwl-contrast{width:100%;margin-top:8px;text-align:left;font-size:16px;line-height:1.7}
.dwl-contrast b{color:var(--dsw-alias-state-warn-primary)}
.dwl-contrast b.right{color:var(--dsw-alias-brand-primary)}
.dwl-why{margin-top:12px;padding:10px 14px;border-radius:9px;text-align:left;font-size:13.5px;
  line-height:1.65;color:var(--dsw-alias-label-secondary);
  background:var(--dwl-tint);border-left:3px solid var(--dsw-alias-brand-primary)}
.dwl-etym{margin-top:10px;font-size:12.5px;line-height:1.6;text-align:left;
  color:var(--dsw-alias-label-tertiary)}

/* 评分：4 个 48px 目标 */
.dwl-rate{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;width:100%;margin-top:14px}
.dwl-rate button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  min-height:48px;padding:8px 4px;border-radius:11px;cursor:pointer;font:inherit;
  border:1px solid var(--dwl-btn-border);background:var(--dsw-alias-bg-layer-1);
  transition:transform .12s ease,background .14s ease,border-color .14s ease,box-shadow .14s ease}
.dwl-rate button:hover:not(:disabled){transform:translateY(-1px);box-shadow:var(--dwl-shadow)}
.dwl-rate button:active:not(:disabled){transform:none}
.dwl-rate button:disabled{opacity:.5;cursor:default}
.dwl-rate .rl{font-size:13px;font-weight:600}
.dwl-rate .rk{font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dwl-rate button[data-tone="again"]{border-color:rgba(220,38,38,.35);background:rgba(220,38,38,.06)}
.dwl-rate button[data-tone="again"] .rl{color:var(--dwl-again-text)}
.dwl-rate button[data-tone="again"]:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);background:rgba(220,38,38,.10)}
.dwl-rate button[data-tone="again"]:hover:not(:disabled) .rl{color:var(--dwl-again-text)}
.dwl-rate button[data-tone="hard"]{border-color:rgba(217,119,6,.35);background:rgba(217,119,6,.06)}
.dwl-rate button[data-tone="hard"] .rl{color:var(--dwl-hard-text)}
.dwl-rate button[data-tone="hard"]:hover:not(:disabled){border-color:var(--dsw-alias-state-warn-primary);background:rgba(217,119,6,.10)}
.dwl-rate button[data-tone="hard"]:hover:not(:disabled) .rl{color:var(--dwl-hard-text)}
.dwl-rate button[data-tone="good"]{border-color:rgba(22,163,74,.35);background:rgba(22,163,74,.06)}
.dwl-rate button[data-tone="good"] .rl{color:var(--dwl-good-text)}
.dwl-rate button[data-tone="good"]:hover:not(:disabled){border-color:var(--dsw-alias-state-success-primary);background:rgba(22,163,74,.10)}
.dwl-rate button[data-tone="good"]:hover:not(:disabled) .rl{color:var(--dwl-good-text)}
.dwl-rate button[data-tone="easy"]{border-color:rgba(37,99,235,.35);background:rgba(37,99,235,.06)}
.dwl-rate button[data-tone="easy"] .rl{color:var(--dwl-easy-text)}
.dwl-rate button[data-tone="easy"]:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);background:rgba(37,99,235,.10)}
.dwl-rate button[data-tone="easy"]:hover:not(:disabled) .rl{color:var(--dwl-easy-text)}

/* 三分支自评 */
.dwl-branch{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;margin-top:20px}
.dwl-branch button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
  min-height:56px;padding:10px 6px;border-radius:12px;cursor:pointer;font:inherit;
  border:1.5px solid var(--dwl-btn-border);background:var(--dsw-alias-bg-layer-1);
  transition:transform .12s ease,background .14s ease,border-color .14s ease,box-shadow .14s ease}
.dwl-branch button:hover:not(:disabled){transform:translateY(-1px);box-shadow:var(--dwl-shadow)}
.dwl-branch button:active:not(:disabled){transform:none}
.dwl-branch button:disabled{opacity:.65;cursor:default;transform:none;filter:grayscale(.2)}
.dwl-branch .bl{font-size:15px;font-weight:700}
.dwl-branch .bd{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dwl-branch button[data-tone="again"]{border-color:rgba(220,38,38,.35);background:rgba(220,38,38,.06)}
.dwl-branch button[data-tone="again"] .bl{color:var(--dwl-again-text)}
.dwl-branch button[data-tone="again"]:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);background:rgba(220,38,38,.10)}
.dwl-branch button[data-tone="again"]:hover:not(:disabled) .bl{color:var(--dwl-again-text)}
.dwl-branch button[data-tone="hard"]{border-color:rgba(217,119,6,.35);background:rgba(217,119,6,.06)}
.dwl-branch button[data-tone="hard"] .bl{color:var(--dwl-hard-text)}
.dwl-branch button[data-tone="hard"]:hover:not(:disabled){border-color:var(--dsw-alias-state-warn-primary);background:rgba(217,119,6,.10)}
.dwl-branch button[data-tone="hard"]:hover:not(:disabled) .bl{color:var(--dwl-hard-text)}
.dwl-branch button[data-tone="good"]{border-color:rgba(22,163,74,.35);background:rgba(22,163,74,.06)}
.dwl-branch button[data-tone="good"] .bl{color:var(--dwl-good-text)}
.dwl-branch button[data-tone="good"]:hover:not(:disabled){border-color:var(--dsw-alias-state-success-primary);background:rgba(22,163,74,.10)}
.dwl-branch button[data-tone="good"]:hover:not(:disabled) .bl{color:var(--dwl-good-text)}

/* 记忆提示（词根/场景/mnemonic） */
.dwl-hints{width:100%;margin-top:18px;text-align:left;animation:dwl-fade .25s ease}
.dwl-hint-section{margin-top:12px}
.dwl-hint-section:first-child{margin-top:0}
.dwl-hint-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;
  color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.dwl-hint-roots{display:flex;flex-wrap:wrap;gap:6px}
.dwl-root-tag{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:7px;
  background:var(--dwl-tint);font-size:12.5px}
.dwl-root-tag .part{font-weight:700;color:var(--dsw-alias-brand-primary)}
.dwl-root-tag .rmean{color:var(--dsw-alias-label-secondary)}
.dwl-mnemonic{font-size:13.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);
  padding:10px 14px;border-radius:9px;background:var(--dwl-tint);border-left:3px solid var(--dsw-alias-brand-primary)}
.dwl-confusables{display:flex;flex-wrap:wrap;gap:6px;font-size:12.5px}

/* 悬浮释义：易混淆词/近义词这种"只给一个英文词"的地方，停留就浮出释义卡 */
.dwl-hoverword{position:relative;display:inline-block;padding:3px 8px;border-radius:6px;
  background:var(--dwl-tint);color:var(--dsw-alias-label-secondary);cursor:help;
  outline:none;font-size:12.5px;line-height:1.5;
  text-decoration:underline dotted var(--dsw-alias-label-tertiary);text-underline-offset:2px}
.dwl-hoverword:hover,.dwl-hoverword:focus-visible{color:var(--dsw-alias-label-primary);
  box-shadow:inset 0 0 0 1px var(--dwl-btn-border)}
.dwl-hovercard{position:fixed;z-index:9995;display:block;padding:10px 12px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dwl-btn-border);
  box-shadow:0 10px 28px rgba(0,0,0,.2);font-size:12.5px;line-height:1.55;
  color:var(--dsw-alias-label-primary);text-align:left;cursor:auto;animation:dwl-fade .12s ease}
body[data-ds-dark-theme] .dwl-hovercard{background:var(--dsw-alias-bg-layer-1,#242424);
  box-shadow:0 12px 32px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08)}
.dwl-hovercard-head{display:flex;align-items:baseline;gap:6px;margin-bottom:6px}
.dwl-hovercard-head b{font-size:15px;font-family:ui-serif,Georgia,"Songti SC",serif}
.dwl-hovercard-head i{font-style:normal;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dwl-hovercard-senses{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
.dwl-hovercard-sense{display:block;color:var(--dsw-alias-label-secondary)}
.dwl-hovercard-foot{display:flex;align-items:center;gap:8px;
  border-top:1px solid var(--dwl-btn-border);padding-top:8px}
.dwl-hovercard-add{font:inherit;font-size:12px;font-weight:600;padding:4px 10px;border-radius:7px;
  border:1px solid transparent;background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base);cursor:pointer}
.dwl-hovercard-add:disabled{opacity:.5;cursor:default}
.dwl-hovercard-saved{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.dwl-hovercard-loading{color:var(--dsw-alias-label-secondary);font-size:12px}
.dwl-hovercard-err{color:var(--dsw-alias-state-error-primary);font-size:12px}

/* 选择题 */
.dwl-quiz{width:100%;margin-top:18px;animation:dwl-fade .25s ease}
.dwl-quiz-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:10px;text-align:left}
.dwl-options{display:flex;flex-direction:column;gap:6px}
.dwl-opt{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;cursor:pointer;
  border:1.5px solid var(--dwl-btn-border);background:var(--dsw-alias-bg-layer-1);
  font:inherit;font-size:13.5px;text-align:left;width:100%;
  transition:border-color .15s ease,background .15s ease}
.dwl-opt:hover:not([data-locked]){border-color:var(--dsw-alias-brand-primary);background:var(--dwl-tint)}
.dwl-opt[data-checked="1"]{border-color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)}
.dwl-opt[data-wrong="1"]{border-color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  animation:dwl-shake .35s ease}
@keyframes dwl-shake{0%,100%{transform:none}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.dwl-opt[data-locked]{cursor:default}
.dwl-opt .check{width:18px;height:18px;border-radius:5px;border:1.5px solid var(--dwl-btn-border);
  flex:none;display:flex;align-items:center;justify-content:center;
  transition:border-color .15s ease,background .15s ease}
.dwl-opt[data-checked="1"] .check{border-color:var(--dsw-alias-state-success-primary);
  background:var(--dsw-alias-state-success-primary);color:#fff}
.dwl-opt[data-wrong="1"] .check{border-color:var(--dsw-alias-state-error-primary);
  background:var(--dsw-alias-state-error-primary);color:#fff}
.dwl-quiz-score{margin-top:14px;text-align:center;font-size:14px;font-weight:600;animation:dwl-fade .3s ease}
.dwl-quiz-score .pct{font-size:20px;font-variant-numeric:tabular-nums}
.dwl-quiz-score .ok{color:var(--dsw-alias-state-success-primary)}
.dwl-quiz-score .meh{color:var(--dsw-alias-state-warn-primary)}
.dwl-quiz-score .bad{color:var(--dsw-alias-state-error-primary)}

/* 写得出：看中文拼单词 */
.dwl-word-cn{font-family:inherit;font-size:clamp(19px,2.8vw,25px);line-height:1.5;font-weight:600;
  letter-spacing:0;max-width:36em}
.dwl-write{display:flex;gap:8px;align-items:stretch}
.dwl-write input{flex:1 1 auto;min-width:0;font:inherit;font-size:19px;letter-spacing:.02em;
  padding:10px 12px;border-radius:10px;border:1px solid var(--dwl-btn-border);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none}
.dwl-write input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px var(--dwl-tint)}
.dwl-write input[data-state="exact"]{border-color:var(--dsw-alias-state-success-primary)}
.dwl-write input[data-state="close"]{border-color:var(--dsw-alias-state-warn-primary)}
.dwl-write input[data-state="miss"]{border-color:var(--dsw-alias-state-error-primary)}
.dwl-write button{font:inherit;font-size:13px;font-weight:600;padding:0 18px;border-radius:10px;
  border:1px solid transparent;background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base);cursor:pointer}
.dwl-write button:disabled{opacity:.45;cursor:default}
.dwl-write-result{margin-top:12px;font-size:14px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.dwl-write-result>div:first-child{font-weight:600}
.dwl-write-result[data-state="exact"]>div:first-child{color:var(--dsw-alias-state-success-primary)}
.dwl-write-result[data-state="close"]>div:first-child{color:var(--dsw-alias-state-warn-primary)}
.dwl-write-result[data-state="miss"]>div:first-child{color:var(--dsw-alias-state-error-primary)}
.dwl-write-result b{font-family:ui-serif,Georgia,"Songti SC",serif;font-size:18px;
  color:var(--dsw-alias-label-primary)}

/* 分支内的操作按钮 */
.dwl-action-row{display:flex;justify-content:center;gap:10px;margin-top:16px}
.dwl-action-row button{font:inherit;font-size:13px;font-weight:600;padding:8px 20px;border-radius:9px;
  cursor:pointer;border:1.5px solid var(--dwl-btn-border);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);transition:transform .12s ease,border-color .14s ease,box-shadow .14s ease}
.dwl-action-row button:hover:not(:disabled){transform:translateY(-1px);box-shadow:var(--dwl-shadow);
  border-color:var(--dsw-alias-brand-primary)}
.dwl-action-row button.primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent}
.dwl-action-row button.primary:hover:not(:disabled){filter:brightness(1.12);box-shadow:0 4px 12px rgba(0,0,0,.2)}
.dwl-action-row button:disabled{opacity:.65;cursor:default;transform:none;filter:grayscale(.2)}

/* 底部：进度点 + 快捷键 */
.dwl-tail{margin-top:16px;display:flex;flex-direction:column;align-items:center;gap:10px;padding-bottom:4px}
.dwl-dots{display:flex;gap:5px;justify-content:center;flex-wrap:wrap;max-width:420px}
/* 未到的点用描边而不是填充：填充色只有 1 个 token 的差值，
   在浅色底上几乎看不见，进度就读不出来 */
.dwl-dots i{width:7px;height:7px;border-radius:50%;box-sizing:border-box;
  border:1px solid var(--dsw-alias-label-tertiary);opacity:.85}
.dwl-dots i.done{background:var(--dsw-alias-brand-primary);border-color:transparent;opacity:1}
.dwl-dots i.now{background:var(--dsw-alias-label-primary);border-color:transparent;opacity:1;
  transform:scale(1.45)}
.dwl-keys{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;
  font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dwl-page kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1;
  padding:3px 5px;border-radius:4px;border:1px solid var(--dwl-btn-border);border-bottom-width:2px;
  color:var(--dsw-alias-label-secondary)}

/* 空 / 完成 / 骨架 */
.dwl-mid{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;gap:10px;padding:40px 0}
.dwl-mid .big{font-size:34px;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums}
.dwl-mid .ttl{font-size:15px;font-weight:600}
.dwl-mid .sub{font-size:12.5px;color:var(--dsw-alias-label-tertiary);max-width:36ch;line-height:1.7}
.dwl-btn{font:inherit;font-size:12.5px;padding:7px 14px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dwl-btn-border);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);transition:background .14s ease}
.dwl-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dwl-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;
  color:var(--dsw-alias-bg-base)}
.dwl-btn.primary:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-brand-primary)}
.dwl-skel{height:11px;border-radius:5px;background:var(--dsw-alias-bg-skeleton);margin:8px 0}

/* 词汇 */
.dwl-vocab{padding-top:8px;flex:1;display:flex;flex-direction:column}
.dwl-search{display:flex;align-items:center;gap:9px;border:1px solid var(--dwl-btn-border);
  border-radius:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary)}
.dwl-search input{flex:1;min-width:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;outline:none}
.dwl-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dwl-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.dwl-chip{font:inherit;font-size:11.5px;padding:6px 12px;border-radius:99px;cursor:pointer;
  border:1px solid var(--dwl-btn-border);background:var(--dwl-btn-bg);color:var(--dsw-alias-label-secondary);
  transition:background .14s ease,color .14s ease}
.dwl-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwl-chip[aria-pressed="true"]{background:var(--dwl-tint);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 0 0 0 1px var(--dsw-alias-label-primary)}
.dwl-vlist{display:grid;grid-template-columns:1fr 1fr;gap:1px 18px;margin-top:12px}
.dwl-vlist-virtual{display:block;max-height:min(60vh, 600px);margin-top:12px}
.dwl-vrow{display:flex;align-items:baseline;gap:8px;padding:8px 10px;border-radius:7px;min-height:40px;
  transition:background .12s ease}
.dwl-vrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwl-vrow .w{font-weight:600;font-size:13.5px;flex:none}
.dwl-vrow .p{font-size:10.5px;color:var(--dsw-alias-label-secondary);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;flex:none}
.dwl-vrow .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12px;color:var(--dsw-alias-label-secondary)}
.dwl-vrow .m{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dwl-more{display:flex;justify-content:center;align-items:center;margin:18px 0 0;gap:10px;font-size:11.5px;
  color:var(--dsw-alias-label-tertiary)}

/* 数据 */
.dwl-stats{padding-top:14px;display:flex;flex-direction:column;gap:14px;flex:1}
.dwl-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--dsw-alias-border-l2);
  border:1px solid var(--dwl-btn-border);border-radius:11px;overflow:hidden}
.dwl-kpi{background:var(--dsw-alias-bg-layer-1);padding:12px 14px;min-width:0}
.dwl-kpi .n{font-size:20px;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums}
.dwl-kpi .l{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwl-panel{border:1px solid var(--dwl-btn-border);border-radius:11px;
  background:var(--dsw-alias-bg-layer-1);padding:14px 16px;min-width:0}
.dwl-panel>h3{margin:0 0 12px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);
  display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.dwl-panel>h3 span{font-weight:400;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dwl-bars{display:flex;align-items:flex-end;gap:4px;height:64px}
.dwl-bars i{flex:1;min-width:0;border-radius:3px 3px 0 0;background:var(--dwl-accent);
  opacity:.9;min-height:2px;transition:opacity .14s ease}
.dwl-bars i.zero{opacity:.3;background:var(--dsw-alias-bg-skeleton)}
.dwl-axis{display:flex;gap:4px;margin-top:5px}
.dwl-axis span{flex:1;text-align:center;font-size:9.5px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;white-space:nowrap}
.dwl-prog{height:7px;border-radius:4px;background:var(--dsw-alias-bg-skeleton);overflow:hidden;
  display:flex;margin:8px 0 9px}
.dwl-prog i{display:block;height:100%}
.dwl-lgd{display:flex;flex-wrap:wrap;gap:12px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dwl-lgd span{display:inline-flex;align-items:center;gap:5px}
.dwl-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
.dwl-abrow{display:flex;align-items:center;gap:10px;margin-top:8px}
.dwl-abrow:first-of-type{margin-top:0}
.dwl-abrow .nm{width:36px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dwl-abrow .hist{flex:1;min-width:0;display:flex;gap:3px;align-items:flex-end;height:24px}
.dwl-abrow .hist i{flex:1;border-radius:2px 2px 0 0;background:var(--dwl-accent);min-height:2px}
.dwl-abrow .hi{font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;flex:none;width:52px;text-align:right}
.dwl-dist{display:flex;align-items:center;gap:9px;font-size:11.5px;margin-top:7px}
.dwl-dist:first-of-type{margin-top:0}
.dwl-dist .nm{width:44px;flex:none;color:var(--dsw-alias-label-secondary)}
.dwl-dist .bar{flex:1;height:8px;border-radius:4px;background:var(--dsw-alias-bg-skeleton);overflow:hidden}
.dwl-dist .bar i{display:block;height:100%}
.dwl-dist .v{width:56px;text-align:right;flex:none;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary)}
.dwl-rows{display:flex;flex-direction:column;gap:1px}
.dwl-row{display:flex;align-items:baseline;gap:10px;padding:6px 8px;border-radius:7px}
.dwl-row .w{font-weight:600;font-size:13px;flex:none;min-width:88px}
.dwl-row .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-secondary);font-size:12px}
.dwl-row .m{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dwl-note{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:10px;line-height:1.65}
.dwl-err{color:var(--dsw-alias-state-error-primary);font-size:12.5px}
.dwl-banner{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:9px;
  border:1px solid var(--dsw-alias-state-error-primary);font-size:12px;margin-bottom:10px;flex:none}
.dwl-banner span{flex:1;min-width:0;color:var(--dsw-alias-state-error-primary)}

@media (max-width:620px){
  .dwl-wrap{padding:0 16px 48px}
  .dwl-vlist{grid-template-columns:1fr}
  .dwl-kpis{grid-template-columns:1fr 1fr}
  .dwl-rate{gap:6px}
  .dwl-branch{gap:6px}
  .dwl-branch .bl{font-size:13px}
  .dwl-word{font-size:32px}
  .dwl-opt{padding:8px 12px;font-size:12.5px}
}
@media (prefers-reduced-motion:reduce){
  .dwl-page *,.dwl-page *::before,.dwl-page *::after{animation:none!important;transition:none!important}
}

/* ── WordMeta 弹窗 ─────────────────────────────── */
.dwl-modal-overlay{position:fixed;inset:0;z-index:9990;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;animation:dwl-fade .15s ease;backdrop-filter:blur(2px)}
.dwl-modal{position:relative;background:var(--dsw-alias-bg-layer-1,#fff);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);width:min(480px,92vw);max-height:82vh;overflow-y:auto;padding:24px 22px 18px;animation:dwl-slide-up .2s ease}
body[data-ds-dark-theme] .dwl-modal{background:var(--dsw-alias-bg-layer-1,#242424);box-shadow:0 12px 48px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08)}
@keyframes dwl-slide-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.dwl-modal-close{position:absolute;top:10px;right:12px;background:none;border:none;cursor:pointer;font-size:18px;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-radius:6px;min-width:32px;min-height:32px;display:inline-flex;align-items:center;justify-content:center;transition:background .12s,color .12s}
.dwl-modal-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dwl-modal h3{margin:0 0 4px;font-size:18px;font-weight:700;color:var(--dsw-alias-label-primary)}
.dwl-modal .dwl-modal-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:16px}
.dwl-meta-section{margin-bottom:14px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dwl-meta-section-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.dwl-meta-section-hd .lbl{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.5px}
.dwl-meta-section-hd .dwl-refresh-btn{background:none;border:none;cursor:pointer;padding:4px 6px;border-radius:5px;color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;min-width:28px;min-height:28px;justify-content:center;transition:color .12s,background .12s}
.dwl-meta-section-hd .dwl-refresh-btn:hover:not(:disabled){color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dwl-meta-section-hd .dwl-refresh-btn:disabled{opacity:.55;cursor:default;filter:grayscale(.2)}
.dwl-meta-section-hd .dwl-refresh-btn svg{width:14px;height:14px}
.dwl-meta-section-hd .dwl-refresh-btn.loading svg{animation:dwl-spin .8s linear infinite}
@keyframes dwl-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes dwl-shimmer{0%{opacity:.45}50%{opacity:.85}100%{opacity:.45}}
.dwl-meta-tags{display:flex;flex-wrap:wrap;gap:5px}
.dwl-meta-tag{display:inline-block;font-size:12px;padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.dwl-meta-root{display:flex;align-items:baseline;gap:4px;font-size:13px;margin-bottom:3px}
.dwl-meta-root .part{font-weight:600;color:var(--dsw-alias-brand-primary)}
.dwl-meta-root .type{font-size:10px;color:var(--dsw-alias-label-tertiary);padding:1px 4px;border-radius:3px;background:var(--dsw-alias-bg-layer-2)}
.dwl-meta-root .meaning{color:var(--dsw-alias-label-secondary)}
.dwl-meta-memo{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.dwl-meta-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);font-style:italic}
.dwl-modal-empty{text-align:center;padding:28px 16px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dwl-modal-empty .dwl-empty-icon{margin-bottom:8px;opacity:.5;color:var(--dsw-alias-label-tertiary);display:flex;justify-content:center}
.dwl-modal-empty .dwl-empty-text{font-size:13px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.dwl-modal-empty .dwl-empty-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px;opacity:.7}
.dwl-modal-actions{display:flex;justify-content:center;gap:10px;margin-top:16px;padding-top:12px;border-top:1px solid var(--dwl-btn-border)}
.dwl-modal-actions button{font:inherit;font-size:13px;font-weight:600;padding:8px 18px;border-radius:9px;cursor:pointer;border:1px solid var(--dwl-btn-border);background:var(--dwl-btn-bg);color:var(--dsw-alias-label-primary);transition:transform .1s,box-shadow .1s,background .12s}
.dwl-modal-actions button:hover:not(:disabled){transform:translateY(-1px);box-shadow:var(--dwl-shadow);background:var(--dsw-alias-interactive-bg-hover)}
.dwl-modal-actions button.primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent}
.dwl-modal-actions button.primary:hover:not(:disabled){filter:brightness(1.12);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.2)}
.dwl-modal-actions button.primary:active:not(:disabled){filter:brightness(.92);transform:none}
.dwl-modal-actions button:disabled{opacity:.65;cursor:default;transform:none;filter:grayscale(.2)}
.dwl-ai-pill{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:99px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);margin-left:8px;vertical-align:middle;letter-spacing:.3px}
.dwl-modal-error{margin-top:10px;padding:8px 12px;border-radius:8px;font-size:12px;color:var(--dsw-alias-state-error-primary,#e53935);background:var(--dwl-error-bg);text-align:center;animation:dwl-fade .15s ease}
.dwl-settings{padding:16px 0;display:flex;flex-direction:column;gap:20px}
.dwl-settings-section{display:flex;flex-direction:column;gap:6px}
.dwl-settings-section .hd{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dwl-settings-section .desc{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.dwl-settings-row{display:flex;align-items:center;gap:10px;min-height:36px}
.dwl-settings-row label{font-size:13px;color:var(--dsw-alias-label-secondary);flex:1}
.dwl-settings-row select{font:inherit;font-size:13px;padding:4px 8px;border-radius:6px;border:1px solid var(--dwl-btn-border);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);color-scheme:inherit}
.dwl-settings-row input[type="checkbox"]{width:18px;height:18px;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}
.dwl-settings-model{font-size:12px;padding:10px 14px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);line-height:1.6;word-break:break-all}
.dwl-settings-row select:disabled{opacity:.6;cursor:default}
.dwl-settings-effect{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dwl-settings-link{font:inherit;font-size:12px;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer}
.dwl-settings-link:hover:not(:disabled){text-decoration:underline}
.dwl-settings-link:disabled{opacity:.6;cursor:default}
.dwl-vrow{cursor:pointer}
.dwl-vrow:hover{background:var(--dsw-alias-bg-layer-2)}

/* ── R5 次日回访 ─────────────────────────────────────────────
   为什么只用 --dsw-alias-* 令牌：回访卡和主学习卡长在同一个 .dwl-page 里，
   写死颜色在深色主题下会变成刺眼白块（DESIGN.md 风险 13）。
   两句英文用 --dwl-tint（作用域内的中性填充）而不是纯白，避免把注意力
   从词义上拉走；对/错的边框用状态令牌，颜色本身就是反馈的一部分。 */
.dwl-recap-q{margin-top:14px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.dwl-recap-pair{width:100%;margin-top:14px;display:flex;flex-direction:column;gap:8px}
.dwl-recap-sent{display:flex;gap:9px;text-align:left;padding:11px 13px;border-radius:10px;
  background:var(--dwl-tint);font-size:14.5px;line-height:1.65;color:var(--dsw-alias-label-primary)}
.dwl-recap-sent .idx{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;padding-top:2px}
.dwl-recap-sent .txt{flex:1;min-width:0;word-break:break-word}
.dwl-recap-choice{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:100%;margin-top:16px}
.dwl-recap-choice .dwl-pick-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px}
.dwl-recap-choice .k{font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  border:1px solid var(--dwl-btn-border);border-radius:4px;padding:0 4px;line-height:1.5}
.dwl-recap-feedback{width:100%;margin-top:16px;padding:12px 15px;border-radius:10px;text-align:left;
  border:1px solid var(--dwl-btn-border);background:var(--dwl-tint)}
.dwl-recap-feedback[data-ok="1"]{border-color:var(--dsw-alias-state-success-primary)}
.dwl-recap-feedback[data-ok="0"]{border-color:var(--dsw-alias-state-warn-primary)}
.dwl-recap-feedback .hd{font-size:13px;font-weight:600;margin-bottom:6px}
.dwl-recap-feedback[data-ok="1"] .hd{color:var(--dsw-alias-state-success-primary)}
.dwl-recap-feedback[data-ok="0"] .hd{color:var(--dsw-alias-state-warn-primary)}
.dwl-recap-feedback .row{display:flex;gap:8px;font-size:13.5px;line-height:1.6;margin-top:2px}
.dwl-recap-feedback .row .k{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;padding-top:2px}
.dwl-recap-feedback .dwl-action-row{margin-top:12px}
.dwl-recap-skip{margin-top:14px;font:inherit;font-size:11.5px;border:0;background:transparent;
  color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:6px 10px;border-radius:7px}
.dwl-recap-skip:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}

/* 义项地图（词汇页详情面板）。
   三个状态点用状态令牌而不是固定色：深色主题下要保证对比度由主题自己负责。 */
.dwl-sense-legend{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dwl-sense-map{display:flex;flex-direction:column;gap:6px}
.dwl-sense-row{display:flex;align-items:center;gap:8px;font-size:13px;min-height:24px}
.dwl-sense-row .gloss{flex:1;min-width:0;color:var(--dsw-alias-label-primary)}
.dwl-sense-row .st{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dwl-sense-row[data-status="seen"] .dwl-dot{background:var(--dsw-alias-label-tertiary);opacity:.45}
.dwl-sense-row[data-status="right"] .dwl-dot{background:var(--dsw-alias-state-success-primary)}
.dwl-sense-row[data-status="wrong"] .dwl-dot{background:var(--dsw-alias-state-error-primary)}
.dwl-sense-row[data-status="right"] .gloss{color:var(--dsw-alias-state-success-primary)}
.dwl-sense-row[data-status="wrong"] .gloss{color:var(--dsw-alias-state-error-primary)}
`

  window.__dwlDashboardCSS = CSS
  // 通知可能先 apply 的 dashboard.js：样式已就绪（它自己还会兜底轮询）。
  window.dispatchEvent(new CustomEvent('dwl:assets-ready'))
})()
