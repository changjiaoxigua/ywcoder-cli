# YWCODER 部署脚本 · PowerShell 版设计与伪代码（评审稿，未落地）

> 目的：把 Linux/bash 版 1:1 映射为 Windows 原生 PowerShell 版的**设计草案 + 伪代码**，供评审。
> 以下伪代码用真实 PowerShell cmdlet 表达便于审阅，但**尚未作为可执行 `.ps1` 交付**。

---

## 0. 范围与前提

- **拟交付脚本**：`ywcoder-setup.ps1`（主力）、`ywcoder-uninstall.ps1`。
  - 建议**不做** `setup-new.ps1`：Windows 下 `setup.ps1` 已覆盖新老用户，减少维护面（待定）。
- **PowerShell 版本**：⚠️ 需明确目标——
  - **Windows PowerShell 5.1**（Windows 自带）：`ConvertFrom-Json` **无 `-AsHashtable`**，JSON 合并要走 PSCustomObject + Add-Member（略繁）。
  - **PowerShell 7+（pwsh）**：有 `-AsHashtable`，合并很干净。
  - 建议优先按 **5.1 兼容**写（覆盖面最广），下文伪代码给 5.1 可用写法。
- **配置载体不变**：仍写 `%USERPROFILE%\.ywcoder\settings.json` 的 `env` 块，内容与 Linux 版完全一致。

---

## 1. 公共约定（两脚本共用片段）

```powershell
#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'      # 等价 set -e

# 颜色输出（等价 info/warn/err）
function Info($m){ Write-Host $m -ForegroundColor Green }
function Warn($m){ Write-Host $m -ForegroundColor Yellow }
function Err ($m){ Write-Host $m -ForegroundColor Red }

# 配置路径（$HOME 在 PS 指向用户目录）
$ConfigDir = Join-Path $HOME '.ywcoder'
$Settings  = Join-Path $ConfigDir 'settings.json'

# 受管 provider 变量（清理目标，含历史 typo YWCODEDR）
$ManagedVars = @(
  'YWCODER_USE_OPENAI','YWCODEDR_USE_OPENAI','CLAUDE_CODE_USE_OPENAI',
  'OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_API_BASE','OPENAI_MODEL',
  'YWCODER_INTRANET','CLAUDE_CODE_INTRANET'
)
```

> 注：bash 的"自动切 bash"保险在 PS 不需要（没有 sh/dash 混跑问题）；取而代之的 Windows 门槛是 **ExecutionPolicy**（见 §5）。

---

## 2. `ywcoder-setup.ps1` 详细伪代码

### 2.1 参数与运维预填
```powershell
param(
  [switch]$Reconfigure,                          # 等价 --reconfigure
  [string]$PkgFile = $(if($env:YW_PKG_FILE){$env:YW_PKG_FILE}else{'.\dcywzc-ywcoder-1.2.1.tgz'}),
  [string]$PrefillKey = $env:YW_API_KEY,         # 共享 key 可预填；留空=问用户
  [string]$PrefillUrl = $env:YW_BASE_URL,        # 网关地址预填；留空=问用户
  [string]$DefaultModel = $(if($env:YW_MODEL){$env:YW_MODEL}else{'Qwen3.5-27B'})
)
```

### 2.2 读已有配置（PS 原生 JSON，无需 jq）
```powershell
function Read-Setting([string]$key){
  if(-not (Test-Path $Settings)){ return $null }
  try   { return (Get-Content $Settings -Raw | ConvertFrom-Json).env.$key }
  catch { return $null }
}
$existKey   = Read-Setting 'OPENAI_API_KEY'
$existUrl   = Read-Setting 'OPENAI_BASE_URL'
$existModel = Read-Setting 'OPENAI_MODEL'

# 老用户继承来的环境变量（子进程继承父会话已设的变量）
$envKey   = $env:OPENAI_API_KEY
$envUrl   = if($env:OPENAI_BASE_URL){$env:OPENAI_BASE_URL}else{$env:OPENAI_API_BASE}
$envModel = $env:OPENAI_MODEL
```

### 2.3 取值优先级：settings.json → 当前环境变量 → 运维预填 → 交互询问
```powershell
$ApiKey=$null; $BaseUrl=$null; $fromEnv=$false

# 模型：始终复用(settings → env → 默认)，--Reconfigure 也不重置
$Model = if($existModel){$existModel} elseif($envModel){$envModel} else{$DefaultModel}

if(-not $Reconfigure){
  if($existKey){ $ApiKey=$existKey } elseif($envKey){ $ApiKey=$envKey; $fromEnv=$true }
  if($existUrl){ $BaseUrl=$existUrl } elseif($envUrl){ $BaseUrl=$envUrl; $fromEnv=$true }
}
# 运维预填
if(-not $ApiKey ){ $ApiKey =$PrefillKey }
if(-not $BaseUrl){ $BaseUrl=$PrefillUrl }
# 交互询问（key 用 SecureString 隐藏输入，再转明文写文件——文件本就明文存）
if(-not $ApiKey){
  $sec = Read-Host '请输入网关 API Key' -AsSecureString
  $ApiKey = [System.Net.NetworkCredential]::new('',$sec).Password
}
if(-not $BaseUrl){ $BaseUrl = Read-Host '请输入网关地址 (形如 http://gw/v1)' }
if(-not $ApiKey ){ Err '未提供 API Key'; exit 1 }
if(-not $BaseUrl){ Err '未提供网关地址'; exit 1 }
if($fromEnv){ Info '  检测到旧环境变量配置，已自动迁移到 settings.json' }
Info "本次配置：地址=$BaseUrl  模型=$Model  key=***"
```

### 2.4 清理旧的 Windows 用户环境变量（替代 Linux 清 rc）
```powershell
Info '[1/4] 检查并清理旧的用户环境变量...'
$cleaned=$false
foreach($v in $ManagedVars){
  if([Environment]::GetEnvironmentVariable($v,'User')){
    [Environment]::SetEnvironmentVariable($v,$null,'User')   # 删 User 级（不需管理员）
    Info "  已清除用户环境变量 $v"; $cleaned=$true
  }
}
if($cleaned){ Warn '  注意：当前已开的终端里旧变量仍在内存，重开终端后才彻底失效。' }
else        { Info '  无旧残留，跳过。' }
# 注：'Machine'(系统级)需要管理员，默认不动；如有需要再单独处理。
```

### 2.5 离线安装/更新
```powershell
Info "[2/4] 安装/更新 ywcoder（离线包：$PkgFile）..."
if(-not (Test-Path $PkgFile)){ Err "安装包不存在：$PkgFile"; exit 1 }
npm install -g $PkgFile
if(-not (Get-Command ywcoder -ErrorAction SilentlyContinue)){
  Err 'ywcoder 不在 PATH（可能需重开终端让 PATH 刷新）'; exit 1
}
Info "  版本：$(ywcoder --version 2>$null)"
```

### 2.6 写配置到 settings.json（PS 原生合并，5.1 兼容）
```powershell
Info "[3/4] 写入配置到 $Settings ..."
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

# 读旧对象(没有则空对象)
$obj = if(Test-Path $Settings){
  try{ Get-Content $Settings -Raw | ConvertFrom-Json } catch { [pscustomobject]@{} }
} else { [pscustomobject]@{} }

# 确保有 .env 子对象
if(-not $obj.PSObject.Properties['env']){ $obj | Add-Member env ([pscustomobject]@{}) }

# 写/覆盖这几个 key（PSCustomObject：存在则赋值，不存在则 Add-Member）
$kv = [ordered]@{
  YWCODER_USE_OPENAI='1'; OPENAI_API_KEY=$ApiKey; OPENAI_BASE_URL=$BaseUrl;
  OPENAI_MODEL=$Model; YWCODER_INTRANET='1'
}
foreach($k in $kv.Keys){
  if($obj.env.PSObject.Properties[$k]){ $obj.env.$k = $kv[$k] }
  else { $obj.env | Add-Member $k $kv[$k] }
}

# 写盘（UTF-8，-Depth 给够避免中文/嵌套被截断）
$obj | ConvertTo-Json -Depth 10 | Set-Content -Path $Settings -Encoding UTF8

# 收紧权限（等价 chmod 600）：去继承、只授当前用户完全控制
icacls $Settings /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
Info '  配置已写入（权限已收紧）'
```

### 2.7 网关连通自检（非交互 -p + 超时）
```powershell
Info '[4/4] 网关连通自检...'
$job = Start-Job { ywcoder -p '只回复 ok' }
if(Wait-Job $job -Timeout 60){
  Info "  网关连通 ✓（回复：$((Receive-Job $job) -join ' ' )）"
}else{
  Stop-Job $job; Warn '  自检超时，请手动运行 ywcoder 排查'
}
Remove-Job $job -Force -ErrorAction SilentlyContinue
Info '完成。运行  ywcoder  即可使用。'
```

---

## 3. `ywcoder-uninstall.ps1` 详细伪代码

```powershell
param([switch]$Yes)                                # 等价 -y
Set-StrictMode -Version Latest; $ErrorActionPreference='Stop'
# ...Info/Warn/Err、$ConfigDir、$ManagedVars 同 §1...

if(-not $Yes){
  Warn '将卸载 @dcywzc/ywcoder、移除 ~/.ywcoder、清理用户环境变量。'
  if((Read-Host '确认继续？[y/N]') -notmatch '^[Yy]$'){ Write-Host '已取消'; exit 0 }
}

# 1) 卸载 npm 包（失败不致命）
Info '[1/3] 卸载 npm 包...'
try{ npm uninstall -g '@dcywzc/ywcoder'; Info '  已卸载' } catch { Warn '  跳过（可能未安装）' }

# 2) 移除 ~/.ywcoder（Move 备份，可恢复；不动 ~/.claude.json 等存量）
Info '[2/3] 移除配置目录...'
if(Test-Path $ConfigDir){
  $dst = "$ConfigDir.removed.$(Get-Date -Format yyyyMMddHHmmss)"
  Move-Item $ConfigDir $dst
  Info "  已移到 $dst"; Warn "  彻底删除：Remove-Item -Recurse -Force '$dst'"
}else{ Info '  不存在，跳过' }

# 3) 清理用户环境变量
Info '[3/3] 清理用户环境变量...'
foreach($v in $ManagedVars){
  if([Environment]::GetEnvironmentVariable($v,'User')){
    [Environment]::SetEnvironmentVariable($v,$null,'User'); Info "  已清除 $v"
  }
}
Info '完成。重开终端后旧环境变量彻底失效。'
```

---

## 4. 与 bash 版的关键差异（评审重点）

| 点 | bash 版 | PowerShell 版 |
|---|---|---|
| JSON 读写 | jq/python3/整写三段兜底 | **PS 原生 ConvertFrom/To-Json**，省掉外部依赖 |
| 清理目标 | `.bashrc`/`.zshrc` 的 export 行 | **Windows 用户环境变量**（`[Environment]::...'User'`） |
| 权限收紧 | `chmod 600` | `icacls`（去继承+只授当前用户） |
| 运行门槛 | `sh` 误用→自动切 bash | **ExecutionPolicy**（见 §5） |
| 超时自检 | `timeout 60 ...` | `Start-Job`+`Wait-Job -Timeout` |
| 管理员需求 | 可能要 sudo | 用户级 npm 全局 + 用户环境变量，**多数不需管理员** |

---

## 5. Windows 特有注意点（必须写进说明）

1. **ExecutionPolicy（头号门槛）**：默认可能禁跑 `.ps1`。运行方式：
   `powershell -ExecutionPolicy Bypass -File .\ywcoder-setup.ps1`
   或管理员 `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`。
2. **PowerShell 版本**：上面按 **5.1 兼容**写；若全员 pwsh 7+，§2.6 合并可改用 `ConvertFrom-Json -AsHashtable` 更简洁。需先确认目标机版本。
3. **PATH 刷新**：npm 全局装好后，当前会话可能尚未识别 `ywcoder`，必要时重开终端。
4. **编码**：脚本与 settings.json 用 **UTF-8**，避免中文提示/值乱码。
5. **`-AsSecureString` 仅隐藏输入**：key 最终仍明文存 settings.json（已 icacls 收紧）——与 Linux 同，属内网可接受的取舍。

---

## 6. 决策记录（2026-06-25 评审确认）

1. ✅ **目标 = Windows PowerShell 5.1**（Windows 自带）。本文伪代码即按 5.1 兼容（JSON 合并走 PSCustomObject + Add-Member）。
2. ✅ **省掉 setup-new.ps1**：只交付 `ywcoder-setup.ps1` + `ywcoder-uninstall.ps1`。
3. ✅ **保留权限收紧（icacls）**：成本极小、又是好习惯，保留 §2.6 那一行。
4. ✅ **保留自检**（`ywcoder -p` 连一次网关）。
5. ✅ **不做远程 Windows 部署**：Windows 均为本机终端使用，无远程场景——本项移出范围。

---

> 评审通过 + Linux 版定型后，再据此落地为可执行 `.ps1`。当前仅为设计草案。
