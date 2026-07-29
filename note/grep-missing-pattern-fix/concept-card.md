# 问题原因

这个错误发生在底层 LLM 调用 Grep 工具时，没有传入必须的 pattern 参数。

错误的完整生成路径：

模型发出工具调用：Grep({"path": "src/", "glob": "*.ts"}) ← 缺少 pattern
  ↓
toolErrors.ts:107 捕获到 Zod 校验失败，生成：
  The required parameter `pattern` is missing
  ↓
toolExecution.ts:670 包装成：
  InputValidationError: Grep failed due to the following issue: ...

---

# 核心概念

## 1. Schema（参数身份证）

**Schema** 是工具参数的"身份证"，描述了调用工具时必须给什么、可以选填什么。

以 Grep 工具为例（GrepTool.ts:33-89）：

```ts
z.strictObject({
  pattern: z.string(),              // ← 必填（没写 .optional()）
  path: z.string().optional(),      // ← 可选（写了 .optional()）
  glob: z.string().optional(),      // ← 可选
  output_mode: z.enum([...]).optional(), // ← 可选
})
```

| 字段 | 类型 | 是否必填 | 含义 |
|------|------|----------|------|
| `pattern` | string | **是** | 正则表达式，搜索内容 |
| `path` | string | 否 | 搜索路径，默认当前目录 |
| `glob` | string | 否 | 文件过滤模式，如 `"*.ts"` |
| `output_mode` | enum | 否 | 输出模式：content / files_with_matches / count |

模型在调用工具前会先"看"这张身份证，知道要传哪些参数。

---

## 2. 约束解码（Constrained Decoding）

**约束解码**是 API 后端的一种能力：在模型生成 tool_use JSON 的**每一个字符时**，实时检查"这个字符放这里是否合法"，不合法的直接屏蔽。

### 没有约束解码（自由写作）

模型像自由写作，从整个词表里挑下一个词：

```
模型开始写：{ "path": "src/utils/" }
写完后想：接下来写什么？
可选：",", "}", "pattern", "glob", "foo"...
模型可能觉得"列出文件"的任务已完成，选了 "}"
→ 结果：{ "path": "src/utils/" }    ← 漏了 pattern！
```

Schema 只是"建议"，模型可以不听。

### 有约束解码（监工实时检查）

模型写到 `{ "path": "src/utils/"` 时，监工马上介入：

> "根据 schema，`pattern` 是 required 字段，你还没写，所以下一个字符**只能是** `,` 接着写 `pattern`。`}` 这个选项我给你屏蔽了。"

```
模型写到：{ "path": "src/utils/" }
监工检查：pattern 还没出现，且是 required
屏蔽选项："}"
保留选项：","
模型只能选：, "pattern": "..."
→ 结果：{ "path": "src/utils/", "pattern": "foo" }   ← 不可能漏掉
```

**关键点**：约束解码发生在**生成过程中**（物理层面阻止），不是生成后再检查。

---

## 3. Claude API vs OpenAI 兼容 API 的差异

| 维度 | Claude API | OpenAI 兼容 API |
|------|-----------|----------------|
| 约束解码开关位置 | `tool.strict: true`（工具定义外层） | `function.strict: true`（工具定义外层） |
| ywcoder 是否已设置 | ✅ 已设置（api.ts:191） | ❌ **遗漏**（openaiShim.ts:485 缺少） |
| 后端是否启用约束解码 | 是 | 否（因为开关没开） |
| 模型能否漏传 required 字段 | **不能**（物理上被阻止） | **能**（自由采样，概率性发生） |

### Claude API 的请求结构

```json
{
  "name": "Grep",
  "description": "...",
  "input_schema": { "pattern": { "type": "string" }, ... },
  "strict": true   // ← Anthropic 后端据此启动约束解码
}
```

### OpenAI 兼容 API 的请求结构（当前 ywcoder 实际发出）

```json
{
  "type": "function",
  "function": {
    "name": "Grep",
    "description": "...",
    "parameters": {
      "type": "object",
      "properties": { "pattern": { "type": "string" }, ... },
      "required": ["pattern", ...],
      "additionalProperties": false
    }
    // ↑ 没有 strict: true！网关不会启动约束解码
  }
}
```

**注意**：schema 本身（properties / required / additionalProperties）是完整且正确的，问题出在**外层的 `strict` 开关缺失**。

---

## 4. 为什么有时候报错，有时候不报错？

这是一个**概率问题**，不是必然问题。

| 因素 | 说明 |
|------|------|
| 采样随机性 | 温度 > 0 时，模型每次生成都有随机性 |
| 提示词诱导 | "列出 src/utils/ 下的文件"容易让模型觉得只需传 `path` |
| 模型能力差异 | Qwen3 比 Claude 4.6 更容易在细节参数上出错 |
| 大多数时候 | 模型训练过大量 tool_use 示例，知道 `pattern` 重要，所以通常能写对 |

**结论**：不是每次都漏，而是"偶尔手滑"。没有约束解码时，这种手滑无法被物理阻止。

---

## 5. 三者关系图（pattern → schema → strict）

```
┌─────────────────────────────────────────────────────────────┐
│                     ywcoder 内部工具定义                      │
│  GrepTool.ts:165  strict: true                               │
│  GrepTool.ts:33   inputSchema（Zod 定义，pattern 必填）       │
└─────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
      Claude API 路径              OpenAI 兼容 API 路径
      (src/utils/api.ts)           (src/services/api/openaiShim.ts)
              │                           │
              ▼                           ▼
      请求体带上 strict: true      请求体没带上 strict: true
      （api.ts:191）               （openaiShim.ts:485 遗漏）
              │                           │
              ▼                           ▼
      Anthropic 后端启动           网关不启动约束解码
      约束解码                      │
              │                           ▼
              ▼              模型自由生成 JSON，偶尔漏字段
      模型无法生成非法 JSON         │
              │                           ▼
              ▼              Zod 校验（toolExecution.ts）发现
      不会报错                      pattern 缺失 → InputValidationError
```

---

# 根本原因（修订版）

早期认为是"非 Claude 模型不遵守 schema"，但深入分析后发现：

> **ywcoder 已经把完整 schema 传给了网关，但客户端遗漏了 OpenAI 协议层的 `function.strict: true` 开关，导致网关侧无法启动约束解码。**

这不是模型"不听话"，而是**客户端没告诉网关"请强制模型听话"**。

---

# 解决思路

## 选项 C（治本，推荐）：启用 `function.strict: true`

在 `openaiShim.ts:485` 添加 `strict: true`，让网关启动约束解码。

```ts
return {
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description ?? '',
    strict: true,                          // ← 新增
    parameters: normalizeSchemaForOpenAI(schema, !isGemini),
  },
}
```

- **优点**：触及根因，所有工具的必填字段都受益，改动仅 1 行
- **风险**：需确认网关支持，Ollama/老版 vLLM 可能返回 400

## 选项 A（治标，兜底）：客户端注入默认值

在 `toolArgumentNormalization.ts` 中，当 Grep 缺少 `pattern` 且 `output_mode` 为 `files_with_matches` 时，注入 `".*"`。

- **优点**：不依赖网关，执行路径确定
- **缺点**：语义污染，把 Grep 悄悄变成 Glob，可能让模型形成错误习惯

## 选项 B（辅助）：改进错误提示

在 `toolErrors.ts` 中对 Grep + pattern 缺失的场景追加更明确的重试引导。

- **优点**：语义准确，不猜测意图
- **缺点**：依赖模型重试，Qwen 重试成功率不稳定

---

# pattern 是什么

`pattern` 是 Grep 工具的搜索正则表达式，告诉 ripgrep 要在文件内容里找什么字符串。

类比命令行：

```bash
# Grep 工具调用等价于：
rg "pattern" path/ --glob "*.ts"
#    ^^^^^^^^
#    这就是 pattern 参数
```

举几个例子：

| pattern 值 | 含义 |
|-----------|------|
| `"useState"` | 查找包含 useState 的行 |
| `"import.*from"` | 用正则匹配所有 import 语句 |
| `"TODO\|FIXME"` | 查找 TODO 或 FIXME |
| `"function\s+\w+"` | 查找所有函数定义 |
| `".*"` | 匹配所有内容（兜底注入时用的默认值） |
