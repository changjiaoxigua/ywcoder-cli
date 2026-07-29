# YwCoder 用户使用指南

YwCoder 是一款支持多 LLM 提供商的 AI 编码助手 CLI 工具。

---

## 安装

```bash
npm install -g @dcywzc/ywcoder
```

或使用 npx：

```bash
npx @dcywzc/ywcoder
```

---

## 快速开始

### 1. 初始化配置

YwCoder 支持多种大模型提供商，首次使用需要配置：

```bash
# 使用交互式向导配置
ywcoder profile:init

# 或直接指定提供商
ywcoder profile:init --provider deepseek --model deepseek-chat
```

### 2. 启动工具

```bash
# 启动交互式会话
ywcoder

# 或在指定目录启动
ywcoder /path/to/your/project
```

---

## 支持的 LLM 提供商

### 国内/中文优化

| 提供商 | 命令示例 | 说明 |
|--------|----------|------|
| DeepSeek | `ywcoder profile:init --provider deepseek` | 深度求索，中文友好 |
| Moonshot AI | `ywcoder profile:init --provider moonshotai` | 月之暗面 Kimi |

### 国际主流

| 提供商 | 命令示例 | 说明 |
|--------|----------|------|
| OpenAI | `ywcoder profile:init --provider openai` | GPT-4 系列 |
| Anthropic | `ywcoder profile:init --provider anthropic` | Claude 系列 |
| Google Gemini | `ywcoder profile:init --provider gemini` | Gemini 模型 |

### 本地/开源

| 提供商 | 命令示例 | 说明 |
|--------|----------|------|
| Ollama | `ywcoder profile:init --provider ollama` | 本地运行开源模型 |
| LM Studio | `ywcoder profile:init --provider lmstudio` | 本地模型管理 |

### 其他平台

| 提供商 | 命令示例 | 说明 |
|--------|----------|------|
| Groq | `ywcoder profile:init --provider groq` | 高速推理 |
| Together | `ywcoder profile:init --provider together` | 开源模型平台 |
| Mistral | `ywcoder profile:init --provider mistral` | Mistral AI |
| OpenRouter | `ywcoder profile:init --provider openrouter` | 多模型聚合 |
| Azure OpenAI | `ywcoder profile:init --provider azure-openai` | 企业 Azure 服务 |

---

## 配置方法详解

### 方式一：交互式配置（推荐）

```bash
ywcoder profile:init
```

按照提示输入：
1. 选择提供商
2. 输入 API Key
3. 选择/输入模型名称

配置会自动保存，下次启动无需重复设置。

### 方式二：命令行参数

```bash
# DeepSeek 示例
ywcoder profile:init \
  --provider openai \
  --model deepseek-chat \
  --base-url https://api.deepseek.com/v1
```

然后按提示输入 API Key。

### 方式三：环境变量（临时使用）

#### 3.1 使用 YWCODER 品牌变量（推荐）

YwCoder 提供品牌化的环境变量，优先于 CLAUDE_CODE_* 变量：

**Anthropic Claude OAuth 登录：**
```bash
export YWCODER_OAUTH_TOKEN=your-oauth-token
ywcoder
```

**第三方 Provider API Key 登录：**
```bash
# 启用 OpenAI 兼容模式
export YWCODER_USE_OPENAI=1

# 设置服务商 API Key（使用服务商标准变量名）
export OPENAI_API_KEY=your-api-key        # OpenAI / DeepSeek / 其他兼容服务
export OPENAI_BASE_URL=https://api.deepseek.com/v1  # 自定义端点
export OPENAI_MODEL=deepseek-chat

ywcoder
```

**其他 Provider：**
```bash
# Gemini
export YWCODER_USE_GEMINI=1
export GEMINI_API_KEY=your-api-key
ywcoder

# GitHub Models
export YWCODER_USE_GITHUB=1
export GITHUB_TOKEN=your-github-token
ywcoder
```

#### 3.2 使用 CLAUDE 品牌变量（兼容）

向后兼容原 Claude Code 环境变量：

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-api-key
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat

ywcoder
```

**优先级说明：**
- `YWCODER_*` 变量优先于 `CLAUDE_CODE_*` 变量
- 两者同时存在时，使用 `YWCODER_*` 的值
- 建议新配置使用 `YWCODER_*` 变量

#### 3.3 环境变量优先级

```
YWCODER_* > CLAUDE_CODE_* > 配置文件
```

环境变量适合临时切换模型或 CI/CD 场景使用。

---

## 常用命令

### 基础操作

| 命令 | 说明 |
|------|------|
| `ywcoder` | 启动交互式会话 |
| `ywcoder /path/to/dir` | 在指定目录启动 |
| `ywcoder --version` | 查看版本 |

### 配置管理

| 命令 | 说明 |
|------|------|
| `ywcoder profile:init` | 添加新配置 |
| `ywcoder profile:list` | 列出所有配置 |
| `ywcoder profile:switch` | 切换活动配置 |
| `ywcoder profile:delete` | 删除配置 |

### 系统诊断

| 命令 | 说明 |
|------|------|
| `ywcoder doctor` | 运行系统检查 |
| `ywcoder doctor:runtime` | 运行时诊断 |

---

## 使用示例

### 示例 1：使用 DeepSeek

```bash
# 初始化 DeepSeek 配置
ywcoder profile:init --provider deepseek

# 启动（自动使用已配置的 DeepSeek）
ywcoder
```

### 示例 2：本地 Ollama

```bash
# 确保 Ollama 已安装并运行
ollama pull llama3.1:8b

# 配置 YwCoder 使用 Ollama
ywcoder profile:init --provider ollama --model llama3.1:8b

# 启动（无需 API Key）
ywcoder
```

### 示例 3：临时使用不同模型

```bash
# 平时使用 DeepSeek（推荐方式）
export YWCODER_USE_OPENAI=1
export OPENAI_API_KEY=sk-deepseek-key
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat

# 临时切换到 OpenAI
YWCODER_USE_OPENAI=1 OPENAI_API_KEY=sk-openai-key OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_MODEL=gpt-4o ywcoder
```

---

## 配置文件位置

YwCoder 的配置存储在：

- **全局配置目录**: `~/.ywcoder/`
- **全局配置文件**: `~/.ywcoder/.config.json` 或 `~/.claude.json`
- **旧版兼容目录**: `~/.openclaude/` 或 `~/.claude/`

配置目录优先级：
1. `~/.ywcoder/`（新默认，优先使用）
2. `~/.openclaude/`（旧版兼容）
3. `~/.claude/`（旧版兼容）

配置文件包含 Provider Profile、API Key（加密存储）、OAuth Token 等信息。

**迁移说明**：
如果之前使用过 OpenClaude/Claude Code，配置会自动继承。运行以下命令迁移到新目录：

```bash
ywcoder --migrate-config
```

---

## 故障排查

### 无法连接模型

```bash
# 检查网络连接
ywcoder doctor:runtime

# 检查配置是否正确
ywcoder profile:list
```

### API Key 错误

```bash
# 重新配置
ywcoder profile:init --provider <provider>
```

### 本地模型无法使用

确保 Ollama/LM Studio 服务已启动：

```bash
# 检查 Ollama 状态
ollama list

# 启动 Ollama 服务
ollama serve
```

---

## 安全提示

1. **API Key 安全**：不要在不安全的环境中明文存储 API Key
2. **配置文件权限**：配置文件的权限设置为仅当前用户可读
3. **日志敏感信息**：提交 issue 时注意不要包含 API Key

---

## 获取帮助

- 项目地址：https://github.com/dcywzc/ywcoder
- 提交 Issue：https://github.com/dcywzc/ywcoder/issues

---

*YwCoder - 开源 AI 编码助手，支持 200+ 模型*
