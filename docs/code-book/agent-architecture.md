# Agent 工程架构深度解析

> 本文档是对 ywcoder-cli (OpenClaude) 代码库 Agent 架构的系统性分析，旨在帮助开发者快速建立对整体设计的认知框架。

---

## 目录

- [一、推荐阅读路线](#一推荐阅读路线)
- [二、核心设计思想](#二核心设计思想)
- [三、第 1 层：核心循环](#三第-1-层核心循环--一次对话怎么跑起来)
- [四、第 2 层：工具系统](#四第-2-层工具系统--工具怎么注册怎么调度)
- [五、第 3 层：Agent 系统](#五第-3-层agent-系统--子-agent-怎么生出来怎么跑)
- [六、第 4 层：上下文 + 任务 + 协调](#六第-4-层上下文--任务--协调)
- [七、第 5 层：API 层 + 扩展机制](#七第-5-层api-层--扩展机制)
- [八、第 4.5 层：记忆架构](#八第-45-层记忆架构--agent-怎么跨会话记住东西)
- [九、关键模块详解](#九关键模块详解)
- [十、架构全景图](#十架构全景图)
- [十一、实操建议](#十一实操建议)

---

## 一、推荐阅读路线

代码库有 2000+ 个源文件，不建议无序浏览。以下是一条**由内而外、层层递进**的阅读路线，共 5 层 20 个关键文件：

### 第 1 层：核心循环（先搞清"一次对话怎么跑起来"）

| 顺序 | 文件 | 要理解的问题 |
|------|------|-------------|
| 1 | `src/main.tsx` | 应用入口，整个主循环如何编排 |
| 2 | `src/query.ts` (~1726行) | Query 状态机：用户输入 → 调 LLM → 解析 tool_use → 执行工具 → 回传结果 → 循环 |
| 3 | `src/QueryEngine.ts` (~1309行) | Query 的上层编排器，管理 token 预算、auto-compact、系统提示拼装 |

### 第 2 层：工具系统（"工具怎么注册、怎么调度"）

| 顺序 | 文件 | 要理解的问题 |
|------|------|-------------|
| 4 | `src/Tool.ts` (~802行) | Tool 的类型定义：name、inputSchema、execute()、权限检查 |
| 5 | `src/tools.ts` (~389行) | 工具注册表工厂：~50 个工具通过 feature flag 按需组装 |
| 6 | `src/services/tools/toolExecution.ts` | 工具执行管线：权限检查 → schema 校验 → execute() → 结果截断 |
| 7 | `src/services/tools/StreamingToolExecutor.ts` | 流式工具执行器，处理并发工具调用 |

### 第 3 层：Agent 系统（"子 Agent 怎么生出来、怎么跑"）

| 顺序 | 文件 | 要理解的问题 |
|------|------|-------------|
| 8 | `src/tools/AgentTool/AgentTool.tsx` | AgentTool 是关键入口：LLM 调用 Agent 工具 → 创建子对话循环 |
| 9 | `src/tools/AgentTool/runAgent.ts` | Agent 执行引擎：为子 Agent 组装上下文、跑独立 query loop |
| 10 | `src/tools/AgentTool/loadAgentsDir.ts` | Agent 定义发现：内置 + 用户自定义 agent，通过 frontmatter 描述能力 |
| 11 | `src/tools/AgentTool/built-in/` 目录 | 内置 agent 定义：generalPurpose、plan、explore、verification、claudeCodeGuide |
| 12 | `src/tools/AgentTool/forkSubagent.ts` | 子 Agent 的上下文隔离：克隆 AppState、FileCache、权限，独立 AbortController |

### 第 4 层：上下文 + 任务 + 协调

| 顺序 | 文件 | 要理解的问题 |
|------|------|-------------|
| 13 | `src/context.ts` | 系统上下文拼装：git 状态、CLAUDE.md 内存、日期等 |
| 14 | `src/Task.ts` + `src/tasks/` | 任务系统：7 种任务类型，统一生命周期管理 |
| 15 | `src/tools/shared/spawnMultiAgent.ts` | 多 Agent 编排：TeamCreate、进程内/tmux/远程三种 spawn 模式 |
| 16 | `src/coordinator/coordinatorMode.ts` | Coordinator 模式：Leader 进程 spawn Worker，Worker 拥有受限工具集 |

### 第 4.5 层：记忆架构（"Agent 怎么跨会话记住东西"）

| 顺序 | 文件 | 要理解的问题 |
|------|------|-------------|
| 16.1 | `src/utils/claudemd.ts` | 指令记忆：4 级 CLAUDE.md 发现与加载机制，`@include` 指令 |
| 16.2 | `src/memdir/memdir.ts` | Auto Memory 提示词构建：MEMORY.md 索引、截断策略 |
| 16.3 | `src/memdir/paths.ts` | 记忆目录解析：路径安全校验、多来源优先级 |
| 16.4 | `src/memdir/memoryTypes.ts` | 4 种记忆类型分类法：user / feedback / project / reference |
| 16.5 | `src/memdir/findRelevantMemories.ts` | 智能召回：用 Sonnet 做语义检索，按相关性选择记忆 |
| 16.6 | `src/memdir/memoryScan.ts` | 记忆扫描：读 frontmatter、排序、上限 200 条 |
| 16.7 | `src/services/extractMemories/extractMemories.ts` | 自动提取：会话结束时 fork Agent 提取持久化记忆 |
| 16.8 | `src/tools/AgentTool/agentMemory.ts` | Agent 专属记忆：per-agent 三级作用域（user/project/local） |
| 16.9 | `src/memdir/teamMemPaths.ts` + `teamMemPrompts.ts` | 团队记忆：多人共享的记忆空间 |

### 第 5 层：API 层 + 扩展机制

| 顺序 | 文件 | 要理解的问题 |
|------|------|-------------|
| 17 | `src/services/api/claude.ts` | Claude API 客户端：流式响应、重试、fallback |
| 18 | `src/services/api/openaiShim.ts` | OpenAI 兼容层：让 Ollama/GPT/Gemini 都走统一接口 |
| 19 | `src/commands.ts` + `src/commands/` | 斜杠命令系统 |
| 20 | `src/services/mcp/` | MCP Server 连接：动态发现外部工具 |

---

## 二、核心设计思想

**一句话概括**：这是一个**递归式、工具驱动的多 Agent 框架**。

核心是 tool-use 对话循环，Agent 本身也是 Tool，通过上下文克隆+隔离实现层级递归，通过 Task 系统管理异步生命周期，通过 Coordinator 模式支持规模化多 Agent 协作。

### 设计原则

1. **统一工具抽象**：无论是读文件、跑 bash、还是启动子 Agent，对 LLM 来说都是同一种 tool_use 协议
2. **Agent 即 Tool**：子 Agent 通过 AgentTool 启动，对父 Agent 来说就是一次工具调用
3. **上下文隔离与继承**：子 Agent 克隆父 Agent 的状态，但拥有独立的对话循环和 AbortController
4. **递归组合**：Agent 可以 spawn Agent，理论上无限嵌套
5. **编译期裁剪**：通过 `feature()` 宏在构建时按需组装工具集，减小产物体积

---

## 三、第 1 层：核心循环 — "一次对话怎么跑起来"

### 3.1 主入口 `src/main.tsx`

应用入口，负责：
- 初始化 AppState（全局状态）
- 组装工具集、命令集、Agent 定义
- 启动主对话循环
- 处理用户输入/输出的渲染（React/Ink 终端 UI）

### 3.2 Query 状态机 `src/query.ts`

这是整个系统的**心脏**。一次完整的 query 流程：

```
query()
├── buildQueryConfig()       — 快照当前配置
├── buildSystemPrompt()      — 拼装系统提示词
├── normalizeMessages()      — 转换为 API 格式
├── callModel()              — 调 LLM API（流式）
├── StreamingToolExecutor.executeTools()
│   ├── matchToolCalls()     — 按名称找到工具
│   ├── validateInput()      — Zod schema 校验
│   ├── handlePermissions()  — 权限检查（必要时问用户）
│   └── tool.execute()       — 执行工具
├── applyToolResultBudget()  — 截断过大的结果
├── autoCompactIfNeeded()    — token 超预算时压缩历史
└── yield 循环直到 stop_reason="end_turn"
```

**关键概念**：
- LLM 返回 `tool_use` block（包含工具名 + 参数）
- 宿主进程执行工具，把结果作为 `tool_result` block 喂回 LLM
- 循环往复，直到 LLM 决定 `end_turn`（即不再需要调工具）

### 3.3 Query 编排器 `src/QueryEngine.ts`

在 query.ts 之上的编排层，负责：
- Token 预算管理（`tokenBudget.ts`）
- 自动压缩（auto-compact / micro-compact）
- 系统提示词注入与缓存
- Stop reason 处理（`stopHooks.ts`）

---

## 四、第 2 层：工具系统 — "工具怎么注册、怎么调度"

### 4.1 Tool 类型定义 `src/Tool.ts`

```typescript
Tool (基础接口)
├── name: string                              // 工具名称
├── description: string                       // 描述（LLM 用来决定是否调用）
├── inputSchema: JSONSchema                   // 输入参数 schema
├── execute(input, context) → ToolResult<T>   // 执行函数
├── getActivityDescription?(input) → string   // 进度描述（UI 用）
└── validate?(input) → ValidationResult       // 额外校验
```

### 4.2 工具注册表 `src/tools.ts`

~50 个工具通过 `assembleToolPool()` 函数按需组装：

**工具分类**：

| 类别 | 工具示例 |
|------|---------|
| 核心工具 | Bash, FileRead, FileWrite, FileEdit, Glob, Grep, REPL |
| Agent 工具 | AgentTool, SkillTool, SendMessageTool, TeamCreateTool |
| 任务工具 | TaskCreate, TaskList, TaskGet, TaskUpdate, TaskOutput |
| API 工具 | WebSearch, WebFetch, MCPTool, ReadMcpResource |
| 工作区工具 | EnterWorktreeTool, ExitWorktreeTool |
| 计划工具 | EnterPlanModeTool, ExitPlanModeTool |

关键机制：
- **feature() 宏**：Bun 编译期特性门控，未开启的工具在构建时被裁剪
- **懒加载**：部分工具（如 TeamCreate/TeamDelete）使用 lazy require 打破循环依赖
- **动态组装**：AgentTool 调用 `assembleToolPool()` 为子 Agent 定制工具集

### 4.3 工具执行管线 `src/services/tools/toolExecution.ts`

```
LLM 返回 tool_use block
       │
       ▼
findToolByName()        — 从工具池匹配工具
       │
       ▼
canUseTool()            — 权限检查（deny rules / always-ask rules）
       │
       ▼
validateInput()         — Zod schema 校验
       │
       ▼
tool.execute(input, context)  — 执行
       │
       ▼
applyToolResultBudget() — 结果截断（防止 token 爆炸）
       │
       ▼
返回 tool_result block 给 LLM
```

### 4.4 ToolUseContext — 工具执行上下文

每个工具执行时都会收到一个 `ToolUseContext`：

```typescript
ToolUseContext
├── options
│   ├── commands: Command[]                // 可用命令
│   ├── tools: Tools                       // 可用工具集
│   ├── mainLoopModel: string              // 当前模型
│   ├── agentDefinitions: AgentDefinitionsResult  // Agent 定义
│   ├── mcpClients: MCPServerConnection[]  // MCP 连接
│   └── refreshTools?: () => Tools         // 动态刷新工具（MCP 更新时）
├── abortController: AbortController       // 取消控制
├── readFileState: FileStateCache          // 文件 I/O 缓存（LRU）
├── getAppState/setAppState                // 全局状态读写
└── setAppStateForTasks                    // 会话级基础设施
```

---

## 五、第 3 层：Agent 系统 — "子 Agent 怎么生出来、怎么跑"

### 5.1 AgentTool — Agent 即 Tool

`src/tools/AgentTool/AgentTool.tsx` 是整个 Agent 系统的入口。

**核心洞察**：AgentTool 注册为普通 Tool，LLM 通过 tool_use 协议调用它来 spawn 子 Agent。对 LLM 来说，spawn 一个 Agent 和读一个文件没有本质区别 — 都是"调工具"。

AgentTool 的输入参数：
- `subagent_type` — Agent 类型（explore、plan、general-purpose 等）
- `prompt` — 交给子 Agent 的任务描述
- `description` — 简短描述（3-5 词）
- `model` — 可选的模型覆盖
- `isolation` — 隔离模式（worktree 等）
- `run_in_background` — 是否后台运行

### 5.2 Agent 定义与发现 `src/tools/AgentTool/loadAgentsDir.ts`

Agent 通过 frontmatter 定义能力：

```yaml
---
name: explore
description: Fast agent for codebase exploration
model: inherit          # 继承父 Agent 模型
tools:                  # 可用工具列表
  - Glob
  - Grep
  - Read
  - WebFetch
permissions:            # 权限配置
mcpServers:             # MCP 服务器（追加到父 Agent 的）
---

系统提示词内容...
```

**Agent 来源**：
- **内置 Agent**：`src/tools/AgentTool/built-in/` 目录
  - `generalPurposeAgent` — 通用 Agent
  - `planAgent` — 规划 Agent
  - `exploreAgent` — 代码探索 Agent
  - `verificationAgent` — 验证 Agent
  - `claudeCodeGuideAgent` — 使用指南 Agent
- **用户自定义 Agent**：从用户/插件目录加载

### 5.3 Agent 执行引擎 `src/tools/AgentTool/runAgent.ts`

子 Agent 的执行流程：

```
AgentTool.execute()
├── 解析 Agent 定义（类型、模型、工具集）
├── 创建子 Agent 上下文
│   ├── 克隆 AppState
│   ├── 克隆 FileStateCache
│   ├── 创建独立 AbortController
│   ├── 组装子 Agent 工具集（assembleToolPool）
│   └── 继承权限框架
├── 构建子 Agent 系统提示词
│   ├── Agent frontmatter 中的提示词
│   ├── 父 Agent 传入的 prompt
│   └── 上下文注入（CLAUDE.md 等）
├── 启动独立 Query Loop
│   └── 与主循环相同的 query() 流程
└── 返回子 Agent 的最终输出作为 tool_result
```

### 5.4 上下文隔离 `src/tools/AgentTool/forkSubagent.ts`

```typescript
createSubagentContext(parentContext)
├── Clone AppState            // 子 Agent 有自己的状态副本
├── Clone FileStateCache      // 避免重复文件 I/O
├── new AbortController()     // 子 Agent 可被独立取消
├── assembleToolPool()        // 子 Agent 可能有不同的工具集
├── Share commands            // 共享命令注册
├── Share agent definitions   // 共享 Agent 定义
└── setAppState → no-op       // 子 Agent 不能修改父 Agent 状态
    （用 setAppStateForTasks 修改会话级基础设施）
```

**关键设计**：子 Agent 的 `setAppState` 变成 no-op，防止子 Agent 意外修改父 Agent 状态。但通过 `setAppStateForTasks` 可以操作会话级基础设施（如任务注册）。

### 5.5 递归能力

Agent 可以 spawn Agent，理论上无限嵌套：

```
主 Agent (query loop)
├── 调用 AgentTool → 子 Agent A (独立 query loop)
│   ├── 调用 AgentTool → 子 Agent A1
│   └── 调用 AgentTool → 子 Agent A2
└── 调用 AgentTool → 子 Agent B (独立 query loop)
    └── 调用 AgentTool → 子 Agent B1
```

每一层都是独立的 query loop，有自己的上下文、工具集、AbortController。

---

## 六、第 4 层：上下文 + 任务 + 协调

### 6.1 上下文系统 `src/context.ts`

系统提示词的分层拼装：

```
System Prompt
├── DEFAULT_AGENT_PROMPT          // 基础 Agent 提示词
├── getSystemContext()            // 系统上下文（memoized）
│   ├── gitStatus                 // git 分支、最近提交、状态
│   └── cacheBreaker              // 调试注入
├── getUserContext()              // 用户上下文（memoized）
│   ├── claudeMd                  // ~/.claude.md 和 CLAUDE.md 文件
│   └── currentDate               // 当前日期
├── MCP context                   // MCP 服务器上下文
├── File history snapshot         // 文件历史快照（可选）
└── appendSystemPrompt            // 自定义追加内容
```

**Memory 机制**：
- CLAUDE.md 文件通过 `getMemoryFiles()` 发现（向上遍历目录树）
- 通过 `--add-dir` 可注入额外目录
- 缓存在 state 中避免重复读取

### 6.2 任务系统 `src/Task.ts` + `src/tasks/`

统一管理所有异步任务的生命周期：

```typescript
TaskType（7 种任务类型）
├── local_bash             // Shell 命令执行
├── local_agent            // 异步本地 Agent（后台）
├── remote_agent           // 远程执行 Agent
├── in_process_teammate    // 进程内 Teammate
├── local_workflow         // 工作流脚本
├── monitor_mcp            // MCP 服务器监控
└── dream                  // 实验性任务

TaskStatus 生命周期
pending → running → completed | failed | killed
```

**任务生命周期**：

```
registerTask()              → 注册到 AppState.tasks
       │
spawnShellTask() /          → 启动执行
registerAsyncAgent()
       │
updateTaskProgress()        → 实时进度更新
       │
streamOutput → disk         → 输出写入 getTaskOutputPath(id)
       │
status → terminal           → completed | failed | killed
       │
eviction after grace period → 清理
```

**任务 ID 前缀约定**：
- `b` — local_bash
- `a` — local_agent
- `r` — remote_agent
- `t` — in_process_teammate
- `w` — local_workflow
- `m` — monitor_mcp
- `d` — dream

### 6.3 多 Agent 编排 `src/tools/shared/spawnMultiAgent.ts`

支持三种 Teammate spawn 模式：

```
spawnTeammate(prompt, name, model, isolation)
├── 解析模型（inherit → 继承父模型）
├── 检测后端
│   ├── tmux panes        — 终端分屏
│   ├── in-process        — 同进程内
│   └── remote            — 远程 CCR 会话
├── Spawn 执行
│   ├── startInProcessTeammate()   — 同进程
│   ├── spawnInProcessTeammate()   — 子进程 + IPC
│   └── createSession()            — 远程会话
├── 注册 team 文件 (~/.claude/teams/sessionId.json)
├── 建立 mailbox（Agent 间消息传递）
└── 返回 InProcessTeammateTaskState
```

### 6.4 Coordinator 模式 `src/coordinator/coordinatorMode.ts`

Leader-Worker 架构，用于规模化多 Agent 协作：

```
Leader Process（主 Agent）
├── 环境标记: YWCODER_COORDINATOR_MODE
├── 通过 AgentTool spawn Workers（异步 Agent）
└── Workers 继承受限工具集:
    ├── SIMPLE 模式: Bash, FileRead, FileEdit
    └── 标准模式: ASYNC_AGENT_ALLOWED_TOOLS
        排除: TeamCreate, TeamDelete, SendMessage, SyntheticOutput

访问控制
├── isCoordinatorMode()          — 检查 feature flag + 环境变量
├── getCoordinatorUserContext()   — 向 Worker 系统提示词注入工具限制
└── Workers 使用与子 Agent 相同的权限框架
```

---

## 七、第 4.5 层：记忆架构 — "Agent 怎么跨会话记住东西"

记忆系统是这个框架区别于"一次性对话"的关键能力。它让 Agent 具备**跨会话持久化认知**，放在第 4 层和第 5 层之间，因为：
- 它依赖第 4 层的上下文系统（记忆最终注入 system prompt）
- 它不像核心循环和工具系统那样是"必须先懂"的基础设施
- 但它比 API 层更贴近 Agent 的核心行为——影响 Agent "知道什么"

### 7.1 记忆的两大体系

系统有两套并行的记忆机制，服务于不同目的：

```
记忆体系
├── 指令记忆（CLAUDE.md 体系）
│   目的：告诉 Agent "怎么做"
│   载体：CLAUDE.md / YWCODER.md 文件
│   注入时机：每次对话开始时，写入 system prompt
│   特点：静态、手动维护、全量加载
│
└── 自动记忆（Auto Memory / memdir 体系）
    目的：让 Agent "记住"跨会话的事实
    载体：~/.claude/projects/<path>/memory/ 下的 .md 文件
    注入时机：按需召回（语义检索）+ MEMORY.md 索引常驻
    特点：动态、自动提取、选择性加载
```

### 7.2 指令记忆：CLAUDE.md 体系 `src/utils/claudemd.ts`

这是"告诉 Agent 规则"的机制，按优先级从低到高的 4 层发现：

```
1. 管理员指令    /etc/claude-code/YWCODER.md     全局所有用户
2. 用户指令      ~/.claude/YWCODER.md             用户私有全局
3. 项目指令      YWCODER.md / .claude/YWCODER.md  项目级，提交到 VCS
                 .claude/rules/*.md               项目规则目录
4. 本地指令      YWCODER.local.md                 项目级私有，不提交
```

**加载顺序**：按优先级从低到高加载，后加载的内容 LLM 会更关注（recency bias）。

**目录发现**：从 `cwd` 向上遍历到根目录，每层目录都检查是否存在上述文件。距离 `cwd` 越近的文件优先级越高。

**@include 指令**：CLAUDE.md 文件支持 `@path` 语法引用其他文件（支持相对路径、`~/` 路径、绝对路径），被引用的文件作为独立条目插入。只允许文本文件扩展名，防止二进制注入。

### 7.3 自动记忆：memdir 体系

这是系统的核心创新——让 Agent 像人一样"主动记笔记"并"按需回忆"。

#### 7.3.1 记忆类型分类 `src/memdir/memoryTypes.ts`

4 种记忆类型，构成封闭分类法：

| 类型 | 存什么 | 示例 |
|------|--------|------|
| `user` | 用户的角色、偏好、知识背景 | "用户是数据科学家，关注可观测性" |
| `feedback` | 用户对工作方式的纠正或确认 | "不要在测试中 mock 数据库" |
| `project` | 项目动态、目标、截止日期 | "周四开始 merge freeze" |
| `reference` | 外部资源的指针 | "pipeline bug 在 Linear INGEST 项目追踪" |

**设计原则**：只存"不能从代码/git 推导出来"的信息。代码模式、架构、文件路径等**不应该**存为记忆。

#### 7.3.2 记忆存储格式

每条记忆是一个独立的 `.md` 文件，使用 frontmatter 标注元数据：

```markdown
---
name: 不要 mock 数据库
description: 集成测试必须用真实数据库
type: feedback
---

集成测试必须命中真实数据库，不用 mock。

**Why:** 上季度 mock 测试全部通过但生产迁移失败。
**How to apply:** 编写测试时选择集成测试而非单元测试。
```

#### 7.3.3 记忆目录解析 `src/memdir/paths.ts`

记忆存储位置的解析优先级：

```
getAutoMemPath() 解析顺序:
1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量   （SDK/Cowork 场景）
2. settings.json 中的 autoMemoryDirectory        （用户配置，仅信任源）
3. ~/.claude/projects/<sanitized-git-root>/memory/ （默认）
```

**安全设计**：
- 路径经过严格校验（`validateMemoryPath`）：拒绝相对路径、根路径、UNC 路径、null 字节
- `projectSettings`（提交到仓库的 `.claude/settings.json`）**被排除**在外——防止恶意仓库通过设置 `autoMemoryDirectory: "~/.ssh"` 获取敏感目录写权限
- 所有 worktree 共享同一个记忆目录（通过 `findCanonicalGitRoot` 找到规范根）

#### 7.3.4 记忆扫描 `src/memdir/memoryScan.ts`

```
scanMemoryFiles(memoryDir)
├── readdir(recursive: true)       — 递归读目录
├── 过滤 .md 文件（排除 MEMORY.md）
├── 限制深度 ≤ 3 层               — 防止深层/符号链接 DoS
├── 读取每个文件前 30 行           — 只解析 frontmatter
├── 并行读取 (Promise.allSettled)  — 容错，单个文件失败不影响整体
├── 按 mtime 降序排列             — 最新的在前
└── 截断到 200 条                  — MAX_MEMORY_FILES 上限
```

#### 7.3.5 智能召回 `src/memdir/findRelevantMemories.ts`

这是记忆系统最精巧的部分——**用 LLM 做语义检索**：

```
findRelevantMemories(query, memoryDir)
├── scanMemoryFiles()              — 拿到所有记忆的 header（name + description）
├── 过滤已展示的记忆               — 避免重复
├── formatMemoryManifest()         — 格式化为文本清单
├── sideQuery(Sonnet)              — 调 Sonnet 模型做选择
│   ├── 输入：用户 query + 记忆清单 + 最近使用的工具列表
│   ├── 输出：JSON { selected_memories: string[] }
│   └── 上限 5 条
└── 返回选中记忆的路径 + mtime
```

**设计亮点**：
- 用轻量模型（Sonnet）做选择，主模型（Opus）看结果——成本可控
- 传入"最近使用的工具"列表，避免选中已在使用的工具的参考文档（减少噪音）
- 返回 `mtime` 供主模型判断新鲜度

#### 7.3.6 记忆新鲜度 `src/memdir/memoryAge.ts`

记忆会随时间变旧，系统主动提醒 LLM 注意：

```
memoryAgeDays(mtime)     → 0 (today), 1 (yesterday), 47, ...
memoryAge(mtime)         → "today" / "yesterday" / "47 days ago"
memoryFreshnessText()    → "" (≤1天) / "This memory is 47 days old.
                            Claims about code may be outdated.
                            Verify against current code."
```

这解决了一个真实问题：用户报告旧的记忆（包含 file:line 引用）被 LLM 当作事实断言，导致错误建议。

#### 7.3.7 MEMORY.md 索引 `src/memdir/memdir.ts`

MEMORY.md 是记忆目录的**索引文件**，始终加载到 system prompt：

```
MEMORY.md 规格:
├── 最大 200 行 (MAX_ENTRYPOINT_LINES)
├── 最大 25KB (MAX_ENTRYPOINT_BYTES)
├── 无 frontmatter
├── 每行是一个指针: - [标题](file.md) — 一句话描述
└── 超限时自动截断 + 附加警告
```

双重截断策略（先按行数，再按字节数）防止"少量超长行"绕过行数限制。

#### 7.3.8 自动提取 `src/services/extractMemories/extractMemories.ts`

系统能在**每轮对话结束时**自动提取值得记住的信息：

```
extractMemories (stopHooks 触发)
├── 触发条件: model 返回 end_turn (无 tool_use 的最终响应)
├── 执行方式: runForkedAgent()
│   └── fork 主对话 → 共享 prompt cache → 独立执行
├── 提取逻辑:
│   ├── 扫描当前记忆目录 → 知道已有什么
│   ├── 分析会话 transcript → 发现值得记住的新信息
│   ├── 检查是否与已有记忆重复
│   └── 写入新记忆文件 + 更新 MEMORY.md 索引
├── 工具集: Bash, FileRead, FileWrite, FileEdit, Glob, Grep
└── 门控: feature('EXTRACT_MEMORIES') + isExtractModeActive()
```

**设计亮点**：
- 使用 `runForkedAgent` 模式——fork 主对话的完整上下文，共享 prompt cache，避免重复计算
- 只在主 Agent 没有主动写记忆时才运行（`hasMemoryWritesSince` 检测）

### 7.4 Agent 专属记忆 `src/tools/AgentTool/agentMemory.ts`

除了全局的 auto memory，每个 Agent 类型还可以有**自己的专属记忆**：

```
AgentMemoryScope（3 级作用域）
├── 'user'    → ~/.claude/agent-memory/<agentType>/      全局，跨项目
├── 'project' → <cwd>/.claude/agent-memory/<agentType>/  项目级，提交到 VCS
└── 'local'   → <cwd>/.claude/agent-memory-local/<agentType>/  项目级私有

Agent 记忆快照 (agentMemorySnapshot.ts)
├── 快照文件: .claude/agent-memory-snapshots/<agentType>/snapshot.json
├── 同步标记: agent-memory/<agentType>/.snapshot-synced.json
└── 用途: 将 project scope 的记忆分发给新加入的协作者
```

### 7.5 团队记忆 `src/memdir/teamMemPaths.ts` + `teamMemPrompts.ts`

通过 `feature('TEAMMEM')` 门控，支持多人共享的记忆空间：

```
团队记忆 vs 私有记忆
├── 私有记忆: ~/.claude/projects/<path>/memory/     个人
├── 团队记忆: <project>/.claude/team-memory/         共享（提交到 VCS）
└── 合并提示: buildCombinedMemoryPrompt()
    ├── 每种记忆类型增加 <scope> 标签
    ├── user 类型 → always private
    ├── feedback → default private，项目级惯例可 team
    ├── project → 强偏向 team
    └── reference → 同 project
```

### 7.6 记忆系统全景图

```
┌─────────────────────────────────────────────────────────────┐
│                    System Prompt 注入                        │
│                                                             │
│  ┌──────────────────┐  ┌───────────────────────────────┐   │
│  │ 指令记忆          │  │ 自动记忆                       │   │
│  │ (CLAUDE.md 体系)  │  │ (memdir 体系)                  │   │
│  │                  │  │                               │   │
│  │ /etc/ → 管理员    │  │ MEMORY.md 索引 → 常驻加载      │   │
│  │ ~/.claude → 用户  │  │                               │   │
│  │ 项目根 → 项目     │  │ 按需召回 (Sonnet 语义检索)     │   │
│  │ .local → 私有     │  │ ├── 扫描 frontmatter          │   │
│  │                  │  │ ├── 格式化清单                  │   │
│  │ @include 展开     │  │ ├── sideQuery → 选 ≤5 条      │   │
│  │                  │  │ └── 注入到对话上下文             │   │
│  └──────────────────┘  └───────────────────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 自动提取 (extractMemories)                            │   │
│  │ 会话结束 → fork Agent → 分析 transcript → 写入记忆    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌────────────────────┐  ┌──────────────────────────────┐  │
│  │ Agent 专属记忆      │  │ 团队记忆 (TEAMMEM)           │  │
│  │ user/project/local │  │ .claude/team-memory/          │  │
│  │ per-agent 隔离     │  │ 多人共享 + scope 标签          │  │
│  └────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 八、第 5 层：API 层 + 扩展机制

### 8.1 Claude API 客户端 `src/services/api/claude.ts`

```
queryModelWithStreaming()
├── 重试 + FallbackTriggeredError 处理
├── Prompt cache 校验
├── Usage 跟踪（input/output/cache tokens）
├── 流式响应处理
│   ├── content_block_start/stop/delta
│   ├── message_start/delta/stop
│   └── 中途错误处理
└── Usage 汇总
```

**错误处理策略**：
- **可重试**：rate limit、timeout、retryable 5xx
- **不可重试**：auth 失败、无效请求
- **Fallback**：过载时模型降级
- **Prompt 过长**：auto-compact + 重试

### 7.2 OpenAI 兼容层 `src/services/api/openaiShim.ts`

将 OpenAI 兼容 API（Ollama、GPT、Gemini 等）适配到统一接口，使得：
- 所有 Provider 共享同一套 query 流程
- tool_use 协议在不同 Provider 间保持一致
- 通过环境变量切换后端

### 7.3 Provider 路由 `src/services/api/agentRouting.ts`

```
模型解析优先级:
用户指定 → Agent frontmatter → 父 Agent 模型 → 默认模型

每个 Provider 可配置:
├── API Key
├── Base URL
└── 模型映射
```

### 7.4 MCP 服务器 `src/services/mcp/`

Model Context Protocol 支持动态工具发现：
- MCP Server 可在运行时连接
- Agent 可定义自己的 MCP Server（追加到父 Agent 的）
- 工具集通过 `refreshTools()` 动态更新

### 7.5 斜杠命令 `src/commands.ts`

```
用户输入 "/command"
       │
Parser 提取命令名
       │
getCommand(name) — 从注册表匹配
       │
handler(ToolUseContext, AppState)
       │
yield JSX (UI) / messages / tool results
```

命令类别：
- 信息类：`/help`, `/status`, `/cost`, `/config`
- 会话类：`/resume`, `/session list`, `/context`
- Git 类：`/diff`, `/commit`, `/review`
- 管理类：`/doctor`, `/init`, `/setup`

---

## 九、关键模块详解

### 9.1 权限系统

```
权限传播：父 → 子
├── 子 Agent 继承父 Agent 的权限模式
├── 可通过 query 参数覆盖（如 mode=plan）
├── deny rules 从 Leader 向下同步
└── 每个 Agent 独立跟踪 approval 状态
```

相关文件：`src/utils/swarm/permissionSync.ts`, `src/hooks/useCanUseTool.ts`

### 9.2 Bridge 模式 `src/bridge/`

远程执行桥接：

| 文件 | 职责 |
|------|------|
| `bridgeMain.ts` | Bridge 入口（远程执行桥） |
| `replBridge.ts` | 基于 REPL 的远程会话桥 |
| `sessionRunner.ts` | Bridge 上下文中的会话执行 |
| `remoteBridgeCore.ts` | 核心 Bridge RPC 逻辑 |

当本地 Agent 需要在远程环境执行时，通过 WebSocket/HTTP 将 tool_use 请求路由到远程 executor。

### 9.3 Buddy 系统 `src/buddy/`

实验性的 Companion UI（KAIROS 模式下的辅助界面）：
- `CompanionSprite.tsx` — UI 伴侣精灵
- `companion.ts` — 伴侣状态管理
- 通过 `feature.ts` 门控

### 9.4 文件状态缓存

`FileStateCache` (LRU 缓存) 避免重复文件 I/O：
- 每个 Agent（含子 Agent）持有独立的缓存实例
- 子 Agent 克隆时继承父 Agent 的缓存快照
- 防止大量文件操作时重复磁盘访问

---

## 十、架构全景图

```
┌──────────────────────────────────────────────────────────────┐
│                        用户终端 (React/Ink)                    │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                    main.tsx（应用入口）                         │
│  初始化 AppState / 工具集 / 命令集 / Agent 定义                 │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│              QueryEngine.ts（Query 编排器）                     │
│  token 预算 / auto-compact / 系统提示拼装                      │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                query.ts（Query 状态机 - 核心循环）               │
│                                                               │
│  ┌─────────┐    ┌──────────┐    ┌───────────────┐            │
│  │ 用户输入  │───▶│ 调 LLM   │───▶│ 解析 tool_use │            │
│  └─────────┘    └──────────┘    └───────┬───────┘            │
│       ▲                                  │                    │
│       │         ┌──────────────┐   ┌─────▼──────┐            │
│       └─────────│ 回传 result  │◀──│ 执行工具    │            │
│                 └──────────────┘   └────────────┘            │
└──────────────────────────────────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
┌─────────▼────┐   ┌────────▼───────┐  ┌──────▼───────┐
│  Tool System  │   │  Agent System  │  │ Task System   │
│              │   │               │  │              │
│ ~50 个工具    │   │ AgentTool     │  │ 7 种任务类型  │
│ feature 门控  │   │ = Tool + 独立  │  │ 统一生命周期  │
│ 统一 schema   │   │   Query Loop  │  │              │
│ 权限检查      │   │ + 上下文隔离   │  │ pending      │
│              │   │               │  │ → running    │
│ Bash         │   │ 递归 spawn    │  │ → completed  │
│ FileRead     │   │ 内置+自定义    │  │   / failed   │
│ FileEdit     │   │ worktree 隔离 │  │   / killed   │
│ Glob/Grep    │   │               │  │              │
│ WebFetch     │   │ Coordinator   │  │ 输出 → 磁盘   │
│ MCP Tools    │   │ Leader-Worker │  │ 进度 → UI    │
│ ...          │   │               │  │              │
└──────────────┘   └───────────────┘  └──────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
┌─────────▼────┐   ┌────────▼───────┐  ┌──────▼───────┐
│  Context      │   │  Memory System │  │  API Layer    │
│              │   │               │  │              │
│ System Prompt│   │ 指令记忆       │  │ claude.ts    │
│ CLAUDE.md    │   │ CLAUDE.md 4层  │  │ openaiShim   │
│ git status   │   │               │  │ 流式/重试     │
│ 日期/环境     │   │ 自动记忆       │  │              │
│              │   │ memdir 体系    │  ├──────────────┤
│              │   │ Sonnet 语义召回│  │  MCP         │
│              │   │ 自动提取       │  │ 动态工具发现  │
│              │   │ Agent 专属记忆 │  │ 运行时连接    │
│              │   │ 团队记忆       │  │              │
└──────────────┘   └───────────────┘  └──────────────┘
```

---

## 十一、实操建议

### 11.1 第一步：跑起来

```bash
bun run dev
```

实际使用一次，体感理解"一次交互"的流转。

### 11.2 第二步：打断点观察核心循环

在 `src/query.ts` 的主循环里加日志/断点，观察：
- LLM 返回了什么 tool_use block
- 哪个工具被匹配和执行
- tool_result 是什么
- 循环了几轮才 end_turn

### 11.3 第三步：按 1-20 顺序读

每层理解后再往下走，不要跳着看。

### 11.4 遇到不懂的子系统

Bridge、Buddy、MCP 等是扩展点，**暂时跳过**不影响理解核心架构。等核心循环和 Agent 系统理解透了，再回头看这些。

### 11.5 关键文件速查表

| 想理解的问题 | 去看哪个文件 |
|-------------|-------------|
| 一次对话怎么跑 | `src/query.ts` |
| 工具怎么定义 | `src/Tool.ts` |
| 工具怎么注册 | `src/tools.ts` |
| 工具怎么执行 | `src/services/tools/toolExecution.ts` |
| Agent 怎么 spawn | `src/tools/AgentTool/AgentTool.tsx` |
| Agent 怎么跑 | `src/tools/AgentTool/runAgent.ts` |
| Agent 定义格式 | `src/tools/AgentTool/loadAgentsDir.ts` |
| 上下文怎么拼 | `src/context.ts` |
| 任务怎么管理 | `src/Task.ts` + `src/tasks/` |
| 多 Agent 协作 | `src/tools/shared/spawnMultiAgent.ts` |
| Leader-Worker | `src/coordinator/coordinatorMode.ts` |
| CLAUDE.md 怎么加载 | `src/utils/claudemd.ts` |
| 自动记忆怎么存取 | `src/memdir/memdir.ts` + `src/memdir/paths.ts` |
| 记忆怎么召回 | `src/memdir/findRelevantMemories.ts` |
| 记忆怎么自动提取 | `src/services/extractMemories/extractMemories.ts` |
| Agent 专属记忆 | `src/tools/AgentTool/agentMemory.ts` |
| API 调用 | `src/services/api/claude.ts` |
| 权限系统 | `src/hooks/useCanUseTool.ts` |
