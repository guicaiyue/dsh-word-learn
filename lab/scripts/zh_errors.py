"""中式英语发音错误表：把 OpenPronounce 的音素输出重判成"对中国学习者有意义"的反馈。

## 为什么要自己重判

调研（pronunciation-alternatives-research.md）确认了一个反直觉的事实：

    OpenPronounce 单词级精确率只有 0.20，**根因不是模型差，是评分者的口径太宽松**。
    它的官方 benchmark 原文写着：母语评分者对 "ð→z、θ→s、ɪ→i、吞掉词尾辅音"
    这类**带口音但可听懂**的特征"几乎从不判错"。

    而这些特征**恰恰是中国学习者的高频错误**。

所以"找一个在 speechocean762 上精确率更高的方案"是在优化一个**错的靶子**——
越像人类评分者，对用户的痛点越不敏感。

正确做法：**保留 OpenPronounce 的音素级输出（errors[].phones[]），换掉判定规则。**
也就是本模块。

## 数据来源

每条规则都来自中国英语学习者发音研究的常见结论，不是拍脑袋：

    - 齿擦音 th：汉语无 /θ/ /ð/，常替换为 /s/ /z/ 或 /t/ /d/
    - 唇齿音 v：汉语无 /v/，常替换为 /w/
    - 边音 l 与近音 r：汉语只有一个 /l/ 类音，二者常混
    - 后鼻音 ng：汉语有 /ŋ/ 但**不能出现在词首**，且常与 /n/ 混
    - 松紧元音对立：汉语无 /i/–/ɪ/、/u/–/ʊ/ 的松紧对立
    - 梅花音 æ：汉语无此元音，常读成 /ɛ/ 或 /a/
    - 词尾辅音：汉语音节多为开音节，常吞掉或加元音（"desk"→"des-ku"）

## 用法

    from zh_errors import analyze
    report = analyze(differences)   # differences 来自 compare_audio_with_text()
"""

from __future__ import annotations

from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# 规则表
# ---------------------------------------------------------------------------

#: 替换类错误：(期望音, 实际听到的音) -> (严重度, 中文解释, 纠正要点)
SUBSTITUTIONS: dict[tuple[str, str], tuple[str, str, str]] = {
    # 齿擦音 th
    ("θ", "s"): ("high", "/θ/ 读成了 /s/", "舌尖轻触上齿，让气流从舌齿间摩擦出来，不要用汉语的 s"),
    ("θ", "f"): ("high", "/θ/ 读成了 /f/", "用舌尖而不是下唇；上齿轻咬舌尖"),
    ("θ", "t"): ("high", "/θ/ 读成了 /t/", "/θ/ 是持续的摩擦音，不是一触即走的爆破音"),
    ("θ", "d"): ("high", "/θ/ 读成了 /d/", "舌尖轻触上齿持续送气，不要读成爆破音 d"),
    ("θ", "z"): ("high", "/θ/ 读成了 /z/", "/θ/ 不振动声带；舌尖轻触上齿"),
    ("ð", "z"): ("high", "/ð/ 读成了 /z/", "舌尖轻触上齿并振动声带，不是汉语的 z"),
    ("ð", "d"): ("high", "/ð/ 读成了 /d/", "/ð/ 要持续送气摩擦，不能读成爆破音 d"),
    ("ð", "v"): ("high", "/ð/ 读成了 /v/", "用舌尖而非下唇"),
    ("ð", "t"): ("high", "/ð/ 读成了 /t/", "/ð/ 是浊摩擦音，要持续且振动声带"),
    # 唇齿音 v
    ("v", "w"): ("high", "/v/ 读成了 /w/", "上齿轻触下唇；/w/ 是双唇收圆，两者口型不同"),
    ("v", "f"): ("medium", "/v/ 读成了 /f/", "/v/ 要振动声带，/f/ 不振动"),
    # 边音 / 近音
    # 注意：模型的 IPA 输出是 ɹ（U+0279），不是 ASCII 的 r。
    # 第一版这里只写了 "r"，导致 l→ɹ 完全漏检（最小对立对实验实测抓到）。
    ("l", "ɹ"): ("high", "/l/ 读成了 /r/", "舌尖抵上齿龈；/r/ 舌尖悬空不碰上颚"),
    ("l", "r"): ("high", "/l/ 读成了 /r/", "舌尖抵上齿龈；/r/ 舌尖悬空不碰上颚"),
    ("l", "w"): ("high", "/l/ 读成了 /w/", "舌尖要抵上齿龈，不能只收圆双唇"),
    ("ɹ", "l"): ("high", "/r/ 读成了 /l/", "舌尖不要碰上颚，卷起但不接触"),
    ("l", "n"): ("medium", "/l/ 读成了 /n/", "气流从舌两侧出，不从鼻腔出"),
    # 鼻音
    ("ŋ", "n"): ("high", "/ŋ/ 读成了 /n/", "舌根抵软颚（如汉语'英'的尾音），不是舌尖的 n"),
    ("n", "ŋ"): ("medium", "/n/ 读成了 /ŋ/", "舌尖抵上齿龈，不要用舌根"),
    # 松紧元音
    ("i", "ɪ"): ("medium", "/iː/ 读得偏松", "嘴角向两侧拉开，舌位更高更前，时长更长"),
    ("ɪ", "i"): ("high", "/ɪ/ 读成了 /iː/", "/ɪ/ 更短更松，舌位略低略后，不要拉长"),
    ("u", "ʊ"): ("medium", "/uː/ 读得偏松", "双唇收圆前突，舌位更高，时长更长"),
    ("ʊ", "u"): ("high", "/ʊ/ 读成了 /uː/", "/ʊ/ 更短更松，嘴唇不要过度收圆"),
    ("æ", "ɛ"): ("high", "/æ/ 读成了 /e/", "嘴张更大、下巴放低，舌位更低更前（介于 a 与 e 之间）"),
    ("æ", "a"): ("medium", "/æ/ 读得偏后", "舌位更靠前，嘴角略向两侧"),
    ("ɛ", "æ"): ("low", "/e/ 读得偏开", "嘴张得略小一点"),
    ("ʌ", "a"): ("low", "/ʌ/ 读得偏后", "舌位居中偏后但更松短"),
    ("ə", "ʌ"): ("low", "弱读元音读得太重", "非重读音节要弱化、短促、放松"),
    # 其他常见
    ("ɹ", "w"): ("high", "/r/ 读成了 /w/", "舌尖卷起，不要只收圆双唇"),
    ("s", "ʃ"): ("low", "/s/ 读得偏 /ʃ/", "舌尖靠近齿龈，不要抬向硬颚"),
    ("z", "s"): ("medium", "/z/ 读成了 /s/", "/z/ 要振动声带"),
    ("v", "b"): ("medium", "/v/ 读成了 /b/", "上齿轻触下唇摩擦，不要双唇闭合爆破"),
    # 清浊混淆：汉语送气/不送气对立取代了清浊对立，学习者常把浊音读成清音
    ("b", "p"): ("medium", "/b/ 读成了 /p/", "/b/ 要振动声带；汉语的 b 其实是不送气清音，不等于英语的 /b/"),
    ("d", "t"): ("medium", "/d/ 读成了 /t/", "/d/ 要振动声带；注意汉语 d 与英语 /d/ 不同"),
    ("g", "k"): ("medium", "/g/ 读成了 /k/", "/g/ 要振动声带；注意汉语 g 与英语 /g/ 不同"),
    ("z", "ts"): ("medium", "/z/ 读成了 /ts/", "/z/ 是持续的浊摩擦音，不是塞擦音"),
    ("dʒ", "tʃ"): ("medium", "/dʒ/ 读成了 /tʃ/", "/dʒ/ 要振动声带"),
    ("ʒ", "ʃ"): ("medium", "/ʒ/ 读成了 /ʃ/", "/ʒ/ 要振动声带"),
    ("ð", "s"): ("high", "/ð/ 读成了 /s/", "舌尖轻触上齿并振动声带"),
    ("θ", "ɹ"): ("high", "/θ/ 读成了 /r/", "舌尖轻触上齿送气，不要卷舌"),
    ("t", "d"): ("low", "/t/ 读得偏浊", "词首 /t/ 要送气；不过词中 /t/ 在美音里常浊化，可接受"),
    ("k", "g"): ("low", "/k/ 读得偏浊", "词首 /k/ 要送气"),
    ("p", "b"): ("low", "/p/ 读得偏浊", "词首 /p/ 要送气"),
}

#: 词尾辅音相关：汉语音节多为开音节，学习者常吞尾音或加元音
FINAL_CONSONANTS = set("ptkbdgmnŋlfsvzʃʒθðɹtʃdʒ")

#: 常见"加元音"插入（desk -> des-ku）
EPENTHETIC_VOWELS = set("əɯuʊiɪo")

#: 严重度排序，用于输出排序
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


@dataclass
class PhoneIssue:
    """一个音素级问题。"""

    word: str
    position: int
    expected: str
    heard: str
    kind: str            # substitution | deletion | insertion | final_drop
    severity: str        # high | medium | low
    label: str           # 简短中文标签
    advice: str          # 纠正要点
    confidence: float = 0.0


@dataclass
class WordReport:
    """一个词的分析结果。"""

    word: str
    position: int
    expected: str
    heard: str
    issues: list[PhoneIssue] = field(default_factory=list)

    @property
    def worst(self) -> str:
        if not self.issues:
            return "low"
        return min((i.severity for i in self.issues), key=lambda s: SEVERITY_ORDER.get(s, 9))

    @property
    def has_real_issue(self) -> bool:
        """只把 high/medium 当作"值得纠正"，避免 low 级噪音。"""
        return any(i.severity in ("high", "medium") for i in self.issues)


def _classify(expected: str, heard: str) -> tuple[str, str, str, str]:
    """返回 (kind, severity, label, advice)。"""
    if heard == "" or heard is None:
        return ("deletion", "high", f"漏读了 /{expected}/", "这个词的音没有完整发出，注意不要吞音")
    if (expected, heard) in SUBSTITUTIONS:
        severity, label, advice = SUBSTITUTIONS[(expected, heard)]
        return ("substitution", severity, label, advice)
    return (
        "substitution",
        "low",
        f"/{expected}/ 读成了 /{heard}/",
        "这个音有偏差，但通常不影响理解",
    )


def _align(flat_expected: list[str], heard: list[str]) -> list[tuple[int, str, str]]:
    """把 heard 音素序列对齐到 expected 序列，返回 [(expected_index, exp, heard), ...]。

    为什么必须自己做对齐，而不是读 OpenPronounce 的 ``errors[]``：

        实测发现它会**漏报**。例如 espeak 合成的 "latent" 被听成 /l eɪ d ə n d/，
        期望 /l eɪ t ə n t/ —— 两处 t→d 是清浊对，它的近音成本只算 0.5，
        加总后达不到词级阈值（edits/length >= 0.4 或 edits >= 2），于是
        ``errors`` 返回**空列表**，而分数只有 56.67。

        也就是说：**它给低分，却不告诉你哪里错了。** 这正是要绕开的地方。
        音素级原始数据（expected_phones / heard_phones）始终是可靠的。

    ``heard`` 比 ``expected`` 短（漏读）或长（多读）都能处理。
    """
    import Levenshtein

    pairs: list[tuple[int, str, str]] = []
    for tag, i1, i2, j1, j2 in Levenshtein.opcodes(flat_expected, heard):
        if tag == "equal":
            continue  # 读对了，跳过
        if tag == "replace":
            # 逐位配对；长度不等时，多出的按插入/漏读处理
            for offset in range(max(i2 - i1, j2 - j1)):
                exp = flat_expected[i1 + offset] if i1 + offset < i2 else ""
                got = heard[j1 + offset] if j1 + offset < j2 else ""
                pairs.append((i1 + offset if exp else i1, exp, got))
        elif tag == "delete":
            # 期望有、听到没有 -> 漏读
            for index in range(i1, i2):
                pairs.append((index, flat_expected[index], ""))
        elif tag == "insert":
            # 听到多余的音 -> 多读；挂到前一个期望音上
            anchor = max(i1 - 1, 0)
            for index in range(j1, j2):
                pairs.append((anchor, "", heard[index]))
    return pairs


def analyze(differences: dict, text: str | None = None) -> list[WordReport]:
    """把 OpenPronounce 的输出转成中式视角的逐词报告。

    刻意**不读** ``differences["errors"]``（它会漏报近音替换，见 ``_align`` 的说明），
    而是直接用 ``expected_phones``（逐词分组）与 ``heard_phones``（扁平序列）
    自己做对齐。
    """
    import Levenshtein  # noqa: F401  (供 _align 使用，提前暴露依赖缺失)

    groups: list[list[str]] = differences.get("expected_phones") or []
    heard: list[str] = differences.get("heard_phones") or []
    confidences: list[float] = differences.get("heard_phones_confidence") or []

    if not groups or not heard:
        return []

    # 词名：优先用传入的 text，否则退回 expected 拼写
    words: list[str] = []
    if text:
        words = [w for w in str(text).split() if w]
    if len(words) != len(groups):
        words = ["".join(g) for g in groups]

    flat_expected = [p for group in groups for p in group]

    # 期望音素下标 -> 所属词下标
    owner: list[int] = []
    for word_index, group in enumerate(groups):
        owner.extend([word_index] * len(group))

    # 建立 听到音素下标 -> 置信度 的查询
    conf_by_index = dict(enumerate(confidences))

    # 用 opcodes 对齐，同时记录 heard 的下标以便取置信度
    import Levenshtein

    reports: dict[int, WordReport] = {}

    def ensure(word_index: int) -> WordReport:
        if word_index not in reports:
            reports[word_index] = WordReport(
                word=words[word_index] if word_index < len(words) else "",
                position=word_index,
                expected="".join(groups[word_index]),
                heard="",
            )
        return reports[word_index]

    for tag, i1, i2, j1, j2 in Levenshtein.opcodes(flat_expected, heard):
        if tag == "equal":
            continue
        if tag == "replace":
            for offset in range(max(i2 - i1, j2 - j1)):
                exp = flat_expected[i1 + offset] if i1 + offset < i2 else ""
                got = heard[j1 + offset] if j1 + offset < j2 else ""
                anchor = i1 + offset if exp else max(i1 - 1, 0)
                _add_issue(ensure(owner[anchor]), exp, got, conf_by_index.get(j1 + offset, 0.0))
        elif tag == "delete":
            for index in range(i1, i2):
                _add_issue(ensure(owner[index]), flat_expected[index], "", 1.0)
        elif tag == "insert":
            anchor = max(i1 - 1, 0)
            for index in range(j1, j2):
                _add_issue(ensure(owner[anchor]), "", heard[index], conf_by_index.get(index, 0.0))

    result = list(reports.values())
    for report in result:
        report.heard = "".join(
            heard[i] for i, o in enumerate(owner) if o == report.position and i < len(heard)
        )
    result.sort(key=lambda r: (SEVERITY_ORDER.get(r.worst, 9), r.position))
    return result


def _add_issue(report: WordReport, exp: str, got: str, confidence: float) -> None:
    """往报告里追加一个问题（带去重）。"""
    if exp == got:
        return
    # 同一个 (exp, got) 在一个词里只报一次
    if any(i.expected == exp and i.heard == got for i in report.issues):
        return

    kind, severity, label, advice = _classify(exp, got)

    if kind == "deletion" and exp in FINAL_CONSONANTS:
        kind = "final_drop"
        label = f"词尾 /{exp}/ 被吞掉了"
        advice = "汉语音节多是开音节，英语词尾辅音要发出来（但不要加元音）"

    if kind == "insertion" and got in EPENTHETIC_VOWELS:
        label = f"词尾多加了一个元音 /{got}/"
        advice = "词尾辅音后不要加元音，直接收住"

    report.issues.append(
        PhoneIssue(
            word=report.word,
            position=report.position,
            expected=exp,
            heard=got,
            kind=kind,
            severity=severity,
            label=label,
            advice=advice,
            confidence=confidence,
        )
    )


def summarize(reports: list[WordReport]) -> str:
    """生成中文可读摘要。"""
    if not reports:
        return "没有发现需要纠正的音。"

    lines: list[str] = []
    real = [r for r in reports if r.has_real_issue]
    lines.append(f"发现 {len(real)} 个值得纠正的音（共 {len(reports)} 个词有偏差）\n")

    for report in reports:
        mark = "●" if report.has_real_issue else "○"
        lines.append(f"{mark} {report.word}  /{report.expected}/ → 听到 /{report.heard}/")
        for issue in report.issues:
            lines.append(f"    · {issue.label}")
            lines.append(f"      {issue.advice}")
        lines.append("")

    return "\n".join(lines)
