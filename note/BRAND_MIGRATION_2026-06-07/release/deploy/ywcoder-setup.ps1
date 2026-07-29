#requires -Version 5.1
<#
  YWCODER 内网部署脚本（Windows PowerShell 5.1）
  作用：离线安装/更新 + 写配置(~/.ywcoder/settings.json) + 自动迁移旧环境变量 + 冒烟自检。
  用法：
    powershell -ExecutionPolicy Bypass -File .\ywcoder-setup.ps1
    powershell -ExecutionPolicy Bypass -File .\ywcoder-setup.ps1 -Reconfigure   # 重新输入 key/网关
  配置：改下方"可配置项"，或用环境变量覆盖：
    $env:YW_PKG_FILE / $env:YW_API_KEY / $env:YW_BASE_URL / $env:YW_MODEL
#>
param([switch]$Reconfigure)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ===================== 可配置项（部署前改这里）=====================
# 离线安装包：管理员每次把下载好的 .tgz 文件名填这里（更新版本就改这一行）
$PkgFile      = if ($env:YW_PKG_FILE) { $env:YW_PKG_FILE } else { '.\dcywzc-ywcoder-1.2.1.tgz' }
$PrefillKey   = $env:YW_API_KEY        # 共享 key 可预填；留空=问用户
$PrefillUrl   = $env:YW_BASE_URL       # 网关地址；留空=问用户
$DefaultModel = if ($env:YW_MODEL) { $env:YW_MODEL } else { 'Qwen3.5-27B' }
# =================================================================

function Info($m){ Write-Host $m -ForegroundColor Green }
function Warn($m){ Write-Host $m -ForegroundColor Yellow }
function Err ($m){ Write-Host $m -ForegroundColor Red }
function Set-Prop($o,$n,$val){ if ($o.PSObject.Properties[$n]) { $o.$n = $val } else { $o | Add-Member -NotePropertyName $n -NotePropertyValue $val } }

$ConfigDir = Join-Path $HOME '.ywcoder'
$Settings  = Join-Path $ConfigDir 'settings.json'
$ManagedVars = @(
  'YWCODER_USE_OPENAI','YWCODEDR_USE_OPENAI','CLAUDE_CODE_USE_OPENAI',
  'OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_API_BASE','OPENAI_MODEL',
  'YWCODER_INTRANET','CLAUDE_CODE_INTRANET'
)

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Err '未找到 npm，请先安装 Node/npm'; exit 1 }

# ---------- 读 settings.json 已有值（PS 原生 JSON）----------
function Read-Setting([string]$key){
  if (-not (Test-Path $Settings)) { return $null }
  try {
    $j = Get-Content $Settings -Raw | ConvertFrom-Json
    if ($j.PSObject.Properties['env'] -and $j.env.PSObject.Properties[$key]) { return $j.env.$key }
    return $null
  } catch { return $null }
}
$existKey   = Read-Setting 'OPENAI_API_KEY'
$existUrl   = Read-Setting 'OPENAI_BASE_URL'
$existModel = Read-Setting 'OPENAI_MODEL'

# 老用户继承来的环境变量
$envKey   = $env:OPENAI_API_KEY
$envUrl   = if ($env:OPENAI_BASE_URL) { $env:OPENAI_BASE_URL } else { $env:OPENAI_API_BASE }
$envModel = $env:OPENAI_MODEL

# ---------- 取值优先级：settings.json → 当前环境变量 → 运维预填 → 交互询问 ----------
$ApiKey = $null; $BaseUrl = $null; $fromEnv = $false
# 模型：始终复用(settings → env → 默认)，-Reconfigure 也不重置
$Model = if ($existModel) { $existModel } elseif ($envModel) { $envModel } else { $DefaultModel }
if (-not $Reconfigure) {
  if ($existKey) { $ApiKey = $existKey } elseif ($envKey) { $ApiKey = $envKey; $fromEnv = $true }
  if ($existUrl) { $BaseUrl = $existUrl } elseif ($envUrl) { $BaseUrl = $envUrl; $fromEnv = $true }
}
if (-not $ApiKey)  { $ApiKey  = $PrefillKey }
if (-not $BaseUrl) { $BaseUrl = $PrefillUrl }
if (-not $ApiKey) {
  $sec = Read-Host '请输入网关 API Key' -AsSecureString
  $ApiKey = [System.Net.NetworkCredential]::new('', $sec).Password
}
if (-not $BaseUrl) { $BaseUrl = Read-Host '请输入网关地址 (OPENAI_BASE_URL，形如 http://gw/v1)' }
if (-not $ApiKey)  { Err '未提供 API Key，退出'; exit 1 }
if (-not $BaseUrl) { Err '未提供网关地址，退出'; exit 1 }
if ($fromEnv) { Info '  检测到旧环境变量配置，已自动迁移到 settings.json' }
Info "本次配置：地址=$BaseUrl  模型=$Model  key=***"

# ---------- 1. 清理旧的 Windows 用户环境变量 ----------
Info '[1/4] 检查并清理旧的用户环境变量...'
$cleaned = $false
foreach ($v in $ManagedVars) {
  if ([Environment]::GetEnvironmentVariable($v, 'User')) {
    [Environment]::SetEnvironmentVariable($v, $null, 'User')
    Info "  已清除用户环境变量 $v"; $cleaned = $true
  }
}
if ($cleaned) { Warn '  注意：当前已打开的终端里旧变量仍在内存，重开终端后才彻底失效。' }
else          { Info '  无旧残留，跳过。' }

# ---------- 2. 离线安装/更新 ----------
Info "[2/4] 安装/更新 ywcoder（离线包：$PkgFile）..."
if (-not (Test-Path $PkgFile)) { Err "安装包不存在：$PkgFile （把 .tgz 放当前目录并核对文件名/顶部 PkgFile）"; exit 1 }
npm install -g $PkgFile
if ($LASTEXITCODE -ne 0) { Err "npm 安装失败（退出码 $LASTEXITCODE）"; exit 1 }
$yw = Get-Command ywcoder -ErrorAction SilentlyContinue
if ($yw) { Info "  版本：$(& ywcoder --version 2>$null)" } else { Warn '  ywcoder 暂未在 PATH（重开终端后应可用）' }

# ---------- 3. 写配置到 settings.json（PS 原生合并，5.1 兼容；UTF-8 无 BOM）----------
Info "[3/4] 写入配置到 $Settings ..."
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
if (Test-Path $Settings) {
  try { $obj = Get-Content $Settings -Raw | ConvertFrom-Json } catch { $obj = [pscustomobject]@{} }
} else { $obj = [pscustomobject]@{} }
if (-not $obj.PSObject.Properties['env']) { $obj | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
Set-Prop $obj.env 'YWCODER_USE_OPENAI' '1'
Set-Prop $obj.env 'OPENAI_API_KEY'   $ApiKey
Set-Prop $obj.env 'OPENAI_BASE_URL'  $BaseUrl
Set-Prop $obj.env 'OPENAI_MODEL'     $Model
Set-Prop $obj.env 'YWCODER_INTRANET' '1'
$json = $obj | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($Settings, $json, (New-Object System.Text.UTF8Encoding($false)))
# 收紧权限（等价 chmod 600）：去继承 + 只授当前用户。域账号下若失败可忽略
try { icacls $Settings /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null; Info '  配置已写入（权限已收紧）' }
catch { Warn '  配置已写入（icacls 收紧失败，可忽略）' }

# ---------- 4. 网关连通自检（非交互 -p + 超时）----------
Info '[4/4] 网关连通自检...'
try {
  $job = Start-Job -ScriptBlock { ywcoder -p '只回复 ok' }
  if (Wait-Job $job -Timeout 60) {
    $out = ((Receive-Job $job -ErrorAction SilentlyContinue) -join ' ').Trim()
    if ($out) { Info "  网关连通 ✓（回复：$($out.Substring(0,[Math]::Min(80,$out.Length)))）" }
    else      { Warn '  自检无输出，请手动运行 ywcoder 验证' }
  } else { Stop-Job $job; Warn '  自检超时，请手动运行 ywcoder 排查' }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
} catch { Warn "  自检异常：$($_.Exception.Message)，请手动运行 ywcoder 验证" }

Write-Host ''
Info '完成。运行  ywcoder  即可使用。后续更新再跑本脚本即可（配置自动复用、无需重输）。'
if ($cleaned) { Warn '提醒：清理过旧环境变量，请重开终端再使用。' }
