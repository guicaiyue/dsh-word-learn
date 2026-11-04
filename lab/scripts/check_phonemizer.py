"""验证 espeak-ng 与 phonemizer 链路（在 D 盘 venv 内运行）。

用法：
    D:\\projects\\blog\\dsh-plugins\\dsh-word-learn\\lab\\.venv\\Scripts\\python.exe check_phonemizer.py
"""

import espeakng_loader
from phonemizer.backend.espeak.wrapper import EspeakWrapper

# 让 phonemizer 用 venv 里自带的 espeak-ng（而不是系统安装）
EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())

from phonemizer import phonemize  # noqa: E402

WORDS = ["hello", "developer", "resolution", "thought", "latent", "throughput"]

print(f"{'word':<14} -> phonemes")
print("-" * 50)
for word in WORDS:
    try:
        phones = phonemize(word, language="en-us")
        print(f"{word:<14} -> {phones}")
    except Exception as exc:  # noqa: BLE001
        print(f"{word:<14} -> 失败: {type(exc).__name__}: {exc}")
