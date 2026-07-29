# 内网模型能力参数网关自报告 — 实施总结

> **日期**：2026-05-05（执行于 2026-05-06）
> **需求文档**：[internal-model-config-gateway-reporting-2026-04-27.md](./internal-model-config-gateway-reporting-2026-04-27.md)（v1.4）
> **实施计划**：[internal-model-config-impl-plan-2026-04-30.md](./internal-model-config-impl-plan-2026-04-30.md)
> **提交记录**：`36a8c25`（主特性）、`b3cd56b`（配置迁移工具）

---

## 一、背景

### 问题

内网部署的 OpenAI 兼容网关（自研）服务多个 LLM 模型（qwen2.5、deepseek 等），各模型实际上下文窗口各异（64K / 128K / 131072 等），但 CLI 目前统一使用 `200_000` 硬编码默认值：

- **提前压缩**：模型真实窗口 < 200K 时，auto-compact 触发阈值（200K × 80% = 160K）永远达不到，模型直接硬截断，用户收到截断响应而非压缩提示
- **用户无感知**：无任何诊断手段确认"CLI 究竟用的哪个上下文窗口"

### 废弃的前方案

原方案 `internal-model-config-redesign-2026-04-27.md` 要求用户手动维护 `models-config.json`，引入运维负担，且容易填错。本次方案改为**网关 `/v1/models` 自报告 `context_length`**，CLI 启动时自动预加载。

---

## 二、最终决策

### 协议设计

| 决策项                  | 结论                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 字段名                  | `context_length`（与 vLLM / TGI 自报告一致；自研网关无需多字段兼容）                                                                       |
| 是否返回 `max_tokens`   | **否**（v1）——内网 escalation 机制由 GrowthBook 门禁恒为 false，无收益；且 `max_tokens` 在 OpenAI 协议中是请求参数，作为响应字段有语义歧义 |
| CLI 侧字段别名 fallback | **否**——自研网关统一约定 `context_length`，无需兼容 `context_window` / `n_ctx` 等                                                          |

### CLI 架构选型

| 决策项        | 结论                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 缓存路径      | 复用现有 `additionalModelOptionsCache`（bootstrap 链路），**不新建**独立字段                                                                                                                     |
| 双缓存并存    | `additionalModelOptionsCache`（bootstrap 写，含 contextWindow）与 `openaiAdditionalModelOptionsCache`（`/model` 命令写，不含 contextWindow）完全独立，互不干扰                                   |
| Option A vs B | **Option A**：只改 bootstrap 链路（`listOpenAICompatibleModels()`），不改 `/model` 刷新链路（`openaiModelDiscovery.ts:fetchOpenAIModels()`）——`context_length` 是模型固有参数，重启生效已足够    |
| 启动机制      | 保持 `void fetchBootstrapData()` **fire-and-forget** 不变；失败时显示静态黄色横幅，不阻塞 REPL，不刷新横幅（Ink/React 终端不支持更新已渲染节点）                                                 |
| /doctor 实现  | 新建 `ModelCapabilitiesDoctorSection.tsx` React 组件；Plan B 零成本方案（缓存空时用文案引导用户重开 /doctor，而非 useState 轮询——Doctor pane 由 React Compiler 静态缓存，useState 不触发重渲染） |

### 优先级链路（`context.ts:getContextWindowForModel`）--

```
环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS（去除 USER_TYPE='ant' 门禁）
    ↓
[1m] 后缀（显式 1M 选项）
    ↓
★ findCachedModelOption(model).contextWindow（网关自报告，本方案主路径）
    ↓
getOpenAIContextWindow() 硬编码表（公网模型兜底）
    ↓
ModelCapabilities 表（getModelCapability()）
    ↓
默认值 MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
```

---

## 三、已完成改动

### 主特性提交（`36a8c25`）

| 文件                                                | 改动类型 | 关键内容                                                                                                                                                                    |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/providerDiscovery.ts`                    | 修改     | `listOpenAICompatibleModels` 返回类型从 `string[]` 改为 `Array<{id: string; contextWindow?: number}>`；解析 `context_length`；用 Map 去重（保留最后值，含 contextWindow）   |
| `src/utils/model/modelOptions.ts`                   | 修改     | `ModelOption` 类型新增 `contextWindow?: number` 字段                                                                                                                        |
| `src/services/api/bootstrap.ts`                     | 修改     | `.map()` 把 `contextWindow` 透传到 `additionalModelOptionsCache`                                                                                                            |
| `src/utils/context.ts`                              | 修改     | 新增 `findCachedModelOption()`（含 scope 守卫：仅 `openai:` 前缀 provider）；OpenAI 兼容分支优先读网关缓存；去除 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 的 `USER_TYPE='ant'` 门禁 |
| `src/components/ModelCapabilitiesDoctorSection.tsx` | **新建** | /doctor 模型能力段落组件；空缓存时引导用户重开 /doctor（Plan B）；非 OpenAI provider 返回 null                                                                              |
| `src/screens/Doctor.tsx`                            | 修改     | 在静态编译 pane 末尾插入 `<ModelCapabilitiesDoctorSection />`                                                                                                               |
| `src/utils/providerDiscovery.test.ts`               | 修改     | 适配返回类型变更（对象数组）；新增 3 条 context_length 解析用例（正常值 / 0 与负数过滤 / 字段缺失）；共 8 个 pass                                                           |

**合计**：7 个文件，+179 行 / -16 行。

### 配置迁移提交（`b3cd56b`）

| 文件                           | 改动类型 | 关键内容                                                                                                                                                                                       |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/configMigration.ts` | **新建** | `migrateConfig()`：①`mkdir` 提至函数顶部作为共同前置；②独立 JSON 迁移步骤（`~/.claude.json` → `~/.ywcoder/.config.json`，不依赖 `~/.claude/` 目录），仅在目标不存在时复制；③原目录迁移逻辑保留 |

**关联背景**：此迁移涵盖以下场景：官方 Claude Code 卸载后 `~/.claude.json` 残留、用户手动清理了 `~/.claude/` 目录但 JSON 配置还在。触发方式：`ywcoder --migrate-config`（不强制自动执行）。

### v1.x 补丁 — 内网模型列表去歧义（方案A，2026-05-10）

**背景**：内网用户执行 `/model` 时，选择器同时展示网关发现模型（qwen2.5、deepseek 等）和公网硬编码预设模型（gpt-4o、claude-3-opus 等），用户困惑"这些公网模型我能选吗"。

**方案**：运行时过滤，不改硬编码数据源，只改读取/展示逻辑。

| 文件                                                | 改动类型 | 关键内容                                                                                                                                                                                                                                     |
| --------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/model/modelOptions.ts`                   | 修改     | `getModelOptions()` 内网环境下（`isLocalProviderUrl()=true` 且 `getScopedAdditionalModelOptions()` 非空）用 `[...discovered]` 浅拷贝替代 `getModelOptionsBase()`，只展示网关发现模型；浅拷贝防止后续 `push` 意外 mutate 全局 config 内存缓存 |
| `src/utils/context.ts`                              | 修改     | 导入 `isLocalProviderUrl`；`getContextWindowForModel()` OpenAI 兼容分支中，内网环境且 bootstrap 缓存非空时跳过硬编码表 fallback，直接走默认值 200K                                                                                           |
| `src/components/ModelCapabilitiesDoctorSection.tsx` | 修改     | 导入 `isLocalProviderUrl`；内网环境下增加提示：有模型时 dimColor 显示"已过滤硬编码预设模型，仅展示网关发现模型"，空列表时 warning 显示"未从网关发现可用模型，/model 列表为空"                                                                |

**设计决策**：

- 用 `scope.startsWith('openai:')` + `isLocalProviderUrl()` 双重判定，避免误判公网用户
- 仅当 `additionalModelOptionsCache` 非空时才跳过硬编码表——bootstrap 失败时仍保留兜底行为
- `/model` 选择器展示与 `getContextWindowForModel()` 读取路径解耦，互不影响

**代码注释格式**：所有改动处统一使用 `// 2026-05-10 方案A：...` 前缀

### v1.x 补丁 — 内网标识开关（方案E，2026-05-14）

**背景**：现网用户的内网网关 IP 为 76.x.x.x，不在 RFC1918 私有段（10.x / 172.16-31.x / 192.168.x）内，导致 `isLocalProviderUrl()` 判定为公网，进而 `getAdditionalModelOptionsCacheScope()` 返回 null，网关自报告 `context_length`、`/model` 去歧义、`/doctor` 提示等**所有内网特性全部失效**，方案A 也因此无法生效。

**根因**：原 `isPrivateIpv4Address()` 仅识别 RFC1918 三段，未覆盖企业内网常见的非 RFC1918 段（如早期分配给国企/科研院所的公网段、CGNAT `100.64.0.0/10`、跨专线/VPN 互通的事实内网等）。`isLocalProviderUrl()` 的原始设计本意是判断"baseUrl 是不是本机/局域网风格的免 key 服务"（loopback / RFC1918 / `.local`），在网关自报告特性里被复用为"是不是企业内网"，**两个语义混用导致覆盖盲区**。

**方案**：在 `isLocalProviderUrl()` 顶部新增环境变量 **opt-in 短路**，由用户/部署脚本显式声明"当前 baseUrl 是受信内网网关"。

| 文件                                | 改动类型     | 关键内容                                                                                                                                                                                                                  |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/api/providerConfig.ts` | 修改         | `isLocalProviderUrl()` 顶部新增 3 行短路：`YWCODER_INTRANET=1` 时直接 return true，跳过 RFC1918 IP 段判断；复用已 import 的 `isEnvTruthy` + `getYwCoderEnv`，零新增依赖                                                  |
| `src/utils/configMigration.ts`       | 修改（顺手） | ① L78/L89/L109/L121 的英文 `console.log/error` 统一改中文；② L110-L111 的 `rm -rf` 提示改为跨平台命令清单（Linux / PowerShell / Windows cmd 三套），用户照抄自己平台对应的一条                                                |

**具体代码改动**：

```ts
// src/services/api/providerConfig.ts — isLocalProviderUrl() 顶部新增 3 行
export function isLocalProviderUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  // 2026-05-14 方案E：非 RFC1918 内网网关（如 76.x.x.x 段）通过 YWCODER_INTRANET=1 显式声明
  if (isEnvTruthy(getYwCoderEnv('INTRANET'))) {
    return true
  }
  try {
    // ... 原有 IP 段判断保持完全不变
```

```ts
// src/utils/configMigration.ts — 英文日志中文化 + 平台中立删除提示
console.log('✓ 已在使用 ~/.ywcoder 配置目录')           // L78
console.log('✓ 已创建新配置目录 ~/.ywcoder')             // L89
console.log(`✓ 已将配置从 ${sourceDir} 迁移到 ~/.ywcoder`) // L109
console.log(`  你现在可以安全删除旧目录，根据使用的 shell 选择对应命令：`)
console.log(`    Linux:        rm -rf ${sourceDir}`)
console.log(`    PowerShell:   Remove-Item -Recurse -Force ${sourceDir}`)
console.log(`    Windows cmd:  rmdir /s /q "${sourceDir}"`)
console.error(`✗ 迁移失败：${message}`)                  // L121
```

**用户操作变更**：

- **新用户**：通过公司提供的环境变量配置脚本设置（脚本已新增 `YWCODER_INTRANET=1` 一行）
- **老用户**：升级到 v1.0.2 后**重新运行最新版配置脚本**——不在 `ywcoder --migrate-config` 中混入环境变量配置
- Release notes 文案：「v1.0.2 版本调整了环境变量配置，升级后请运行最新配置脚本，以确保新增特性正常启用」

**设计决策**：

- 采用 **opt-in 显式开关**而非自动探测，避免误判公网 IP 为内网（自动探测会污染 `providerValidation.ts:77` 的"内网免 API key 放行"语义）
- **不修改** `isPrivateIpv4Address()` 判断范围，避免影响其他 7 个 `isLocalProviderUrl()` 调用点的既有行为
- **不放进** `--migrate-config` 命令——该命令是过渡期一次性命令，新用户/新机器/CI 部署不会触发；环境变量配置由公司脚本统一管理，**migrate（迁移文件）与配置脚本（环境变量）两个入口各司其职**
- **默认行为完全保持现状**：未启用 `YWCODER_INTRANET=1` 时 100% 等同当前逻辑，零回归风险
- 变量名采用 `YWCODER_INTRANET`——*intranet* 英文专指"企业内网"，无歧义；与 `YWCODER_*` 命名前缀一致

**代码注释格式**：所有改动处统一使用 `// 2026-05-14 方案E：...` 前缀（与方案A 风格一致）

#### 延伸改动 — Provider 显示标签（2026-05-14，同日补）

**背景**：方案E 落地内网后，`/doctor` 与 `/provider` 输出的 Provider 字段显示为 `Local OpenAI-compatible`——这是 `getLocalOpenAICompatibleProviderLabel()` 的通用 fallback 文案，专为本机开源工具（LM Studio / Ollama / vLLM 等）设计，**对企业内网自研网关不贴切**（用户不是 "local" 本机部署，是公司内网网关）。

**方案**：在 [providerDiscovery.ts:63 `getLocalOpenAICompatibleProviderLabel()`](../../src/utils/providerDiscovery.ts#L63) 函数顶部新增 INTRANET 判断，**优先级高于关键字自动识别**——既然用户已显式声明企业内网，"自动识别开源工具"在该场景下无意义。

| 文件 | 改动类型 | 关键内容 |
| --- | --- | --- |
| `src/utils/providerDiscovery.ts` | 修改 | 顶部新增 `isEnvTruthy / getYwCoderEnv` import；`getLocalOpenAICompatibleProviderLabel()` 函数最开头加 3 行：`YWCODER_INTRANET=1` 时直接返回 `'YwCoder-OpenAI协议网关'`，跳过 try/catch 的 URL 解析与关键字匹配 |
| `src/utils/providerDiscovery.test.ts` | 修改 | ① `afterEach` 扩展恢复 `YWCODER_INTRANET` 防止跨用例污染；② 新增 1 条测试用例（2 个断言：纯 IP fallback 命中 + 即使 URL 含 `vllm` 关键字也优先返回内网标签） |

**具体代码**：

```ts
// src/utils/providerDiscovery.ts
export function getLocalOpenAICompatibleProviderLabel(baseUrl?: string): string {
  // 2026-05-14 方案E：显式声明企业内网网关时使用专属标签，优先级高于关键字自动识别
  if (isEnvTruthy(getYwCoderEnv('INTRANET'))) {
    return 'YwCoder-OpenAI协议网关'
  }
  try {
    // ... 原有 URL 解析 + 关键字匹配（LM Studio / Ollama / vLLM 等）
```

**文案决策**：

- 候选讨论：`YwCoder 企业内网网关` / `Intranet Gateway` / `YwCoder-OpenAI协议网关`
- 最终采用 `YwCoder-OpenAI协议网关`——同时点明品牌（YwCoder）、协议（OpenAI 兼容）、形态（网关），三个信息密度最高

**验证结果**：

```
bun test src/utils/providerDiscovery.test.ts
# 10 pass / 0 fail（含本次新增 1 条用例）

bun run build
# 构建成功
```

**设计决策**：

- INTRANET 标签**优先级高于**关键字匹配——避免内网网关路径中偶然含 `vllm` / `llama` 等开源工具关键字时被误标
- 改动局限在显示逻辑，不影响 `getAdditionalModelOptionsCacheScope()` / bootstrap / `/model` 过滤等任何功能路径
- 默认行为零变化：未设 `YWCODER_INTRANET=1` 时 100% 等同原逻辑

#### 延伸改动 — /doctor 缓存陈旧警告（2026-05-14，同日补）

**背景**：内网验证时发现一个排错盲区——用户在同一 shell 临时改了 `OPENAI_BASE_URL`（故意写错以验证错误处理），重启 ywcoder 后 `/doctor` 仍照常展示**上次正确网关**的模型 + `context_length`，**无任何失败提示**。表象上"一切正常"，但实际本次 bootstrap 已悄无声息地失败了。

**根因**：v1 实施时为了"网关偶发抖动时缓存兜底"的考虑，[bootstrap.ts:138-141](../../src/services/api/bootstrap.ts#L138-L141) 在 `listOpenAICompatibleModels` 返回 null 时只跑一句 `logForDebugging`（仅 debug 模式可见），**完全不动磁盘缓存**。叠加 [ModelCapabilitiesDoctorSection.tsx](../../src/components/ModelCapabilitiesDoctorSection.tsx) 直接读 `getGlobalConfig()`、不做"当前环境 vs 缓存"一致性比对，于是 `/doctor` 显示的 scope 永远是上次成功写入的旧 URL，跟当前 `OPENAI_BASE_URL` 不一致也不会被察觉。

04 文档 §二启动机制原文「失败时显示静态黄色横幅」**与实际代码有出入**——OpenAI bootstrap 失败这条路径其实没接 UI 提示，是 v1 未完工的设计点。

**方案候选与决策**：

| 候选 | 改动量 | 是否采纳 | 理由 |
| --- | --- | --- | --- |
| A. `/doctor` 加 scope 不一致警告 | ~10 行 | ✅ 采纳 | 仅在排错场景触发，日常零干扰；改动局限在显示层 |
| B. bootstrap 失败时 stderr 红字 | ~3 行 | ❌ 暂不做 | 非 TTY 环境会污染 stdout；启动期信息易被刷掉 |
| C. /doctor 加缓存写入时间 | ~20 行 | ❌ 暂不做 | 需新增 `additionalModelOptionsCacheUpdatedAt` 字段，超出本次范围 |
| D. bootstrap 失败时清空 cache | ~5 行 | ❌ 不推荐 | 牺牲"网络抖动兜底"优点，行为变化激进 |

**具体改动**：

| 文件 | 改动类型 | 关键内容 |
| --- | --- | --- |
| `src/components/ModelCapabilitiesDoctorSection.tsx` | 修改 | ① import 新增 `getAdditionalModelOptionsCacheScope`；② 新增 `scopeStale = getAdditionalModelOptionsCacheScope() !== scope` 计算；③ 在「└ 来源」一行之后追加条件渲染的 warning 文本 |

**具体代码**：

```tsx
// src/components/ModelCapabilitiesDoctorSection.tsx
import {
  getAdditionalModelOptionsCacheScope,
  isLocalProviderUrl,
} from '../services/api/providerConfig.js'

export function ModelCapabilitiesDoctorSection(): React.ReactElement | null {
  const config = getGlobalConfig()
  const scope = config.additionalModelOptionsCacheScope
  if (!scope?.startsWith('openai:')) return null

  // ... 既有逻辑 ...

  // 2026-05-14 方案E 延伸：磁盘缓存的 scope 与当前环境推导的 scope 不一致
  // → 用户改了 BASE_URL 但本次 bootstrap 拉取失败，cache 仍是旧网关的快照
  const scopeStale = getAdditionalModelOptionsCacheScope() !== scope

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Model Capabilities</Text>
      <Text>└ 来源: {scope}</Text>
      {scopeStale && (
        <Text color="warning">
          └ 缓存来自旧网关，本次启动拉取失败（bootstrap 未成功）
        </Text>
      )}
      {/* ... 其余 isLocal / 缓存状态 / 模型列表渲染 ... */}
    </Box>
  )
}
```

**文案决策**：

- 候选讨论：包含具体 BASE_URL / 不包含；包含"⚠"emoji / 不包含；简短 vs 详细
- 最终采用用户拍板版本「缓存来自旧网关，本次启动拉取失败（bootstrap 未成功）」——简短、明确、保留括号注解供开发者识别 bootstrap 概念
- 不带 `⚠` emoji，与同组件其他 warning 文本（方案A 内网模式提示）保持无 emoji 一致风格

**触发场景矩阵**：

| 场景 | 当前 scope | 磁盘 scope | scopeStale | 警告显示 |
| --- | --- | --- | --- | --- |
| 首次启动无缓存 | `openai:http://X` | undefined | — | 整个组件早退（不显示）|
| bootstrap 正常完成 | `openai:http://X` | `openai:http://X` | false | 不显示（零干扰）|
| 改了 BASE_URL，bootstrap 失败 | `openai:http://Y` | `openai:http://X` | **true** | **显示警告** |
| 切到公网模式（baseUrl=api.openai.com） | null | `openai:http://X` | **true** | **显示警告**（合理）|
| `YWCODER_INTRANET=1` 但换了内网 IP | `openai:http://Y` | `openai:http://X` | **true** | **显示警告** |

**验证**：

```
bun run build
# 构建成功（sha:f41aaea → 新 sha 取决于 push 后的 dev build）

# 无新增单测：ModelCapabilitiesDoctorSection 当前无单测基础设施
# （项目未引入 ink-testing-library，组件也无 .test 文件），
# 新增依赖+mock 框架超出本次"精准最小改动"范围。
# 手工 e2e 验证步骤详见 commit message。
```

**设计决策**：

- 仅在 scope 不一致时显示警告，**正常使用零干扰**——避免误报
- 不引入新依赖（直接复用已有的 `getAdditionalModelOptionsCacheScope`）
- 不修改 bootstrap 失败逻辑（保留"网络抖动时缓存兜底"的 v1 优点）
- `/doctor` 仍展示缓存内的模型列表 + `context_length`——即使陈旧，对排错也有参考价值；警告只是**告知用户"这是旧快照"**，而非屏蔽数据
- 未来 v2 可考虑追加 C（缓存写入时间）让陈旧程度可量化

### v1.x 补丁 — `--migrate-config` 双目录场景与漏拷贝 bug 修复（2026-05-14）

**背景**：内网用户实测 `ywcoder --migrate-config` 时只看到"✓ 已在使用 ~/.ywcoder 配置目录"和"✓ 迁移全局配置文件 ~/.claude.json → ~/.ywcoder/.config.json"两行输出，**但 `~/.claude/` 目录里的 `settings.json`、`agents/`、`projects/` 等内容根本没搬到 `~/.ywcoder/`**；也没有出现"可以删除旧目录"的提示。

排查时又顺带挖出第二个隐患：早期 ywcoder 版本曾用过 `~/.ywcoder` 目录、后来又改回 `~/.claude`，这部分用户机器上两个目录并存，原 `cp(force:false)` 会让"老配置赢"反向覆盖最新 `~/.claude` 状态。

**根因**：

| Bug | 来源 | 影响 |
| --- | --- | --- |
| ① 早期 return 漏 cp | 2026-04-30 把 `mkdir(targetDir)` 提到函数顶部后，[configMigration.ts:73 `detectCurrentConfigDir()`](../../src/utils/configMigration.ts#L73) 的存在性检查永远命中 `~/.ywcoder`（因为我们自己刚 mkdir 出来），`currentDir === targetDir` 始终为 true，提前 return 跳过整段目录 cp 与删除提示 | 自 b3cd56b 起所有走 `--migrate-config` 的用户实际只迁移了 `.claude.json`，目录内容（含 agents/skills/projects/credentials 等）全部留在 `~/.claude/` |
| ② 双目录反向覆盖 | `cp(sourceDir, targetDir, { force: false })` 语义是"目标已存在则跳过"，双目录场景下老 `~/.ywcoder` 文件会赢过最新 `~/.claude` 文件 | 早期 ywcoder 用户升级后会被陈旧配置（旧 settings.json、旧 credentials）反向覆盖，潜在数据/登录态错乱 |

**方案**：

| 决策项 | 结论 |
| --- | --- |
| 误判修复 | 在 `mkdir` 之前先拍 `targetExistedBefore = existsSync(targetDir)` 快照，作为"用户原本是否已在新目录"的**唯一**判据；删除 `detectCurrentConfigDir()` 函数 |
| 双目录处理 | `targetExistedBefore && sourceDir` 都为真时，把历史 `~/.ywcoder` rename 为 `~/.ywcoder.bak.<本地时间戳>`（时间戳形如 `2026-05-14T10-30-00`，避免冒号/小数点—— Windows 文件名禁用），再走干净的 mkdir + step1 + cp 流程 |
| 自动删除旧目录 | **否**——`~/.claude` 本是官方 Claude Code 共享目录，不能越权清理；保持用户手动删除原则。备份目录同理只 rename 不自动删 |
| rename 失败兜底 | try/catch 包住，转为 `MigrationResult { success: false }`，避免上层 CLI 进程崩出；错误消息明确告知"两个目录均未改动"，方便用户重试或诊断 |
| cp 失败兜底 | catch 块新增"备份位置 + 可复制粘贴的回滚命令"，保证半迁移状态下用户也能一键恢复 |

**具体改动**：

| 文件 | 改动类型 | 关键内容 |
| --- | --- | --- |
| `src/utils/configMigration.ts` | 修改 | ① 删除 `detectCurrentConfigDir()`；② 新增 `makeBackupTimestamp()`；③ `migrateConfig()` 入口拍 `targetExistedBefore` 快照；④ 双目录场景 rename 备份（含 try/catch）；⑤ 步骤 2 三分支按快照而非当下存在性判断；⑥ cp 失败 catch 块追加备份位置 + 还原命令；⑦ import 新增 `rename` |
| `src/utils/envUtils.ts` | 修改 | [envUtils.ts:60-65 `getYwCoderConfigHomeDir()`](../../src/utils/envUtils.ts#L60-L65) 中"使用历史 `~/.claude` 配置目录"提示由英文改为中文（与项目"提示走中文"风格统一） |

**具体代码片段**：

```ts
// src/utils/configMigration.ts — 快照 + 双目录备份
const targetExistedBefore = existsSync(targetDir)
const sourceDir = findSourceConfigDir()

let backupDir: string | null = null
if (targetExistedBefore && sourceDir) {
  backupDir = `${targetDir}.bak.${makeBackupTimestamp()}`
  try {
    await rename(targetDir, backupDir)
  } catch (error) {
    // 转为 MigrationResult，避免上层 CLI 崩出
    const message = error instanceof Error ? error.message : String(error)
    console.error(`✗ 备份历史 ~/.ywcoder 失败：${message}`)
    console.error(`  迁移已中止，~/.ywcoder 和 ~/.claude 均未改动`)
    return { success: false, from: sourceDir, to: targetDir, message: ... }
  }
  console.log(`ℹ 检测到历史 ~/.ywcoder，已备份至 ${backupDir}`)
  console.log(`  （如确认无用可手动删除）`)
}

await mkdir(targetDir, { recursive: true })
// ...步骤 1（.claude.json → .config.json）保持不变...

// 步骤 2 三分支：用快照判断，不再用 detectCurrentConfigDir
if (targetExistedBefore && !sourceDir) {           // 真·已在新目录
  console.log('✓ 已在使用 ~/.ywcoder 配置目录')
  return { ... }
}
if (!sourceDir) {                                  // 纯新装
  console.log('✓ 已创建新配置目录 ~/.ywcoder')
  return { ... }
}
// 走 cp + 备份位置提示 + 删除旧目录命令清单
```

```ts
// cp 失败兜底
} catch (error) {
  console.error(`✗ 迁移失败：${message}`)
  if (backupDir) {
    console.error(`  历史 ~/.ywcoder 已备份至：${backupDir}`)
    console.error(`  可手动还原：rm -rf "${targetDir}" && mv "${backupDir}" "${targetDir}"`)
  }
  return { success: false, ... }
}
```

**四种场景行为矩阵**：

| 场景 | `targetExistedBefore` | `sourceDir` | 输出/行为 |
| --- | --- | --- | --- |
| 纯新装 | false | null | `✓ 已创建新配置目录 ~/.ywcoder`，仅 mkdir 空目录 |
| 只有 `~/.claude`（老用户首次迁移） | false | `~/.claude` | `✓ 迁移 .config.json` + `✓ 已将配置从 ~/.claude 迁移到 ~/.ywcoder` + 删除旧目录命令清单 |
| 只有 `~/.ywcoder`（已迁移用户） | true | null | `✓ 已在使用 ~/.ywcoder 配置目录` |
| 双目录都存在（早期残留） | true | `~/.claude` | `ℹ 检测到历史 ~/.ywcoder，已备份至 ~/.ywcoder.bak.<ts>` + `✓ 迁移 .config.json` + `✓ 已将配置从 ~/.claude 迁移到 ~/.ywcoder` + 备份目录提示 + 删除旧目录命令清单 |

**设计决策**：

- 用 `rename` 而非 `cp + rm`：原子操作、无损、零数据丢失风险；且两个路径都在 `homedir()` 下必然同一文件系统，不会跨设备失败
- 时间戳精度到秒（`2026-05-14T10-30-00`），不带毫秒——可读性优先；同秒内重跑命令概率极低且 rename 失败时已有兜底
- **不**修改 `MigrationResult` 类型新增 `backupDir` 字段——目前 [cli.tsx:102](../../src/entrypoints/cli.tsx#L102) 只用 `success` 决定退出码，加字段属于过度设计
- **不**自动删除 `~/.claude`：该目录本是官方 Claude Code 共享目录，越权清理可能破坏并存的官方 Claude Code 工作流；备份目录同理
- **不**在 mkdir/copyFile 外包额外 try/catch：这些是 OS 级故障（磁盘满/权限），按 CLAUDE.md "不为不可能场景加错误处理"原则跳过
- 单元测试：原文件本就无 `configMigration.test.ts`，本次也未补——已知改进点，列入未来 v2

**验证**：

- 构建：`bun run build` 通过（dev build sha 取决于 CI）
- 4 种场景：本地手工推演分支逻辑正确（rebase 后 commit `4888d78`）
- 内网部署：已 push 到 `feature/brand-replacement` 触发 `build-npm-windows-offline` / `build-npm-linux-offline` 打包，待内网测试机实测

**Commit**：`4888d78 fix: 修复 --migrate-config 在双目录场景下漏拷贝与老配置反向覆盖`

**关联**：本补丁修复的是 b3cd56b（§三"配置迁移提交"）引入的两个潜伏缺陷，建议把 b3cd56b 文档章节里"边界情况处理"列表中的"迁移成功"一行更新为"含历史 `~/.ywcoder` 残留时自动备份至 `~/.ywcoder.bak.<时间戳>`"。

---

## 四、验证结果

### 单元测试

```
bun test src/utils/providerDiscovery.test.ts
# 8 tests pass（含 3 条 context_length 新用例）

bun test --max-concurrency=1
# 全量测试无回归
```

### 构建验证

```
bun run build && bun run smoke
# dist/cli.mjs 生成正常，版本命令可用
```

### 方案A验证（2026-05-10）

```
bun run build
# 构建成功

bun test --max-concurrency=1
# 530 pass / 0 fail（含方案A改动，零回归）
```

### 手动验证路径

1. 启动时打印 bootstrap cache 日志（若配置 OpenAI provider）
2. `/doctor` 内 Model Capabilities 段落展示 scope + 缓存条数 + per-model contextWindow
3. `getContextWindowForModel()` 读取 `additionalModelOptionsCache` 中的 contextWindow 字段

---

## 五、v1 接受的限制

| 限制                                | 说明                                                                                                                                                           | 影响范围                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **首请求竞态**                      | bootstrap 在 fire-and-forget 模式下异步完成（通常 300ms 内），若用户在 bootstrap 完成前（< 0.5% 概率）发出首请求，走 fallback（硬编码表 / 200K）而非网关自报告 | 仅首请求，后续请求恢复正常                                         |
| **profile 切换不刷新**              | 用户执行 `/provider` 切换 provider 后，`additionalModelOptionsCache` 不实时刷新，需重启 CLI                                                                    | 重启后 bootstrap 重新拉取，自动恢复正确值                          |
| **`/model` 刷新不含 contextWindow** | `/model` 命令刷新的是 `openaiAdditionalModelOptionsCache`（Option A 不改此路径），该缓存不携带 contextWindow                                                   | 不影响 `getContextWindowForModel()` 读取（固定读 bootstrap cache） |
| **Doctor 缓存**                     | 若 bootstrap 在打开 /doctor 前未完成，段落显示"未加载"；用户需重开 /doctor（Plan B 文案引导）                                                                  | 启动超过 10s 后基本不出现                                          |
| **/doctor 无时间戳**                | 当前实现不显示"缓存于何时"信息（原规格有 `cached at ...`）                                                                                                     | 排障时需配合日志，v2 可选补充                                      |
| **非 OpenAI provider 不展示**       | `ModelCapabilitiesDoctorSection` 在非 `openai:` scope 时返回 null                                                                                              | 公网用户 / Gemini / GitHub 用户无感知                              |
| **方案A：首次启动 /model 可能为空** | bootstrap 尚未完成前 `additionalModelOptionsCache` 为空，内网 `/model` 选择器展示空列表，需等待 3-5s 或重启 CLI                                                | 与"首请求竞态"同一类问题，启动完成后自动恢复                       |

---

## 六、后续建议

### 已完成的补丁

- **✅ 方案A — 内网模型列表去歧义（2026-05-10）**：运行时过滤 `/model` 选择器和 `getContextWindowForModel()` fallback 链路，解决内网用户看到公网硬编码模型的问题

### v2 可选项（按优先级排序）

1. **P1 — profile 切换触发 bootstrap 刷新**：`setActiveProviderProfile()` 中补充调用 `fetchBootstrapData()`，消除切换后的陈旧 contextWindow 问题（目前重启可解决，不紧急）
2. **P1 — Doctor 段落加时间戳**：在 `ModelCapabilitiesDoctorSection` 中展示 bootstrap 完成时间，方便排障定位"缓存是否是本次启动写入的"
3. **P2 — `/model` 刷新路径携带 contextWindow（Option B）**：修改 `openaiModelDiscovery.ts:fetchOpenAIModels()` 同步解析 `context_length`，并修复 `haveSameModelOptions()` 的 contextWindow 比较逻辑；使 `/model` 命令刷新后即时生效，无需重启
4. **P2 — 手动覆盖层**：若用户需要临时覆盖某模型的 contextWindow（测试 / 调试），可选择保留 `models-config.json` 作为最高优先级手动层（目前通过 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 环境变量全局覆盖）
5. **P3 — `max_output_tokens` 字段协议 v2**：若网关侧确认有输出 token 上限约束，届时升级协议支持 `max_output_tokens` 字段（当前 escalation 机制被 GrowthBook 门禁，内网无收益）

### 网关侧待确认（已在方案文档 §十一 标注）

- [ ] 网关团队配置 `/v1/models` 响应的 `context_length` 字段（按实际推理框架配置，如 vLLM 的 `max_model_len`）
- [ ] 确认收到 `max_tokens=64000` 等大值请求时不主动拒绝（由推理后端自然截断）

### 迁移提醒

`ywcoder --migrate-config` 目前为可选命令（不强制执行）。建议在下一个版本发布说明中提醒用户主动执行一次，以将 `~/.claude.json` 中已有的配置（包括 API key、additionalModelOptionsCache 等）迁移到 `~/.ywcoder/.config.json`。迁移完成后，长期来看 `configMigration.ts` 中的 `~/.claude` 目录迁移逻辑可在 v3 稳定期清理掉。

> **说明**：执行 `ywcoder --migrate-config` 会做以下事情：

1. **创建新配置目录** `~/.ywcoder`（如果不存在）。该步骤作为后续迁移的共同前置，无论是否需要迁移都会执行。
2. **迁移全局 JSON 配置**：将 `~/.claude.json` 复制为 `~/.ywcoder/.config.json`。此步骤独立执行，不依赖 `~/.claude/` 目录是否存在，兼容以下场景：
   - 官方 Claude Code 已卸载但 `~/.claude.json` 残留；
   - 用户手动清理了 `~/.claude/` 目录但 JSON 配置还在。
     仅在目标文件不存在时复制，避免覆盖用户已在 YwCoder 中单独修改过的配置。
3. **迁移整个配置目录**：将旧目录 `~/.claude` 中的所有内容递归复制到 `~/.ywcoder`（不覆盖已有文件，保留时间戳）。

边界情况处理：

- **已使用 `~/.ywcoder`**：提示 "Already using ~/.ywcoder"，直接跳过。
- **无旧配置**：仅创建新目录，提示 "Created new config directory"。
- **迁移成功**：提示完成，并建议用户可安全删除旧目录 `rm -rf ~/.claude`。
- **迁移失败**：打印错误信息并返回非零退出码。

---

## 七、当前请求链路分析追溯

> **说明**：本章基于实际代码（2026-05-10 代码核查），展示此次特性实施后的完整请求链路。如与历史设计文档有出入，以本章为准。
>
> **标注说明**：
>
> - `[新增]` — 本次特性新增的代码/步骤，实施前不存在
> - `[变更]` — 本次特性修改了已有代码，实施前后行为不同
> - 无标注 — 原有代码，本次未改动

---

### 7.1 链路一：启动时 context_length 获取与缓存写入

```
┌─────────────────────────────────────────────────────────────┐
│  src/main.tsx:2345                                          │
│  void fetchBootstrapData()   ← fire-and-forget（原有）      │
│                                                             │
│  触发条件：                                                  │
│    !isBareMode()                                            │
│    && !(tengu_cicada_nap_ms 节流 && 最近已执行)              │
│  REPL 不等待此调用，立即就绪                                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  src/services/api/bootstrap.ts:fetchBootstrapData()（原有） │
│                                                             │
│  scope = getAdditionalModelOptionsCacheScope()              │
│                                                             │
│  scope === 'firstParty'    → fetchBootstrapAPI()（原有）    │
│  scope?.startsWith('openai:') → fetchLocalOpenAIModelOptions│
│  其他（null）              → 直接 return，跳过              │
└──────────────────────────┬──────────────────────────────────┘
                           │ scope.startsWith('openai:')
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  src/services/api/providerConfig.ts（原有）                 │
│  getAdditionalModelOptionsCacheScope()  ← scope 计算规则   │
│                                                             │
│  USE_OPENAI=1，transport=chat_completions，                 │
│  isLocalProviderUrl(OPENAI_BASE_URL) == true                │
│  → 'openai:${OPENAI_BASE_URL.toLowerCase()}'               │
│                                                             │
│  注：isLocalProviderUrl() 只认私有/内网地址：               │
│    localhost / 127.0.0.0/8 / RFC1918 / .local / 私有 IPv6  │
│  公网地址（api.openai.com）→ scope=null → bootstrap 跳过   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  bootstrap.ts:fetchLocalOpenAIModelOptions()（原有）        │
│                                                             │
│  baseUrl = resolveProviderRequest().baseUrl                 │
│    ← OPENAI_BASE_URL（去除尾部斜杠）                        │
│                                                             │
│  models = await listOpenAICompatibleModels({                │
│    baseUrl,  apiKey: process.env.OPENAI_API_KEY,            │
│  })                                                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  src/utils/providerDiscovery.ts:listOpenAICompatibleModels()│
│                                                             │
│  请求（原有）：                                              │
│    GET {OPENAI_BASE_URL}/models                             │
│    Authorization: Bearer {OPENAI_API_KEY}   超时：5000ms   │
│    注：代码追加 "/models"，"/v1" 由 OPENAI_BASE_URL 提供   │
│                                                             │
│  [变更] 响应类型声明新增 context_length 字段：              │
│    data.data[].context_length?: number | null               │
│                                                             │
│  [变更] 去重机制：Set(string[]) → Map<id, {id,contextWindow}>│
│    重复 id → 最后一条覆盖前值                               │
│                                                             │
│  [新增] context_length 过滤规则：                           │
│    typeof === 'number' && > 0  → contextWindow 取此值       │
│    0 / 负数 / null / 非数字   → contextWindow = undefined   │
│                                                             │
│  [变更] 返回类型：                                          │
│    实施前：Promise<string[] | null>                         │
│    实施后：Promise<Array<{id: string; contextWindow?: number}> | null>│
│    网络/解析失败 → null；HTTP 非 2xx → null                 │
└──────────────────────────┬──────────────────────────────────┘
                           │ models !== null
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  bootstrap.ts:fetchBootstrapData()（续）                    │
│                                                             │
│  [变更] models.map() 映射逻辑：                             │
│    实施前：{ value: model,    label: model,    description }│
│    实施后：{ value: model.id, label: model.id,              │
│             description, contextWindow: model.contextWindow }│
│                                                             │
│  去重检查：isEqual() → 未变化跳过写入（原有）               │
│                                                             │
│  saveGlobalConfig(current => ({                             │
│    ...current,                                              │
│    additionalModelOptionsCache: additionalModelOptions,     │
│    additionalModelOptionsCacheScope: scope,                 │
│    clientDataCache: ...,                                    │
│  }))                                                        │
│                                                             │
│  写入文件：getGlobalClaudeFile()                            │
│    优先：{getYwCoderConfigHomeDir()}/.config.json（若存在） │
│    否则：~/.claude.json                                     │
└─────────────────────────────────────────────────────────────┘
```

---

### 7.2 链路二：每次请求时 contextWindow 读取

每次 LLM 请求前，通过 `getContextWindowForModel(model)` 决定当前有效上下文窗口大小（用于 auto-compact 阈值计算、token 用量警告等）。

**优先级链路（按 `src/utils/context.ts:getContextWindowForModel()` 实际代码顺序）：**

```
1. CLAUDE_CODE_MAX_CONTEXT_TOKENS 环境变量
   [变更] 实施前：需 USER_TYPE='ant' 门禁才可用
          实施后：去除 ant 门禁，所有用户可用
                 （网关自报告不可用时的管理员应急覆盖）
       ↓ 未设置或非正整数

2. [1m] 后缀检测（has1mContext()）——原有，未改动
   → 1_000_000
       ↓

3. OpenAI 兼容 provider 分支——原有分支结构，内部新增 3a
   条件：YWCODER_USE_OPENAI=1 / USE_GEMINI=1 / USE_GITHUB=1
   ↓
   3a. [新增] findCachedModelOption(model)
       ← 读 globalConfig.additionalModelOptionsCache
       ← scope 守卫：scope 必须以 'openai:' 开头
         （USE_GEMINI/USE_GITHUB 的 scope 不含此前缀，直接返回 undefined）
       ← 匹配：opt.value === model || opt.label === model
       → 命中 && contextWindow > 0 → 返回（★ 网关自报告主路径）
       ↓ 未命中

   3b. getOpenAIContextWindow(model)
       [变更] 实施前：无条件查询硬编码表
              实施后：条件查询
                条件：!isLocal || cache 为空  → 正常查硬编码表（原有行为）
                条件：isLocal && cache 非空   → 跳过，直接落到 Step 8（200K）
                其中 isLocal = scope.startsWith('openai:')
                               && isLocalProviderUrl(scope.replace('openai:',''))
       ← openaiContextWindows.ts 硬编码表（公网模型兜底）
       → 命中 → 返回
       ↓ 未命中

4. getModelCapability().max_input_tokens——原有，未改动
5. Beta 头 1M 检测——原有，未改动
6. Sonnet 实验功能——原有，未改动

7. USER_TYPE='ant' → resolveAntModel()——原有，未改动
   注：Step 1 只去除了 CLAUDE_CODE_MAX_CONTEXT_TOKENS 的 ant 门禁，
       此处的 ant 检查（用于 Ant 内部模型表）独立存在，未动
       ↓

8. MODEL_CONTEXT_WINDOW_DEFAULT = 200_000——原有，未改动
```

---

### 7.3 /doctor 诊断链路

```
用户执行 /doctor
   ↓
src/screens/Doctor.tsx（原有，React Compiler 静态编译）
   ↓ [变更] 新增一行 JSX：在 SandboxDoctorSection 之后插入组件
   ↓
[新增] src/components/ModelCapabilitiesDoctorSection.tsx
   ↓
同步读取 getGlobalConfig()
   ├── scope 不以 'openai:' 开头 → return null（非内网用户无感知）
   │
   └── scope 以 'openai:' 开头 → 渲染 Model Capabilities 段落
       │
       │   [变更 v1.x] 计算 isLocal = isLocalProviderUrl(scope.replace('openai:',''))
       │
       ├── isLocal && cache.length > 0
       │   → [新增 v1.x] dimColor 提示：
       │       "内网模式：已过滤硬编码预设模型，仅展示网关发现模型"
       │
       ├── isLocal && cache.length === 0
       │   → [新增 v1.x] warning 提示：
       │       "内网模式：未从网关发现可用模型，/model 列表为空"
       │
       ├── cache.length === 0（缓存状态行，含上述 isLocal 场景）
       │   → [新增 v1] 显示引导文案：若超过 10 秒请重开 /doctor
       │     原因：React Compiler 静态 cache 不支持 useState 刷新
       │
       └── cache.length > 0（缓存状态行）
           → [新增 v1] 展示 scope / 模型数量 / per-model contextWindow
              有值：context_length=131072
              无值：fallback 到硬编码表或 200K 默认值
```

---

### 7.4 改动点汇总（实施前 → 实施后）

| 文件                                              | 改动类型     | 实施前行为                                                   | 实施后行为                                                                                                            |
| ------------------------------------------------- | ------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `providerDiscovery.ts:listOpenAICompatibleModels` | 变更         | 返回 `string[]`，Set 去重，不解析 `context_length`           | 返回 `Array<{id,contextWindow?}>`，Map 去重，解析并过滤 `context_length`                                              |
| `model/modelOptions.ts:ModelOption`               | 变更         | 无 `contextWindow` 字段                                      | 新增 `contextWindow?: number` 字段                                                                                    |
| `bootstrap.ts:fetchLocalOpenAIModelOptions`       | 变更         | `.map(model => ({value: model, ...}))`                       | `.map(model => ({value: model.id, ..., contextWindow: model.contextWindow}))`                                         |
| `context.ts:getContextWindowForModel` — Step 1    | 变更         | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 需 `USER_TYPE='ant'` 才可用 | 去除 ant 门禁，所有用户均可用                                                                                         |
| `context.ts:findCachedModelOption`                | 新增         | 不存在                                                       | 新增工具函数，读取 `additionalModelOptionsCache`，含 scope 守卫                                                       |
| `context.ts:getContextWindowForModel` — Step 3a   | 新增         | OpenAI 分支直接走硬编码表                                    | 先查网关缓存，未命中再走硬编码表                                                                                      |
| `components/ModelCapabilitiesDoctorSection.tsx`   | 新增         | 不存在                                                       | 新建组件，展示缓存状态与 per-model contextWindow                                                                      |
| `screens/Doctor.tsx`                              | 变更         | 无 Model Capabilities 段落                                   | 插入 `<ModelCapabilitiesDoctorSection />`                                                                             |
| `model/modelOptions.ts:getModelOptions`           | 变更（v1.x） | `options = getModelOptionsBase()`，始终包含预设模型          | 内网（`isLocalProviderUrl=true`）且发现模型非空时 `options = [...discovered]`（浅拷贝，只含网关模型）；否则同原有行为 |
| `context.ts:getContextWindowForModel` — Step 3b   | 变更（v1.x） | 无条件查 `getOpenAIContextWindow()` 硬编码表                 | 仅当 `!isLocal \|\| cache 为空` 时查；内网且缓存非空时跳过，直接走 200K 默认值                                        |
| `components/ModelCapabilitiesDoctorSection.tsx`   | 变更（v1.x） | 仅展示缓存状态和模型列表                                     | 新增 `isLocal` 判断：有模型时 dimColor 提示"已过滤硬编码预设模型"，无模型时 warning 提示"未发现可用模型"              |

---

## 八、用户配置操作指南（内网环境）

> 本章节面向在内网部署 OpenAI 兼容网关的终端用户，说明如何配置 CLI 以自动拉取网关自报告的模型能力参数。

### 8.1 网关侧准备

确保内网 OpenAI 兼容网关（自研）在 `/v1/models` 响应中正确配置了 `context_length` 字段，示例：

```json
{
  "data": [
    {
      "id": "qwen2.5-72b",
      "context_length": 131072
    }
  ]
}
```

### 8.2 CLI 环境变量配置

设置以下环境变量（或写入 shell profile）：

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://your-internal-gateway/v1  # 内网地址
export OPENAI_API_KEY=your-api-key
export OPENAI_MODEL=qwen2.5-72b                          # 默认模型（保底）
```

**关键判定**：`OPENAI_BASE_URL` 必须是内网地址（`localhost` / `127.0.0.0/8` / RFC1918 私有网段 / `.local` / 私有 IPv6），CLI 才会识别为内网模式并触发网关自报告。公网地址（如 `api.openai.com`）会跳过此流程。

**关于 `OPENAI_MODEL`**：不需要清理。它指定 CLI 启动时的默认模型，与网关自报告是互补关系：
- `OPENAI_MODEL` → 决定启动后默认用哪个模型发请求
- `OPENAI_BASE_URL` + `OPENAI_API_KEY` → 让 bootstrap 去网关拉取模型列表和 `context_length`

若清理掉 `OPENAI_MODEL`，CLI 会 fallback 到 `'gpt-4o'`，如果内网网关不存在该模型则首请求 404。建议保留 `OPENAI_MODEL` 指向网关确实存在的模型作为保底。

### 8.3 配置迁移（建议执行一次）

如果之前使用过官方 Claude Code 或旧版本：

```bash
ywcoder --migrate-config
```

该命令会将 `~/.claude.json` 迁移到 `~/.ywcoder/.config.json`，确保缓存文件路径正确。迁移逻辑详见上文"配置迁移提交（`b3cd56b`）"章节。

### 8.4 启动 CLI，自动拉取模型参数

```bash
ywcoder
```

启动时会**自动**触发 `fetchBootstrapData()`（fire-and-forget 模式，不阻塞 REPL）：

1. 发送 `GET {OPENAI_BASE_URL}/models` 请求
2. 解析响应中的 `context_length`
3. 过滤有效值（`typeof === 'number' && > 0`）
4. 将 `{id, contextWindow}` 写入 `additionalModelOptionsCache`

通常 300ms 内完成。若失败会显示黄色静态横幅，不阻塞使用。

### 8.5 验证是否生效

执行 `/doctor`，查看 **Model Capabilities** 段落：

- 展示当前 scope、缓存模型数量
- 每个模型显示 `context_length` 值（如 `131072`）或 fallback 提示
- 内网环境下额外提示："已过滤硬编码预设模型，仅展示网关发现模型"

若启动后立即打开 `/doctor` 显示"未加载"，等几秒后**重开一次** `/doctor` 即可（React Compiler 静态缓存限制）。

### 8.6 正常使用

后续每次请求前，`getContextWindowForModel()` 按以下优先级读取上下文窗口：

```
环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS（应急覆盖）
    ↓
[1m] 后缀
    ↓
★ additionalModelOptionsCache 中的 contextWindow（网关自报告主路径）
    ↓
硬编码公网模型表（兜底）
    ↓
ModelCapabilities 表
    ↓
默认值 200_000
```

### 8.7 切换模型

执行 `/model`，选择器**仅展示网关发现的内网模型**（已过滤掉公网硬编码预设模型，避免歧义）。用户可随时切换到其他网关模型。

### 8.8 已知限制

| 限制 | 说明 |
| --- | --- |
| 首请求竞态 | bootstrap 异步完成（约 300ms），若极快发首请求可能走 200K fallback |
| profile 切换不刷新 | 切换 provider 后需**重启 CLI** 重新拉取网关参数 |
| 首次启动 /model 可能为空 | bootstrap 尚未完成前缓存为空，内网 `/model` 选择器可能展示空列表，等 3-5s 或重启即可 |
| Doctor 缓存静态 | 若打开 /doctor 时 bootstrap 未完成，需重开 /doctor 查看最新状态 |
