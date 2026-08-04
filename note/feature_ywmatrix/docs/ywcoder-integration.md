# ywcoder 接入管控台 —— 技术方案与字段级映射

> 目标：把 ywcoder-cli 接入管控台，扮演协议中的「本地 Agent」，通过 AgentClient 的 Stdio 适配器接入网关。
> 前置阅读：[architecture.md](architecture.md)、[protocol.md](protocol.md)、[local-agent-interface.md](local-agent-interface.md)。
> 本文所有协议行为均已对 ywcoder v1.2.4（`dist/cli.mjs`）实测验证，依据见 §16。

## 0. 方案概述

ywcoder 内置 Claude Agent SDK 的 `--output-format stream-json` 无头模式：一个上游维护、全保真的 JSONL 事件流协议，自带权限控制面（control protocol）、多轮输入、增量输出、会话续接、usage、中断。

因此接入方案是：**不改 ywcoder 源码，用现成 stream-json 模式 + 一层薄翻译 shim**。shim 对上说管控台协议、对下扮演 SDK client，只做两套协议的纯映射。整个接入退化为「一个伴生翻译进程 + 正确的启动参数」。

| 复用面 | 信封 | 权限控制面 | 保真度 | ywcoder 改动 | 采用 |
|---|---|---|---|---|---|
| gRPC server | 自定义 protobuf | 无（每工具粗暴弹窗） | 仅 text+tool | 已有 | 否（AgentClient 无 gRPC 适配器） |
| **stream-json + shim** | **SDK 原生 schema** | **control protocol** | **全** | **零** | **是** |

## 1. 总体架构

```text
网关 ──WS──► AgentClient(Go,stdio适配器) ──stdin/stdout JSONL(管控台协议)──► ywmatrix-shim
                                                                              │  spawn 子进程
                                                                              │  stdin/stdout JSONL(SDK stream-json)
                                                                              ▼
                                                            ywcoder -p --output-format stream-json ...
```

- **shim 对上**：说管控台的 JSON-RPC（`lifecycle.* / task.* / stream.chunk`），是 AgentClient 眼里的「本地 Agent」。
- **shim 对下**：扮演 SDK client，用 stream-json 与 ywcoder 双向通信；负责两套协议的纯映射。
- shim 维护：`session_id`、`task_id ↔ can_use_tool.request_id ↔ confirm_id` 关联表、每个 pending 权限请求的超时定时器。
- shim 建议用 Node 写（可 import [controlSchemas.ts](../../../src/entrypoints/sdk/controlSchemas.ts) / [coreSchemas.ts](../../../src/entrypoints/sdk/coreSchemas.ts) 做类型校验），或由管控台团队在 AgentClient 内实现同等翻译。

## 2. 启动参数

AgentClient 的 stdio 适配器把 shim 当本地 Agent 拉起：
```
client -adapter stdio -token user:zhangsan -gateway ws://... \
  -local-agent "node /opt/ywmatrix/shim.mjs"
```
shim 内部拉起 ywcoder（完整档）：
```
ywcoder -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --permission-mode default \
  --permission-prompt-tool stdio \
  [--include-partial-messages] \
  [--model <m>] [--fallback-model <m>] \
  --add-dir <workdir>
```

| 参数 | 说明 |
|---|---|
| `--input-format stream-json` | 多轮用户消息以 JSONL 从 stdin 注入 |
| `--output-format stream-json` | 所有事件以 SDKMessage JSONL 从 stdout 输出——**天然保证 stdout 洁净**（无横幅/日志污染，日志走 stderr） |
| `--verbose` | **stream-json 模式的强制前提**，缺失则 ywcoder 启动即报错退出 |
| `--permission-prompt-tool stdio` | **完整档必需**：只有它（或 `--sdk-url`）能让工具权限走 `can_use_tool` 控制面；不加则权限由本地按 permission-mode 判定，被拒工具直接返回 `is_error` 的 tool_result，**不会**向网页发确认 |
| `--include-partial-messages` | 可选：开启后输出 `stream_event` 增量（text/thinking/tool_use 增量）；不开则只输出完整 `assistant` 消息 |
| `--add-dir <workdir>` | 授权工作目录 |

## 3. shim 角色与握手时序

stream-json 双向流上跑两类消息：**数据消息**（SDKMessage）与**控制消息**（control_request/response）。启动后的固定时序：

```text
1. shim → ywcoder   control_request{subtype:'initialize'}          （shim 主动先发）
2. ywcoder → shim   control_response{subtype:'success', response:{commands,agents,models,output_style,account,...}}
3. ywcoder → shim   {type:'system', subtype:'init', session_id, cwd, tools, model, permissionMode, ...}
                    ↑ 真实 session_id 从这里取（不在 initialize response 里）
4. shim → ywcoder   {type:'user', ...}                              （此后才能发任务）
```

- 数据方向：读 ywcoder stdout 的 SDKMessage → 翻成管控台 `stream.chunk`；管控台 `task.create` → 翻成 stdin 的 user message。
- 控制方向：ywcoder 需要权限时发 `control_request{can_use_tool}` → shim 翻成 `confirm_required`；网页 `task.respond` → shim 回 `control_response`。

## 4. 字段级映射 —— 输出方向（ywcoder SDKMessage → 管控台 stream.chunk）

所有输出 chunk 回填 `task_id` / `session_id`，`content` 用 typed content 数组。

| ywcoder 输出（SDKMessage） | 判定 | 管控台输出 |
|---|---|---|
| `{type:'system',subtype:'init',session_id,...}` | 握手后首条数据消息 | shim 记录 `session_id`；触发 `lifecycle.register`（见 §7）；不直接转发 |
| `{type:'stream_event',event:{...content_block_delta,delta:{type:'text_delta',text}}}` | 文本增量（需开 partial） | `stream.chunk type:"text"`, `content:[{type:"text",text}]`, `done:false` |
| `{...delta:{type:'thinking_delta',thinking}}` | 思考增量（需开 partial） | `stream.chunk type:"thinking"`, `content:[{type:"text",text:thinking}]` |
| `{...delta:{type:'input_json_delta',partial_json}}` | 工具入参增量 | 忽略；用完整 tool_use（下行）即可 |
| `{type:'assistant',message:{content:[{type:'tool_use',id,name,input}]}}` | 工具调用 | `stream.chunk type:"action"`, `name`, `arguments:input`（记录 `id→name`） |
| `{type:'assistant',message:{content:[{type:'text',text}]}}` | 完整文本 | `stream.chunk type:"text"`（开了 partial 则以增量为准，见 §11 去重） |
| `{type:'user',message:{content:[{type:'tool_result',tool_use_id,content,is_error}]}}` | 工具结果 | `stream.chunk type:"result"`, `name:map[tool_use_id]`, `content:[...]`；`is_error` 见 §10 |
| `{type:'result',subtype:'success',result,usage,total_cost_usd,session_id}` | 任务成功 | 补 `stream.chunk done:true` + `task.completed`（summary=result；usage/cost 放 metadata） |
| `{type:'result',subtype:'error_during_execution'\|'error_max_turns'\|'error_max_budget_usd',errors}` | 任务失败 | `event.error{code:"LOCAL_AGENT_ERROR",message:errors.join}` + 结束 task |

> **工具由 ywcoder 自己执行**（[query.ts:1379](../../../src/query.ts#L1379) `runTools`，`canUseTool` 仅为权限门）。`assistant{tool_use}` 之后的 `user{tool_result}` 是 **ywcoder 自己产出的观测输出**，shim 收到 `tool_use` 时**只做展示翻译，绝不代为执行工具或注入 tool_result**——否则会破坏 ywcoder 内部工具状态机与 usage/计费统计。完整档下也一样：shim 回 `allow` 后由 ywcoder 执行。官方参考实现见 [sessionRunner.ts:483](../../../src/bridge/sessionRunner.ts#L483)（对 `user` 消息只观测、不注入）。
>
> `tool_result.content` 可能是字符串或 content block 数组（含 image/resource），可透传为对应 typed content；MVP 只处理文本。

## 5. 字段级映射 —— 输入方向（管控台 task.create → ywcoder stdin）

管控台 `task.create.params` → 写一条 SDK user message 到 ywcoder stdin：
```json
{ "type":"user",
  "message":{ "role":"user", "content":"<task.create.params.content>" },
  "parent_tool_use_id":null }
```

| 管控台字段 | shim 处理 |
|---|---|
| `content` | 上面 user message 的 `message.content` |
| `task_id` | shim 侧维护「当前活动 task_id」，回填到所有输出与控制关联 |
| `session_id` | 来自 `system/init.session_id`；跨连接续接用 `--resume <id>`（见 §9） |
| `context_id` | 多会话隔离见 §9；MVP 可等同 session |
| `history` | 通常无需——同一 stream-json 会话已保上下文；如需可展开为多条 user message |
| `type:chat` | 新 user message；`type:respond` → §6.2 走控制面 |
| `model` | 启动参数，或运行时 `control_request{set_model}` |
| `timeout` | shim 起定时器，超时发 `control_request{interrupt}` + `event.error(-32001)` |

## 6. 字段级映射 —— 控制面（control protocol ↔ 管控台）

### 6.1 初始化握手

**shim → ywcoder**（stdin，spawn 后第一件事）：
```json
{ "type":"control_request", "request_id":"init-1",
  "request":{ "subtype":"initialize" } }
```
**ywcoder → shim**（stdout）：
```json
{ "type":"control_response", "response":{ "subtype":"success", "request_id":"init-1",
  "response":{ "commands":[...], "agents":[...], "models":[...],
               "output_style":"...", "available_output_styles":[...], "account":{...} } }}
```
收到 success 后 shim 进入 idle，等待管控台 `task.create`。真实 `session_id` 从随后的 `system/init` 取。

### 6.2 权限确认：`can_use_tool` ↔ `confirm_required` ↔ `task.respond`

**ywcoder → shim**（仅在 `--permission-prompt-tool stdio` 下、且工具需批准时发出）：
```json
{ "type":"control_request", "request_id":"<rid>",
  "request":{ "subtype":"can_use_tool", "tool_name":"Bash",
    "input":{...}, "tool_use_id":"tool_...",
    "permission_suggestions":[{"type":"addRules","rules":[...],"behavior":"allow","destination":"localSettings"}],
    "decision_reason":"...", "title":"...", "description":"..." } }
```
**shim → 管控台**：
```json
{ "jsonrpc":"2.0","method":"stream.chunk","params":{
  "task_id":"...","session_id":"...",
  "type":"confirm_required","confirm_id":"<rid>",
  "title":"执行 Bash", "content":[{"type":"text","text":"<input 摘要>"}],
  "level":"dangerous", "timeout":<shim 自设> }}
```
**管控台 → shim**：`task.respond`
```json
{ "jsonrpc":"2.0","id":"...","method":"task.respond","params":{
  "task_id":"...","confirm_id":"<rid>","response":"确认" }}
```
**shim → ywcoder**（stdin），三种语义：
```json
// ① 允许本次工具
{ "type":"control_response","response":{ "subtype":"success","request_id":"<rid>",
  "response":{ "behavior":"allow", "updatedInput":{} } }}
// ② 仅拒绝本次工具（模型继续对话）
{ "type":"control_response","response":{ "subtype":"success","request_id":"<rid>",
  "response":{ "behavior":"deny", "message":"用户在管控台拒绝" } }}
// ③ 拒绝并中断整个任务
{ "type":"control_response","response":{ "subtype":"success","request_id":"<rid>",
  "response":{ "behavior":"deny", "message":"用户取消任务", "interrupt":true } }}
```

**allow 的两条硬约束（务必遵守）：**
1. `updatedInput` **必填**（stdio 路径的 schema 要求）。传空对象 `{}` 表示「用原始入参」；除非管控台要改写入参，一律回 `{}`。
2. **绝不回传 `updatedPermissions`**。`can_use_tool` 里的 `permission_suggestions` 是「把该命令永久加白名单」的建议；一旦作为 `updatedPermissions` 回传，会被 ywcoder [持久化落盘](../../../src/utils/permissions/PermissionPromptToolResultSchema.ts#L96)，使「本次允许」静默变成「永久允许」。远程场景下这是危险默认，shim 必须丢弃该建议。

### 6.3 取消：`task.cancel` → `interrupt`

管控台 `task.cancel` → shim 发 `{type:'control_request',request_id:'<new>',request:{subtype:'interrupt'}}`（ywcoder 内部处理，中断当前轮）。

## 7. lifecycle / capabilities（shim 面向管控台补齐）

stream-json 无「注册」概念，由 shim 补：
- `lifecycle.initialize`（AgentClient→shim）：shim 回固定能力集 `{chat,streaming,confirmations,prompts}` + `serverInfo{name:"ywcoder",version}`。
- `lifecycle.register`（shim→AgentClient，收到 `initialized` 后主动发）：`capabilities:[{type:"chat",name:"coding",description:"编码助手，可读写文件、执行命令、分析代码"}]`，`platform` 用 `process.platform/arch/hostname`。
- `lifecycle.ping` → shim 本地应答 `{status:"ok",timestamp}`（不透传给 ywcoder）。
- `lifecycle.status`：任务开始/结束时 shim 主动发 `busy/idle`；ywcoder `result{error_*}` 或子进程异常时发 `error`。

## 8. 权限模型与安全边界

### 8.1 权限触发规则（实测）

| 工具类别 | 行为 |
|---|---|
| 只读工具（Read/Glob/Grep 等） | 自动放行，不触发确认 |
| 只读 Bash（如 `pwd`、`ls`） | 工作目录内自动放行 |
| 网络 / 子 shell 类 Bash（如 `curl`、`bash -c "..."`） | 触发 `can_use_tool`，需确认 |
| 删除 / 写盘类 Bash（如 `rm`、`rm -rf`、重定向写文件） | 触发 `can_use_tool`（按目标路径判定，请求带 `blocked_path`）；**allow 后真实且不可逆执行**（实测 `rm`/`rm -rf` 工作目录内外均触发确认，allow 后目标被删除） |
| 写操作（Write/Edit） | 受 permission-mode 影响：`default` 下若无控制面则直接 `is_error` 失败；`default + stdio` 下触发确认；`acceptEdits`/`bypassPermissions` 自动放行 |

Bash 的判定由共享子系统完成（[bashCommandHelpers.ts](../../../src/tools/BashTool/bashCommandHelpers.ts) 拆段逐段过权限、[modeValidation.ts](../../../src/tools/BashTool/modeValidation.ts) 区分只读/需批准、[bashSecurity.ts](../../../src/tools/BashTool/bashSecurity.ts) 查注入），stream-json 与终端模式**共用同一判定核心**，只是确认交付方式不同（`can_use_tool` vs 终端 UI）。

### 8.2 两档策略

- **简单档（受控内网 / MVP）**：`--permission-mode acceptEdits` 或 `bypassPermissions`，shim 不实现控制面，纯做输出翻译。
- **完整档**：`--permission-mode default --permission-prompt-tool stdio`，shim 实现 §6.2 控制面，网页二次确认。partial 可选。

### 8.3 shim/管控台侧硬约束（安全关键）

1. **必须自建 Bash 命令安全策略，并慎重对待 allow**。ywcoder 默认权限对只读放行，对网络/子 shell、以及写/删除类命令（`rm`、`rm -rf`、重定向写盘等，按目标路径判定）会触发 `can_use_tool`。已实测 `rm`/`rm -rf` 确实触发确认，**且 shim 回 allow 后文件/目录被真实且不可逆删除**。因此：`confirm_required` 到网页时必须如实呈现命令与危险级别（allow 即真执行，无二次兜底）；远程被驱动场景建议在 shim/管控台层再叠加独立命令白/黑名单做纵深防御；**不能仅依赖模型自律**（模型可能自我克制、也可能直接执行）。
2. **必须自实现确认超时**。ywcoder 对 pending 的 `can_use_tool` **没有默认超时**（无人应答会永久挂起、既不出 result 也不执行）。shim 应对每个 `confirm_required` 设超时（如 30s），到期自动回 `deny` 或按策略处理。
3. **allow 不回传 `updatedPermissions`**（见 §6.2）。
4. **续接不保留权限**：`--resume` 后每次工具调用仍重新确认（见 §9），不会因上次 allow 而免确认——设计上安全，但需预期确认频次。

## 9. 会话与上下文

| 能力 | 行为（实测） |
|---|---|
| `session_id` 来源 | `system/init.session_id`（非 initialize response） |
| 同进程续接 | 同一子进程内多轮 user message 天然维持上下文 |
| 跨进程续接 | kill 原进程 → `--resume <session_id>` 起新进程 → **需重新走 initialize 握手** → session_id 与历史一致 |
| `--resume` 入参 | 支持 `<session_id>`，也支持 `<jsonl 文件路径>`（可跨目录续接） |
| 多会话并发 | 一个 shim 同时管理多个独立 ywcoder 子进程，session 互相隔离 |
| 续接后权限状态 | **不保留**，每次工具调用重新确认 |

`context_id` → 用「多个独立子进程 / `--resume` 续接」实现分组隔离；`task_id` → shim 关联表键，回填所有输出与 `confirm_id`。

## 10. 错误码映射

| 情况 | 输出 |
|---|---|
| shim 收到非法 JSON / 未知 method | JSON-RPC `-32700` / `-32601` |
| `task.respond`/`cancel` 的 task_id 不存在 | `-32000` |
| 确认超时（shim 定时器） | 按策略 `deny` 或 `interrupt` + `event.error`/`-32001` |
| 用户仅拒绝确认 | `control_response{deny}`，模型继续；ywcoder 产出 `is_error:true` 的 tool_result |
| 用户中断任务 | `control_response{deny,interrupt:true}` → ywcoder `result{subtype:error_during_execution}` |
| 工具执行失败（tool_result.is_error） | `stream.chunk type:"result"` 携带错误文本 |
| `result.subtype` 为 error_* | `event.error{code:"LOCAL_AGENT_ERROR"}` |
| ywcoder 子进程异常退出 | `event.error{recoverable:false}` + 上报 offline |

## 11. 增量输出去重

开启 `--include-partial-messages` 后，ywcoder **同时**输出 `stream_event` 增量与完整 `assistant` 消息（实测一次问答约 209 条增量 + 8 条完整）。shim 二选一：
- **开 partial**：以 `stream_event` 增量渲染流式效果，**忽略随后的完整 `assistant`**（避免重复）；工具调用仍以完整 `assistant` 的 `tool_use` 为准。
- **不开 partial（推荐 MVP）**：只处理完整 `assistant` 消息，逻辑最简。

## 12. 备选方案

- **`--sdk-url ws://...`**：ywcoder 可把 stream-json I/O 直连 WebSocket（会自动启用 stdio 权限控制面），省掉 stdio 桥接；但对端仍是 SDK schema，翻译层只是从 shim 挪到该 WS 端点。管控台若愿在网关侧翻译可考虑。
- **AgentClient 内置翻译（Go）**：把 §4~§6 映射写进 AgentClient 的「ywcoder/SDK 适配器」，省掉独立 shim 进程；需管控台团队配合。

## 13. 分阶段实施与估时

**简单档 MVP（约 2~3 天）**——ywcoder 零改动
1. shim 骨架：spawn、按行读写 JSONL、stdout 原子写 —— 0.5d
2. initialize 握手 + `session_id` 抓取 + lifecycle/register —— 0.5d
3. 输出翻译 §4（text/action/result/completed）+ 输入翻译 §5 —— 1d
4. 固定 `acceptEdits`/`bypassPermissions`，对接 demo 网关联调 —— 1d

**完整档（+3~4 天）**
5. 控制面：initialize 之外的 `can_use_tool ↔ confirm_required ↔ task.respond`（allow/deny/deny+interrupt）—— 1.5d
6. shim 硬约束：确认超时、丢弃 updatedPermissions、Bash 独立命令策略 —— 1d
7. `task.cancel`/interrupt、thinking、partial 去重、`--resume` 多会话隔离 —— 1~1.5d

**生产强化**：Token 透传、多进程池与路由、审计日志、跨平台打包（见 §14）、`stream.artifact`/`block_required`（高级）。

## 14. 风险

1. **跨平台打包（最大不确定性）**：管控台目标含麒麟 arm64/loong64、Win7。ywcoder 是 Node/Bun 产物，需实测这些平台运行时；shim 若为 Node 同此约束。必要时 `bun build --compile` 打单文件。
2. **Bash 安全边界**：见 §8.3——写/删除/网络类命令会触发确认，但 allow 即真实（不可逆）执行；模型自律不可依赖，须自建命令策略并在网页确认时如实呈现危险级别。
3. **多任务并发**：单个 stream-json 会话串行；并发靠多子进程 + cwd/session 隔离，shim 需进程池与路由。
4. **schema 漂移**：stream-json 是上游契约、较稳，升级 ywcoder 后仍应回归 §4~§6 映射；shim import 官方 zod schema 可在解析层早发现不兼容。

## 15. 速查对照表

| 管控台协议 | ywcoder stream-json |
|---|---|
| `lifecycle.initialize/register/ping` | shim 本地补齐 |
| （握手）| shim 先发 `control_request{initialize}` → ywcoder 回 `control_response` → `system/init` |
| `task.create.content` | stdin：`{type:'user',message:{role:'user',content}}` |
| `stream.chunk`(text/thinking) | `stream_event` 的 text_delta/thinking_delta（需 partial） |
| `stream.chunk`(action) | assistant 消息的 `tool_use` 块 |
| `stream.chunk`(result) | user 消息的 `tool_result` 块（ywcoder 自产） |
| `confirm_required` | `control_request{can_use_tool}`（需 `--permission-prompt-tool stdio`） |
| `task.respond`(允许/拒绝/取消) | `control_response{allow, updatedInput:{}}` / `{deny,message}` / `{deny,message,interrupt:true}` |
| `task.cancel` | `control_request{interrupt}` |
| `task.completed` | `result{subtype:success}` |
| `event.error` | `result{subtype:error_*}` / 子进程异常 |

## 16. 源码与实测依据

**源码：**
- `--verbose` 强制：[print.ts:788-794](../../../src/cli/print.ts#L788)
- 权限路由（`stdio` 走控制面 / 无则本地判定）：[print.ts:4274](../../../src/cli/print.ts#L4274) `getCanUseToolFn`
- initialize 请求处理：[print.ts:2864](../../../src/cli/print.ts#L2864)
- allow 必填 updatedInput / `{}` 回退原始 / updatedPermissions 持久化：[PermissionPromptToolResultSchema.ts:44-127](../../../src/utils/permissions/PermissionPromptToolResultSchema.ts#L44)
- deny+interrupt 实现：[PermissionPromptToolResultSchema.ts:117](../../../src/utils/permissions/PermissionPromptToolResultSchema.ts#L117)
- 工具内部执行：[query.ts:1379](../../../src/query.ts#L1379)；参考实现：[sessionRunner.ts:483](../../../src/bridge/sessionRunner.ts#L483)
- Bash 权限子系统：[bashCommandHelpers.ts](../../../src/tools/BashTool/bashCommandHelpers.ts)、[modeValidation.ts](../../../src/tools/BashTool/modeValidation.ts)、[bashSecurity.ts](../../../src/tools/BashTool/bashSecurity.ts)

**实测覆盖**（脚本与日志见 `/Users/sijia/code/2026/test/ywmatrix-verify/`）：Read/Bash/Write/Glob 工具流程、initialize 握手、default/default+stdio/acceptEdits/bypassPermissions 权限矩阵、危险 Bash（curl/子 shell 触发确认；`rm`/`rm -rf` 工作目录内外均触发确认、allow 后真实删除）、`can_use_tool` 无超时、deny vs deny+interrupt、同进程/跨进程/JSONL 续接、多会话并发、续接不保留权限、partial 增量输出。
