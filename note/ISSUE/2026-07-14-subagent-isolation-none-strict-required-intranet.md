# [已修复] 内网 OpenAI 兼容接口下 subagent 可选枚举字段被 strict 模式强制必填，模型乱填 "none" 触发 InputValidationError

> **TL;DR**：完善 OpenAI 接口对 subagent 枚举字段的兼容性，保障 subagent 链路可用，且支持自主开启 worktree 隔离（在独立 git 分支副本中运行，改动不影响主工作区），为高风险操作提供沙箱保护。
>
> **状态**：✅ 方案 A + 定向泛化（isolation 容错 + model 窄判收口）已完成（2026-07-14）；方案 B 评估后暂缓
>
> **分支**：`feature/default-provider-openai`
>
> **报错现象**：
> ```
> InputValidationError: [{ "code": "invalid_value", "values": ["worktree"],
>   "path": ["isolation"], "message": "Invalid input: expected \"worktree\"..." }]
> ```
>
> **涉及文件**：
> - `src/tools/AgentTool/AgentTool.tsx`（`isolation` / `cwd` 等可选字段的 schema）
> - `src/services/api/openaiShim.ts`（`normalizeSchemaForOpenAI` / `convertTools` strict 模式）

---

## 问题概述

内网走 OpenAI 兼容 shim（`getAPIProvider()` 为 `openai` / `codex` / `gemini` / `github`），编排 LLM 是非 Claude 模型。运行 subagent 时，模型给**可选枚举字段**主动填了一个枚举外的"占位值" `"none"`（也可能是空串），回到我方用原始 zod schema 校验时落选，抛 `InputValidationError`。

具体到本次：AgentTool 的 `isolation` 字段定义为 `z.enum(['worktree']).optional()`（[AgentTool.tsx:100](../../src/tools/AgentTool/AgentTool.tsx#L100)），只接受 `'worktree'` 一个值、且可省略。但模型输出了 `isolation: "none"`，`"none"` 不在枚举里 → 校验失败。

> 注：`isolation` 的 `("external" === 'ant' ? ... : z.enum(['worktree']))` 三元里，`"external"` 是构建时 `USER_TYPE` 宏被替换成的字面量，恒不等于 `'ant'`，故 external 构建下枚举实为单值 `['worktree']`。

## 根因：strict 模式把「可选」翻译成了「必填」

这**不是** OpenAI 协议本身会传 `"none"`，而是 shim 的 schema 翻译在作祟：

看 [openaiShim.ts:423-429](../../src/services/api/openaiShim.ts#L423-L429)，`normalizeSchemaForOpenAI` 在 strict 模式下：

```js
if (strict) {
  // OpenAI strict mode requires every property to be listed in required[]
  const allKeys = Object.keys(normalizedProps)
  record.required = Array.from(new Set([...existingRequired, ...allKeys]))
  record.additionalProperties = false
}
```

OpenAI 的 strict 结构化输出**不支持「可选字段」这个概念**——一个属性要么必填、要么不存在。为合规，shim 只能把所有属性（含 `.optional()` 的 `isolation` / `cwd`）统统塞进 `required[]`。`convertTools` 对非 Gemini 网关默认开启 `strict: true`（[openaiShim.ts:485-489](../../src/services/api/openaiShim.ts#L485-L489)）。

### 与原生 Anthropic 协议的差异

| | 原生 Anthropic | OpenAI 兼容 shim |
|---|---|---|
| 可选字段 | schema 如实保留「可选」 | strict 强制提升为 required |
| 模型行为 | Claude 训练过：不需要就省略，不臆造枚举外值 | 非 Claude 模型被逼填值 → 给 `"none"` 占位 |
| enum 约束 | Anthropic 采样遵守 enum | 内网网关（vLLM/Ollama）通常只保证 JSON 结构，不做 enum 级约束解码，`"none"` 顺利过线 |

三者叠加：原生协议下 Claude 直接**不输出** `isolation`，`"none"` 根本不会产生；OpenAI shim 下字段被迫必填、模型乱填、网关不拦、回程校验炸。

## 调用链说明

```
── 我方 zod schema ──────────────────────────────────────────────
AgentTool.inputSchema: isolation = z.enum(['worktree']).optional()

── shim 翻译（convertTools → normalizeSchemaForOpenAI, strict=true）──
isolation 被塞进 required[]，additionalProperties=false
  → 发给内网 OpenAI 兼容网关的 schema 中 isolation 变「必填」

── 模型生成 ─────────────────────────────────────────────────────
模型被告知 isolation 必填，但语义上不想开 worktree
  → 输出 isolation: "none"（枚举外的「不适用」占位）
  → 内网网关不做 enum 级约束解码 → "none" 过线

── 回程校验 ─────────────────────────────────────────────────────
Anthropic 工具调用用原始 zod schema 校验 isolation
  → z.enum(['worktree']) 不含 "none"
  → ❌ InputValidationError
```

## 反讽：strict 是为了修相反的问题才加的

strict 约束解码是 **2026-05-10** 为解决「非 Claude 模型在概率采样下**漏传 required 字段**」（如 Grep 缺 `pattern`）而引入的（见 [openaiShim.ts:485-487](../../src/services/api/openaiShim.ts#L485-L487) 注释）。它治好了「漏传必填」，却带来副作用：**把可选字段也一并变必填，逼模型给可选枚举字段乱填 `"none"`**。

## 与既有问题的同源性

本问题与以下两项是「Anthropic 工具 schema 语义在翻译到 OpenAI 兼容协议时被扭曲/丢失」的不同侧面：

1. **subagent 模型别名 fallback**（见 `2026-06-29-subagent-model-alias-fallback-intranet.md`）——模型主动传 `sonnet`/`haiku` 别名，解析到内网不存在的 `gpt-4o`。已通过对 openai 隐藏 `model` 参数缓解，但窄判 `=== 'openai'` 漏了 codex/gemini/github。
2. **ToolSearch/tool_reference beta 提示泄漏**——`isToolSearchEnabledOptimistic()` 的关闭闸门只判 `firstParty`（[toolSearch.ts:299](../../src/utils/toolSearch.ts#L299)），非 Anthropic 直连 provider 未关闭，subagent 仍收到「deferred tools via ToolSearch」系统提示。

三者的共同病根：**大量 `getAPIProvider() === 'openai'` 的精确匹配，应统一为「是否 Anthropic 直连」**（已有现成的 [`isOpenAICompatibleProvider()`](../../src/utils/model/providers.ts#L44)）。

## 拟定修复方案

### 方案 A（✅ 已完成，治标、低风险）— AgentTool 侧容错

worktree 隔离基于 git、与 provider 无关，openai 用户也可能要用，**不宜像 `model` 那样对 openai 整个隐藏**。改用 `z.preprocess` 把枚举外的值吞成 `undefined`：

```ts
// AgentTool.tsx:100-107（实际实现，白名单动态跟随当前 enum）
const isAnt = "external" === 'ant';
const allowed = isAnt ? ['worktree', 'remote'] as const : ['worktree'] as const;
isolation: z.preprocess(
  v => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v : undefined),
  (isAnt ? z.enum(['worktree', 'remote']) : z.enum(['worktree'])).optional()
).describe(...)
```

> 相比文档原始草案，实现时增加了：(1) `typeof v === 'string'` 防止模型吐 `false`/数字炸 `includes`；(2) 白名单动态跟随 `isAnt` 分支，external 构建下 `"remote"` 也会被静默丢弃而非报 `invalid_enum_value`。

模型传 `isolation: "none"` 会被静默丢弃（等价于不隔离），不再报错；`"worktree"` 仍正常工作。

### 方案 B（🟡 评估后暂缓）— shim 侧让被迫必填的可选枚举接受中性值

**原设想**：在 `normalizeSchemaForOpenAI` 中，对因 strict 被提升为 required 的可选枚举字段，给 enum 补中性值（如允许 `""`/`"none"`）或改成 nullable，并在回程归一化。

**暂缓结论（2026-07-14 评估）**：不建议现在推进，理由如下：

1. **兜底层永远在我方 zod 校验**：内网网关（vLLM/Ollama）不做 enum 级约束解码，即使 shim 把字段改成 nullable/补中性值，模型仍可能吐 `"none"` 而非 `null`。shim 只能**降低**发生率，无法兜底——真正 airtight 的只能是我方校验层的容错（即方案 A）。
2. **注入中性值会污染模型语义**：给每个可选枚举补 `"none"` 会改变模型看到的 schema，反而可能诱导模型"合法地"主动选 `"none"`。
3. **回程剥离缺少 schema 上下文**：shim 解析 tool_call 参数时没有 per-field schema，难以精确把中性值/null 归一化回 undefined。
4. **回归面覆盖全部工具**：为一个"减少频率"的效果承担所有工具的 schema 回归，性价比低。

结论：shim 只能锦上添花、不能替代方案 A，故降级为**远期硬化项**，非必要不做。

### 方案 A′（✅ 推荐后续）— 定向泛化方案 A

把方案 A 的容错抽成共享 helper，只贴在**真正有 crash 风险的少数可选枚举 tool 输入**上，成本低、无回归面：

```ts
// utils：把"被 strict 逼填的枚举外值"统一吞成 undefined
export function optionalEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    v => (typeof v === 'string' && (values as readonly string[]).includes(v) ? v : undefined),
    z.enum(values).optional(),
  )
}
```

**风险审计（2026-07-14 全项目扫描）**——crash 类 = 会被 strict 强制必填、且模型常态诉求是"都不要"的可选枚举 tool 输入：

| 字段 | 风险 | 处置 |
|---|---|---|
| `AgentTool.isolation` | — | ✅ 方案 A 已修 |
| `AgentTool.model`（[:87](../../src/tools/AgentTool/AgentTool.tsx#L87)） | ✅ 已修 | 见下方「model 窄判收口」 |
| `GrepTool.mode`、`ConfigTool.operation` | 低 | 枚举值即模型想要的真值，倾向填合法值；内网实测再定 |
| `loadAgentsDir` 的 effort/permissionMode/memory | 不涉及 | 解析 agent 定义文件 frontmatter，不作为 tool schema 发给 LLM，不经 strict |

**关键洞察**：crash 最易发生在「枚举值全是 opt-in、而模型常态诉求恰是"都不要"」的字段——`isolation`（只有 worktree）与 `model`（只有 sonnet/opus/haiku，无"不覆盖"）正属此类，模型只能去够 `"none"`；`mode`/`operation` 模型本就想选真值，风险低。

**model 窄判收口（✅ 已完成，并入本 issue）**：`AgentTool.model` 的 `.omit({ model: true })` 原先只在 `getAPIProvider() === 'openai'` 时触发，codex/gemini/github 仍暴露该字段 → 模型可填 `"none"`/别名 → 回程校验炸。已把窄判 `=== 'openai'` 改为 `isOpenAICompatibleProvider()`（[AgentTool.tsx:137](../../src/tools/AgentTool/AgentTool.tsx#L137)，[providers.ts:44](../../src/utils/model/providers.ts#L44)），让所有非 Anthropic 直连 provider 一致隐藏 model 参数，同步更新了 import 与注释。此举同时收口「同源病根」（大量 `=== 'openai'` 精确匹配应统一为"是否 Anthropic 直连"）。

> 尚未收口的同类窄判：ToolSearch 闸门（[toolSearch.ts:299](../../src/utils/toolSearch.ts#L299) 只判 `firstParty`）、`getAgentModelOptions()`（[agent.ts:139](../../src/utils/model/agent.ts#L139) 只判 `=== 'openai'`）。留作后续。

## 验证

- [x] `bun run build`
- [x] 新增测试：模型传 `isolation: "none"` 时不报错、被当作未隔离 → `src/tools/AgentTool/AgentTool.test.ts`（6 条用例：`none` / `""` / `worktree` / 省略 / `false` 非字符串守卫 / external 下 `remote` 被白名单吞）
- [x] `bun run smoke`
- [x] `bun test --max-concurrency=1` → 615 pass, 0 fail（含 model 窄判收口后回归）
- [x] model 窄判收口：`.omit({ model })` 改用 `isOpenAICompatibleProvider()`，覆盖 codex/gemini/github

## 内网实测建议

1. openai/codex provider 下触发一次带 subagent 的技能（如 `/init`），确认不再出现 `isolation` 相关的 `InputValidationError`
2. 显式让子代理走 worktree（若适用），确认 `isolation: "worktree"` 仍能正常创建隔离工作树
3. 观察工具调用参数卡片：`model` 字段应不出现（Phase 4 已修），`isolation` 即使被模型填 `"none"` 也应被吞掉

## 关联

- subagent 模型别名 fallback：`note/ISSUE/2026-06-29-subagent-model-alias-fallback-intranet.md`
- USE_OPENAI 标志 fallback 覆盖不全：`note/ISSUE/2026-06-12-use-openai-flag-fallback-incomplete.md`
- 品牌去标识工程：`note/BRAND_MIGRATION_2026-06-07/START_HERE.md`
