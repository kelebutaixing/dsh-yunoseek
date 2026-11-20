# 把 yuno 的嗓子（GPT-SoVITS）拉起来。已经有一个引擎在跑就直接退出。
# 由同目录的 start-engine-hidden.vbs 以隐藏窗口调用；也可以手动跑：
#   powershell -NoProfile -ExecutionPolicy Bypass -File start-engine.ps1
#
# 参数全部来自 %USERPROFILE%\.dsh\yuno-tts\config.json（DSH_HOME 改动时用 $env:DSH_HOME）。
# 引擎脚本 / prompts 跟着本文件走（..\server\），所以插件装在哪儿都行。
$ErrorActionPreference = 'SilentlyContinue'

$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$stateDir = Join-Path $home_ 'yuno-tts'
$cfgPath = Join-Path $stateDir 'config.json'
if (-not (Test-Path $cfgPath)) { exit 0 }

$cfg = Get-Content $cfgPath -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $cfg -or -not $cfg.engineRoot) { exit 0 }

$port = if ($cfg.port) { [int]$cfg.port } else { 9801 }
$python = if ($cfg.pythonPath) { $cfg.pythonPath } else { Join-Path $cfg.engineRoot 'runtime\python.exe' }
if (-not (Test-Path $python)) { exit 0 }

$pkgRoot = Split-Path $PSScriptRoot -Parent
$server = Join-Path $pkgRoot 'server\yuno_tts_server_gsv.py'
$prompts = Join-Path $pkgRoot 'server\gsv_voices.json'
if (-not (Test-Path $server)) { exit 0 }

# 已经有一个引擎在跑（DSH 自己拉起来的，或者上一次没退干净）就不再起第二个
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
  if ($h -and $h.ready) { exit 0 }
} catch { }

$logDir = Join-Path $stateDir 'boot'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$cache = Join-Path $stateDir 'engine-cache'

$engArgs = @(
  '-u', $server,
  '--port', "$port",
  '--root', $cfg.engineRoot,
  '--voice-dir', $cfg.voiceDir,
  '--prompts', $prompts,
  '--gpt-weights', $cfg.gptWeights,
  '--sovits-weights', $cfg.sovitsWeights,
  '--cache-dir', $cache
)
if ($cfg.voice) { $engArgs += @('--voice', $cfg.voice) }

$out = Join-Path $logDir 'engine.out.log'
$err = Join-Path $logDir 'engine.err.log'

# 用 WMI 起进程：由 WmiPrvSE 创建，不落在调用方的 Job Object 里。
# Start-Process 不行 —— Electron 的 job 会把子进程树整个收走，DSH 一退引擎就跟着死。
# 参数和重定向写进一个 .cmd 文件再交给 cmd.exe 跑，免得命令行引号嵌套出岔子。
$cmdFile = Join-Path $logDir 'launch-engine.cmd'
$quoted = @($engArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
$lines = @(
  '@echo off',
  ('"' + $python + '" ' + ($quoted -join ' ') + ' > "' + $out + '" 2> "' + $err + '"')
)
Set-Content -Path $cmdFile -Value $lines -Encoding Default

$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$res = ([wmiclass]'Win32_Process').Create('cmd.exe /c "' + $cmdFile + '"', $cfg.engineRoot, $startup)

"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 启动引擎 port=$port wmi=$($res.ReturnValue) pid=$($res.ProcessId)" |
  Out-File -Append -Encoding utf8 (Join-Path $logDir 'boot.log')