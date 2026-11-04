# dsh-word-learn 实验环境变量（全部指向 D 盘）
# 用法：. 'D:\projects\blog\dsh-plugins\dsh-word-learn\lab\env.ps1'
#
# 为什么需要这个文件：
#   DSH 宿主进程的环境块是启动时快照的，用户级 SetEnvironmentVariable 写的值
#   不会出现在新子进程里。所以每次都必须在本进程内联设置，不能依赖持久化变量。

$env:UV_CACHE_DIR          = 'D:\dsh-cache\uv'
$env:UV_PYTHON_INSTALL_DIR = 'D:\dsh-cache\uv\python'
$env:UV_LINK_MODE          = 'copy'   # 跨盘符无法硬链接，显式用 copy 消除警告
$env:PIP_CACHE_DIR         = 'D:\dsh-cache\pip'
$env:HF_HOME               = 'D:\dsh-cache\huggingface'
$env:HF_HUB_CACHE          = 'D:\dsh-cache\huggingface\hub'
$env:TORCH_HOME            = 'D:\dsh-cache\torch'
$env:XDG_CACHE_HOME        = 'D:\dsh-cache'
$env:TMP                   = 'D:\dsh-cache\tmp'
$env:TEMP                  = 'D:\dsh-cache\tmp'

# 便携式二进制 ffmpeg 优先。动态解析，避免版本号变化导致路径失效。
$ffBin = Get-ChildItem 'D:\dsh-cache\tools\ffmpeg' -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue |
         Select-Object -First 1 -ExpandProperty DirectoryName
if ($ffBin -and (Test-Path $ffBin)) { $env:PATH = "$ffBin;$env:PATH" }

# espeak-ng 直接用 venv 内 espeakng-loader 自带的副本（不需要系统安装）。
# 注意：MSI 管理安装会因"系统已注册过 eSpeak NG 1.51.0"而返回 1603，
# 所以不要走 MSI，用 pip 包最干净，且天然落在 D 盘 venv 内。
$espeakPkg = "$PSScriptRoot\.venv\Lib\site-packages\espeakng_loader"
if (Test-Path $espeakPkg) {
    $env:PATH = "$espeakPkg;$env:PATH"
    $dll = Join-Path $espeakPkg 'espeak-ng.dll'
    $dat = Join-Path $espeakPkg 'espeak-ng-data'
    if (Test-Path $dll) { $env:PHONEMIZER_ESPEAK_LIBRARY = $dll }
    if (Test-Path $dat) { $env:PHONEMIZER_ESPEAK_PATH = $dat }
}

# 关掉 tokenizers 的并行告警，避免 Windows 上的 fork 警告
$env:TOKENIZERS_PARALLELISM = 'false'
