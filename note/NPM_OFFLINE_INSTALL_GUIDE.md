# YwCoder NPM 离线包安装指南

## 适用场景

- 内网环境无法访问 npm registry
- 需要快速部署到多台 Windows 机器
- 确保依赖版本一致

## 安装步骤

### 1. 下载离线包

从 GitHub Actions 下载 `ywcoder-offline` artifact：

**下载地址**: https://github.com/changjiaoxigua/openclaude/actions/workflows/build-npm-offline.yml

- 选择最新的成功构建
- 下载 `ywcoder-offline` artifact（zip 文件）
- 解压 zip 文件，得到 `dcywzc-ywcoder-1.0.0.tgz`

### 2. 准备环境

确保目标机器已安装 **Node.js >= 18.0.0**：

```bash
node --version
# 应显示 v18.x.x 或更高版本
```

如未安装，请从内网软件库或 U 盘安装 Node.js 18 LTS。

### 3. 安装 YwCoder

在包含 `.tgz` 文件的目录执行：

```bash
npm install -g dcywzc-ywcoder-1.0.0.tgz
```

安装过程无需联网，所有依赖已打包在 .tgz 中。

### 4. 验证安装

```bash
ywcoder --version
# 应显示 1.0.0
```

### 5. 配置 API（首次使用）

根据你的 API 提供商配置环境变量：

**Kimi（月之暗面）**:
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-kimi-api-key
export OPENAI_BASE_URL=https://api.kimi.com/coding/v1
export OPENAI_MODEL=kimi-for-coding
```

**DeepSeek**:
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-deepseek-key
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat
```

**Ollama（本地）**:
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=qwen2.5-coder:7b
```

### 6. 启动使用

```bash
ywcoder
```

首次启动会提示登录，按提示完成即可。配置会自动保存，下次无需重复设置。

## 配置保存说明

YwCoder 的配置文件保存在以下位置：

| 平台 | 配置目录 |
|------|----------|
| Windows | `C:\Users\<用户名>\.claude\` 或 `%USERPROFILE%\.claude\` |
| macOS/Linux | `~/.claude/` |

包含以下内容：
- API Key 和登录状态
- 用户设置和偏好
- 会话历史
- 插件数据

**注意**: 尽管 YwCoder 是独立品牌，但为了与原版 Claude Code 保持配置兼容，默认仍使用 `.claude` 目录。如需更改，可设置 `YWCODER_CONFIG_DIR` 环境变量。

## 常见问题

### Q: 提示 "ywcoder 不是内部或外部命令"

**原因**: npm 全局 bin 目录未加入 PATH

**解决**:
```bash
# 查看 npm 全局 bin 目录
npm bin -g

# 将输出路径加入系统环境变量 PATH
# 例如: C:\Users\xxx\AppData\Roaming\npm
```

### Q: 安装时报 "Unsupported platform" 错误

**原因**: 离线包在 Windows 构建，包含 Windows 原生二进制，不能直接在 Linux/macOS 使用

**解决**: 如需 Linux/macOS 离线包，需在该平台重新构建

### Q: 如何更新到新版

1. 下载新版 `dcywzc-ywcoder-x.x.x.tgz`
2. 先卸载旧版: `npm uninstall -g @dcywzc/ywcoder`
3. 安装新版: `npm install -g dcywzc-ywcoder-x.x.x.tgz`

## 卸载

```bash
npm uninstall -g @dcywzc/ywcoder
```
