# -*- coding: utf-8 -*-
"""一次性应用暗色主题的 7 处样式修正（逐条精确匹配，任一条不匹配即中止，不写文件）。"""
import sys

P = r'D:\projects\blog\dsh-plugins\dsh-word-learn\assets\dashboard.js'
s = open(P, encoding='utf-8').read()

SUBS = [
    # ① 新增插件自己的强调色（DSH 的 brand 在深浅两套里都是黑/白，不能当有彩色用）
    ('--dwl-error-bg:rgba(229,57,53,.08);',
     '--dwl-error-bg:rgba(229,57,53,.08);--dwl-accent:#0d9488;'),
    ('--dwl-error-bg:rgba(229,57,53,.16);',
     '--dwl-error-bg:rgba(229,57,53,.16);--dwl-accent:#2dd4bf;'),
    # ② 控件描边 18% → 34%（合成 1.74:1 → 3.2:1）
    ('--dwl-btn-border:rgba(255,255,255,.18);',
     '--dwl-btn-border:rgba(255,255,255,.34);'),
    # ③ 图表不再用 brand（深色下是近白），改用强调色
    ('border-radius:3px 3px 0 0;background:var(--dsw-alias-brand-primary);',
     'border-radius:3px 3px 0 0;background:var(--dwl-accent);'),
    ('opacity:.82;min-height:2px;transition:opacity .14s ease}',
     'opacity:.9;min-height:2px;transition:opacity .14s ease}'),
    ('.dwl-abrow .hist i{flex:1;border-radius:2px 2px 0 0;background:var(--dsw-alias-brand-primary);',
     '.dwl-abrow .hist i{flex:1;border-radius:2px 2px 0 0;background:var(--dwl-accent);'),
    ("{ key: 'top8k', label: '常用 8000', color: 'var(--dsw-alias-brand-primary)' },",
     "{ key: 'top8k', label: '常用 8000', color: 'var(--dwl-accent)' },"),
    # ④ 选中态补一条与文字同强度的指示条（不靠 5.5% 白的深浅差）
    ('.dwl-tab{font:inherit;', '.dwl-tab{position:relative;font:inherit;'),
    ('.dwl-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dwl-tint)}',
     '.dwl-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dwl-tint)}\n'
     '.dwl-tab[aria-selected="true"]::after{content:"";position:absolute;left:12px;right:12px;bottom:1px;'
     'height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}'),
    # ⑤ chips 选中态补 1px 同色环
    ('.dwl-chip[aria-pressed="true"]{background:var(--dwl-tint);color:var(--dsw-alias-label-primary);font-weight:600}',
     '.dwl-chip[aria-pressed="true"]{background:var(--dwl-tint);color:var(--dsw-alias-label-primary);font-weight:600;'
     'box-shadow:inset 0 0 0 1px var(--dsw-alias-label-primary)}'),
]

for old, new in SUBS:
    n = s.count(old)
    if n != 1:
        print('FAIL: expected 1 match, got %d for: %r' % (n, old[:70]))
        sys.exit(1)
    s = s.replace(old, new, 1)

open(P, 'w', encoding='utf-8', newline='').write(s)
print('ok: %d substitutions applied' % len(SUBS))
