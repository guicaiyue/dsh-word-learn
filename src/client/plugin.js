/**
 * 学习页 —— dsh-word-learn 的浏览器侧。
 *
 * ─────────────────────────────────────────────────────────────
 * 这一半做什么
 * ─────────────────────────────────────────────────────────────
 * 两个 slot：
 *
 * ① `sidebar.panellist`：左栏上半部分的入口图标。
 *    注册时的 `id` **就是**下面 `main` 的 `key` —— 侧栏点击时调
 *    `selectPanel(id)`，框架用同一个 id 去 `main` 里找面板。
 *    这是照 dsh-client-ui-schedule 的做法（它就是这么挂"定时任务"的）。
 *
 * ② `main`：点开后的整页。keyed slot，`key: PANEL_ID`。
 *
 * ─────────────────────────────────────────────────────────────
 * 三个视图（2026-11 重构的核心）
 * ─────────────────────────────────────────────────────────────
 * **学习**（默认）：一屏一词。释义先藏起来，按空格揭晓，再按 1-4 评分。
 *   —— 以前是"一屏铺 50 行、每行 4 个按钮"，等于开卷考试：
 *      没有回忆就没有记忆，而且 200 个按钮把复习变成了填表。
 *   用游标（`cursor`）而不是删行：评分只让游标前进，队列本身不动，
 *   这样"还剩几个"和进度条永远一致。
 *
 *   **两条线练的东西不一样**：认得出（receptive）是"看英文选释义"；
 *   写得出（productive）是"看中文拼英文"——顶部显示中文释义、藏起单词和音标，
 *   提交后对照正确拼写再自评。
 *
 * **词汇**：两列紧凑行，一屏约 38 个词（原来一屏 9.5 个）。按档位筛选
 *   走 `/list?tier=`；搜索是**已加载集合**内的过滤 —— 服务器没有搜索参数，
 *   所以界面上直说"在已加载的 N 条里搜"，不假装是全库搜索。
 *
 * **数据**：原来的 KPI、14 天曲线、能力画像、作答分布全搬到这里。
 *   首屏不再放报表 —— 进来先看到"该做什么"，而不是"我做过什么"。
 *
 * ─────────────────────────────────────────────────────────────
 * 发音（浏览器自带语音合成，零网络）
 * ─────────────────────────────────────────────────────────────
 * 注入的 voice.js 提供 `window.__dwlVoice`，内部就是 speechSynthesis：
 * 不需要 key、不需要网络，Windows 上直接用系统里的 Microsoft 音色。
 * 服务端发音链路（路由、磁盘缓存、预取）已经整体删除 —— 用户明确只要
 * 浏览器自带的免费前端语音。与 wordcard.js 共用同一份口音偏好。
 * 学习视图按 S 或点喇叭图标即可朗读，口音切换（US / UK）持久化到
 * localStorage，wordcard 划词卡片也读同一个偏好。
 *
 * ─────────────────────────────────────────────────────────────
 * 文案怎么处理
 * ─────────────────────────────────────────────────────────────
 * 分两类：
 *   - **面板标题**（侧栏入口的 label）必须让框架拿到，走 `ctx.locale` ——
 *     注册 `DICT` 目录后用 `t('panel.title')`。注意 `locale: NS` 本身
 *     只是声明，不注册目录的话 t() 会**退回返回原始 key**，
 *     侧栏就显示 "panel.title" 这种字样。
 *   - **页面内的文案**跟着数据变（"今日待复习 12 个词"这种），
 *     集中放在文件顶部的常量里，不走 t()，避免为了拼接而绕远路。
 *
 * ─────────────────────────────────────────────────────────────
 * 样式
 * ─────────────────────────────────────────────────────────────
 * 全部用 DSH 主题令牌 `--dsw-alias-*`，不写死颜色。
 * 理由见 DESIGN.md 风险 13：写死颜色在深色主题下会变成刺眼的白块。
 * 真实令牌值（浅/深）见 DESIGN.md 风险 13 的附表 —— 要验对比度请查表，
 * 不要凭感觉填色，我因此误判过一次。
 *
 * 只有两个例外，都定义在 `.dwl-page` 作用域内（不污染宿主）：
 *   `--dwl-shadow` 面板阴影、`--dwl-tint` 中性填充 —— 这两个没有对应令牌，
 *   深浅两套主题各写一份，跟着 `body[data-ds-dark-theme]` 切换。
 */

import React from 'react'
import LOGIC from './dashboard/logic.js'
import { CSS as DASHBOARD_CSS } from './dashboard/styles.js'

const h = React.createElement
const { useCallback, useEffect, useMemo, useRef, useState } = React

/** 本插件的 locale 命名空间。 */
const NS = 'dsh-word-learn'

/** 侧栏入口与主面板共用的 id。两者必须一致，否则点了没反应。 */
const PANEL_ID = 'word-learn'

// 无 React 依赖的纯函数/常量现在是本 bundle 的模块（./dashboard/logic.js）。
// 历史上它们是注入脚本、靠 window.__dwlDashboardLogic + 就绪轮询消费，
// 阶段 2 起构建期就绑好了：不存在「晚到」，也就不需要加载态兜底。
const assetOf = (name) => LOGIC[name]
const bind =
  (name) =>
  (...args) =>
    (assetOf(name) || (() => undefined))(...args)

const api = bind('api')
const fmtMD = bind('fmtMD')
const splitSenses = bind('splitSenses')
const wordSpot = bind('wordSpot')
const playWord = bind('playWord')
const loadAutoSpeak = bind('loadAutoSpeak')
const loadAccent = bind('loadAccent')
const saveAccent = bind('saveAccent')
const readView = bind('readView')
const normalizeSpelling = bind('normalizeSpelling')
const editDistance = bind('editDistance')
const spellCheck = bind('spellCheck')
const tierBadgeOf = bind('tierBadgeOf')
const tierLabelOf = bind('tierLabelOf')
const quizRating = bind('quizRating')
const writeRating = bind('writeRating')
const hoverPlacement = bind('hoverPlacement')

// ---------------------------------------------------------------- 图标

/** 放大镜。跟侧栏那支同一套风格：线性、圆头、1.9 描边。 */
function IconSearch(props) {
  const size = (props && props.size) || 14
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.9,
      strokeLinecap: 'round',
      'aria-hidden': true,
      style: { flex: 'none' },
    },
    h('circle', { cx: 11, cy: 11, r: 7 }),
    h('path', { d: 'm20 20-3.5-3.5' }),
  )
}

/** 侧栏图标：一本翻开的书 + 一个正在学的词。 */
function PanelIcon(props) {
  const size = (props && props.size) || 18
  const active = !!(props && props.active)
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    h('path', {
      d: 'M3 5.2c2.6-.9 5-1.3 7.2-1.2.6 0 1 .4 1 .9v12.6c0 .6-.5 1-1 .9-2.1-.2-4.4.1-6.7.9-.4.1-.8-.2-.8-.6V5.8c0-.3.1-.5.3-.6Z',
      fill: active ? 'currentColor' : 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
      opacity: active ? 0.22 : 1,
    }),
    h('path', {
      d: 'M3 5.2c2.6-.9 5-1.3 7.2-1.2.6 0 1 .4 1 .9v12.6c0 .6-.5 1-1 .9-2.1-.2-4.4.1-6.7.9-.4.1-.8-.2-.8-.6V5.8c0-.3.1-.5.3-.6Z',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
    }),
    h('path', {
      d: 'M21 5.2c-2.6-.9-5-1.3-7.2-1.2-.6 0-1 .4-1 .9v12.6c0 .6.5 1 1 .9 2.1-.2 4.4.1 6.7.9.4.1.8-.2.8-.6V5.8c0-.3-.1-.5-.3-.6Z',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
    }),
    h('circle', {
      cx: 12,
      cy: 12,
      r: 3.1,
      fill: 'var(--dsw-alias-bg-base, #fff)',
      stroke: 'currentColor',
      strokeWidth: 1.4,
    }),
    h('path', {
      d: 'M11 10.6h1.6c.5 0 .9.4.9.9s-.4.9-.9.9H12l1.7 1.7',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

// ---------------------------------------------------------------- 小组件

/** 柱状图。数据是 [{date, count}]。 */
function Bars({ data, titleFor }) {
  const max = Math.max(1, ...data.map((d) => d.count))
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'dwl-bars' },
      data.map((d, i) =>
        h('i', {
          key: i,
          className: d.count ? '' : 'zero',
          style: { height: `${Math.max(2, (d.count / max) * 100)}%` },
          title: titleFor(d),
        }),
      ),
    ),
    h(
      'div',
      { className: 'dwl-axis' },
      data.map((d, i) => h('span', { key: i }, fmtMD(d.date))),
    ),
  )
}

/** 一条堆叠进度条 + 图例。 */
function StackedProgress({ parts, total }) {
  const sum = total || parts.reduce((s, p) => s + p.value, 0)
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'dwl-prog' },
      parts
        .filter((p) => p.value > 0)
        .map((p, i) =>
          h('i', {
            key: i,
            style: { width: `${sum ? (p.value / sum) * 100 : 0}%`, background: p.color },
            title: `${p.label}：${p.value}`,
          }),
        ),
    ),
    h(
      'div',
      { className: 'dwl-lgd' },
      parts.map((p, i) =>
        h(
          'span',
          { key: i },
          h('i', { className: 'dwl-dot', style: { background: p.color } }),
          `${p.label} ${p.value}`,
        ),
      ),
    ),
  )
}

/** 0-5 分的直方图。 */
function Histogram({ buckets, max }) {
  const m = Math.max(1, max)
  return h(
    'div',
    { className: 'hist' },
    buckets.map((n, i) =>
      h('i', {
        key: i,
        style: { height: `${Math.max(2, (n / m) * 100)}%`, opacity: n ? 0.78 : 0.18 },
        title: `${i} 分：${n} 个词`,
      }),
    ),
  )
}

// ---------------------------------------------------------------- 新组件：三分支复习流程

/** 三分支自评按钮（忘了 / 模糊 / 记得）。 */
function BranchBar({ onBranch, disabled }) {
  return h(
    'div',
    { className: 'dwl-branch', role: 'group', 'aria-label': '你记得这个词吗' },
    (assetOf('BRANCHES') || []).map((b) =>
      h(
        'button',
        {
          key: b.key,
          type: 'button',
          'data-tone': b.tone,
          disabled,
          'aria-label': `${b.label}——${b.desc}`,
          onClick: () => onBranch(b.key),
        },
        h('span', { className: 'bl' }, b.label),
        h('span', { className: 'bd' }, b.desc),
      ),
    ),
  )
}

/**
 * 记忆提示面板：词根词缀、记忆场景、易混淆词。
 * meta 可能是 null（AI 还没跑完），此时降级为空。
 */
// ---------------------------------------------------------------- 悬浮释义

/**
 * HoverWord —— "只给一个英文词"的地方（易混淆词、近义词）的悬浮释义。
 *
 * 鼠标停留 280ms / 聚焦 / 点击就查一次词典（`save:false`，只看不记），
 * 浮出和划词卡片同款的释义卡；卡片里点「加入生词本」才真正写库 ——
 * 否则鼠标扫过一排易混淆词就全进了生词本，那是噪音。
 */
function HoverWord({ word }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [pos, setPos] = useState(null)
  const anchorRef = useRef(null)
  const openTimer = useRef(null)
  const closeTimer = useRef(null)

  /** 算固定坐标：几何在 ./dashboard/logic.js（hoverPlacement），这里只取视口尺寸。 */
  const place = useCallback(() => {
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1200
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
    setPos(hoverPlacement(anchorRef.current, vw, vh))
  }, [])

  const load = useCallback(async () => {
    if (data || error) return
    try {
      const r = await api('/lookup?word=' + encodeURIComponent(word) + '&enrich=false&save=false')
      if (r && r.ok) setData(r)
      else setError((r && r.error) || '查不到这个词')
    } catch (err) {
      setError('查不到这个词')
    }
  }, [word, data, error])

  const show = useCallback(() => {
    clearTimeout(closeTimer.current)
    place()
    setOpen(true)
    load()
  }, [place, load])

  const scheduleClose = useCallback(() => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 260)
  }, [])

  const addToVocabulary = useCallback(async () => {
    if (saving || (data && data.saved)) return
    setSaving(true)
    try {
      const r = await api('/lookup', {
        method: 'POST',
        body: { word, enrich: false, save: true },
      })
      if (r && r.ok) setData(r)
    } finally {
      setSaving(false)
    }
  }, [word, saving, data])

  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    [],
  )

  const senses = (data && data.dict && data.dict.senses) || []
  return h(
    'span',
    {
      className: 'dwl-hoverword',
      ref: anchorRef,
      tabIndex: 0,
      role: 'button',
      'aria-label': word + '：停留查看释义',
      onMouseEnter: () => {
        clearTimeout(closeTimer.current)
        openTimer.current = setTimeout(show, 280)
      },
      onMouseLeave: scheduleClose,
      onFocus: show,
      onBlur: scheduleClose,
      onClick: (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (open) setOpen(false)
        else show()
      },
    },
    h('span', { lang: 'en' }, word),
    open && pos
      ? h(
          'span',
          {
            className: 'dwl-hovercard',
            role: 'dialog',
            'aria-label': word + ' 的释义',
            style: { left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px' },
            onMouseEnter: () => clearTimeout(closeTimer.current),
            onMouseLeave: scheduleClose,
            onClick: (e) => e.stopPropagation(),
          },
          error
            ? h('span', { className: 'dwl-hovercard-err' }, error)
            : !data
              ? h('span', { className: 'dwl-hovercard-loading' }, '查询中…')
              : h(
                  'span',
                  null,
                  h(
                    'span',
                    { className: 'dwl-hovercard-head' },
                    h('b', { lang: 'en' }, data.dict.word),
                    data.dict.phonetic ? h('i', null, '/' + data.dict.phonetic + '/') : null,
                  ),
                  h(
                    'span',
                    { className: 'dwl-hovercard-senses' },
                    senses
                      .slice(0, 3)
                      .map((s, i) =>
                        h(
                          'span',
                          { key: i, className: 'dwl-hovercard-sense' },
                          (s.pos ? s.pos + ' ' : '') + s.text,
                        ),
                      ),
                  ),
                  h(
                    'span',
                    { className: 'dwl-hovercard-foot' },
                    data.saved
                      ? h(
                          'span',
                          { className: 'dwl-hovercard-saved' },
                          '✓ 已在生词本 · 遇见 ' + data.saved.seenCount + ' 次',
                        )
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'dwl-hovercard-add',
                            disabled: saving,
                            onClick: (e) => {
                              e.stopPropagation()
                              addToVocabulary()
                            },
                          },
                          saving ? '加入中…' : '＋ 加入生词本',
                        ),
                  ),
                ),
        )
      : null,
  )
}

function MemoryHints({ meta }) {
  if (!meta) {
    return h(
      'div',
      { className: 'dwl-hints' },
      h('div', { className: 'dwl-hint-label' }, 'AI 分析还没就绪'),
      h(
        'div',
        { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 } },
        '这个词的记忆提示正在后台生成，下次复习时会有',
      ),
    )
  }
  const parts = []

  // 词根词缀
  if (meta.roots && meta.roots.length) {
    parts.push(
      h(
        'div',
        { className: 'dwl-hint-section', key: 'roots' },
        h('div', { className: 'dwl-hint-label' }, '词根词缀'),
        h(
          'div',
          { className: 'dwl-hint-roots' },
          meta.roots.map((r, i) =>
            r
              ? h(
                  'span',
                  { key: i, className: 'dwl-root-tag' },
                  h('span', { className: 'part' }, r.part),
                  h('span', { className: 'rmean' }, r.meaning),
                )
              : null,
          ),
        ),
      ),
    )
  }

  // 记忆方法 / 场景
  if (meta.mnemonic) {
    parts.push(
      h(
        'div',
        { className: 'dwl-hint-section', key: 'mnemonic' },
        h('div', { className: 'dwl-hint-label' }, '记忆方法'),
        h('div', { className: 'dwl-mnemonic' }, meta.mnemonic),
      ),
    )
  }

  // 易混淆词
  if (meta.confusables && meta.confusables.length) {
    parts.push(
      h(
        'div',
        { className: 'dwl-hint-section', key: 'confusables' },
        h('div', { className: 'dwl-hint-label' }, '易混淆'),
        h(
          'div',
          { className: 'dwl-confusables' },
          meta.confusables.map((w, i) => h(HoverWord, { key: i, word: String(w) })),
        ),
      ),
    )
  }

  if (!parts.length) {
    return h(
      'div',
      { className: 'dwl-hints' },
      h(
        'div',
        { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } },
        '暂无额外记忆提示',
      ),
    )
  }
  return h('div', { className: 'dwl-hints' }, parts)
}

/** 小对号 SVG。 */
function CheckSVG() {
  return h(
    'svg',
    {
      width: 12,
      height: 12,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    h('polyline', { points: '20 6 9 17 4 12' }),
  )
}

/** 小叉 SVG。 */
function CrossSVG() {
  return h(
    'svg',
    {
      width: 12,
      height: 12,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    h('line', { x1: 18, y1: 6, x2: 6, y2: 18 }),
    h('line', { x1: 6, y1: 6, x2: 18, y2: 18 }),
  )
}

/**
 * 选择题面板。
 *
 * 交互规则：
 *   - options 是 [{text, correct}] 的打乱数组
 *   - 点击一个选项：
 *     · 如果是正确选项 → 打勾，标绿
 *     · 如果是错误选项 → 打叉，摇动，0.5s 后消失
 *   - 选完所有正确选项后自动结算
 *   - 显示正确率：已选正确 / 总选项数（包含错误选项的尝试也计入分母）
 *   - onFinish(score) 在结算后回调
 */
function QuizPanel({ quiz, onFinish }) {
  const [checked, setChecked] = useState(new Set())
  const [wrong, setWrong] = useState(new Set())
  const [attempts, setAttempts] = useState(0)
  const [done, setDone] = useState(false)
  const correctCount = quiz ? quiz.correctCount : 0
  const options = quiz ? quiz.options : []

  const handleClick = useCallback(
    (idx) => {
      if (done) return
      const opt = options[idx]
      if (!opt) return
      if (checked.has(idx)) return // 已选的正确项不能反选

      setAttempts((a) => a + 1)

      if (opt.correct) {
        const next = new Set(checked)
        next.add(idx)
        setChecked(next)
        // 选完所有正确选项 → 结算
        if (next.size >= correctCount) {
          setDone(true)
          // 得分 = 正确次数 / 总点击次数
          const totalAttempts = attempts + 1 // 当前这次也算
          const score = correctCount / totalAttempts
          setTimeout(() => onFinish(score), 600)
        }
      } else {
        // 错误选项：闪红+摇动，短暂后清除
        const next = new Set(wrong)
        next.add(idx)
        setWrong(next)
        setTimeout(() => {
          setWrong((prev) => {
            const s = new Set(prev)
            s.delete(idx)
            return s
          })
        }, 500)
      }
    },
    [options, checked, wrong, done, correctCount, attempts, onFinish],
  )

  if (!quiz) {
    return h(
      'div',
      { className: 'dwl-quiz' },
      h('div', { className: 'dwl-quiz-title' }, '无法生成选择题（释义数据不足）'),
    )
  }

  const score = attempts > 0 ? Math.round((checked.size / attempts) * 100) : null
  const scoreClass = score === null ? '' : score >= 80 ? 'ok' : score >= 50 ? 'meh' : 'bad'

  return h(
    'div',
    { className: 'dwl-quiz' },
    h('div', { className: 'dwl-quiz-title' }, `选出这个词的所有正确释义（共 ${correctCount} 个）`),
    h(
      'div',
      { className: 'dwl-options' },
      options.map((opt, idx) =>
        h(
          'button',
          {
            key: idx,
            type: 'button',
            className: 'dwl-opt',
            'data-checked': checked.has(idx) ? '1' : undefined,
            'data-wrong': wrong.has(idx) ? '1' : undefined,
            'data-locked': done ? '' : undefined,
            onClick: () => handleClick(idx),
          },
          h(
            'span',
            { className: 'check' },
            checked.has(idx) ? h(CheckSVG) : wrong.has(idx) ? h(CrossSVG) : null,
          ),
          h('span', null, opt.text),
        ),
      ),
    ),
    done
      ? h(
          'div',
          { className: 'dwl-quiz-score' },
          '正确率 ',
          h('span', { className: 'pct ' + scoreClass }, `${score}%`),
          h(
            'span',
            {
              style: {
                fontSize: '12px',
                marginLeft: 8,
                color: 'var(--dsw-alias-label-tertiary)',
              },
            },
            `（${checked.size}/${attempts} 次点击）`,
          ),
        )
      : checked.size > 0
        ? h(
            'div',
            {
              style: {
                fontSize: '12px',
                color: 'var(--dsw-alias-label-tertiary)',
                marginTop: 8,
                textAlign: 'center',
              },
            },
            `已找到 ${checked.size}/${correctCount} 个正确释义`,
          )
        : null,
  )
}

// ---------------------------------------------------------------- 写得出：看中文拼单词

/**
 * WritePanel —— 产出型练习：给中文释义，把英文单词拼出来。
 *
 * 这才是 "写得出"（productive）那条线该练的：认出意思 ≠ 能写出形式。
 * "认得出"（receptive）仍然走 QuizPanel 的选释义。
 */
function WritePanel({ item, onFinish, onReveal }) {
  const [value, setValue] = useState('')
  const [result, setResult] = useState(null)

  const submit = useCallback(() => {
    if (result || !String(value).trim()) return
    const res = spellCheck(value, item.word)
    setResult(res)
    // 结果出来 = 正确拼写已经露出来了，这时候读一遍才有意义
    if (typeof onReveal === 'function') onReveal()
  }, [value, result, item.word, onReveal])

  const next = useCallback(() => {
    if (result) onFinish(result)
  }, [result, onFinish])

  const onKeyDown = useCallback(
    (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (result) next()
      else submit()
    },
    [result, next, submit],
  )

  const state = result ? result.state : ''

  return h(
    'div',
    { className: 'dwl-quiz' },
    h('div', { className: 'dwl-quiz-title' }, '看中文，写出对应的英文单词'),
    h(
      'div',
      { className: 'dwl-write' },
      h('input', {
        type: 'text',
        value,
        placeholder: '把单词拼出来…',
        autoFocus: true,
        autoComplete: 'off',
        autoCorrect: 'off',
        autoCapitalize: 'off',
        spellCheck: false,
        'aria-label': '写出对应的英文单词',
        'data-state': result ? state : undefined,
        readOnly: !!result,
        onChange: (e) => setValue(e.target.value),
        onKeyDown,
      }),
      h(
        'button',
        { type: 'button', disabled: !!result || !String(value).trim(), onClick: submit },
        '提交',
      ),
    ),
    result
      ? h(
          'div',
          { className: 'dwl-write-result', 'data-state': state },
          h(
            'div',
            null,
            state === 'exact' ? '✓ 拼对了' : state === 'close' ? '✓ 差一点，注意拼写' : '✗ 没写对',
          ),
          h(
            'div',
            null,
            '正确拼写：',
            h('b', { lang: 'en' }, item.word),
            item.phonetic
              ? h(
                  'span',
                  {
                    style: {
                      marginLeft: 8,
                      fontSize: '13px',
                      color: 'var(--dsw-alias-label-tertiary)',
                    },
                  },
                  '/' + item.phonetic + '/',
                )
              : null,
          ),
          h(
            'div',
            { className: 'dwl-action-row' },
            h('button', { type: 'button', className: 'primary', onClick: next }, '下一个'),
          ),
        )
      : h(
          'div',
          { className: 'dwl-hintline', style: { textAlign: 'center', marginTop: 10 } },
          '回车提交',
        ),
  )
}

// ---------------------------------------------------------------- 刷新 SVG 图标
function RefreshSVG() {
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    h('path', { d: 'M21 2v6h-6' }),
    h('path', { d: 'M3 12a9 9 0 0 1 15-6.7L21 8' }),
    h('path', { d: 'M3 22v-6h6' }),
    h('path', { d: 'M21 12a9 9 0 0 1-15 6.7L3 16' }),
  )
}

// ---------------------------------------------------------------- 单词 AI 分析弹窗

/**
 * WordMetaModal — 展示一个词的 AI 分析详情。
 *
 * props:
 *   word     — 单词对象 { word, translation, phonetic, wordMeta, ... }
 *   onClose  — 关闭回调
 *   api      — api 函数
 */
function WordMetaModal({ word: entry, onClose, api }) {
  const [meta, setMeta] = useState(() => entry.wordMeta || null)
  const [allLoading, setAllLoading] = useState(false)
  const [fieldLoading, setFieldLoading] = useState('')
  const [error, setError] = useState('')
  // P2：义项地图。没有 sense_meta 的词返回空数组，整块就不渲染。
  const [senses, setSenses] = useState([])

  useEffect(() => {
    let alive = true
    // 失败静默降级：义项地图只是补充信息，拿不到不能影响弹窗其余部分
    api(`/sense-map?word=${encodeURIComponent(entry.word)}`)
      .then((r) => {
        if (!alive) return
        if (r && r.ok && Array.isArray(r.senses)) setSenses(r.senses)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [entry.word, api])

  const FIELDS = useMemo(
    () => [
      { key: 'roots', label: '词根词缀' },
      { key: 'synonyms', label: '近义词' },
      { key: 'distractors', label: '干扰项' },
      { key: 'mnemonic', label: '记忆方法' },
      { key: 'confusables', label: '易混淆词' },
    ],
    [],
  )

  /** 重新分析（全部或单项）。 */
  const refresh = useCallback(
    async (field) => {
      if (allLoading || fieldLoading) return
      setError('')
      if (field) {
        setFieldLoading(field)
      } else {
        setAllLoading(true)
      }
      try {
        const body = { word: entry.word, force: true }
        if (field) body.field = field
        const r = await api('/enrich-ai', { method: 'POST', body })
        if (r && r.ok && r.meta) {
          setMeta(r.meta)
        } else {
          setError((r && r.error) || '分析失败，请稍后再试')
        }
      } catch (e) {
        setError((e && e.message) || '网络错误')
      } finally {
        setAllLoading(false)
        setFieldLoading('')
      }
    },
    [entry.word, api, allLoading, fieldLoading],
  )

  /** 错误提示 3s 自动消失。 */
  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(''), 4000)
    return () => clearTimeout(t)
  }, [error])

  /** ESC 关闭。 */
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /** 点击遮罩关闭。 */
  const handleOverlay = useCallback(
    (e) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose],
  )

  const renderField = (key) => {
    const isRefreshing = fieldLoading === key || (allLoading && fieldLoading === null)
    if (isRefreshing) {
      return h(
        'div',
        {
          className: 'dwl-meta-empty',
          style: { animation: 'dwl-shimmer 1.2s ease-in-out infinite' },
        },
        '分析中…',
      )
    }
    if (!meta) return h('div', { className: 'dwl-meta-empty' }, '尚未分析')
    const val = meta[key]
    if (key === 'roots') {
      if (!Array.isArray(val) || !val.length) return h('div', { className: 'dwl-meta-empty' }, '无')
      return val.map((r, i) =>
        r
          ? h(
              'div',
              { key: i, className: 'dwl-meta-root' },
              h('span', { className: 'part' }, r.part || '?'),
              h('span', { className: 'type' }, r.type || 'root'),
              h('span', { className: 'meaning' }, r.meaning || ''),
            )
          : null,
      )
    }
    if (key === 'mnemonic') {
      if (!val) return h('div', { className: 'dwl-meta-empty' }, '无')
      return h('div', { className: 'dwl-meta-memo' }, val)
    }
    // synonyms / confusables 是英文词 → 悬浮给释义；distractors 是中文释义，只做标签
    if (!Array.isArray(val) || !val.length) return h('div', { className: 'dwl-meta-empty' }, '无')
    const hoverable = key === 'synonyms' || key === 'confusables'
    return h(
      'div',
      { className: 'dwl-meta-tags' },
      val.map((s, i) =>
        hoverable
          ? h(HoverWord, { key: i, word: String(s) })
          : h('span', { key: i, className: 'dwl-meta-tag' }, s),
      ),
    )
  }

  const analyzed = meta && meta.analyzedAt
  const timeStr = analyzed ? new Date(meta.analyzedAt).toLocaleString('zh-CN') : null
  const modelStr = meta && meta._provider && meta._model ? meta._provider + '/' + meta._model : null

  return h(
    'div',
    { className: 'dwl-modal-overlay', onClick: handleOverlay },
    h(
      'div',
      { className: 'dwl-modal', role: 'dialog', 'aria-label': entry.word + ' AI 分析' },
      h('button', { className: 'dwl-modal-close', onClick: onClose, 'aria-label': '关闭' }, '✕'),
      h(
        'h3',
        null,
        entry.word,
        entry.phonetic
          ? h(
              'span',
              {
                style: {
                  fontWeight: 400,
                  fontSize: '14px',
                  marginLeft: 8,
                  color: 'var(--dsw-alias-label-tertiary)',
                },
              },
              '/' + entry.phonetic + '/',
            )
          : null,
        h('span', { className: 'dwl-ai-pill' }, 'AI 生成'),
      ),
      h(
        'div',
        { className: 'dwl-modal-sub' },
        (entry.translation || '').split('\\n')[0] || '无释义',
        timeStr
          ? h(
              'span',
              { style: { marginLeft: 8 } },
              '· ' + (modelStr ? modelStr + ' · ' : '') + '分析于 ' + timeStr,
            )
          : null,
      ),

      // P2 义项地图：这个词见过 / 答对过 / 答错过哪些义项。
      // 没有 sense_meta 的词返回空数组，这里整块不出现（不占位、不报错）。
      senses.length
        ? h(
            'div',
            { className: 'dwl-meta-section' },
            h(
              'div',
              { className: 'dwl-meta-section-hd' },
              h('span', { className: 'lbl' }, '义项'),
              h('span', { className: 'dwl-sense-legend' }, '见过 / 答对过 / 答错过'),
            ),
            h(
              'div',
              { className: 'dwl-sense-map' },
              senses.map((s, idx) =>
                h(
                  'div',
                  {
                    key: s.senseKey || idx,
                    className: 'dwl-sense-row',
                    'data-status': s.status || 'seen',
                  },
                  h('i', { className: 'dwl-dot', 'aria-hidden': true }),
                  h('span', { className: 'gloss' }, String(s.gloss || s.senseKey || '')),
                  h(
                    'span',
                    { className: 'st' },
                    (assetOf('SENSE_STATUS_LABEL') || {})[s.status] || '',
                  ),
                ),
              ),
            ),
          )
        : null,

      !meta
        ? h(
            'div',
            { className: 'dwl-modal-empty' },
            h(
              'div',
              { className: 'dwl-empty-icon', 'aria-hidden': 'true' },
              h(
                'svg',
                {
                  viewBox: '0 0 24 24',
                  width: 28,
                  height: 28,
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.5,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                },
                h('circle', { cx: 11, cy: 11, r: 8 }),
                h('line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }),
              ),
            ),
            h('div', { className: 'dwl-empty-text' }, '这个词还没有 AI 分析数据'),
            h('div', { className: 'dwl-empty-hint' }, '点击下方「重新分析全部」开始'),
          )
        : FIELDS.map(({ key, label }) =>
            h(
              'div',
              { key, className: 'dwl-meta-section' },
              h(
                'div',
                { className: 'dwl-meta-section-hd' },
                h('span', { className: 'lbl' }, label),
                h(
                  'button',
                  {
                    className: 'dwl-refresh-btn' + (fieldLoading === key ? ' loading' : ''),
                    title: '重新分析「' + label + '」',
                    disabled: allLoading || !!fieldLoading,
                    onClick: () => refresh(key),
                  },
                  h(RefreshSVG),
                ),
              ),
              renderField(key),
            ),
          ),

      error ? h('div', { className: 'dwl-modal-error' }, error) : null,

      h(
        'div',
        { className: 'dwl-modal-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'primary',
            disabled: allLoading || !!fieldLoading,
            onClick: () => refresh(null),
          },
          allLoading ? '分析中…' : '重新分析全部',
        ),
        h('button', { type: 'button', onClick: onClose }, '关闭'),
      ),
    ),
  )
}

// ---------------------------------------------------------------- 进度指示

/** 进度点。超过 40 个词就换成文字，免得挤成一排二维码。 */
function ProgressDots({ total, cursor }) {
  if (total > 40) {
    return h(
      'div',
      { className: 'dwl-keys' },
      `第 ${Math.min(cursor + 1, total)} 个 / 共 ${total} 个`,
    )
  }
  const dots = []
  for (let i = 0; i < total; i++) {
    dots.push(h('i', { key: i, className: i < cursor ? 'done' : i === cursor ? 'now' : '' }))
  }
  return h('div', { className: 'dwl-dots', 'aria-hidden': true }, dots)
}

// ---------------------------------------------------------------- 学习视图
//
// 三分支自评流程：
//   看到词 → 自评（忘了 / 模糊 / 记得）
//   · 忘了 → 补记循环：回忆（自己写意思）→ 对照（你写的 vs 释义）
//            → 拼写（把词拼对一次）→ 才评 Again(1) → 下一个
//     为什么不是直接给释义：失败后仍要提取、且要有产出。看答案 + 点下一个
//     是纯再认，下次见面还是忘（见 design/forgot-repair-loop.md）。
//   · 模糊 → 显示记忆提示 → "想起来了吗?" → 是 → 选择题 → Grade Good(3)
//                                          → 否 → 显示释义 → Grade Hard(2)
//   · 记得 → 直接选择题 → Grade Easy(4) 或根据得分降级
//
// 状态机：phase = 'assess' | 'recall' | 'reveal' | 'spell' | 'spell-ok'
//                 | 'fuzzy-hints' | 'fuzzy-confirm' | 'quiz' | 'result'

/**
 * R4：会话末补记。
 *
 * 今天评过「忘了」的词再复现一次：给中文 + 原句挖空，拼出单词。
 * 拼对就清掉那笔债。不重写 FSRS —— 分在评 Again 时已经记过了，
 * 这里只补"失败之后至少成功提取一次"。
 */
function RepairPass({ items, onDone }) {
  const [i, setI] = useState(0)
  const [value, setValue] = useState('')
  const [miss, setMiss] = useState(0)
  const [showAnswer, setShowAnswer] = useState(false)
  const [ok, setOk] = useState(false)
  const item = items[i]

  useEffect(() => {
    setValue('')
    setMiss(0)
    setShowAnswer(false)
    setOk(false)
  }, [i])

  const spot = useMemo(() => wordSpot((item && item.sentence) || '', item && item.word), [item])
  const senses = useMemo(() => splitSenses(item && item.translation), [item])

  const submit = () => {
    if (ok) return
    const v = value.trim().toLowerCase()
    if (!v) return
    if (v === String(item.word || '').toLowerCase()) {
      setOk(true)
      if (item.cardId) {
        api('/repair/clear', { method: 'POST', body: { cardId: item.cardId } }).catch(() => {})
      }
      return
    }
    setMiss((n) => n + 1)
    if (miss + 1 >= 2) setShowAnswer(true)
  }

  const next = () => {
    if (i + 1 >= items.length) onDone()
    else setI(i + 1)
  }

  return h(
    'div',
    { className: 'dwl-study' },
    h(
      'div',
      { className: 'dwl-focus' },
      h(
        'div',
        { className: 'dwl-hintline', style: { textAlign: 'center' } },
        `补记 ${i + 1} / ${items.length} · 今天忘了的，过一遍再走`,
      ),
      h(
        'div',
        { className: 'dwl-word dwl-word-cn' },
        senses.lead || (item && item.translation) || '',
      ),
      spot
        ? h(
            'div',
            { className: 'dwl-sentence' },
            spot.before,
            h(
              'span',
              { key: 'b', className: 'dwl-blank' },
              '▁'.repeat(Math.min(24, spot.token.length)),
            ),
            spot.after,
          )
        : h(
            'div',
            { className: 'dwl-hintline', style: { textAlign: 'center' } },
            '看中文，拼出这个单词',
          ),
      h('input', {
        type: 'text',
        className: 'dwl-cloze-input',
        value,
        autoComplete: 'off',
        autoCapitalize: 'off',
        spellCheck: false,
        disabled: ok,
        placeholder: '拼出来',
        onChange: (e) => setValue(e.target.value),
        onKeyDown: (e) => {
          if (e.isComposing || e.keyCode === 229) return
          if (e.key === 'Enter') submit()
        },
      }),
      ok
        ? h(
            'div',
            { className: 'dwl-hintline', style: { textAlign: 'center' } },
            `对了 —— ${item.word}`,
          )
        : showAnswer
          ? h(
              'div',
              { className: 'dwl-hintline', style: { textAlign: 'center' } },
              `是 ${item.word}。照着拼一次也可以`,
            )
          : null,
      h(
        'div',
        { className: 'dwl-action-row' },
        ok
          ? h(
              'button',
              { type: 'button', className: 'primary', onClick: next },
              i + 1 >= items.length ? '结束' : '下一个',
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'primary',
                disabled: !value.trim(),
                onClick: submit,
              },
              '拼好了',
            ),
      ),
    ),
  )
}

/**
 * R5：次日回访。
 *
 * 昨天忘过/补记过的词，今天换个方式再考一次：给两句英文，问「这两句里的
 * 这个词，是同一个意思吗」。同义句与异义句各占一半（服务端配好 same），
 * 所以不能靠「答案总是不同」蒙对 —— 那会把判别变成猜按钮。
 *
 * 与 RepairPass 的区别：
 *   · 不删词、不改排期，答题只落 repair_log（stage='tomorrow'）并清/开债；
 *   · 答错时把两句各自的义项摆出来。反差（「① 处理，② 地址」）比一个
 *     「错」字有用得多，也符合「唤醒绑在词义上，不绑在界面上」。
 */
function RecapPass({ trials, onDone, onSkip }) {
  const [i, setI] = useState(0)
  const [choice, setChoice] = useState(null) // 'same' | 'diff' | null
  // 同一题只提交一次：键盘和按钮可能连着触发
  const sent = useRef(false)
  const trial = trials[i] || null

  useEffect(() => {
    setChoice(null)
    sent.current = false
  }, [i])

  const answer = useCallback(
    (pick) => {
      if (!trial || sent.current) return
      sent.current = true
      setChoice(pick)
      const correct = (pick === 'same') === !!trial.same
      // 静默降级：记不上也不影响继续答题（回访不是评分，丢了不致命）
      api('/repair/recap', {
        method: 'POST',
        body: { wordId: trial.wordId, cardId: trial.cardId, ok: correct, guess: pick },
      }).catch(() => {})
    },
    [trial],
  )

  const next = useCallback(() => {
    if (i + 1 >= trials.length) onDone()
    else setI(i + 1)
  }, [i, trials.length, onDone])

  // 键盘：1 = 同一个意思，2 = 不是；答完回车/空格进下一题
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (!trial) return
      if (choice == null && (e.key === '1' || e.key === '2')) {
        e.preventDefault()
        answer(e.key === '1' ? 'same' : 'diff')
        return
      }
      if (choice != null && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [trial, choice, answer, next])

  if (!trial) return null

  const correct = choice != null && (choice === 'same') === !!trial.same

  return h(
    'div',
    { className: 'dwl-study' },
    h(
      'div',
      { className: 'dwl-focus' },
      h(
        'div',
        { className: 'dwl-hintline', style: { textAlign: 'center' } },
        `昨日回访 ${i + 1} / ${trials.length} · 昨天忘过的词，今天再看一眼`,
      ),
      h('div', { className: 'dwl-word' }, trial.word),
      h('div', { className: 'dwl-recap-q' }, '这两句里的它，是同一个意思吗？'),
      h(
        'div',
        { className: 'dwl-recap-pair' },
        h(
          'div',
          { className: 'dwl-recap-sent' },
          h('span', { className: 'idx' }, '①'),
          h('span', { className: 'txt' }, String(trial.s1 || '')),
        ),
        h(
          'div',
          { className: 'dwl-recap-sent' },
          h('span', { className: 'idx' }, '②'),
          h('span', { className: 'txt' }, String(trial.s2 || '')),
        ),
      ),
      choice == null
        ? h(
            'div',
            { className: 'dwl-recap-choice' },
            h(
              'button',
              { type: 'button', className: 'dwl-pick-btn', onClick: () => answer('same') },
              '同一个意思',
              h('span', { className: 'k' }, '1'),
            ),
            h(
              'button',
              { type: 'button', className: 'dwl-pick-btn', onClick: () => answer('diff') },
              '不是',
              h('span', { className: 'k' }, '2'),
            ),
          )
        : h(
            'div',
            { className: 'dwl-recap-feedback', 'data-ok': correct ? '1' : '0' },
            h('div', { className: 'hd' }, correct ? '答对了' : '没答对，对照一下'),
            h(
              'div',
              { className: 'row' },
              h('span', { className: 'k' }, '①'),
              String(trial.senseHere || '这个义项'),
            ),
            h(
              'div',
              { className: 'row' },
              h('span', { className: 'k' }, '②'),
              trial.same
                ? String(trial.senseHere || '同一个义项')
                : String(trial.otherGloss || '另一个义项'),
            ),
            h(
              'div',
              { className: 'dwl-action-row' },
              h(
                'button',
                { type: 'button', className: 'primary', onClick: next },
                i + 1 >= trials.length ? '结束回访' : '下一题',
              ),
            ),
          ),
      h(
        'button',
        {
          type: 'button',
          className: 'dwl-recap-skip',
          onClick: onSkip,
          title: '跳过不清债，下次复习再补',
        },
        '跳过回访',
      ),
    ),
  )
}

function StudyView({
  item,
  cursor,
  total,
  busy,
  onRate,
  accent,
  onToggleAccent,
  onSpeak,
  speaking,
  autoSpeak,
}) {
  const senses = useMemo(() => splitSenses(item.translation), [item.translation])
  const meta = item.wordMeta || null
  // 两条线练的东西不一样：认得出=选释义，写得出=看中文拼单词
  const productive = item.track === 'productive'

  // 每个词的阶段状态
  const [phase, setPhase] = useState('assess')
  const [branch, setBranch] = useState(null) // 'forgot' | 'fuzzy' | 'remember'
  const [quiz, setQuiz] = useState(null)
  const [quizLoading, setQuizLoading] = useState(false)
  // 「忘了」分支的补记状态：先回忆 → 对照 → 拼写，拼对才评 Again。
  // 这不是为了"惩罚"，是为了让失败之后至少发生一次提取和一次产出。
  const [recall, setRecall] = useState('')
  const [spell, setSpell] = useState('')
  const [spellMiss, setSpellMiss] = useState(0)
  const [spellAnswer, setSpellAnswer] = useState(false)
  // P1：义项材料（/repair 返回）。有 senseMeta 时先做四选一，没有退回自由回忆。
  const [repair, setRepair] = useState(null)
  const [picked, setPicked] = useState(null)
  const repairStart = useRef(0)
  // 连点提交会重复评分（spell-ok 有 420ms 延迟），用 ref 上一把锁
  const spellLock = useRef(false)

  // 换词时重置阶段
  useEffect(() => {
    setPhase('assess')
    setBranch(null)
    setQuiz(null)
    setQuizLoading(false)
    setRecall('')
    setSpell('')
    setSpellMiss(0)
    setSpellAnswer(false)
    setRepair(null)
    setPicked(null)
    repairStart.current = 0
    spellLock.current = false
  }, [item.cardId])

  // 原句里这个词的位置。允许 -s/-ed/-ing 这类变形；
  // 找不到（老词没存原句、或句子被截断）就返回 null，前端降级成「看释义拼写」。
  // 有原句时它就是最强的提取线索（编码特异性），比干背释义有效。
  const sentenceSpot = useMemo(
    () => wordSpot((repair && repair.sentence) || item.sentence, item.word),
    [repair, item.sentence, item.word],
  )

  // 自动发音：进页面听到词、看答案时再听一遍。
  //
  // 写得出（productive）那条线在"出题"阶段故意不读：单词是答案，
  // 先读出来等于把拼写提示给出去；等拼完显示正确拼写时再读。
  // 自动播放失败（浏览器拦自动播放）不提示，用户点喇叭就行。
  const speakRef = useRef(onSpeak)
  speakRef.current = onSpeak
  useEffect(() => {
    if (!autoSpeak) return
    const t = setTimeout(() => {
      if (phase === 'assess') {
        if (!productive) speakRef.current()
      } else if (phase === 'reveal') {
        // 写得出这条线里单词是答案，拼写前不能读出来
        if (!productive) speakRef.current()
      } else if (phase === 'result' || phase === 'spell-ok') {
        speakRef.current()
      }
    }, 260)
    return () => clearTimeout(t)
  }, [phase, item.cardId, autoSpeak, productive])

  // 键盘快捷键：assess 阶段 1/2/3 选分支
  const branchRef = useRef({})
  branchRef.current = { phase, handleBranch: null } // handleBranch 会在下面赋值后更新
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const s = branchRef.current
      if (s.phase !== 'assess' || !s.handleBranch) return
      const map = { 1: 'forgot', 2: 'fuzzy', 3: 'remember' }
      if (map[e.key]) {
        e.preventDefault()
        s.handleBranch(map[e.key])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** 拉选择题数据。 */
  const loadQuiz = useCallback(async () => {
    setQuizLoading(true)
    try {
      const r = await api(`/quiz?word=${encodeURIComponent(item.word)}`)
      if (r && r.ok && r.quiz) {
        setQuiz(r.quiz)
      } else {
        setQuiz(null)
      }
    } catch {
      setQuiz(null)
    } finally {
      setQuizLoading(false)
    }
  }, [item.word])

  /** 进练习：认得出 → 选择题；写得出 → 拼写。 */
  const startQuiz = useCallback(() => {
    setPhase('quiz')
    if (!productive) loadQuiz()
  }, [productive, loadQuiz])

  /** 补记事件：只落 repair_log，失败也不该影响学习流程。 */
  const logRepair = useCallback(
    (evt) => {
      const elapsedMs = repairStart.current ? Date.now() - repairStart.current : 0
      api('/repair/log', {
        method: 'POST',
        body: { cardId: item.cardId, elapsedMs, ...evt },
      }).catch(() => {})
    },
    [item.cardId],
  )

  /**
   * 按「忘了」时拉补记材料。
   *
   * 有 senseMeta 就先做四选一（义项判别），没有就退回自由回忆。
   * 义项分析是后台跑的，第一次忘一个词时大概率还没好 —— 降级不阻塞。
   */
  const beginRepair = useCallback(async () => {
    repairStart.current = Date.now()
    setRepair(null)
    setPicked(null)
    try {
      const r = await api(`/repair?cardId=${item.cardId}`)
      if (r && r.ok) {
        setRepair(r)
        const opts = r.senseMeta && r.senseMeta.options
        setPhase(Array.isArray(opts) && opts.length === 4 ? 'pick' : 'recall')
        return
      }
    } catch (err) {
      /* 退回自由回忆 */
    }
    setPhase('recall')
  }, [item.cardId])

  /** 四选一：记下选择，进对照。 */
  const chooseOption = useCallback(
    (index) => {
      const option = repair && repair.senseMeta && repair.senseMeta.options[index]
      setPicked(index)
      logRepair({
        stage: 'pick',
        ok: option ? option.correct : null,
        guess: option ? option.text : '',
      })
      setPhase('reveal')
    },
    [repair, logRepair],
  )

  /** 自评按钮点击。 */
  const handleBranch = useCallback(
    (key) => {
      setBranch(key)
      if (key === 'forgot') {
        // 认得出：先拉义项材料（有四选一就做四选一，没有就自由回忆）；
        // 写得出：意义已经写在屏幕上，直接进拼写 —— 否则原句里高亮的英文词
        // 等于把答案递过去。
        if (productive) setPhase('spell')
        else beginRepair()
      } else if (key === 'fuzzy') {
        setPhase('fuzzy-hints')
      } else if (key === 'remember') {
        startQuiz()
      }
    },
    [startQuiz, productive, beginRepair],
  )
  // 让键盘处理器能拿到最新的 handleBranch
  branchRef.current = { phase, handleBranch }

  /** 模糊分支："想起来了" → 进选择题。 */
  const fuzzyYes = useCallback(() => {
    startQuiz()
  }, [startQuiz])

  /** 模糊分支："没想起来" → 显示释义，评 Hard(2)。 */
  const fuzzyNo = useCallback(() => {
    setPhase('result')
  }, [])

  /**
   * 忘了分支第一步：先让他自己生成一次意思。
   *
   * 为什么不是直接给释义：失败后的提取（哪怕错了）比直接看答案记得好；
   * 而"看释义 + 点下一个"既没有提取也没有产出，是纯再认。
   * 写不出（空串）也放行 —— 惩罚诚实会让下一次开始谎报。
   */
  const recallDone = useCallback((text) => {
    setRecall(String(text || '').trim())
    setPhase('reveal')
  }, [])

  /** 对照完释义，进拼写。 */
  const revealNext = useCallback(() => {
    setPhase('spell')
  }, [])

  /**
   * 拼写结算：必须拼对一次才评 Again(1)。
   *
   * 评的是"第一次无提示提取失败了"这个事实，拼写成功不改变评级 ——
   * 如果这里改评「记得」，FSRS 会以为这个词很稳，把间隔拉长，下次忘得更惨。
   * 拼写的作用是产出，不是给调度器看的成绩。
   */
  const spellSubmit = useCallback(() => {
    if (spellLock.current) return
    const v = spell.trim().toLowerCase()
    if (!v) return
    if (v === String(item.word || '').toLowerCase()) {
      spellLock.current = true
      logRepair({ stage: 'spell', ok: true })
      setPhase('spell-ok')
      setTimeout(() => onRate(1), 420) // Again
      return
    }
    logRepair({ stage: 'spell', ok: false, guess: v })
    // 两次没中就直接给答案：原来要再点一次「看答案」，按钮还会在被点后消失，
    // 用户会以为界面卡死了。答案摆出来、照着打一遍，比藏起来多一次点击有用。
    setSpellMiss((n) => {
      const next = n + 1
      if (next >= 2) setSpellAnswer(true)
      return next
    })
  }, [spell, item.word, onRate, logRepair])

  /**
   * 答案已经摆出来还是过不去时的出口。
   *
   * 不是"跳过惩罚"：评级本来就是 Again(1)，这里只是把「必须拼对」降级成
   * 「至少看一遍答案」。没有出口的硬锁只会让人关掉页面。
   */
  const skipSpell = useCallback(() => {
    if (spellLock.current || busy) return
    spellLock.current = true
    logRepair({ stage: 'spell', ok: false, guess: spell.trim() })
    onRate(1)
  }, [spell, onRate, logRepair, busy])

  /** 模糊+没想起来：看完释义，继续（评 Hard(2)）。 */
  const fuzzyFailNext = useCallback(() => {
    onRate(2) // Hard
  }, [onRate])

  /** 选择题结算：评级映射在 ./dashboard/logic.js（quizRating），这里只管延迟与回调。 */
  const handleQuizFinish = useCallback(
    (score) => {
      // 延迟一下让用户看到结果
      setTimeout(() => {
        const rating = quizRating(branch, score)
        if (rating) onRate(rating)
      }, 800)
    },
    [branch, onRate],
  )

  /** 拼写结算：评级映射在 ./dashboard/logic.js（writeRating）。 */
  const handleWriteFinish = useCallback(
    (res) => {
      onRate(writeRating(branch, res.state))
    },
    [branch, onRate],
  )

  /** 喇叭 SVG（volume-high 风格）。 */
  const speakerIcon = h(
    'svg',
    { viewBox: '0 0 24 24', 'aria-hidden': true },
    h('path', {
      d: 'M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zM16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM3 9v6h4l5 5V4L7 9H3z',
    }),
  )

  // ── 释义区（忘了分支 / 模糊失败时展示的完整释义）
  const meaningBlock = h(
    'div',
    { className: 'dwl-body', style: { display: 'block' } },
    senses.lead
      ? h('div', { className: 'dwl-meaning' }, h('span', { className: 'lead' }, senses.lead))
      : h('div', { className: 'dwl-meaning' }, '这个词还没有释义'),
    senses.rest.map((s, i) => h('div', { key: i, className: 'dwl-sense' }, s)),
  )

  // ── 各阶段的内容
  let phaseContent = null

  if (phase === 'assess') {
    // 初始：三个自评按钮
    phaseContent = h(
      'div',
      { style: { width: '100%', animation: 'dwl-fade .2s ease' } },
      h(
        'div',
        { className: 'dwl-hintline', style: { textAlign: 'center', marginBottom: 4 } },
        productive
          ? '看中文，想英文：点「记得」之后把单词写出来'
          : item.isNew
            ? '第一次见这个词'
            : '先想想这个词是什么意思',
      ),
      h(BranchBar, { onBranch: handleBranch, disabled: busy }),
    )
  } else if (phase === 'recall') {
    // 补记第一步：不给答案，先让他自己生成一次。
    // 写不出来也放行（"想不起来，直接看"）—— 惩罚诚实，下次就开始谎报。
    phaseContent = h(
      'div',
      { style: { width: '100%', animation: 'dwl-fade .25s ease' } },
      sentenceSpot
        ? h(
            'div',
            { className: 'dwl-sentence' },
            sentenceSpot.before,
            h('mark', { key: 'w' }, sentenceSpot.token),
            sentenceSpot.after,
          )
        : h(
            'div',
            { className: 'dwl-hintline', style: { textAlign: 'center' } },
            '先别看答案 —— 这个词是什么意思？',
          ),
      h(
        'div',
        { className: 'dwl-recall' },
        h('textarea', {
          value: recall,
          rows: 2,
          maxLength: 120,
          placeholder: '用中文写，想到什么写什么（想不起来就留空）',
          'aria-label': '回忆这个词的意思',
          onChange: (e) => setRecall(e.target.value),
          onKeyDown: (e) => {
            // 中文输入法选词时的回车不算提交（isComposing / 229）
            if (e.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              recallDone(recall)
            }
          },
        }),
      ),
      h(
        'div',
        { className: 'dwl-action-row' },
        h(
          'button',
          {
            type: 'button',
            className: 'primary',
            disabled: busy || !recall.trim(),
            onClick: () => recallDone(recall),
          },
          '写好了',
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: () => recallDone(''),
          },
          '想不起来，直接看',
        ),
      ),
      h(
        'div',
        { className: 'dwl-hintline', style: { textAlign: 'center' } },
        '先自己生成一次，再看答案 —— 这一步比看十遍释义有用',
      ),
    )
  } else if (phase === 'pick') {
    // P1：义项判别。四个选项都来自这个词自己的义项（服务端拼的），
    // 正确项是"这句里用的那个"。比自由回忆多一步"承诺"，才有反差。
    const opts = (repair && repair.senseMeta && repair.senseMeta.options) || []
    phaseContent = h(
      'div',
      { style: { width: '100%', animation: 'dwl-fade .25s ease' } },
      sentenceSpot
        ? h(
            'div',
            { className: 'dwl-sentence' },
            sentenceSpot.before,
            h('mark', { key: 'w' }, sentenceSpot.token),
            sentenceSpot.after,
          )
        : null,
      h(
        'div',
        { className: 'dwl-hintline', style: { textAlign: 'center' } },
        '这句里，它是什么意思？',
      ),
      h(
        'div',
        { className: 'dwl-pick' },
        opts.map((o, i) =>
          h(
            'button',
            {
              key: i,
              type: 'button',
              className: 'dwl-pick-btn',
              disabled: busy,
              onClick: () => chooseOption(i),
            },
            o.text,
          ),
        ),
      ),
      h(
        'div',
        { className: 'dwl-hintline', style: { textAlign: 'center' } },
        '这四个都可能是这个词的意思，只有一个符合这句话',
      ),
    )
  } else if (phase === 'reveal') {
    // 补记第二步：对照。有义项材料时给"你选的 vs 这句的"；
    // 没有时退回"你写的 vs 释义"。两种都制造同一个反差。
    const sm = repair && repair.senseMeta
    const right = sm && Array.isArray(sm.options) ? sm.options.find((o) => o.correct) : null
    const pickedText =
      sm && Array.isArray(sm.options) && picked != null && sm.options[picked]
        ? sm.options[picked].text
        : ''
    phaseContent = h(
      'div',
      { style: { width: '100%', animation: 'dwl-fade .25s ease' } },
      sm
        ? h(
            'div',
            { className: 'dwl-contrast' },
            pickedText && right && pickedText === right.text
              ? h('div', null, '你选对了 —— ', h('b', { className: 'right' }, pickedText), '。')
              : h('div', null, '你选的是 ', h('b', null, pickedText || '（没选）'), '。'),
            pickedText && right && pickedText === right.text
              ? h(
                  'div',
                  { style: { fontSize: 13, opacity: 0.75 } },
                  '但先别急着走 —— 把这个词写出来一次。',
                )
              : h(
                  'div',
                  null,
                  '这句里是 ',
                  h('b', { className: 'right' }, right ? right.text : sm.sense_here),
                  '。',
                ),
          )
        : recall
          ? h(
              'div',
              { className: 'dwl-compare' },
              h('div', { className: 'k' }, '你刚才写的'),
              h('div', { className: 'v' }, recall),
            )
          : h(
              'div',
              { className: 'dwl-hintline', style: { textAlign: 'center' } },
              '没关系 —— 这次靠反差记住它',
            ),
      sm && sm.why_confusable ? h('div', { className: 'dwl-why' }, sm.why_confusable) : null,
      sm && sm.etymology_note ? h('div', { className: 'dwl-etym' }, sm.etymology_note) : null,
      meaningBlock,
      h(MemoryHints, { meta }),
      h(
        'div',
        { className: 'dwl-action-row' },
        h(
          'button',
          { type: 'button', className: 'primary', disabled: busy, onClick: revealNext },
          '继续 · 把它拼出来',
        ),
      ),
    )
  } else if (phase === 'spell') {
    // 补记第三步：产出。必须拼对一次才能离开这张卡（这是唯一的"代价"）。
    // 单词在这一步被藏起来 —— 显示着让人抄，等于没练。
    phaseContent = h(
      'div',
      { style: { width: '100%', animation: 'dwl-fade .25s ease' } },
      h(
        'div',
        { className: 'dwl-hintline', style: { textAlign: 'center', marginBottom: 4 } },
        '把刚才那个词拼出来',
      ),
      sentenceSpot
        ? h(
            'div',
            { className: 'dwl-sentence' },
            sentenceSpot.before,
            h(
              'span',
              { key: 'b', className: 'dwl-blank' },
              '▁'.repeat(Math.min(24, sentenceSpot.token.length)),
            ),
            sentenceSpot.after,
          )
        : h(
            'div',
            { className: 'dwl-sentence' },
            '看中文，拼出这个单词：',
            h('b', { key: 's' }, senses.lead || item.translation || ''),
          ),
      h('input', {
        type: 'text',
        className: 'dwl-cloze-input',
        value: spell,
        autoComplete: 'off',
        autoCapitalize: 'off',
        spellCheck: false,
        autoFocus: true,
        placeholder: '输入完整单词',
        'aria-label': '拼写这个单词',
        onChange: (e) => setSpell(e.target.value),
        onKeyDown: (e) => {
          if (e.isComposing || e.keyCode === 229) return
          if (e.key === 'Enter') {
            e.preventDefault()
            spellSubmit()
          }
        },
      }),
      spellAnswer
        ? h(
            'div',
            { className: 'dwl-answerline' },
            h('span', { className: 'k' }, '答案'),
            h('b', { key: 'a' }, item.word),
            h('span', { className: 'k' }, '照着打一遍'),
          )
        : null,
      spellMiss > 0
        ? h(
            'div',
            {
              className: 'dwl-hintline',
              style: { textAlign: 'center', color: 'var(--dsw-alias-state-error-primary)' },
            },
            spellAnswer
              ? '还不对。答案就在上面，一个字母一个字母对着打。'
              : '还不对。注意词尾 —— 再错一次就把答案摆出来。',
          )
        : null,
      h(
        'div',
        { className: 'dwl-action-row' },
        h(
          'button',
          {
            type: 'button',
            className: 'primary',
            disabled: busy || !spell.trim(),
            onClick: spellSubmit,
          },
          '提交',
        ),
        spellAnswer
          ? h('button', { type: 'button', disabled: busy, onClick: skipSpell }, '过不去，先过这张')
          : null,
      ),
    )
  } else if (phase === 'spell-ok') {
    phaseContent = h(
      'div',
      { style: { width: '100%', animation: 'dwl-fade .2s ease', textAlign: 'center' } },
      h('div', { className: 'dwl-hintline' }, '✓ 对。'),
      h('div', { className: 'dwl-hintline' }, '这个词评「忘了」，下次会提前再见。'),
      // 评分请求失败时用户会停在这一屏（自动前进只跑一次），给个手动入口
      h(
        'div',
        { className: 'dwl-action-row' },
        h('button', { type: 'button', disabled: busy, onClick: () => onRate(1) }, '继续'),
      ),
    )
  } else if (phase === 'fuzzy-hints') {
    // 模糊 → 先给记忆提示
    phaseContent = h(
      'div',
      { style: { width: '100%', animation: 'dwl-fade .25s ease' } },
      h(MemoryHints, { meta }),
      h(
        'div',
        { className: 'dwl-hintline', style: { textAlign: 'center', marginTop: 16 } },
        '看了提示之后——',
      ),
      h(
        'div',
        { className: 'dwl-action-row' },
        h(
          'button',
          { type: 'button', className: 'primary', disabled: busy, onClick: fuzzyYes },
          '想起来了',
        ),
        h('button', { type: 'button', disabled: busy, onClick: fuzzyNo }, '还是没想起来'),
      ),
    )
  } else if (phase === 'result') {
    // 模糊 + 没想起来 → 展示释义
    phaseContent = h(
      'div',
      { style: { width: '100%', animation: 'dwl-fade .25s ease' } },
      meaningBlock,
      h(MemoryHints, { meta }),
      h(
        'div',
        { className: 'dwl-action-row' },
        h(
          'button',
          { type: 'button', className: 'primary', disabled: busy, onClick: fuzzyFailNext },
          '下一个',
        ),
      ),
    )
  } else if (phase === 'quiz') {
    // 认得出 → 选释义；写得出 → 看中文拼单词
    phaseContent = h(
      'div',
      { style: { width: '100%', animation: 'dwl-fade .25s ease' } },
      productive
        ? h(WritePanel, {
            key: item.cardId,
            item,
            onFinish: handleWriteFinish,
            onReveal: () => {
              if (autoSpeak) speakRef.current()
            },
          })
        : quizLoading
          ? h(
              'div',
              { className: 'dwl-meta-empty', style: { textAlign: 'center', padding: 20 } },
              '正在出题……',
            )
          : h(QuizPanel, { key: item.cardId, quiz, onFinish: handleQuizFinish }),
    )
  }

  return h(
    'div',
    { className: 'dwl-study' },
    h(
      'div',
      // key 让每个新词重播一次入场动画；reduced-motion 下动画被关掉
      { className: 'dwl-focus', key: item.cardId },
      (productive || phase === 'spell') && phase !== 'spell-ok'
        ? h(
            'div',
            { className: 'dwl-word dwl-word-cn' },
            senses.lead || item.translation || '（这个词还没有释义）',
          )
        : h('div', { className: 'dwl-word', lang: 'en' }, item.word),
      h(
        'div',
        { className: 'dwl-phon' },
        item.phonetic && !productive && phase !== 'spell'
          ? h('span', null, `/${item.phonetic}/`)
          : null,

        // 发音按钮 + 口音切换
        // 拼写阶段整块藏掉：点一下喇叭就等于把答案读出来了。
        phase === 'spell'
          ? null
          : h(
              'span',
              { className: 'dwl-speak' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dwl-speak-btn',
                  'data-busy': speaking ? '1' : undefined,
                  'aria-label': '朗读单词',
                  title: '朗读（S）',
                  onClick: onSpeak,
                },
                speakerIcon,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dwl-accent',
                  'aria-label': accent === 'uk' ? '当前英音，点击切美音' : '当前美音，点击切英音',
                  title: accent === 'uk' ? '当前英音，点击切美音' : '当前美音，点击切英音',
                  onClick: onToggleAccent,
                },
                accent.toUpperCase(),
              ),
            ),

        item.trackLabel ? h('span', { className: 'dwl-pos' }, item.trackLabel) : null,
        item.isNew ? h('span', { className: 'dwl-pos' }, '新词') : null,
        item.overdueDays > 0
          ? h('span', { className: 'dwl-flag' }, `拖了 ${item.overdueDays} 天`)
          : null,
      ),

      phaseContent,

      h(
        'div',
        { className: 'dwl-tail' },
        h(ProgressDots, { total, cursor }),
        h(
          'div',
          { className: 'dwl-keys' },
          phase === 'assess'
            ? [
                h('kbd', { key: 'k1' }, '1'),
                ' 忘了 · ',
                h('kbd', { key: 'k2' }, '2'),
                ' 模糊 · ',
                h('kbd', { key: 'k3' }, '3'),
                ' 记得 · ',
              ]
            : phase === 'recall'
              ? [h('kbd', { key: 'k1' }, 'Enter'), ' 写好了']
              : phase === 'spell'
                ? [h('kbd', { key: 'k1' }, 'Enter'), ' 提交']
                : null,
          // 拼写阶段不给发音/跳过入口：发音会把答案读出来，跳过会让这张卡不落日志。
          phase === 'spell' ? null : h('kbd', null, 'S'),
          phase === 'spell' ? null : ' 发音 · ',
          phase === 'spell' ? null : h('kbd', null, 'J'),
          phase === 'spell' ? null : ' 跳过',
        ),
      ),
    ),
  )
}

// ---------------------------------------------------------------- 工具 hook

/** 延迟同步一个值，避免高频输入触发昂贵计算。 */
function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

// ---------------------------------------------------------------- 虚拟列表

const ROW_H = 40 // 与 .dwl-vrow min-height 一致

/**
 * 轻量虚拟滚动列表。只渲染可视区域 ± overscan 的行。
 * props: items, rowHeight, overscan, renderRow, className
 */
function VirtualList({ items, rowHeight, overscan, renderRow, className }) {
  const rh = rowHeight || ROW_H
  const os = overscan || 6
  const containerRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerH, setContainerH] = useState(400)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerH(e.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback((e) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  const totalH = items.length * rh
  const startIdx = Math.max(0, Math.floor(scrollTop / rh) - os)
  const endIdx = Math.min(items.length, Math.ceil((scrollTop + containerH) / rh) + os)
  const offsetY = startIdx * rh

  const visible = []
  for (let i = startIdx; i < endIdx; i++) {
    visible.push(renderRow(items[i], i))
  }

  return h(
    'div',
    {
      ref: containerRef,
      className: className || '',
      onScroll,
      style: { overflowY: 'auto', position: 'relative', flex: '1 1 0', minHeight: 0 },
    },
    h(
      'div',
      { style: { height: totalH + 'px', position: 'relative' } },
      h(
        'div',
        { style: { position: 'absolute', top: offsetY + 'px', left: 0, right: 0 } },
        visible,
      ),
    ),
  )
}

// ---------------------------------------------------------------- 词汇视图

function VocabView() {
  const [tier, setTier] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedWord, setSelectedWord] = useState(null)
  const alive = useRef(true)
  const lastFocusRef = useRef(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** 换档位：从 offset 0 重新拉。 */
  const load = useCallback(async (nextTier) => {
    setLoading(true)
    setError('')
    try {
      const qs = new URLSearchParams({ limit: '200', offset: '0', order: 'recent' })
      if (nextTier) qs.set('tier', nextTier)
      const r = await api(`/list?${qs.toString()}`)
      if (!alive.current) return
      if (r && r.ok) {
        setItems(r.items || [])
        setTotal(r.total || 0)
      } else {
        setError((r && r.error) || '读不到词表')
      }
    } catch (err) {
      if (alive.current) setError((err && err.message) || '请求失败')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(tier)
  }, [load, tier])

  /** 加载更多：按当前 offset 续拉，追加。 */
  const more = useCallback(async () => {
    if (loading) return
    setLoading(true)
    try {
      const qs = new URLSearchParams({
        limit: '200',
        offset: String(items.length),
        order: 'recent',
      })
      if (tier) qs.set('tier', tier)
      const r = await api(`/list?${qs.toString()}`)
      if (alive.current && r && r.ok) {
        const more = r.items || []
        setItems((prev) => prev.concat(more))
        setTotal(r.total || items.length + more.length)
      }
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [items.length, loading, tier])

  const debouncedQuery = useDebouncedValue(query, 220)
  const keyword = debouncedQuery.trim().toLowerCase()
  // 服务器没有搜索参数，所以这里是**已加载集合**内的过滤，界面上照实说
  const shown = useMemo(() => assetOf('filterLoadedItems')(items, keyword), [items, keyword])

  // 档位缩写/全称在 ./dashboard/logic.js（tierBadgeOf / tierLabelOf）。

  return h(
    'div',
    { className: 'dwl-vocab' },
    h(
      'label',
      { className: 'dwl-search' },
      h(IconSearch, null),
      h('input', {
        type: 'search',
        value: query,
        placeholder: `在已加载的 ${items.length} 条里搜索`,
        'aria-label': '搜索单词',
        onChange: (e) => setQuery(e.target.value),
      }),
    ),

    h(
      'div',
      { className: 'dwl-chips', role: 'group', 'aria-label': '按词频筛选' },
      [{ key: '', label: '全部' }].concat(assetOf('TIERS') || []).map((t) =>
        h(
          'button',
          {
            key: t.key || 'all',
            type: 'button',
            className: 'dwl-chip',
            'aria-pressed': tier === t.key,
            onClick: () => setTier(t.key),
          },
          t.label,
        ),
      ),
    ),

    error ? h('div', { className: 'dwl-note dwl-err' }, error) : null,

    loading && !items.length
      ? h(
          'div',
          { style: { marginTop: 14 } },
          [0, 1, 2, 3, 4, 5].map((i) =>
            h('div', { key: i, className: 'dwl-skel', style: { width: `${90 - i * 7}%` } }),
          ),
        )
      : null,

    !loading && !items.length && !error
      ? h(
          'div',
          { className: 'dwl-mid' },
          h('div', { className: 'ttl' }, '这个词表还是空的'),
          h(
            'div',
            { className: 'sub' },
            '在对话里划一个英文单词，词会自动进生词本，也会出现在这里。',
          ),
        )
      : null,

    shown.length
      ? shown.length > 80
        ? h(VirtualList, {
            items: shown,
            rowHeight: ROW_H,
            overscan: 6,
            className: 'dwl-vlist dwl-vlist-virtual',
            renderRow: (x) =>
              h(
                'div',
                {
                  key: x.id || x.word,
                  className: 'dwl-vrow',
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': `${x.word}${x.translation ? '，' + (x.translation || '').split('\\n')[0] : ''}`,
                  title: `${x.word} · ${tierLabelOf(x.freqTier)}${x.translation ? ' · ' + x.translation : ''}`,
                  onClick: (e) => {
                    lastFocusRef.current = e.currentTarget
                    setSelectedWord(x)
                  },
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      lastFocusRef.current = e.currentTarget
                      setSelectedWord(x)
                    }
                  },
                },
                h('span', { className: 'w' }, x.word),
                x.phonetic ? h('span', { className: 'p' }, `/${x.phonetic}/`) : null,
                h('span', { className: 't' }, (x.translation || '').split('\n')[0] || '—'),
                h('span', { className: 'm' }, tierBadgeOf(x.freqTier)),
              ),
          })
        : h(
            'div',
            { className: 'dwl-vlist' },
            shown.map((x) =>
              h(
                'div',
                {
                  key: x.id || x.word,
                  className: 'dwl-vrow',
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': `${x.word}${x.translation ? '，' + (x.translation || '').split('\\n')[0] : ''}`,
                  title: `${x.word} · ${tierLabelOf(x.freqTier)}${x.translation ? ' · ' + x.translation : ''}`,
                  onClick: (e) => {
                    lastFocusRef.current = e.currentTarget
                    setSelectedWord(x)
                  },
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      lastFocusRef.current = e.currentTarget
                      setSelectedWord(x)
                    }
                  },
                },
                h('span', { className: 'w' }, x.word),
                x.phonetic ? h('span', { className: 'p' }, `/${x.phonetic}/`) : null,
                h('span', { className: 't' }, (x.translation || '').split('\n')[0] || '—'),
                h('span', { className: 'm' }, tierBadgeOf(x.freqTier)),
              ),
            ),
          )
      : null,

    keyword && !shown.length && items.length
      ? h(
          'div',
          { className: 'dwl-mid' },
          h(
            'div',
            { className: 'sub' },
            `已加载的 ${items.length} 条里没有「${query}」。试试换个词频档位，或加载更多词条。`,
          ),
          items.length < total
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dwl-btn',
                  style: { marginTop: 8 },
                  onClick: more,
                  disabled: loading,
                },
                loading ? '读取中…' : '加载更多再搜',
              )
            : null,
        )
      : null,

    h(
      'div',
      { className: 'dwl-more' },
      h('span', null, `已加载 ${items.length} / 共 ${total} 条`),
      items.length < total
        ? h(
            'button',
            { type: 'button', className: 'dwl-btn', onClick: more, disabled: loading },
            loading ? '读取中…' : '加载更多',
          )
        : null,
    ),

    h(
      'div',
      { className: 'dwl-note' },
      '这里只列出已经收录的词。想让新词进来，在对话里划词选「加入生词本」。',
    ),

    selectedWord
      ? h(WordMetaModal, {
          word: selectedWord,
          onClose: () => {
            setSelectedWord(null)
            if (lastFocusRef.current && lastFocusRef.current.focus) lastFocusRef.current.focus()
          },
          api,
        })
      : null,
  )
}

// ---------------------------------------------------------------- 数据视图

function StatsView({ data }) {
  // KPI / 14 天曲线 / 能力画像 / 作答分布的取数与算术全在 ./dashboard/logic.js。
  const { w, c, q, acc, started, tierParts, abMax, repair, dist } = assetOf('statsViewModel')(data)

  return h(
    'div',
    { className: 'dwl-stats' },
    h(
      'div',
      { className: 'dwl-kpis', role: 'group', 'aria-label': '学习概览' },
      h(
        'div',
        { className: 'dwl-kpi' },
        h('div', { className: 'n' }, `${started}`),
        h('div', { className: 'l' }, `开始 / ${w.total || 0} 词`),
      ),
      h(
        'div',
        { className: 'dwl-kpi' },
        h('div', { className: 'n' }, acc.total ? `${Math.round(acc.rate * 100)}%` : '—'),
        h('div', { className: 'l' }, '复习正确率'),
      ),
      h(
        'div',
        { className: 'dwl-kpi' },
        h('div', { className: 'n' }, `${q.dueTomorrow || 0}`),
        h('div', { className: 'l' }, '明日到期'),
      ),
      h(
        'div',
        { className: 'dwl-kpi' },
        h('div', { className: 'n' }, `${q.reviewedToday || 0}`),
        h('div', { className: 'l' }, '今日已复习'),
      ),
    ),

    repair
      ? h(
          'div',
          { className: 'dwl-panel' },
          h('h3', null, '补记循环', h('span', null, '忘了之后的二次提取')),
          h('div', { className: 'dwl-kpis', role: 'group', 'aria-label': '补记效果' }, [
            h(
              'div',
              { key: 'p', className: 'dwl-kpi' },
              h('div', { className: 'n' }, repair.pickRate),
              h('div', { className: 'l' }, `义项首猜命中 / ${repair.pickN} 次`),
            ),
            h(
              'div',
              { key: 's', className: 'dwl-kpi' },
              h('div', { className: 'n' }, repair.spellRate),
              h('div', { className: 'l' }, `拼写通过 / ${repair.spellN} 次`),
            ),
            h(
              'div',
              { key: 'd', className: 'dwl-kpi' },
              h('div', { className: 'n' }, repair.debtText),
              h('div', { className: 'l' }, '补记债已清'),
            ),
          ]),
        )
      : null,

    h(
      'div',
      { className: 'dwl-panel' },
      h('h3', null, '未来 14 天到期', h('span', null, '只算已排期的卡')),
      h(Bars, {
        data: data.forecast || [],
        titleFor: (d) => `${fmtMD(d.date)}：${d.count} 个`,
      }),
    ),

    h(
      'div',
      { className: 'dwl-panel' },
      h('h3', null, '近 14 天复习量'),
      h(Bars, {
        data: data.activity || [],
        titleFor: (d) => `${fmtMD(d.date)}：${d.count} 次作答`,
      }),
    ),

    h(
      'div',
      { className: 'dwl-panel' },
      h('h3', null, '学习进度', h('span', null, `${started} / ${w.total || 0} 个词`)),
      h(StackedProgress, { parts: tierParts, total: w.total || 0 }),
      h(
        'div',
        { className: 'dwl-note' },
        `新词 ${c.fresh || 0} · 学习中 ${c.learning || 0} · 复习中 ${c.review || 0} · 重学 ${c.relearning || 0}`,
      ),
    ),

    h(
      'div',
      { className: 'dwl-panel' },
      h('h3', null, '能力画像', h('span', null, '0–5 分，条长是词数')),
      (assetOf('ABILITIES') || []).map((a) =>
        h(
          'div',
          { key: a.key, className: 'dwl-abrow', title: a.hint },
          h('span', { className: 'nm' }, a.label),
          h(Histogram, {
            buckets: (data.ability || {})[a.key] || [0, 0, 0, 0, 0, 0],
            max: abMax,
          }),
          h(
            'span',
            { className: 'hi' },
            assetOf('abilityAverage')((data.ability || {})[a.key] || []),
          ),
        ),
      ),
    ),

    h(
      'div',
      { className: 'dwl-panel' },
      h('h3', null, '作答分布', h('span', null, acc.total ? `共 ${acc.total} 次` : '暂无')),
      dist.length
        ? dist.map((r) =>
            h(
              'div',
              { key: r.value, className: 'dwl-dist' },
              h('span', { className: 'nm' }, r.label),
              h(
                'span',
                { className: 'bar' },
                h('i', { style: { width: `${r.pct}%`, background: r.color } }),
              ),
              h('span', { className: 'v' }, `${r.n} 次`),
            ),
          )
        : h('div', { className: 'dwl-note' }, '还没有作答记录'),
    ),

    h(
      'div',
      { className: 'dwl-panel' },
      h('h3', null, '最容易忘的词', h('span', null, '按遗忘次数')),
      data.hardest && data.hardest.length
        ? h(
            'div',
            { className: 'dwl-rows' },
            data.hardest.map((x, i) =>
              h(
                'div',
                { key: i, className: 'dwl-row' },
                h('span', { className: 'w' }, x.word),
                h('span', { className: 't' }, (x.translation || '').split('\n')[0]),
                h('span', { className: 'm' }, `忘 ${x.lapses} 次`),
              ),
            ),
          )
        : h('div', { className: 'dwl-note' }, '还没有反复忘的词'),
    ),

    h(
      'div',
      { className: 'dwl-panel' },
      h('h3', null, '最近遇到'),
      data.recent && data.recent.length
        ? h(
            'div',
            { className: 'dwl-rows' },
            data.recent.map((x, i) =>
              h(
                'div',
                { key: i, className: 'dwl-row' },
                h('span', { className: 'w' }, x.word),
                h('span', { className: 't' }, (x.translation || '').split('\n')[0]),
                h('span', { className: 'm' }, assetOf('relTime')(x.seen_at)),
              ),
            ),
          )
        : h('div', { className: 'dwl-note' }, '还没遇到过词'),
    ),

    data.schedule && data.schedule.ok === false
      ? h('div', { className: 'dwl-note dwl-err' }, '排期引擎未就绪，评分可能不生效')
      : null,

    h(
      'div',
      { className: 'dwl-note' },
      `数据存在 ${data.dbPath || '$DSH_HOME/dsh-word-learn/user.db'}（本地，可备份）`,
    ),
  )
}

// ---------------------------------------------------------------- 主页面

// ---------------------------------------------------------------- 设置视图

function SettingsView({ api }) {
  const [accent, setAccentState] = useState(loadAccent)
  const [autoSpeak, setAutoSpeakState] = useState(loadAutoSpeak)
  // AI 分析模型：目录来自宿主（DSH 的模型列表），selection 是当前生效的那个。
  const [catalog, setCatalog] = useState(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    let alive = true
    setCatalogLoading(true)
    api('/models')
      .then((r) => {
        if (!alive) return
        if (r && r.ok) {
          setCatalog(r)
          setCatalogError('')
        } else {
          setCatalogError((r && r.error) || '读不到 DSH 的模型列表')
        }
      })
      .catch(() => {
        if (alive) setCatalogError('读不到 DSH 的模型列表')
      })
      .finally(() => {
        if (alive) setCatalogLoading(false)
      })
    return () => {
      alive = false
    }
  }, [api])

  const handleAccent = useCallback((e) => {
    const v = e.target.value
    setAccentState(v)
    saveAccent(v)
  }, [])

  const handleAutoSpeak = useCallback((e) => {
    const on = !!e.target.checked
    setAutoSpeakState(on)
    assetOf('saveAutoSpeak')(on)
  }, [])

  // 下拉取数（选中下标 / 按 provider 分组）在 ./dashboard/logic.js；select 的 value
  // 用下标而不是 "provider/model"：模型 id 里可能带斜杠，拼字符串再拆会选错。
  const { models, selection, currentIndex, groups } = useMemo(
    () => assetOf('modelCatalogView')(catalog),
    [catalog],
  )

  const chooseModel = useCallback(
    async (e) => {
      const model = models[Number(e.target.value)]
      if (!model || saving) return
      setSaving(true)
      setSaveError('')
      try {
        const r = await api('/model', {
          method: 'POST',
          body: { provider: model.provider, model: model.id },
        })
        if (r && r.ok) {
          setCatalog((prev) =>
            prev ? { ...prev, selection: r.selection, lostSelection: null } : prev,
          )
        } else {
          setSaveError((r && r.error) || '保存失败')
        }
      } catch (err) {
        setSaveError('保存失败')
      } finally {
        setSaving(false)
      }
    },
    [api, models, saving],
  )

  const resetModel = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setSaveError('')
    try {
      const r = await api('/model', { method: 'POST', body: { reset: true } })
      if (r && r.ok) {
        setCatalog((prev) =>
          prev ? { ...prev, selection: r.selection, lostSelection: null } : prev,
        )
      } else {
        setSaveError((r && r.error) || '恢复默认失败')
      }
    } catch (err) {
      setSaveError('恢复默认失败')
    } finally {
      setSaving(false)
    }
  }, [api, saving])

  return h(
    'div',
    { className: 'dwl-settings' },
    // 发音偏好
    h(
      'div',
      { className: 'dwl-settings-section' },
      h('div', { className: 'hd' }, '发音偏好'),
      h(
        'div',
        { className: 'desc' },
        '影响词汇卡片和对话中划词卡片的发音。美音/英音都会缓存在本地，学习页开始一轮时自动把这一轮的词准备好。',
      ),
      h(
        'div',
        { className: 'dwl-settings-row' },
        h('label', { htmlFor: 'dwl-accent-select' }, '默认口音'),
        h(
          'select',
          {
            id: 'dwl-accent-select',
            value: accent,
            onChange: handleAccent,
            'aria-label': '选择默认发音口音',
          },
          h('option', { value: 'us' }, '美式 (US)'),
          h('option', { value: 'uk' }, '英式 (UK)'),
        ),
      ),
      h(
        'div',
        { className: 'dwl-settings-row' },
        h('label', { htmlFor: 'dwl-auto-speak' }, '自动发音'),
        h('input', {
          id: 'dwl-auto-speak',
          type: 'checkbox',
          checked: autoSpeak,
          onChange: handleAutoSpeak,
          'aria-label': '学习时自动发音',
        }),
      ),
      h(
        'div',
        { className: 'dwl-settings-effect' },
        autoSpeak
          ? '学习时，单词出现、看答案、拼完单词都会自动读一遍；喇叭图标随时可以手动重听。'
          : '已关闭：只有点喇叭（或按 S）才会发音。',
      ),
    ),
    // AI 分析模型：复用 DSH 已有的文本模型列表，默认第一个
    h(
      'div',
      { className: 'dwl-settings-section' },
      h('div', { className: 'hd' }, 'AI 分析模型'),
      h(
        'div',
        { className: 'desc' },
        '词根拆解、联想记忆等 AI 分析用哪个模型。列表就是 DSH 里已配置的文本模型，默认用第一个；这里改了不影响对话用的默认模型。',
      ),
      catalogLoading
        ? h('div', { className: 'dwl-settings-effect' }, '读取 DSH 模型列表…')
        : catalogError
          ? h('div', { className: 'dwl-err' }, catalogError)
          : models.length === 0
            ? h('div', { className: 'dwl-settings-effect' }, assetOf('catalogEmptyHint')(selection))
            : h(
                'div',
                null,
                h(
                  'div',
                  { className: 'dwl-settings-row' },
                  h('label', { htmlFor: 'dwl-model-select' }, '分析用模型'),
                  h(
                    'select',
                    {
                      id: 'dwl-model-select',
                      value: currentIndex >= 0 ? String(currentIndex) : '',
                      disabled: saving,
                      onChange: chooseModel,
                      'aria-label': '选择 AI 分析使用的模型',
                    },
                    groups.map((g) =>
                      h(
                        'optgroup',
                        { key: g.id, label: g.name },
                        g.items.map((it) =>
                          h(
                            'option',
                            { key: it.index, value: String(it.index) },
                            it.model.name +
                              (it.model.id !== it.model.name ? '（' + it.model.id + '）' : ''),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'dwl-settings-effect' },
                  h('span', null, '当前生效：' + assetOf('selectionText')(selection)),
                  selection && selection.source === 'custom'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dwl-settings-link',
                          onClick: resetModel,
                          disabled: saving,
                        },
                        '恢复默认（第一个）',
                      )
                    : null,
                ),
                catalog && catalog.lostSelection
                  ? h(
                      'div',
                      { className: 'dwl-settings-effect' },
                      '你之前选的 ' +
                        catalog.lostSelection.provider +
                        ' / ' +
                        catalog.lostSelection.model +
                        ' 已不在 DSH 模型目录里，现按默认第一个分析。',
                    )
                  : null,
                saveError ? h('div', { className: 'dwl-err' }, saveError) : null,
              ),
    ),
    // 关于
    h(
      'div',
      { className: 'dwl-settings-section' },
      h('div', { className: 'hd' }, '关于'),
      h(
        'div',
        { className: 'desc' },
        '生词本插件 (dsh-word-learn)。在对话中选中英文单词即可触发划词卡片，点「加入生词本」收录。',
      ),
    ),
  )
}

// 入口：逻辑与样式都在 bundle 内，模块求值即就绪，不需要加载态。
function WordLearnPage() {
  return h(ReadyPage, null)
}

function ReadyPage() {
  const [view, setView] = useState(readView)
  const [data, setData] = useState(null)
  const [queue, setQueue] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState(0)
  // P1：本轮评过「忘了」的词，会话末集中补记一次（R4）。
  const [repairs, setRepairs] = useState([])
  const [repairDone, setRepairDone] = useState(false)
  // 补记效果（统计页用）：义项首猜命中、拼写通过、债的清偿
  const [repairStats, setRepairStats] = useState(null)
  // P2：R5 昨日回访。trials 为 null 表示还没拉过；[] 表示今天没有可回访的词。
  const [recap, setRecap] = useState(null)
  const [recapDone, setRecapDone] = useState(false)
  // 回访只拉一次：load() 会因为出错重试再次执行，不能把答到一半的流程重置。
  const recapLoaded = useRef(false)
  // 本轮自己评了几次，用来即时更新顶部"今日已复习"，避免每评一次就重拉看板
  const [graded, setGraded] = useState(0)
  // 发音状态（Web Speech API）
  const [accent, setAccent] = useState(loadAccent)
  const [autoSpeak, setAutoSpeak] = useState(loadAutoSpeak)
  const [speaking, setSpeaking] = useState(false)
  // 一次性提示（发音失败之类），3 秒后自己消失
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3200)
    return () => clearTimeout(t)
  }, [toast])

  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      // R5 昨日回访：拿不到就当今天没有回访，主队列照常 ——
      // 绝不能因为回访接口挂了让学习页白屏。
      const wantRecap = !recapLoaded.current && !assetOf('recapSkippedToday')()
      const [dash, q, rs, rc] = await Promise.all([
        api('/dashboard?days=14'),
        api('/queue?limit=500'),
        api('/repair/stats?days=14').catch(() => null),
        wantRecap ? api('/repair/recap?limit=5').catch(() => null) : null,
      ])
      if (!alive.current) return
      if (wantRecap) {
        recapLoaded.current = true
        const trials = rc && rc.ok && Array.isArray(rc.trials) ? rc.trials : []
        setRecap(trials)
        setRecapDone(false)
      }
      setRepairStats(rs && rs.ok ? rs : null)
      if (!dash || dash.ok === false) {
        setError((dash && dash.error) || '读不到学习数据')
        setData(null)
      } else {
        setData(dash)
      }
      const nextQueue = q && q.ok ? q : { items: [], total: 0 }
      setQueue(nextQueue)
      // 新的一轮：补记清单和"已补完"标记都清掉
      setRepairs([])
      setRepairDone(false)
      // 开始一轮先预热音色列表（不阻塞 UI，失败静默）：
      // speechSynthesis 第一次 getVoices() 常是空数组，预热后点喇叭即时出声。
      try {
        const voice = assetOf('voiceModule')()
        if (voice && typeof voice.preload === 'function') {
          Promise.resolve(voice.preload()).catch(() => {})
        }
      } catch (err) {}
    } catch (err) {
      if (alive.current) setError((err && err.message) || '请求失败')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const items = (queue && queue.items) || []
  const item = items[cursor] || null
  const total = items.length

  // R5：回访没做完就不显示主队列（一次一题，做完/跳过才进主队列）。
  const recapActive = !!(recap && recap.length && !recapDone)

  const changeView = useCallback(
    (next) => {
      // 回访做到一半切走（去看词表/数据）：本轮回访就此结束，不要再把它
      // 挂在那里 —— RecapPass 卸载后进度会归零，切回来会把答过的题再问一遍、
      // 重复写 repair_log。没答的题服务端仍会留着，刷新后还能接着回访。
      if (recapActive) setRecapDone(true)
      setView(next)
      assetOf('saveView')(next)
    },
    [recapActive],
  )

  /** 跳过回访：不扣任何东西（不清债、不写库），只记「今天不再问」。 */
  const skipRecap = useCallback(() => {
    assetOf('markRecapSkipped')()
    setRecapDone(true)
  }, [])

  /** 回访做完。 */
  const finishRecap = useCallback(() => {
    setRecapDone(true)
  }, [])

  // 设置页改完口音/自动发音，回到学习页要立刻生效：
  // 这两个偏好在 localStorage，WordLearnPage 只在挂载时读一次会读到旧值。
  useEffect(() => {
    if (view !== 'study') return
    setAccent(loadAccent())
    setAutoSpeak(loadAutoSpeak())
  }, [view])

  const skip = useCallback(() => {
    setCursor((c) => Math.min(c + 1, total))
  }, [total])

  /**
   * 评分（由 StudyView 的分支逻辑决定 rating 值）。
   *
   * 成功后只做两件事：游标 +1、本轮计数 +1。
   * **不删队列行** —— 删行会让"还剩几个"跟着变，进度条就会跳。
   */
  const grade = useCallback(
    async (rating) => {
      if (!item || busy) return
      setBusy(true)
      try {
        const r = await api('/grade', {
          method: 'POST',
          body: { cardId: item.cardId, rating },
        })
        if (!alive.current) return
        if (r && r.ok) {
          // 评「忘了」的词记下来，会话末统一补记（R4）。
          if (rating === 1) setRepairs((prev) => [...prev, item])
          setGraded((n) => n + 1)
          setCursor((c) => c + 1)
        } else {
          setError((r && r.error) || '评分没成功')
        }
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [item, busy],
  )

  /** 朗读当前词。 */
  const speak = useCallback(() => {
    if (!item || speaking) return
    setSpeaking(true)
    playWord(item.word, accent)
      .catch((err) => {
        // 重新点一次会打断上一条（ABORTED），那不是失败，别弹提示
        if (alive.current && !assetOf('isAbort')(err)) setToast(assetOf('voiceErrorText')(err))
      })
      .finally(() => {
        if (alive.current) setSpeaking(false)
      })
  }, [item, accent, speaking])

  const toggleAccent = useCallback(() => {
    setAccent((prev) => {
      const next = prev === 'uk' ? 'us' : 'uk'
      saveAccent(next)
      return next
    })
  }, [])

  // 键盘：只在学习视图生效，且不在输入框里
  // 1/2/3 分支选择由 StudyView 内部处理（它知道当前 phase）
  // 回访进行中则由 RecapPass 自己接管 1/2，这里不要抢 j/s（那会跳过主队列、
  // 播当前词），否则用户答着回访听到一个无关单词的发音。
  const live = useRef({})
  live.current = { view, item, skip, speak, recapActive }

  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const s = live.current
      if (s.view !== 'study' || !s.item || s.recapActive) return
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        s.skip()
        return
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        s.speak()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const reviewedToday = ((data && data.queue && data.queue.reviewedToday) || 0) + graded

  // ── 顶部
  const top = h(
    'div',
    { className: 'dwl-top' },
    h(
      'div',
      { className: 'dwl-tabs', role: 'tablist', 'aria-label': '学习页视图' },
      (assetOf('TABS') || []).map((t) =>
        h(
          'button',
          {
            key: t.key,
            type: 'button',
            role: 'tab',
            className: 'dwl-tab',
            'aria-selected': view === t.key,
            onClick: () => changeView(t.key),
          },
          t.label,
        ),
      ),
    ),
    h('span', { className: 'dwl-pill' }, '今日已复习 ', h('b', null, String(reviewedToday)), ' 次'),
  )

  // ── 学习视图的内容（含加载 / 空 / 完成三种状态）
  let body = null
  if (view === 'study') {
    if (loading && !queue) {
      body = h(
        'div',
        { className: 'dwl-study' },
        h('div', {
          className: 'dwl-skel',
          style: { width: '34%', height: 34, margin: '0 auto' },
        }),
        h('div', { className: 'dwl-skel', style: { width: '22%', margin: '18px auto 0' } }),
        h('div', { className: 'dwl-skel', style: { width: '70%', margin: '40px auto 0' } }),
        h('div', { className: 'dwl-skel', style: { width: '50%', margin: '14px auto 0' } }),
      )
    } else if (recapActive) {
      // R5：昨日回访优先。昨天忘过的词今天先做义项判别，做完或跳过才进主队列。
      // 跳过不清债 —— 那笔债明天还会以回访的形式回来。
      body = h(RecapPass, {
        trials: recap,
        onDone: finishRecap,
        onSkip: skipRecap,
      })
    } else if (!total) {
      body = h(
        'div',
        { className: 'dwl-mid' },
        h('div', { className: 'big' }, '0'),
        h('div', { className: 'ttl' }, '今天没有到期的词'),
        h(
          'div',
          { className: 'sub' },
          (data && data.queue && data.queue.dueTomorrow
            ? `明天有 ${data.queue.dueTomorrow} 个词到期。`
            : '') + '想在对话里遇到新词就顺手收进来 —— 划词卡片上有「加入生词本」。',
        ),
        h(
          'button',
          { type: 'button', className: 'dwl-btn', onClick: () => changeView('vocab') },
          '去看看词表',
        ),
      )
    } else if (cursor >= total && repairs.length && !repairDone) {
      // R4：会话末补记。今天「忘了」的词再过一遍，拼对一次才清债。
      body = h(RepairPass, {
        items: repairs,
        onDone: () => setRepairDone(true),
      })
    } else if (cursor >= total) {
      body = h(
        'div',
        { className: 'dwl-mid' },
        h('div', { className: 'big' }, String(total)),
        h('div', { className: 'ttl' }, '今天的都过完了'),
        h(
          'div',
          { className: 'sub' },
          `这一轮过掉 ${total} 个词。` +
            (data && data.queue && data.queue.dueTomorrow
              ? `明天还有 ${data.queue.dueTomorrow} 个到期。`
              : ''),
        ),
        h(
          'button',
          { type: 'button', className: 'dwl-btn primary', onClick: () => changeView('stats') },
          '看看这段时间的进度',
        ),
      )
    } else {
      body = h(StudyView, {
        item,
        cursor,
        total,
        busy,
        onRate: grade,
        accent,
        onToggleAccent: toggleAccent,
        onSpeak: speak,
        speaking,
        autoSpeak,
      })
    }
  } else if (view === 'vocab') {
    body = h(VocabView, null)
  } else if (view === 'stats') {
    body = data
      ? h(StatsView, { data: repairStats ? { ...data, repair: repairStats } : data })
      : h(
          'div',
          { className: 'dwl-mid' },
          h('div', { className: 'sub' }, error || '读不到统计数据'),
          h('button', { type: 'button', className: 'dwl-btn', onClick: load }, '重试'),
        )
  } else if (view === 'settings') {
    body = h(SettingsView, { api })
  }

  return h(
    'div',
    { className: 'dwl-page' },
    h(
      'div',
      { className: 'dwl-wrap' },
      top,

      // 非致命错误：数据还能用就只用一条横幅，不整页替换
      error && (data || queue)
        ? h(
            'div',
            { className: 'dwl-banner', role: 'alert' },
            h('span', null, error),
            h(
              'button',
              {
                type: 'button',
                className: 'dwl-btn',
                onClick: () => {
                  setError('')
                  load()
                },
              },
              '重试',
            ),
          )
        : null,

      // 一闪而过的提示（发音失败等），不占用错误横幅
      toast ? h('div', { className: 'dwl-banner', role: 'status' }, h('span', null, toast)) : null,

      // 今日进度条：只在学习视图出现，跟着游标走。
      // 回访阶段不显示 —— 那是「昨天的词」，和本轮进度条不是一回事，
      // 挂着 0/12 会让人以为回访的题也算进了今天的复习量。
      view === 'study' && total && !recapActive
        ? h(
            'div',
            { className: 'dwl-meter' },
            h(
              'div',
              { className: 'dwl-track' },
              h('i', { style: { width: `${(cursor / total) * 100}%` } }),
            ),
            h(
              'div',
              { className: 'dwl-legend-line' },
              h(
                'span',
                null,
                '本轮 ',
                h('b', null, String(Math.min(cursor, total))),
                ` / ${total}`,
              ),
              h(
                'span',
                null,
                cursor < total
                  ? `还剩 ${total - cursor} 个 · ${assetOf('estimateMinutes')(total - cursor)}`
                  : '全部完成',
              ),
            ),
          )
        : null,

      body,
    ),
  )
}

/**
 * 侧栏与面板标题用的文案。
 *
 * 这两个 key 会被注册进 locale 目录，所以侧栏 label 必须写成
 * `t('panel.title')` 而不是硬编码字符串 —— 否则 `locale: NS` 是空配置，
 * 而且英文环境下标题还是中文。
 */
const DICT = {
  zh: {
    'panel.title': '英语学习',
    'panel.desc': '今日复习、生词表与学习数据',
  },
  en: {
    'panel.title': 'Word Learning',
    'panel.desc': 'Due reviews, vocabulary, and progress',
  },
}

/** 需要客户端服务：插槽注册表 + 文案目录。 */
const inject = ['slots', 'locale']

function apply(ctx) {
  // ① 注册文案目录。**必须在注册 slot 之前**，否则 label 求值时
  //    目录还是空的，t() 会退回返回原始 key（界面显示 "panel.title"）。
  ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-word-learn: browser dictionaries')

  // 侧栏 label 在注册时求值一次，用绑定的 t。
  const t = ctx.locale.bind(NS)

  // ② 左栏入口。id 必须与下面 main 的 key 完全一致。
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 15,
        locale: NS,
        label: () => t('panel.title'),
      },
      PanelIcon,
    ),
  )

  // ③ 主面板。点侧栏入口时框架用同一个 id 来这里取。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      },
      WordLearnPage,
    ),
  )

  // ④ 样式。作为 effect 注册，卸载时自动摘掉。
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-word-learn'
    tag.textContent = DASHBOARD_CSS
    document.head.appendChild(tag)
    return () => {
      try {
        tag.remove()
      } catch (err) {}
    }
  }, 'dsh-word-learn: page styles')
}

// 单测入口：整文件加载本模块后从这里取组件与纯函数。
// 为什么要有：测试过去按函数名切源码再 new Function，注释/解构一变就碎。
// DSH 只读 inject/apply，多一个键不影响加载（见 tests/helpers/dashboard.mjs）。
const __test__ = {
  // 纯逻辑模块对象：组件测试要 spy 单个函数（如 saveAccent）时改它的属性，
  // 与运行时读的是同一个对象。
  LOGIC,
  HoverWord,
  WritePanel,
  SettingsView,
  StatsView,
  VocabView,
  WordLearnPage,
  normalizeSpelling,
  editDistance,
  spellCheck,
}

// 导出给构建产物：banner/footer 负责包成
// window.__ModuleLoader__.load({ id, factory }) 的 CJS 壳（见 tsdown.config.ts）。
// DSH 只读 inject/apply，__test__ 给组件测试用。
export { inject, apply, __test__ }
