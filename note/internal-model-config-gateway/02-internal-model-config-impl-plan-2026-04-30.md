# 内网模型能力参数网关自报告——实施计划

> Status: Accepted / 已采纳  
> Implementation: Completed on 2026-05-06  
> Decision: 网关作为模型能力参数权威来源，CLI 启动时拉取并缓存 `context_length`。

> **日期**：2026-04-30
> **关联方案文档**：[01-internal-model-config-gateway-reporting-2026-04-27.md](./internal-model-config-gateway-reporting-2026-04-27.md)（v1.3）
> **实施目标**：CLI 启动时从网关 `/v1/models` 自动拉取 `context_length`，写入 `additionalModelOptionsCache`，后续请求按该值计算自动压缩阈值，取代 200K 默认值

---

## 一、前置确认（开发前必须完成）

| #    | 确认项                                                                                        | 责任方   | 状态  |
| ---- | --------------------------------------------------------------------------------------------- | -------- | ----- |
| P0-1 | 网关团队确认 `/v1/models` 接口可扩展 `context_length` 字段，字段名最终确认为 `context_length` | 网关团队 | `[ ]` |
| P0-2 | 网关团队确认收到 `max_tokens=64000` 等大值请求时不主动拒绝（由推理后端自然截断）              | 网关团队 | `[ ]` |

---

## 二、不在本次范围内（明确边界）

- **不实现** `models-config.json` 手动配置层（v1 选方案 A，仅网关自报告）
- **不改动** `src/utils/model/openaiModelDiscovery.ts`（`/model` 命令刷新链路，v1 Option A 不覆盖）
- **不改动** `src/services/api/errors.ts`（`context_length_exceeded` 触发刷新已撤销）
- **不改动** `getModelMaxOutputTokens()`（`maxOutputTokens` 链路完全不动）

### 已知限制（v1 接受，文档披露但不修复）

- **首次会话用 200K**：CLI 启动时 [main.tsx:2345](../src/main.tsx) 异步触发 `fetchBootstrapData()`（约 3–5s 完成）；在 bootstrap 完成前发出的请求，`additionalModelOptionsCache` 仍为空，`findCachedModelOption` 返回 `undefined`，最终走 fallback 到硬编码表或 200K 默认值。第二次启动后该会话内 cache 已就绪，正常生效。**此为预期行为**，可通过 `/doctor` 观察 cache 状态。
- **profile 切换不刷新 contextWindow**：[ProviderManager.tsx:855](../src/components/ProviderManager.tsx) 调用 `setActiveProviderProfile()` 时只更新 `openaiAdditionalModelOptionsCache*`（带 openai 前缀），**不重新调用 `fetchBootstrapData()`**（[model.tsx:7](../src/commands/model/model.tsx) 虽 import 但实际从未调用，属 dead import）。同会话内从 profile A（gateway X）切到 profile B（gateway Y）时，`findCachedModelOption()` 读到的可能仍是 profile A 的 `contextWindow`。**重启 CLI 一次即可绕过**（启动期 bootstrap 会用新 profile 重新拉模型清单）。本 v1 暂不修复，理由见下文【三、Task 8（v2 候选）】。
- **bootstrap 失败/退化静默**：当前所有失败路径（5xx、超时、字段缺失）只调 `logForDebugging`/`logError`，用户感知不到。Task 6 的 `/doctor` 段落是 v1 唯一的可观测性兜底。

---

## 三、任务清单

### 执行顺序与依赖关系

```
Task 1（providerDiscovery.ts）─┬─→ Task 3（bootstrap.ts）─→ Task 5（测试）
                               │
Task 2（modelOptions.ts 类型）─┘─→ Task 4（context.ts）

Task 6（Doctor 诊断）── 独立，可在 Task 1-5 完成后并行或最后执行

Task 7（configMigration.ts）── 完全独立，与 Task 1-6 无代码依赖，可随时执行
```

Task 1 与 Task 2 可并行。Task 3 依赖 Task 1，Task 4 依赖 Task 2，Task 5 最后执行核心测试。Task 6 读取 config 中的缓存数据，与 Task 1-5 无代码依赖，可在功能代码合并后独立完成。Task 7 修复配置迁移工具，完全独立于其他 Task，可在任意时间点单独执行或合入。

---

### Task 1 · `src/utils/providerDiscovery.ts`

**目的**：让 `listOpenAICompatibleModels()` 解析并返回 `context_length` 字段。

> **执行情况（2026-05-06 已完成）**：1-A/B/C 全部按计划落地，[providerDiscovery.ts:173-222](../src/utils/providerDiscovery.ts) 返回类型改为 `Array<{id, contextWindow?}>`，Map 去重保留 contextWindow。Task 5 同步更新测试 8/8 通过。

#### 改动 1-A：修改响应类型声明

定位：`listOpenAICompatibleModels()` 函数体内，`response.json()` 的 as 类型断言处（当前约第 195–197 行）。

```typescript
// 改前：
const data = (await response.json()) as {
  data?: Array<{ id?: string }>
}

// 改后：
const data = (await response.json()) as {
  data?: Array<{
    id?: string
    context_length?: number | null // 2026-04-30 内网网关自报告 context_length 字段解析
  }>
}
```

#### 改动 1-B：修改函数签名返回类型

定位：`listOpenAICompatibleModels()` 函数签名行（当前第 176 行）。

```typescript
// 改前：
): Promise<string[] | null> {

// 改后：
// 2026-04-30 返回类型变更，对应 context_length 自报告特性
): Promise<Array<{ id: string; contextWindow?: number }> | null> {
```

#### 改动 1-C：修改返回语句

定位：函数内 `return Array.from(new Set(...))` 语句（当前第 199–205 行）。

```typescript
// 改前（Set 去重，返回 string[]）：
return Array.from(
  new Set(
    (data.data ?? [])
      .filter((model) => Boolean(model.id))
      .map((model) => model.id!),
  ),
)

// 改后（Map 按 id 去重，返回对象数组，携带 contextWindow）：
// 2026-04-30 改用 Map 去重以保留 contextWindow，配合 context_length 自报告特性
return Array.from(
  new Map(
    (data.data ?? [])
      .filter((m) => Boolean(m.id))
      .map((m) => [
        m.id!,
        {
          id: m.id!,
          contextWindow:
            typeof m.context_length === 'number' && m.context_length > 0
              ? m.context_length
              : undefined,
        },
      ]),
  ).values(),
)
```

---

### Task 2 · `src/utils/model/modelOptions.ts`

**目的**：为 `ModelOption` 类型新增 `contextWindow` 可选字段。

> **执行情况（2026-05-06 已完成）**：[modelOptions.ts:41-48](../src/utils/model/modelOptions.ts) 已加 `contextWindow?: number`，无破坏性变更，现有所有构造点无需修改。

#### 改动 2-A：扩展 `ModelOption` 类型定义

定位：`ModelOption` export type 声明（当前第 41–46 行）。

```typescript
// 改前：
export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

// 改后：
export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
  contextWindow?: number // 2026-04-30 内网网关自报告上下文窗口大小（来自 /v1/models context_length 字段）
}
```

**注意**：`contextWindow` 为可选字段，现有所有构造 `ModelOption` 的代码无需修改。

---

### Task 3 · `src/services/api/bootstrap.ts`

**目的**：`fetchLocalOpenAIModelOptions()` 调用方同步更新，将 `contextWindow` 写入缓存。

> **执行情况（2026-05-06 已完成）**：[bootstrap.ts:148-155](../src/services/api/bootstrap.ts) 的 `.map()` 已改为读取 `model.id` 并透传 `model.contextWindow`，与 Task 1 返回类型变更对齐。

#### 改动 3-A：更新 `.map()` 映射逻辑

定位：`fetchLocalOpenAIModelOptions()` 函数内的 `additionalModelOptions: models.map(...)` 处（当前第 148–152 行）。

```typescript
// 改前（models 为 string[]）：
additionalModelOptions: models.map(model => ({
  value: model,
  label: model,
  description: `Detected from ${providerLabel}`,
})),

// 改后（models 为 Array<{ id, contextWindow? }>，Task 1 变更后的新类型）：
// 2026-04-30 models 类型变更（Task 1），同步更新映射逻辑以传递 contextWindow
additionalModelOptions: models.map(model => ({
  value: model.id,
  label: model.id,
  description: `Detected from ${providerLabel}`,
  contextWindow: model.contextWindow,
})),
```

**其余不动**：第 138 行 `if (models === null)` 检查仍然有效，无需修改。

---

### Task 4 · `src/utils/context.ts`

**目的**：① 去除 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 的 `USER_TYPE='ant'` 门禁（开放管理员应急覆盖入口）；② 新增 `findCachedModelOption()` 本地函数；③ 在 OpenAI 兼容分支中插入网关缓存查询。

> **执行情况（2026-05-06 已完成）**：4-A/B/C 全部落地，详见 [context.ts:53-104](../src/utils/context.ts)。已知遗留：line 124 / 189 调用 `resolveAntModel` 但缺 import，是**预先存在**的 LSP 警告（与本次改动无关），bun build 用 esbuild 不会因此失败。

#### 改动 4-A：去除 `USER_TYPE='ant'` 门禁

定位：`getContextWindowForModel()` 函数起始处的环境变量检查（当前第 60–68 行）。

```typescript
// 改前：
if (
  process.env.USER_TYPE === 'ant' &&
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
) {
  const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
  if (!isNaN(override) && override > 0) {
    return override
  }
}

// 改后：
// 2026-04-30 去除 USER_TYPE='ant' 门禁：在此 fork 中 USER_TYPE 不为 'ant'，
// 该分支从未执行。去除后管理员可通过 CLAUDE_CODE_MAX_CONTEXT_TOKENS
// 应急覆盖上下文窗口大小（网关自报告不可用时的降级手段）
if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
  const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
  if (!isNaN(override) && override > 0) {
    return override
  }
}
```

#### 改动 4-B：新增 `findCachedModelOption()` 本地函数

定位：文件顶层，紧接在现有 `export const MODEL_CONTEXT_WINDOW_DEFAULT` 等常量声明之后、`getContextWindowForModel()` 函数定义之前插入。

无需新增任何 import（`getGlobalConfig` 已在文件顶部 import）。

```typescript
/**
 * 从 bootstrap 启动缓存中查找模型的能力参数。
 * 固定读 additionalModelOptionsCache（启动时由 fetchBootstrapData 写入，含 contextWindow）。
 * 不读 openaiAdditionalModelOptionsCache（/model 命令写入，v1 不含 contextWindow）。
 * 2026-04-30 内网网关 context_length 自报告特性新增
 */
function findCachedModelOption(
  model: string,
): { contextWindow?: number } | undefined {
  const config = getGlobalConfig()
  // 仅在 OpenAI 兼容 provider 且 scope 匹配时查询，避免对其他 provider 产生影响
  if (!config.additionalModelOptionsCacheScope?.startsWith('openai:')) {
    return undefined
  }
  const cache = config.additionalModelOptionsCache
  if (!Array.isArray(cache)) return undefined
  return cache.find((opt) => opt.value === model || opt.label === model)
}
```

#### 改动 4-C：插入网关缓存查询

定位：`getContextWindowForModel()` 函数内，OpenAI 兼容分支的 `if (isEnvTruthy(...))` 块中，`getOpenAIContextWindow(model)` 调用之前插入（当前第 76–85 行）。

```typescript
// 改前：
if (
  isEnvTruthy(getYwCoderEnv('USE_OPENAI')) ||
  isEnvTruthy(getYwCoderEnv('USE_GEMINI')) ||
  isEnvTruthy(getYwCoderEnv('USE_GITHUB'))
) {
  const openaiWindow = getOpenAIContextWindow(model)
  if (openaiWindow !== undefined) {
    return openaiWindow
  }
}

// 改后：
if (
  isEnvTruthy(getYwCoderEnv('USE_OPENAI')) ||
  isEnvTruthy(getYwCoderEnv('USE_GEMINI')) ||
  isEnvTruthy(getYwCoderEnv('USE_GITHUB'))
) {
  // 2026-04-30 优先从网关自报告缓存读取 contextWindow（内网 context_length 自报告特性）
  const cached = findCachedModelOption(model)
  if (cached?.contextWindow && cached.contextWindow > 0) {
    return cached.contextWindow
  }

  const openaiWindow = getOpenAIContextWindow(model)
  if (openaiWindow !== undefined) {
    return openaiWindow
  }
}
```

---

### Task 5 · `src/utils/providerDiscovery.test.ts`

**目的**：更新 `listOpenAICompatibleModels()` 相关测试，适配 Task 1 的返回类型变更。

> **执行情况（2026-05-06 已完成）**：5-A/B 全部落地。原有 2 条测试更新为新返回结构，新增 3 条 `context_length` 解析用例（正常值 / 0 与负数过滤 / 字段缺失）。结果：8 pass / 0 fail。

#### 改动 5-A：更新现有断言

将所有 `listOpenAICompatibleModels` 返回值为 `string[]` 的断言改为对象数组格式：

```typescript
// 改前（示例）：
expect(result).toEqual(['model-a', 'model-b'])

// 改后：
expect(result).toEqual([
  { id: 'model-a', contextWindow: undefined },
  { id: 'model-b', contextWindow: undefined },
])
```

#### 改动 5-B：新增 `context_length` 解析测试用例

```typescript
// 新增用例 1：网关返回 context_length，验证 contextWindow 被正确解析
it('解析网关返回的 context_length 字段', async () => {
  // mock fetch 返回包含 context_length 的响应
  // 断言 result[0].contextWindow === 131072
})

// 新增用例 2：context_length 为 0 或负数时，contextWindow 应为 undefined
it('过滤无效的 context_length（0 或负数）', async () => {
  // mock fetch 返回 context_length: 0 和 context_length: -1
  // 断言 contextWindow === undefined
})

// 新增用例 3：context_length 缺失时，contextWindow 应为 undefined
it('context_length 字段缺失时 contextWindow 为 undefined', async () => {
  // mock fetch 返回不含 context_length 的标准响应
  // 断言 contextWindow === undefined
})
```

---

### Task 6 · `/doctor` 命令新增模型能力诊断段落

**目的**：在 `/doctor` 输出中新增 `Model Capabilities` 段落，展示网关自报告的 `contextWindow` 缓存状态，帮助内网用户排查"为什么上下文是 200K 而不是预期值"的问题。

> **执行情况（2026-05-06 已完成）**：6-A 新建 [src/components/ModelCapabilitiesDoctorSection.tsx](../src/components/ModelCapabilitiesDoctorSection.tsx)，使用计划最终版"未加载…请退出后重新执行 /doctor"文案；6-B-1/B-2 在 [Doctor.tsx](../src/screens/Doctor.tsx) 顶部加 import、`<Pane>` 内 `{t31}` 之后插入 `<ModelCapabilitiesDoctorSection />`。已知限制（首次打开后不自动刷新）已通过文案兜底。

**实现策略**：`src/screens/Doctor.tsx` 已经过 React Compiler 处理，cache slot 编号复杂，不应直接在其中插入逻辑。参照现有 `SandboxDoctorSection`、`McpParsingWarnings` 的模式，**新建独立组件**，`Doctor.tsx` 只增加一行 import 和一行 JSX 引用。

#### 已知限制（v1 接受）：cache 状态首次打开 doctor 后不自动刷新

`getGlobalConfig()` 是同步、非响应式的——render 时取一次快照，不订阅变更。Doctor 屏幕外层 `<Pane>` 是 React Compiler 编译产物，依赖列表 `[t23, t30, t35-t39]` 不含 cache 状态；当 bootstrap 后台完成并写入 cache 后：

- 同一次 `/doctor` 屏幕生命周期内，`<Pane>` 缓存命中，`<ModelCapabilitiesDoctorSection />` 元素引用复用，React 直接 bailout，**子组件函数体不会重新执行** → 段落保持启动初的"未加载"
- 用户**退出再次打开 `/doctor`**（组件重新 mount）即可看到最新数据

**为什么 v1 选择接受**：

- `/doctor` 是用户**短暂打开-排查-关闭**的诊断屏，不是常驻面板
- 多数情况下 bootstrap 在用户首次打开 doctor 之前已完成
- 问题窗口窄（启动后 < 5s 内首次打开 doctor）
- 用户重新打开 doctor 即可刷新，体验代价低

**v1 兜底**：通过文案明确引导用户「稍后重新执行 `/doctor`」，将限制显式化（见改动 6-A 中"未加载"分支的展开文案）。

> **未来若需自动刷新**：在 `ModelCapabilitiesDoctorSection` 内自带 `useState(getGlobalConfig)` + `useEffect` 做 1.5s 轮询，绕过外层 Pane 缓存。v1 不实施。

#### 改动 6-A：新建组件文件 `src/components/ModelCapabilitiesDoctorSection.tsx`

新建此文件，内容如下：

```tsx
// 2026-04-30 内网网关 context_length 自报告特性——/doctor 诊断段落
import React from 'react'
import { Box, Text } from '../ink.js'
import { getGlobalConfig } from '../utils/config.js'

/**
 * 在 /doctor 中展示网关自报告的模型能力缓存状态。
 * 仅在 OpenAI 兼容 provider（scope 以 openai: 开头）时渲染，其他 provider 返回 null。
 * 2026-04-30 内网网关 context_length 自报告特性新增
 */
export function ModelCapabilitiesDoctorSection(): React.ReactElement | null {
  const config = getGlobalConfig()
  const scope = config.additionalModelOptionsCacheScope

  // 非 OpenAI 兼容 provider 不展示此段落
  if (!scope?.startsWith('openai:')) {
    return null
  }

  const cache = config.additionalModelOptionsCache ?? []
  const withWindow = cache.filter((m) => m.contextWindow && m.contextWindow > 0)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Model Capabilities</Text>
      <Text>└ 来源: {scope}</Text>
      <Text>
        └ 缓存状态:{' '}
        {cache.length === 0 ? (
          // 2026-04-30 v1 接受首次打开后不自动刷新的限制，通过文案引导手动刷新
          <Text color="warning">
            未加载（bootstrap 仍在进行 / 网关不可达 / 启动时未配置 OpenAI 兼容
            provider）； 若启动时间已超过 10 秒，请退出后重新执行 /doctor
            查看刷新后的状态
          </Text>
        ) : (
          <Text color="green">
            已加载 {cache.length} 个模型，其中 {withWindow.length} 个含
            context_length
          </Text>
        )}
      </Text>
      {cache.map((model) => (
        <Text key={model.value} dimColor>
          {'  '}└ {model.value}:{' '}
          {model.contextWindow
            ? `context_length=${model.contextWindow}`
            : '未提供 context_length → fallback 到硬编码表或 200K 默认值'}
        </Text>
      ))}
    </Box>
  )
}
```

#### 改动 6-B：在 `src/screens/Doctor.tsx` 中引入并使用

**改动 6-B-1**：在文件顶部 import 区域末尾追加一行：

```typescript
// 改前（import 区结束处，约第 31 行之后）：
import { getXDGStateHome } from '../utils/xdg.js'

// 改后（追加一行）：
import { getXDGStateHome } from '../utils/xdg.js'
import { ModelCapabilitiesDoctorSection } from '../components/ModelCapabilitiesDoctorSection.js' // 2026-04-30 内网网关 context_length 自报告特性
```

**改动 6-B-2**：在 JSX 渲染的 `<Pane>` 内，`SandboxDoctorSection`（即 `{t31}`）之后插入组件引用。

定位：当前第 489 行：

```tsx
t41 = (
  <Pane>
    {t23}
    {t30}
    {t31}
    {t32}
    {t33}
    {t34}
    {t35}
    {t36}
    {t37}
    {t38}
    {t39}
    {t40}
  </Pane>
)
```

改为（在 `{t31}` 后紧跟插入）：

```tsx
// 2026-04-30 插入模型能力诊断段落（内网网关 context_length 自报告特性）
t41 = (
  <Pane>
    {t23}
    {t30}
    {t31}
    <ModelCapabilitiesDoctorSection />
    {t32}
    {t33}
    {t34}
    {t35}
    {t36}
    {t37}
    {t38}
    {t39}
    {t40}
  </Pane>
)
```

**注意**：本 fork 的构建链路 [scripts/build.ts:140-150](../scripts/build.ts) **只 shim 了 `react/compiler-runtime` 运行时（提供一个返回 `Symbol.for('react.memo_cache_sentinel')` 数组的 `c()` 函数），并不跑 babel-plugin-react-compiler**。因此 `Doctor.tsx` 里的 cache slot `$[76]...$[82]` 是**已经编译好、提交进仓库的最终产物**——手动编辑后会原样保留，下次 build **不会**自动重新生成它们。

代价是：`<Pane>` 的 cache 依赖列表 `[t23, t30, t35-t39]` **不会自动把新插入的 `<ModelCapabilitiesDoctorSection />` 纳入**。当 cache 命中时 React 会复用同一个 element 引用并 bailout，子组件函数体不会重新执行——这就是 Task 6 顶部"已知限制（v1 接受）"描述的"首次打开 doctor 后不自动刷新"问题。

**v1 兜底**：通过改动 6-A 中"未加载"分支的文案（"若启动时间已超过 10 秒，请退出后重新执行 /doctor"）显式引导用户手动刷新。executor 务必使用改动 6-A 给出的文案版本，不要保留旧版"未加载（bootstrap 尚未完成或失败）"。

---

## 四、代码注释格式规范

所有改动处注释统一格式：

```typescript
// 2026-04-30 <原因一句话>
```

各处注释速查：

| 改动位置                                  | 注释内容                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| providerDiscovery.ts 响应类型扩展         | `// 2026-04-30 内网网关自报告 context_length 字段解析`                                   |
| providerDiscovery.ts 返回类型修改         | `// 2026-04-30 返回类型变更，对应 context_length 自报告特性`                             |
| providerDiscovery.ts 返回语句             | `// 2026-04-30 改用 Map 去重以保留 contextWindow，配合 context_length 自报告特性`        |
| modelOptions.ts contextWindow 字段        | `// 2026-04-30 内网网关自报告上下文窗口大小（来自 /v1/models context_length 字段）`      |
| bootstrap.ts .map() 改动                  | `// 2026-04-30 models 类型变更（Task 1），同步更新映射逻辑以传递 contextWindow`          |
| context.ts 去除 ant 门禁                  | 多行注释（见 Task 4-A，已写好）                                                          |
| context.ts findCachedModelOption 函数     | 多行 JSDoc（见 Task 4-B，已写好）                                                        |
| context.ts 缓存查询插入点                 | `// 2026-04-30 优先从网关自报告缓存读取 contextWindow（内网 context_length 自报告特性）` |
| ModelCapabilitiesDoctorSection.tsx 文件头 | `// 2026-04-30 内网网关 context_length 自报告特性——/doctor 诊断段落`                     |
| Doctor.tsx import 行                      | `// 2026-04-30 内网网关 context_length 自报告特性`                                       |
| Doctor.tsx JSX 插入行                     | `// 2026-04-30 插入模型能力诊断段落（内网网关 context_length 自报告特性）`               |

---

## 五、验收检查清单

> **2026-05-06 自动化检查执行结果**：
>
> - ✅ `bun run build` — 构建成功
> - ✅ `bun test src/utils/providerDiscovery.test.ts` — **8 pass / 0 fail**
> - ✅ `bun test --max-concurrency=1` — **525 pass / 0 fail**（零回归）
> - ✅ `bun run smoke` — `v1.0.1 (YwCoder)` 正常输出
> - ✅ `bun run test:provider` — **133 pass / 0 fail**
> - ✅ `bun run test:provider-recommendation` — **46 pass / 0 fail**
> - ✅ `bun run security:pr-scan -- --base origin/main` — `no suspicious additions found`
> - ⏳ 手动验证项 a–f：待内网环境实测

```bash
# 1. 类型检查 + 构建通过
bun run build

# 2. 针对 providerDiscovery 的单测通过
bun test src/utils/providerDiscovery.test.ts

# 3. 全量测试无回归
bun test --max-concurrency=1

# 4. 冒烟测试
bun run smoke

# 5. 手动验证（内网环境）
#    a. 启动后查看 getGlobalClaudeFile() 返回的实际配置文件
#       （执行迁移后为 ~/.ywcoder/.config.json；未迁移则 fallback 到 ~/.claude.json），
#       确认 additionalModelOptionsCache 中各模型条目包含 contextWindow 字段
#       且值与网关配置一致
#    b. 使用内网模型发起请求，确认 auto-compact 阈值按 contextWindow 计算，
#       而非固定 200K 默认值
#    c. 使用不在网关配置中的模型（无 context_length），确认 fallback 到
#       硬编码表或 200K，行为与改动前一致
#    d. 设置 CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536，确认可覆盖网关自报告值
#    e. 执行 /doctor，确认出现 [Model Capabilities] 段落，
#       列出各模型的 context_length 值；
#       对无 context_length 的模型显示"fallback 到硬编码表或 200K 默认值"
#    f. 断开网关连接后启动 + 立刻执行 /doctor，
#       确认段落出现且文案包含「未加载」与「重新执行 /doctor」关键字
#       （不要硬匹配整串文案，以改动 6-A 给出的实际版本为准），
#       且功能不阻塞——CLI 仍能正常进入交互
#
# 6. 方案A 手动验证（内网环境）
#    g. 执行 /model，确认选择器中只展示网关返回的模型（qwen2.5、deepseek 等），
#       不展示 gpt-4o、claude-3-opus 等硬编码预设模型
#    h. 断开网关后执行 /model，确认选择器为空，显示"未从网关发现可用模型"提示
#    i. 使用不在网关配置中的模型名发起请求，
#       确认 `getContextWindowForModel()` 返回 200K 默认值（不走硬编码表 fallback）
#    j. 切换 OPENAI_BASE_URL 到 api.openai.com（公网），确认 /model 正常展示硬编码模型
```

---

### Task 7 · `src/utils/configMigration.ts`（P2，建议实施）

**目的**：修复 `migrateConfig()` 遗漏 `~/.claude.json` → `~/.ywcoder/.config.json` 的问题。

> **执行情况（2026-05-06 已完成）**：7-A 加 `copyFile` import；7-B 把目录 `mkdir` 与 JSON 文件迁移**提到顶部独立步骤**，与目录迁移完全解耦——即使 `~/.claude/` 目录不存在但 `~/.claude.json` 存在的场景也能完成迁移。详见 [configMigration.ts](../src/utils/configMigration.ts)。
> 当前代码只将 `~/.claude/`（目录）复制到 `~/.ywcoder/`，但 `getGlobalClaudeFile()` 读取的
> `~/.ywcoder/.config.json` 来自 home 根目录的 `~/.claude.json`（JSON 文件，非目录），两者不是同一路径。
> 不修复时 ywcoder 仍会 fallback 读 `~/.claude.json`，功能正常但配置未隔离（ywcoder 与官方 Claude Code 共享同一个 JSON 文件）。

**修复后效果**：执行 `ywcoder --migrate-config` 后，`~/.ywcoder/.config.json` 被创建，
ywcoder 独立维护自己的配置（`additionalModelOptionsCache`、MCP servers 等），不再与官方 Claude Code CLI 共享。

#### 改动 7-A：import 行新增 `copyFile`

定位：文件第 2 行 `import { cp, mkdir } from 'fs/promises'`。

```typescript
// 改前：
import { cp, mkdir } from 'fs/promises'

// 改后：
// 2026-04-30 新增 copyFile，用于迁移 ~/.claude.json → ~/.ywcoder/.config.json
import { copyFile, cp, mkdir } from 'fs/promises'
```

#### 改动 7-B：以独立步骤补充 JSON 文件迁移（不依赖目录是否存在）

**关键背景**：`getGlobalClaudeFile()` 在 [src/utils/env.ts:14-26](../src/utils/env.ts) 优先检查 `~/.ywcoder/.config.json`，fallback 到 `~/.claude.json`。当前 `migrateConfig()` 只迁移**目录** `~/.claude/` → `~/.ywcoder/`，完全忽略 `~/.claude.json` JSON 配置文件。

**为什么不能把 JSON 迁移放在 `try { cp(...) }` 块内**：当前 [configMigration.ts:36-43](../src/utils/configMigration.ts) 的 `findSourceConfigDir()` 仅检测 `~/.claude` 目录是否存在；当目录不存在时（[configMigration.ts:64-74](../src/utils/configMigration.ts)），函数会在第 65–74 行早期 return，**永远到不了 try 块**。两种用户场景会因此漏迁：

1. 用户卸载了官方 Claude Code，但保留了 `~/.claude.json`（卸载脚本通常不删 user data）
2. 用户手动清理过 `~/.claude/` 目录，但 `~/.claude.json` 还在

**修正方案**：把 JSON 文件迁移**提到顶部作为独立步骤**，与目录迁移解耦。无论 `~/.claude/` 目录是否存在，只要 `~/.claude.json` 存在就尝试迁移。

**完整改造后的 `migrateConfig()` 函数源码**（直接替换 [configMigration.ts:48-108](../src/utils/configMigration.ts) 现有的 `export async function migrateConfig` 整个函数体）：

```typescript
// 2026-04-30 修复 ~/.claude.json → ~/.ywcoder/.config.json 的迁移遗漏
export async function migrateConfig(): Promise<MigrationResult> {
  const targetDir = join(homedir(), '.ywcoder')

  // 2026-04-30 始终先确保目标目录存在，作为后续 JSON 迁移和目录迁移的共同前置
  // 取代原 try 块内的 mkdir 调用（避免重复创建）
  await mkdir(targetDir, { recursive: true })

  // 2026-04-30 步骤 1（独立）：迁移 ~/.claude.json → ~/.ywcoder/.config.json
  // 不依赖 ~/.claude 目录是否存在，覆盖以下场景：
  //   a. 官方 Claude Code 已卸载但 ~/.claude.json 残留
  //   b. 用户清理过 ~/.claude 目录但 JSON 配置还在
  // 仅在目标文件不存在时复制，防止覆盖已在 ywcoder 中单独修改过的配置
  const sourceClaudeJson = join(homedir(), '.claude.json')
  const targetConfigJson = join(targetDir, '.config.json')
  if (existsSync(sourceClaudeJson) && !existsSync(targetConfigJson)) {
    await copyFile(sourceClaudeJson, targetConfigJson)
    console.log(`✓ 迁移全局配置文件 ~/.claude.json → ~/.ywcoder/.config.json`)
  } else if (existsSync(targetConfigJson)) {
    console.log(`  ~/.ywcoder/.config.json 已存在，跳过（保留现有配置）`)
  }
  // 若 ~/.claude.json 不存在，静默跳过——用户可能从未用过 Claude Code

  // 步骤 2：目录迁移（保留原有逻辑，仅删除原 try 块内重复的 mkdir）
  const currentDir = detectCurrentConfigDir()
  const sourceDir = findSourceConfigDir()

  // 如果当前已经在用 ~/.ywcoder（目录），目录迁移可跳过
  if (currentDir === targetDir) {
    console.log('✓ Already using ~/.ywcoder')
    return {
      success: true,
      from: currentDir || '',
      to: targetDir,
      message: 'Already using the new config directory',
    }
  }

  // 如果 ~/.claude/ 目录不存在（但 JSON 步骤可能已经成功），仅创建目录就 return
  if (!sourceDir) {
    console.log('✓ Created new config directory at ~/.ywcoder')
    return {
      success: true,
      from: '',
      to: targetDir,
      message: 'Created new config directory',
    }
  }

  // 迁移目录内容（不覆盖已存在的文件）
  try {
    // 2026-04-30 已在函数顶部 mkdir，此处不再重复
    await cp(sourceDir, targetDir, {
      recursive: true,
      force: false,
      preserveTimestamps: true,
    })

    console.log(`✓ Migrated config from ${sourceDir} to ~/.ywcoder`)
    console.log(`  You can now safely delete the old directory:`)
    console.log(`  rm -rf ${sourceDir}`)

    return {
      success: true,
      from: sourceDir,
      to: targetDir,
      message: 'Config migrated successfully',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`✗ Migration failed: ${message}`)

    return {
      success: false,
      from: sourceDir,
      to: targetDir,
      message: `Migration failed: ${message}`,
    }
  }
}
```

**关键设计决策**：

- JSON 迁移与目录迁移**完全独立**，任何一方失败都不影响另一方（JSON 步骤不在 try 块内，让其自身错误能直接抛出，便于排查）
- `!existsSync(targetConfigJson)` 防止覆盖用户已在 ywcoder 中单独修改过的配置
- `existsSync`、`homedir`、`join` 均已在文件顶部导入；`copyFile` 需补充（改动 7-A）
- 顶部 `mkdir` 取代原 try 块内的 `mkdir` 调用，避免重复
- `MigrationResult` 接口、`detectCurrentConfigDir`、`findSourceConfigDir`、`cp` 等保持原有引用关系不变

**diff 简表**（与原文件差异点）：

- 函数体最开头新增：`mkdir(targetDir, ...)` + JSON 迁移代码块（约 14 行）
- 原 [configMigration.ts:65-74](../src/utils/configMigration.ts) `if (!sourceDir) { await mkdir... }` 中删除内部 `await mkdir`（已提前完成），保留 `console.log` + `return`
- 原 [configMigration.ts:78-79](../src/utils/configMigration.ts) try 块开头的 `await mkdir(targetDir, { recursive: true })` 删除（已提前完成）

#### 改动 7-C：发布与生命周期相关说明

**下一版发布是否需要提醒用户主动迁移？**

- **不需要强制提醒**。`getGlobalClaudeFile()` 已有 fallback：当 `~/.ywcoder/.config.json` 不存在时自动读 `~/.claude.json`，功能正常。
- **但建议在 release notes 中给出**：「执行 `ywcoder --migrate-config` 可让 ywcoder 与官方 Claude Code 配置完全隔离；不执行则继续与官方共享 `~/.claude.json`，多客户端写入可能互相覆盖」——把决定权交给用户。
- 不强制自动迁移（启动时静默执行）的原因：迁移是不可逆动作，用户可能希望保持共享。

**未来版本能否移除 `migrateConfig()` 与 `~/.claude.json` fallback？**

- **migrateConfig() 工具**：建议保留至少 6 个月，老用户随时可能从旧版升级。
- **`~/.claude.json` fallback**：与 `migrateConfig()` 同节奏，移除时机同步。移除前需在 release notes 提前一个版本预告。
- **判断时机的指标**：观察 `~/.claude.json` 仍在被读取（fallback 路径命中）的用户占比，若降至个位数百分比可考虑下线。
- 即便彻底下线 fallback，`migrateConfig()` 工具本身可保留更久作为 one-off CLI 子命令，老用户升级两个大版本之后也仍能恢复配置。

#### 验收检查（Task 7 专项）

```bash
# 准备测试环境（确保 ~/.claude.json 存在）
ls ~/.claude.json

# 模拟执行迁移（若 ~/.ywcoder 已存在，先备份）
ywcoder --migrate-config

# 验证
ls ~/.ywcoder/.config.json                          # 文件应已创建
diff ~/.claude.json ~/.ywcoder/.config.json         # 内容应一致（首次迁移时）

# 再次执行迁移，确认不覆盖
ywcoder --migrate-config
# 应输出：~/.ywcoder/.config.json 已存在，跳过（保留现有配置）
```

---

### Task 8 · profile 切换刷新 contextWindow（v2 候选，本次不实施）

**问题**：`setActiveProviderProfile()` 只重写 `openaiAdditionalModelOptionsCache*`（`/model` 命令的那份），不刷新 `additionalModelOptionsCache`（bootstrap 写、本 v1 读的那份）。同会话跨 profile 时 `findCachedModelOption()` 可能返回旧 profile 的 `contextWindow`。

**为什么 v1 不实施**：

1. profile 切换是低频操作——大多数用户配置一次后长期使用同一 provider
2. 影响仅限 auto-compact 阈值偏差，不影响功能正确性
3. **重启 CLI 即可绕过**：CLI 重启时 [providerProfiles.ts:449](../src/utils/providerProfiles.ts) 会把 active profile 应用到 `process.env`，[main.tsx:2345](../src/main.tsx) 启动时的 `fetchBootstrapData()` 会用新 profile 的 base_url 重新拉 `/v1/models`，3–5s 后覆盖 cache。也就是说切完 profile **重启一次** 就回到正确状态，与"首次会话用 200K"是同一类窗口期问题
4. 工程上需要在 `setActiveProviderProfile()` 内追加 `void fetchBootstrapData()`，但要慎重处理：
   - profile 切换是同步函数，bootstrap 是异步——不能 await，仍存在窗口期
   - bootstrap 内部按 scope 判断（scope 已经被切换），但 `process.env` 已被 `applyProviderProfileToProcessEnv` 改写过，可能引发竞态
5. 跨 profile 用同一模型名但不同 `context_length` 的概率极低（要求两个网关的模型清单刚好同名）

**v2 修复策略（建议）**：

- 在 `setActiveProviderProfile()` 末尾追加 `void fetchBootstrapData()`，让新 profile 生效后异步刷新
- 或在 `findCachedModelOption()` 内额外校验 `additionalModelOptionsCacheScope === 期望 scope`，scope 不匹配时直接返回 `undefined`，让 fallback 链路兜底
- 配合添加 e2e 测试覆盖跨 profile 场景

> **决策**：v1 文档披露限制，v2 视用户反馈再修。

---

### Task 9 · 内网模型列表去歧义（方案A）

**目的**：当 `isLocalProviderUrl()` 为 true 时，隐藏 `/model` 选择器中的硬编码预设模型，避免用户误选内网不可用的公网模型；同时优化 `getContextWindowForModel()` 的 fallback 链路。

> **状态**：待实施（v1.5 或 v1.x 补丁）
> **依赖**：Task 1~6 已完成（bootstrap 链路含 contextWindow）

#### 改动 9-A：`/model` 选择器过滤硬编码模型

> **执行情况（2026-05-10 已完成）**：实际改动在 `src/utils/model/modelOptions.ts:getModelOptions()`，而非原计划的 `model.tsx`。`getModelOptions()` 是模型列表的统一出口，在此过滤可覆盖所有调用方；改 `model.tsx` 只影响 `/model` 命令 UI 层，覆盖范围不足。

定位：`src/utils/model/modelOptions.ts:getModelOptions()` 函数。

**9-A-0：补充 import**

定位：`src/utils/model/modelOptions.ts` 顶部 import 区（`getAdditionalModelOptionsCacheScope` 已存在，追加 `isLocalProviderUrl`）。

```typescript
// 改前：
import { getAdditionalModelOptionsCacheScope } from '../../services/api/providerConfig.js'

// 改后：
// 2026-05-10 方案A：内网环境下判断 provider 是否为本地地址，用于过滤硬编码预设模型
import { getAdditionalModelOptionsCacheScope, isLocalProviderUrl } from '../../services/api/providerConfig.js'
```

**9-A-1：模型列表过滤逻辑**

```typescript
// 实际代码（modelOptions.ts:getModelOptions()）
const scope = getAdditionalModelOptionsCacheScope()
const isLocal = scope?.startsWith('openai:') && isLocalProviderUrl(scope.replace('openai:', ''))
const discovered = getScopedAdditionalModelOptions()
// 2026-05-11 修复：浅拷贝断开与 additionalModelOptionsCache 的共享引用，
// 避免后续 options.push() 意外 mutate 全局 config 内存缓存
const options = isLocal && discovered.length > 0 ? [...discovered] : getModelOptionsBase(fastMode)
```

说明：
- `getScopedAdditionalModelOptions()` 直接读 `additionalModelOptionsCache`（含 scope 守卫），不读 `openaiAdditionalModelOptionsCache`
- `isLocal=false` 或 `discovered` 为空时，走 `getModelOptionsBase(fastMode)`（内含完整 tier 判断和预设模型，非简单 preset 拼接）
- 内网且发现模型非空时，`options = [...discovered]`，后续 `push` 不影响全局缓存

**边界条件**：
- `isLocalProviderUrl()` 为 true 但 `discovered` 为空（网关不可达）→ 走 `getModelOptionsBase()`，仍展示预设模型（兜底）
- `isLocalProviderUrl()` 为 false（公网）→ 完全不受影响，走原有逻辑
- `discovered` 含部分有 `contextWindow`、部分无 → 全部展示，无 `contextWindow` 的模型在 `/doctor` 中标记"未提供 context_length"

#### 改动 9-B：`getContextWindowForModel()` 跳过硬编码表 fallback

定位：`src/utils/context.ts` 中 OpenAI 兼容分支。

当 `isLocalProviderUrl()` 为 true 且 `additionalModelOptionsCache` 非空时，跳过 `getOpenAIContextWindow(model)` 查询，直接 fallback 到默认值。

#### 改动 9-B-0：补充 `isLocalProviderUrl` 导入

定位：`src/utils/context.ts` 顶部 import 区。

```typescript
// 改前：context.ts 顶部 import 区（无 providerConfig 相关 import）

// 改后：
// 2026-05-10 方案A：内网环境下判断 provider 是否为本地地址，用于过滤硬编码模型
import { isLocalProviderUrl } from '../services/api/providerConfig.js'
```

#### 改动 9-B-1：OpenAI 兼容分支跳过硬编码表

```typescript
if (isEnvTruthy(getYwCoderEnv('USE_OPENAI')) || ...) {
  const cached = findCachedModelOption(model)
  if (cached?.contextWindow && cached.contextWindow > 0) {
    return cached.contextWindow
  }

  // 方案A新增：内网环境且缓存非空时，不再查硬编码表
  const config = getGlobalConfig()
  const scope = config.additionalModelOptionsCacheScope
  const isLocal = scope?.startsWith('openai:') && isLocalProviderUrl(scope.replace('openai:', ''))
  if (!isLocal || !config.additionalModelOptionsCache?.length) {
    const openaiWindow = getOpenAIContextWindow(model)
    if (openaiWindow !== undefined) return openaiWindow
  }
}
```

**设计决策**：
- 用 `scope.startsWith('openai:')` + `isLocalProviderUrl()` 双重判定，避免误判
- 仅当 `additionalModelOptionsCache` 非空时才跳过硬编码表——若 bootstrap 失败导致缓存为空，仍允许 fallback 到硬编码表（虽然内网模型大概率不在表中，但保留兜底行为更保守）

#### 改动 9-C：`/doctor` 模型能力段落补充

**9-C-0：补充 import**

定位：`src/components/ModelCapabilitiesDoctorSection.tsx` 顶部 import 区。

```typescript
// 改前：
// （无 providerConfig 相关 import）

// 改后：
// 2026-05-10 方案A：内网环境下判断 provider 是否为本地地址，用于 /doctor 诊断提示
import { isLocalProviderUrl } from '../services/api/providerConfig.js'
```

**9-C-1：诊断段落补充提示**

在 `ModelCapabilitiesDoctorSection` 中，当 `isLocalProviderUrl()` 为 true 时：
- 若发现模型数量 > 0，显示"已过滤硬编码预设模型"
- 若发现模型数量 = 0，显示黄色警告："未从网关发现可用模型，/model 列表为空"

```tsx
// 实际代码（ModelCapabilitiesDoctorSection.tsx）
// scope 已在组件顶部从 getGlobalConfig() 读取，直接提取 baseUrl，无需 resolveProviderRequest
const isLocal = isLocalProviderUrl(scope.replace('openai:', ''))

{isLocal && cache.length > 0 && (
  // 2026-05-10 方案A：内网环境提示已过滤硬编码预设模型
  <Text dimColor>└ 内网模式：已过滤硬编码预设模型，仅展示网关发现模型</Text>
)}
{isLocal && cache.length === 0 && (
  // 2026-05-10 方案A：内网环境无可用模型时给出警告
  <Text color="warning">└ 内网模式：未从网关发现可用模型，/model 列表为空</Text>
)}
```

---

## 六、改动文件汇总

| 文件                                                        | 改动 Task         | 必须/可选           |
| ----------------------------------------------------------- | ----------------- | ------------------- |
| `src/utils/providerDiscovery.ts`                            | Task 1（A/B/C）   | 必须                |
| `src/utils/model/modelOptions.ts`                           | Task 2（A）       | 必须                |
| `src/services/api/bootstrap.ts`                             | Task 3（A）       | 必须                |
| `src/utils/context.ts`                                      | Task 4（A/B/C）   | 必须                |
| `src/utils/providerDiscovery.test.ts`                       | Task 5（A/B）     | 必须                |
| `src/components/ModelCapabilitiesDoctorSection.tsx`（新建） | Task 6（A）       | 必须                |
| `src/screens/Doctor.tsx`                                    | Task 6（B-1/B-2） | 必须                |
| `src/utils/configMigration.ts`                              | Task 7（A/B/C）   | 建议（P2）          |
| —（仅文档）profile 刷新策略                                 | Task 8            | v2 候选，本次不实施 |
| `src/utils/model/modelOptions.ts`                           | Task 9（A）       | 建议（方案A）       |
| `src/utils/context.ts`                                      | Task 9（B）       | 建议（方案A）       |
| `src/components/ModelCapabilitiesDoctorSection.tsx`         | Task 9（C）       | 建议（方案A）       |

---

## 七、PR 描述模板

```markdown
## Summary

- 内网模型网关 `/v1/models` 的 `context_length` 字段现可被自动消费：bootstrap 启动时拉取并写入 `additionalModelOptionsCache`，后续请求用真实窗口大小计算 auto-compact 阈值，取代 200K 硬编码默认值。
- `/doctor` 新增 "Model Capabilities" 段落，可视化展示缓存状态，便于用户排查"为什么阈值不是预期值"。
- 解除 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 的 `USER_TYPE='ant'` 门禁，作为网关不可达时的应急覆盖通道（注意：此处仅取消该 env 的限制，不影响 `USER_TYPE='ant'` 在其他位置的管理员逻辑，如 ConfigTool / TungstenTool / REPLTool 的 gating）。
- （P2）修复 `migrateConfig()` 对 `~/.claude.json → ~/.ywcoder/.config.json` 的迁移遗漏，让卸载官方 Claude Code 但保留 JSON 配置的用户也能完成迁移。

## 行为变化（重要）

- **首次会话窗口期**：CLI 启动到 bootstrap 完成（约 3–5s）之间发出的请求，`additionalModelOptionsCache` 仍为空，`getContextWindowForModel` 会走 fallback 到硬编码表或 200K 默认值；第二次启动后该会话起 cache 就绪，正常生效。**此为预期行为**，可通过 `/doctor` 观察当前 cache 状态。
- **`/doctor` 段落刷新限制**：进入 `/doctor` 时若 cache 还在加载，段落会显示"未加载…"。React Compiler 缓存导致段落不会在同一屏幕生命周期内自动刷新，**退出后重新执行 `/doctor` 即可看到最新状态**。
- **profile 跨切换刷新滞后**（v1 已知限制）：同会话切换 provider profile 后，`additionalModelOptionsCache` 仍是切换前的快照。**重启 CLI 一次即可绕过**——重启时启动期 bootstrap 会自动用新 profile 的 base_url 拉一次模型清单。日常使用中影响极小（要求两个网关模型名重叠且 `context_length` 不同）。

## 配置迁移说明（仅 P2 改动相关）

执行 `ywcoder --migrate-config` 可让 ywcoder 与官方 Claude Code 配置完全隔离。**不强制要求**——若不执行，`getGlobalClaudeFile()` 会自动 fallback 到 `~/.claude.json`，多客户端共享同一文件可能互相覆盖（升级时建议执行一次）。

## Test plan

- [ ] `bun run build` 通过
- [ ] `bun test src/utils/providerDiscovery.test.ts` 通过（含新增的 context_length 解析用例）
- [ ] `bun test --max-concurrency=1` 全量通过
- [ ] `bun run smoke` 通过
- [ ] 内网手动验证：网关返回 `context_length=131072` 后，`~/.ywcoder/.config.json` 中 `additionalModelOptionsCache` 含对应字段，auto-compact 阈值按 131072 计算
- [ ] 设置 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536`，确认覆盖网关自报告值
- [ ] 执行 `/doctor`，确认出现 "Model Capabilities" 段落
- [ ] 断开网关后启动 + 立刻 `/doctor`，确认显示"未加载…请退出后重新执行 /doctor"，且功能不阻塞
- [ ] （P2）`~/.claude/` 目录不存在但 `~/.claude.json` 存在的场景下执行 `ywcoder --migrate-config`，确认 `~/.ywcoder/.config.json` 被创建
```
