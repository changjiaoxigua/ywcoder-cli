# 打包与安装说明

本文档说明如何将 ywcoder 打包分发，以及用户在不同平台、不同网络环境下的安装方式。

---

## 一、开发者打包（Mac）

### 前提条件

- Node.js >= 18.0.0
- Bun（安装：`curl -fsSL https://bun.sh/install | bash`）

### 构建步骤

```bash
# 1. 安装依赖
bun install

# 2. 构建（生成 dist/cli.mjs）
bun run build

# 3. 打包为 .tgz
npm pack
# 生成文件：dcywzc-ywcoder-1.0.0.tgz
```

打包完成后将 `dcywzc-ywcoder-1.0.0.tgz` 分发给用户。

---

## 二、用户安装说明

### 方案 A：Mac 在线安装

**前提**：Node.js >= 18.0.0，能访问 npm registry。

```bash
# 安装（将文件名替换为实际版本号）
npm install -g dcywzc-ywcoder-1.0.0.tgz

# 验证
ywcoder --version
```

---

### 方案 B：Windows 在线安装

**前提**：Node.js >= 18.0.0（推荐从 https://nodejs.org 下载 LTS 版本），能访问 npm registry。

```powershell
# 安装（将文件名替换为实际版本号）
npm install -g dcywzc-ywcoder-1.0.0.tgz

# 验证
ywcoder --version
```

> 说明：npm 会自动为 Windows 下载对应平台的原生依赖二进制文件，无需在 Windows 上重新构建。

---

### 方案 C：Windows 离线安装（内网环境）

离线安装需要提前在一台**能联网的 Windows 机器**上准备好安装包，再分发到内网机器。

#### 第一步：在联网 Windows 机器上准备离线包

```powershell
# 1. 安装（此步骤需要联网）
npm install -g dcywzc-ywcoder-1.0.0.tgz

# 2. 查找全局安装目录
npm root -g
# 输出类似：C:\Users\用户名\AppData\Roaming\npm\node_modules

# 3. 找到 ywcoder 的安装目录
# 通常为：C:\Users\用户名\AppData\Roaming\npm\node_modules\@dcywzc\ywcoder

# 4. 同时需要打包 npm 全局 bin 目录下的启动脚本
# 通常为：C:\Users\用户名\AppData\Roaming\npm\ywcoder、ywcoder.cmd、claude、claude.cmd
```

```powershell
# 5. 将以下两个目录打成 zip（使用 PowerShell）
$installRoot = "$env:APPDATA\npm"

Compress-Archive -Path "$installRoot\node_modules\@dcywzc" `
                 -DestinationPath "ywcoder-offline-package.zip"
```

将以下文件一并拷贝，打成一个 zip 发给内网用户：

- `ywcoder-offline-package.zip`（含 node_modules）
- `ywcoder.cmd`、`ywcoder`（来自 npm bin 目录）
- `OFFLINE_INSTALL.bat`（见下方脚本）

#### 第二步：制作 OFFLINE_INSTALL.bat 安装脚本

在联网机器上创建 `OFFLINE_INSTALL.bat`，内容如下：

```bat
@echo off
setlocal

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 18 或以上版本。
    echo 下载地址：https://nodejs.org（需内网可访问，或由管理员提前准备安装包）
    pause
    exit /b 1
)

:: 获取 npm 全局目录
for /f "delims=" %%i in ('npm root -g') do set NPM_ROOT=%%i
for /f "delims=" %%i in ('npm bin -g') do set NPM_BIN=%%i

echo npm 全局模块目录：%NPM_ROOT%
echo npm 全局 bin 目录：%NPM_BIN%

:: 解压模块
echo 正在安装模块文件...
powershell -Command "Expand-Archive -Force '.\ywcoder-offline-package.zip' '%NPM_ROOT%'"

:: 复制 bin 脚本
echo 正在复制命令脚本...
copy /Y ".\ywcoder.cmd" "%NPM_BIN%\ywcoder.cmd"
copy /Y ".\ywcoder"     "%NPM_BIN%\ywcoder"

echo.
echo 安装完成！请重新打开命令提示符后运行：ywcoder --version
pause
```

#### 第三步：在内网 Windows 机器上安装

1. 将以下文件拷贝到目标机器同一目录：
   - `ywcoder-offline-package.zip`
   - `ywcoder.cmd`、`ywcoder`
   - `OFFLINE_INSTALL.bat`
   - Node.js 安装包（如目标机器无 Node.js）

2. 先安装 Node.js（如未安装），然后双击运行 `OFFLINE_INSTALL.bat`。

3. 重新打开命令提示符，验证：

```powershell
ywcoder --version
```

---

### 方案 D：Mac 离线安装

```bash
# 在有网络的 Mac 上安装并导出
npm install -g dcywzc-ywcoder-1.0.0.tgz

# 找到安装目录
npm root -g
# 通常为：/usr/local/lib/node_modules 或 /opt/homebrew/lib/node_modules

# 打包
tar -czf ywcoder-offline-mac.tar.gz \
  $(npm root -g)/@dcywzc/ywcoder \
  $(npm bin -g)/ywcoder \
  $(npm bin -g)/claude
```

在内网 Mac 上还原：

```bash
# 解压（注意路径与打包时一致）
tar -xzf ywcoder-offline-mac.tar.gz -C /

# 验证
ywcoder --version
```

---

## 三、常见问题

### Q：提示"ywcoder 不是内部或外部命令"（Windows）

确认 npm 全局 bin 目录已加入 PATH 环境变量：

```powershell
# 查看 npm bin 目录
npm bin -g

# 将输出的路径加入系统环境变量 PATH 后重启终端
```

### Q：提示 Node.js 版本过低

本工具需要 Node.js 18.0.0 或以上版本。检查当前版本：

```bash
node --version
```

### Q：Windows 上 sharp 相关报错

`sharp` 为原生模块，需在联网 Windows 上完成首次安装以获取正确二进制。离线包必须从 Windows 机器上制作，不能直接使用 Mac 上打包的 node_modules。

---

## 四、卸载

### Mac / Linux

```bash
npm uninstall -g @dcywzc/ywcoder

# 验证已卸载
which ywcoder   # 无输出则成功
```

### Windows（在线安装方式）

```powershell
npm uninstall -g @dcywzc/ywcoder

# 验证已卸载
where ywcoder   # 提示"找不到"则成功
```

### Windows（离线手动安装方式）

离线安装是直接复制文件，需手动删除：

```powershell
# 1. 删除模块目录
$npmRoot = npm root -g
Remove-Item -Recurse -Force "$npmRoot\@dcywzc\ywcoder"

# 2. 删除 bin 脚本
$npmBin = npm bin -g
Remove-Item -Force "$npmBin\ywcoder", "$npmBin\ywcoder.cmd"
Remove-Item -Force "$npmBin\claude", "$npmBin\claude.cmd"
```

---

## 五、版本更新

每次更新版本后，开发者重新执行打包步骤生成新的 `.tgz`，用户重新执行对应安装命令即可覆盖旧版本。
