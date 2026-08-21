# YwCoder 适配本地 Agent 接口 v3 实施方案

> 状态：待实施
>
> 日期：2026-08-19
>
> 目标协议：[local-agent-interface-0819-v3.md](local-agent-interface-0819-v3.md)
>
> 现有实现依据：[ywcoder-integration.md](ywcoder-integration.md) / [shim-build-plan.md](shim-build-plan.md)

## 1. 结论

v3 没有推翻现有 M1～M5。聊天、流式输出、权限确认、取消、会话续接和文件/图片预览均应原样保留。

YwCoder 侧需新增四组能力：

1. 会话级工作目录 `metadata.workdir`。
2. 命令发现、`metadata.command` 与 Agent 实例级模型/权限切换。
3. 群聊上下文 `metadata.group`。
4. 管理者编排 `task.invoke` / `task.subtask_result`。

建议分成两个交付批次：

- **批次 A：v3 基础兼容**：UUID、workdir、command、模型/权限切换、群聊上下文。
- **批次 B：管理者编排**：通过 YwCoder 现有 SDK MCP 控制桥接实现远程委派工具。

管理者编排不应与基础协议升级混在同一个 PR 中。

## 2. 审核后对原方案的修正

### 2.1 权限模式切换不能只增加 `set_permission_mode`

现有 shim 只在初始模式为 `default` 时给 YwCoder 增加 `--permission-prompt-tool stdio`。如果 Agent 全局权限从 `acceptEdits` 动态切换到 `default`，但某个 session 子进程启动时没有 stdio 权限通道，网页仍然收不到 `can_use_tool`。

修正方案：

- 所有受该 Agent 全局权限控制的 session 子进程都应启动 `--permission-prompt-tool stdio`。
- 当前模式仍决定是否实际产生权限请求；开启通道不等于自动放行。
- `bypassPermissions` 不得默认暴露为可切换选项。只有 AgentClient 启动配置显式允许 full-auto 时，shim 才能在 capability 中上报该选项，并为 YwCoder 子进程加入允许切换的启动条件。

### 2.2 管理者编排可以复用 SDK MCP 桥，无需预设修改主运行时

YwCoder 已有完整的 SDK MCP 控制通道：

```text
YwCoder MCP Client
  → control_request{subtype:"mcp_message"}
  → shim 内的 MCP Server
  → control_response{mcp_response}
```

shim 可在 initialize 时声明 `sdkMcpServers:["ywmatrix"]`，并在自身进程内提供一个 YwMatrix 委派 MCP 工具。这符合“YwCoder 主运行时零改动”边界。

只有在 SDK MCP 实测无法满足取消、多子任务或 Node.js 18.20.8 要求时，才考虑修改 YwCoder 工具注册层。

### 2.3 workdir 中途变更不是简单替换 `cwd`

YwCoder 的子进程 cwd 在 spawn 时确定，会话 transcript 又按项目目录分桶。同一 `session_id` 在运行中切换 workdir 需要：

1. 等当前任务结束。
2. 停止旧子进程。
3. 在新 cwd 下用旧 transcript JSONL 路径执行跨目录 resume。
4. 持久化 `session_id → transcript path + current workdir` 路由，否则 shim 重启后无法找回原 transcript。

v3 当前未明确是否要求“已开始的会话中途换目录”。批次 A 建议先实现**首任务绑定，后续不可变**；若 Client 确认必须动态换目录，再增加上述 transcript 路由持久化。

### 2.4 capability 采用全局与 session 两级作用域

当前内网产品约束是：同一 YwCoder Agent 实例通过统一网关工作，模型和权限模式不按 session 分叉。用户切换目录或创建新 session 时，自动继承该 Agent 当前的模型与权限。因此模型/权限的 `metadata.current` 属于 Agent 全局状态，不需要按 session 维护。

但项目命令和技能由具体 workdir 下的 YwCoder 子进程发现，不同 session 仍可能不同。推荐给 `lifecycle.capabilities_updated.params` 增加可选 `session_id`：

- 不带 `session_id`：Agent 全局能力的全量快照，例如模型、权限和稳定内置命令。
- 带 `session_id`：指定 session 的全量能力快照，例如该 workdir 下的命令和技能。
- Client 展示时合并“全局 + 当前 session”两层；同 `type/name` 冲突时 session 层优先。
- 全量替换只作用于本层级，session 更新不得覆盖全局快照。
- session 关闭时 Client 自动清理对应快照；必要时 Agent 可发送该 session 的空快照提前清理。

推荐消息示例：

```jsonc
// Agent 全局快照
{"jsonrpc":"2.0","method":"lifecycle.capabilities_updated","params":{"capabilities":[...]}}

// session/workdir 快照
{"jsonrpc":"2.0","method":"lifecycle.capabilities_updated","params":{"session_id":"session-001","capabilities":[...]}}
```

Client 内部应分别以 `agent_id` 和 `(agent_id, session_id)` 为缓存键，不能把两类消息写入同一个全局数组。

该设计既保持当前模型/权限全局复用，也避免把项目 A 的技能错误显示到项目 B。

### 2.5 管理者身份缺少可比较的本机 agent_id

v3 要求用 `metadata.group.manager_agent_id === 自身 agent_id` 判断管理者，但现有 shim 只在 register 中硬编码 `ywcoder`，实际 agent_id 由 AgentClient/网关分配。shim 并不知道自身实例 ID。

必须由 Client 额外下发实例 ID，否则 shim 不能安全地开放委派工具。

### 2.6 QueryEngine 能执行斜杠命令，但只能声明 headless 可执行集合

“斜杠命令只在 `REPL.tsx` 解析、经 `sendUser()` 会变成普通 prompt”的判断与当前代码不符：

- `main.tsx` 为 headless 模式构造 `commandsHeadless`：允许未禁用非交互模式的 `prompt` 命令，以及 `supportsNonInteractive: true` 的 `local` 命令。
- `QueryEngine.submitMessage()` 明确调用 `processUserInput()`；后者在输入以 `/` 开头且未设置 `skipSlashCommands` 时调用 `processSlashCommand()`。
- `QueryEngine` 对 `shouldQuery: false` 的本地命令会直接返回命令结果，而不是调用模型。
- `/compact` 是 `local` 命令，且明确声明 `supportsNonInteractive: true`，因此属于 headless 可执行集合；技能属于允许非交互的 `prompt` 命令时也可执行。

需要修正的是原方案的范围表述，而不是删除该能力：shim 只能把 YwCoder **SDK initialize response 实际返回的 commands** 暴露为 capability。该 response 使用的正是 `commandsHeadless`，不会包含 `local-jsx` 或不支持非交互的本地命令。不得把交互 REPL 的完整命令表自行补进 capability，也不得假设任意未知 `/xxx` 都会被本地执行。

### 2.7 权限 capability 默认使用 YwCoder 原生值

v3 明确规定页面的枚举选项来自 Agent 上报的 `metadata.args[].options`，且“执行语义由 Agent 自定”。因此 `default/auto/full_auto` 是协议示例，不是强制词表。

默认实现应直接上报并接受 YwCoder 原生值：

- `default`
- `acceptEdits`
- `bypassPermissions`（仅在 shim 启动时显式 opt-in 后暴露）

只有 Client 实现经联调证实硬编码了 `auto/full_auto`，才增加兼容别名映射 `auto → acceptEdits`、`full_auto → bypassPermissions`；capability 的 `current` 仍统一回写原生值。不能同时无说明地混用两套词表。

## 3. 最终需要与 Client 沟通确认的契约

| 编号 | 需要 Client 确认 | YwCoder 推荐方案 | 影响 |
|---|---|---|---|
| C1 | `capabilities_updated` 是否接受可选 `session_id`，以及两层快照如何合并/清理 | 无 `session_id` 表示全局全量快照；有值表示指定 session 全量快照；展示时 session 优先，关闭 session 自动清理 | 阻塞按 workdir 正确展示项目命令/技能 |
| C2 | 页面是否严格使用 capability 的动态权限 options | 上报原生 `default/acceptEdits/bypassPermissions`；只在 Client 已硬编码时兼容 `auto/full_auto` 输入别名 | 不阻塞后端实现，阻塞权限工具栏联调验收 |
| C3 | AgentClient 如何把网关认可的本 Agent 实例 ID 下发给 shim | `lifecycle.initialize.params.agentInfo.agent_id` 下发受信 ID，不使用 shim 自报名称代替 | 阻塞群管理者编排 |
| C4 | 页面是否接受“首任务后锁定目录；换目录新建 session” | 批次 A 不支持同 session 中途换 workdir；明确返回 `-32602`，不静默切换上下文 | 不阻塞基础实现，需 Client 配合 UI 限制 |
| C6 | 取消父任务时由谁取消网关已经派发的子任务 | 网关按 `parent_task_id` 级联取消；AgentClient 通知 shim 收尾，迟到结果幂等忽略 | 阻塞编排取消验收 |
| C7 | 首个 session ready 前页面如何展示命令，以及动态技能加载状态 | register 先报稳定全局命令；具体 YwCoder 子进程 initialize 后按 C1 推 session 命令/技能；页面显示“正在加载项目技能” | 不新增协议分歧，但需确认页面交互 |

C5 已关闭：在当前统一内网网关的信任模型下，`metadata.workdir` 就是用户在 Client 设定并由网关持久化的工作目录，不再配置 workspace roots 或 `--allowed-workdir-root`。Client 必须保证该字段只来自用户的目录选择/会话设置；shim 负责路径规范化和可用性校验。

C1、C3、C6 分别阻塞 session 技能发现、管理者身份校验和编排取消；对应功能不能在未确认时宣称完成。C2、C4、C7 已有推荐默认值，可以先实现，但最终仍需 Client 联调确认。

## 4. 范围与非目标

### 4.1 本期范围

- 基于 v3 的输入/输出 schema。
- 会话级 workdir。
- 命令发现和结构化命令。
- Agent 实例级模型/权限模式，切换目录和新 session 自动继承。
- 群聊上下文。
- 管理者一层子任务编排。
- Node.js 18.20.8 运行兼容。

### 4.2 非目标

- 不在本方案中实现 M6 上行文件上传。
- 不在本方案中实现 M7 原文件旁路预览。
- 不实现超过一层的递归编排。
- 不由 shim 接管 AgentClient 的网关连接、心跳和重连。
- 不改变已定稿的 M1～M5 消息字段和预览语义。

### 4.3 v3 中无需 YwCoder 改造的项目

- HTTP cancel endpoint 和 WebSocket adapter 属于 AgentClient 传输层。
- `task.cancel → interrupt` 已实现，并有 SIGTERM/SIGKILL 收尾看门狗。
- `confirm_cancelled` 已实现去重与任务结束清理。
- 结构化 `{decision:"cancel"}` 已映射为中止整个任务。
- confirm 已不发 `timeout`，不设人工审批短超时。
- 网关任务默认超时改为 30 分钟属于 Client/网关配置；shim 只需保持正确响应其 `task.cancel`。

## 5. 目标架构

```text
AgentClient
  │  stdio JSONL
  ▼
ywmatrix-shim
  ├─ ProtocolCodec
  │    ├─ lifecycle/task/stream 协议
  │    ├─ JSON-RPC request/response 关联
  │    └─ v3 metadata schema
  ├─ SessionManager
  │    ├─ session_id → workdir/group/动态 capability
  │    ├─ 同 session 任务串行
  │    └─ 多 session 多 YwCoder 子进程
  ├─ AgentSettings
  │    └─ 全局 model/permission + settingsVersion
  ├─ CapabilityManager
  │    ├─ Agent 全局全量快照
  │    ├─ session_id → 项目命令/技能全量快照
  │    └─ 分层 fingerprint 去重
  ├─ DelegationBridge
  │    ├─ 内嵌 YwMatrix SDK MCP Server
  │    ├─ task.invoke request 映射
  │    └─ task.subtask_result 等待与取消
  └─ YwcoderSession[]
       └─ YwCoder stream-json child
```

ProtocolCodec 与 SessionManager 可先在现有 `protocol.ts` / `index.ts` 内增量实现，不必立即拆文件。DelegationBridge 应独立文件，避免把双层 JSON-RPC 关联表继续堆进 `index.ts`。

## 6. 状态模型

### 6.1 任务元数据

```ts
interface GroupMember {
  agent_id: string
  name: string
}

interface GroupContext {
  group_id: string
  group_name: string
  manager_agent_id: string
  members: GroupMember[]
  mentions: string[]
}

interface CommandInvocation {
  name: string
  args: Record<string, unknown>
}

interface TaskMetadata {
  workdir?: string
  group?: GroupContext
  command?: CommandInvocation
  [key: string]: unknown
}
```

对已知字段做严格校验，但允许未知 metadata 字段透传，避免阻断后续协议扩展。

### 6.2 会话状态

```ts
interface QueuedTask {
  taskId: string
  content: string
  metadata: TaskMetadata
}

interface SessionEntry {
  session: YwcoderSession | null
  queue: QueuedTask[]
  activeTaskId: string | null
  workdir: string
  transcriptPath?: string
  group?: GroupContext
  sessionCapabilityFingerprint?: string
  appliedSettingsVersion: number
}

interface AgentSettings {
  model?: string
  permissionMode: ExternalPermissionMode
  version: number
  globalCapabilityFingerprint?: string
}
```

`workdir/group/sessionCapabilityFingerprint` 按 `session_id` 存储；`model/permissionMode` 放在 Agent 全局 `AgentSettings`。每个 session 用 `appliedSettingsVersion` 记录其子进程是否已经应用最新设置，在处理下一任务前完成同步。全局设置更新必须经过单一互斥入口，避免两个 session 同时切换造成竞态。

### 6.3 双层 JSON-RPC 关联

shim 需同时管理：

1. AgentClient 发来的 request（initialize/create/respond）。
2. shim 向 AgentClient 发出的 request（`task.invoke`）。
3. shim 向 YwCoder 发出的 control request（set_model/set_permission_mode/interrupt）。
4. YwCoder 向 shim 发出的 control request（can_use_tool/mcp_message）。

因此 `parseIncoming` 不能再只接受带 `method` 的消息，必须支持 AgentClient 返回的 JSON-RPC response：

```json
{"jsonrpc":"2.0","id":"inv-1","result":{...}}
{"jsonrpc":"2.0","id":"inv-1","error":{...}}
```

外层 request id、MCP message id 和 YwCoder control request id 必须分开命名空间和映射表。

## 7. 分阶段实施

### 7.1 阶段 P0：冻结 v3 契约

#### 任务

- 将第 3 节发给 Client：定稿 C1/C3/C6，确认 C4/C7 页面行为，并按 C2 验证页面消费动态 options；C5 已按可信用户目录输入关闭。
- 将 [ywcoder-integration.md](ywcoder-integration.md) 从 v2 口径升级为 v3。
- 标记 [shim-build-plan.md](shim-build-plan.md) 中已过时的“首条 task 可不带 session_id”。
- 固化模型/权限的 Agent 全局作用域、权限原生词表（以及必要时的 Client 兼容别名）和 workdir 优先级。

#### 验收

- 无未决定字段直接进入实现。
- Client 和 YwCoder 对 session/capability/cancel/invoke 的语义有同一份定稿。

### 7.2 阶段 P1：协议基线与可测试性

#### 改动文件

- `src/entrypoints/ywmatrix-shim/protocol.ts`
- `src/entrypoints/ywmatrix-shim/index.ts`
- `src/entrypoints/ywmatrix-shim/protocol.test.ts`
- `src/entrypoints/ywmatrix-shim/mock-agentclient.ts`
- 建议新增 `src/entrypoints/ywmatrix-shim/test-fixtures/fake-ywcoder.ts`

#### 任务

1. `task.create.session_id` 改为必填，先用 YwCoder 同源 `validateUuid` 校验格式，再显式校验 `value === value.toLowerCase()`（现有 `validateUuid` 本身不区分大小写）。
2. 大写 UUID、格式非法 UUID、缺失 UUID 均返回 `-32602`。
3. 删除 shim 自行 mint UUID 的正常路径；ack 仅回显网关 ID。
4. 增加 `TaskMetadata` / `GroupContext` / `CommandInvocation` schema。
5. 扩展 incoming envelope，支持 JSON-RPC response 和 `task.subtask_result` notification。
6. 将队列从 `{taskId,content}` 升级为完整 `QueuedTask`。
7. 把 child spawn 封装成可注入工厂，大多数测试使用 fake YwCoder，不依赖 Provider/API Key。

#### 兼容策略

- `task.create{type:"respond"}` 继续保留。
- `task.respond` 的 boolean/自由文本旧格式继续归一。
- 未知 metadata 字段不拒绝整条任务。
- 未启用 v3 新能力时，M1～M5 输出必须逐字段保持。

#### 验收

- 协议单测不需真模型即可覆盖所有新 schema。
- 未知 request 返回 `-32601`，未知 notification 记 stderr 且不产生非法 response。
- 原 M1～M5 测试全部通过。

### 7.3 阶段 P2：会话级 workdir

#### 改动文件

- `src/entrypoints/ywmatrix-shim/index.ts`
- `src/entrypoints/ywmatrix-shim/ywcoderSession.ts`
- `src/entrypoints/ywmatrix-shim/protocol.ts`
- 建议新增 `src/entrypoints/ywmatrix-shim/workdirPolicy.ts`

#### 目录选择规则

```text
metadata.workdir
  → 已配置且通过校验：使用该目录
  → 未配置：回落 shim --workdir
```

校验顺序：

1. 必须为绝对路径。
2. 必须存在且为目录。
3. 用 `realpath` 消除 `..` 和符号链接差异。
4. 保存规范化后的真实路径，后续同 session 比较也使用该路径。

不额外限制 allowed root：目录选择权限属于 Client/网关的受信会话设置，shim 直接使用用户设定的 `metadata.workdir`。非法、已删除或不可访问的目录仍返回明确的 `-32602`。

若未来开放第三方 API 直接写入 workdir、跨租户网关或其他非受信来源，再单独引入可选目录 allowlist；不为当前内网场景预先增加配置负担。

#### 会话恢复

现有 `sessionIdExists(sessionId)` 依赖进程全局 original cwd，不可再用于多 workdir shim。改为显式路径计算：

```ts
const transcript = join(getProjectDir(workdir), `${sessionId}.jsonl`)
```

- transcript 存在：`--resume <sessionId>`，子进程 cwd 为该 workdir。
- transcript 不存在：`--session-id <sessionId>`。
- 不再通过 shim 全局 `process.chdir()` 支持会话分桶。
- 每个 YwCoder 子进程仍显式使用自己的 `cwd` 与 `--add-dir`。

#### 同 session workdir 变更

批次 A 默认策略：

- 首个 chat/command 任务绑定 workdir。
- 后续任务 workdir 经 realpath 后不一致，返回明确的 `-32602`，不静默换目录。
- UI 应在会话产生首条任务后禁用目录切换，或切换时自动建新会话。

若 C4 确认必须中途换目录，单独增加 P2b：

- 会话空闲时停止子进程。
- 使用 `--resume <old-transcript.jsonl>` 在新 cwd 恢复。
- 以原子写方式持久化会话路由。
- 重启 shim 后先读路由，再决定 UUID resume 还是 JSONL-path resume。
- 新增 transcript 丢失、路由损坏、新目录不可访问等恢复测试。

#### 验收

- 两个 session 可同时在两个目录运行。
- 相对路径工具操作确实发生在各自 workdir。
- 相同 session/workdir 跨子进程 resume 保留上下文。
- `..` 和符号链接路径被规范化，同一真实目录不会被误判为 workdir 变更。
- 一个会话的目录失败不影响其他会话。

### 7.4 阶段 P3：command 发现与 Agent 全局设置

#### 改动文件

- `src/entrypoints/ywmatrix-shim/ywcoderSession.ts`
- `src/entrypoints/ywmatrix-shim/protocol.ts`
- `src/entrypoints/ywmatrix-shim/index.ts`
- 建议新增 `src/entrypoints/ywmatrix-shim/capabilities.ts`

#### initialize 元数据

`YwcoderSession.spawn()` 不再只返回 ready，还要保存 YwCoder initialize response 中的：

- `commands`
- `models`
- `output_style`
- 必要的 account/provider 可用性信息（不对上泄露凭据）

initialize schema 校验失败仍采用“诊断从严、消息处理从宽”，不因上游枚举漂移丢弃整个响应。

#### capability 生成

Agent 全局列表（register 或不带 `session_id` 的 update）：

- `chat/coding`
- `command/model`：启动时没有真实模型 options 则暂不上报；首个子进程 initialize 后，根据统一网关模型列表加入全局快照。
- `command/permission`（只列实际允许的模式）
- 模型 options 来自首个成功 initialize 的统一网关模型列表，不硬编码云端模型名。
- model/permission 的 current 来自全局 `AgentSettings`。

session 动态列表（带 `session_id` 的 update）：

- YwCoder SDK initialize response 返回的 slash commands；该列表已由 YwCoder 按 headless 可执行性过滤，shim 不得从交互命令全集补项。
- 技能标记 `metadata.kind:"skill"`。
- 列表只属于产生 initialize response 的 session/workdir。

全局和每个 session 分别稳定排序并计算 fingerprint，只在对应层级的全量快照变化时推送。session 子进程尚未 ready 时，Client 只展示全局能力并显示“正在加载项目技能”。

#### 结构化命令执行

```text
metadata.command 存在
  → 优先按结构化 name/args 执行
metadata.command 不存在
  → 将 content 原样发给 YwCoder，兼容手输 /command
```

- `/model` 和 `/permission` 由 shim 识别，不调 LLM；命令虽然从某个 session 发起，但修改 Agent 全局设置。
- 只有 initialize response 已声明的其他 slash command/技能，才使用 `sendUser(content)` 进入 YwCoder 现有 QueryEngine。
- 对未声明的手输 `/xxx` 仍按 v3 原样透传，但不承诺它会作为本地命令执行；最终行为以 QueryEngine 的可用命令集为准。
- 所有 command 仍占用一个正常 task，按同 session 队列顺序执行。
- 本地切换命令输出 text chunk + done chunk + `task.completed`，不伪造 LLM usage。

#### YwCoder control request 通用化

在 `YwcoderSession` 增加：

```ts
setModel(model: string): Promise<void>
setPermissionMode(mode: ExternalPermissionMode): Promise<void>
```

并增加机器控制请求关联表：

```ts
Map<requestId, {
  resolve: (response: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}>
```

- `set_model` / `set_permission_mode` 可使用 10 秒级机器响应超时。
- 人工 `can_use_tool` confirm 继续不设短超时。
- 子进程退出时 reject 所有 pending control promise。
- 未知/迟到 control response 只记录 stderr，不污染 stdout。

全局设置应用规则：

- 模型/权限更新经过全局互斥入口，写入 `AgentSettings` 并递增 `settingsVersion`。
- 发起切换命令的当前子进程先完成控制面切换；失败则不提交全局新值。
- 其他 session 不打断正在执行的任务；在各自下一任务开始前对比 `appliedSettingsVersion` 并补齐模型/权限设置。
- 新建、resume 或切换目录后重拉的子进程直接使用最新全局设置。
- 成功后发送不带 `session_id` 的全局 `capabilities_updated` 更新 current。

#### 权限安全

- 所有支持动态切换的子进程启用 stdio permission prompt channel。
- `bypassPermissions` 必须有 shim 启动级显式 opt-in，否则不上报、不接受；若启用 Client 兼容别名，`full_auto` 同样受此限制。
- 页面切换宽权限模式的二次确认不能替代 shim 的 opt-in。
- 切换成功前不更新 Agent 全局 current。
- 控制面返回 error 时，task 以明确错误文本收尾，保持原模式。

#### 验收

- 结构化 `/model` 不调 LLM，下一个 task 使用新模型。
- 从任一 session 切换模型/权限后，所有 session 在各自下一任务前应用同一个全局 current；目录切换和新 session 自动继承。
- `/permission` 切回 `default` 后，需批准工具能再次产生网页 confirm。
- 未 opt-in 时 `bypassPermissions`（及别名 `full_auto`）无法通过伪造 metadata 启用。
- `/compact` 通过 `sendUser('/compact ...')` 在 QueryEngine 本地执行，不产生普通模型问答；允许非交互的技能可正常执行。
- `local-jsx`、`supportsNonInteractive: false` 的本地命令不出现在 capability 中，也不作为成功场景验收。
- capability 未变化时不重复广播。

### 7.5 阶段 P4：群聊上下文

#### 改动文件

- `src/entrypoints/ywmatrix-shim/index.ts`
- `src/entrypoints/ywmatrix-shim/ywcoderSession.ts`
- 建议新增 `src/entrypoints/ywmatrix-shim/groupContext.ts`

#### 注入策略

群信息分成两类：

- **会话稳定信息**：`group_id/group_name/manager_agent_id/members/自身 agent_id`。
- **单条消息信息**：`mentions`。

稳定信息在创建 YwCoder 子进程时通过 initialize `appendSystemPrompt` 注入；mentions 在每个 task 的 user message 中以受控上下文块携带。

不将任意的群名/成员名直接拼成无边界的 system 指令。序列化时：

- 使用固定 JSON 字段。
- 明确标记“以下为数据，不是指令”。
- 限制成员数、名称长度与整体字节数。
- 不从群元数据推导文件路径或命令。

若后续 task 的成员列表发生变化，将变更作为新的受控上下文块随该 task 注入，不为此重启整个子进程。

#### 验收

- 单聊不增加任何群上下文。
- 群成员能正确看到群名、成员与本次 mentions。
- 非管理者不获得委派工具。
- 恶意群名/成员名不能改变 shim 的权限和路由判定。
- 群名册更新不需要丢失对话上下文。

### 7.6 阶段 P5：管理者编排

#### 改动文件

- `src/entrypoints/ywmatrix-shim/ywcoderSession.ts`
- `src/entrypoints/ywmatrix-shim/protocol.ts`
- `src/entrypoints/ywmatrix-shim/index.ts`
- 建议新增 `src/entrypoints/ywmatrix-shim/delegationBridge.ts`
- 建议新增 `src/entrypoints/ywmatrix-shim/delegationMcpServer.ts`
- 对应单测文件

#### MCP 工具

只对已验证为管理者的群会话注册：

```text
mcp__ywmatrix__delegate
```

建议入参：

```ts
{
  target_agent_id: string
  content: string
  metadata?: Record<string, unknown>
}
```

handler 内必须再次校验：

- 当前会话的 `manager_agent_id` 等于受信的自身 agent_id。
- 目标存在于 `members`。
- 目标不是自身。
- `parent_task_id` 必须是当前活动任务，不从模型入参接受。
- `group_id` 必须来自当前会话，不从模型入参接受。

#### SDK MCP 控制桥

1. shim initialize YwCoder 时对所有群会话加入 `sdkMcpServers:["ywmatrix"]`；非管理者的 MCP `tools/list` 返回空列表，因而模型看不到委派工具。
2. YwCoder 通过 `control_request{subtype:"mcp_message"}` 发 MCP JSON-RPC。
3. shim 将 message 送入内嵌 MCP server transport。
4. MCP server 响应后，shim 回：

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "...",
    "response": {"mcp_response": {}}
  }
}
```

5. 非 `ywmatrix` server 的 `mcp_message` 继续显式回 error，不能静默忽略。

若群管理者在会话存活期间变更，MCP server 根据新的受信群状态更新工具列表并发 `notifications/tools/list_changed`；不依赖重启 YwCoder 子进程来撤销旧管理者权限。工具 handler 仍必须每次重新校验管理者身份，防止模型在列表刷新竞态中调用旧工具。

#### task.invoke 发起

MCP handler 调用 DelegationBridge：

1. 生成外层 request id。
2. 向 AgentClient stdout 发 `task.invoke`。
3. 等 AgentClient 回 `result{task_id,status:"dispatched"}` 或 error。
4. 取得远程子任务 ID 后，继续等待 `task.subtask_result`。
5. completed 时把 chunks 转为 MCP tool result。
6. failed/timeout/断线时返回结构化错误，不让工具 Promise 永久挂起。

YwCoder 当前 MCP tool call 层使用长超时（默认约 27.8 小时），不会被 MCP SDK 通用 60 秒默认过早截断。联调时仍需确认 `MCP_TOOL_TIMEOUT` 没有被部署环境设成小于网关 task timeout 的值。

#### 取消与清理

- 父任务 `task.cancel` 时，立即 abort 本地 MCP tool 等待。
- 按 C6 的最终契约取消远程子任务。
- YwCoder 子进程退出时，清理该 session 所有未决委派。
- AgentClient stdin 关闭/网关断线 error 时，所有未决外层 request 失败收尾。
- 迟到/重复 `task.subtask_result` 幂等忽略，仅记 stderr。
- 对未决委派设置与网关 task timeout 一致的长超时，不使用 10 秒级短超时。

#### 并发

- 一个父任务可以有多个并行委派，映射必须按 request/subtask ID，不使用“当前子任务”全局单值。
- 同一 session 的上层 `task.create` 仍然串行；MCP 工具内的并行委派不改变该规则。
- 网关继续负责限制编排深度为 1。shim 也不应对已标记为子任务的输入暴露委派工具。

#### 验收

- 管理者可委派一个或多个群成员，并将结果继续用于父任务回答。
- 非管理者无该 MCP 工具。
- 模型不能伪造 `group_id` / `parent_task_id` / 管理者身份。
- 非群成员、自身、嵌套编排均被拒绝。
- dispatch error、subtask failed、timeout、网关断线、父任务取消均无悬挂 Promise。
- stdout 仍只有合法外层 JSON-RPC JSONL。

### 7.7 阶段 P6：联调、回归与文档

#### 单元测试

- v3 metadata schema 与 UUID。
- workdir 绝对路径、存在性、目录类型、realpath 规范化和同目录等价判断。
- command 解析、headless 命令过滤、权限原生值/兼容别名与 capability fingerprint。
- 通用 YwCoder control request success/error/timeout/child-exit。
- 群上下文序列化和长度护栏。
- MCP initialize/tools-list/tools-call。
- task.invoke dispatch response 与 subtask_result 关联。
- 取消、迟到、重复、断线清理。

#### mock 场景

```text
workdir-default
workdir-two-sessions
workdir-invalid
workdir-realpath
command-model
command-permission
command-compact
command-skill
command-unsupported-local
group-member
group-manager
invoke-success
invoke-parallel
invoke-dispatch-error
invoke-subtask-failed
invoke-timeout
invoke-parent-cancel
```

#### 真实 AgentClient 联调顺序

1. 普通单聊和 M1～M5 回归。
2. 网页设定 workdir。
3. 命令/技能发现。
4. 模型切换。
5. 权限模式切换与网页 confirm。
6. 群聊普通成员。
7. 群管理者单个/并行委派。
8. 停止、超时、断线和子进程强杀。
9. shim 重启后会话恢复。

#### 本地验证命令

```bash
bun run typecheck
bun test src/entrypoints/ywmatrix-shim/
bun run build
bun run smoke
node dist/cli.mjs --version
```

最终必须在 Node.js 18.20.8 下执行构建产物和 shim mock。

## 8. PR 拆分建议

| PR | 内容 | 前置 |
|---|---|---|
| PR-1 | v3 schema、UUID、JSON-RPC response、完整队列状态、fake YwCoder | C1 的消息结构定稿；C2/C4/C7 按推荐默认值推进 |
| PR-2 | workdir policy、多目录 session、显式 transcript 查找 | C4；C5 已关闭 |
| PR-3 | 两级 capability manager、结构化 command、全局 model/permission control | C1；C2/C7 在 Client 联调中验证 |
| PR-4 | group context 注入与身份判定 | C3 |
| PR-5 | SDK MCP delegation bridge、task.invoke/subtask_result | C3/C6 |
| PR-6 | 真 AgentClient 联调修正、完整回归、文档收口 | 前述 PR |

不建议把 PR-1～PR-5 合成一次大改：workdir、控制面和委派桥各自有独立的失败与回退边界。

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| workdir 非法、已删除或不同写法指向同一目录 | 启动失败或误判目录切换 | Client 只下发用户设定目录；shim 校验绝对路径、目录存在性并使用 realpath |
| 同 session 换 workdir | 上下文静默丢失 | 首版锁定；若支持则用 JSONL-path resume + 持久路由 |
| `bypassPermissions`（或 `full_auto` 别名）被远程伪造开启 | 绕过全部权限门 | 启动级 opt-in + capability 白名单 + 页面确认 |
| 项目 capability 无 session 归属 | 不同 workdir 的命令/技能串台 | C1：全局与 session 两级快照，分层替换与去重 |
| 全局模型/权限只更新部分子进程 | session 实际行为与页面 current 不一致 | 全局 settingsVersion；每个 session 在下一任务前强制同步 |
| 群元数据 prompt injection | 模型被名称/元数据误导 | 结构化数据边界 + 长度限制 + 不作权限根据 |
| 模型伪造委派路由字段 | 跨群/跨任务派发 | group/parent/self 均来自 shim 受信状态，不收模型参数 |
| 委派子任务无结果 | 父任务工具永久挂起 | 长超时 + 取消 + 断线/退出统一清理 |
| control response 丢失 | 命令 task 卡住 | request map + 10s 机器超时 + child-exit reject |
| command capability 每任务广播 | 网关和 UI 抖动 | 稳定排序 + fingerprint + 全量去重 |
| Node.js 20+ API 混入 | 目标机器不可运行 | CI 增加 Node 18.20.8 构建/运行矩阵 |

## 10. 完成定义

只有同时满足以下条件，才可标记 v3 适配完成：

1. C1/C3/C6 已定稿，C2/C4/C7 已完成 Client 联调确认，C5 的可信目录输入约束已同步到协议文档。
2. 普通单聊及 M1～M5 全部回归。
3. 两个不同 workdir 的 session 可并发工作并正确续接。
4. 命令/技能按 session/workdir 正确发现；模型/权限作为 Agent 全局设置在所有 session 一致生效。
5. 切回 default 后网页权限确认仍真实生效。
6. 群上下文正确，非管理者无委派工具。
7. 管理者委派的成功、失败、超时、取消、断线全部能收尾。
8. 真实 AgentClient 联调通过，不只是 mock PASS。
9. shim stdout 全程无非协议内容。
10. Node.js 18.20.8 下 build/smoke/shim mock 全部通过。

## 11. 推荐执行顺序

```text
P0 契约冻结
  → P1 协议基线
  → P2 workdir
  → P3 command/model/permission
  → P4 group context
  → P5 delegation
  → P6 真实联调与收口
```

P2 与 P3 在 P1 后可分支开发，但合并前必须统一 `SessionEntry` 数据模型。P5 必须等 P4 的身份与群成员路由稳定后再开始。
