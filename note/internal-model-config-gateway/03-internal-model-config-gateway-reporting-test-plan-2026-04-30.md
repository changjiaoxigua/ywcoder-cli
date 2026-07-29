# 内网模型能力参数网关自报告 — 需求说明书与测试计划

> **日期**：2026-04-30
> **对应方案版本**：v1.3
> **对应文档**：`internal-model-config-gateway-reporting-2026-04-27.md`

---

## 一、需求说明书

### 1.1 功能背景

取消用户手动维护 `models-config.json` 配置文件，改为由网关在 OpenAI 兼容 `/v1/models` 接口中自报告模型的 `context_length`（上下文窗口大小），CLI 启动时自动拉取并缓存到 `additionalModelOptionsCache`，实现内网模型的**零配置接入**。

### 1.2 功能范围

#### 1.2.1 网关侧（本方案只约定接口，不实现网关）

- `/v1/models` 响应中每个模型对象可扩展 `context_length` 字段（`number` 类型，> 0）
- 网关收到 `max_tokens` 大值请求时不主动拒绝，由推理后端自然截断

#### 1.2.2 CLI 侧（本方案实现范围）

| 模块           | 需求描述                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| **模型发现**   | `listOpenAICompatibleModels()` 解析 `/v1/models` 响应中的 `context_length`，返回带 `contextWindow` 的模型对象数组 |
| **启动缓存**   | `fetchBootstrapData()` 将发现的模型列表（含 `contextWindow`）写入 `additionalModelOptionsCache`                   |
| **上下文解析** | `getContextWindowForModel()` 新增缓存查询层：`additionalModelOptionsCache` → 硬编码表 → 默认值                    |
| **缓存读取**   | 新增 `findCachedModelOption()` 工具函数，固定读取 `additionalModelOptionsCache`，加 `openai:` scope 守卫          |
| **错误降级**   | 网关未返回 `context_length`、请求失败、缓存解析失败时，静默 fallback 到硬编码表 / 默认值                          |
| **启动提示**   | `fetchBootstrapData` 失败时，REPL 顶部显示一次性静态黄色横幅 —— **v1 未实现，v2 优化方向**                        |
| **诊断输出**   | `/doctor` 命令新增 `[Model Capabilities]` 段落（必须实现）                                                        |

### 1.3 优先级链路（`getContextWindowForModel`）

```
1. 环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS（需去除 USER_TYPE='ant' 门禁）
2. [1m] 后缀模型 → 1_000_000
3. OpenAI 兼容 provider 分支：
   3a. additionalModelOptionsCache[model].contextWindow（本方案新增）
   3b. getOpenAIContextWindow() 硬编码表
4. modelCapabilities / 1M Beta / resolveAntModel 等原有逻辑
5. 默认值 MODEL_CONTEXT_WINDOW_DEFAULT（200_000）
```

### 1.4 非功能需求

| 需求               | 说明                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| **向后兼容**       | 网关未返回 `context_length` 时，CLI 行为与原逻辑完全一致                            |
| **不影响公网用户** | 未配置网关扩展字段的公网用户无感知                                                  |
| **重启生效**       | `contextWindow` 变更需重启 CLI 才生效（固有参数，变更概率极低）                     |
| **并发安全**       | 缓存写入通过 `saveGlobalConfig` 已有路径，无需额外锁                                |
| **baseUrl 隔离**   | `additionalModelOptionsCacheScope` 形如 `openai:${baseUrl}`，切换 provider 不脏数据 |

### 1.5 明确不做的范围（v1 边界）

- 不返回 `max_tokens` 字段（escalation 机制对内网不生效）
- 不改 `/model` 命令刷新链路（`openaiAdditionalModelOptionsCache` 不含 `contextWindow`）
- 不监听 `context_length_exceeded` 错误触发刷新
- 不新增 `models-config.json` 手动覆盖层（v1 推荐不保留）
- **方案A（v1.x 补丁）**：运行时过滤 `/model` 展示列表和 `getContextWindowForModel()` fallback 链路，不改硬编码数据源本身

---

## 二、测试点（Test Points）

### TP-01：网关接口解析 — 正常场景

- 网关返回 `context_length`，`listOpenAICompatibleModels()` 正确解析并返回带 `contextWindow` 的对象
- 多个模型分别返回不同 `context_length`，均正确解析

### TP-02：网关接口解析 — 边界与异常

- 网关未返回 `context_length` 字段 → `contextWindow` 为 `undefined`
- `context_length` 为 `null` → 忽略
- `context_length` 为负数 / 0 / 非数字 → 忽略（视为无效）
- 网关返回空列表 → 返回空数组（非 `null`）
- 网关返回重复模型 ID → 去重（保留最后一个的 `context_length`，Map 后值覆盖前值）

### TP-03：启动缓存链路 — 正常写入

- 启动时 `fetchBootstrapData()` 成功拉取 → `additionalModelOptionsCache` 写入正确（含 `contextWindow`）
- `additionalModelOptionsCacheScope` 正确设置为 `openai:${baseUrl}`
- 缓存已存在且内容相同 → 不重复写入（`isEqual` 比较）

### TP-04：启动缓存链路 — 异常与降级

- `/v1/models` 请求超时（> 5s）→ 返回 `null`，保留上次缓存
- `/v1/models` 返回 401/403/5xx → 返回 `null`，保留上次缓存
- 首次启动且无上次缓存 → `additionalModelOptionsCache` 为空，`getContextWindowForModel` fallback 到硬编码表
- 首次启动且无上次缓存、模型也不在硬编码表 → fallback 到 200K 默认值

### TP-05：优先级链路 — `getContextWindowForModel`

- 环境变量 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 存在 → 优先使用（即使缓存和硬编码表都有值）
- `[1m]` 后缀模型 → 返回 1_000_000（优先级高于缓存）
- 缓存命中 → 返回缓存的 `contextWindow`
- 缓存未命中、硬编码表命中 → 返回硬编码值
- 均未命中 → 返回 200K 默认值

### TP-06：缓存读取 — `findCachedModelOption`

- 固定读取 `additionalModelOptionsCache`（不读 `openaiAdditionalModelOptionsCache`）
- 非 `openai:` scope 时返回 `undefined`（不查询）
- 按 `value` 和 `label` 匹配模型名
- 模型不存在于缓存 → 返回 `undefined`

### TP-07：provider 切换

- 切换 baseUrl 后 scope 变更 → `getScopedAdditionalModelOptions()` 返回空，触发重新拉取
- 新 provider 的 `context_length` 正确写入新的 scope

### TP-08：启动失败提示（v2 优化方向）

> **v1 状态**：未实现。当前失败路径仅 `logForDebugging`/`logError` 静默降级，用户无感知。`/doctor` 段落是 v1 唯一可观测性兜底。

- `fetchBootstrapData` 失败时，REPL 顶部显示黄色静态横幅
- 横幅只显示一次，不随异步恢复刷新
- 横幅文案包含运行 `/doctor` 的引导

### TP-09：`/doctor` 诊断（必须实现）

- 显示已发现模型列表及各自的 `contextWindow` 来源（网关 / 硬编码 / 默认）
- 显示缓存 scope 和最后刷新时间
- 启动日志同步打印精简版 `[ModelCapabilities] discovered N models from {scope}` —— **v1 未实现，归入 v2 优化方向「启动日志诊断」**

### TP-10：回归测试 — 不影响现有功能

- 公网用户（firstParty provider）行为完全不变
- `/model` 命令刷新链路行为不变（`openaiAdditionalModelOptionsCache` 不含 `contextWindow`）
- `getModelMaxOutputTokens()` 完全不变
- 硬编码表 `openaiContextWindows.ts` 不被删除或注释

### TP-11：内网模型列表过滤（方案A）

- `/model` 选择器在 `isLocalProviderUrl()=true` 时，不展示硬编码预设模型
- `/model` 选择器在 `isLocalProviderUrl()=true` 且网关返回空列表时，展示空列表 + 提示
- `/model` 选择器在 `isLocalProviderUrl()=false`（公网）时，正常展示硬编码模型
- `getContextWindowForModel()` 内网环境下，缓存非空时跳过硬编码表 fallback
- `getContextWindowForModel()` 内网环境下，缓存为空时仍返回默认值 200K

---

## 三、测试用例（Test Cases）

### TC-01：网关正常返回 context_length

| 项           | 内容                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-01                                                                                                               |
| **测试点**   | TP-01                                                                                                               |
| **前置条件** | 设置 `OPENAI_BASE_URL=http://gw.intra/v1`，网关 `/v1/models` 正常返回                                               |
| **输入**     | 网关响应：`{ data: [{ id: "qwen2.5-72b", context_length: 131072 }, { id: "deepseek-r1", context_length: 65536 }] }` |
| **执行步骤** | 1. 调用 `listOpenAICompatibleModels({ baseUrl: 'http://gw.intra/v1', apiKey: 'key' })`                              |
| **预期结果** | 返回 `[{ id: 'qwen2.5-72b', contextWindow: 131072 }, { id: 'deepseek-r1', contextWindow: 65536 }]`                  |

---

### TC-02：网关未返回 context_length

| 项           | 内容                                                                               |
| ------------ | ---------------------------------------------------------------------------------- |
| **ID**       | TC-02                                                                              |
| **测试点**   | TP-02                                                                              |
| **前置条件** | 网关兼容旧协议，不返回 `context_length`                                            |
| **输入**     | 网关响应：`{ data: [{ id: "qwen2.5-72b" }] }`                                      |
| **执行步骤** | 1. 调用 `listOpenAICompatibleModels()`                                             |
| **预期结果** | 返回 `[{ id: 'qwen2.5-72b', contextWindow: undefined }]`，不影响后续 fallback 逻辑 |

---

### TC-03：context_length 为无效值

| 项           | 内容                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-03                                                                                                                                                          |
| **测试点**   | TP-02                                                                                                                                                          |
| **前置条件** | 网关返回异常值                                                                                                                                                 |
| **输入**     | 网关响应：`{ data: [{ id: "a", context_length: -1 }, { id: "b", context_length: 0 }, { id: "c", context_length: "abc" }, { id: "d", context_length: null }] }` |
| **执行步骤** | 1. 调用 `listOpenAICompatibleModels()`                                                                                                                         |
| **预期结果** | 四者 `contextWindow` 均为 `undefined`                                                                                                                          |

---

### TC-04：重复模型 ID 去重

| 项           | 内容                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-04                                                                                                       |
| **测试点**   | TP-02                                                                                                       |
| **输入**     | 网关响应：`{ data: [{ id: "qwen2.5", context_length: 131072 }, { id: "qwen2.5", context_length: 65536 }] }` |
| **执行步骤** | 1. 调用 `listOpenAICompatibleModels()`                                                                      |
| **预期结果** | 返回 `[{ id: 'qwen2.5', contextWindow: 65536 }]`（保留最后一个，`new Map()` 后值覆盖前值）                  |

---

### TC-05：启动时成功写入缓存

| 项           | 内容                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-05                                                                                                                                                                                   |
| **测试点**   | TP-03                                                                                                                                                                                   |
| **前置条件** | 首次启动，无已有缓存                                                                                                                                                                    |
| **执行步骤** | 1. 启动 CLI（触发 `fetchBootstrapData()`）<br>2. 读取 `getGlobalConfig().additionalModelOptionsCache`                                                                                   |
| **预期结果** | 缓存中包含 `{ value: "qwen2.5-72b", label: "qwen2.5-72b", contextWindow: 131072, description: "Detected from ..." }`；`additionalModelOptionsCacheScope` 为 `openai:http://gw.intra/v1` |

---

### TC-06：缓存未变化时不重复写入

| 项           | 内容                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-06                                                                                                    |
| **测试点**   | TP-03                                                                                                    |
| **前置条件** | 已有缓存与网关返回内容完全一致                                                                           |
| **执行步骤** | 1. 记录 `additionalModelOptionsCache` 当前值<br>2. 再次启动 CLI<br>3. 检查 `saveGlobalConfig` 是否被调用 |
| **预期结果** | `saveGlobalConfig` **未被调用**（通过 `isEqual` 比较，跳过写入）                                         |

---

### TC-07：网关请求失败保留上次缓存

| 项           | 内容                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| **ID**       | TC-07                                                                                   |
| **测试点**   | TP-04                                                                                   |
| **前置条件** | 已有缓存 `{ qwen2.5-72b: contextWindow=131072 }`                                        |
| **执行步骤** | 1. 模拟网关返回 503<br>2. 启动 CLI<br>3. 调用 `getContextWindowForModel('qwen2.5-72b')` |
| **预期结果** | 返回 `131072`（使用上次缓存，不覆盖）                                                   |

---

### TC-08：首次启动且无缓存 fallback 到默认值

| 项           | 内容                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **ID**       | TC-08                                                                                 |
| **测试点**   | TP-04 / TP-05                                                                         |
| **前置条件** | 首次启动，网关不可达，模型不在硬编码表                                                |
| **执行步骤** | 1. 模拟网关超时<br>2. 启动 CLI<br>3. 调用 `getContextWindowForModel('unknown-model')` |
| **预期结果** | 返回 `200_000`（默认值）                                                              |

---

### TC-09：优先级 — 环境变量最高

| 项           | 内容                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| **ID**       | TC-09                                                                        |
| **测试点**   | TP-05                                                                        |
| **前置条件** | 设置 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=50000`，缓存中有 `contextWindow=131072` |
| **执行步骤** | 1. 调用 `getContextWindowForModel('qwen2.5-72b')`                            |
| **预期结果** | 返回 `50000`（环境变量优先）                                                 |

---

### TC-10：优先级 — 缓存命中高于硬编码表

| 项           | 内容                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| **ID**       | TC-10                                                                                      |
| **测试点**   | TP-05                                                                                      |
| **前置条件** | 缓存中有 `gpt-4o: contextWindow=64000`（假设网关配置了覆盖值），硬编码表中 `gpt-4o=128000` |
| **执行步骤** | 1. 调用 `getContextWindowForModel('gpt-4o')`                                               |
| **预期结果** | 返回 `64000`（缓存优先于硬编码表）                                                         |

---

### TC-11：findCachedModelOption scope 守卫

| 项           | 内容                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| **ID**       | TC-11                                                                             |
| **测试点**   | TP-06                                                                             |
| **前置条件** | `additionalModelOptionsCacheScope` 为 `openai:http://gw.intra/v1`，缓存中有模型 A |
| **执行步骤** | 1. 调用 `findCachedModelOption('model-a')`                                        |
| **预期结果** | 返回缓存对象（scope 匹配）                                                        |

---

### TC-12：findCachedModelOption 非 openai scope 不查

| 项           | 内容                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| **ID**       | TC-12                                                                    |
| **测试点**   | TP-06                                                                    |
| **前置条件** | `additionalModelOptionsCacheScope` 为 `firstParty`（或其他非 openai 值） |
| **执行步骤** | 1. 调用 `findCachedModelOption('any-model')`                             |
| **预期结果** | 返回 `undefined`（不查询缓存）                                           |

---

### TC-13：provider 切换重新拉取

| 项           | 内容                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-13                                                                                                         |
| **测试点**   | TP-07                                                                                                         |
| **前置条件** | 当前 scope 为 `openai:http://gw-a/v1`，缓存中有模型 A                                                         |
| **执行步骤** | 1. 切换 `OPENAI_BASE_URL` 到 `http://gw-b/v1`<br>2. 启动 CLI<br>3. 调用 `getContextWindowForModel('model-a')` |
| **预期结果** | 返回硬编码表 / 默认值（scope 变更，旧缓存不生效，触发重新拉取 gw-b）                                          |

---

### TC-14：启动失败横幅显示（v2 优化方向）

> **v1 状态**：未实现。当前 bootstrap 失败时仅静默降级到硬编码表/默认值，用户无感知。

| 项           | 内容                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **ID**       | TC-14                                                                                 |
| **测试点**   | TP-08                                                                                 |
| **前置条件** | 网关不可达（模拟网络故障）                                                            |
| **执行步骤** | 1. 启动 CLI<br>2. 观察 REPL 顶部输出                                                  |
| **预期结果** | 显示一次性黄色横幅：`⚠ 模型能力加载失败，使用默认 200K 上下文。运行 /doctor 查看详情` |

---

### TC-15：/doctor 诊断输出（必须实现）

| 项           | 内容                                                                                                                                                                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-15                                                                                                                                                                                                                                                                                                                      |
| **测试点**   | TP-09                                                                                                                                                                                                                                                                                                                      |
| **前置条件** | 缓存中有 3 个模型：qwen2.5-72b（contextWindow=131072，来自网关）、deepseek-r1（contextWindow=65536，来自网关）、llama-internal（无 contextWindow）                                                                                                                                                                         |
| **执行步骤** | 1. 执行 `/doctor` 命令                                                                                                                                                                                                                                                                                                     |
| **预期结果** | 输出包含 `[Model Capabilities]` 段落，格式示例：<br>`来源: openai:http://gw.intra/v1`<br>`缓存状态: 已加载 3 个模型，其中 2 个含 context_length`<br>`  └ qwen2.5-72b: context_length=131072`<br>`  └ deepseek-r1: context_length=65536`<br>`  └ llama-internal: 未提供 context_length → fallback 到硬编码表或 200K 默认值` |

---

### TC-15a：启动日志诊断输出（v2 优化方向）

> **v1 状态**：未实现。当前启动流程未输出 `[ModelCapabilities]` 日志，仅 `/doctor` 可查看缓存状态。

| 项           | 内容                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- |
| **ID**       | TC-15a                                                                                   |
| **测试点**   | TP-09                                                                                    |
| **前置条件** | 启动时 bootstrap 成功拉取到 3 个模型                                                     |
| **执行步骤** | 1. 启动 CLI                                                                              |
| **预期结果** | 控制台打印一行：`[ModelCapabilities] discovered 3 models from openai:http://gw.intra/v1` |

---

### TC-16：不影响 firstParty 用户

| 项           | 内容                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-16                                                                                                                |
| **测试点**   | TP-10                                                                                                                |
| **前置条件** | `getAPIProvider() === 'firstParty'`（公网 Anthropic 用户）                                                           |
| **执行步骤** | 1. 启动 CLI<br>2. 检查 `additionalModelOptionsCache` 是否被写入 openai 模型数据                                      |
| **预期结果** | `fetchBootstrapData()` 走 `fetchBootstrapAPI()` 路径，**不调用** `listOpenAICompatibleModels()`，openai 缓存不受影响 |

---

### TC-17：不影响 /model 命令刷新链路

| 项           | 内容                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-17                                                                                                             |
| **测试点**   | TP-10                                                                                                             |
| **前置条件** | 已启动，缓存中有 `contextWindow`                                                                                  |
| **执行步骤** | 1. 执行 `/model` 命令<br>2. 观察 `openaiAdditionalModelOptionsCache` 变化<br>3. 调用 `getContextWindowForModel()` |
| **预期结果** | `/model` 刷新**不携带** `contextWindow`；`getContextWindowForModel()` 仍返回 bootstrap 缓存中的值                 |

---

### TC-18：硬编码表保留为兜底

| 项           | 内容                                                                        |
| ------------ | --------------------------------------------------------------------------- |
| **ID**       | TC-18                                                                       |
| **测试点**   | TP-10                                                                       |
| **前置条件** | 网关未返回 `context_length`，模型 `deepseek-chat` 在硬编码表中定义为 128000 |
| **执行步骤** | 1. 调用 `getContextWindowForModel('deepseek-chat')`                         |
| **预期结果** | 返回 `128000`（硬编码表命中）                                               |

---

### TC-19：configMigration 迁移 ~/.claude.json → ~/.ywcoder/.config.json

| 项           | 内容                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-19                                                                                                                                    |
| **测试点**   | Task 7                                                                                                                                   |
| **前置条件** | `~/.claude.json` 存在，`~/.ywcoder/.config.json` 不存在                                                                                  |
| **执行步骤** | 1. 运行 `ywcoder --migrate-config`                                                                                                       |
| **预期结果** | `~/.ywcoder/.config.json` 被创建，内容与 `~/.claude.json` 一致；控制台输出 `✓ 迁移全局配置文件 ~/.claude.json → ~/.ywcoder/.config.json` |

---

### TC-20：configMigration 目录不存在但 JSON 存在仍可迁移

| 项           | 内容                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TC-20                                                                                                                        |
| **测试点**   | Task 7                                                                                                                       |
| **前置条件** | `~/.claude/` 目录不存在（或已被删除），但 `~/.claude.json` 仍存在；`~/.ywcoder/.config.json` 不存在                          |
| **执行步骤** | 1. 运行 `ywcoder --migrate-config`                                                                                           |
| **预期结果** | JSON 迁移成功（`~/.ywcoder/.config.json` 被创建）；目录迁移因无源目录而跳过，最终返回 `Created new config directory`，不报错 |

---

### TC-21：configMigration 已存在目标文件时不覆盖

| 项           | 内容                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **ID**       | TC-21                                                                                 |
| **测试点**   | Task 7                                                                                |
| **前置条件** | `~/.ywcoder/.config.json` 已存在                                                      |
| **执行步骤** | 1. 运行 `ywcoder --migrate-config`                                                    |
| **预期结果** | 控制台输出 `~/.ywcoder/.config.json 已存在，跳过（保留现有配置）`；原文件内容不被覆盖 |

---

### TC-22：内网 `/model` 只展示网关发现模型

| 项           | 内容                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **ID**       | TC-22                                                                                 |
| **测试点**   | TP-11                                                                                 |
| **前置条件** | `OPENAI_BASE_URL=http://gw.intra/v1`（`isLocalProviderUrl()` 为 true），bootstrap 已完成（`additionalModelOptionsCache` 含 `qwen2.5-72b` 和 `deepseek-r1`）或 `/model` 刷新已完成（`openaiAdditionalModelOptionsCache` 含相同模型） |
| **输入**     | 网关返回 `qwen2.5-72b`、`deepseek-r1`                                                 |
| **执行步骤** | 1. 执行 `/model` 命令                                                                 |
| **预期结果** | 选择器只展示 `qwen2.5-72b` 和 `deepseek-r1`，不展示 `gpt-4o`、`claude-3-opus` 等      |

---

### TC-23a：内网 `/model` 网关返回空列表时提示

| 项           | 内容                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **ID**       | TC-23a                                                                                |
| **测试点**   | TP-11                                                                                 |
| **前置条件** | `OPENAI_BASE_URL=http://gw.intra/v1`，网关正常响应但返回空列表 `[]`，`openaiAdditionalModelOptionsCache` 已被更新为空 |
| **执行步骤** | 1. 执行 `/model` 命令                                                                 |
| **预期结果** | 选择器为空，显示提示文案："未从网关发现可用模型，请检查 OPENAI_BASE_URL 配置"          |

---

### TC-23b：内网 `/model` 首次启动且网关不可达时提示

| 项           | 内容                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **ID**       | TC-23b                                                                                |
| **测试点**   | TP-11                                                                                 |
| **前置条件** | `OPENAI_BASE_URL=http://gw.intra/v1`，首次启动（`additionalModelOptionsCache` 和 `openaiAdditionalModelOptionsCache` 均为空），网关不可达（超时/5xx） |
| **执行步骤** | 1. 执行 `/model` 命令                                                                 |
| **预期结果** | 选择器为空，显示提示文案："未从网关发现可用模型，请检查 OPENAI_BASE_URL 配置"          |

---

### TC-24：公网 `/model` 不受影响

| 项           | 内容                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| **ID**       | TC-24                                                                               |
| **测试点**   | TP-11                                                                               |
| **前置条件** | `OPENAI_BASE_URL=https://api.openai.com/v1`（`isLocalProviderUrl()` 为 false）      |
| **执行步骤** | 1. 执行 `/model` 命令                                                               |
| **预期结果** | 正常展示硬编码预设模型（gpt-4o、gpt-4-turbo 等）和发现模型                           |

---

### TC-25：内网 contextWindow 明确跳过硬编码表（缓存与硬编码表冲突时）

| 项           | 内容                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| **ID**       | TC-25                                                                               |
| **测试点**   | TP-11                                                                               |
| **前置条件** | `OPENAI_BASE_URL=http://gw.intra/v1`，`additionalModelOptionsCache` 非空，缓存含 `deepseek-chat: 131072`，且 `getOpenAIContextWindow('deepseek-chat')` 硬编码表返回 `128000` |
| **输入**     | 调用 `getContextWindowForModel('deepseek-chat')`                                    |
| **预期结果** | 返回 `131072`（缓存值），而非 `128000`（硬编码表值），直接验证内网环境下**跳过**硬编码表 fallback |

---

### TC-26：内网未知模型不走硬编码表

| 项           | 内容                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| **ID**       | TC-26                                                                               |
| **测试点**   | TP-11                                                                               |
| **前置条件** | `OPENAI_BASE_URL=http://gw.intra/v1`，缓存非空，模型 `unknown-model` 不在缓存中     |
| **输入**     | 调用 `getContextWindowForModel('unknown-model')`                                    |
| **预期结果** | 返回 `200_000`（默认值），**不**查询 `getOpenAIContextWindow()` 硬编码表             |

---

## 四、测试覆盖矩阵

| 测试用例                       | 单元测试 | 集成测试                          | 回归测试 |
| ------------------------------ | -------- | --------------------------------- | -------- |
| TC-01 ~ TC-04（解析逻辑）      | ✅ 必须  | —                                 | —        |
| TC-05 ~ TC-06（缓存写入）      | ✅ 必须  | —                                 | —        |
| TC-07 ~ TC-08（异常降级）      | ✅ 必须  | ✅ 建议                           | —        |
| TC-09 ~ TC-10（优先级链路）    | ✅ 必须  | —                                 | —        |
| TC-11 ~ TC-12（scope 守卫）    | ✅ 必须  | —                                 | —        |
| TC-13（provider 切换）         | —        | ✅ 建议                           | —        |
| TC-14（失败横幅）              | —        | ❌ 未实现（v1 静默降级，v2 考虑） | —        |
| TC-15 ~ TC-15a（/doctor 诊断） | ✅ 必须  | ✅ 建议                           | —        |
| TC-16 ~ TC-18（回归）          | —        | ✅ 必须                           | ✅ 必须  |
| TC-19 ~ TC-21（配置迁移）      | —        | ✅ 必须                           | —        |
| TC-22（/model 过滤）           | ✅ 必须  | ✅ 建议                           | —        |
| TC-23a ~ TC-23b（空列表提示）  | ✅ 必须  | ✅ 建议                           | —        |
| TC-24（公网不受影响）          | —        | ✅ 必须                           | ✅ 必须  |
| TC-25 ~ TC-26（contextWindow） | ✅ 必须  | —                                 | —        |

---

## 附录 A：集成测试与 Mock 步骤说明

### A.1 三种测试类型的区别

| 类型         | 含义                                          | 在本项目中的典型写法                                 |
| ------------ | --------------------------------------------- | ---------------------------------------------------- |
| **单元测试** | 只测一个函数/模块，外部依赖全部"假装"（mock） | `bun test src/utils/providerDiscovery.test.ts`       |
| **集成测试** | 多个模块串联起来测，部分真实组件参与          | 启动 CLI → 触发 bootstrap → 检查全局配置文件是否写入 |
| **回归测试** | 验证原有功能没被改坏                          | 跑全部测试套件 `bun test --max-concurrency=1`        |

### A.2 什么是 Mock

**Mock** = 测试中"替换"外部依赖，让它按你的意愿返回固定结果，而不是真的去执行。

**为什么需要 mock**：

- 测试 `listOpenAICompatibleModels()` 时，不能真的去连内网网关（网关可能没搭好、网络可能不通）
- mock 后，无论什么时候跑测试，结果都是确定的

### A.3 本项目中的 Mock 示例

#### Mock 1：模拟网关 HTTP 响应（fetch mock）

```typescript
// providerDiscovery.test.ts 中已经使用的方式
globalThis.fetch = mock((input, init) => {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        data: [
          { id: 'qwen2.5-72b', context_length: 131072 },
          { id: 'deepseek-r1', context_length: 65536 },
        ],
      }),
      { status: 200 },
    ),
  )
}) as typeof globalThis.fetch
```

**说明**：把 `globalThis.fetch` 换成一个假函数，它永远返回上面那个 JSON。被测代码调用 `fetch()` 时，拿到的是这个假数据，不会真的发 HTTP 请求。

#### Mock 2：模拟全局配置（getGlobalConfig mock）

```typescript
// 测试中需要让 getGlobalConfig() 返回特定缓存值
import { getGlobalConfig } from '../config.js'

const originalGetGlobalConfig = getGlobalConfig
// 替换为返回固定值
mock.module('../config.js', () => ({
  ...jest.requireActual('../config.js'),
  getGlobalConfig: () => ({
    additionalModelOptionsCache: [
      { value: 'qwen2.5-72b', label: 'qwen2.5-72b', contextWindow: 131072 },
    ],
    additionalModelOptionsCacheScope: 'openai:http://gw.intra/v1',
  }),
}))
```

**说明**：`getContextWindowForModel()` 内部会调 `getGlobalConfig()`，mock 后可以让它读到你构造的缓存数据，而不依赖磁盘上的真实配置文件。

#### Mock 3：模拟网络超时

```typescript
globalThis.fetch = mock(
  () =>
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), 6000) // 超过 5s 超时
    }),
)
```

**说明**：`listOpenAICompatibleModels()` 内部设置了 5s 超时，mock 一个 6s 后才 reject 的 Promise，可以测试超时降级逻辑。

### A.4 集成测试的具体做法（以 TC-13 为例）

TC-13 "provider 切换重新拉取" 属于集成测试，因为涉及：

1. 环境变量变更（`OPENAI_BASE_URL`）
2. `getAdditionalModelOptionsCacheScope()` 重新计算
3. `fetchBootstrapData()` 重新拉取
4. `getContextWindowForModel()` 读取新缓存

**具体步骤**：

```bash
# 步骤 1：第一次启动，使用 gw-a
export OPENAI_BASE_URL=http://gw-a/v1
export OPENAI_API_KEY=key-a
bun run dev
# 验证：getContextWindowForModel('model-a') 返回 gw-a 的值

# 步骤 2：退出，切换 provider
export OPENAI_BASE_URL=http://gw-b/v1
export OPENAI_API_KEY=key-b
bun run dev
# 验证：getContextWindowForModel('model-a') 返回硬编码表/默认值（旧缓存不生效）
# 验证：additionalModelOptionsCacheScope 已变为 openai:http://gw-b/v1
```

或者用测试框架写：

```typescript
// 集成测试伪代码
test('TC-13: provider 切换重新拉取', async () => {
  // 模拟 gw-a 的响应
  process.env.OPENAI_BASE_URL = 'http://gw-a/v1'
  await fetchBootstrapData()
  const scopeA = getGlobalConfig().additionalModelOptionsCacheScope
  expect(scopeA).toBe('openai:http://gw-a/v1')

  // 切换 provider
  process.env.OPENAI_BASE_URL = 'http://gw-b/v1'
  await fetchBootstrapData()
  const scopeB = getGlobalConfig().additionalModelOptionsCacheScope
  expect(scopeB).toBe('openai:http://gw-b/v1')
})
```

### A.5 本项目中哪些测试需要 Mock

| 测试用例      | 需要 Mock 什么                                                                                    | Mock 难度          |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------ |
| TC-01 ~ TC-04 | `globalThis.fetch`（模拟网关 JSON 响应）                                                          | 低（已有测试模板） |
| TC-05 ~ TC-06 | `getGlobalConfig()` / `saveGlobalConfig()`（模拟磁盘配置）                                        | 中                 |
| TC-07 ~ TC-08 | `globalThis.fetch`（模拟 503 / 超时） + `getGlobalConfig()`                                       | 中                 |
| TC-09 ~ TC-10 | `getGlobalConfig()` + `process.env`                                                               | 低                 |
| TC-11 ~ TC-12 | `getGlobalConfig()`                                                                               | 低                 |
| TC-13         | `process.env.OPENAI_BASE_URL` + `globalThis.fetch`                                                | 中                 |
| TC-14         | **v1 未实现**。若 v2 实现，需启动完整 CLI 流程验证横幅渲染，mock 较难                             | 高                 |
| TC-15         | `getGlobalConfig()`                                                                               | 低                 |
| TC-15a        | **v1 未实现**。若 v2 实现，需在 `fetchBootstrapData()` 完成路径中 mock `console.log` 断言启动日志 | 低                 |
| TC-16         | `getAPIProvider()`（返回 'firstParty'）                                                           | 低                 |
| TC-17         | `discoverOpenAICompatibleModelOptions()`（确保不返回 contextWindow）                              | 低                 |
| TC-18         | `getGlobalConfig()`（空缓存）                                                                     | 低                 |

---

## 五、后续优化方向（v2）

以下需求/测试点在 **v1 中未实现**，已记录为后续迭代候选：

| #     | 方向                                   | 背景                                                                                                                                                                                                 | 建议策略                                                                                                                                                                                                                             |
| ----- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | **启动失败横幅（TP-08 / TC-14）**      | v1 中 bootstrap 失败仅静默降级，用户无感知                                                                                                                                                           | 在 `fetchBootstrapData()` 失败路径中，通过全局状态或 `useEffect` 在 REPL 顶部渲染一次性黄色静态横幅，提示「模型能力加载失败，使用默认 200K 上下文。运行 /doctor 查看详情」                                                           |
| **2** | **启动日志诊断（TC-15a）**             | v1 中 bootstrap 成功/失败均无 `[ModelCapabilities]` 启动日志                                                                                                                                         | 在 `fetchBootstrapData()` 完成时同步打印一行 `[ModelCapabilities] discovered N models from {scope}`，失败时打印 `[ModelCapabilities] failed to discover models, fallback to hardcoded/default`                                       |
| **3** | **Profile 切换实时刷新 contextWindow** | v1 中同会话切换 provider profile 后，`additionalModelOptionsCache` 仍是切换前的快照（`setActiveProviderProfile()` 只刷新 `openaiAdditionalModelOptionsCache`，不刷新 `additionalModelOptionsCache`） | 方案 A：在 `setActiveProviderProfile()` 末尾追加 `void fetchBootstrapData()`，异步刷新缓存；方案 B：在 `findCachedModelOption()` 内校验 `additionalModelOptionsCacheScope === 期望 scope`，不匹配时返回 `undefined` 走 fallback 兜底 |
| **4** | **context_length_exceeded 触发刷新**   | v1 明确不监听推理时返回的 `context_length_exceeded` 错误                                                                                                                                             | 在 `src/services/api/errors.ts` 中新增：收到 `context_length_exceeded` 时自动重新调用 `fetchBootstrapData()` 并刷新缓存                                                                                                              |

---

_文档最后更新：2026-05-06_
