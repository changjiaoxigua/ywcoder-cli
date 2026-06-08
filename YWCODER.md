# YWCODER.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 交互规则

- **始终使用中文**：与用户交流时，请全程使用中文（简体）。所有回复、解释和对话内容都应为中文。
- **代码注释使用中文**：编写或修改代码时，所有注释（包括行内注释、块注释、JSDoc）必须使用中文（简体）。
- **Git commit 使用中文**：所有提交说明（commit message）必须使用中文（简体），包括标题和正文。

## Build System

This is a TypeScript/Bun project. Always use Bun commands (not npm):

```bash
# Install dependencies
bun install

# Build the CLI (bundles to dist/cli.mjs)
bun run build

# Build and run locally
bun run dev

# Smoke test (builds and checks version works)
bun run smoke
```

## Testing

Uses Bun's built-in test runner:

```bash
# Run all tests
bun test

# Run with coverage (outputs to coverage/ with heatmap)
bun run test:coverage

# Run a single test file
bun test src/utils/providerProfile.test.ts

# Provider-specific tests
bun run test:provider
bun run test:provider-recommendation
```

## Provider Development

OpenClaude supports multiple LLM providers (OpenAI, Gemini, Ollama, GitHub Models, Codex, etc.):

- Provider implementations are in `src/services/api/`
- `openaiShim.ts` - OpenAI-compatible API shim (used by most providers)
- `codexShim.ts` - GitHub Codex integration
- `claude.ts` - Anthropic Claude API
- `providerConfig.ts` - Provider configuration logic

### Testing Provider Changes

```bash
# Initialize a local profile for testing
bun run profile:init -- --provider ollama --model llama3.2:3b

# Run with the saved profile
bun run dev:profile

# Or use quick presets
bun run dev:ollama      # Ollama local
bun run dev:openai      # OpenAI
bun run dev:gemini      # Google Gemini
bun run dev:codex       # GitHub Codex

# Runtime diagnostics
bun run doctor:runtime
```

## Architecture Overview

### Entry Points

- `src/entrypoints/cli.tsx` - Main CLI entry point
- `src/grpc/` - Headless gRPC server (`npm run dev:grpc`)

### Core Directories

- `src/commands/` - Slash commands (e.g., `/commit`, `/provider`, `/help`)
- `src/tools/` - Tool implementations (BashTool, FileReadTool, FileEditTool, etc.)
- `src/components/` - React/Ink UI components for terminal rendering
- `src/services/` - External service integrations (API clients, MCP, analytics)
- `src/bridge/` - Bridge mode for external integrations
- `src/hooks/` - React hooks for UI state
- `src/utils/` - Utility functions

### Key Files

- `src/main.tsx` - Main application loop and orchestration
- `src/Tool.ts` - Tool definitions and types
- `src/commands.ts` - Command registration and routing
- `src/query.ts` - Query engine for handling LLM interactions

### Build Configuration

- `scripts/build.ts` - Custom Bun build script with feature flags
- Feature flags control which capabilities are enabled in the open build
- `MACRO.*` constants are replaced at build time (version, build time, etc.)

## gRPC Server (Headless Mode)

OpenClaude can run as a headless gRPC service:

```bash
# Start the gRPC server
npm run dev:grpc

# Run the test CLI client
npm run dev:grpc:cli
```

Proto file is at `src/proto/openclaude.proto`.

## CI Checks

Before submitting a PR, run:

```bash
bun run build
bun run smoke
bun test --max-concurrency=1
bun run security:pr-scan -- --base origin/main
bun run test:provider
bun run test:provider-recommendation
```

## Agent Routing

Different agents can route to different models via `~/.claude/settings.json`:

```json
{
  "agentModels": { "gpt-4o": { "base_url": "...", "api_key": "..." } },
  "agentRouting": { "Explore": "gpt-4o", "Plan": "gpt-4o", "default": "gpt-4o" }
}
```

## Environment Variables

Common env vars for quick testing:

```bash
# OpenAI-compatible
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o

# Ollama local
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=qwen2.5-coder:7b
```

# YWCODER.md

行为指南，用于减少大语言模型在编码时的常见错误。可根据需要与项目特定说明合并。

**权衡取舍：** 这些指南倾向于谨慎而非速度。对于简单任务，请自行判断。

## 1. 编码前先思考

**不要假设。不要隐藏困惑。明确表达权衡取舍。**

实现前：

- 明确陈述你的假设。如果不确定，就问。
- 如果存在多种理解方式，请呈现出来 —— 不要默默选择。
- 如果存在更简单的方案，请说出来。必要时提出异议。
- 如果有不清楚的地方，停下来。指出困惑的地方。提问。

## 2. 简洁优先

**用最少的代码解决问题。不做任何推测性的设计。**

- 不添加超出需求的功能。
- 不为一次性代码创建抽象。
- 不添加未被要求的"灵活性"或"可配置性"。
- 不处理不可能发生的场景的错误。
- 如果你写了 200 行代码，其实 50 行就能搞定，那就重写。

扪心自问："资深工程师会说这过于复杂吗？" 如果是，就简化。

## 3. 精准修改

**只碰必须碰的地方。只清理自己造成的混乱。**

编辑现有代码时：

- 不要"改进"相邻的代码、注释或格式。
- 不要重构没有问题的代码。
- 遵循现有风格，即使你自己写会不一样。
- 如果你注意到不相关的死代码，提一下即可 —— 不要删除。

当你的变更产生了孤儿代码时：

- 删除**你的**变更导致不再使用的导入/变量/函数。
- 除非被要求，不要删除预先存在的死代码。

检验标准：每一行变更的代码都应该能直接追溯到用户的请求。

## 4. 目标驱动执行

**定义成功标准。循环验证直到达成。**

将任务转化为可验证的目标：

- "添加验证" → "为无效输入编写测试，然后让它们通过"
- "修复 bug" → "编写一个能复现 bug 的测试，然后让它通过"
- "重构 X" → "确保重构前后测试都通过"

对于多步骤任务，简要说明计划：

```
1. [步骤] → 验证: [检查点]
2. [步骤] → 验证: [检查点]
3. [步骤] → 验证: [检查点]
```

强有力的成功标准让你能独立循环迭代。弱标准（"让它能跑起来"）需要不断澄清。

---

**这些指南生效的标志是：** diff 中不必要的变更更少，因过度复杂而重写的情况更少，澄清问题出现在实现之前而不是犯错之后。
