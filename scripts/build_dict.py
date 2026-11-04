"""把 ECDICT 的 ecdict.csv 转成插件用的精简 SQLite 词典。

## 为什么要精简

原始 `ecdict.csv` 有 63MB / 77 万词条，但插件的实际用途是"划词查词"，只需要：

    - 用户可能遇到的词（**按词频截断**，不是全量）
    - 每个词的必要字段（音标、释义、词性、变形、词频）

全量入库会让 `ecdict.db` 涨到 100MB+，而其中绝大多数是用户一辈子不会查的
生僻词、专有名词、拼写变体。截断到高频区间，体积能降到 1/5，命中率几乎不变。

## 截断规则（可调）

保留满足**任一**条件的词：

    1. 有 `frq`（当代语料库词频）或 `bnc`（英国国家语料库词频）——说明是真实高频词
    2. 有 `tag`（cet4/cet6/ielts/gre/zk/gk/ky/toefl）——考试大纲词，用户明确要学
    3. 有 `oxford` 或 `collins >= 1`——权威词典收录的核心词
    4. 是某个保留词的**变形**（exchange 指向它）——否则查 "perceived" 查不到

第 4 条很关键：ECDICT 的 `exchange` 里 `0:lemma` 表示原形，
如果只按词频截断，"perceived" 这类变形词可能因为自身没词频而被丢掉。

用法：
    python build_dict.py                    # 用默认截断
    python build_dict.py --all              # 不截断，全量入库
    python build_dict.py --max-frq 30000    # 只保留词频前 30000
"""

from __future__ import annotations

import argparse
import csv
import re
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
DATA = PROJECT / "data"

DEFAULT_CSV = Path(r"D:\dsh-cache\tmp\ecdict.csv")
DEFAULT_DB = DATA / "ecdict.db"

# 考试标签：有这些标签的词一定要留（用户明确要学）
EXAM_TAGS = {"zk", "gk", "cet4", "cet6", "ky", "ielts", "toefl", "gre"}

SCHEMA = """
DROP TABLE IF EXISTS dict;
CREATE TABLE dict (
  word        TEXT PRIMARY KEY,   -- 原形（小写）
  lemma       TEXT,               -- 本条若是变形，指向原形（ECDICT exchange 的 0:）
  phonetic    TEXT,
  translation TEXT,               -- 中文释义
  definition  TEXT,               -- 英文释义
  pos         TEXT,               -- 词性，'/' 分隔
  collins     INTEGER,            -- 柯林斯星级 0-5
  oxford      INTEGER,            -- 牛津 3000 核心词
  tag         TEXT,               -- 考试标签
  bnc         INTEGER,            -- 英国国家语料库词频（越小越常见）
  frq         INTEGER,            -- 当代语料库词频
  exchange    TEXT,               -- 变形
  audio       TEXT                -- 发音 url（ECDICT 里是空的，靠外部补）
);
CREATE INDEX idx_dict_frq ON dict(frq) WHERE frq > 0;
CREATE INDEX idx_dict_bnc ON dict(bnc) WHERE bnc > 0;

-- 变形反查：查 "perceived" 要能找到原形 "perceive"
DROP TABLE IF EXISTS forms;
CREATE TABLE forms (
  form TEXT PRIMARY KEY,          -- 变形后的拼写
  word TEXT NOT NULL              -- 原形
);
CREATE INDEX idx_forms_word ON forms(word);
"""

# exchange 字段格式：d:perceived/p:perceived/3:perceives/i:perceiving/0:perceive
# 键含义：p=过去式 d=过去分词 i=现在分词 3=第三人称单数 r=比较级 t=最高级
#         0=原形(lemma) 1=原形变换 s=复数
EXCHANGE_KEYS = {
    "p": "过去式",
    "d": "过去分词",
    "i": "现在分词",
    "3": "第三人称单数",
    "r": "比较级",
    "t": "最高级",
    "s": "复数",
}


def parse_exchange(raw: str) -> tuple[str | None, dict[str, str]]:
    """解析 exchange 字段，返回 (lemma, {键: 变形值})。"""
    lemma = None
    forms: dict[str, str] = {}
    if not raw:
        return lemma, forms
    for part in raw.split("/"):
        if ":" not in part:
            continue
        key, _, value = part.partition(":")
        key = key.strip()
        value = value.strip()
        if not value:
            continue
        if key == "0":
            lemma = value.lower()
        elif key == "1":
            # 1 是"原形变换"标记，值就是原形本身
            lemma = lemma or value.lower()
        else:
            forms[key] = value.lower()
    return lemma, forms


def to_int(value: str) -> int:
    try:
        return int(str(value).strip() or 0)
    except (TypeError, ValueError):
        return 0


def is_ascii_word(word: str) -> bool:
    """只要纯字母（可含连字符、撇号、空格）的词条。

    划词遇到的是正常英文，专有名词/含数字/含奇怪符号的条目对本插件无用，
    还会把词典撑大。
    """
    if not word or len(word) > 40:
        return False
    return bool(re.fullmatch(r"[a-z][a-z'\- ]*", word))


def unescape(raw: str) -> str:
    """ECDICT 的 translation/definition 里换行是**字面的两个字符** ``\\n``。

    实测：19944 条 translation 含字面 ``\\n``，含真实换行的 **0 条**。
    必须在这里还原成真换行，否则释义会挤成一行、还带着可见的反斜杠。
    """
    if not raw:
        return ""
    return raw.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n").strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="ECDICT CSV -> 精简 SQLite")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--all", action="store_true", help="不截断，全量入库")
    parser.add_argument("--max-frq", type=int, default=0, help="只保留 frq <= N 的词")
    args = parser.parse_args()

    if not args.csv.exists():
        print(f"找不到 CSV: {args.csv}")
        return 1

    DATA.mkdir(parents=True, exist_ok=True)
    if args.db.exists():
        args.db.unlink()

    print(f"读取 {args.csv}  ({args.csv.stat().st_size / 1024 / 1024:.1f} MB)")

    started = time.time()
    conn = sqlite3.connect(str(args.db))
    conn.executescript(SCHEMA)

    # ---------- 第一遍：读进来，判断哪些词该保留 ----------
    rows: list[tuple] = []
    form_rows: list[tuple[str, str]] = []
    total = 0
    kept = 0
    skipped_encoding = 0

    with args.csv.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for raw in reader:
            total += 1
            word = (raw.get("word") or "").strip().lower()
            if not is_ascii_word(word):
                skipped_encoding += 1
                continue

            frq = to_int(raw.get("frq"))
            bnc = to_int(raw.get("bnc"))
            collins = to_int(raw.get("collins"))
            oxford = to_int(raw.get("oxford"))
            tag = (raw.get("tag") or "").strip().lower()
            exchange = (raw.get("exchange") or "").strip()
            # exchange 里 0:xxx 表示"这是 xxx 的变形"（如 children -> 0:child）
            lemma, forms = parse_exchange(exchange)

            if not args.all:
                # 保留条件（任一满足）
                has_freq = frq > 0 or bnc > 0
                has_exam = bool(tag) and bool(EXAM_TAGS & set(tag.split()))
                has_authority = oxford > 0 or collins > 0
                in_frq_range = args.max_frq > 0 and 0 < frq <= args.max_frq
                if not (has_freq or has_exam or has_authority or in_frq_range):
                    continue

            rows.append(
                (
                    word,
                    lemma or "",
                    (raw.get("phonetic") or "").strip(),
                    unescape(raw.get("translation")),
                    unescape(raw.get("definition")),
                    (raw.get("pos") or "").strip(),
                    collins,
                    oxford,
                    tag,
                    bnc,
                    frq,
                    exchange,
                    (raw.get("audio") or "").strip(),
                )
            )
            kept += 1

            for value in forms.values():
                form_rows.append((value, word))

    # ---------- 第二遍：入库 ----------
    print(f"  总行数 {total:,}  保留 {kept:,}  跳过 {skipped_encoding:,}")

    conn.executemany(
        "INSERT OR REPLACE INTO dict (word,lemma,phonetic,translation,definition,pos,"
        "collins,oxford,tag,bnc,frq,exchange,audio) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )

    # 变形表：只登记"原形也在库里"的，避免指向被截断掉的词
    kept_words = {r[0] for r in rows}
    form_rows = [(f, w) for (f, w) in form_rows if w in kept_words and f != w]
    conn.executemany("INSERT OR REPLACE INTO forms (form, word) VALUES (?,?)", form_rows)

    conn.commit()
    conn.execute("VACUUM")
    conn.close()

    size = args.db.stat().st_size / 1024 / 1024
    print(f"  变形索引 {len(form_rows):,} 条")
    print(f"  写入 {args.db}  ({size:.1f} MB)  用时 {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
