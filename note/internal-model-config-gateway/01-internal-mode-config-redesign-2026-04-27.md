# 内网自定义模型与上下文配置改造方案

> **日期标签**：2026-04-27（v1.2 更新于 2026-04-27）
> **版本**：v1.2（采纳第三方 review，补充 resolveAntModel 链路与 modelCapabilities stub 说明）
> **目标**：支持内网环境下的自定义模型清单与可配置上下文大小，无需修改源码即可适配
> **文档位置**：本文位于 `note/` 目录，文中相对路径均以仓库根为基准

---

## 一、背景与动机

YwCoder 当前的模型能力（contextWindow / maxOutputTokens）通过 [src/utils/model/openaiContextWindows.ts](../src/utils/model/openaiContextWindows.ts) 中的硬编码表维护，覆盖约 40 个公网模型。内网部署后会遇到以下问题：

1. **内网模型不在硬编码表中** → fallback 到默认值 `MODEL_CONTEXT_WINDOW_DEFAULT = 200_000`，与实际不符
2. **环境变量 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 是全局单值** → 多模型共存时无法独立配置
3. **不同内网模型的 maxOutputTokens 差异大** → 默认值会触发 API 报 `max_tokens is too large` 错误

---

## 二、当前架构概览

### 2.1 上下文大小解析优先级（[context.ts](../src/utils/context.ts)）

```
环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS  ★ 仅 USER_TYPE='ant' 时生效（详见 §10）
    ↓
模型名带 [1m] 后缀 → 强制 1M
    ↓
getOpenAIContextWindow(model)   ← 硬编码表（USE_OPENAI/GEMINI/GITHUB 启用时，内网模型卡在这里）
    ↓
modelCapabilities（外部构建中是空 stub，永远返回 undefined；仅 ant 内部构建有实现，详见 §2.3）
    ↓
1M Beta 权限检查（CONTEXT_1M_BETA_HEADER + modelSupports1M）
    ↓
getSonnet1mExpTreatmentEnabled（仅 sonnet-4-6，依赖 GrowthBook 灰度位 coral_reef_sonnet）
    ↓
resolveAntModel().contextWindow  ★ 仅 USER_TYPE='ant' 时生效（GrowthBook tengu_ant_model_override 动态下发）
    ↓
默认值 200_000
```

**关键警示**：

- 第一层与倒数第二层都是 `USER_TYPE === 'ant'` 门禁；非 ant（即所有内网用户）会**直接跳过**
- `modelCapabilities` 在外部构建中是空 stub（`return undefined`），实际不参与决策；阅读源码时不要被它误导
- `getSonnet1mExpTreatmentEnabled` 同样依赖 GrowthBook，内网无法访问，等同于始终返回 false

### 2.2 输出 Token 解析优先级（[context.ts](../src/utils/context.ts)）

```
getOpenAIMaxOutputTokens(model)  ← 硬编码表（内网模型卡在这里）
    ↓
按 Claude 模型版本硬编码规则
    ↓
默认 { default: 32_768, upperLimit: 65_536 }
```

### 2.3 `modelCapabilities` 在外部构建中是空 stub

[src/utils/model/modelCapabilities.ts](../src/utils/model/modelCapabilities.ts) 在本 fork（外部构建）中的完整实现：

```typescript
// External build: internal model-capabilities fetch/cache path is disabled.
// Preserve a stable public surface so callers can continue to import it.

export type ModelCapability = {
  id: string
  max_input_tokens?: number
  max_tokens?: number
}

export function getModelCapability(
  _model: string,
): ModelCapability | undefined {
  return undefined
}

export async function refreshModelCapabilities(): Promise<void> {}
```

**含义**：

- 上游 ant 内部构建中，`getModelCapability` 会从 Anthropic 内部 API 拉取 firstParty 模型的精确能力（含 max_input_tokens / max_tokens），覆盖硬编码表
- 外部构建（包括本 fork）保留**接口签名**但实现为空，所有调用返回 `undefined`
- [context.ts:87-96](../src/utils/context.ts#L87-L96) 与 [context.ts:228-232](../src/utils/context.ts#L228-L232) 中对 `getModelCapability` 的引用在外部构建中**永远走不到 if 分支**

**对本方案的影响**：

- 阅读源码时若误以为 modelCapabilities 会动态影响 contextWindow / maxOutputTokens，会浪费排查时间
- 本方案的"用户配置文件"事实上**填补了** modelCapabilities 在外部构建中失效留下的能力空缺
- 未来如果上游开放此实现，应优先以模型自报告能力为准，用户配置作为覆盖层

> **生效条件速查表**
>
> | 构建类型                                   | `getModelCapability` 行为                   | 是否影响 contextWindow / maxOutputTokens                          |
> | ------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------- |
> | **外部构建**（本 fork / 开源版本）         | 空 stub，永远返回 `undefined`               | ❌ **不生效**（代码里 `if (cap?.max_input_tokens)` 永远为 false） |
> | **ant 内部构建**（Anthropic 官方闭源版本） | 从内部 API 拉取 firstParty 模型能力表并缓存 | ✅ **生效**（可覆盖硬编码表中的默认值）                           |
>
> **判断自己所处构建类型的简易方法**：查看 `src/utils/model/modelCapabilities.ts` 文件内容。若 `getModelCapability` 函数体只有 `return undefined`，即属于外部构建，此层可安全忽略。

### 2.4 模型清单来源

- **firstParty**：从 Anthropic API `/api/claude_cli/bootstrap` 获取（内网不可达）
- **OpenAI 兼容**：从 `${baseUrl}/models` 端点动态发现 ✓ 内网可用
- **modelAllowlist**：从 `settings.json` 的 `availableModels` 字段读取白名单

---

## 三、改造方案（v1.0 修订版）

### 3.1 配置文件设计

**主配置文件**：`~/.ywcoder/models-config.json`

```json
{
  "$schema": "ywcoder-models-config/v1",
  "models": {
    "qwen2.5-72b-instruct": {
      "contextWindow": 131072,
      "maxOutputTokens": 8192
    },
    "deepseek-r1-local": {
      "contextWindow": 65536,
      "maxOutputTokens": 16384
    },
    "internal-llama3.3-70b": {
      "contextWindow": 128000,
      "maxOutputTokens": 32768,
      "aliases": ["llama-prod", "llama-internal"]
    }
  },
  "defaults": {
    "contextWindow": 32768,
    "maxOutputTokens": 8192
  }
}
```

**字段说明**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `models[name].contextWindow` | `number > 0` | 是 | 总上下文窗口（输入 + 输出） |
| `models[name].maxOutputTokens` | `number > 0` | 是 | 最大输出 token |
| `models[name].aliases` | `string[]` | 否 | 用户可用别名 |
| `defaults.contextWindow` | `number > 0` | 否 | 未匹配时的默认上下文，覆盖全局 200K 默认 |
| `defaults.maxOutputTokens` | `number > 0` | 否 | 未匹配时的默认输出 token |

### 3.2 配置文件路径优先级（漏洞 #3 修复）

从高到低，**首个存在的有效文件生效**（不合并）：

| 优先级 | 路径                                     | 用途                                              |
| ------ | ---------------------------------------- | ------------------------------------------------- |
| 1      | `process.env.YWCODER_MODELS_CONFIG_FILE` | CI / 临时调试，，不受机器上个人配置干扰           |
| 2      | `<cwd>/.ywcoder-models.json`             | 项目级（可提交 git，团队共享）                    |
| 3      | `~/.ywcoder/models-config.json`          | 用户级（个人覆盖）                                |
| 4      | `~/.claude/models-config.json`           | 兼容回退（沿用 `getYwCoderConfigHomeDir()` 风格） |

### 3.3 解析优先级修订

**contextWindow 链路**（修订后，配合 §10 去门禁化改造）：

```
环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS （★ 需先去除 USER_TYPE='ant' 门禁，见 §10）
    ↓
模型名带 [1m] 后缀                       → 强制 1M
    ↓
★ 用户配置文件 models[name].contextWindow                ← 新增（本方案核心）
    ↓
getOpenAIContextWindow(model)（硬编码表，USE_OPENAI/GEMINI/GITHUB 时生效）
    ↓
modelCapabilities                        （外部构建空 stub，无实际作用；仅 ant 内部构建生效）
    ↓
1M Beta 权限检查 (CONTEXT_1M_BETA_HEADER) → 强制 1M
    ↓
getSonnet1mExpTreatmentEnabled           （sonnet-4-6 + GrowthBook 灰度，内网恒为 false）
    ↓
resolveAntModel(model).contextWindow     （仅 USER_TYPE='ant'，GrowthBook 动态配置）
    ↓
★ 用户配置文件 defaults.contextWindow                    ← 新增
    ↓
默认值 200_000
```

> **注意**：
>
> - 若不执行 §10 的去门禁化改造，环境变量这一行对内网用户**完全无效**，请从优先级心智模型中剔除
> - `modelCapabilities` 与 `resolveAntModel` 在内网均不可达（前者是空 stub，后者依赖 GrowthBook），实际生效顺序退化为：用户配置 → openai 表 → 1M Beta → 用户 defaults → 200K
> - 这意味着内网部署的"实际有效层"只剩 **3 层**：用户配置文件（自定义） / openai 硬编码表（公网模型） / 默认 200K

**maxOutputTokens 链路**（漏洞 #1 修复，对称改造）：

```
★ 用户配置文件 models[name].maxOutputTokens  ← 新增
    ↓
getOpenAIMaxOutputTokens(model)（硬编码表）
    ↓
按 Claude 模型版本硬编码规则
    ↓
★ 用户配置文件 defaults.maxOutputTokens     ← 新增
    ↓
默认 { default: 32_768, upperLimit: 65_536 }
```

### 3.4 缓存策略（漏洞 #2 修复）

```typescript
// src/utils/userModelsConfig.ts (新文件)
let cache: {
  config: UserModelsConfig | null
  mtimeMs: number
  path: string
} | null = null

export function loadUserModelsConfig(): UserModelsConfig | null {
  const path = resolveConfigPath()
  if (!path) return null

  try {
    const stat = fs.statSync(path)
    if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs) {
      return cache.config
    }
    const raw = fs.readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    const validated = validateConfig(parsed) // schema 校验
    cache = { config: validated, mtimeMs: stat.mtimeMs, path }
    return validated
  } catch (err) {
    logConfigError(err, path) // warn 一次，不阻断
    cache = { config: null, mtimeMs: 0, path }
    return null
  }
}
```

- **进程级 memoization** + **mtime 失效**：避免热路径同步 IO，同时支持配置热更新
- **首次失败缓存 null**：避免每次请求都重试读盘
- 进程内不再使用 `process.exit` 等中断；测试时通过 `__resetCacheForTests()` 重置

### 3.5 错误处理策略（漏洞 #4 修复）

| 场景                                          | 行为                                | 日志级别         |
| --------------------------------------------- | ----------------------------------- | ---------------- |
| 配置文件不存在                                | 静默 fallback 到下一优先级          | DEBUG            |
| JSON 解析失败                                 | fallback 到硬编码表                 | WARN（一次）     |
| Schema 校验失败（类型错误/负数）              | 跳过有问题的条目，其他正常生效      | WARN（每条一次） |
| 字段缺失 `contextWindow` 或 `maxOutputTokens` | 跳过该模型条目                      | WARN             |
| 配置生效成功                                  | 启动日志记录"已加载 N 个自定义模型" | INFO             |

**核心原则**：配置错误**不阻断启动**，但要在 `/doctor` 输出和首次失败时给出明确提示。

### 3.6 Schema 校验（漏洞 #6 修复）

```typescript
// src/utils/userModelsConfig.ts
function validateConfig(raw: unknown): UserModelsConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const out: UserModelsConfig = { models: {}, defaults: {} }

  const models = (raw as any).models
  if (models && typeof models === 'object') {
    for (const [name, cap] of Object.entries(models)) {
      if (!isValidCapability(cap)) {
        warnOnce(`models["${name}"]: 字段类型不合法，已跳过`)
        continue
      }
      out.models[name] = cap as ModelCapability
    }
  }
  // 同理处理 defaults
  return out
}

function isValidCapability(cap: unknown): boolean {
  if (!cap || typeof cap !== 'object') return false
  const c = cap as any
  return (
    Number.isInteger(c.contextWindow) &&
    c.contextWindow > 0 &&
    Number.isInteger(c.maxOutputTokens) &&
    c.maxOutputTokens > 0 &&
    c.maxOutputTokens <= c.contextWindow
  )
}
```

### 3.7 modelAllowlist 联动（漏洞 #5 修复）

修改 [src/utils/model/modelAllowlist.ts](../src/utils/model/modelAllowlist.ts) 的 `isModelAllowed()`：

```typescript
export function isModelAllowed(model: string): boolean {
  // 原有逻辑：settings.json 的 availableModels 白名单
  if (originalAllowlistMatch(model)) return true

  // 新增：models-config.json 中定义的模型自动允许
  const userConfig = loadUserModelsConfig()
  if (userConfig?.models[model]) return true
  // 别名匹配
  for (const cap of Object.values(userConfig?.models ?? {})) {
    if (cap.aliases?.includes(model)) return true
  }
  return false
}
```

**理由**：内网用户在 models-config 中显式定义模型 == 用户已表达"我要用这个模型"的意图，不应再被 allowlist 拦截。

---

### 3.8 内网环境下硬编码模型的展示过滤（方案A）

#### 3.8.1 问题描述

内网环境下，`/model` 命令的模型选择器会同时展示两类模型：

- **网关发现的模型**：来自 `/v1/models` 自报告（qwen2.5-72b、deepseek-r1 等），用户实际可用
- **硬编码预设模型**：来自代码中的公网模型列表（gpt-4o、claude-3-opus 等），内网无法访问

这导致用户产生困惑："这些公网模型我能选吗？选了会怎样？"

#### 3.8.2 解决方案：运行时过滤

不改硬编码数据源，只改**读取/展示**逻辑。

**`/model` 选择器过滤**：

当 `isLocalProviderUrl(OPENAI_BASE_URL) === true` 时：

- 隐藏硬编码预设模型选项
- 只展示 `openaiAdditionalModelOptionsCache`（`/model` 刷新链路）或 `additionalModelOptionsCache`（bootstrap 链路）中发现的模型

  > **关于两个缓存的说明**：
  > - `openaiAdditionalModelOptionsCache` 由 `/model` 命令刷新写入，**不含 `contextWindow`**，供选择器展示用
  > - `additionalModelOptionsCache` 由 bootstrap 启动时写入，**含 `contextWindow`**，供 `getContextWindowForModel()` 读取用
  > - 两者是完全独立的 `GlobalConfig` 字段，v1 Option A 明确不改 `/model` 刷新链路
  > - 选择器展示时用 `openaiAdditionalModelOptionsCache ?? additionalModelOptionsCache` 兜底，仅影响展示，不影响 `getContextWindowForModel()` 的读取路径

- 当网关发现列表为空时，显示提示"未从网关发现可用模型"，不展示任何硬编码模型

**`getContextWindowForModel()` 优先级微调**：

在 OpenAI 兼容 provider 分支中，当 `isLocalProviderUrl()` 为 true 且 `additionalModelOptionsCache` 非空时：

- 优先使用缓存中的 `contextWindow`（网关自报告值）
- 若缓存中无该模型，**不再 fallback 到 `getOpenAIContextWindow()` 硬编码表**
- 直接 fallback 到默认值 `MODEL_CONTEXT_WINDOW_DEFAULT = 200_000`

**原因**：内网模型不在硬编码表中，fallback 到硬编码表只会返回不准确的值（或恰好命中同名公网模型的错误值），不如直接走默认值，避免误导。

#### 3.8.3 兜底策略

| 场景 | 行为 |
|------|------|
| 网关正常返回模型列表 | `/model` 只展示网关模型；contextWindow 优先读缓存 |
| 网关不可达/返回空列表 | `/model` 展示空列表 + 提示"未从网关发现可用模型" |
| 缓存为空但用户硬要发请求 | `getContextWindowForModel()` 返回 200K 默认值 |
| 公网用户（api.openai.com） | 完全不受影响，正常展示硬编码模型 |

---

## 四、需要修改的文件清单

| 文件                                                                            | 改动类型 | 说明                                                                     |
| ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| **[src/utils/userModelsConfig.ts](../src/utils/userModelsConfig.ts)**           | 🆕 新建  | 配置加载、缓存、Schema 校验、热更新                                      |
| **[src/utils/userModelsConfig.test.ts](../src/utils/userModelsConfig.test.ts)** | 🆕 新建  | 单元测试                                                                 |
| [src/utils/context.ts](../src/utils/context.ts)                                 | ✏️ 修改  | `getContextWindowForModel` 和 `getModelMaxOutputTokens` 插入用户配置查询 |
| [src/utils/model/modelAllowlist.ts](../src/utils/model/modelAllowlist.ts)       | ✏️ 修改  | `isModelAllowed` 联动用户配置                                            |
| [src/utils/envUtils.ts](../src/utils/envUtils.ts)                               | ✏️ 修改  | 新增 `getUserModelsConfigPath()` 解析路径优先级                          |
| [src/commands/doctor/](../src/commands/doctor/)                                 | ✏️ 修改  | `/doctor` 输出加载结果与错误                                             |
| [docs/advanced-setup.md](../docs/advanced-setup.md)                             | ✏️ 修改  | 新增"内网模型配置"章节                                                   |
| [src/commands/model/model.tsx](../src/commands/model/model.tsx)                 | ✏️ 修改  | 方案A：内网环境下过滤硬编码预设模型，只展示网关发现模型                  |
| [src/utils/context.ts](../src/utils/context.ts)                                 | ✏️ 修改  | 方案A：内网环境下缓存非空时跳过 `getOpenAIContextWindow()` 硬编码表 fallback |

---

## 五、测试方案（漏洞 #7 修复）

### 5.1 单元测试覆盖点（`userModelsConfig.test.ts`）

| 测试用例                          | 期望行为                   |
| --------------------------------- | -------------------------- |
| 配置文件不存在                    | 返回 `null`，不抛错        |
| JSON 损坏                         | 返回 `null`，warn 日志     |
| `contextWindow` 为负数            | 跳过该条目，其他生效       |
| `maxOutputTokens > contextWindow` | 视为非法，跳过             |
| mtime 未变化时第二次调用          | 不再读盘（验证缓存命中）   |
| mtime 变化后调用                  | 重新读盘                   |
| 优先级：env > project > user      | 三者同时存在时取 env       |
| 别名匹配                          | `aliases` 中的名字也能查到 |

### 5.2 集成测试覆盖点

| 场景                              | 验证点                                   |
| --------------------------------- | ---------------------------------------- |
| 内网模型 + 自定义 contextWindow   | `/cost` 和自动压缩阈值使用配置值         |
| 内网模型 + 自定义 maxOutputTokens | API 请求 body 中 `max_tokens` 字段正确   |
| `/model` 选择器                   | 列出 models-config 中定义的所有模型      |
| `/doctor` 输出                    | 显示已加载的自定义模型数量与配置文件路径 |

### 5.3 回归测试

- 不创建任何 `models-config.json` 时，所有现有行为与改造前完全一致
- 现有的 `openaiContextWindows.test.ts`（如有）应全部通过

### 5.4 方案A测试覆盖点

| 场景 | 验证点 |
|------|--------|
| 内网 `/model` 选择器 | 只展示网关发现模型，不展示硬编码预设模型 |
| 内网 `/model` 空列表 | 网关返回空时显示"未从网关发现可用模型"提示 |
| 公网 `/model` 不受影响 | `isLocalProviderUrl()=false` 时正常展示硬编码模型 |
| 内网 contextWindow 链路 | 缓存非空时跳过硬编码表，未知模型直接 fallback 到 200K |

---

## 六、部署与运维建议

### 6.1 内网部署 SOP

1. **配置文件下发**：通过运维系统将 `models-config.json` 分发到所有用户机器的 `~/.ywcoder/`
2. **团队共享**：把 `.ywcoder-models.json` 提交到内网项目仓库根目录
3. **校验**：用户首次启动时跑 `ywcoder doctor` 确认加载成功
4. **变更**：修改配置文件无需重启 CLI（mtime 检测会触发重载）

### 6.2 常见错误自查清单

| 现象                          | 排查项                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| 模型在 `/model` 中不显示      | 检查配置文件路径优先级；检查是否被 allowlist 过滤                                   |
| 自动压缩阈值不对              | 确认 `contextWindow` 数值；检查 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 是否被环境变量覆盖 |
| API 报 `max_tokens too large` | 调小 `maxOutputTokens`；确认值 ≤ `contextWindow`                                    |
| 配置不生效                    | 看 `/doctor` 输出的"已加载配置文件路径"；JSON 语法校验                              |

---

## 七、未来扩展方向（不在本次改造范围内）

1. **`/models` 端点元数据增强**：如内网 API 能返回 `context_length` 字段，可在 [bootstrap.ts](../src/services/api/bootstrap.ts) 中直接解析，免去配置文件维护
2. **可视化配置 UI**：在 `/provider` 命令向导中新增"自定义模型能力"输入步骤
3. **配置版本管理**：通过 `$schema` 字段支持未来格式升级与迁移
4. **模型成本配置**：扩展配置文件支持 `inputPrice` / `outputPrice`，集成到 [modelCost.ts](../src/utils/modelCost.ts)

---

## 八、风险与回滚

### 8.1 风险评估

| 风险                                              | 缓解措施                              |
| ------------------------------------------------- | ------------------------------------- |
| 配置文件被恶意构造（极大 contextWindow 导致 OOM） | Schema 校验设上限（如 ≤ 10M）         |
| 多用户共享路径冲突                                | 按用户级配置目录隔离（`~/.ywcoder/`） |
| 缓存 stale                                        | mtime 检测 + 启动时强刷               |

### 8.2 回滚策略

- 删除 `~/.ywcoder/models-config.json` 即可回退到硬编码行为
- 设置 `YWCODER_DISABLE_USER_MODELS_CONFIG=1` 环境变量可临时关闭加载（实现时一并提供）

---

## 十、`USER_TYPE === 'ant'` 门禁分析与处置

### 10.1 设计意图（上游 Anthropic Claude Code 视角）

`USER_TYPE === 'ant'` 是上游 **多租户 / 双发行版隔离机制**。从 [envUtils.ts:197-198](../src/utils/envUtils.ts#L197-L198) 的注释可知：

> _"USER_TYPE is build-time --define'd; in external builds this block is DCE'd so the require() and namespace allowlist never appear in the bundle."_

**上游设计目标**：

1. **信息安全隔离**：内部模型 codename、内部 API endpoint、GrowthBook key、protected namespace allowlist 等敏感符号不能泄漏到外部 bundle
2. **构建产物分离**：构建时通过 `--define 'process.env.USER_TYPE=...'` 让 esbuild/bun 做 dead-code elimination (DCE)，外部 bundle 物理上不含 ant-only 代码
3. **能力分级**：内部用户拥有更高 effort level (`max`)、ant 专属模型 alias、homespace 集成等增强功能

### 10.2 本 fork（ywcoder-cli）的实际形态

经验证 [scripts/build.ts:55-67](../scripts/build.ts#L55-L67) 的 `define` 块**未注入 USER_TYPE**：

```typescript
define: {
  'MACRO.VERSION': JSON.stringify('99.0.0'),
  'MACRO.DISPLAY_VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  // ... 无 process.env.USER_TYPE
}
```

因此在本 fork 中：

| 维度                          | 上游官方               | 本 fork                  |
| ----------------------------- | ---------------------- | ------------------------ |
| `USER_TYPE` 是否构建时替换    | 是（DCE 生效）         | **否**（纯运行时）       |
| 外部 bundle 是否含 ant 代码   | 否（被 DCE 移除）      | **是**（仍在 bundle 中） |
| 设置 `USER_TYPE=ant` 是否生效 | 否（已被替换为字面量） | **是**（运行时读取）     |

**含义**：本 fork 中 ant 代码路径仍存在于 bundle，理论上可通过运行时设置 `USER_TYPE=ant` 解锁，**但会触发大量副作用通道**（见 §10.4），因此不推荐整体设置，只能针对单点做精准去门禁化。

### 10.3 `USER_TYPE === 'ant'` 全局影响清单（按功能域归类）

全仓库共约 **120 处** ant 门禁，按功能域分类如下：

| 功能域                       | 代表文件                                                                                                                                                                                                                                                                                                  | 对内网用户的实际影响                                                     | 改造决策                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| **模型配置（核心）**         | [context.ts](../src/utils/context.ts), [antModels.ts](../src/utils/model/antModels.ts), [model.ts](../src/utils/model/model.ts), [modelOptions.ts](../src/utils/model/modelOptions.ts), [providers.ts](../src/utils/model/providers.ts)                                                                   | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 失效；`resolveAntModel` 返回空          | ✅ **精准去门禁**（仅环境变量这一条）       |
| **GrowthBook 远程配置**      | [growthbook.ts](../src/services/analytics/growthbook.ts), [magicDocs.ts](../src/services/MagicDocs/magicDocs.ts), [extractMemories.ts](../src/services/extractMemories/extractMemories.ts)                                                                                                                | 无法拉取内部 feature flag、Magic docs、记忆提取规则                      | ⚪ 不改造（GrowthBook endpoint 内网不可达） |
| **内部 telemetry**           | [datadog.ts](../src/services/analytics/datadog.ts), [bigqueryExporter.ts](../src/utils/telemetry/bigqueryExporter.ts), [firstPartyEventLogger.ts](../src/services/analytics/firstPartyEventLogger.ts), [metadata.ts](../src/services/analytics/metadata.ts), [vcr.ts](../src/services/vcr.ts)             | 不上报到内部 BigQuery / Datadog                                          | ⚪ 期望行为（数据出域风险）                 |
| **更新通道**                 | [cli/update.ts](../src/cli/update.ts), [autoUpdater.ts](../src/utils/autoUpdater.ts)                                                                                                                                                                                                                      | 使用 `@dcywzc/ywcoder` 包，不走 `@anthropic-ai/claude-cli`               | ⚪ 期望行为                                 |
| **Settings schema 扩展**     | [settings/types.ts](../src/utils/settings/types.ts)                                                                                                                                                                                                                                                       | 缺 `effortLevel='max'`、`classifierPermissionsEnabled`、`soft_deny` 别名 | ⚠️ 视需求评估（max effort 可解锁）          |
| **Homespace 集成**           | [envUtils.ts](../src/utils/envUtils.ts) (`isRunningOnHomespace`)                                                                                                                                                                                                                                          | 始终 false                                                               | ⚪ 期望行为                                 |
| **Protected namespace 检测** | [envUtils.ts](../src/utils/envUtils.ts) (`isInProtectedNamespace`)                                                                                                                                                                                                                                        | 始终 false                                                               | ⚪ 期望行为                                 |
| **Bash 权限分类器**          | [bashPermissions.ts](../src/tools/BashTool/bashPermissions.ts), [yoloClassifier.ts](../src/utils/permissions/yoloClassifier.ts), [dangerousPatterns.ts](../src/utils/permissions/dangerousPatterns.ts), [classifierDecision.ts](../src/utils/permissions/classifierDecision.ts)                           | 走外部默认规则                                                           | ⚪ 期望行为                                 |
| **工具 prompt 扩展**         | [SkillTool/prompt.ts](../src/tools/SkillTool/prompt.ts), [ToolSearchTool/prompt.ts](../src/tools/ToolSearchTool/prompt.ts), [AgentTool/prompt.ts](../src/tools/AgentTool/prompt.ts), [BashTool/prompt.ts](../src/tools/BashTool/prompt.ts), [FileEditTool/prompt.ts](../src/tools/FileEditTool/prompt.ts) | 不带 ant 内部提示词                                                      | ⚪ 期望行为                                 |
| **慢操作追踪**               | [bootstrap/state.ts](../src/bootstrap/state.ts) (`addSlowOperation`), [slowOperations.ts](../src/utils/slowOperations.ts), [startupProfiler.ts](../src/utils/startupProfiler.ts), [headlessProfiler.ts](../src/utils/headlessProfiler.ts)                                                                 | 不追踪                                                                   | ⚪ 期望行为                                 |
| **MCP 内部集成**             | [useManageMCPConnections.ts](../src/services/mcp/useManageMCPConnections.ts), [vscodeSdkMcp.ts](../src/services/mcp/vscodeSdkMcp.ts)                                                                                                                                                                      | 缺失内部 MCP 能力                                                        | ⚪ 期望行为                                 |
| **Internal beta flags**      | [constants/betas.ts](../src/constants/betas.ts)                                                                                                                                                                                                                                                           | 部分 beta header 不发送                                                  | ⚪ 期望行为                                 |
| **Internal env overrides**   | [growthbook.ts](../src/services/analytics/growthbook.ts) (`CLAUDE_INTERNAL_FC_OVERRIDES`)                                                                                                                                                                                                                 | 不读取                                                                   | ⚪ 期望行为                                 |
| **错误日志/HTTP/重试**       | [errors.ts](../src/services/api/errors.ts), [http.ts](../src/utils/http.ts), [withRetry.ts](../src/services/api/withRetry.ts), [errorLogSink.ts](../src/utils/errorLogSink.ts)                                                                                                                            | 不发到内部 sentry/sink                                                   | ⚪ 期望行为                                 |
| **Skills/Tasks/Agent 定义**  | [skills/bundled/debug.ts](../src/skills/bundled/debug.ts), [tasks.ts](../src/utils/tasks.ts), [tools.ts](../src/tools.ts), [exploreAgent.ts](../src/tools/AgentTool/built-in/exploreAgent.ts)                                                                                                             | 缺 ant 内部 skill / 默认 agent 配置                                      | ⚪ 期望行为                                 |
| **其他 UX 细节**             | [tipRegistry.ts](../src/services/tips/tipRegistry.ts), [keybindings/loadUserBindings.ts](../src/keybindings/loadUserBindings.ts), [logoV2Utils.ts](../src/utils/logoV2Utils.ts), [warningHandler.ts](../src/utils/warningHandler.ts)                                                                      | 不显示 ant 内部 tips、品牌 logo                                          | ⚪ 期望行为                                 |

**图例**：✅ 改造 / ⚠️ 评估 / ⚪ 保持现状

### 10.4 处置策略矩阵

| 策略                                                     | 改动面           | 收益                                                                                    | 风险                                                                                                        |
| -------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **A. 精准去门禁**（仅 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`） | 1 行             | 还原环境变量直觉语义；与 `CLAUDE_CODE_DISABLE_1M_CONTEXT` 等其他无门禁 env var 风格一致 | 几乎零风险（语义本就是用户主动覆盖）                                                                        |
| **B. 整体设置 `USER_TYPE=ant`**                          | 0 行（仅运行时） | 一次解锁所有 ant 路径                                                                   | **高风险**：会触发 GrowthBook 拉取（404/超时）、homespace 检测、内部上报 → 网络错误、性能下降、潜在数据出域 |
| **C. 完全保持现状 + 只用新配置文件**                     | 0 行（仅文档）   | 改动最小                                                                                | env var `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 在内网为"哑变量"，违反最小惊讶原则                                 |

**推荐组合**：**A**（精准去门禁）+ §3 的新配置文件方案。

理由对照表（同文件内其他环境变量门禁状态）：

| 环境变量                                    | 当前是否 ant 门禁 | 是否合理                                 |
| ------------------------------------------- | ----------------- | ---------------------------------------- |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS`            | ✗ 仅 ant          | **不合理**（用户主动覆盖语义）           |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT`            | ✓ 全用户可用      | 合理（HIPAA 合规需求）                   |
| `YWCODER_BASH_MAINTAIN_PROJECT_WORKING_DIR` | ✓ 全用户可用      | 合理                                     |
| `COO_RUNNING_ON_HOMESPACE`                  | ✗ 仅 ant          | 合理（内部基础设施信号）                 |
| `CLAUDE_INTERNAL_FC_OVERRIDES`              | ✗ 仅 ant          | 合理（仅 ant GrowthBook 才有的覆盖机制） |

可见 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 的门禁是**风格异类**，应予去除。

### 10.5 实施代码示意（推荐方案 A）

[src/utils/context.ts:60-68](../src/utils/context.ts#L60-L68)：

```typescript
// ❌ 改造前（内网用户走不到这里）
if (
  process.env.USER_TYPE === 'ant' &&
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
) {
  const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
  if (!isNaN(override) && override > 0) {
    return override
  }
}

// ✅ 改造后（所有用户均生效）
if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
  const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
  if (!isNaN(override) && override > 0) {
    return override
  }
}
```

**保留的 ant 门禁**（[context.ts:104-109](../src/utils/context.ts#L104-L109) 与 [context.ts:169-176](../src/utils/context.ts#L169-L176)）：

- `resolveAntModel(model)?.contextWindow` 来源是 ant 内部 GrowthBook，内网不可达
- 去门禁后会触发空指针或不必要的远程请求
- **保持现状**

### 10.6 测试用例补充

在 §5.1 单元测试列表中追加：

| 测试用例                                                   | 期望行为                       |
| ---------------------------------------------------------- | ------------------------------ |
| 非 ant 用户设置 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=50000`     | 返回 50000（验证去门禁后生效） |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS=invalid`                   | 忽略，走下一优先级             |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS=-100`                      | 忽略（≤ 0 不视为有效）         |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 与 models-config 同时存在 | env var 优先（最高层覆盖）     |

---

## 九、变更记录

| 日期       | 版本 | 变更摘要                                                                                                                                                                                                                                                                                                       |
| ---------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-27 | v1.0 | 初稿；自检发现 7 处漏洞并修订                                                                                                                                                                                                                                                                                  |
| 2026-04-27 | v1.1 | 新增漏洞 #8（`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 被 `USER_TYPE='ant'` 门禁导致内网失效）；新增 §10 章节系统梳理 ant 门禁的设计意图、120 处全局影响清单与处置策略；修订 §2.1/§3.3 优先级图；修复因移至 `note/` 失效的相对链接                                                                                      |
| 2026-04-27 | v1.2 | 采纳第三方 AI review 意见：①§3.3 优先级图原本将 modelCapabilities/1M Beta/resolveAntModel 折叠成一行，现展开为 5 个独立环节并标注每层的实际生效条件；②新增 §2.3 章节系统说明 `modelCapabilities` 在外部构建中是空 stub；③§2.1 与 §3.3 补全 `getSonnet1mExpTreatmentEnabled` 这一遗漏环节；④原 §2.3 顺延为 §2.4 |
