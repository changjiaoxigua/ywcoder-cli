# Kimi API reasoning_content 兼容性修复总结

## 问题现象

使用 Kimi（月之暗面）的 `https://api.kimi.com/coding/v1` OpenAI 兼容 API 时，多轮对话中执行工具调用会报错：

```
API Error: 400 {
  "error": {
    "message": "thinking is enabled but reasoning_content is missing in assistant tool call message at index 8",
    "type": "invalid_request_error"
  }
}
```

- 第一轮对话通常正常
- 多轮之后或涉及工具调用的对话失败
- 仅在 Kimi 出现，OpenAI、Gemini 等标准 API 不受影响

---

## 原因分析

### 根本原因

Kimi 的 `/coding/v1` API 内部实现了类似 Claude 的 thinking/reasoning 机制。该 API：

1. **响应阶段**：SSE 流中返回 `reasoning_content` 字段（而非标准 OpenAI 的 `reasoning` 或 `reasoning_effort`）
2. **历史校验**：期望后续请求中，如果 assistant 消息包含工具调用，也必须附带 `reasoning_content` 字段

### ywcoder 的缺陷

OpenAI shim 在两个环节丢弃了 `reasoning_content`：

#### 环节 1：响应接收（`openaiStreamToAnthropic()`）

- `OpenAIStreamChunk` 类型定义中没有 `reasoning_content` 字段
- Kimi 返回的 `delta.reasoning_content` 被静默忽略，未生成对应的 Anthropic thinking block
- 历史消息中不存在 thinking 内容

#### 环节 2：请求发送（`convertMessages()`）

- 即使历史中有 thinking block，第 252 行的过滤器也会过滤掉它
- 回传给 Kimi 的请求中没有 `reasoning_content` 字段

#### 触发条件

多轮对话时，Kimi 记住了第一轮生成过 reasoning，后续请求的 assistant 消息（包含工具调用）缺少 `reasoning_content`，导致校验失败。

---

## 解决方案

### 改动 1：类型定义扩展

**文件**：`src/services/api/openaiShim.ts`（第 439-449 行）

在 `OpenAIStreamChunk` 的 `delta` 类型中增加 `reasoning_content` 字段：

```typescript
delta: {
  role?: string
  content?: string | null
  reasoning_content?: string | null  // ← 新增
  tool_calls?: Array<{
    // ...
  }>
}
```

### 改动 2：流式响应处理

**位置**：`openaiStreamToAnthropic()`（流式解析循环）

- 新增 `hasEmittedThinkingStart` 状态跟踪
- 在处理 `delta.reasoning_content` 时，生成 Anthropic 格式的 thinking content block
- thinking block 在 text block 开始前自动关闭
- 在流完成时（finish_reason）正确关闭未关闭的 thinking block

效果：Kimi 返回的 `reasoning_content` 字段在历史消息中以 Anthropic thinking block 形式保留。

### 改动 3：历史消息回传

**位置**：`convertMessages()`（assistant 消息处理）

- 提取历史中的 thinking block（之前被过滤掉）
- 将 thinking 内容重新构造为 `reasoning_content` 字段
- 在回传给 API 的 assistant 消息中附加该字段

效果：多轮对话时，历史中的 thinking 内容原样回传，满足 Kimi 的校验。

---

## 影响范围

### 受益的 Provider

- ✅ **Kimi** (`https://api.kimi.com/coding/v1`)
- ✅ **DeepSeek R1** 及其他支持 reasoning 的 OpenAI 兼容服务
- ✅ 未来的类似 API

### 不影响的 Provider

- ✅ **标准 OpenAI** API（不返回 `reasoning_content`）
- ✅ **Google Gemini**（走独立的 shim）
- ✅ **Claude API**（走独立的客户端）

### 性能影响

- **零代码性能开销**：仅增加条件检查，与现有文本处理同量级（纳秒级）
- **网络开销**：reasoning_content 作为历史消息回传，增加 token 数，但这是 Kimi 生成的内容，必须回传否则报错

---

## 提交信息

```
fix: preserve reasoning_content for OpenAI-compatible providers (Kimi, DeepSeek R1)

Providers like Kimi and DeepSeek R1 return reasoning_content in their
SSE stream and expect it back in subsequent requests. The OpenAI shim
was silently discarding this field, causing 400 errors on multi-turn
conversations with tool calls.

- Add reasoning_content to OpenAIStreamChunk delta type
- Convert reasoning_content to Anthropic thinking blocks during streaming
- Reconstruct reasoning_content from thinking blocks when sending history
- Properly close thinking blocks on stream finish and before text blocks
```

commit: `50fdc4b`

---

## 测试验证

用以下配置测试多轮对话：

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=<kimi-api-key>
export OPENAI_BASE_URL=https://api.kimi.com/coding/v1
export OPENAI_MODEL=kimi-for-coding

bun run dev
# 执行包含工具调用的多轮对话，不应再报 reasoning_content is missing 错误
```

---

## 相关文件

- `src/services/api/openaiShim.ts`：主要改动文件，包含流处理和消息转换逻辑
