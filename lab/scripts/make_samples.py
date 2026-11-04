"""用 espeak-ng 生成测试音频（合成音，用于验证链路；不是真人发音）。

为什么先用合成音：
    端到端链路（音频解码 -> Wav2Vec2 -> 音素对齐 -> 评分）要先证明能跑通，
    而这一步不依赖"我读得好不好"。合成音的音素是已知的，所以它是很好的
    冒烟测试：如果链路正确，合成音应该拿到高分。

    真正评估"中式发音会被怎么判"，需要真人录音，那是下一步。

用法：
    . lab\\env.ps1
    lab\\.venv\\Scripts\\python.exe lab\\scripts\\make_samples.py
"""

import subprocess
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent
SAMPLES = LAB / "samples"
SAMPLES.mkdir(parents=True, exist_ok=True)

# 覆盖用户的高频难点：th、r/l、ɪ/i、æ/ɛ、词尾辅音
WORDS = [
    "hello",
    "developer",
    "resolution",
    "thought",
    "throughput",
    "latent",
    "rhythm",
    "measure",
]


def synthesize(word: str, out: Path) -> bool:
    """用 espeak-ng 生成 wav。返回是否成功。"""
    cmd = [
        sys.executable,
        "-c",
        (
            "import espeakng_loader, ctypes, sys;"
            "lib=ctypes.CDLL(espeakng_loader.get_library_path());"
            "lib.espeak_Initialize(0x02, 0, espeakng_loader.get_data_path().encode(), 0);"
            "lib.espeak_SetVoiceByName(b'en-us');"
            f"lib.espeak_Synth({word!r}.encode(), 0, 0, 0, 0, 0, None, None);"
        ),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=60)
        return True
    except Exception:
        return False


def main() -> int:
    print("说明：本脚本用 espeak-ng 合成音做链路冒烟测试，不是真人发音。\n")

    # 用 openpronounce 自带的 TTS（更简单，且它已经处理好格式）
    from openpronounce import audio

    ok = 0
    for word in WORDS:
        out = SAMPLES / f"{word}.wav"
        try:
            path = audio.text2speech(word, lang="en")
            data = Path(path).read_bytes()
            out.write_bytes(data)
            print(f"  {word:<14} -> {out.name}  ({len(data) / 1024:.0f} KB)")
            ok += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  {word:<14} -> 失败: {type(exc).__name__}: {exc}")

    print(f"\n生成 {ok}/{len(WORDS)} 个样本，目录：{SAMPLES}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
