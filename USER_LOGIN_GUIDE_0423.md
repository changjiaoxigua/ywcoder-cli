# 模型对接配置指南（2025-04-23）

本文档说明如何通过配置文件修改当前项目对接的 LLM 模型。

---

## 一、主对话模型配置（Provider Profiles）

Provider Profiles 存储在 `~/.claude.json` 中，通过 `providerProfiles` 字段管理，决定主对话使用的模型和 API 提供商。

### 配置示例

```json
{
  "providerProfiles": [
    {
      "id": "provider_xxx",
      "name": "DeepSeek",
      "provider": "openai",
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "apiKey": "sk-xxx"
    }
  ],
  "activeProviderProfileId": "provider_xxx"
}
```

### 支持的预设（Preset）

| Preset | 默认 baseUrl | 默认 model |
|--------|-------------|-----------|
| `openai` | `https://api.openai.com/v1` | `gpt-5.3-codex` |
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3-flash-preview` |
| `moonshotai` | `https://api.moonshot.ai/v1` | `kimi-k2.5` |
| `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-6` |
| `ollama` | `http://localhost:11434/v1` | `llama3.1:8b` |
| `together` | `https://api.together.xyz/v1` | `Qwen/Qwen3.5-9B` |
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| `mistral` | `https://api.mistral.ai/v1` | `mistral-large-latest` |
| `azure-openai` | `https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1` | `YOUR-DEPLOYMENT-NAME` |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai/gpt-5-mini` |
| `lmstudio` | `http://localhost:1234/v1` | `local-model` |
| `custom` | 从环境变量读取或默认 Ollama | 从环境变量读取 |

配置后项目会自动将对应的环境变量注入当前进程。

---

## 二、子 Agent 路由配置（Agent Routing）

Agent Routing 配置在 `~/.claude/settings.json` 或项目级的 `.claude/settings.json` 中，用于给不同的子 Agent（如 Explore、Plan、executor 等）分配不同的模型和 API 端点。

### 配置示例

```json
{
  "agentModels": {
    "deepseek-chat": {
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-xxx"
    },
    "gpt-4o": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-xxx"
    }
  },
  "agentRouting": {
    "Explore": "deepseek-chat",
    "Plan": "gpt-4o",
    "default": "gpt-4o"
  }
}
```

### 字段说明

- **`agentModels`**：定义模型名称到 API 端点、密钥的映射。
  - `base_url`：OpenAI 兼容的 API 端点（必须包含 `https://` 或 `http://`）
  - `api_key`：该提供商的 API 密钥

- **`agentRouting`**：定义 Agent 标识符（`subagent_type` 或 team member name）到模型名称的映射。
  - 支持 `default` 作为兜底配置
  - 模型名称必须已在 `agentModels` 中定义

### 匹配优先级

匹配时按以下顺序查找，不区分大小写且忽略 `-` 和 `_`：

1. `name`（Agent 名称）
2. `subagentType`（子 Agent 类型）
3. `default`（默认兜底）
4. 未匹配到则使用全局 Provider 配置

---

## 三、配置文件优先级

`settings.json` 的来源按优先级从低到高依次为：

1. **`userSettings`**：`~/.claude/settings.json`
2. **`projectSettings`**：`<project>/.claude/settings.json`
3. **`localSettings`**：`<project>/.claude/settings.local.json`
4. **`policySettings`**：托管策略配置（远程 / MDM / 文件）
5. **`flagSettings`**：CLI 传入的 `--settings` 内联配置

**高优先级会覆盖低优先级的同名字段。**

---

## 四、快速命令方式

### 4.1 环境变量快速切换

```bash
# OpenAI
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o
export OPENAI_BASE_URL=https://api.openai.com/v1

# Ollama 本地
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=qwen2.5-coder:7b
```

### 4.2 内置快捷命令

```bash
bun run dev:ollama      # Ollama 本地
bun run dev:openai      # OpenAI
bun run dev:gemini      # Google Gemini
bun run dev:codex       # GitHub Codex
```

### 4.3 TUI 交互式管理

在 Claude Code 交互界面中，使用 `/provider` 命令可以交互式管理 Provider Profiles，包括添加、切换、删除配置。

### 4.4 初始化本地测试配置

```bash
# 初始化并保存一个本地 profile
bun run profile:init -- --provider ollama --model llama3.2:3b

# 使用保存的 profile 运行
bun run dev:profile
```

---

## 五、配置文件路径速查

| 用途 | 路径 |
|------|------|
| 全局 Provider Profiles | `~/.claude.json` |
| 用户级 settings | `~/.claude/settings.json` |
| 项目级 settings | `<project>/.claude/settings.json` |
| 项目级 local settings | `<project>/.claude/settings.local.json` |
| 托管策略配置 | `<managed>/managed-settings.json` |

---

*本文档基于 2025-04-23 的代码状态生成。*
