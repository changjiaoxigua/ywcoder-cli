# [已完成] 内网环境子代理硬编码 Anthropic 模型别名导致调用失败或模型选择 UI 异常

> **状态**：✅ 已完成（2026-06-29）
>
> **分支**：`feature/brand-replacement`
>
> **提交**：`7846dc5`（Phase 1-3）、`3a49c20`（Phase 4）
>
> **涉及文件**：
> - `src/tools/AgentTool/built-in/exploreAgent.ts`
> - `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`
> - `src/tools/AgentTool/built-in/statuslineSetup.ts`
> - `src/utils/model/agent.ts`
> - `src/components/agents/ModelSelector.tsx`
> - `src/tools/AgentTool/AgentTool.tsx`

---

## 问题概述

内网走 OpenAI 兼容 shim（`getAPIProvider() === 'openai'`），实际无 Anthropic 系列模型。但三个内置子代理硬编码了 Anthropic 模型别名：

| 子代理 | 原始值 | 风险 |
|--------|--------|------|
| Explore | `USER_TYPE==='ant' ? 'inherit' : 'haiku'` | 内网非 ant 用户走 haiku → `OPENAI_MODEL \|\| 'gpt-4o-mini'`，内网网关无此模型 → 调用失败 |
| claude-code-guide | `'haiku'` | 同上 |
| statusline-setup | `'sonnet'` | `OPENAI_MODEL \|\| 'gpt-4o'`，内网网关若无 gpt-4o 则失败 |

此外还存在三个衍生问题：

1. `getAgentModelOptions()` 函数（子代理模型选择 UI 的数据源）把内网限制硬编码进了通用层——直接删除 Sonnet/Opus/Haiku 三个选项，导致 firstParty/Bedrock/Vertex/Gemini 等其他 provider 的用户子代理模型选择界面也退化为单选。

2. `ModelSelector` 组件在处理「当前值不在选项列表」时，把已知别名（如 `sonnet`）当成自定义 ID 显示，标签文字混乱（`"sonnet (custom ID)"`）。

3. **编排 LLM 本身主动传入别名**：AgentTool 的工具 schema 向 LLM 暴露 `model: z.enum(['sonnet','opus','haiku'])` 枚举，LLM 在执行 `/init` 等技能时会主动为 Explore 子代理指定 `model: sonnet`，显示在工具调用参数卡片里。该字段**会被实际读取并影响 API 调用**（走 `toolSpecifiedModel` 分支，最终 `parseUserSpecifiedModel('sonnet')` → `OPENAI_MODEL || 'gpt-4o'`），`OPENAI_MODEL` 未设时 fallback 到内网不存在的 `gpt-4o` 导致失败。

## 调用链说明

```
── 路径A：子代理定义硬编码别名 ──────────────────────────────────────
agentDef.model = 'haiku'/'sonnet'
  → getAgentModel(agentModel='haiku', parentModel, toolSpecifiedModel=undefined, ...)
  → parseUserSpecifiedModel('haiku')
      → getAPIProvider()==='openai' → OPENAI_MODEL || 'gpt-4o-mini'
      → 内网网关无该模型 → ❌ 调用失败

── 路径B：LLM 主动通过工具调用传入别名 ─────────────────────────────
LLM 调用 Agent(model='sonnet', ...)
  → AgentTool.tsx model: modelParam → const model = modelParam（非 coordinator）
  → getAgentModel(agentDef.model, parentModel, toolSpecifiedModel='sonnet', ...)
  → toolSpecifiedModel 非空，优先走此分支
  → parseUserSpecifiedModel('sonnet')
      → getAPIProvider()==='openai' → OPENAI_MODEL || 'gpt-4o'
      → OPENAI_MODEL 未设时 → ❌ fallback 到 gpt-4o，内网无此模型

── 正确路径：inherit ────────────────────────────────────────────────
agentDef.model = 'inherit'，LLM 不传 model 参数
  → getAgentModel('inherit', parentModel, undefined, ...)
  → getRuntimeMainLoopModel() → 返回父模型（内网配置的唯一模型）✅
```

## 修复内容

### Phase 1 — 内置子代理模型统一改为 inherit（治调用）

三个硬编码别名全部改为 `'inherit'`，子代理直接继承主对话模型，完全绕过别名重映射，不会 fallback 到内网不存在的 `gpt-4o-mini`。

```diff
// exploreAgent.ts
- model: process.env.USER_TYPE === 'ant' ? 'inherit' : 'haiku',
+ model: 'inherit',

// claudeCodeGuideAgent.ts
- model: 'haiku',
+ model: 'inherit',

// statuslineSetup.ts
- model: 'sonnet',
+ model: 'inherit',
```

已是 `inherit` 的子代理（planAgent、verificationAgent、generalPurpose）不动。

### Phase 2 — getAgentModelOptions() 加 provider 条件分支（治架构）

改为在函数内判断 provider，而非无条件截断全部选项。参照 `modelOptions.ts` 里的 `getAPIProvider()` 条件分支模式：

```ts
export function getAgentModelOptions(): AgentModelOption[] {
  if (getAPIProvider() === 'openai') {
    // 内网单模型场景：只返回 inherit
    return [{ value: 'inherit', ... }]
  }
  // 其他 provider 保留完整四选项（sonnet/opus/haiku/inherit）
  return [...]
}
```

### Phase 3 — ModelSelector 已知别名显示可读标签（治 UX）

`initialModel` 不在选项列表时，label 从 raw string 改为 `getAgentModelDisplay(initialModel)`，已有配置 `model: sonnet` 的用户打开编辑器看到的是 "Sonnet" 而非 "sonnet (custom ID)"。

### Phase 4 — AgentTool schema 隐藏 model 参数（治 LLM 主动传入，commit `3a49c20`）

在 `inputSchema` 的 `lazySchema` 中，当 `getAPIProvider() === 'openai'` 时用 `.omit({ model: true })` 向 LLM 完全隐藏 `model` 参数。LLM 看不到该字段，无法在工具调用时传入 Anthropic 别名。

```ts
// AgentTool.tsx inputSchema
const schemaWithBg = isBackgroundTasksDisabled || isForkSubagentEnabled()
  ? schema.omit({ run_in_background: true }) : schema;

// openai provider 内网场景：隐藏 model 参数，子代理走 inherit 路径
return getAPIProvider() === 'openai'
  ? schemaWithBg.omit({ model: true })
  : schemaWithBg;
```

> **为什么 model 字段会影响实际调用**：LLM 传入的 `model` 作为 `toolSpecifiedModel` 进入 `getAgentModel()`，优先级高于 agent 定义的 `model` 字段，走独立的 `parseUserSpecifiedModel` 分支而非 inherit 路径。`OPENAI_MODEL` 未设时会 fallback 到 `gpt-4o`，内网网关若无此模型则调用失败。隐藏字段后子代理 100% 走 inherit，不存在该脆弱性。

## 验证

- `bun run build` ✅（两次提交均通过）
- `bun test src/utils/model/`（18 passed / 0 fail）✅
- `bun run smoke` ✅

## 内网实测建议

1. openai provider 下打开 `/agents`，模型选择器只有 "Inherit from parent"
2. 手动创建写了 `model: sonnet` 的 agent 配置，打开编辑器确认标签显示 "Sonnet"
3. 执行 `/init` 技能，确认 Explore 子代理工具调用参数中不再出现 `model: sonnet`
4. 触发一次 Explore 子代理，确认其 API 调用用的是主对话模型而非 `gpt-4o-mini`

## 关联

- 品牌去标识工程：`note/BRAND_MIGRATION_2026-06-07/START_HERE.md`
- 内置子代理目录：`src/tools/AgentTool/built-in/`
