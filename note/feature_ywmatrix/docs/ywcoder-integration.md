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
网关 ──WS──► AgentClient(通用 Stdio JSONL 适配器) ──stdin/stdout JSONL(本地-agent 协议)──► ywmatrix-shim
   (管控台侧，Node)   外连/心跳/重连/spawn 托管                                        │  spawn 子进程
                                                                                     │  stdin/stdout JSONL(SDK stream-json)
                                                                                     ▼
                                                            ywcoder -p --output-format stream-json ...
```

**职责划分（已定）：**
- **AgentClient**（管控台侧，Node，**通用 Stdio JSONL 适配器**，为适配多种 agent 而通用）：负责外连网关、心跳、重连，并 **spawn + 托管**本地 agent，通过 stdio 说 protocol.md 的本地-agent 协议（`lifecycle.* / task.* / stream.chunk`）。连接层不是我们的事。
- **shim**（ywcoder 侧，**随 ywcoder 打包交付**）：就是 AgentClient spawn 的那个「本地 agent」。
  - 对上：说本地-agent 协议（`lifecycle.* / task.* / stream.chunk`）。
  - 对下：扮演 SDK client，用 stream-json 与 ywcoder 子进程双向通信；负责两套协议的纯映射。
  - 维护：`session_id`、`task_id ↔ can_use_tool.request_id ↔ confirm_id` 关联表、每个 pending 权限请求的超时定时器。
  - 用 Node 写，可 import [controlSchemas.ts](../../../src/entrypoints/sdk/controlSchemas.ts) / [coreSchemas.ts](../../../src/entrypoints/sdk/coreSchemas.ts) 做类型校验。

**打包（已定）**：shim 是 **ywcoder 交付物的一部分**（作为 ywcoder-cli 包里的一个附带入口，如 `dist/shim.mjs` 或 bin `ywcoder-ywmatrix`），**ywcoder 运行时零改动**（不碰 `cli.mjs`/`main.tsx`）。用户终端安装：ywcoder（含 shim）+ AgentClient，共两件，无新增运行时（Node 本就为 ywcoder 装）。

## 2. 启动参数

AgentClient（通用 stdio 适配器）把 shim 当本地 Agent 拉起（已与 AgentClient 团队定，见 §17-A）：
```json
{
  "command": "ywcoder-ywmatrix",
  "args": ["--workdir", "/path/to/project", "--permission-mode", "default"],
  "cwd": "/path/to/project"
}
```
- AgentClient 保持通用：只透传 `command/args/cwd`，不解释 args 含义。
- shim 的 args：`--workdir`（shim 据此设 ywcoder 的 cwd 与 `--add-dir`）、`--permission-mode`（用 ywcoder 真实取值 `default/acceptEdits/bypassPermissions`）。
- env 整体继承 AgentClient；需 AgentClient **以正确用户身份启动**，保证 `HOME/USER/PATH` 正确（供 ywcoder 读本地配置/凭证，见 §17-B）。

shim 内部据 args 用 ywcoder **真实 flag** 拉起（`--permission-mode default` 时 shim **自动补 `--permission-prompt-tool stdio`** 并启用控制面）：
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
                    ↑ 收到 success 即 READY，可发用户消息（不要等 system/init，否则死锁）
3. shim → ywcoder   {type:'user', ...}
4. ywcoder → shim   {type:'system', subtype:'init', session_id, ...}（处理第一条 user 时才产出，仅回显校验 session_id）
5. ywcoder → shim   assistant / tool_use / tool_result / result ...
```

> ⚠️ **实测修正**：`system/init` **不是** initialize 后主动推送，而是 ywcoder 处理**第一条用户消息**时才产出（[QueryEngine.ts:541](../../../src/QueryEngine.ts#L541)，在 `submitMessage` 生成器内 yield）。因此 **ready 判据是 `control_response{success}`，不是 system/init**——等 system/init 才发消息会死锁。`session_id` 由 shim 经 `--session-id` 主动设定（§9.2），system/init 里的 session_id **仅作回显校验**，不是唯一来源。

- 数据方向：读 ywcoder stdout 的 SDKMessage → 翻成管控台 `stream.chunk`；管控台 `task.create` → 翻成 stdin 的 user message。
- 控制方向：ywcoder 需要权限时发 `control_request{can_use_tool}` → shim 翻成 `confirm_required`；网页 `task.respond` → shim 回 `control_response`。

## 4. 字段级映射 —— 输出方向（ywcoder SDKMessage → 管控台 stream.chunk）

所有输出 chunk 回填 `task_id` / `session_id`，`content` 用 typed content 数组。

| ywcoder 输出（SDKMessage） | 判定 | 管控台输出 |
|---|---|---|
| `{type:'system',subtype:'init',session_id,...}` | 处理**第一条 user 后**才产出（非握手期，见 §3） | 仅回显校验 `session_id`；不作 ready 判据、不转发。**schema 校验从宽**：ywcoder 的 `SDKSystemMessageSchema` 可能与运行时漂移（如 `apiKeySource` 枚举缺 `none`），校验失败只告警、不丢消息 |
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

每条 `task.create` **必带 `session_id` + `task_id`**（并发多会话靠它路由，见 §9）。

| 管控台字段 | shim 处理 |
|---|---|
| `content` | 对应 session 的 ywcoder 子进程 stdin，写 user message 的 `message.content` |
| `session_id` | **路由键**（见 §9.2）：首条 task **不带 session_id** → shim mint 一个 UUID、`--session-id` 启动、并回填到 ack/输出供管控台采纳；后续带该 id → 路由到存活子进程或 `--resume` |
| `task_id` | 回填到该 session 所有输出与控制关联；同一 session 内多个 task 串行 |
| `context_id` | 多会话分组见 §9；MVP 可等同 session |
| `history` | 通常无需——同一 ywcoder 会话已保上下文 |
| `type:chat` | 新 user message；`type:respond` → §6.2 走控制面 |
| `model` | 启动参数，或运行时 `control_request{set_model}` |
| `timeout` | **不在 shim 处理**：任务超时由网关/AgentClient 侧统一控制（`-task-timeout`，见 §17-H，建议调至 30~60min） |

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
**收到 success 即 READY**（可发用户消息），进入 idle 等 `task.create`。**不要等 `system/init`**——它要处理第一条用户消息时才产出（见 §3）。`session_id` 由 shim 经 `--session-id` 设定（§9.2），system/init 仅回显校验。

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
  "level":"dangerous" }}
```
- `confirm_id` **就是** ywcoder 的 `request_id`（原样透传，回复时直接用于 `control_response`）。
- `title` 取请求里的 `title`，缺省 `执行 <tool_name>`；`content` = 入参摘要（Bash 给完整命令、Write 给路径+内容、其余 JSON 摘要，超长截断）+ `description`/`blocked_path`/`decision_reason`。
- `level` 由 shim 推断：`blocked_path` 存在 → `dangerous`；Bash 命中危险特征（`rm/sudo/dd/mkfs/chmod/chown/curl/wget/ssh/scp/nc/shutdown/reboot`）→ `dangerous`，其余 Bash → `warning`；Write/Edit/MultiEdit/NotebookEdit、WebFetch/WebSearch → `warning`；其余 → `info`。**这是给人看的危险提示，不是安全策略**（真正判定在 ywcoder 侧，见 §8.3）。
- **不带 `timeout` 字段**：confirm 不设 shim 短超时（§8.3 硬约束 2）。
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

**⚠️ `response` → 三种语义的映射约定（shim 已实现，待与 AgentClient 最终确认）**

协议只规定 `response` 是「字符串或结构化对象」（[protocol.md](protocol.md) §7.7），没规定取值。shim 的归一规则：

| 管控台回复 `response`（去空白、不分大小写） | 裁决 | 发给 ywcoder |
|---|---|---|
| `确认`/`确定`/`允许`/`同意`/`批准`/`是`/`yes`/`ok`/`allow`/`approve`/`confirm`/`accept` | allow | ① `{behavior:'allow',updatedInput:{}}` |
| `拒绝`/`不允许`/`否`/`跳过`/`no`/`deny`/`reject`/`decline`/`skip` | deny | ② `{behavior:'deny',message:<原文>}` |
| **裸** `取消`/`cancel` | deny（**不中止任务**） | ② |
| `取消任务`/`中止`/`中断`/`终止`/`停止`/`abort`/`interrupt`/`stop`/`terminate` | cancel | ③ `{behavior:'deny',message,interrupt:true}` |
| 结构化 `{decision\|action\|behavior\|result\|choice: "allow"\|"deny"\|"cancel", message\|reason?}` | 同字面 | 同上（结构化的 `cancel` **就是**中止任务） |
| 其它任意文本 / 无裁决字段的对象 | deny | ②，**原文作为拒绝理由**回传给模型 |

两条刻意的取舍：
1. **裸「取消」只拒绝本次工具，不中止任务**——网页确认框的「取消」按钮通常表达「别做这个操作」；要中止整轮请用「取消任务」、结构化 `{decision:'cancel'}` 或 `task.cancel`（§6.3）。
2. **无法识别的回复一律 deny**，绝不因歧义放行。

> ⏳ 需 AgentClient 确认：网页「确认/取消」按钮实际回传什么字面值，以及是否愿意改用结构化 `{decision, message}`（推荐，无歧义）。若字面值与上表不符，只需改 shim 的词表（`protocol.ts` 的 `ALLOW_WORDS/DENY_WORDS/ABORT_WORDS`）。

**其它已实现的控制面行为：**
- `task.create{type:'respond', confirm_id, content}` 等价于 `task.respond`（§5），走同一条裁决路径。
- `task.respond` 的 `confirm_id` 不存在/已回复/已被撤销 → JSON-RPC `-32000`（§10）。
- ywcoder 撤销待决权限请求（`control_cancel_request`，如 `interrupt` 触发 abort）→ shim 清理 `confirm_id` 映射；协议上无对应消息，网页侧的悬挂确认框由管控台自行处理（**待确认**）。
- ywcoder 发来的**其它** `control_request` subtype（`hook_callback`/`mcp_message` 等）→ shim 回 `control_response{subtype:'error'}`；不能静默忽略，ywcoder 的 pending 请求没有自超时。
- `result.permission_denials` 透传进 `task.completed.metadata.permission_denials`，供管控台核对「拒绝确实生效」。

**allow 的两条硬约束（务必遵守）：**
1. `updatedInput` **必填**（stdio 路径的 schema 要求）。传空对象 `{}` 表示「用原始入参」；除非管控台要改写入参，一律回 `{}`。
2. **绝不回传 `updatedPermissions`**。`can_use_tool` 里的 `permission_suggestions` 是「把该命令永久加白名单」的建议；一旦作为 `updatedPermissions` 回传，会被 ywcoder [持久化落盘](../../../src/utils/permissions/PermissionPromptToolResultSchema.ts#L96)，使「本次允许」静默变成「永久允许」。远程场景下这是危险默认，shim 必须丢弃该建议。

### 6.3 取消：`task.cancel` → `interrupt`

管控台 `task.cancel`（带 `session_id`/`task_id`）→ shim 对**对应 session 的 ywcoder 子进程**发 `{type:'control_request',request_id:'<new>',request:{subtype:'interrupt'}}`（ywcoder 内部中断当前轮；必要时 kill 子进程）。

> ⚠️ **已知缺口（需 AgentClient 侧修）**：当前 stdio 模式下,用户点「停止」时 AgentClient 只关闭本地 chunk 队列,**不会把取消传到 shim**——shim 与 ywcoder 子进程仍在跑,继续烧 API/token 且后续输出被静默丢弃。修法：AgentClient 停止时**补发一行 `task.cancel` 给 shim**（对齐 HTTP 模式的 abort 语义），shim 再按上面转成 `interrupt`。这条不修则「停止」是假的（见 §17-H）。

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

**档位如何指定（已定）：**
- 通过 shim 的 **`--permission-mode` 参数**指定，取 ywcoder 真实值 `default`/`acceptEdits`/`bypassPermissions`；由 AgentClient 在 `args` 里透传（AgentClient 只转发、不解释，故通用性不破，见 §2）。
- shim 据此派生：`default` → 追加 `--permission-prompt-tool stdio` + 启用控制面（完整档）；`acceptEdits`/`bypassPermissions` → 不启用控制面（简单档）。
- **默认/建议值**：MVP 用 `bypassPermissions`/`acceptEdits`（先跑通）；**生产建议 `default`**——危险操作弹网页确认更安全。
- ⚠️ **注意**：`bypassPermissions` 会**关掉全部权限门**，此时 §8.3「依赖 ywcoder 权限控制」不成立（无控制可依赖）。要靠 ywcoder 拦危险命令,必须用 `default`。
- （可选）运行时动态切：SDK 控制面的 `set_permission_mode` control_request。

### 8.3 shim/管控台侧硬约束（安全关键）

1. **必须自建 Bash 命令安全策略，并慎重对待 allow**。ywcoder 默认权限对只读放行，对网络/子 shell、以及写/删除类命令（`rm`、`rm -rf`、重定向写盘等，按目标路径判定）会触发 `can_use_tool`。已实测 `rm`/`rm -rf` 确实触发确认，**且 shim 回 allow 后文件/目录被真实且不可逆删除**。因此：`confirm_required` 到网页时必须如实呈现命令与危险级别（allow 即真执行，无二次兜底）；远程被驱动场景建议在 shim/管控台层再叠加独立命令白/黑名单做纵深防御；**不能仅依赖模型自律**（模型可能自我克制、也可能直接执行）。
2. **超时不由 shim 持有短计时器**。任务时长超时归网关（`-task-timeout`，见 §17-H）；confirm 确认**不设 shim 短超时**——人在回路本就该等人（尤其手机端/异步），快速自动 deny 会误杀正常操作。ywcoder 对 pending `can_use_tool` 虽无默认超时，但"永久挂起"已被 **网关 task-timeout + 手动取消**兜住（到点砍任务 → `task.cancel` → shim `interrupt`），有明确上界。若确需 confirm 级上限，设**长的、可配置的（分钟级），默认 deny**，而非 30s。前提：网关 task-timeout 生效 + stdio 取消缺口已修（§6.3）。
3. **allow 不回传 `updatedPermissions`**（见 §6.2）。
4. **续接不保留权限**：`--resume` 后每次工具调用仍重新确认（见 §9），不会因上次 allow 而免确认——设计上安全，但需预期确认频次。

### 9.1 并发与会话路由（已定）

- AgentClient 只 spawn **一个 shim 实例**，所有 `task.create` 都发给它；每条**必带 `session_id` + `task_id`**。
- shim 维护 `session_id → ywcoder 子进程` 映射：
  - **同一 `session_id`** 的多个 task 路由到**同一个 ywcoder 子进程内串行**；
  - **不同 `session_id`** 各起**独立 ywcoder 子进程**，互不干扰。
- 上对 AgentClient 是**一条多路复用的 stdio**：每行输出必带 `session_id`+`task_id`、**整行原子写**，供 AgentClient demux。

### 9.2 session_id 对齐（关键，已定）

**模型：ywcoder 侧拥有 session_id，管控台采纳**（stdio 模式经 `task.create`，不走页面 `session.create`）。

- **第一条 `task.create` 不带 `session_id`** → shim **mint 一个 UUID**、以 `ywcoder --session-id <uuid>` 启动、并在 **ack 与所有输出中回填该 `session_id`** → 管控台采纳，后续 task.create 都带它。
  - 好处：id 由我方产、**保证 UUID**、立即可回传（不依赖 system/init 时序）；网关的 `{task_id}-session` 兜底（`gateway.ts:839`，非 UUID）**因此永不触发**。
- **后续 `task.create` 带该 UUID** → 路由到同一**存活子进程**直接发消息；子进程已回收 → `ywcoder --resume <uuid>`（是 ywcoder 自己的 id，直接可用）。

```js
// 会话路由键 = task.create.session_id（任意字符串都能当 key）
if (!session_id) {                      // 首条：建会话
  const uuid = mintUuid()
  spawn ywcoder --session-id <uuid>     // 保证 UUID
  回填 uuid 到 ack + 所有输出            // 管控台采纳
} else if (有存活子进程[session_id]) {
  send user message                      // 同会话续发
} else if (isUuid(session_id) && sessionIdExists(session_id)) {
  spawn ywcoder --resume <session_id>    // 子进程回收后续接
} else if (isUuid(session_id)) {
  spawn ywcoder --session-id <session_id> // 采纳一个 UUID（含 shim 重启后首见）
} else {
  spawn ywcoder                          // 防御：非 UUID（不该出现）→ 一次性，不续接
}
```

`--session-id` **已实测确认**（[main.tsx:995](../../../src/main.tsx#L995)）：传入 `--session-id <UUID>` 后 `system/init.session_id` 如实回显；已存在时 `--resume <UUID>` 正常续接。约束：**必须合法 UUID**（[main.tsx:1285](../../../src/main.tsx#L1285) 硬校验）；**id 本地不能已存在**（[main.tsx:1292](../../../src/main.tsx#L1292) `sessionIdExists` = 查 `<projectDir>/<id>.jsonl`，故存在时走 `--resume`）；**不与 `--resume`/`--continue` 混用**（[main.tsx:1276](../../../src/main.tsx#L1276)）。

> 因 id 由我方生成且恒为 UUID，**无需持久化映射、无需"确认管控台 id 为 UUID"**。只要 shim 首条任务必回传一个 UUID，就不会落到网关非 UUID 兜底。

### 9.3 续接（实测）

| 能力 | 行为 |
|---|---|
| 跨进程续接 | kill 原子进程 → `--resume <session_id>` 起新子进程 → 重走 initialize 握手 → 历史恢复、id 一致 |
| `--resume` 入参 | 支持 `<session_id>`，也支持 `<jsonl 文件路径>`（跨目录续接） |
| 续接后权限状态 | **不保留**，每次工具调用重新确认（设计上安全，需预期确认频次） |

`context_id` → 多会话分组，用多子进程/`--resume` 实现；`task_id` → 回填所有输出与 `confirm_id`。

## 10. 错误码映射

| 情况 | 输出 |
|---|---|
| shim 收到非法 JSON / 未知 method | JSON-RPC `-32700` / `-32601` |
| `task.cancel` 的 task_id 不存在 / `task.respond` 的 confirm_id 不存在（含已回复、已被撤销） | `-32000` |
| 任务超时（网关 `-task-timeout`，shim 不设计时器） | 网关发 done+error=timeout → `task.cancel` 到 shim → 对应 ywcoder 子进程 `interrupt` |
| 用户仅拒绝确认 | `control_response{deny}`，模型继续；ywcoder 产出 `is_error:true` 的 tool_result |
| 用户中断任务 | `control_response{deny,interrupt:true}` → ywcoder `result{subtype:error_during_execution}` |
| 工具执行失败（tool_result.is_error） | `stream.chunk type:"result"` 携带错误文本 |
| `result.subtype` 为 error_* | `event.error{code:"LOCAL_AGENT_ERROR"}` |
| ywcoder 子进程异常退出 | `event.error{recoverable:false}` + 上报 offline |

## 11. 增量输出去重

开启 `--include-partial-messages` 后，ywcoder **同时**输出 `stream_event` 增量与完整 `assistant` 消息（实测一次问答约 209 条增量 + 8 条完整）。shim 二选一：
- **开 partial**：以 `stream_event` 增量渲染流式效果，**忽略随后的完整 `assistant`**（避免重复）；工具调用仍以完整 `assistant` 的 `tool_use` 为准。
- **不开 partial（推荐 MVP）**：只处理完整 `assistant` 消息，逻辑最简。

## 12. 备选方案（均未采用，仅存档）

- **AgentClient 内置翻译**：把 §4~§6 映射写进 AgentClient。**不采用**——AgentClient 决定做**通用 Stdio JSONL 适配器**以适配多种 agent，不能塞 ywcoder 专用逻辑；翻译因此归 ywcoder 侧（shim）。
- **ywcoder `--sdk-url` 外连 + 心跳**：ywcoder/shim 自己外连网关、维持心跳。**不采用**——等于重造 AgentClient 已有的连接/心跳/重连层，运维职责外扩，且上行要改说网关协议。
- 当前方案：**AgentClient 通用 stdio 适配器 spawn shim，shim 随 ywcoder 打包**（见 §1）。

## 13. 分阶段实施与估时

里程碑与验收清单以 [shim-build-plan.md](shim-build-plan.md) 为准，概览：

- **简单档 MVP（约 2~3 天）**：M1 下行封装（`ywcoderSession.ts`）→ M2 上行协议 + mock（`protocol.ts`/`mock-agentclient.ts`）→ M3 组装冒烟（`index.ts`）。
- **完整档（+3~4 天）**：M4 权限控制面 `can_use_tool ↔ confirm_required ↔ task.respond`（allow/deny/deny+interrupt）+ 硬约束（`updatedInput:{}`、不回传 updatedPermissions、confirm 不设短超时、Bash 独立命令策略）。
- **生产强化**：Token 透传、多进程池与路由、审计日志、跨平台打包（见 §14）、`stream.artifact`/`block_required`（高级）。

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

## 17. 契约外需与管控台对齐的确认项

protocol.md 只规定「消息怎么长」；以下是它未覆盖、接入落地必须敲定的事项。多数已与 AgentClient 团队谈定：

| 项 | 结论 | 状态 |
|---|---|---|
| A. 启动约定 | shim 以 bin `ywcoder-ywmatrix` 分发；AgentClient 通用透传 `command/args/cwd`，args = `["--workdir", <dir>, "--permission-mode", <mode>]`；AgentClient 长驻 spawn 一个 shim 并托管/重拉；shim 据 args 用 ywcoder 真实 flag 拉起、自解析同包 ywcoder；env 整体继承，AgentClient 须以正确用户身份启动（`HOME/USER/PATH` 正确）。见 §2 | ✅ 已定 |
| B. Provider 凭证 | 走 **ywcoder 本地配置文件**，管控台不额外下发。前提：spawn 时用户上下文/`HOME` 正确 | ✅ 已定 |
| C. task_id/session_id | 按 local-agent-interface.md，每条 `task.create` 带 `session_id`+`task_id`。见 F 的 id 对齐 | ✅ 已定 |
| D. 并发模型 | AgentClient 只 spawn 一个 shim,所有 task 发给它;shim 按 `session_id` 路由:同 session 串行于一个 ywcoder 子进程,不同 session 起多个子进程。见 §9.1 | ✅ 已定 |
| E. 命令安全策略 | 管控台**不做**命令黑白名单;shim 层可选做额外过滤,默认依赖 ywcoder 权限控制。⚠️ 「依赖 ywcoder 控制」要求用 `--permission-mode default`(bypass 无控制),见 §8 | ✅ 已定 |
| F. session_id 对齐与续接 | **ywcoder 侧产 id、管控台采纳**：首条 task.create 不带 session_id → shim mint UUID、`--session-id` 启动、回填供管控台采纳；后续带该 id 路由/`--resume`。id 恒为 UUID，无需持久化映射、无需确认管控台 id 格式。见 §9.2 | ✅ 已定 |
| G. agent_id / 能力标签 | `agent_id` 由 AgentClient 定(如 `ywcoder`;多机需带 hostname 防撞);`capabilities` 由我方给默认 `{type:"chat",name:"coding"}` | ✅ 已定 |
| H. 心跳/超时/取消 | 心跳全归 AgentClient(30s `system.heartbeat` + WS ping/pong,shim 不管)。**任务超时**:网关 `-task-timeout` 默认 5min **太短,协商调至 30~60min 固定值**(不做 task 级 timeout)。**⚠️ stdio 取消缺口必须修**:AgentClient 停止时补发 `task.cancel` 给 shim,shim 转 `interrupt`(见 §6.3),否则「停止」是假的。confirm 无人应答超时由 shim 自实现(§8.3) | ⚠️ 超时/取消待改 |
