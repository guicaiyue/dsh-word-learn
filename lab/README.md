# P5a 实验环境（OpenPronounce 自测）

这个目录是为 **P5a** 建的：**不集成插件，先独立跑通发音评测**，回答一个问题——

> 音素级反馈对我到底有没有用？

有用才值得做 P5b（sidecar 集成 + formant 元音模块 + 口型动画）。

---

## 目录

```
lab/
├── env.ps1                    # 环境变量（必须每次先 dot-source，见下）
├── .venv/                     # Python 3.12 虚拟环境（D 盘）
├── scripts/
│   ├── check_phonemizer.py    # 只验 espeak-ng + phonemizer
│   ├── check_openpronounce_import.py  # 验整条依赖链
│   ├── make_samples.py        # 生成测试音频
│   ├── analyze.py             # ★ 主脚本：分析音频并给出中式视角反馈
│   └── zh_errors.py           # ★ 中式英语错误表（P5b 要复用的核心）
├── samples/                   # 测试音频
└── results/                   # 分析结果 JSON
```

模型与缓存**全部在 D 盘**：

| 用途 | 路径 |
|---|---|
| HF 模型（2.4GB） | `D:\dsh-cache\huggingface` |
| uv / pip 缓存 | `D:\dsh-cache\uv`、`D:\dsh-cache\pip` |
| 临时目录 | `D:\dsh-cache\tmp` |
| ffmpeg | `D:\dsh-cache\tools\ffmpeg\...` |

---

## 用法

```powershell
# 1) 每次开新 shell 必须先加载环境（原因见下）
. 'D:\projects\blog\dsh-plugins\dsh-word-learn\lab\env.ps1'

# 2) 验证链路
lab\.venv\Scripts\python.exe lab\scripts\check_openpronounce_import.py

# 3) 生成测试音频
lab\.venv\Scripts\python.exe lab\scripts\make_samples.py

# 4) 分析
lab\.venv\Scripts\python.exe lab\scripts\analyze.py                  # 全部样本
lab\.venv\Scripts\python.exe lab\scripts\analyze.py 我的录音.wav      # 指定文件
lab\.venv\Scripts\python.exe lab\scripts\analyze.py 我的录音.wav "hello world"
```

---

## 踩过的坑（都是实测，不是推测）

### 1. C 盘只剩 8GB，所有缓存必须显式改到 D 盘

`SetEnvironmentVariable(..., 'User')` 写的用户级变量，**新起的子进程读不到**——
因为 DSH 宿主进程的环境块是启动时快照的。实测：设了 `UV_CACHE_DIR` 后，
`uv` 仍往 `C:\Users\...\AppData\Local\uv\cache` 写了 **1.1GB**。

**所以必须每个进程内联设置**，不能依赖持久化变量。这就是 `env.ps1` 存在的唯一原因。

清理误落的缓存：`uv cache clean`（实测清掉 1.1GB）。

### 2. espeak-ng 的 MSI 装不了（1603）

官方 Windows 分发只有 `.msi`。实测两种方式都失败：

- 直接装 → 默认落 C 盘，不行
- `msiexec /a` 管理安装解包到 D 盘 → **返回 1603**

日志显示原因是**系统里已注册过 "eSpeak NG 1.51.0"**，MSI 拒绝再装。
（`C:\Program Files\eSpeak NG` 目录其实不存在，只剩注册表残留。）

**解法：改用 pip 的 `espeakng-loader`**（自带 DLL + 数据，天然落在 D 盘 venv 内）。

### 3. espeakng-loader 不会自动接管 phonemizer，且失败是**静默的**

装了 `espeakng-loader` 后，phonemizer 仍然去找系统 espeak-ng。
更坑的是：**OpenPronounce 不报错，而是返回空音素列表**：

```python
speech.get_phonemes_with_word_mapping("hello developer", "en")
# -> ([], [])      # 不抛异常，排查成本很高
```

**解法**：`site-packages/dsh_espeak_bootstrap.py` + `_dsh_espeak_bootstrap.pth`，
在解释器启动时自动调用 `EspeakWrapper.set_library/set_data_path`。
这样 CLI、uvicorn、子进程都不需要额外设置。

### 4. huggingface_hub 1.16.1 走 Xet 路径会**停滞**

实测现象：进程活着、连接建立，但**字节零增长**（卡在 767MB / 1180MB）。

诊断过程：
- 直连 `huggingface.co`：大文件 302 到 `us.aws.cdn.hf.co`（Xet CDN）
- `hf-mirror.com`：大文件 **308 重定向回 huggingface.co**（镜像不代理 LFS，等于没加速）
- 用 Range 直拉 CDN：**9.2 MB/s**（缓存命中时）；持续拉约 0.4-0.6 MB/s
- 8 线程并行：0.43 MB/s，**无增益**（瓶颈是总带宽，不是连接数）

**解法：用 `curl -C -` 直接续传。** 它跟随 302 到 CDN，不碰 Xet 逻辑。

### 5. HF 缓存布局必须照抄，否则 transformers 认不出来

```
hub/models--<owner>--<repo>/
├── refs/main                 # 内容 = commit sha
├── blobs/
│   ├── <sha256-of-resolve-url>          # 大文件（注意：不是原文件名）
│   └── <原文件名>                        # 小文件（config.json 等）
└── snapshots/<commit>/
    └── <原文件名>                        # 硬链接指向 blobs
```

**blob 名是 `sha256(resolve URL)`，不是原文件名，也不是 LFS 内容哈希**——
实测验证过：`sha256("https://huggingface.co/facebook/wav2vec2-large-960h/resolve/main/pytorch_model.bin")`
= `09b8f01e...`，而实际文件名是 `7aef9939...`（后者是 LFS oid）。

**未下完的文件名带 `.incomplete` 后缀，下完必须去掉**，否则 transformers 当它不存在。

验证方法：设 `HF_HUB_OFFLINE=1` 后 `from_pretrained` 能加载，就说明缓存结构正确。

---

## 关键结论（写进设计文档的）

**不要追"更高精确率"的方案，要换掉判定规则。**

OpenPronounce 单词级精确率只有 0.20，**根因不是模型差，是评分者口径太宽松**。
它官方 benchmark 原文承认：母语评分者对 `ð→z、θ→s、ɪ→i、吞词尾辅音`
这类"带口音但可听懂"的特征**几乎从不判错**——而这正是中国学习者的高频错误。

所以本目录的 `zh_errors.py` 才是重点：**消费 `errors[].phones[]`（音素级），
忽略它的词级 flag**，用中式错误表重判。零新增依赖。

**还要注意**：它自带的嘴型图（`HunanBeanCMU39`，41 张）**许可不明**——
出自 `morevnaproject-org/papagayo-ng`，该仓库**无 LICENSE，只有 `gpl.txt`（GPLv2）**。
替代方案：**Wikimedia CC0 剖面图（43 个）+ Rhubarb MIT 口型图（9 个）**。
