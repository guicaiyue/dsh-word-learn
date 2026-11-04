"""端到端检查：OpenPronounce 的依赖链是否可用（在 D 盘 venv 内运行）。

用法：
    . lab\\env.ps1
    lab\\.venv\\Scripts\\python.exe lab\\scripts\\check_openpronounce_import.py

检查项：
    1. phonemizer 是否已指向 venv 内的 espeak-ng
    2. 直接音素化（对照）
    3. openpronounce 能否导入
    4. 音素化 + 词映射是否有结果（不接管 espeak-ng 时会**静默返回空**）
    5. ffmpeg 是否可见
"""

import shutil
import sys

failures = []

print("=== 1) phonemizer 的 espeak-ng 配置 ===")
try:
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    lib = getattr(EspeakWrapper, "_library", None) or getattr(EspeakWrapper, "library", None)
    data = getattr(EspeakWrapper, "_data_path", None) or getattr(EspeakWrapper, "data_path", None)
    print(f"library  : {lib}")
    print(f"data_path: {data}")
    if not lib or not data:
        failures.append("phonemizer 未指向 venv 内的 espeak-ng")
except Exception as exc:  # noqa: BLE001
    failures.append(f"读取 EspeakWrapper 失败: {type(exc).__name__}: {exc}")

print("\n=== 2) 直接音素化（对照） ===")
try:
    from phonemizer import phonemize

    for word in ("hello", "developer", "thought"):
        print(f"  {word:<12} -> {phonemize(word, language='en-us')}")
except Exception as exc:  # noqa: BLE001
    failures.append(f"phonemize 失败: {type(exc).__name__}: {exc}")

print("\n=== 3) OpenPronounce 导入 ===")
speech = None
try:
    from openpronounce import speech

    print("  import OK")
except Exception as exc:  # noqa: BLE001
    failures.append(f"openpronounce 导入失败: {type(exc).__name__}: {exc}")

print("\n=== 4) OpenPronounce 音素化 + 词映射 ===")
if speech is not None:
    try:
        phonemes, words = speech.get_phonemes_with_word_mapping("hello developer", "en")
        print(f"  phonemes: {phonemes}")
        print(f"  words   : {list(words.values())}")
        if not phonemes:
            failures.append("音素列表为空 —— espeak-ng 未真正生效（静默失败）")
    except Exception as exc:  # noqa: BLE001
        failures.append(f"get_phonemes_with_word_mapping 失败: {type(exc).__name__}: {exc}")

print("\n=== 5) ffmpeg ===")
ffmpeg = shutil.which("ffmpeg")
print(f"  {ffmpeg or '(不在 PATH)'}")
if not ffmpeg:
    failures.append("ffmpeg 不在 PATH")

print("\n" + "=" * 50)
if failures:
    print("失败项：")
    for item in failures:
        print(f"  - {item}")
    sys.exit(1)
print("全部通过")
