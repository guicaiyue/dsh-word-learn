# -*- coding: utf-8 -*-
"""划词卡片深色块：底色改用 bg-layer-3（bg-overlay 在深色下是 #61666B 的中灰），错误色改用浅红。"""
import sys

P = r'D:\projects\blog\dsh-plugins\dsh-word-learn\assets\wordcard.js'
s = open(P, encoding='utf-8').read()

SUBS = [
    ("'  --dwl-bg:var(--dsw-alias-bg-overlay,#1c1f26);',",
     "'  --dwl-bg:var(--dsw-alias-bg-layer-3,#1c1f26);',"),
    ("'  --dwl-err:var(--dsw-alias-state-error-primary,#f87171);',",
     "'  --dwl-err:var(--dsw-static-red-100,#f87171);',"),
]

for old, new in SUBS:
    n = s.count(old)
    if n != 1:
        print('FAIL: %d matches for %r' % (n, old))
        sys.exit(1)
    s = s.replace(old, new, 1)

open(P, 'w', encoding='utf-8', newline='').write(s)
print('ok: wordcard patched (%d)' % len(SUBS))
