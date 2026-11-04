"""P5a 自测：拿真实音频跑 OpenPronounce，再用中式错误表重判。

这一步的目的是回答一个具体问题：

    **音素级反馈对我到底有没有用？**

如果答案是有用，才值得投入 P5b（sidecar 集成 + formant + 口型动画）。
所以本脚本刻意**不集成任何插件代码**，只输出人类可读的诊断。

用法：
    . lab\\env.ps1
    lab\\.venv\\Scripts\\python.exe lab\\scripts\\analyze.py                     # 跑 samples/ 下全部 wav
    lab\\.venv\\Scripts\\python.exe lab\\scripts\\analyze.py path\\to\\rec.wav   # 跑指定文件
    lab\\.venv\\Scripts\\python.exe lab\\scripts\\analyze.py rec.wav "hello"     # 指定音频与期望文本
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LAB / "scripts"))

from zh_errors import analyze, summarize  # noqa: E402

SAMPLES = LAB / "samples"
RESULTS = LAB / "results"


def load_audio(path: Path):
    from openpronounce import audio

    return audio.load(str(path))


def run_one(path: Path, expected: str | None, show_json: bool = False) -> dict | None:
    from openpronounce import speech

    if expected is None:
        expected = path.stem.replace("_", " ").replace("-", " ")

    sound = load_audio(path)
    started = time.time()
    result = speech.compare_audio_with_text(sound, expected)
    elapsed = time.time() - started

    print(f"\n{'=' * 68}")
    print(f"文件      : {path.name}")
    print(f"期望文本  : {expected}")
    print(f"耗时      : {elapsed:.1f}s")
    print(f"{'-' * 68}")

    # 原始输出
    print(f"[OpenPronounce 原始判定]")
    print(f"  转写      : {result.get('transcribe', '')}")
    print(f"  分数      : {result.get('score')}")
    diffs = result.get("differences", {})
    print(f"  音素错误率: {diffs.get('phoneme_error_rate')}")
    print(f"  词错误率  : {diffs.get('word_error_rate')}")
    print(f"  它标记的错词: {diffs.get('words_with_errors') or '(无)'}")

    # 我们自己的重判（必须传 expected 才能正确切词；不读它的 errors，因为会漏报）
    reports = analyze(diffs, expected)
    print(f"\n[中式错误表重判]")
    print(summarize(reports) or "  （无）")

    # 音素级原始数据（P5b 要消费的就是这个）
    print(f"[音素级原始数据]")
    print(f"  期望音素: {diffs.get('expected_phones')}")
    print(f"  听到音素: {diffs.get('heard_phones')}")
    print(f"  置信度  : {diffs.get('heard_phones_confidence')}")
    for err in diffs.get("errors", []) or []:
        phones = err.get("phones", []) or []
        detail = "  ".join(
            f"{p.get('expected')}→{p.get('heard') or '(漏)'}({p.get('confidence', 0):.2f})"
            for p in phones
        )
        print(f"  {err.get('word'):<16} /{err.get('expected')}/ → /{err.get('actual')}/")
        if detail:
            print(f"      {detail}")

    if show_json:
        out = RESULTS / f"{path.stem}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n  完整 JSON 已存: {out}")

    return result


def main() -> int:
    args = sys.argv[1:]

    if args and Path(args[0]).exists():
        target = Path(args[0])
        expected = args[1] if len(args) > 1 else None
        run_one(target, expected, show_json=True)
        return 0

    wavs = sorted(SAMPLES.glob("*.wav"))
    if not wavs:
        print(f"samples/ 下没有 wav。先跑 make_samples.py 生成，或直接传入音频路径。")
        print(f"目录: {SAMPLES}")
        return 1

    print(f"共 {len(wavs)} 个样本，逐个分析（首次会加载模型，较慢）…")
    ok = 0
    for wav in wavs:
        try:
            run_one(wav, None, show_json=True)
            ok += 1
        except Exception as exc:  # noqa: BLE001
            print(f"\n{wav.name} 失败: {type(exc).__name__}: {exc}")

    print(f"\n{'=' * 68}")
    print(f"完成 {ok}/{len(wavs)}，结果 JSON 在 {RESULTS}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
