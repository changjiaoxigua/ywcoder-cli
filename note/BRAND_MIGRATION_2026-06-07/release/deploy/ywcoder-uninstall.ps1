#requires -Version 5.1
<#
  YWCODER 卸载/还原脚本（Windows PowerShell 5.1）
  作用：卸载 npm 包 + 移除 ~/.ywcoder 配置 + 清理用户环境变量，还原到干净状态。
  用法：
    powershell -ExecutionPolicy Bypass -File .\ywcoder-uninstall.ps1
    powershell -ExecutionPolicy Bypass -File .\ywcoder-uninstall.ps1 -Yes   # 跳过确认
#>
param([switch]$Yes)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Info($m){ Write-Host $m -ForegroundColor Green }
function Warn($m){ Write-Host $m -ForegroundColor Yellow }

$ConfigDir = Join-Path $HOME '.ywcoder'
$ManagedVars = @(
  'YWCODER_USE_OPENAI','YWCODEDR_USE_OPENAI','CLAUDE_CODE_USE_OPENAI',
  'OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_API_BASE','OPENAI_MODEL',
  'YWCODER_INTRANET','CLAUDE_CODE_INTRANET'
)

if (-not $Yes) {
  Warn '将执行：卸载 @dcywzc/ywcoder、移除 ~/.ywcoder、清理用户环境变量。'
  if ((Read-Host '确认继续？[y/N]') -notmatch '^[Yy]$') { Write-Host '已取消'; exit 0 }
}

# ---------- 1. 卸载 npm 包（失败不致命）----------
Info '[1/3] 卸载 npm 包...'
if (Get-Command npm -ErrorAction SilentlyContinue) {
  npm uninstall -g '@dcywzc/ywcoder' 2>$null | Out-Null
  Info '  npm 卸载完成（若本未安装则无影响）'
} else { Warn '  未找到 npm，跳过' }

# ---------- 2. 移除 ~/.ywcoder（Move 备份，可恢复；不动 ~/.claude.json 等存量）----------
Info '[2/3] 移除配置目录...'
if (Test-Path $ConfigDir) {
  $dst = "$ConfigDir.removed.$(Get-Date -Format 'yyyyMMddHHmmss')"
  Move-Item $ConfigDir $dst
  Info "  ~/.ywcoder 已移到 $dst"
  Warn "  彻底删除：Remove-Item -Recurse -Force `"$dst`""
} else { Info '  ~/.ywcoder 不存在，跳过' }

# ---------- 3. 清理用户环境变量 ----------
Info '[3/3] 清理用户环境变量...'
foreach ($v in $ManagedVars) {
  if ([Environment]::GetEnvironmentVariable($v, 'User')) {
    [Environment]::SetEnvironmentVariable($v, $null, 'User'); Info "  已清除 $v"
  }
}

Write-Host ''
Info '完成。机器已还原到干净状态。'
Warn '当前终端里旧环境变量仍在内存，重开终端后彻底失效。~/.claude.json 等存量文件未处理。'
