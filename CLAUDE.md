# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 交互规则

- **始终使用中文**：与用户交流时，请全程使用中文（简体）。所有回复、解释和对话内容都应为中文。

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
