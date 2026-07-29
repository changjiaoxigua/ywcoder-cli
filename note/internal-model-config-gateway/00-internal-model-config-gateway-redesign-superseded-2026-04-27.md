# 内网模型能力参数网关自报告方案

> Status: Superseded / 已被替代  
> Superseded by: `01-internal-mode-config-redesign-2026-04-27.md`  
> Reason: 原方案依赖用户手动维护 `models-config.json`，后续改为网关 `/v1/models` 自报告 `context_length` 作为主路径。  
> Keep for: 方案演进记录、备选思路、历史判断依据。

> **日期标签**：2026-04-27（v1.4 更新于 2026-05-05）
> **版本**：v1.4（执行收口：①§8 文件清单补录 Doctor 相关两个文件；②§5.5 确认 `findCachedModelOption()` 落在 `context.ts`；③§7.1 补录实际 React 组件实现方案及 Plan B 决策；④v1.3 历史不变）
> **定位**：`internal-model-config-redesign-2026-04-27.md` 的替代方案
> **目标**：取消用户手动维护 `models-config.json`，改由网关在 `/v1/models` 返回中自报告 `context_length`，CLI 启动时自动预加载并缓存
> **核心简化（v1.1）**：仅扩展 1 个字段 `context_length`；不返回 `max_tokens`（escalation 机制对内网恒不生效，保留默认 32K/64K 即可）；CLI 侧复用 `additionalModelOptionsCache`，不新建独立链路

---

## 一、与原方案的关系

| 维度             | 原方案 `internal-model-config-redesign-2026-04-27.md` | 本方案                    |
| ---------------- | ----------------------------------------------------- | ------------------------- |
| **能力参数来源** | 用户手动编写 `models-config.json`                     | 网关 `/models` 接口自报告 |
| **用户操作**     | 需手动维护 JSON 文件                                  | **零配置**，无感知        |
| **新模型上线**   | 需通知所有用户更新配置文件                            | 网关配置后自动生效        |
| **网关策略变更** | 用户本地文件不会同步                                  | 下次启动自动同步          |
| **准确性**       | 用户可能填错                                          | 网关是唯一权威来源        |
| **互补关系**     | 可作为本方案的**手动覆盖层**保留                      | 主路径                    |

**最终优先级链路（v1.1 简化版）**：

仅 `contextWindow` 链路改造，`maxOutputTokens` 完全不动（保留 32K/64K 默认，由模型自然截断）。

```
环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS（需先去除 USER_TYPE='ant' 门禁，详见原方案 §10）
    ↓
[1m] 后缀
    ↓
★ additionalModelOptionsCache[model].contextWindow（来自 /v1/models 自报告，本方案主路径）
    ↓
getOpenAIContextWindow() 硬编码表（公网模型兜底）
    ↓
默认值 200_000
```

`maxOutputTokens` 链路保持现状（[context.ts:162-235](../src/utils/context.ts#L162-L235)）：

- 本 fork 中 `isMaxTokensCapEnabled()` 因 GrowthBook 不可达恒为 `false`
- escalation 路径 `8K → 64K` 在内网根本不会触发
- 因此返回 `max_tokens` 字段对内网无任何收益，徒增协议复杂度，v1 不引入

---

## 二、背景与动机

### 2.1 原方案的问题

`models-config.json` 虽然解决了内网模型参数配置问题，但引入了新的运维负担：

1. **用户手动维护**：内网用户需要自行编写 JSON，容易填错参数
2. **新模型上线成本高**：每部署一个新模型，需通知所有用户更新本地文件
3. **网关策略变更不同步**：网关侧调整了模型上下文窗口，用户配置文件仍是旧值
4. **准确性无法保障**：`contextWindow` 填错直接导致自动压缩时机错误（提前压缩浪费 token / 不及时压缩触发硬截断）

### 2.2 核心洞察

网关作为模型的直接部署方，天然知道这个模型实际支持多少上下文（来自训练配置 / 推理框架的 `max_position_embeddings` / `model_max_length` / `max_model_len`）。

**网关是最权威的来源，不应让用户猜。**

---

## 三、设计目标

1. **零配置**：用户无需编写任何 JSON 文件
2. **自动同步**：网关参数变更，CLI 下次启动自动感知
3. **启动时预加载**：启动后首次调用前已完成能力参数缓存
4. **向后兼容**：保留 `models-config.json` 作为手动覆盖层（可选）
5. **不影响公网用户**：未配置网关扩展字段时，行为与原逻辑完全一致

---

## 四、网关侧改动

### 4.1 接口规范（v1.1 极简版）

在现有 OpenAI 兼容 `/v1/models` 返回中，仅扩展 **1 个字段** `context_length`：

```http
GET /v1/models
Authorization: Bearer {api_key}

Response 200 OK:
{
  "object": "list",
  "data": [
    {
      "id": "qwen2.5-72b-instruct",
      "object": "model",
      "created": 1686935002,
      "owned_by": "your-org",
      "context_length": 131072
    },
    {
      "id": "deepseek-r1",
      "object": "model",
      "created": 1686935002,
      "owned_by": "your-org",
      "context_length": 65536
    }
  ]
}
```

### 4.2 字段说明

| 字段             | 类型     | 必填     | 说明                                                                                           |
| ---------------- | -------- | -------- | ---------------------------------------------------------------------------------------------- |
| `id`             | `string` | 是       | 模型标识（标准 OpenAI 字段）                                                                   |
| `context_length` | `number` | 强烈建议 | 模型总上下文窗口（输入 + 输出 token 总数上限）。未提供时 CLI fallback 到硬编码表或 200K 默认值 |

**为什么不返回 `max_tokens`**：

1. `max_tokens` 在 OpenAI 协议中是**请求参数**而非响应字段，作为响应字段会引起协议歧义
2. CLI 端的 `max_output_tokens_escalate` 机制由 GrowthBook flag `tengu_otk_slot_v1` 门禁，本 fork 中恒为 `false`，escalation 路径在内网根本不会触发
3. 内网网关无限流需求，模型按自身能力自然截断输出即可（vLLM / TGI / llama.cpp 等主流推理框架均支持优雅截断）
4. 协议复杂度最小化原则：留给未来确有需要时作为 v2 扩展

**前置确认**（开发前必须与网关团队对齐）：

- [ ] 网关收到 `max_tokens=64000` 等大值请求时**不主动拒绝**，由推理后端自然截断
- 若网关侧确有硬校验，则 v1 必须额外返回 `max_output_tokens` 字段（届时升级到 v2 协议）

### 4.3 字段命名理由

最终选择 **`context_length`**：

| 候选                 | 是否采用 | 理由                                                                                                                         |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **`context_length`** | ✅ 采用  | 与模型 huggingface config（`max_position_embeddings` / `model_max_length`）语义一致；vLLM / TGI 自报告也常用此名；含义无歧义 |
| `context_window`     | 备选     | 商业 API 常用措辞（Anthropic / OpenAI 文档），但不是协议字段名                                                               |
| `max_context_tokens` | 否       | 与 `max_tokens` 命名相近，仍有混淆风险                                                                                       |

由于本方案对接的是**自研网关**，无需兼容多种开源生态字段命名，故 CLI 端只解析 `context_length` 单一字段，不做别名 fallback。

### 4.4 网关实现建议

字段为**静态配置**，无需实时计算：

```python
# 网关配置示例（伪代码）
MODEL_CONFIGS = {
    "qwen2.5-72b-instruct": {"context_length": 131072},
    "deepseek-r1":          {"context_length": 65536},
    "internal-llama3-70b":  {"context_length": 128000},
}

@app.get("/v1/models")
def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": model_id,
                "object": "model",
                "created": 1686935002,
                "owned_by": "your-org",
                "context_length": config["context_length"],
            }
            for model_id, config in MODEL_CONFIGS.items()
        ]
    }
```

**兼容性说明**：

- 字段缺失时 CLI 自动 fallback 到 `getOpenAIContextWindow()` 硬编码表（公网模型）或 200K 默认值
- OpenAI 官方客户端会忽略不认识的字段，不会报错
- 现有用户升级网关后无需变更 CLI，旧 CLI 也会忽略此字段（向前兼容）

---

## 五、CLI 侧改动

### 5.1 复用现有 `fetchBootstrapData` 链路（关键改动）

**重要**：本 fork 已存在 `/v1/models` 拉取 + 缓存机制，本方案**严格复用**而非新建独立链路：

| 既有组件 | 位置                                                               | 现状                                                                                                                      |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 启动入口 | [main.tsx:2345](../src/main.tsx#L2345)                             | `void fetchBootstrapData()` 已 fire-and-forget 启动                                                                       |
| 拉取实现 | [bootstrap.ts:159](../src/services/api/bootstrap.ts#L159)          | `fetchBootstrapData()` 调用 `listOpenAICompatibleModels()`                                                                |
| 缓存字段 | [bootstrap.ts:188-200](../src/services/api/bootstrap.ts#L188-L200) | `additionalModelOptionsCache` + `additionalModelOptionsCacheScope`（key 形如 `openai:${baseUrl}`，已天然按 baseUrl 隔离） |
| 列表查询 | [providerDiscovery.ts:173](../src/utils/providerDiscovery.ts#L173) | `listOpenAICompatibleModels({ baseUrl, apiKey })`                                                                         |

**改造原则（v1.3 精确版）**：扩展现有 `ModelOption` 类型 + `listOpenAICompatibleModels` 解析层，不新增独立字段。

**两套缓存的实际关系（代码精查结论，v1.3 修正）**：

| 缓存字段                            | 写入方                                                                        | 读取方                               | 是否含 contextWindow      |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ | ------------------------- |
| `additionalModelOptionsCache`       | `fetchBootstrapData()` → `listOpenAICompatibleModels()`                       | `context.ts:findCachedModelOption()` | **v1 改造后含**           |
| `openaiAdditionalModelOptionsCache` | `refreshOpenAIModelOptionsCache()` → `discoverOpenAICompatibleModelOptions()` | 模型选择器（`/model` 命令）          | **v1 不含**（不改此路径） |

这两套缓存是完全独立的链路，**互不写入**。v1 选择 **Option A**：只改 bootstrap 链路（`listOpenAICompatibleModels()`），不改 `/model` 刷新链路（`openaiModelDiscovery.ts:fetchOpenAIModels()`）。

**Option A 的设计边界**：

- `contextWindow` 仅在启动时通过 bootstrap 写入 `additionalModelOptionsCache`
- 用户执行 `/model` 刷新 `openaiAdditionalModelOptionsCache`，但该缓存**不携带 contextWindow**
- `context.ts` 的 `findCachedModelOption()` 固定读 `additionalModelOptionsCache`（bootstrap cache），不随 `/model` 操作变化
- 若网关调整某模型的 `context_length`，需重启 CLI 才生效（此行为合理：`context_length` 是模型固有参数，网关自主变更概率极低）

**Option A 带来的好处**：

- 已有 baseUrl scope 隔离（`additionalModelOptionsCacheScope`，切换 provider 不脏数据）
- 已有的并发安全 `saveGlobalConfig` 路径
- `findCachedModelOption()` 读路径稳定，不受 `/model` 操作影响

### 5.2 `providerDiscovery.ts` 解析扩展字段（仅改 bootstrap 链路，不动 `/model` 刷新链路）

**改造范围（v1.3 精确）**：只改 [src/utils/providerDiscovery.ts](../src/utils/providerDiscovery.ts) 中的 `listOpenAICompatibleModels()`，**不动** [src/utils/model/openaiModelDiscovery.ts](../src/utils/model/openaiModelDiscovery.ts) 中的 `fetchOpenAIModels()`（那是 `/model` 命令的发现路径，v1 Option A 不覆盖）。

当前 `listOpenAICompatibleModels()` 返回 `Promise<string[] | null>`，需改为返回带 `contextWindow` 的对象数组：

```typescript
// src/utils/providerDiscovery.ts — 改动 1：响应类型扩展
const data = (await response.json()) as {
  data?: Array<{
    id?: string
    context_length?: number | null // ← 唯一新增字段
  }>
}

// 改动 2：返回类型从 string[] 改为对象数组
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
// 返回类型: Promise<Array<{ id: string; contextWindow?: number }> | null>
```

**同步改动**：`bootstrap.ts` 的调用方 `fetchLocalOpenAIModelOptions()` 需同步更新 `.map()` 以传递 `contextWindow`；`providerDiscovery.test.ts` 相关测试需更新。

### 5.3 `modelOptions.ts` 类型扩展（仅 1 个字段）

```typescript
// src/utils/model/modelOptions.ts

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
  contextWindow?: number // ← 唯一新增（来自网关自报告）
  // 不增加 maxOutputTokens（见 §4.2 决策说明）
}
```

### 5.4 `context.ts` 优先级链路插入缓存层（仅改 contextWindow）

```typescript
// src/utils/context.ts（修改 getContextWindowForModel）

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // 1. 环境变量（最高优先级，需先去除 USER_TYPE='ant' 门禁——见原方案 §10）
  if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) return override
  }

  // 2. [1m] 后缀
  if (has1mContext(model)) return 1_000_000

  // 3. OpenAI 兼容 provider — 优先读 additionalModelOptionsCache
  if (
    isEnvTruthy(getYwCoderEnv('USE_OPENAI')) ||
    isEnvTruthy(getYwCoderEnv('USE_GEMINI')) ||
    isEnvTruthy(getYwCoderEnv('USE_GITHUB'))
  ) {
    // 3a. ★ 新增：从 additionalModelOptionsCache 读取网关自报告
    const cachedOption = findCachedModelOption(model) // 从 globalConfig.additionalModelOptionsCache 中按 model id 查
    if (cachedOption?.contextWindow && cachedOption.contextWindow > 0) {
      return cachedOption.contextWindow
    }

    // 3b. 硬编码表兜底
    const openaiWindow = getOpenAIContextWindow(model)
    if (openaiWindow !== undefined) return openaiWindow
  }

  // 4. 其余原有逻辑保持不动（modelCapabilities / 1M Beta / Sonnet exp / resolveAntModel）
  // ...

  // 5. 默认值
  return MODEL_CONTEXT_WINDOW_DEFAULT
}
```

**`getModelMaxOutputTokens` 完全不动**——保留原有 32K/64K 默认行为，由模型按自身能力自然截断输出。

### 5.5 `findCachedModelOption` 实现（新增工具函数）

**v1.4 位置确认**：最终落在 `src/utils/context.ts`，非 `modelOptions.ts`。原因：与 `getContextWindowForModel()` 共处同文件，避免跨模块导入；`ModelOption` 类型仍在 `modelOptions.ts`，但此函数的返回类型已简化为匿名对象 `{ contextWindow?: number }`。

```typescript
// src/utils/context.ts（v1.4 确认：不在 modelOptions.ts）

function findCachedModelOption(
  model: string,
): { contextWindow?: number } | undefined {
  const config = getGlobalConfig()
  // 固定读 additionalModelOptionsCache（bootstrap 启动时写入，含 contextWindow）
  // 不读 openaiAdditionalModelOptionsCache（/model 命令写入，v1 不含 contextWindow）
  const scope = config.additionalModelOptionsCacheScope
  if (!scope?.startsWith('openai:')) return undefined // 非 OpenAI 兼容 provider 不查
  const cache = config.additionalModelOptionsCache
  if (!Array.isArray(cache)) return undefined
  return cache.find((opt) => opt.value === model || opt.label === model)
}
```

**设计说明**：

- 固定读 `additionalModelOptionsCache`（bootstrap 写的那个），不随 `/model` 操作改变
- `/model` 命令刷新的是 `openaiAdditionalModelOptionsCache`，该缓存 v1 不携带 `contextWindow`，`context.ts` 不读它
- 重启 CLI 时 bootstrap 重新拉取，`contextWindow` 得到更新——对于模型固有的上下文参数，这是合理的更新频率

### 5.6 缓存刷新策略

| 时机                 | 写入字段                            | 行为                                                                                      | 是否新增                   |
| -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| **启动时**           | `additionalModelOptionsCache`       | `fetchBootstrapData()` fire-and-forget，含 `contextWindow`                                | 无（已有入口，仅扩展解析） |
| **执行 `/model` 时** | `openaiAdditionalModelOptionsCache` | `refreshOpenAIModelOptionsCache()` 刷新，**不含 `contextWindow`**（Option A：不改此路径） | 无变化                     |
| **provider 切换时**  | `additionalModelOptionsCache`       | scope 变更触发 bootstrap 重新拉取                                                         | 无（已有）                 |
| **重启 CLI**         | `additionalModelOptionsCache`       | bootstrap 强刷，`contextWindow` 同步最新值                                                | 无                         |
| **缓存有效期**       | —                                   | 单会话内不主动过期；启动时强刷一次                                                        | 无（已有）                 |

v1 无"API 错误触发刷新"逻辑（已降级为 P2，见 §十一）。

---

## 六、数据流时序图

### 6.1 首次启动（v1.1 简化版）

```
用户启动 YwCoder
  ↓
main.tsx 已有逻辑: void fetchBootstrapData()  ← fire-and-forget
  ↓ (并行)
REPL 就绪，用户可输入            fetchBootstrapData 调用 listOpenAICompatibleModels()
                                   ↓
                                 GET {OPENAI_BASE_URL}/v1/models
                                 Authorization: Bearer {OPENAI_API_KEY}
                                   ↓
                                 网关返回：
                                   [
                                     { id: "qwen2.5-72b", context_length: 131072 },
                                     { id: "deepseek-r1", context_length: 65536 }
                                   ]
                                   ↓
                                 解析 + 写入 ~/.claude.json（由 getGlobalClaudeFile() 决定，见 §12.6）:
                                   additionalModelOptionsCache: [
                                     { value: "qwen2.5-72b", contextWindow: 131072, ... },
                                     { value: "deepseek-r1", contextWindow: 65536, ... }
                                   ]
                                   additionalModelOptionsCacheScope: "openai:http://gw.intra/v1"
  ↓
用户输入问题，触发 getContextWindowForModel("deepseek-r1")
  ↓
findCachedModelOption("deepseek-r1") 命中 → 返回 65536
  ↓
有效窗口 = 65536；自动压缩线按 65536 计算 ≈ 52000 token
  ↓
正常发请求 / 自动压缩 / 警告提示
```

**首请求竞态处理**（P1-1 → **v1.2 决策：不处理，接受为已知限制**）：若 `fetchBootstrapData` 尚未完成（毫秒级窗口）：

- `findCachedModelOption` 返回 `undefined` → fallback 到 `getOpenAIContextWindow()` 硬编码表 → fallback 到 200K 默认
- 仅影响第一个请求的自动压缩判断；后续请求一旦 bootstrap 完成即正常
- **竞态触发概率 < 0.5%**（bootstrap 通常在 300ms 内完成，用户首次输入通常 > 1s），v1 不添加阻塞逻辑，保持 `void fetchBootstrapData()` fire-and-forget 不变

### 6.2 网关参数变更后

```
网关管理员调整 deepseek-r1 的 context_length：65536 → 131072（升配）
  ↓
用户第二天启动 YwCoder
  ↓
fetchBootstrapData 重新调用 /v1/models
  ↓
新结果与缓存不一致 → saveGlobalConfig 覆盖 additionalModelOptionsCache
  ↓
后续请求自动使用新值，无需用户操作
```

### 6.3 会话内网关参数变更（v1.3 决策：**此流程撤销**）

~~原方案：CLI 监听 `context_length_exceeded` 错误，触发缓存刷新 + 提示用户重试~~

**撤销理由（代码精查后发现三个问题）**：

1. **语义混淆**：`context_length_exceeded` 最常见的含义是"当前对话太长"，而非"模型上限变了"。对前者触发缓存刷新毫无意义（上限没变，刷新无法缩短对话）。
2. **格式依赖**：CLi 识别 `context_length_exceeded` 依赖网关返回特定 OpenAI 标准错误格式（`{ error: { type: "context_length_exceeded" } }`），自研网关不一定实现此格式，需额外约定。
3. **context_length 是模型固有参数**：团队已确认网关自主变更此参数的概率极低（月级甚至更长），无需为此建立会话内实时感知机制。

**v1 行为**：`context_length_exceeded` 类错误按现有错误处理逻辑处理（提示用户输入过长），不触发缓存刷新。如有需要 v2 再评估。

---

## 七、错误与降级策略

| 场景                                              | 行为                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| 网关未返回 `context_length`                       | CLI 忽略缺失字段，fallback 到硬编码表 / 200K 默认值，行为与原逻辑一致        |
| `/v1/models` 请求失败（网络/认证）                | 保留上次缓存；无缓存则 fallback 到硬编码表                                   |
| 缓存解析失败（字段类型错误：负数 / 非整数 / 0）   | 跳过该模型的 contextWindow，其他字段正常生效                                 |
| 用户同时配置了 `models-config.json`（若保留此层） | 用户配置优先于 API 自报告缓存（保留手动覆盖能力）                            |
| 启动时 fetchBootstrapData 未完成时首请求触发      | 走硬编码表 / 默认值；后续请求恢复正常                                        |
| API 返回 `context_length_exceeded` 错误           | 按现有逻辑处理（提示用户输入过长），**不触发**缓存刷新（v1.3 撤销，见 §6.3） |

### 7.0 启动失败横幅（v1.2 决策：静态单次提示）

若 `fetchBootstrapData` 失败（网络故障 / 认证错误），在 REPL 顶部显示一次性静态黄色横幅：

```
⚠ 模型能力加载失败，使用默认 200K 上下文。运行 /doctor 查看详情
```

**三种方案的取舍（供后续决策参考）**：

| 方案                                      | 描述                                            | 结论                                                    |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| **A：完全不动（静默降级）**               | 不显示任何提示，直接 fallback 到硬编码表 / 200K | 过于隐蔽，用户无法感知配置未生效                        |
| **B：静态横幅 + `/doctor`**（✅ v1 采纳） | 失败时显示一次固定黄色横幅，不跟踪异步恢复状态  | 实现最简，足够排障                                      |
| **C：阻塞启动 + 异步刷新 + 横幅刷新**     | 启动时阻塞等待 bootstrap，失败/成功分别刷新横幅 | 实现复杂（终端无刷新 UI 机制）、延迟启动体验，v1 不引入 |

**方案 C 的具体问题（已评估排除）**：

1. **阻塞启动**：会明显拖慢 REPL 就绪时间，仅为 < 0.5% 竞态概率不值得
2. **异步成功后刷新横幅**：Ink/React 终端组件不支持主动刷新已渲染内容，需额外状态管理，实现代价高，收益（告知用户"已恢复"）极低

**v1 行为**：横幅只在失败时显示一次，bootstrap 后台成功则后续请求自然使用新缓存，无需横幅刷新。

### 7.1 `/doctor` 诊断输出（P1-3 修复）

**v1.4 实际实现方案（React 组件 + Plan B 零成本方案）**：

原规格描述的是文本格式输出；实际执行中，Doctor 屏幕使用 React Compiler 编译的静态渲染，无法在不重写整个 Doctor 的情况下动态注入段落。采用了 **Plan B（零成本复制文本引导）**：

- 新建 `src/components/ModelCapabilitiesDoctorSection.tsx`，独立 React 组件
- 在编译输出的 `src/screens/Doctor.tsx` 中，于最后一个静态段落（`t31`）后直接插入 `<ModelCapabilitiesDoctorSection />`
- **Plan B 的"零成本"指**：若 bootstrap 尚未完成（cache 为空），显示文案 "若启动时间已超过 10 秒，请退出后重新执行 /doctor 查看刷新后的状态"，引导用户重开 /doctor，而非通过 `useState` 轮询（Ink/React 组件在 Doctor pane 里已由 React Compiler 缓存，useState 更新不会触发重渲染）

**实际 /doctor 段落输出格式**：

```
Model Capabilities
└ 来源: openai:http://gw.intra/v1
└ 缓存状态: 已加载 2 个模型，其中 2 个含 context_length
  └ qwen2.5-72b: context_length=131072
  └ deepseek-r1: context_length=65536
```

失败或空缓存时：

```
└ 缓存状态: 未加载（bootstrap 仍在进行 / 网关不可达 / 启动时未配置 OpenAI 兼容 provider）；
  若启动时间已超过 10 秒，请退出后重新执行 /doctor 查看刷新后的状态
```

此组件**仅在 OpenAI 兼容 provider（scope 以 `openai:` 开头）时渲染**，其他 provider 返回 null，对非内网用户无影响。

---

## 八、需要修改的文件清单

| 文件                                                                                                      | 改动类型                   | 说明                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/utils/providerDiscovery.ts](../src/utils/providerDiscovery.ts)                                       | ✏️ 修改（必须）            | `listOpenAICompatibleModels` 响应类型新增 `context_length`；返回类型从 `string[]` 改为 `{ id, contextWindow? }[]`（v1.3：这是核心改动，不可绕过）                                                                   |
| [src/services/api/bootstrap.ts](../src/services/api/bootstrap.ts)                                         | ✏️ 修改（必须）            | `fetchLocalOpenAIModelOptions()` 调用方的 `.map()` 同步更新，将 `contextWindow` 写入 `additionalModelOptionsCache`                                                                                                  |
| [src/utils/model/modelOptions.ts](../src/utils/model/modelOptions.ts)                                     | ✏️ 修改（必须）            | `ModelOption` 类型新增 `contextWindow?: number`（v1.4：`findCachedModelOption()` 最终落在 `context.ts` 而非此文件）                                                                                                 |
| [src/utils/context.ts](../src/utils/context.ts)                                                           | ✏️ 修改（必须）            | `getContextWindowForModel` 在 OpenAI 兼容分支前插入 `findCachedModelOption` 查询；去掉 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 的 `USER_TYPE='ant'` 门禁；`findCachedModelOption()` 工具函数也放在此文件（v1.4：位置确认） |
| [src/utils/providerDiscovery.test.ts](../src/utils/providerDiscovery.test.ts)                             | ✏️ 修改（必须）            | `listOpenAICompatibleModels` 返回类型变更，相关测试需同步更新                                                                                                                                                       |
| [src/components/ModelCapabilitiesDoctorSection.tsx](../src/components/ModelCapabilitiesDoctorSection.tsx) | ✏️ 新增（已完成 P1）       | 新增 React 组件，在 /doctor 中展示模型能力缓存状态（source、cache count、per-model contextWindow）；仅在 OpenAI 兼容 provider 时渲染（v1.4 补录）                                                                   |
| [src/screens/Doctor.tsx](../src/screens/Doctor.tsx)                                                       | ✏️ 修改（已完成 P1）       | 在编译输出的 Doctor pane 中插入 `<ModelCapabilitiesDoctorSection />`（v1.4 补录）                                                                                                                                   |
| ~~[src/utils/model/openaiModelDiscovery.ts](../src/utils/model/openaiModelDiscovery.ts)~~                 | ❌ **v1 不改**（Option A） | `/model` 命令的 `fetchOpenAIModels()` 不解析 `context_length`；`contextWindow` 更新需重启，这是 v1 已知限制                                                                                                         |
| ~~`src/services/api/errors.ts`~~                                                                          | ❌ **v1 不改**             | `context_length_exceeded` 触发刷新已撤销（见 §6.3），v1 不实现                                                                                                                                                      |
| ~~`src/main.tsx` / `initializeModelCapabilitiesCache()`~~                                                 | ❌ 不新增                  | 已有 `void fetchBootstrapData()` 入口，复用即可                                                                                                                                                                     |
| ~~`src/utils/settings/types.ts` `discoveredModelCapabilities`~~                                           | ❌ 不新增                  | 复用已有 `additionalModelOptionsCache` 字段，无独立配置项                                                                                                                                                           |

**改动量评估（v1.4 实际执行版）**：必须改 5 个文件（4 个源码 + 1 个测试），doctor 诊断新增 1 个组件文件 + 修改 1 个 Doctor 屏幕文件，共 7 个文件；单文件改动 < 30 行。

---

## 九、与原方案的共存策略

本方案上线后，原方案 `models-config.json` **是否保留留待团队决策**。两种方案：

**方案 A：完全不保留（推荐，最简）**

- 用户只能通过 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 环境变量覆盖
- 网关是唯一权威来源
- 配置面最清晰，无两套配置心智负担

**方案 B：保留作为手动覆盖层**

- 优先级：环境变量 > `models-config.json` > 网关自报告 > 硬编码表 > 默认值
- 适用于高级用户 / 测试场景需要临时覆盖某个模型参数

```typescript
// 方案 B 的 context.ts 优先级链路
if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) { ... }
if (has1mContext(model)) return 1_000_000

if (isOpenAICompatible()) {
  // 1. 用户手动覆盖（可选保留）
  const userOverride = loadUserModelsConfig()?.models[model]?.contextWindow
  if (userOverride) return userOverride

  // 2. 网关自报告（本方案主路径）
  const cached = findCachedModelOption(model)?.contextWindow
  if (cached) return cached

  // 3. 硬编码表兜底
  const openaiWindow = getOpenAIContextWindow(model)
  if (openaiWindow !== undefined) return openaiWindow
}
```

**当前推荐**：v1 上线选 **方案 A**（最简），观察一段时间内是否真有覆盖需求，再决定是否在 v2 加回 `models-config.json`。

### 9.1 modelAllowlist 联动（v1.2 决策：**不需要额外逻辑，原方案撤销**）

原提案建议在 `isModelAllowed()` 中添加"通过 `findCachedModelOption` 发现的模型自动放行"逻辑。

**v1.2 撤销理由**：

经查 [src/utils/model/modelAllowlist.ts](../src/utils/model/modelAllowlist.ts)，`isModelAllowed()` 的行为如下：

```typescript
export function isModelAllowed(model: string): boolean {
  const availableModels = getGlobalConfig().availableModels
  if (!availableModels || availableModels.length === 0) return true // ← 关键：未配置 = 全部放行
  // ...
}
```

当 `availableModels` 未设置时，函数**直接返回 `true`**，即所有模型默认允许。内网用户不会配置 `availableModels` 白名单，因此网关自报告的新模型天然通过 allowlist 检查，**无需新增代码**。

**什么时候才需要联动**：仅当用户在 `~/.claude.json`（见 §12.7）中显式配置了 `availableModels` 白名单时，新模型才会被拦截。这是极少数高级场景，v1 不处理，必要时 v2 再评估。

**硬编码表（openaiContextWindows.ts）保留策略**：不注释、不删除。作为公网模型的兜底 fallback，在无网关自报告时仍有意义（公网用户 / 开发调试场景）。内网模型若不在表中，会走 200K 默认值，这在引入网关自报告后已是最后 fallback，可接受。

---

## 十、变更记录

| 日期       | 版本 | 变更摘要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-27 | v1.0 | 初稿；作为 `internal-model-config-redesign-2026-04-27.md` 的替代方案，提出网关 `/models` 自报告 + CLI 启动时预加载缓存的零配置方案                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-04-27 | v1.1 | 采纳团队反馈：①协议简化为单字段 `context_length`，移除 `max_tokens`（escalation 机制对内网恒不生效，且 `max_tokens` 在 OpenAI 协议中是请求参数易引起歧义）；②CLI 侧严格复用现有 `fetchBootstrapData` / `additionalModelOptionsCache` 链路，不新建 `discoveredModelCapabilities` 独立字段；③新增 §6.3 会话内变更 + §7.1 `/doctor` 诊断 + §9.1 modelAllowlist 联动；④撤销 `capabilities` 子对象扩展性建议（thinking / reasoning_content 已由 [openaiShim.ts](../src/services/api/openaiShim.ts) 通过响应 payload 自适应处理）；⑤待确认事项标注 P0/P1/P2 优先级        |
| 2026-04-30 | v1.2 | Q&A 七题决策落地：①启动机制保持 fire-and-forget 不变，竞态 < 0.5% 接受为已知限制（§6.1）；②失败提示采纳"静态横幅 + /doctor"方案，撤销阻塞启动 + 横幅刷新方案（§7.0）；③modelAllowlist 联动撤销（`isModelAllowed` 默认全部放行，无需新增代码，§9.1）；④硬编码模型表保留为兜底 fallback；⑤配置目录全部更正为 `~/.ywcoder/`；⑥确认 v1 范围为 OpenAI provider（P2-8）；⑦新增 §12.5 启动机制选型决策记录                                                                                                                                                                 |
| 2026-04-30 | v1.3 | 代码精查后修正：①两套缓存架构厘清（`additionalModelOptionsCache` vs `openaiAdditionalModelOptionsCache` 完全独立链路）；②Q1 决策 Option A——`contextWindow` 仅由 bootstrap 链路写入，`/model` 刷新链路 v1 不改；③配置文件路径更正为 `~/.claude.json`（`getGlobalClaudeFile()` 实际返回）；④`context_length_exceeded` 触发刷新撤销（语义混淆 + 格式依赖 + 参数固有性，§6.3）；⑤§5.2 范围明确为只改 `listOpenAICompatibleModels()`，不动 `openaiModelDiscovery.ts:fetchOpenAIModels()`；⑥§5.5 `findCachedModelOption()` 加 scope 守卫；⑦§8 文件清单精确化；⑧新增 §12.6 |
| 2026-05-05 | v1.4 | 执行收口更新：①§8 文件清单补录已完成的 Doctor 相关文件（新增 `ModelCapabilitiesDoctorSection.tsx`、修改 `Doctor.tsx`）；②§5.5 确认 `findCachedModelOption()` 落在 `context.ts`（非 `modelOptions.ts`），返回类型简化为匿名对象；③§7.1 补录实际 React 组件实现及 Plan B 决策（React Compiler 缓存问题 → 用户引导重开 /doctor 代替 useState 轮询）；④额外落地 `configMigration.ts` 独立 JSON 迁移逻辑（`~/.claude.json` → `~/.ywcoder/.config.json`，与本特性解耦，随同提交）                                                                                         |

---

## 十一、待确认事项（按优先级标注）

### P0（阻塞开发，必须先决策）

1. [ ] **【网关侧】** 网关团队确认 `/v1/models` 接口可扩展 `context_length` 字段，且收到 `max_tokens=64000` 等大值请求时不主动拒绝（由推理后端自然截断）
2. [ ] **【字段命名】** 最终确认字段名 `context_length`（本文档推荐）还是其他

### P1（影响生产质量，开发期内补齐）

3. [x] **【失败策略】** ✅ **v1.2 已决策**：静态黄色横幅 + 引导 `/doctor`，不阻塞启动，异步成功后不刷新横幅（见 §7.0）
4. [x] **【首请求竞态】** ✅ **v1.2 已决策**：不处理。竞态概率 < 0.5%，接受为 v1 已知限制（见 §6.1）
5. [x] **【错误触发刷新】** ✅ **v1.3 已决策**：撤销。`context_length_exceeded` 语义混淆（多数是"对话太长"非"上限变了"）+ 格式依赖网关约定 + context_length 固有参数变更概率极低，v1 不实现。若有需要 v2 再评估（见 §6.3）

### P2（可后续迭代）

6. [ ] **【手动覆盖层】** 是否保留 `models-config.json` 作为可选层（推荐 v1 不保留，观察后再决定）
7. [x] **【modelAllowlist 联动】** ✅ **v1.2 已决策**：不需新增逻辑（`isModelAllowed()` 在 `availableModels` 未设置时默认全部放行，见 §9.1）；硬编码模型表保留作为兜底 fallback，不注释/删除
8. [x] **【当前仅 OpenAI provider】** ✅ **v1 覆盖范围确认**：内网网关当前仅部署 OpenAI provider，本方案完整覆盖；Codex / Bedrock / Vertex 等为 v2 范围
9. [ ] **【字段扩展】** 未来若网关需要返回 `max_output_tokens` / `supports_1m_context` 等更多能力字段时的协议升级路径（v2 预留）

---

## 十二、关键设计决策回顾

本节记录方案演进中的核心取舍，避免后续讨论重复推导。

### 12.1 为什么不返回 `max_tokens` 字段

**结论**：v1 协议只返回 `context_length`，不返回 `max_tokens`。

**关键事实链**：

1. `max_output_tokens_escalate` 机制（[query.ts:1214](../src/query.ts#L1214)）依赖 `default < upperLimit` 才能触发"先 8K 再升 64K"的重试
2. cap 机制本身被 GrowthBook flag `tengu_otk_slot_v1` 门禁（[claude.ts:3414-3416](../src/services/api/claude.ts#L3414-L3416)），默认 `false`
3. 内网无法访问 GrowthBook → `isMaxTokensCapEnabled()` 恒为 `false`
4. → cap 不生效 → `default = upperLimit` 永远成立 → escalation 路径在内网根本不会被触发
5. → 网关返回 `max_tokens` 对内网行为无任何影响，徒增协议复杂度

**附带好处**：避免与 OpenAI 协议中"`max_tokens` 是请求参数"的语义冲突。

### 12.2 为什么不需要字段别名 fallback

**结论**：CLI 端只解析 `context_length` 单一字段，不做 `context_window` / `max_model_len` / `n_ctx` 等别名兼容。

**理由**：本方案对接的是**自研网关**，字段命名由我方约定；别名 fallback 是为对接 vLLM / LiteLLM / TGI 等开源生态设计的，自研环境无此需求。

**风险与缓解**：未来若新增第二个网关（如对接公网开源服务），由那个 provider 的 shim 层做命名转换即可，不污染主链路。

### 12.3 为什么不为 thinking / reasoning_content 等能力字段预留协议位

**结论**：撤销原 P2-4 建议的 `capabilities` 子对象。

**理由**：[openaiShim.ts:276-283,649-661](../src/services/api/openaiShim.ts#L276-L283) 已通过**响应 payload 自适应**处理 reasoning_content（识别流式响应中的 `delta.reasoning_content` 字段并转换为 `thinking_delta`）。这种设计比 capability 元数据更鲁棒——同一模型在不同推理参数下的行为差异也能正确适配。

**何时可能需要重新引入**：当出现"必须预先知道才能正确发起请求"的能力（如某些 provider 必须在请求里带 `enable_thinking: true` 才会返回 reasoning），那时再 v2 协议升级。当前阶段不需要。

### 12.4 为什么不新建独立缓存字段，而复用 `additionalModelOptionsCache`

**结论**：扩展现有 `ModelOption` 类型，不新增 `discoveredModelCapabilities`。

**理由**：

- 已有 `fetchBootstrapData` / `listOpenAICompatibleModels` 启动入口（[main.tsx:2345](../src/main.tsx#L2345)）
- 已有 `additionalModelOptionsCacheScope` 的 baseUrl scope 隔离（[bootstrap.ts:188-200](../src/services/api/bootstrap.ts#L188-L200)）
- 已有 `saveGlobalConfig` 的并发安全写入

**v1.3 修正**：原文档中"与 `/model` 命令缓存复用"的表述是错误的。`/model` 命令实际写入 `openaiAdditionalModelOptionsCache`，与本方案操作的 `additionalModelOptionsCache` **是两个独立字段**。v1 选择不覆盖 `/model` 刷新链路（Option A），两者并存但互不干扰。

### 12.5 为什么启动机制选择 fire-and-forget + 静态横幅，而非阻塞启动

**结论**：v1 保持 `void fetchBootstrapData()` fire-and-forget 不变；失败时显示静态黄色横幅；不添加阻塞逻辑，不刷新横幅。

**三种方案对比**：

```
方案 C（过度工程）：
  启动 → 阻塞等待 bootstrap → REPL 就绪
                              ↓ 后台持续刷新
                         失败: 显示横幅 → 刷新成功: 更新横幅 ✓
         问题: 终端无 UI 刷新机制（Ink/React 已渲染节点不可更新）
               阻塞延迟体验（为 <0.5% 竞态概率）

方案 B（v1 采纳）：
  启动 → void fetchBootstrapData()（fire-and-forget）
       ↓ 并行
  REPL 立即就绪                 bootstrap 完成 → 缓存写入
  bootstrap 失败 → 静态横幅 ⚠   后续请求自然使用新缓存（无需横幅刷新）

方案 A（过于隐蔽）：
  bootstrap 失败 → 静默降级（用户不知道配置没生效）
```

**关键取舍**：

1. **不阻塞的理由**：竞态触发概率 < 0.5%（bootstrap 通常 300ms 完成，用户首次输入通常 > 1s）。为此阻塞启动会影响 100% 用户的启动体验，代价远大于收益。
2. **不刷新横幅的理由**：终端 UI（Ink/React）不支持更新已渲染内容。异步成功后唯一能做的是在下一轮输出时打印新内容，但这会破坏 REPL 的输出顺序，用户体验更差。
3. **静态横幅的价值**：失败时用户看到提示，知道有问题、知道去哪排查（`/doctor`），避免"明明设置了 128K 模型但一直用 200K"的无声错误。

**何时可以升级**：若未来终端 UI 支持可更新的状态条（类似 LSP 进度指示器），再考虑方案 C 的动态横幅。当前阶段方案 B 已经足够。

### 12.6 Q1 决策：两套缓存架构下选 Option A

**背景**：代码精查发现两套完全独立的缓存链路：

```
链路 A（bootstrap）：
  启动 → fetchBootstrapData() → listOpenAICompatibleModels() → additionalModelOptionsCache
  读取方：context.ts:findCachedModelOption()

链路 B（/model 刷新）：
  /model 命令 → refreshOpenAIModelOptionsCache()
             → discoverOpenAICompatibleModelOptions()
             → fetchOpenAIModels()（openaiModelDiscovery.ts）
             → openaiAdditionalModelOptionsCache
  读取方：模型选择器 UI（优先读此字段）
```

**Option A vs Option B**：

|                                 | Option A（v1 采纳）                               | Option B（v2 可选）                                                  |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| **改动范围**                    | 只改链路 A（providerDiscovery.ts + bootstrap.ts） | 同时改链路 A + B（openaiModelDiscovery.ts + haveSameModelOptions()） |
| **contextWindow 更新时机**      | 仅启动时（重启生效）                              | 启动 + `/model` 命令刷新均生效                                       |
| **haveSameModelOptions() 问题** | 不适用（链路 B 不携带 contextWindow，比较无意义） | **必须同时修复**（否则 contextWindow 变更被静默跳过）                |
| **回归风险**                    | 低（只改 bootstrap 链路）                         | 高（per-profile 缓存逻辑复杂，改动面大）                             |

**选 Option A 的核心理由**：`context_length` 是**模型固有参数**（来自推理框架的 `max_position_embeddings` / `max_model_len`），网关自主变更的概率极低（月级甚至更长），无需在会话内实时同步。重启 CLI 时 bootstrap 重新拉取即可满足需求。Option A 以最小改动量覆盖 99% 的使用场景。

### 12.7 Q2 决策：配置文件实际路径

**结论**：`saveGlobalConfig()` 写入的文件由 `getGlobalClaudeFile()` 决定（[src/utils/env.ts:14](../src/utils/env.ts#L14)）：

```typescript
export const getGlobalClaudeFile = memoize((): string => {
  if (existsSync(join(getYwCoderConfigHomeDir(), '.config.json'))) {
    return join(getYwCoderConfigHomeDir(), '.config.json') // ~/.ywcoder/.config.json（legacy）
  }
  const filename = `.claude${fileSuffixForOauthConfig()}.json`
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), filename) // ~/.claude.json（默认）
})
```

- **默认路径**：`~/.claude.json`（在 `$HOME` 下）
- **Legacy 路径**：`~/.ywcoder/.config.json`（若该文件已存在）
- **不存在的路径**：`~/.ywcoder/settings.json`（之前文档误写，已更正）

`additionalModelOptionsCache` 字段存储在 `~/.claude.json` 中（或 legacy 路径），而非任何 `settings.json`。
