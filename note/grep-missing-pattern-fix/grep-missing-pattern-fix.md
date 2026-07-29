# Grep 工具缺少 pattern 参数的兜底处理

## 背景

使用 Qwen3.5-27B（或其他非 Claude 模型）时，模型有时会调用 `Grep` 工具却不携带必须的 `pattern` 参数，例如：

```json
{ "path": "src/utils/", "glob": "*.ts" }
```

这会触发 Zod 校验失败，最终向用户和模型返回：

```
InputValidationError: Grep failed due to the following issue: The required parameter `pattern` is missing
```

模型收到该错误后不一定能正确恢复，导致对话卡住或反复出错。

## 根本原因分析（修订）

### 一、Claude API 与 OpenAI 兼容 API 的约束机制差异

- **Claude API**：`GrepTool` 定义了 `strict: true`，Anthropic 后端会做**约束解码（constrained decoding）**，模型在生成 tool_use JSON 时物理上无法省略 required 字段。
- **OpenAI 兼容 API**：约束解码的开关是**工具定义的 `function.strict: true` 字段**（OpenAI 官方协议），而非 schema 内部字段。

### 二、ywcoder 当前的真实行为（与早期分析的修正）

查阅 [src/services/api/openaiShim.ts](src/services/api/openaiShim.ts) 后发现：

1. [openaiShim.ts:485](src/services/api/openaiShim.ts#L485) 中 `convertTools` 调用 `normalizeSchemaForOpenAI(schema, !isGemini)`，[openaiShim.ts:423-429](src/services/api/openaiShim.ts#L423-L429) 内部确实已将 `pattern` 等字段全部塞入 `required[]`，并设置了 `additionalProperties: false`：

   ```ts
   if (strict) {
     record.required = Array.from(new Set([...existingRequired, ...allKeys]))
     record.additionalProperties = false
   }
   ```

   也就是说，**`pattern` 已作为 required 字段发给了网关，schema 信息没有丢失**。

2. 但 [openaiShim.ts:480-487](src/services/api/openaiShim.ts#L480-L487) 在生成 OpenAI 工具定义时**没有设置 `function.strict: true`**：

   ```ts
   return {
     type: 'function' as const,
     function: {
       name: t.name,
       description: t.description ?? '',
       parameters: normalizeSchemaForOpenAI(schema, !isGemini),
       // ↑ 缺少 strict: true 开关
     },
   }
   ```

   OpenAI / vLLM 实现约束解码的开关是 `function.strict: true`，没有它，即使 schema 已标明 required，**网关也不会真正强制约束**。

### 三、修订后的根因

> ywcoder 已经把 schema 完整传给了网关，但**没有启用 OpenAI 协议层的 `function.strict: true` 开关**，导致网关侧无法启动约束解码，Qwen3 在概率性采样下偶尔漏传 `pattern`。

这与"strict 语义无法透传"的早期判断不同——本质是**客户端没启用约束开关**，不是协议或网关能力问题。

## 问题定位

- **错误生成**：`src/utils/toolErrors.ts` → `formatZodValidationError`
- **触发位置**：`src/services/tools/toolExecution.ts` → Zod schema parse 失败时
- **规范化入口**：`src/services/api/toolArgumentNormalization.ts` → `normalizeToolArguments`
- **约束开关缺失位置**：`src/services/api/openaiShim.ts:480-487` → `convertTools`

当 `normalizeToolArguments` 收到合法 JSON 对象（如 `{"path":"src/"}`）时，直接原样返回，不做任何补全，随后 Zod 报 `pattern` 缺失。

---

## 方案对比

### 方案 C（推荐优先尝试）：在 `convertTools` 中启用 `strict: true`

**位置**：`src/services/api/openaiShim.ts`

**改动**：在 OpenAI 工具定义中添加 `strict: true`，让网关侧启用约束解码。

```ts
// openaiShim.ts:480
return {
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description ?? '',
    strict: true,                                   // ← 新增
    parameters: normalizeSchemaForOpenAI(schema, !isGemini),
  },
}
```

**优点**：
- **触及根因**：在协议层启用约束解码，从源头消除概率性漏字段
- 不依赖任何客户端补全或猜测
- 不污染工具语义
- 改动只有 1 行
- 不仅修复 Grep 漏 `pattern`，**所有工具的 required 字段都会受益**

**风险**：
- 需先确认内网网关与 Qwen3 vLLM 服务支持 OpenAI `function.strict`。Ollama 和老版 vLLM 不支持，开启可能直接 400
- 如果支持但实现不完整，行为可能比当前差
- 可能影响其他通过 OpenAI shim 的 provider（Codex、本地模型等）

**前置条件**：必须用 curl 验证内网网关支持（详见"前置验证步骤"章节）。

**改动规模**：1 行新增，单文件。

**影响范围**：所有走 OpenAI shim 的 provider 的所有工具调用——影响面较大，需要灰度。可考虑加 feature flag 或环境变量开关。

---

### 方案 A（C 不可行时的次选）：客户端注入默认 pattern

**位置**：`src/services/api/toolArgumentNormalization.ts`

**改动**：在解析为合法 JSON 对象之后，当 `toolName === 'Grep'` 且缺少 `pattern`、且 `output_mode` 不是 `content`/`count` 时，注入 `".*"`。

> **注意：基础版（无条件注入）不推荐**，必须使用下述"加强版"。原因详见"缺点 #1"。

```ts
// 改动前
if (isRecord(parsed)) {
  return parsed
}

// 改动后（加强版：仅在 files_with_matches 模式下注入）
if (isRecord(parsed)) {
  if (
    toolName === 'Grep' &&
    !('pattern' in parsed) &&
    parsed.output_mode !== 'content' &&
    parsed.output_mode !== 'count'
  ) {
    return { pattern: '.*', ...parsed }
  }
  return parsed
}
```

**`".*"` 的实际效果**：

| output_mode                  | 注入 `".*"` 的效果                  | 加强版是否注入 |
| ---------------------------- | ----------------------------------- | -------------- |
| `files_with_matches`（默认） | 返回目录下所有非空文件，等价于 Glob | ✓ 注入         |
| `content`                    | 返回所有文件的所有行，结果量极大    | ✗ 走报错       |
| `count`                      | 返回每个文件总行数，语义无意义      | ✗ 走报错       |

**优点**：
- 不依赖模型重试，执行路径确定，不会陷入错误循环
- 无额外 token 消耗
- 覆盖最常见场景（模型省略 `pattern` 通常意图是列文件）

**缺点**：
1. **语义污染**：把 `Grep` 悄悄变成了 `Glob`，可能使模型形成错误的工具使用习惯——下次它"发现 Grep 不带 pattern 也能用"，可能更频繁地省略，副作用持久化。
2. **静默成功的风险**：模型本意做内容搜索却漏传 `pattern` 时（虽然在 `content`/`count` 模式下已被排除），仍可能掩盖真实意图，下游推理走偏，**没有错误信号让用户察觉问题**。
3. **基础版（无 output_mode 判断）会在 content 模式下返回海量内容**，完全不可接受，因此**必须使用加强版**。

**改动规模**：约 6 行（加强版），无删除。

---

### 方案 B（C 不可行时的补充）：改进错误提示，引导模型重试

**位置**：`src/utils/toolErrors.ts`

**改动**：在 `formatZodValidationError` 中，当缺失参数为 `pattern` 且工具为 `Grep` 时，在错误消息末尾追加重试引导。

```ts
// 改动前
;(param) => `The required parameter \`${param}\` is missing`

// 改动后（仅对 Grep + pattern 追加引导）
// 例：The required parameter `pattern` is missing.
//     Please retry and include `pattern` (a regex to match file contents, e.g. "function foo").
```

**优点**：
- 语义更准确，让模型自己纠正，不猜测意图
- 不注入可能有副作用的默认值
- 不污染工具语义

**缺点**：
- 依赖模型能正确响应错误并重试——而 Qwen 在这方面不稳定，可能再次漏传 `pattern`
- 每次出错都多一次模型往返，消耗额外 token 和时间
- 极端情况下可能反复出错形成循环（**需确认 `toolExecution` 是否有"同名工具反复失败"的退出机制**，否则需要单独加上限保护）
- **无法达到约束解码的效果**：两次采样都是独立的概率过程，改进提示只能提高重试成功率，不能保证

**改动规模**：约 5 行，需将 `toolName` 参数传入或在调用处特判。

---

## 综合评估（修订）

| 维度             | 方案 C（推荐）              | 方案 A（加强版）        | 方案 B                     |
| ---------------- | --------------------------- | ----------------------- | -------------------------- |
| 是否触及根因     | 是                          | 否                      | 否                         |
| 是否依赖模型重试 | 否（约束解码）              | 否                      | 是                         |
| 额外 token 消耗  | 无                          | 无                      | 每次出错多一次往返         |
| 语义准确性       | 完全准确                    | 仅 files 模式准确       | 准确（让模型纠正）         |
| 稳定性           | 高（如果网关支持）          | 高（路径确定）          | 中（取决于 Qwen 重试行为） |
| 改动规模         | 1 行，单文件                | 约 6 行，单文件         | 约 5 行，单文件            |
| 影响范围         | 所有走 shim 的工具          | 仅 Grep 缺 pattern 场景 | 仅 Grep 缺 pattern 场景    |
| 主要风险         | 网关不支持 → 直接 400       | 语义污染、静默成功      | 重试循环                   |

## 实施建议

**推荐顺序**：

1. **优先尝试方案 C**（修改 `convertTools` 加 `strict: true`）。**前置条件**：用 curl 验证内网网关支持（详见下节）。
2. 如果 C 不可行（网关返回 400 或行为退化），**采用方案 A 的加强版**（仅 files_with_matches 模式注入 `".*"`）。
3. 方案 B 可作为方案 A 的补充：在 `content`/`count` 模式下走 B 的路径返回更明确的引导提示，与方案 A 配合形成"列文件场景兜底 + 内容搜索场景引导"的完整闭环。
4. 如果选择方案 B，需检查 `toolExecution` 是否有"同名工具反复失败"的退出机制，否则需要单独加上限保护。

---

## 前置验证步骤：如何用 curl 验证内网网关是否支持 `strict: true`

### 一、目标

确认内网网关在收到 `function.strict: true` 时：
- ✅ 接受请求并启用约束解码（最佳）
- ⚠️  接受请求但忽略 strict（次佳，行为不变）
- ❌ 直接返回 400（不可用，方案 C 不可行）

### 二、准备工作

从环境变量或配置文件取出：
- `$GATEWAY_URL`：内网网关地址（如 `https://gateway.internal/v1`）
- `$API_KEY`：访问令牌
- `$MODEL`：实际模型 ID（如 `qwen3.5-27b`）

### 三、测试 1：协议接受测试（基础）

发送一个带 `function.strict: true` 的最小请求，看 HTTP 状态码。

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST "$GATEWAY_URL/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$MODEL"'",
    "messages": [
      {"role": "user", "content": "Search for the word foo in src/utils/"}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "Grep",
        "strict": true,
        "description": "Search file contents using regex",
        "parameters": {
          "type": "object",
          "properties": {
            "pattern": {"type": "string", "description": "regex to search"},
            "path": {"type": "string", "description": "directory to search"}
          },
          "required": ["pattern", "path"],
          "additionalProperties": false
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

**判断标准**：
- `HTTP 200`：网关接受 `strict` 字段，**进入测试 2**
- `HTTP 400` 且响应体含 "strict"/"unknown field"/"invalid"：**网关不支持，方案 C 不可行**
- `HTTP 4xx`（其他原因）：检查认证、模型名等基础配置

### 四、测试 2：行为差异测试（关键）

测试 1 通过后，需要确认 `strict: true` **真的生效了**，而不是被静默忽略。

构造一个**容易诱导模型漏字段**的提示，分别在 `strict: true` 和 `strict: false` 下各跑 10 次，统计模型生成的 tool_call 是否都包含 `pattern`：

```bash
# 准备一个会让模型偏向只填 path 的诱导提示
PROMPT='List all TypeScript files under src/utils/'

# 跑两组各 10 次（注意：实际生产中 temperature 通常 > 0，这里特意保持默认让概率性出现）
for STRICT in true false; do
  echo "=== strict: $STRICT ==="
  MISSING=0
  for i in $(seq 1 10); do
    RESP=$(curl -sS -X POST "$GATEWAY_URL/chat/completions" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "model": "'"$MODEL"'",
        "messages": [{"role": "user", "content": "'"$PROMPT"'"}],
        "tools": [{
          "type": "function",
          "function": {
            "name": "Grep",
            "strict": '"$STRICT"',
            "description": "Search file contents using regex",
            "parameters": {
              "type": "object",
              "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
                "glob": {"type": "string"}
              },
              "required": ["pattern", "path", "glob"],
              "additionalProperties": false
            }
          }
        }],
        "tool_choice": "auto"
      }')
    # 提取 tool_call.arguments，检查是否含 "pattern"
    ARGS=$(echo "$RESP" | jq -r '.choices[0].message.tool_calls[0].function.arguments // empty')
    if [ -n "$ARGS" ] && ! echo "$ARGS" | grep -q '"pattern"'; then
      MISSING=$((MISSING + 1))
      echo "  Run #$i 漏字段: $ARGS"
    fi
  done
  echo "  $STRICT 模式：10 次中 $MISSING 次漏 pattern"
  echo ""
done
```

**判断标准**：

| `strict: true` 漏字段次数 | `strict: false` 漏字段次数 | 结论 |
|---|---|---|
| 0 | 0 | 模型本身稳定，无法验证 strict 是否生效，需用更难的诱导 prompt 重测 |
| 0 | ≥1 | ✅ **strict 真的生效**，方案 C 可用 |
| ≥1 | ≥1（差不多） | ⚠️ 网关静默忽略 strict，方案 C 不可用，回退方案 A |
| ≥1 | 0 | 异常情况，可能 prompt 设计有问题，重新设计 |

### 五、测试 3：兼容性回归（可选）

如果测试 1、2 都通过，再用其他工具（如 `Read`、`Bash`）做一轮 strict 调用，确认网关对所有 schema 都能正确处理，不会对某些 schema 报错。

### 六、验证产物

| 测试项 | 结果 | 说明 |
| ------ | ---- | ---- |
| **测试 1：协议接受** | ✅ 通过 | HTTP 200，网关接受 `function.strict: true` 字段，未返回 400 |
| **测试 2：行为差异（Prompt 1）** | ⚠️ 无法验证 | `strict: true` 0 次漏 pattern，`strict: false` 0 次漏 pattern。模型本身稳定，未触发概率性漏字段 |
| **测试 2：行为差异（Prompt 2）** | ⚠️ 无法验证 | `strict: true` 0 次漏 pattern；`strict: false` 0 次漏 pattern（Run #8 无 tool_calls）。结果与 Prompt 1 一致 |
| **测试 3：兼容性回归** | — 未执行 | — |

**决策结论**：
- 测试 1 通过说明网关**兼容** `strict` 字段，不会因该字段报错。
- 测试 2 两次均未在统计上区分 `strict` 是否生效（Qwen3.5-27B 本身在简单 prompt 下输出稳定）。但约束解码的意义是**确定性兜底**而非概率优化，在生产环境的复杂上下文/多轮对话中仍有关键价值。
- 综合判断：**方案 C 可行**，在 `convertTools` 中为非 Gemini provider 启用 `strict: true`。如后续观察到网关静默忽略或出现兼容性问题，再回退到方案 A。
- 方案 A 暂不实施，保留为备选兜底策略。

---

## 测试要点（代码实现后）

参考已有测试文件：`src/services/api/toolArgumentNormalization.test.ts`

### 方案 A 加强版的测试用例

追加测试用例（不修改已有用例）：

| 输入                                                          | 预期结果                                       |
| ------------------------------------------------------------- | ---------------------------------------------- |
| `Grep, '{"path":"src/"}'`                                     | `{ pattern: ".*", path: "src/" }`              |
| `Grep, '{"glob":"*.ts"}'`                                     | `{ pattern: ".*", glob: "*.ts" }`              |
| `Grep, '{"path":"src/","output_mode":"content"}'`             | `{ path: "src/", output_mode: "content" }`（不注入，走报错） |
| `Grep, '{"path":"src/","output_mode":"count"}'`               | `{ path: "src/", output_mode: "count" }`（不注入，走报错）   |
| `Grep, '{"pattern":"foo","path":"src/"}'`                     | `{ pattern: "foo", path: "src/" }`（不覆盖）   |
| `Grep, '{"pattern":""}'`                                      | `{ pattern: "" }`（空字符串不覆盖）            |
| `Glob, '{"path":"src/"}'`                                     | `{ path: "src/" }`（Glob 不受影响）            |
| `Bash, '{"command":"ls"}'`                                    | `{ command: "ls" }`（其他工具不受影响）        |

### 方案 C 的测试要点

如选用方案 C：
- 添加单测验证 `convertTools` 输出包含 `strict: true`
- 在 Gemini 模式下 `strict` 应保持原有行为（Gemini 不需要也可能不支持）
- 跑现有 provider 测试，确认无回归
