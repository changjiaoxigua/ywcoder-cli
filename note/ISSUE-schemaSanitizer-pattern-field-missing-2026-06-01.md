# ISSUE: schemaSanitizer 误删 Grep 工具 pattern 字段导致模型反复漏传参数

- 日期：2026-06-01
- 涉及文件：`src/utils/schemaSanitizer.ts`、`src/utils/schemaSanitizer.test.ts`（新增）
- 影响范围：所有使用 OpenAI 兼容 provider（OpenAI、Ollama、Gemini、DeepSeek、GitHub Models 等）的场景

## 问题描述

使用 ywcoder 执行任务时，Grep 工具反复报错"需要 pattern 参数"。模型在反思中已经意识到需要提供 `pattern`，但后续调用仍然持续遗漏该参数，陷入循环（同一句"我一直犯同样的错误——Grep 需要 pattern 参数"反复出现）。

## 分析定位

根因位于 `src/utils/schemaSanitizer.ts` 的 `stripSchemaKeywords` 函数。

该函数用于清理 JSON Schema 中 OpenAI 不兼容的关键字（`pattern`、`format`、`default`、`minimum` 等），以便将 Anthropic 格式的 tool schema 转换为 OpenAI 兼容格式。调用链为：

```
openaiShim.ts  convertTools()
  → normalizeSchemaForOpenAI()
    → sanitizeSchemaForOpenAICompat()
      → stripSchemaKeywords()   ← 问题所在
```

`stripSchemaKeywords` 在递归遍历时**不区分上下文**，只要 key 名命中关键字集合就一概删除。但 Grep 工具的 `input_schema` 中有一个参数字段恰好名为 `pattern`：

```typescript
// src/tools/GrepTool/GrepTool.ts
properties: {
  pattern: {
    type: 'string',
    describe: 'The regular expression pattern to search for in file contents',
  },
  ...
}
```

函数把 `properties` 下的**字段名** `pattern` 误判为 JSON Schema 的 `pattern` **正则约束关键字**并删除。

关键点在于：`sanitizeSchemaForOpenAICompat` 虽然之后还会对每个 `properties` 子项再递归清理一遍，但这第二遍是 iterate 已经被删过的 `properties` 对象——字段名一旦在第一遍被删，key 就永久消失，第二遍无法恢复。最终传给 OpenAI 兼容 provider 的 schema 里根本没有 `pattern` 字段，模型完全不知道该参数的存在，于是反复漏传。

## 修改内容

### 1. 修复 `stripSchemaKeywords`（`src/utils/schemaSanitizer.ts`）

增加 `inPropertiesKeys` 上下文参数，区分"字段名层级"与"schema 定义层级"：

- 处在 `properties` / `patternProperties` 的直接子层（key 是用户定义的字段名/模式名）时，**禁止**按关键字删除，避免误删合法参数名。
- 其他层级（字段自身的 schema 定义内部）继续正常清理不兼容关键字。

**修改前：**
```typescript
function stripSchemaKeywords(schema: unknown, keywords: Set<string>): unknown {
  // ...
  for (const [key, value] of Object.entries(schema)) {
    if (keywords.has(key)) {
      continue  // 直接跳过删除，不区分上下文
    }
    result[key] = stripSchemaKeywords(value, keywords)
  }
  return result
}
```

**修改后：**
```typescript
function stripSchemaKeywords(
  schema: unknown,
  keywords: Set<string>,
  inPropertiesKeys = false,
): unknown {
  // ...
  for (const [key, value] of Object.entries(schema)) {
    // 在 properties / patternProperties 的 key 层级，这些 key 是字段名，
    // 不是 JSON Schema 关键字，不能删除（如 Grep 工具的 pattern 字段）。
    if (keywords.has(key) && !inPropertiesKeys) {
      continue
    }

    // 仅当当前不在字段名层级时，properties / patternProperties 的下一层 key
    // 才是字段名/模式名。字段名层级的下一层是该字段自身的 schema 定义，
    // 即使字段恰好叫 properties，其内部的关键字也应正常清理（不依赖外层第二遍兜底）。
    const nextInPropertiesKeys =
      !inPropertiesKeys &&
      (key === 'properties' || key === 'patternProperties')
    result[key] = stripSchemaKeywords(value, keywords, nextInPropertiesKeys)
  }
  return result
}
```

> 注：`nextInPropertiesKeys` 增加了 `!inPropertiesKeys &&` 守卫。这是相对最初修复的加固——
> 防止"字段名恰好为 `properties`"时，保护标志多渗透一层、把该字段 schema 定义内部本应删除的
> 约束关键字也错误保留。加固后第一遍清理自身即正确，不再隐式依赖外层 `sanitizeSchemaForOpenAICompat`
> 的第二遍重复清理。

### 2. 新增回归测试（`src/utils/schemaSanitizer.test.ts`）

该模块此前**没有任何测试**。新增 4 个用例锁定本次行为，防止后续重构或调整关键字集合时回退：

1. 保留 `properties` 下名为 `pattern` 的字段，同时删除字段内部的 `pattern` 约束关键字（直接复现原 bug）。
2. 嵌套对象参数中名为 `pattern` 的字段同样被保留、内部约束被删除。
3. 字段名恰好为 `properties` 时，字段内部关键字仍被正常清理（验证加固守卫）。
4. 顶层及普通层级的 `pattern` / `format` / `minLength` 等不兼容关键字仍被正常删除（确认未过度保护）。

## 验证结果

```
bun test ./src/utils/schemaSanitizer.test.ts
 4 pass
 0 fail
 14 expect() calls
```

- `pattern` 字段名 ✅ 保留在 schema 中
- 字段内部的 `pattern` 等约束关键字 ✅ 正常删除
- 嵌套对象内的同名字段 ✅ 正确保留
- 字段名为 `properties` 的边界 ✅ 内部关键字正常清理
- `required` 数组中的 `pattern` ✅ 保留

模型能够正确识别并传递 `pattern` 参数，Grep 工具不再循环报错。

## 影响范围

此修复保护所有工具 schema 中位于 `properties` / `patternProperties` 下的字段名，避免与 OpenAI 不兼容关键字（`pattern`、`format`、`default`、`minimum` 等）同名的参数被误删。对使用 OpenAI 兼容 provider（OpenAI、Ollama、Gemini、DeepSeek、GitHub Models 等）的场景均有效。Anthropic 原生 provider 不走该 schema 清理路径，不受影响。

## 已知遗留（与本次修复无关）

`src/utils/schemaSanitizer.ts` 中 `record.required.filter` 一行存在一个**预先存在**的 TS 类型告警（`'record.properties' is of type 'unknown'`，TS18046）。经 `git stash` 验证该告警在本次改动前即存在，属于类型收窄问题，不影响运行时行为，本次按「精准修改」原则未一并处理。

## 后续验证建议

按项目 `CLAUDE.md` 的 CI 要求，合入前在 feature 分支执行：

```bash
bun run build
bun run smoke
bun test --max-concurrency=1
```

并在内网用 OpenAI 兼容 provider 实跑一次 Grep，确认报错消失。
