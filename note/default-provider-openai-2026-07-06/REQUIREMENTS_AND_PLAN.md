# 默认 Provider 改为 OpenAI 的需求与方案文档

> **TL;DR**：默认 Provider 从 Anthropic 切为 OpenAI，解决内网用户必须手动配 `YWCODER_USE_OPENAI=1` 才能对接内网 LLM 网关的问题——改前一旦变量误改、漏配或误删，系统回退到 Anthropic 直连（`api.anthropic.com`），内网不可触达导致工具完全不可用；改后默认走 OpenAI 兼容接口，零配置开箱即用。

## 日期

2026-07-06

## 状态

方案已确定（2026-07-12 评审 + grep 核实修订：补齐"正向 USE_OPENAI 检查"及"切换 UI 残留 USE_ANTHROPIC"遗漏项，方案一改动文件由 10 增至 15，修正 providerValidation 工作量估计，补充多 entrypoint 覆盖论据）

---

## 一、需求背景

### 1.1 问题描述

当前 ywcoder-cli 通过设置 `YWCODER_USE_OPENAI=1` 环境变量来使用 OpenAI 协议接口（对接内网 LLM 网关）。但如果该变量被误改、误删或未设置，系统会回退到默认的 Anthropic 直连（`firstParty`），而 Anthropic API（`api.anthropic.com`）在内网环境不可触达。

### 1.2 核心诉求

**代码级保证**：默认走 OpenAI 协议，只有显式配置才走 Anthropic。即使没有任何环境变量，系统也不会尝试连接 Anthropic API。

### 1.3 现有机制

provider 选择由两个关键函数控制：

| 函数 | 文件 | 默认行为（无 USE_* 标志时） |
|------|------|---------------------------|
| `getAPIProvider()` | `src/utils/model/providers.ts:15-31` | 返回 `'firstParty'`（即 Anthropic 官方 API） |
| `getAnthropicClient()` | `src/services/api/client.ts:178-359` | 创建原生 Anthropic SDK 客户端 |

环境变量优先级链：`gemini > github > openai/codex > bedrock > vertex > foundry > firstParty`

两个函数的最后一行都是"什么都没设 → Anthropic"。所以只要 `YWCODER_USE_OPENAI` 没设或被清掉，系统就会尝试连接 Anthropic API。

### 1.4 关键概念说明

- **`firstParty`**：对项目原作者 Anthropic 而言，自己就是"第一方"，所以源码用 `firstParty` 指代 Anthropic 官方 API。其余 provider（openai、bedrock 等）统称"第三方（3P）"。

- **`getYwCoderEnv()`**：品牌改名后的兼容函数。先查 `YWCODER_*` 新名字，没找到再回退查旧的 `CLAUDE_CODE_*`。因为有些老用户可能仍在使用旧环境变量名。但 `YWCODER_USE_ANTHROPIC` 是 ywcoder 自创概念，上游 Claude Code 不存在这个变量，因此不需要此回退。

- **OpenAI shim**：适配层（`src/services/api/openaiShim.ts`）。整个项目的业务代码是按 Anthropic SDK 接口写的（参数名、返回值格式全是 Anthropic 风格），shim 在中间翻译：接收 Anthropic 格式的调用，转换为 OpenAI 协议（`/v1/chat/completions`）发出去，再把返回的 OpenAI 格式翻译回 Anthropic 格式。这样改底层协议时上层业务代码每行都不用动。

- **`isAnthropicAuthEnabled()` / `isUsing3PServices()`**：这两个函数不调用 `getAPIProvider()`，而是各自独立列举 `USE_*` 环境变量来判断。如果只改 `getAPIProvider()` 的默认值而不改它们，会出现"provider 说自己是 openai，但 auth 模块认为还是 Anthropic"的矛盾。这是方案一要改它们的根本原因。

- **正向检查（正向信号）陷阱**：代码里读 provider 的判断分三类：
  1. `getAPIProvider() !== 'firstParty'` / `=== 'firstParty'` —— 几十处（betas、autoUpdater、webSearch、mcp registry、settingsSync、analytics、modelOptions 等）。翻转 `getAPIProvider()` 默认值后**全部自动跟着正确**，这是方案一优于方案二/三的根本原因。
  2. `getAPIProvider() === 'openai'` —— 少量。同样**自动正确**。
  3. 手写 `isEnvTruthy(getYwCoderEnv('USE_OPENAI'))` 作为"是否 OpenAI 模式"的**正向信号** —— 若干处。翻转默认值**不会**让它们变对：默认走 openai 但环境变量 `USE_OPENAI` 并没有被设置，这些正向检查会返回 `false`，导致"provider 是 openai，但该模块以为不是"。**这类检查必须逐个改造**，不会自动收敛。方案一原先只处理了 `auth.ts`/`client.ts`/`providerValidation.ts`/`providerConfig.ts` 里的正向检查，还漏了 `context.ts`（功能性）、`main.tsx`/`StartupScreen.ts`/`provider.tsx`（展示层）。

---

## 二、方案对比

### 2.1 方案一：硬编码默认值反转（推荐）

**思路**：修改 `getAPIProvider()` 的 fallback 和所有相关判断逻辑，默认走 OpenAI。新增 `YWCODER_USE_ANTHROPIC=1` 给需要显式切回 Anthropic 的场景。核心原则是**将所有零散的 `isEnvTruthy(USE_*)` 判断收敛到 `getAPIProvider()` 单一真相源**。

**改动文件（15 个）**：

| # | 文件 | 改动 | 说明 |
|---|------|------|------|
| 1 | `src/utils/model/providers.ts` | ~5 行 | 加 `YWCODER_USE_ANTHROPIC` 最高优先级；fallback 改为 `'openai'`；`getAPIProvider()` 加可选 env 参数（默认 process.env） |
| 2 | `src/services/api/client.ts` | ~15 行 | 重构为按 `getAPIProvider()` 分流：firstParty → Anthropic SDK，bedrock/vertex/foundry → 各自 SDK，其余 → OpenAI shim |
| 3 | `src/utils/auth.ts` | ~6 行 | `isUsing3PServices()` 和 `isAnthropicAuthEnabled()` 的 is3P 判断改为基于 `getAPIProvider() !== 'firstParty'` |
| 4 | `src/utils/providerValidation.ts` | ~15 行（小重构） | `getProviderValidationError()` 内部的 `useOpenAI` 改为从 `getAPIProvider(env)` 推导，不能只改外层触发条件（见 3.2 第 4 条） |
| 5 | `src/utils/providerFlag.ts` | +1 行 | `--provider anthropic` 从 no-op 改为设 `YWCODER_USE_ANTHROPIC=1` |
| 6 | `src/utils/managedEnvConstants.ts` | +2 行 | `PROVIDER_MANAGED_ENV_VARS` 和 `SAFE_ENV_VARS` 各加入 `YWCODER_USE_ANTHROPIC` |
| 7 | `src/utils/swarm/spawnUtils.ts` | +1 行 | 子进程 env 转发加入 `YWCODER_USE_ANTHROPIC` |
| 8 | `src/utils/providerProfiles.ts` | ~8 行 | anthropic preset 设 `USE_ANTHROPIC=1`；`hasProviderSelectionFlags()`、`hasConflictingProviderFlagsForProfile()`、`clearProviderProfileEnvFromProcessEnv()` 三处补上 ANTHROPIC |
| 9 | `src/utils/providerProfile.ts` | +1 行 | `hasExplicitProviderSelection()` 加入 `YWCODER_USE_ANTHROPIC` 检测 |
| 10 | `providerConfig.ts` → `modelOptions.ts`（搬函数）+ 3 处 import 改指向 | ~10 行 | `getAdditionalModelOptionsCacheScope()` **从 providerConfig.ts 搬到 modelOptions.ts**，改为基于 `getAPIProvider() === 'firstParty'` 判断。**避免 providers.ts ⇄ providerConfig.ts 循环依赖**（详见 3.2 第 10 条）。连带改 `ModelCapabilitiesDoctorSection.tsx`/`model.tsx`/`bootstrap.ts` 的 import 指向 |
| 11 | `src/utils/context.ts` | ~4 行 | **（必修，功能性）** `getContextWindowForModel()`（第 98 行）和 `getMaxOutputTokens()`（第 214 行）的正向 `isEnvTruthy(USE_OPENAI)` 检查改为基于 `getAPIProvider() !== 'firstParty'`。否则默认 openai 无 env 时会回落到 Anthropic 的上下文窗口/输出 token 假设，发到内网网关可能触发 400 |
| 12 | `src/main.tsx` | ~2 行 | **（建议，展示层）** 第 2319 行非法 settings 弹窗抑制条件的正向 `USE_OPENAI` 检查改为基于 `getAPIProvider()` |
| 13 | `src/components/StartupScreen.ts` | ~2 行 | **（建议，展示层）** 第 59 行启动屏 provider 展示的正向 `USE_OPENAI` 检查改为基于 `getAPIProvider()` |
| 14 | `src/commands/provider/provider.tsx` | ~2 行 | **（建议，展示层）** 第 200 行 provider 命令显示逻辑的正向 `USE_OPENAI` 检查改为基于 `getAPIProvider()` |
| 15 | `src/components/ProviderManager.tsx` | ~3 行 | **（必修，功能性）** 交互式 `/provider` 切换 UI。`clearStartupProviderOverrideFromUserSettings()`（第 262 行）和 `activateGithubProvider()`（第 297/321 行）在清空兄弟 `USE_*` 时补上 `YWCODER_USE_ANTHROPIC`（settings 置 undefined + `delete process.env`）。否则从 Anthropic 切到其他 provider 时 `USE_ANTHROPIC=1` 残留，因其在 `getAPIProvider()` 中优先级最高，会强制盖回 firstParty，切换静默失效 |

> **注 1**：`YWCODER_USE_ANTHROPIC` 是 ywcoder 自创概念，上游 Claude Code 不存在 `CLAUDE_CODE_USE_ANTHROPIC`，因此直接用 `process.env.YWCODER_USE_ANTHROPIC`，不经过 `getYwCoderEnv()`。
>
> **注 2**：文件 #11~#14 属于"正向检查陷阱"（见 1.4 节）、#15 属于"切换时残留 `USE_ANTHROPIC`"陷阱，翻转默认值都不会让它们自动变对。**实施第一步应先全量 grep**（见 3.2 开头），逐个核实每处 `isEnvTruthy(USE_OPENAI)` / `getYwCoderEnv('USE_OPENAI') === '1'` 正向检查在翻转默认后是否仍正确，而不是照本清单机械改。建议抽一个 `isOpenAICompatibleProvider()`（内部即 `getAPIProvider() !== 'firstParty'`）helper 复用，真正把正向检查收敛掉。

**优点**：
- 代码级保证，无法被环境变量绕过（连 `USE_OPENAI=0` 这种误改也不会回退 Anthropic，仍走 openai）
- 改在 `getAPIProvider()` 这个所有 entrypoint 共享的函数里，`cli.tsx` / `grpc` / `bridge` / SDK 全部自动覆盖（方案二把默认值设在 `cli.tsx` 启动阶段，非 cli 入口拿不到默认值，会退回 Anthropic）
- 第一类 `!== 'firstParty'` 判断（几十处）自动跟着翻转，无需逐个改
- 运行时语义直观——看 `providers.ts` 末尾即知默认 provider
- 不依赖构建系统

**缺点**：
- 无构建灵活性（写死 openai）
- 改动文件较多，且需甄别所有"正向 `USE_OPENAI` 检查"（第三类），无法完全靠 `getAPIProvider()` 自动收敛

---

### 2.2 方案二：MACRO 编译时注入

**思路**：用 `build.ts` 的 `define` 注入 `MACRO.DEFAULT_USE_OPENAI = '1'`，在 `cli.tsx` 启动最早阶段用 `??=` 给 `process.env.YWCODER_USE_OPENAI` 设默认值。让现有依赖 `isEnvTruthy(USE_OPENAI)` 的代码自动生效，不需要逐个改造。

**改动文件（6 个）**：

| # | 文件 | 改动 | 说明 |
|---|------|------|------|
| 1 | `scripts/build.ts` | +1 行 | define: `MACRO.DEFAULT_USE_OPENAI: '1'` |
| 2 | `src/entrypoints/cli.tsx` | +3 行 | 最早阶段设 `process.env.YWCODER_USE_OPENAI ??= MACRO.DEFAULT_USE_OPENAI` |
| 3 | `src/utils/model/providers.ts` | +3 行 | 加 `USE_ANTHROPIC` 最高优先级检测 |
| 4 | `src/utils/providerFlag.ts` | +1 行 | `--provider anthropic` 设 `USE_ANTHROPIC=1` |
| 5 | `src/utils/managedEnvConstants.ts` | +2 行 | `PROVIDER_MANAGED_ENV_VARS` 和 `SAFE_ENV_VARS` 加入 `YWCODER_USE_ANTHROPIC` |
| 6 | `src/utils/swarm/spawnUtils.ts` | +1 行 | 转发 `YWCODER_USE_ANTHROPIC` |

**相较于方案一不需要改的文件**：
- `client.ts` — 现有 `USE_OPENAI` 检测自动命中
- `auth.ts` — `is3P` 检测到 `USE_OPENAI=1`，auth 自动禁用
- `providerValidation.ts` — `useOpenAI=true`，正常验证凭证
- `providerProfiles.ts` / `providerProfile.ts` / `providerConfig.ts` — 现有逻辑自动生效

**优点**：
- 改动文件更少（6 个）
- 构建层面可切换（改 define 即可，不需要改源码）
- 对大多数现有代码零侵入

**缺点**：
- 运行时有两层间接性：MACRO 替换 → env var 默认值 → 行为，出问题时 debug 路径更长
- `??=` 时序敏感：必须确保在 `applyProviderFlagFromArgs()` 之前执行，否则 `--provider anthropic` 可能不生效
- MACRO 替换依赖构建系统正确配置，历史上有 feature flag shim 因 Bun 版本升级而整体失效的先例（见 `build.ts` 第 82-89 行注释）
- 保留了分散的 `isEnvTruthy(USE_*)` 判断，未收敛到 `getAPIProvider()` 单一真相源

---

### 2.3 方案三：打包默认 settings.json

**思路**：在部署包中自带含 `YWCODER_USE_OPENAI=1` 的配置文件，利用现有的 `applySafeConfigEnvironmentVariables()` 在启动时应用。

**改动**：
- 在打包脚本中添加默认 `settings.json` 文件，包含 `"env": { "CLAUDE_CODE_USE_OPENAI": "1" }`

**优点**：
- 不改任何源码
- 对构建系统零侵入

**缺点**：
- **非代码级保证**：用户或管理员可能覆盖 settings.json，使默认值失效
- settings.json 的 env 应用时机较晚，某些早期初始化可能在 env 应用前就走到了 Anthropic 路径
- 不可控：无法阻止用户删除或修改此文件

---

### 2.4 方案对比总表

| 维度 | 方案一（硬编码） | 方案二（MACRO env 默认） | 方案三（默认 settings.json） |
|------|-----------------|------------------------|----------------------------|
| 改动文件数 | 15 | 6 | 1 |
| 代码级保证 | ✅ 是 | ✅ 是 | ❌ 否（文件级） |
| 可被环境变量绕过 | ❌ 否 | ⚠️ `USE_OPENAI=0` 误改会回退 | ✅ 是 |
| 覆盖全部 entrypoint（cli/grpc/bridge/sdk） | ✅ 是 | ❌ 仅 cli.tsx | ⚠️ 取决于加载时机 |
| 构建灵活性 | 无 | 有（改 define） | 有（改文件） |
| 运行时可见性 | 高 | 中 | 低 |
| debug 难度 | 低 | 中 | 中 |
| 正向 USE_OPENAI 检查处理 | 需逐个改造（第三类不自动收敛） | 自动生效（env 被设真） | 自动生效（env 被设真） |
| 依赖构建系统 | 否 | 是 | 否 |

---

## 三、推荐方案：方案一

### 3.0 执行范围（核心版，2026-07-13 定）

经评审确定**分两批实施**，本批只做核心版：

| 批次 | 步骤 | 内容 | 状态 |
|------|------|------|------|
| **本批（核心版）** | #1~#11、#15 | 安全网（#1~4）+ 功能正确（#10/#11/#15）+ `USE_ANTHROPIC` 逃生舱与 env 管道（#5~9） | **本次执行** |
| 后续批 | #12~#14 | `main.tsx` / `StartupScreen.ts` / `provider.tsx` 三个**展示层**正向检查——纯 UI 显示，不影响连接安全 | **暂缓** |

**为什么这样切分**：核心收益（默认永不误连 Anthropic）由 #1~#4 在"真正发起连接的地方"（`getAPIProvider()` + `client.ts`）保证，结构性成立、不依赖初始化时序；#10/#11/#15 修复默认态下的功能性问题（上下文窗口/输出上限、cache scope、Provider 切换残留）；#5~#9 让 `--provider anthropic` / profile / swarm 转发等逃生舱完整可用。#12~#14 只影响 UI 显示的 provider 名称，改错也不会连错服务，故可延后。

**执行顺序**：#1（地基）→ #2/#3/#4（核心分流/鉴权/校验）→ #10/#11/#15（功能正确）→ #5~#9（env 管道）→ 全量测试并修复因默认值翻转而挂掉的用例。

**三个务必注意的判断点**（详见对应步骤）：
1. **#2 client.ts 最小改动**：只改"分派条件"（`isEnvTruthy(USE_OPENAI)` → 按 `getAPIProvider()` 分流），bedrock/vertex/foundry 的 SDK 构造 + auth 逻辑体**原样保留，不要重写**。
2. **#1 env 透传**：`getYwCoderEnv()` 当前硬读 `process.env`；给 `getAPIProvider(env)` 加 env 参数后，须保证内部 `USE_*` 判断真能读到传入的 `env`（二选一方案见步骤 1）。
3. **#10 别造循环依赖**：必须用"选项 C"把函数搬到 `modelOptions.ts`，不要让 `providerConfig.ts` 反向 import `providers.ts`。

---

### 3.1 推荐理由

1. **覆盖全部 entrypoint（最强理由）**：改在 `getAPIProvider()` 这个所有入口共享的函数里，`cli.tsx` / `grpc` / `bridge` / SDK 全部生效。方案二把默认值设在 `cli.tsx` 启动阶段，`grpc`/`bridge`/`sdk` 这些不走 cli.tsx 的入口拿不到默认值，会退回 Anthropic——这是方案二一个致命硬伤。
2. **代码级保证最彻底**：方案三的 settings.json 可能被覆盖；方案二用 `??=` 设默认值，若有人把 `USE_OPENAI` 误改为 `0` 仍会回退 Anthropic；方案一即使 `USE_OPENAI=0` 也不回退（fallback 恒为 openai），完全对齐"变量被误改/误删/未设置都不连 Anthropic"的原始诉求。
3. **内网部署永远不需要 Anthropic 直连**，方案二的构建灵活性是多余的
4. **运行时语义直观**：看 `providers.ts` 末尾即知默认 provider，不需要追到 `build.ts` 查 MACRO define
5. **方案二的 MACRO 机制有历史风险**：feature flag shim 曾因 Bun 版本升级而整体失效（见 `build.ts` 第 82-89 行注释），如果 MACRO 替换失灵，默认值会悄悄回到 Anthropic

> **代价（务必正视）**：方案一唯一的短板是"第三类正向 `USE_OPENAI` 检查不会自动收敛"（见 1.4 节）。方案二/三因为把 `USE_OPENAI` 环境变量真的设成了 `1`，这些正向检查会自动生效；方案一必须逐个改造 `context.ts`（必修）、`main.tsx`/`StartupScreen.ts`/`provider.tsx`（展示层）。因此**不能只改 10 个文件就收工**——实施第一步必须先 grep 出所有正向检查逐个核实。抽 `isOpenAICompatibleProvider()` helper 复用后，即可兑现"收敛到单一真相源"的目标。

### 3.2 具体实施步骤

> **第 0 步（必做）：全量 grep 正向检查。** 先执行：
> ```bash
> grep -rn "isEnvTruthy(getYwCoderEnv('USE_OPENAI'))\|getYwCoderEnv('USE_OPENAI') ===" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
> ```
> 逐个判定每处"正向 `USE_OPENAI` 检查"在翻转默认后是否仍正确（默认 openai 时该 env 是没设的，正向检查会返回 false）。已知命中（2026-07-12 grep 全量核实，共 11 处正向检查）：`providers.ts`(20)、`client.ts`(179)、`auth.ts`(121/1744)、`providerValidation.ts`(27)、`providerConfig.ts`(348) 已在步骤 1~4/10 覆盖；`context.ts`(98/214，必修)、`main.tsx`(2319)、`StartupScreen.ts`(59)、`provider.tsx`(200) 见步骤 11~14。**建议先在 `providers.ts` 里导出一个 `isOpenAICompatibleProvider()`（内部 `getAPIProvider() !== 'firstParty'`），下面各处统一复用。**
>
> **第 0 步补充：还要 grep "切换 UI 清除 USE_* 的地方"**，确认它们都补上了 `USE_ANTHROPIC` 的清除，否则从 Anthropic 切走会残留：
> ```bash
> grep -rn "delete process.env.YWCODER_USE_\|_USE_OPENAI: undefined\|clearStartupProviderOverride\|clearProviderProfileEnv" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
> ```
> 已知命中：`ProviderManager.tsx`（步骤 15）、`providerProfiles.ts` / `providerProfile.ts`（步骤 8/9）。

1. **`src/utils/model/providers.ts`**
   - `getAPIProvider()` 加可选 `env?: NodeJS.ProcessEnv` 参数（默认 `process.env`），让验证/测试函数可注入自定义 env。内部所有 `getYwCoderEnv('USE_*')` 需能读到传入的 `env`（注意 `getYwCoderEnv` 目前硬读 `process.env`，透传 env 时要么给它加 env 参数、要么在本函数内直接用 `env.YWCODER_USE_* ?? env.CLAUDE_CODE_USE_*`——实施时二选一，保持与 `env` 参数一致）
   - **`isCodexModel()` 加 `env` 参数**（当前是无参、硬读 `process.env`）。现状：
     ```ts
     function isCodexModel(): boolean {
       return shouldUseCodexTransport(
         process.env.OPENAI_MODEL || '',
         process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE,
       )
     }
     ```
     改为：
     ```ts
     function isCodexModel(env: NodeJS.ProcessEnv = process.env): boolean {
       return shouldUseCodexTransport(
         env.OPENAI_MODEL || '',
         env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE,
       )
     }
     ```
     默认仍 `process.env`（向后兼容），但 `getAPIProvider(env)` 须把自己的 `env` 透传进去（`isCodexModel(env)`），避免自定义 env 时 codex 判断读到全局的另一套值。
   - 新增 `env.YWCODER_USE_ANTHROPIC` 检测（**最高优先级**），truthy 时返回 `'firstParty'`。直接用 `env.YWCODER_USE_ANTHROPIC`，不走 `getYwCoderEnv()`（无 `CLAUDE_CODE_*` 旧名需回退）
   - **末尾 fallback 改为 codex-aware**：从字面量 `'firstParty'` 改为 `isCodexModel(env) ? 'codex' : 'openai'`，**不是**简单的 `'openai'`。原因：现状只有 `USE_OPENAI` 分支里做 codex 检测，若兜底写死 `'openai'`，则"不设 `USE_OPENAI` + 用 codex 模型/base URL"会得到 `'openai'`、codex 传输不激活，与"显式 `USE_OPENAI=1`"行为不一致。改成 codex-aware 后，默认路径与显式路径行为完全一致。
     ```ts
     // ...上面各 USE_* 分支不变...
                 : isEnvTruthy(getYwCoderEnv('USE_FOUNDRY'))
                   ? 'foundry'
                   : isCodexModel(env) ? 'codex' : 'openai'   // 原为 'firstParty'
     ```
   - **新增导出 `isOpenAICompatibleProvider(): boolean`**（内部 `return getAPIProvider() !== 'firstParty'`），供 `context.ts`、`main.tsx`、`StartupScreen.ts`、`provider.tsx` 等正向检查点统一复用，避免再散落 `isEnvTruthy(USE_OPENAI)`

2. **`src/services/api/client.ts`**
   - 重构为按 `getAPIProvider()` 分流：
     ```
     providerOverride  → OpenAI shim（agent routing 覆盖，保留在最前面）
     firstParty        → new Anthropic({apiKey, authToken})
     bedrock           → new AnthropicBedrock()
     vertex            → new AnthropicVertex()
     foundry           → new AnthropicFoundry()
     其余(openai/codex/github/gemini) → createOpenAIShimClient()
     ```
   - 不再新增独立的 `isEnvTruthy(USE_ANTHROPIC)` 判断，与 `providers.ts` 永远一致

3. **`src/utils/auth.ts`**
   - `isUsing3PServices()`：改为 `return getAPIProvider() !== 'firstParty'`
   - `isAnthropicAuthEnabled()`：is3P 判断改为 `getAPIProvider() !== 'firstParty'`

4. **`src/utils/providerValidation.ts`（小重构，非仅改触发条件）**
   - **不能只改外层触发条件**：`getProviderValidationError()` 内部有多处基于原始 env 的 `useOpenAI` 判断——第 27 行 `const useOpenAI = isEnvTruthy(env.YWCODER_USE_OPENAI ?? ...)`、第 40 行 `if (useGithub && !useOpenAI)`、第 48 行 `if (!useOpenAI) return null`。默认 openai 但无 env 时 `useOpenAI` 仍是 `false`，函数会在第 48 行提前 `return null`，**根本不会校验 `OPENAI_API_KEY`**，验证场景 #7/#9 会失效。
   - **正确做法**：把第 27 行的 `useOpenAI` 改为从 `getAPIProvider(env)` 推导，例如 `const provider = getAPIProvider(env); const useOpenAI = provider === 'openai' || provider === 'codex'`，后续 codex 分支判断也随之对齐。这样默认 openai（provider 推导为 openai）时才会走到 `OPENAI_API_KEY` 校验分支。
   - 显式选了 Anthropic / Bedrock / Vertex / Foundry / Gemini 时 `getAPIProvider()` 不是 openai/codex，自然跳过。
   - 默认 OpenAI 时如果没配 `OPENAI_BASE_URL`/`OPENAI_API_KEY`，会在启动时报错退出。这是预期行为（代码级保证不回退 Anthropic），需在发布说明中注明。

5. **`src/utils/providerFlag.ts`**
   - `case 'anthropic': process.env.YWCODER_USE_ANTHROPIC = '1'; break`
   - 更新注释：`// Default — no env vars needed` 改为说明 `USE_ANTHROPIC` 的作用
   - 更新文件头注释：`anthropic (default, no-op)` 改为 `anthropic (sets YWCODER_USE_ANTHROPIC=1)`

6. **`src/utils/managedEnvConstants.ts`**
   - `PROVIDER_MANAGED_ENV_VARS`：加入 `YWCODER_USE_ANTHROPIC`
   - `SAFE_ENV_VARS`：也加入 `YWCODER_USE_ANTHROPIC`（与已有的 `USE_BEDROCK`/`USE_FOUNDRY`/`USE_GITHUB`/`USE_VERTEX` 保持一致）

7. **`src/utils/swarm/spawnUtils.ts`**
   - `TEAMMATE_ENV_VARS` 列表加入 `YWCODER_USE_ANTHROPIC`

8. **`src/utils/providerProfiles.ts`**
   - `applyProviderProfileToProcessEnv()`：anthropic provider 时设 `process.env.YWCODER_USE_ANTHROPIC = '1'`
   - `hasProviderSelectionFlags()`：加入 `processEnv.YWCODER_USE_ANTHROPIC !== undefined`
   - `hasConflictingProviderFlagsForProfile()`：非 anthropic profile 冲突检测加入 `processEnv.YWCODER_USE_ANTHROPIC !== undefined`
   - `clearProviderProfileEnvFromProcessEnv()`：加入 `delete processEnv.YWCODER_USE_ANTHROPIC`

9. **`src/utils/providerProfile.ts`**
   - `hasExplicitProviderSelection()`：加入 `processEnv.YWCODER_USE_ANTHROPIC !== undefined`

10. **`getAdditionalModelOptionsCacheScope()`：从 `providerConfig.ts` 搬到 `modelOptions.ts`（避免循环依赖）**
    - **循环依赖风险（2026-07-13 核实）**：若原地让 `providerConfig.ts` 的该函数调 `getAPIProvider()`，会造成 `providers.ts ⇄ providerConfig.ts` 循环 import（`providers.ts` 已 import `providerConfig.ts` 的 `shouldUseCodexTransport`）。两个函数虽都是 hoist 的 `export function`、仅运行时互调，Node ESM 下安全，但经 Bun bundle 后属隐性风险——不值得押在"永不连 Anthropic"的安全保证上。
    - **解法（选项 C，最优）**：把 `getAdditionalModelOptionsCacheScope()` 搬到 `src/utils/model/modelOptions.ts`。该文件已 import `getAPIProvider`（providers.ts）与 `isLocalProviderUrl`/`resolveProviderRequest`（providerConfig.ts），零新增依赖；`providerConfig.ts` 保持"只依赖 envUtils"的叶子状态，环从根上消失。依赖方向始终为 `modelOptions → providers → providerConfig → envUtils` 的 DAG。
    - **函数逻辑**：第一分支改为 `getAPIProvider() === 'firstParty'` 返回 `'firstParty'`，其余 provider 统一走 `resolveProviderRequest()` + `isLocalProviderUrl()`，不再有零散 `!isEnvTruthy(USE_OPENAI)` 分支。bedrock/vertex/foundry 经 `isLocalProviderUrl()` 对远程 URL 返回 false，自然走到 null，行为正确。
    - **连带改 import 指向**：`providerConfig.ts` 删除该函数（内部无自调用，删除干净）；4 个消费者中 `modelOptions.ts` 改为本地调用，`ModelCapabilitiesDoctorSection.tsx`、`commands/model/model.tsx`、`services/api/bootstrap.ts` 的 import 从 `providerConfig.js` 改指向 `modelOptions.js`。
    - **备选（若不想搬函数）**：选项 A 抽 `shouldUseCodexTransport` 及其依赖（`asEnvUrl`/`isCodexBaseUrl`/`isCodexAlias`/`CODEX_ALIAS_MODELS`）成叶子模块打断另一条边——但这些符号深嵌 `resolveProviderRequest` 等核心，手术量大；选项 B 在 `providerConfig.ts` 内用纯 env 判定则会重复 provider 优先级链，引入漂移风险。二者均劣于选项 C。

11. **`src/utils/context.ts`（必修，功能正确性）**
    - `getContextWindowForModel()`（第 98 行）与 `getMaxOutputTokens()`（第 214 行）里 `isEnvTruthy(getYwCoderEnv('USE_OPENAI'))` 的正向分支改为基于 `isOpenAICompatibleProvider()`（即 `getAPIProvider() !== 'firstParty'`）
    - 原因：默认 openai 无 env 时该正向检查返回 false，会回落到 Anthropic 的上下文窗口 / 输出 token 假设（`getMaxOutputTokens` 的注释明写"use known output limits **to avoid 400 errors**"），发到内网网关可能触发 400
    - 注意原分支同时列举了 `USE_GEMINI`/`USE_GITHUB`，改为 `!== 'firstParty'` 后同样覆盖这些 provider，语义一致

12. **`src/main.tsx`（建议，展示层）**
    - 第 2319 行非法 settings 弹窗抑制条件的正向 `USE_OPENAI` 检查改为基于 `getAPIProvider()`。不改的后果仅是 openai 模式下 settings 错误弹窗仍会弹出，非阻断

13. **`src/components/StartupScreen.ts`（建议，展示层）**
    - 第 59 行启动屏 provider 展示的 `getYwCoderEnv('USE_OPENAI') === '1'` 判断改为基于 `getAPIProvider()`，否则默认 openai 时启动屏可能显示成 Anthropic

14. **`src/commands/provider/provider.tsx`（建议，展示层）**
    - 第 200 行 provider 命令显示逻辑的正向 `USE_OPENAI` 检查改为基于 `getAPIProvider()`，保证 `/provider` 命令展示的当前 provider 与实际一致

15. **`src/components/ProviderManager.tsx`（必修，功能正确性）**
    - `clearStartupProviderOverrideFromUserSettings()`（第 262 行）：在清空 `USE_OPENAI/GEMINI/GITHUB/BEDROCK/VERTEX/FOUNDRY`（settings 置 `undefined`）的列表里补上 `YWCODER_USE_ANTHROPIC: undefined`（注意：`USE_ANTHROPIC` 无 `CLAUDE_CODE_*` 变体，不用加旧名）
    - `activateGithubProvider()`（第 297~322 行）：settings 层 env 与 `process.env` 两处都补上 `YWCODER_USE_ANTHROPIC` 的清除（`undefined` / `delete`），与它删除其他 `USE_*` 的写法保持一致
    - 原因：`USE_ANTHROPIC` 在 `getAPIProvider()` 中优先级最高，从 Anthropic 切到其他 provider 若不清除，会残留并强制盖回 firstParty，导致切换静默失效（与场景 #10 同类，只是发生在交互式 UI 路径）
    - 核对：该文件只有 `activateGithubProvider` 一个独立 activate 函数，其余 provider 走"保存 profile → `setActiveProviderProfile` → `clearStartupProviderOverride` + `applyProviderProfileToProcessEnv`"通用路径，由本步与步骤 #8 共同覆盖

### 3.3 验证计划

| # | 场景 | 预期行为 |
|---|------|---------|
| 1 | 不设任何环境变量 | `getAPIProvider()` → `'openai'`；客户端走 OpenAI shim；Anthropic OAuth/keychain 不触发；自动更新被阻止 |
| 2 | `YWCODER_USE_ANTHROPIC=1` | `getAPIProvider()` → `'firstParty'`；走 Anthropic SDK |
| 3 | `YWCODER_USE_OPENAI=1`（显式设） | 行为不变，仍走 OpenAI |
| 4 | `YWCODER_USE_OPENAI=1` + Codex 模型 | `getAPIProvider()` → `'codex'`；验证 Codex 凭证 |
| 4b | **不设** `USE_OPENAI` + Codex 模型/base URL | `getAPIProvider()` → `'codex'`（验证兜底 codex-aware，与场景 4 行为一致，不因省略 `USE_OPENAI` 而退化为 `'openai'`） |
| 5 | `--provider anthropic` | 设 `YWCODER_USE_ANTHROPIC=1`，走 Anthropic；saved profile 不覆盖此选择 |
| 6 | `--provider openai` / `--provider ollama` | 行为不变 |
| 7 | 默认 + 未配 `OPENAI_BASE_URL`/`OPENAI_API_KEY` | `validateProviderEnvOrExit()` 报错退出（预期行为，非回归） |
| 8 | 默认无 env + 有 saved openai profile | `buildStartupEnvFromProfile()` 应用 profile，正常启动 |
| 9 | 默认无 env + 无 profile + 无 key | `validateProviderEnvOrExit()` 报错退出 |
| 10 | anthropic profile 切换到 openai profile | `clearProviderProfileEnvFromProcessEnv()` 清理 `USE_ANTHROPIC`，切换生效 |
| 11 | swarm/tmux 子进程 | `YWCODER_USE_ANTHROPIC` 正确转发到子进程 |
| 12 | 默认无 env，未设 `OPENAI_MODEL` | 默认模型为 `gpt-4o`，发到内网网关。需在发布说明中提醒确认网关接受此模型名 |
| 13 | 默认无 env | `getContextWindowForModel()` / `getMaxOutputTokens()` 走 OpenAI 分支（读网关自报告 contextWindow / OpenAI 输出上限），**不回落到 Anthropic 假设**——验证 context.ts 改造生效 |
| 14 | 默认无 env | `/provider` 命令、启动屏展示的当前 provider 均为 openai，与 `getAPIProvider()` 一致——验证展示层正向检查改造生效 |
| 15 | `/provider` UI 里从 Anthropic 切到 openai/github profile | `USE_ANTHROPIC` 被清除，切换生效；不残留导致盖回 firstParty——验证 ProviderManager 改造生效 |

### 3.4 需更新的测试

> **注意**：以下为静态分析发现的测试。实施前应先跑 `bun test`、`bun run test:provider`、`bun run test:provider-recommendation` 全量测试，把所有因默认值翻转而挂掉的测试全部列出后统一修复。

| 测试文件 | 变更 |
|---------|------|
| `src/utils/model/providers.test.ts` | 默认无 env 期望从 `'firstParty'` 改为 `'openai'`；新增 `USE_ANTHROPIC` 优先级测试 |
| `src/utils/providerFlag.test.ts` | `--provider anthropic` 从"不设置任何变量"改为断言 `YWCODER_USE_ANTHROPIC === '1'` |
| `src/utils/providerProfiles.test.ts` | anthropic profile 测试：断言 `YWCODER_USE_ANTHROPIC` 被设置 |
| `src/utils/auth.test.ts` — 新增 | 默认无 env 时 `isUsing3PServices()` 返回 `true`、`isAnthropicAuthEnabled()` 返回 `false` |
| `src/utils/providerValidation.test.ts` — 新增 | 默认无 env 时 `getProviderValidationError()` 要求 `OPENAI_API_KEY`（或本地 base URL） |
| `src/services/api/withRetry.test.ts` | `setProvider` 辅助函数：清 flag 后默认走 OpenAI rate limit 头解析，需设置 `YWCODER_USE_ANTHROPIC=1` 才能测试 firstParty 行为 |
| `src/utils/apiPreconnect.test.ts` | "fetches in first-party mode" 测试：清 flag 后需显式设 `YWCODER_USE_ANTHROPIC=1` |
| `src/utils/fastMode.test.ts` | 依赖 `getAPIProvider()` 默认返回 `'firstParty'`，需相应调整或设 `USE_ANTHROPIC` |

| `src/utils/context.test.ts` — 关注 | 若有针对 `getContextWindowForModel()` / `getMaxOutputTokens()` 且默认无 env 期望走 Anthropic 分支的用例，需改为期望 OpenAI 分支，或显式设 `YWCODER_USE_ANTHROPIC=1` |

此外可能受影响的文件（实施时通过全量测试确认）：
`src/utils/providerProfile.test.ts`、`src/commands/provider/provider.test.tsx`、`src/utils/model/modelOptions.local.test.ts` 等。

### 3.5 发布说明要点

1. **默认 provider 已改为 OpenAI**：不再需要设置 `YWCODER_USE_OPENAI=1`，系统默认走 OpenAI 协议。如需切回 Anthropic，使用 `--provider anthropic` 或设置 `YWCODER_USE_ANTHROPIC=1`。
2. **默认模型为 `gpt-4o`**：需确认内网 LLM 网关接受此模型名，否则需设置 `OPENAI_MODEL` 环境变量。
3. **启动时需要 OpenAI 凭证**：必须配置 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`（或在本地 Ollama 模式下设为本地地址），否则启动报错退出。
4. **老用户迁移**：如果之前依赖 keychain 中的 Anthropic 凭证或 OAuth 登录，升级后需显式使用 `--provider anthropic` 或 `YWCODER_USE_ANTHROPIC=1`，或配置 OpenAI 网关凭证。
5. **自动更新已阻止**：第三方 provider 模式下不检查、不下载上游 Claude Code 更新。使用 `git pull && bun run build` 手动更新。
