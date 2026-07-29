# YwCoder 快速开始

前言
xxx 是 xxx出品的 AI 编程助手，可以帮助你读懂代码、修复 Bug、生成代码和解释技术问题。
目前提供两种服务方式：vscode插件版本和cli版本

⚠️ 注意：开始之前，请确认已从管理员处获取以下文件：ywcoder 安装包、node v18+安装包（可选），以及内网模型 API 地址和密钥。

## 安装

第一步：安装node...

第二步：安装ywcoder-cli

```bash
npm install -g dcywzc-ywcoder-1.0.0.tgz
```

要求：Node.js >= 18.0.0

## 配置 API Key

YwCoder 兼容 Claude Code 的环境变量：

```bash
# Kimi (推荐)
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-kimi-key
export OPENAI_BASE_URL=https://api.kimi.com/coding/v1
export OPENAI_MODEL=kimi-for-coding

# DeepSeek
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-deepseek-key
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat

# Ollama 本地
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=qwen2.5-coder:7b
```

将上述配置添加到 `~/.bashrc` 或 `~/.zshrc`，或 Windows 系统环境变量。

## 启动使用

```bash
ywcoder
```

首次启动自动登录，配置保存后下次无需重复设置。

第三步：安装vscode插件
....

## 常用命令

| 命令        | 说明            |
| ----------- | --------------- |
| `/help`     | 查看帮助        |
| `/provider` | 切换 API 提供商 |
| `/model`    | 切换模型        |
| `/cost`     | 查看用量        |
| `/exit`     | 退出            |

## 卸载

```bash
npm uninstall -g @dcywzc/ywcoder
```
