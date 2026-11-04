"""用「最小对立对」验证错误表的检出灵敏度。

## 为什么不用 espeak 的音素输入模式

第一版设计是 `[[sINk]]` 这样直接喂音素。**实测证明这条路走不通**：
espeak 的音素输入模式绕过了全部同化/协同发音处理，合成出的音频本身是坏的。

实测对照（同一批词，两条合成路径）：

    | 词    | 普通 TTS 路径      | 音素输入路径      |
    |-------|-------------------|------------------|
    | think | θɛŋk   score=90   | tɪŋk   score=48  |
    | light | laɪt   score=100  | laɪ    score=36  |
    | sing  | sɪŋ    score=100  | sɪn    score=52  |
    | very  | vɛɹi   score=100  | vɛɹi   score=70  |

音素路径把标准发音都读坏了（`light` 连词尾 t 都丢了），
所以它制造的"错误"里混着大量合成伪影，**漏检不能归因于错误表**。

## 现在的做法：最小对立对

用**普通 TTS**（音频干净）合成一个**真实存在的错词**，
但告诉检测器期望的是**目标词**：

    期望 "think"，实际合成 "sink"  ->  应该检出 θ→s
    期望 "light"，实际合成 "right" ->  应该检出 l→ɹ

音频质量有保证，错误又确定已知，才是有效的对照实验。

用法：
    . lab\\env.ps1
    lab\\.venv\\Scripts\\python.exe lab\\scripts\\validate_detector.py
"""

from __future__ import annotations

import sys
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LAB / "scripts"))

from zh_errors import analyze  # noqa: E402

# (目标词, 实际合成的错词, 说明, 期望检出的 (期望音, 听到音) 集合)
# 最后一栏为空集表示对照组：应查不出 high/medium
CASES: list[tuple[str, str, str, set[tuple[str, str]]]] = [
    # ---------- 对照组：读的就是目标词 ----------
    ("think", "think", "标准发音（对照）", set()),
    ("very", "very", "标准发音（对照）", set()),
    ("light", "light", "标准发音（对照）", set()),
    ("sing", "sing", "标准发音（对照）", set()),
    ("bad", "bad", "标准发音（对照）", set()),
    # ---------- θ ----------
    ("think", "sink", "θ→s（think 读成 sink）", {("θ", "s")}),
    ("thin", "fin", "θ→f（thin 读成 fin）", {("θ", "f")}),
    ("thin", "tin", "θ→t（thin 读成 tin）", {("θ", "t")}),
    # ---------- ð ----------
    ("they", "day", "ð→d（they 读成 day）", {("ð", "d")}),
    # ---------- v ----------
    ("vest", "west", "v→w（vest 读成 west）", {("v", "w")}),
    ("very", "wery", "v→w（very 读成 wery）", {("v", "w")}),
    # ---------- l / r ----------
    ("light", "right", "l→ɹ（light 读成 right）", {("l", "ɹ")}),
    ("play", "pray", "l→ɹ（play 读成 pray）", {("l", "ɹ")}),
    # ---------- ŋ ----------
    ("sing", "sin", "ŋ→n（sing 读成 sin）", {("ŋ", "n")}),
    ("thing", "thin", "ŋ→n（thing 读成 thin）", {("ŋ", "n")}),
    # ---------- 松紧元音 ----------
    ("sheep", "ship", "i→ɪ（sheep 读成 ship）", {("i", "ɪ")}),
    ("seat", "sit", "i→ɪ（seat 读成 sit）", {("i", "ɪ")}),
    ("pull", "pool", "ʊ→u（pull 读成 pool）", {("ʊ", "u")}),
    # ---------- æ ----------
    ("bad", "bed", "æ→ɛ（bad 读成 bed）", {("æ", "ɛ")}),
    # ---------- 词尾辅音 ----------
    ("cold", "coal", "词尾 d 脱落（cold 读成 coal）", {("d", "")}),
    ("desk", "des", "词尾 k 脱落（desk 读成 des）", {("k", "")}),
]


def load_wav(path: str):
    import librosa
    import numpy as np
    import soundfile as sf

    data, rate = sf.read(str(path), dtype="float32")
    data = np.asarray(data).reshape(-1)
    if rate != 16000:
        data = librosa.resample(data, orig_sr=rate, target_sr=16000)
    return data


def main() -> int:
    from openpronounce import audio, speech

    print("最小对立对实验：合成错词，声明期望为目标词，看能否检出。")
    print("（普通 TTS 路径，音频干净；错误确定已知）\n")
    print(f"{'目标词':<9}{'合成':<9}{'说明':<26}{'实际听到':<22}{'检出':<22}{'结果'}")
    print("-" * 116)

    hits = misses = false_alarms = errors = 0
    misses_detail: list[str] = []
    false_detail: list[str] = []

    for target, spoken, note, expected in CASES:
        try:
            path = audio.text2speech(spoken, lang="en")
            data = load_wav(path)
        except Exception as exc:  # noqa: BLE001
            errors += 1
            print(f"{target:<9}{spoken:<9}{note:<26}合成失败 {type(exc).__name__}")
            continue

        try:
            result = speech.compare_audio_with_text(data, target)
        except Exception as exc:  # noqa: BLE001
            errors += 1
            print(f"{target:<9}{spoken:<9}{note:<26}分析失败 {type(exc).__name__}")
            continue

        diffs = result.get("differences", {})
        heard = "".join(diffs.get("heard_phones") or [])
        reports = analyze(diffs, target)
        real = [i for r in reports for i in r.issues if i.severity in ("high", "medium")]
        detected = "  ".join(f"{i.expected or '(无)'}→{i.heard or '(漏)'}" for i in real) or "—"

        if not expected:
            if real:
                verdict = "✗ 误报"
                false_alarms += 1
                false_detail.append(f"{target}: 报了 {detected}")
            else:
                verdict = "✓ 正确未报"
        else:
            found = any(
                ((i.expected, i.heard) in expected)
                or ((i.expected, "") in expected and not i.heard)
                for i in real
            )
            if found:
                verdict = "✓ 命中"
                hits += 1
            else:
                verdict = "✗ 漏检"
                misses += 1
                misses_detail.append(f"{target}(合成{spoken}): 期望{sorted(expected)} 实得 {detected}")

        print(f"{target:<9}{spoken:<9}{note:<26}{heard[:20]:<22}{detected[:21]:<22}{verdict}")

    total = hits + misses
    line = f"实验组命中 {hits}/{total}"
    if total:
        line += f"（{hits * 100 / total:.0f}%）"
    print("-" * 116)
    print(f"{line}   对照组误报 {false_alarms}   失败 {errors}")

    if misses_detail:
        print("\n漏检明细：")
        for item in misses_detail:
            print(f"  - {item}")
    if false_detail:
        print("\n误报明细：")
        for item in false_detail:
            print(f"  - {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
