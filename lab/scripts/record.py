"""录一段自己的发音，存成 OpenPronounce 能吃的 16kHz 单声道 wav。

为什么必须用真人录音：
    ``make_samples.py`` 用的是 espeak-ng 合成音，只能证明**链路通**，
    不能证明**对真人有判断力**。合成音本身就很标准，跑出来分数虚高
    （实测 developer/measure/resolution 都是 100 分），没有参考价值。

用法：
    . lab\\env.ps1
    lab\\.venv\\Scripts\\python.exe lab\\scripts\\record.py hello
    lab\\.venv\\Scripts\\python.exe lab\\scripts\\record.py "hello world" --seconds 4
    lab\\.venv\\Scripts\\python.exe lab\\scripts\\record.py hello --list    # 只列设备
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent
RECORDINGS = LAB / "recordings"
TARGET_SR = 16000


def list_devices() -> None:
    import sounddevice as sd

    print("输入设备：")
    for index, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            mark = " <- 默认" if index == sd.default.device[0] else ""
            print(
                f"  [{index}] {dev['name'][:54]:<56} "
                f"{dev['max_input_channels']}ch {dev['default_samplerate']:.0f}Hz{mark}"
            )


def record(seconds: float, device: int | None, samplerate: int) -> "object":
    import numpy as np
    import sounddevice as sd

    print(f"录音 {seconds:.0f} 秒…（现在开始读）")
    for countdown in (3, 2, 1):
        print(f"  {countdown}…", end="", flush=True)
        time.sleep(1)
    print("  ● 开始")

    frames = sd.rec(
        int(seconds * samplerate),
        samplerate=samplerate,
        channels=1,
        dtype="float32",
        device=device,
    )
    # 实时进度，避免用户以为卡住
    for step in range(10):
        time.sleep(seconds / 10)
        level = float(np.abs(frames).max())
        bar = "█" * int(min(level * 40, 40))
        print(f"\r  {bar:<40} {level:.3f}", end="", flush=True)
    sd.wait()
    print("\n  ■ 结束")
    return frames


def main() -> int:
    parser = argparse.ArgumentParser(description="录一段自己的发音")
    parser.add_argument("text", nargs="?", help="要读的文本（用于命名与后续对比）")
    parser.add_argument("--seconds", type=float, default=3.0, help="录音秒数（默认 3）")
    parser.add_argument("--device", type=int, default=None, help="输入设备编号")
    parser.add_argument("--samplerate", type=int, default=48000, help="采样率（默认 48000）")
    parser.add_argument("--list", action="store_true", help="只列出设备")
    args = parser.parse_args()

    if args.list:
        list_devices()
        return 0

    if not args.text:
        print("需要给出要读的文本，例如：record.py hello")
        return 2

    import numpy as np
    import soundfile as sf

    audio = record(args.seconds, args.device, args.samplerate)

    # 重采样到 16kHz（OpenPronounce 期望的输入）
    data = np.asarray(audio).reshape(-1)
    if args.samplerate != TARGET_SR:
        import librosa

        data = librosa.resample(data, orig_sr=args.samplerate, target_sr=TARGET_SR)

    # 去掉首尾静音，避免把等待时间也算进去
    peak = float(np.abs(data).max()) if data.size else 0.0
    if peak > 0:
        threshold = peak * 0.05
        loud = np.flatnonzero(np.abs(data) > threshold)
        if loud.size:
            pad = int(0.15 * TARGET_SR)
            start = max(int(loud[0]) - pad, 0)
            end = min(int(loud[-1]) + pad, data.size)
            data = data[start:end]

    RECORDINGS.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in args.text)[:40]
    out = RECORDINGS / f"{safe}.wav"
    sf.write(out, data, TARGET_SR, subtype="PCM_16")

    duration = data.size / TARGET_SR
    print(f"\n已保存: {out}")
    print(f"  时长 {duration:.2f}s  峰值 {peak:.3f}  采样率 {TARGET_SR}Hz")
    if peak < 0.02:
        print("  ⚠ 音量很低，可能没录到。检查麦克风是否被占用/静音。")
    print(f"\n下一步：")
    print(f'  lab\\.venv\\Scripts\\python.exe lab\\scripts\\analyze.py "{out}" "{args.text}"')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
