# 构建 Feature Flag 补全计划

**文档版本**: 1.3  
**日期**: 2026-05-08  
**分支**: feature/brand-replacement  
**关联问题**: `Error: Agent type 'explore' not found. Available agents: general-purpose, statusline-setup, claude-code-guide`

---

## 1. 问题背景

`scripts/build.ts` 的 `featureFlags` 对象中只显式声明了 **23 个** flag，其余 flag 均被静默关闭。

> **机制说明**：构建时 `bun:bundle` shim 将 `feature()` 替换为：
> ```ts
> export function feature(name) { return featureFlags[name] ?? false; }
> ```
> 当 `featureFlags` 中不含某个 key 时，`feature(name)` 返回 `false` 而**不报错**。
> 这意味着遗漏的 flag 会被静默关闭，不会在运行时产生任何告警。

源码中 `feature()` 共调用了 **88 个**不同 flag（另有 `BUDDY` 声明在 `featureFlags` 中，但通过 `isBuddyEnabled()` 辅助函数访问，不在 88 个中）。

直接触发 bug 的路径：

```
builtInAgents.ts
└─ areExplorePlanAgentsEnabled()
   └─ feature('BUILTIN_EXPLORE_PLAN_AGENTS')  ← 未声明，返回 false
      └─ EXPLORE_AGENT / PLAN_AGENT 从未注册

AgentTool.tsx:353
└─ throw new Error(`Agent type 'explore' not found. Available agents: ...`)
```

---

## 2. 分析范围与评估维度

| 维度 | 判断标准 |
| --- | --- |
| 实现完整性 | 对应 `.ts` 文件存在且非 stub |
| 二次守卫 | 是否还有 GrowthBook 远程特征值 / env 守卫（即使启用 build flag 也可能无效或可控） |
| 行为变更程度 | 纯增量 UI / 条件性逻辑变更 / 全局架构变更 |
| 外部依赖 | 是否依赖 Anthropic 内部服务 / NAPI 原生模块 |

> **关于 GrowthBook 在开放构建中的行为**：GrowthBook 并非全局禁用——其启用状态取决于用户是否关闭遥测（`!isAnalyticsDisabled()`）。但开放构建用户通常没有有效的 `GROWTHBOOK_CLIENT_KEY`，无法从 Anthropic 服务器加载远程特征值，`getFeatureValue_CACHED_MAY_BE_STALE(key, defaultValue)` 因此返回代码中指定的 `defaultValue`。

---

## 3. build.ts 已声明的 23 个 Flag（现状说明）

> 这 23 个 flag 已在 `featureFlags` 中显式声明，当前值均为 `false`（`BUDDY` 除外）。  
> 注：`BUDDY` 通过 `isBuddyEnabled()` 辅助函数访问，不直接调用 `feature('BUDDY')`，因此不计入 88 个源码 flag 中。

| Flag | 当前值 | 控制的功能 | 关键文件 |
| --- | --- | --- | --- |
| `VOICE_MODE` | false | 语音交互模式（`/voice` 命令 + 配置项） | [commands.ts](../src/commands.ts), [ConfigTool/supportedSettings.ts](../src/tools/ConfigTool/supportedSettings.ts) |
| `PROACTIVE` | false | 主动探索模式（SleepTool + 自动探索触发） | [tools.ts](../src/tools.ts), [commands.ts](../src/commands.ts) |
| `KAIROS` | false | Kairos 完整助手系统（频道/推送/任务/梦境） | [commands.ts](../src/commands.ts), [main.tsx](../src/main.tsx) |
| `BRIDGE_MODE` | false | Bridge 桥接模式（外部 IDE/客户端集成） | [commands.ts](../src/commands.ts) |
| `DAEMON` | false | 后台守护进程模式（`--daemon-worker`） | [commands.ts](../src/commands.ts), [cli.tsx](../src/entrypoints/cli.tsx) |
| `AGENT_TRIGGERS` | false | CronCreate / CronDelete / CronList 定时触发工具 | [tools.ts](../src/tools.ts), [ScheduleCronTool/prompt.ts](../src/tools/ScheduleCronTool/prompt.ts) |
| `MONITOR_TOOL` | false | Monitor 进程监控工具 | [tools.ts](../src/tools.ts), [tasks.ts](../src/tasks.ts) |
| `ABLATION_BASELINE` | false | 消融实验基准模式（内部对照测试） | [cli.tsx](../src/entrypoints/cli.tsx) |
| `DUMP_SYSTEM_PROMPT` | false | `--dump-system-prompt` 调试命令（输出系统提示） | [cli.tsx](../src/entrypoints/cli.tsx) |
| `CACHED_MICROCOMPACT` | false | 缓存加速的微型对话压缩（减少重建开销） | [query.ts](../src/query.ts) |
| `COORDINATOR_MODE` | false | 多 agent 协调器调度模式（worker 角色切换） | [tools.ts](../src/tools.ts), [coordinator/](../src/coordinator/) |
| `CONTEXT_COLLAPSE` | false | 上下文折叠压缩（超大上下文优化） | [setup.ts](../src/setup.ts), [tools.ts](../src/tools.ts) |
| `COMMIT_ATTRIBUTION` | false | Git 提交附加 attribution 信息 | [setup.ts](../src/setup.ts), [utils/worktree.ts](../src/utils/worktree.ts) |
| `TEAMMEM` | false | 多 agent 共享记忆目录（team memdir） | [setup.ts](../src/setup.ts), [memdir/memdir.ts](../src/memdir/memdir.ts) |
| `UDS_INBOX` | false | Unix domain socket 消息收件箱（agent 间通信） | [commands.ts](../src/commands.ts), [setup.ts](../src/setup.ts) |
| `BG_SESSIONS` | false | 后台任务会话摘要 | [main.tsx](../src/main.tsx), [query.ts](../src/query.ts) |
| `AWAY_SUMMARY` | false | 用户离开后返回时显示对话摘要 | [screens/REPL.tsx](../src/screens/REPL.tsx), [hooks/useAwaySummary.ts](../src/hooks/useAwaySummary.ts) |
| `TRANSCRIPT_CLASSIFIER` | false | 自动权限模式分类器（auto-mode 智能判断） | [main.tsx](../src/main.tsx), [utils/permissions/autoModeState.ts](../src/utils/permissions/autoModeState.ts) |
| `WEB_BROWSER_TOOL` | false | 网页浏览工具（依赖 Bun WebView） | [tools.ts](../src/tools.ts), [main.tsx](../src/main.tsx) |
| `MESSAGE_ACTIONS` | false | 消息操作快捷键（复制 / 重新生成 / 编辑） | [keybindings/defaultBindings.ts](../src/keybindings/defaultBindings.ts) |
| `BUDDY` | **true** | `/buddy` AI 配对编程助手（唯一已启用的 flag，通过 `isBuddyEnabled()` 访问） | [commands/buddy/](../src/commands/buddy/), [buddy/](../src/buddy/) |
| `CHICAGO_MCP` | false | macOS 自动 MCP 服务发现与连接 | [main.tsx](../src/main.tsx) |
| `COWORKER_TYPE_TELEMETRY` | false | 协作者类型遥测上报 | [services/analytics/metadata.ts](../src/services/analytics/metadata.ts) |

---

## 4. 未声明的 66 个 Flag 分组说明

以下 66 个 flag 在源码中有 `feature()` 调用，但未在 `build.ts` 中声明，均默认 `false`。

---

### 组 A — 最小修复（1 个）

**直接修复 `explore` agent 缺失 bug，其余不变。**

| Flag | 控制的功能 | 关键文件 |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 将 `EXPLORE_AGENT` 和 `PLAN_AGENT` 注册到 activeAgents | [tools/AgentTool/builtInAgents.ts](../src/tools/AgentTool/builtInAgents.ts), [built-in/exploreAgent.ts](../src/tools/AgentTool/built-in/exploreAgent.ts), [built-in/planAgent.ts](../src/tools/AgentTool/built-in/planAgent.ts) |

**副作用**：无。两个 agent 实现文件完整，仅为增量注册，不改变任何已有代码路径。

---

### 组 B — 安全增量（13 个，本次启用 8 个）

纯新增功能，不改变已有行为，无外部依赖。可与 A 组合并同一 PR。

| Flag | 控制的功能 | 启用状态 | 关键文件 |
| ------------------------------ | ---------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTO_THEME` | 主题跟随系统自动切换（增加 "auto" 选项） | **启用** | [tools/ConfigTool/supportedSettings.ts](../src/tools/ConfigTool/supportedSettings.ts), [design-system/ThemeProvider.tsx](../src/components/design-system/ThemeProvider.tsx) |
| `NATIVE_CLIPBOARD_IMAGE` | 粘贴剪贴板图片到输入框 | **启用** | [utils/imagePaste.ts](../src/utils/imagePaste.ts) |
| `QUICK_SEARCH` | 快捷键唤起内联搜索 | **启用** | [keybindings/defaultBindings.ts](../src/keybindings/defaultBindings.ts), [PromptInput/PromptInput.tsx](../src/components/PromptInput/PromptInput.tsx) |
| `HISTORY_PICKER` | 输入框历史消息选择 UI | **启用** | [components/PromptInput/PromptInput.tsx](../src/components/PromptInput/PromptInput.tsx) |
| `MCP_RICH_OUTPUT` | MCP 工具结果富文本渲染 | **启用** | [tools/MCPTool/UI.tsx](../src/tools/MCPTool/UI.tsx) |
| `COMPACTION_REMINDERS` | 上下文压缩操作提示消息 | **启用** | [utils/attachments.ts](../src/utils/attachments.ts) |
| `POWERSHELL_AUTO_MODE` | Windows PowerShell 自动提示文本 | **启用** | [utils/permissions/yoloClassifier.ts](../src/utils/permissions/yoloClassifier.ts) |
| `HOOK_PROMPTS` | 允许 hook 进程通过 stdout 发出 PromptRequest，向用户弹出确认对话框；hook 执行期间 stdin 保持开放以接收用户回复 | **启用** | [screens/REPL.tsx](../src/screens/REPL.tsx), [utils/hooks.ts](../src/utils/hooks.ts) |
| `STREAMLINED_OUTPUT` | `--print` headless 模式精简 CLI 输出 | **暂不启用** | [cli/print.ts](../src/cli/print.ts) |
| `PROMPT_CACHE_BREAK_DETECTION` | 检测 prompt cache 断裂（仅记录日志） | **暂不启用** | [tools/AgentTool/runAgent.ts](../src/tools/AgentTool/runAgent.ts), [services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts) |
| `TOKEN_BUDGET` | Token 用量追踪与提示（仅用户在输入中指定 token 目标时生效） | **暂不启用** | [query.ts](../src/query.ts), [utils/tokenBudget.ts](../src/utils/tokenBudget.ts), [constants/prompts.ts](../src/constants/prompts.ts) |
| `BUILDING_CLAUDE_APPS` | 注册 Claude API 开发专用 skill | **暂不启用** | [skills/bundled/claudeApi.ts](../src/skills/bundled/claudeApi.ts), [skills/bundled/index.ts](../src/skills/bundled/index.ts) |
| `NEW_INIT` | 新版 `/init` 提示词（**双重守卫**：还需 `CLAUDE_CODE_NEW_INIT=1` 或 `USER_TYPE=ant`，否则行为与原来完全相同） | **暂不启用** | [commands/init.ts](../src/commands/init.ts) |

> **暂不启用原因**：
> - `STREAMLINED_OUTPUT`：用户明确不需要启用该 flag。
> - `PROMPT_CACHE_BREAK_DETECTION`：内网模型不支持 Anthropic prompt caching，该检测无实际意义。
> - `TOKEN_BUDGET`：用户决定暂时不启用，后续评估后再决定。
> - `BUILDING_CLAUDE_APPS`：内网环境不连接 Claude API，注册该 skill 无实际用途。
> - `NEW_INIT`：该功能尚未对外部用户开放，暂不启用。

---

### 组 C — 有价值但需单独评估（6 个）

有二次守卫或存在有限的行为变更，建议 A+B 稳定后独立 PR 引入并冒烟测试。

| Flag | 控制的功能 | 二次守卫 / 限制条件 | 关键文件 |
| --------------------------- | -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `REACTIVE_COMPACT` | 响应式自动压缩（按需触发而非定时） | GB `tengu_cobalt_raccoon` 默认 `false`；启用 build flag 仅改变 UI buffer 显示，不激活压缩逻辑 | [utils/analyzeContext.ts](../src/utils/analyzeContext.ts), [commands/compact/compact.ts](../src/commands/compact/compact.ts) |
| `ULTRATHINK` | 关键词 "ultrathink" 触发扩展推理 | GB `tengu_turtle_carbon` 默认 `true`；openaiShim 已处理 thinking block 降级 | [utils/thinking.ts](../src/utils/thinking.ts) |
| `AGENT_MEMORY_SNAPSHOT` | 自定义 agent 记忆快照（会话后写入文件） | 仅对 `isCustomAgent()` 且有 `memory` 属性的 agent 生效 | [tools/AgentTool/loadAgentsDir.ts](../src/tools/AgentTool/loadAgentsDir.ts), [main.tsx](../src/main.tsx) |
| `EXPERIMENTAL_SKILL_SEARCH` | query 启动时预加载 skill 索引 | 名称含 "Experimental"，增加首次 query 轻微延迟 | [query.ts](../src/query.ts), [tools/SkillTool/SkillTool.ts](../src/tools/SkillTool/SkillTool.ts) |
| `MCP_SKILLS` | 从 MCP 服务器加载 skill 定义 | 不支持 skills 的 MCP 服务器会优雅跳过 | [services/mcp/useManageMCPConnections.ts](../src/services/mcp/useManageMCPConnections.ts), [skills/mcpSkills.ts](../src/skills/mcpSkills.ts) |
| `BREAK_CACHE_COMMAND` | 向 context 注入 `<break-cache/>` 标记 | 对不支持 prompt cache 的 provider 仅为额外文本 | [context.ts](../src/context.ts) |

---

### 组 D1 — 实现文件缺失或明确 stub（9 个）

| Flag | 控制的功能 | 不启用原因 |
| ------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASH_CLASSIFIER` | Bash 命令权限智能分类器 | [utils/permissions/bashClassifier.ts](../src/utils/permissions/bashClassifier.ts) 第 1 行明确注释：**Stub for external builds - classifier permissions feature is internal-only** |
| `HISTORY_SNIP` | 对话历史智能截断压缩 | 依赖 `services/compact/snipProjection.ts`，**文件不存在**（已验证） |
| `WORKFLOW_SCRIPTS` | 工作流脚本工具（`/workflow` 命令） | 依赖 `tools/WorkflowTool/bundled/index.js`，**目录不存在**（已验证，仅存 constants.ts） |
| `REVIEW_ARTIFACT` | 代码审查制品工具 | 依赖 `tools/ReviewArtifactTool/` 目录，**不存在**（已验证） |
| `RUN_SKILL_GENERATOR` | 运行时 skill 生成器 | 依赖 `skills/bundled/runSkillGenerator.js`，**文件不存在** |
| `TEMPLATES` | 任务模板分类器与模板加载 | `cli/handlers/templateJobs.js` 在 build.ts 中被**显式 stub**：`throw new Error("Template jobs are unavailable in the open build.")` |
| `VERIFICATION_AGENT` | 独立验证 agent（核查任务结果） | build flag 为必要条件但非充分条件。GrowthBook 远程特征值 `tengu_hive_evidence` 默认 `false`（开放构建用户无法加载远程特征，回落到 defaultValue），因此即使 build flag 为 `true`，该 agent 仍不会被注册 |
| `TREE_SITTER_BASH` | tree-sitter 精确 Bash AST 解析（主路径） | 依赖 NAPI 原生模块，开放构建未捆绑该二进制；虽有优雅降级，功能无法激活 |
| `TREE_SITTER_BASH_SHADOW` | tree-sitter Bash 解析（影子对照实验） | 同上 |

---

### 组 D2 — 架构变更风险（3 个）

启用后对核心流程有全局性破坏性影响。

| Flag | 控制的功能 | 不启用原因 | 关键文件 |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FORK_SUBAGENT` | 继承父上下文的 fork 子 agent | **强制所有 agent spawn 变为异步**；同时从 Agent 工具 schema 中移除 `run_in_background` 参数，破坏依赖同步 agent 的工作流 | [tools/AgentTool/forkSubagent.ts](../src/tools/AgentTool/forkSubagent.ts), [tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx) |
| `ULTRAPLAN` | 关键词 "ultraplan" 路由到 `/ultraplan` skill | `/ultraplan` skill 不在 bundled skills 中，触发后报 "Unknown skill"（源码注释已记录此问题） | [utils/processUserInput/processUserInput.ts](../src/utils/processUserInput/processUserInput.ts), [utils/ultraplan/keyword.ts](../src/utils/ultraplan/keyword.ts) |
| `EXTRACT_MEMORIES` | 后台自动提取会话记忆 | 每次会话结束自动调用 `queryModelWithoutStreaming` 提取记忆，产生额外 API 调用和 token 消耗 | [utils/backgroundHousekeeping.ts](../src/utils/backgroundHousekeeping.ts), [services/extractMemories/extractMemories.ts](../src/services/extractMemories/extractMemories.ts) |

---

### 组 D3 — Anthropic 内部基础设施（18 个）

依赖 Anthropic 内部服务或私有协议，开放构建无法使用。

| Flag | 控制的功能 | 关键文件 |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `LODESTONE` | 内部 Lodestone 服务集成 | [main.tsx](../src/main.tsx) |
| `DIRECT_CONNECT` | 直连模式（内部网络直连） | [main.tsx](../src/main.tsx) |
| `CCR_AUTO_CONNECT` | Claude Code Remote 自动连接 | [bridge/bridgeEnabled.ts](../src/bridge/bridgeEnabled.ts) |
| `CCR_MIRROR` | CCR 会话镜像同步 | [main.tsx](../src/main.tsx) |
| `CCR_REMOTE_SETUP` | CCR 远程设置命令（`/web`） | [commands.ts](../src/commands.ts) |
| `SSH_REMOTE` | SSH 远程连接模式 | [main.tsx](../src/main.tsx) |
| `BYOC_ENVIRONMENT_RUNNER` | BYOC 自定义环境运行器 | [cli.tsx](../src/entrypoints/cli.tsx) |
| `SELF_HOSTED_RUNNER` | 自托管运行器（内部 CI 基础设施） | [cli.tsx](../src/entrypoints/cli.tsx) |
| `TORCH` | Torch 内部工具集 | [commands.ts](../src/commands.ts) |
| `NATIVE_CLIENT_ATTESTATION` | 客户端签名认证（内部安全机制） | [constants/system.ts](../src/constants/system.ts) |
| `DOWNLOAD_USER_SETTINGS` | 从 Anthropic 服务器同步下载用户设置 | [cli/print.ts](../src/cli/print.ts) |
| `UPLOAD_USER_SETTINGS` | 向 Anthropic 服务器同步上传用户设置 | [main.tsx](../src/main.tsx) |
| `ANTI_DISTILLATION_CC` | 反蒸馏保护措施（API 请求头） | [services/api/claude.ts](../src/services/api/claude.ts) |
| `ENHANCED_TELEMETRY_BETA` | 增强会话追踪遥测（内部数据收集） | [utils/telemetry/sessionTracing.ts](../src/utils/telemetry/sessionTracing.ts) |
| `PERFETTO_TRACING` | Perfetto 性能追踪（内部 profiling） | [utils/telemetry/perfettoTracing.ts](../src/utils/telemetry/perfettoTracing.ts) |
| `TERMINAL_PANEL` | 终端面板截图捕获工具 | [tools.ts](../src/tools.ts) |
| `AGENT_TRIGGERS_REMOTE` | 远程触发工具（RemoteTriggerTool） | [tools.ts](../src/tools.ts) |
| `CONNECTOR_TEXT` | `summarize_connector_text` API beta header | [constants/betas.ts](../src/constants/betas.ts) |

---

### 组 D4 — Kairos 子功能（5 个）

均依赖父 flag `KAIROS`（已声明为 false），独立启用也无实际效果。

| Flag | 控制的功能 | 关键文件 |
| -------------------------- | ------------------- | --------------------------------------------------------- |
| `KAIROS_BRIEF` | Kairos 简报功能 | [commands.ts](../src/commands.ts) |
| `KAIROS_CHANNELS` | Kairos 频道监听 | [main.tsx](../src/main.tsx) |
| `KAIROS_DREAM` | Kairos 梦境（记忆整合后台任务） | [skills/bundled/index.ts](../src/skills/bundled/index.ts) |
| `KAIROS_GITHUB_WEBHOOKS` | Kairos GitHub PR 订阅 | [commands.ts](../src/commands.ts) |
| `KAIROS_PUSH_NOTIFICATION` | Kairos 推送通知工具 | [tools.ts](../src/tools.ts) |

---

### 组 D5 — 纯调试 / 测试 / 遥测（11 个）

无用户价值、仅用于内部数据收集，或需额外 env 显式开启。

| Flag | 控制的功能 | 关键文件 |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `SHOT_STATS` | 多轮对话 shot 分布统计 | [utils/stats.ts](../src/utils/stats.ts) |
| `MEMORY_SHAPE_TELEMETRY` | 记忆查询形状遥测上报 | [memdir/findRelevantMemories.ts](../src/memdir/findRelevantMemories.ts) |
| `SLOW_OPERATION_LOGGING` | 慢操作详细日志（内部格式） | [utils/slowOperations.ts](../src/utils/slowOperations.ts) |
| `HARD_FAIL` | 严格错误模式（未捕获异常直接崩溃） | [main.tsx](../src/main.tsx) |
| `OVERFLOW_TEST_TOOL` | 上下文溢出测试工具 | [tools.ts](../src/tools.ts) |
| `ALLOW_TEST_VERSIONS` | 允许安装 `99.99.x` 测试版本 | [utils/nativeInstaller/download.ts](../src/utils/nativeInstaller/download.ts) |
| `SKILL_IMPROVEMENT` | Hook 触发时调用 API 自动优化 skill（后台 API 调用） | [utils/hooks/skillImprovement.ts](../src/utils/hooks/skillImprovement.ts) |
| `IS_LIBC_GLIBC` | Linux glibc 环境标记（特定 Linux 构建用） | [utils/envDynamic.ts](../src/utils/envDynamic.ts) |
| `IS_LIBC_MUSL` | Linux musl 环境标记（Alpine 等 musl 构建用） | [utils/envDynamic.ts](../src/utils/envDynamic.ts) |
| `FILE_PERSISTENCE` | `--print` 模式将工具输出持久化到磁盘文件 | [cli/print.ts](../src/cli/print.ts), [utils/filePersistence/filePersistence.ts](../src/utils/filePersistence/filePersistence.ts) |
| `UNATTENDED_RETRY` | 无人值守模式下的持久化重试（**双重守卫**：还需 `CLAUDE_CODE_UNATTENDED_RETRY=1`） | [services/api/withRetry.ts](../src/services/api/withRetry.ts) |

---

## 5. 变更清单（最小安全变更）

**建议分两步执行，只修改一个文件：[scripts/build.ts](../scripts/build.ts)**

### Step 1 — 直接修复（A 组，1 行）

```ts
// scripts/build.ts，featureFlags 对象中添加：
BUILTIN_EXPLORE_PLAN_AGENTS: true,
```

**验证方式**：

#### Step 1 手工冒烟测试明细

| # | Flag | 使用方式 | 验证方法 | 用户价值 |
|---|---|---|---|---|
| 1 | `BUILTIN_EXPLORE_PLAN_AGENTS` | 在对话中让模型使用 explore/plan agent，例如说 `"请帮我探索这个代码库"` 或 `"帮我制定一个实现方案"` | 模型能正常调用 `Agent(subagent_type="explore")` 或 `Agent(subagent_type="plan")`，不抛出 `Agent type 'explore' not found` 错误，且能返回探索结果或计划文档 | 支持代码库自动探索和任务规划，无需手动浏览文件 |

#### Step 1 回归测试（自动化）

```bash
# 1. 构建与启动验证
bun run build && bun run smoke

# 2. 在交互中验证 agent 注册
ywcoder
# 然后输入：请使用 explore agent 帮我看看 src/utils/ 目录下有哪些工具函数
# 观察是否成功调用 explore agent 并返回结果
```

---

### Step 2 — 安全增量（B 组，8 行，与 Step 1 同 PR）

```ts
// 纯 UI 增量，无行为变更
AUTO_THEME: true,
NATIVE_CLIPBOARD_IMAGE: true,
QUICK_SEARCH: true,
HISTORY_PICKER: true,
MCP_RICH_OUTPUT: true,
COMPACTION_REMINDERS: true,
POWERSHELL_AUTO_MODE: true,
// 有二次守卫或条件触发，实际激活依赖用户操作
HOOK_PROMPTS: true,
```

**验证方式**：
1. `bun test --max-concurrency=1` — 回归测试（注意：UI flag 单测覆盖不到，需手动验证）
2. 确认 `dist/cli.mjs` 构建产物无异常体积增长（新增 flag 的死代码消除应维持或减小）

---

#### Step 2 手工冒烟测试明细

> 以下 8 个 flag 均为增量功能，启用后不会破坏已有行为，但需手动验证是否正常工作。

| # | Flag | 使用方式 | 验证方法 | 用户价值 |
|---|---|---|---|---|
| 1 | `AUTO_THEME` | 输入 `/config theme`，查看选项列表 | 选项列表中出现 `"auto"`（跟随终端），切换后终端主题变化时 ywcoder 主题自动同步 | 无需手动切换明暗主题，自动适配终端/系统偏好 |
| 2 | `NATIVE_CLIPBOARD_IMAGE` | 在终端中按 `Cmd+V`（mac）/`Ctrl+V`（win/linux）粘贴剪贴板图片 | 输入框出现图片占位符或上传提示，模型能识别图片内容 | 直接粘贴截图到对话中，无需先保存为文件 |
| 3 | `QUICK_SEARCH` | 在 ywcoder 交互界面按 `Ctrl+K`（默认绑定） | 屏幕底部弹出内联搜索框，可搜索对话历史或文件 | 快速定位历史消息或文件，无需滚动查找 |
| 4 | `HISTORY_PICKER` | 在输入框按 `↑` 方向键 | 弹出历史消息选择列表，可选中后复用 | 快速复用之前发送过的提示词 |
| 5 | `MCP_RICH_OUTPUT` | 使用任意 MCP 工具（如文件读取、代码搜索） | 工具返回结果带格式高亮、表格、折叠块等富文本样式，而非纯文本 | MCP 结果更易读，代码块带语法高亮 |
| 6 | `COMPACTION_REMINDERS` | 持续对话直到上下文接近压缩阈值 | 屏幕底部出现提示 `"正在压缩上下文以节省 token..."` 等文案 | 用户明确知道正在发生压缩，避免对丢上下文感到困惑 |
| 7 | `POWERSHELL_AUTO_MODE` | 在 Windows 环境使用 auto-mode（yolo 模式），让模型执行 PowerShell 命令 | 模型在 PowerShell 相关命令的 deny 判断上更准确，减少误拦截 | Windows 用户 auto-mode 体验更流畅 |
| 8 | `HOOK_PROMPTS` | 配置 `.claude/settings.json` 中 `type: "prompt"` 的 hook，触发后 hook 脚本通过 stdout 输出 `PromptRequest` | ywcoder 弹出确认对话框，用户输入回复后 hook 能接收 | hook 系统可向用户主动发起交互式提问 |

---

#### Step 2 回归测试（自动化）

```bash
# 1. 构建验证
bun run build && bun run smoke

# 2. 单元测试回归
bun test --max-concurrency=1

# 3. 产物体积检查（应与启用前基本持平或更小，死代码消除会移除未使用 flag 的分支）
ls -lh dist/cli.mjs
```

---

### Step 3 — C 组（独立 PR，需冒烟测试后决策）

`REACTIVE_COMPACT` / `ULTRATHINK` / `AGENT_MEMORY_SNAPSHOT` /  
`EXPERIMENTAL_SKILL_SEARCH` / `MCP_SKILLS` / `BREAK_CACHE_COMMAND`

建议 Step 2 合并、线上稳定后，每个独立 PR 验证。

---

## 6. 不在本次变更范围内

- D1—D5 所有 flag（原因见第 4 节各组）
- C 组 flag（延后独立评估）
- 构建脚本其他逻辑（stubModules / MACRO 常量等）

---

## 7. Flag 数量汇总

| 分组 | flag 数量 | 处置 |
| ------------------------ | ------- | ------------------------- |
| 已声明（build.ts 现有，含 BUDDY） | 23 | 维持现状（BUDDY=true 为唯一启用项） |
| A 组：最小修复 | 1 | **Step 1 启用** |
| B 组：安全增量 | 8 | **Step 2 启用** |
| B 组：安全增量（本次暂不启用） | 5 | 后续评估后再决定 |
| C 组：有限变更 | 6 | Step 3 独立 PR |
| D1：缺失实现 / stub | 9 | 永不启用 |
| D2：架构变更风险 | 3 | 永不启用 |
| D3：内部基础设施 | 18 | 永不启用 |
| D4：Kairos 子功能 | 5 | 永不启用（父 flag 已禁用） |
| D5：调试 / 测试 / 遥测 | 11 | 永不启用 |
| **源码 feature() 调用合计** | **88** |  |
| **build.ts 声明合计** | **23** | 含 BUDDY（不在 88 个源码 flag 中） |
| **未声明的源码 flag** | **66** | = 88 − 22（已声明且在源码中出现的） |

---

## 8. 执行结果总结

| 检查项 | 结果 | 备注 |
| --- | --- | --- |
| `bun install` | 成功 | 429 个包已安装 |
| `bun run build` | 成功 | `✓ Built ywcoder v1.0.1 → dist/cli.mjs` |
| `bun run smoke` | 成功 | 版本输出 `v1.0.1 (YwCoder)` |
| 构建产物体积 | 18 MB | 与预期一致，无异常增长 |
| `bun test --max-concurrency=1` | 529 pass / 1 fail | 失败为已知 flaky test（`osc.test.ts`），单独运行全过，与本次修改无关 |
| 变更文件数 | 1 个 | 仅 `scripts/build.ts` |

**结论**：本次修改安全通过，构建和回归测试均正常。唯一的测试失败是已有 flaky test，不在本次修复范围内。

---

## 附录：审查意见处置记录

### v1.1 → v1.2

| 审查意见 | 结论 | 处置 |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| flag 数量应为 89 | **部分采纳**：重新验证后实际为 88，审查者数字也不准确 | 修正为 88，说明 BUDDY 不在源码 feature() 调用中 |
| 三个"文件不存在"声明需验证 | **不采纳**：已重新执行 find 验证，原始声明全部正确 | 在 D1 表格中增加"（已验证）"标注 |
| VERIFICATION_AGENT 描述不精确 | **部分采纳**：结论正确，但"GrowthBook 全局禁用"说法有误 | 修正为"GrowthBook 无法加载远程特征，回落 defaultValue=false" |
| HOOK_PROMPTS 的 OMC 依赖说法无依据 | **采纳**：该描述确实过于主观 | 改为描述其实际行为（hook 进程发出 PromptRequest） |
| 补充 feature() 回退行为说明 | **采纳** | 在第 1 节增加机制说明框 |
| 补充 Step 2 验证方式 | **采纳** | 增加手动冒烟测试项和构建产物体积检查 |
| 文档遗漏 3 个 flag | **自查发现**：FILE_PERSISTENCE / TEMPLATES / UNATTENDED_RETRY 未分类 | 补入 D1（TEMPLATES）和 D5（FILE_PERSISTENCE / UNATTENDED_RETRY） |

### v1.2 → v1.3

| 变更项 | 处置 |
| ------------------------ | ------------------- |
| `TOKEN_BUDGET` 从启用改为暂不启用 | 用户决定暂时不启用，后续评估后再决定 |
| 在 B 组表格中增加"启用状态"列 | 区分"本次启用"与"本次暂不启用" |
| 更新 Step 2 代码块（13 → 8 个） | 仅保留确认启用的 flag |
| 更新 Flag 数量汇总表 | 增加"B 组：安全增量（本次暂不启用） | 5"分类 |
