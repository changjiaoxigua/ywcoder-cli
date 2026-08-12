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
> `tool_result.content` 可能是字符串或 content block 数组（text/image/resource）。转发规则见 §4.1。

### 4.1 文件/图片预览（typed content 转发）

**目标**：让管控台能预览 agent 读到/产出的文件与图片——shim 把 tool_result 的内容块按类型转发，管控台按类型渲染。**纯预览、无下载、无上传**（历史续接本就把内容持久化到管控台侧，数据边界已如此，不再做「仅本机」隔离）。**下方所有约定均已与管控台定稿**（见 [m5-preview-alignment.md](m5-preview-alignment.md) / [m5-preview-reply.md](m5-preview-reply.md)）。

**内容块转发（进 `stream.chunk` 的 content 数组）**：

| tool_result 内容 | 转发为 | 管控台渲染 |
|---|---|---|
| **文件读取（文本类：md/csv/json/log…）** | **`resource` 块**：`{type:"resource",resource:{uri:<文件名/路径>,mimeType,text:<干净内容>}}` | 按 `mimeType` 路由（md→HTML、csv→表格、其余→文件卡片） |
| **图片** | `image` 块：`{type:"image",data:<base64>,mimeType}` | `<img>` 内联 |
| agent 自己的回答/thinking（非文件） | `text` 块 | markdown 渲染 |

**为什么文件走 resource 而不是裸 text（走 B，已定）**：裸 `text` 块不带"这是 md 还是 csv"的类型信息，管控台只能当 markdown 渲。`resource` 块带 `mimeType` 消除歧义，且管控台**已实现** resource 按 mimeType 渲染分支，shim 走 B 对管控台零改动。

> ⚠️ **实现坑（必须处理）**：ywcoder 的 Read 返回的 tool_result 文本**不是干净文件内容**，而是**每行带 `N\t` 行号前缀 + 尾部可能附 `<system-reminder>`**（本 session mock 实测：`"1\t# 标题\n2\t...\n\n<system-reminder>...</system-reminder>"`）。直接包成 `resource` 交管控台按 md/csv 渲染会**错乱**。**shim 走 B 前必须先清洗**：剥掉每行 `N\t` 行号前缀、去掉尾部 `<system-reminder>` 块，得到干净内容再放进 `resource.text`。验收**必须端到端看渲染结果**，不能只验"发出了 resource 块"。

**mimeType 推断**：shim 按文件扩展名推（`.md`→`text/markdown`、`.csv`→`text/csv`、`.json`→`application/json`、`.log/.txt`→`text/plain`…）。文件路径来自对应 `tool_use` 的 `arguments.file_path`（shim 已维护 `tool_use_id → name`，再加维护 `→ file_path` 即可）。

**大小护栏（阈值 = 2MB，已与管控台定）**：单个内容块原始大小 > **2MB** → **不内联**，降级为一条 `text` 提示，文案带**文件名 + 实际大小 + 阈值**三要素（如 `[文件 report.csv 2.4MB 超阈值 2MB，已截断预览，原文件在终端]`）。
- 阈值对 **text/image/resource 所有块**生效（不只图片）：csv、docx/xlsx 抽取文本也可能超。
- 文本超限可**截断 + 标注**（保留前 2MB，用户仍能看开头）；图片/二进制超限只能发**提示**（base64 截半无意义）。
- 天花板：网关 `messages.content` 为 MEDIUMTEXT（**16MB 上限**），2MB 远低于此，安全（协议 §13：大文件不走 WS）。
- 超限 = **优雅降级**，不是报错：任务照常、ywcoder 内部有真实内容、文件仍在终端磁盘。

> **实测补充（M5 实现时发现，管控台侧无需改动）**：当前 ywcoder 的 Read 自带 **256KB 文件大小上限**（[limits.ts](../../../src/tools/FileReadTool/limits.ts)，超限直接返回 `is_error` 提示、不产内容），图片则按 25000 token 预算压缩到 ~200KB 级。因此**「读文件」这条路目前产不出 >2MB 的内容块**，2MB 护栏实际是给未来 MCP 工具、以及 agent 侧提取能力（docx/xlsx 抽文本）兜底的安全网。护栏已按定稿实现，字节级行为由 shim 单测覆盖。

**其它约定（已定）**：
- 图片若同时有 `image` 块（base64）和 `resource` 块（uri），**优先 `image` 块**，避免 base64 重复传输。
- 纯文本文件统一发 `resource`，**不发裸 `text`**（否则管控台无 mimeType 上下文，只能当 md 渲）。

**格式支持与 shim 解耦**（关键）：能预览哪些格式取决于 **agent 侧的读取能力**，不是 shim/协议的事——
- **csv/md/txt/json/log**：Read 出即文本，shim 清洗后包 resource，现在就能预览（管控台 csv 表格化本期在做）。
- **docx/xlsx 等二进制**：Read 读不出可读文本，需 **agent 有提取工具/技能**（docx→文本、xlsx→表格）；抽取出的文本顺本管道即出——**新增格式不用回来改 shim**。还原原版排版是另一件重活，不在此列。

**前置**：要预览「生成的文件/图表」，需 agent 把它 `Read` 回来（只写盘不 Read 不会进流）。

> ⚠️ **当前阶段的保真边界（管控台需知情，M5 实测）**：因为预览内容寄生在**模型的阅读管道**上，而该管道是为模型消费设计的，本期预览**不保证与磁盘原文一致**：
>
> | 内容 | 当前收到的 | 说明 |
> |---|---|---|
> | 图片 | **压缩降质版，非原图** | 实测 261KB 原图 → 收到 116KB（33.3%），尺寸被 resize。图表的坐标轴标签/图例可能糊掉 |
> | 大文本文件 | 收不到 | ywcoder 的 Read 有 256KB 自限，超限只返回错误提示 |
> | 分片读（`offset/limit`） | 裸 `text` 块，非 resource | shim 不谎称片段是全文，故这类结果不带 mimeType |
> | 文本正文 | 已清洗，但**依赖上游输出格式** | 行号前缀/system-reminder/桩文本已剥离；上游若改格式，清洗可能静默失效 |
>
> 根因与解法（让预览脱离模型阅读管道）已归并为下一阶段议题，见 [shim-build-plan.md §3 M7](shim-build-plan.md)。**本期不影响联调**：小文件文本预览、图片内联渲染均已可用。

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
| `session_id` | **路由键**（见 §9.2）：**带 UUID**（AgentClient 现行行为）→ 原样采用，据本地是否已有该会话走 `--session-id`（新建）或 `--resume`（续接）；**不带**（早期约定，仍支持）→ shim mint 一个 UUID 并在 ack 回填供管控台采纳。两种入口最终都以 **ack 回传的 id 为准** |
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
**管控台 → shim**：`task.respond`（v2 §6.2.1 定为结构化对象；字符串/boolean 仍兼容）
```json
{ "jsonrpc":"2.0","id":"...","method":"task.respond","params":{
  "task_id":"...","confirm_id":"<rid>","response":{"decision":"allow","message":"已核对，放行"} }}
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

**✅ `cancel` 语义已与 AgentClient 敲定（方案 A）**：`decision:'cancel'` = **中止整个任务**，效果等同 §6.3 的 `task.cancel`，只是入口在确认框上。配套的前端约定：**「×」/「关闭」按钮映射为 `deny`**（只拦这一步），只有明确的「终止任务」按钮才发 `cancel`。

两条刻意的取舍：
1. **自由文本里的裸「取消」仍按 deny 处理**——那是 v2 §6.2.1 的旧版兼容路径（字符串/boolean），来自尚未遵循上述前端约定的客户端，其「取消」多半就是「别做这个操作」。宁可少拦一步，也不因一个模糊字符串杀掉整轮任务。**结构化 `{decision:'cancel'}` 不受此限**，明确即中止。
2. **无法识别的回复一律 deny**，绝不因歧义放行。

**其它已实现的控制面行为：**
- `task.create{type:'respond', confirm_id, content}` 等价于 `task.respond`（§5），走同一条裁决路径；result 里的 `task_id` 回请求方自己带的值。
- **无活动任务时收到 `can_use_tool`**（本轮已收尾但请求迟到等）→ shim 自动回 deny。**必须回**：ywcoder 的 pending 请求没有自超时，静默丢弃会让子进程永久阻塞、该 session 后续任务全部卡死。
- `task.respond` 的 `confirm_id` 不存在/已回复/已被撤销 → JSON-RPC `-32000`（§10）。
- **确认框撤销 `confirm_cancelled`**（[local-agent-interface-v2.md](local-agent-interface-v2.md) §8.1.1 已采纳）：待决确认失效时 shim 摘除 `confirm_id` 映射并补发一条通知，网页据此关框。

  ```json
  {"jsonrpc":"2.0","id":null,"method":"stream.chunk","params":{
    "task_id":"...","session_id":"...",
    "type":"confirm_cancelled","confirm_id":"<rid>","reason":"task_cancelled" }}
  ```

  | `reason` | 触发 |
  |---|---|
  | `task_cancelled` | 管控台 `task.cancel`（§6.3），shim 先撤框再转 `interrupt` |
  | `interrupted` | ywcoder 主动放弃该请求（`control_cancel_request`），或本轮以 completed/error 收尾时仍有残留 |
  | `agent_exited` | ywcoder 子进程异常退出，来不及通知，shim 兜底补发 |

  **去重**：只有映射确实还在时才发通知——`task.cancel` 先摘除，ywcoder 随后迟到的 `control_cancel_request` 便不会让同一个框收到两条撤销（已实测恰好 1 条）。
- ywcoder 发来的**其它** `control_request` subtype（`hook_callback`/`mcp_message` 等）→ shim 回 `control_response{subtype:'error'}`；不能静默忽略，ywcoder 的 pending 请求没有自超时。
- `result.permission_denials` 透传进 `task.completed.metadata.permission_denials`，供管控台核对「拒绝确实生效」。

**allow 的两条硬约束（务必遵守）：**
1. `updatedInput` **必填**（stdio 路径的 schema 要求）。传空对象 `{}` 表示「用原始入参」；除非管控台要改写入参，一律回 `{}`。
2. **绝不回传 `updatedPermissions`**。`can_use_tool` 里的 `permission_suggestions` 是「把该命令永久加白名单」的建议；一旦作为 `updatedPermissions` 回传，会被 ywcoder [持久化落盘](../../../src/utils/permissions/PermissionPromptToolResultSchema.ts#L96)，使「本次允许」静默变成「永久允许」。远程场景下这是危险默认，shim 必须丢弃该建议。

### 6.3 取消：`task.cancel` → `interrupt`

管控台 `task.cancel`（带 `session_id`/`task_id`）→ shim 对**对应 session 的 ywcoder 子进程**发 `{type:'control_request',request_id:'<new>',request:{subtype:'interrupt'}}`（ywcoder 内部中断当前轮；必要时 kill 子进程）。

- **通知形式**：v2 §6.3 定为通知类（**不带 `id`**），此时 shim 不回 `result`，任务不存在也不回 `-32000`（只记 stderr 日志）；兼容带 `id` 的请求形式时才回。
- **取消排队中的任务**（同 session 尚未轮到、还没喂给 ywcoder）：直接从队列摘除，并补发 `event.error{code:"TASK_CANCELLED"}` 收尾——它不会有 `result` 事件，通知形式又不回 `result`，不出声则该 `task_id` 在管控台侧一直悬着。
- **interrupt 收尾看门狗**：发出 interrupt 后 **10s** 内若没收到 `result`，shim 强杀子进程解卡（SIGTERM → 再 5s → SIGKILL）。这是唯一会让 session 永久卡死的路径：`activeTaskId` 不清则后续任务全堵在队列里，且再发 `task.cancel` 也无效。
  - **不违反「审批不设超时」（§8.3 硬约束 2）**：那条禁的是 confirm 级超时（人在回路，必须等人）；interrupt 是机器对机器的操作，实测秒级返回。
  - **强杀可恢复**：会话已落盘，下一条 `task.create` 走 `--resume` 原样恢复上下文，最坏后果只是重启一个子进程。
  - **SIGKILL 升级是必需的**（实测）：用 `SIGSTOP` 冻结子进程模拟「不响应 interrupt」时，SIGTERM 完全无效（信号挂起不投递），10s 触发 SIGTERM 无反应、15s 升级 SIGKILL 才真正解卡，随后 `--resume` 起新子进程继续服务。
- **与控制面并存**：若此刻有待决确认，shim 先补发 `confirm_cancelled{reason:'task_cancelled'}` 关框，再转 `interrupt`；ywcoder 随即 abort 该 `can_use_tool`（工具结果为 `AbortError`）并回 `control_cancel_request`（因映射已摘除，不会重复撤销）。已实测。

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
   > 例外（唯一的 shim 侧计时器）：**interrupt 收尾看门狗 10s**（§6.3）。它计的是「机器对机器」的响应，不是人的决策时间，两者不冲突。
3. **allow 不回传 `updatedPermissions`**（见 §6.2）。
4. **续接不保留权限**：`--resume` 后每次工具调用仍重新确认（见 §9），不会因上次 allow 而免确认——设计上安全，但需预期确认频次。

### 9.1 并发与会话路由（已定）

- AgentClient 只 spawn **一个 shim 实例**，所有 `task.create` 都发给它；每条**必带 `session_id` + `task_id`**。
- shim 维护 `session_id → ywcoder 子进程` 映射：
  - **同一 `session_id`** 的多个 task 路由到**同一个 ywcoder 子进程内串行**；
  - **不同 `session_id`** 各起**独立 ywcoder 子进程**，互不干扰。
- 上对 AgentClient 是**一条多路复用的 stdio**：每行输出必带 `session_id`+`task_id`、**整行原子写**，供 AgentClient demux。

### 9.2 session_id 对齐（关键，已定）

**模型（已定，2026-08-11 与 AgentClient 团队最终确认）：网关生成 id，shim 原样采纳。**
早期「shim 在 ack 回填、管控台采纳」的方案**已被明确不采纳**——AgentClient 不消费 ack 里的 `session_id`，shim 若自行生成只会造成「真相分裂」（网关一套 id、子进程另一套）。

管控台侧链路：前端「新会话」→ 浏览器调 `session.create` → 网关 `crypto.randomUUID()` 生成并落库 → 浏览器此后每条 `task.create` 都携带该 id → 网关透传 client → adapter → shim。因 `randomUUID()` 恒为**小写合法 UUID**，格式与大小写风险天然消解；网关 `{task_id}-session` 兜底是死代码，永不触发。

shim 侧行为：

- **`task.create` 带 UUID（常态）** → **原样采用**，据本地是否已有该会话决定 `--session-id`（新建）还是 `--resume`（续接）；ack 仍回传该 id（对方不消费，仅作回显/诊断）。
- **同一 UUID 的后续 `task.create`** → 路由到同一**存活子进程**直接发消息；子进程已回收 → `--resume <uuid>`。
- **未带 `session_id`（不该出现）** → 防御性 mint 一个 UUID 并**打告警日志**：按约定该字段必到，缺失说明上游链路有问题；且对方不消费 ack，mint 出的 id 它并不知道，只能保证本进程内路由自洽。

> ⚠️ 对方文档把这条链路写成「shim → ywcoder `--resume <uuid>`」，实际要分两种：**本地尚无该会话时必须用 `--session-id`**，对不存在的会话用 `--resume` 会被 ywcoder 拒绝。这个分支由 shim 内部处理，不需要管控台侧感知。

**实测的四个分支**（探针直接观察 shim 拉起 ywcoder 的实际命令行）：

| 管控台下发的 `session_id` | 启动模式 | 传给 ywcoder | 结果 |
|---|---|---|---|
| 合法 UUID、本地无该会话 | `create` | `--session-id <id>` | ywcoder 采纳该 id |
| 合法 UUID、本地已有该会话（同 workdir） | `resume` | `--resume <id>` | **恢复历史上下文** |
| 合法 UUID、但换了 `--workdir` | `create` | `--session-id <id>` | 视为新会话（会话文件按工作目录分桶） |
| 非 UUID（如 `task-123-session`） | `ephemeral` | 都不传 | 一次性会话，**不可续接** |

**⚠️ 对管控台侧的三条要求**（前两条已由网关用 `crypto.randomUUID()` 天然满足，第三条仍需其保证）：

1. ✅ **必须是合法 UUID**（8-4-4-4-12 hex）。非 UUID 只能退化为一次性会话，**静默丢失续接**——子进程回收后上下文即消失。
2. ✅ **UUID 固定用小写**（`randomUUID()` 恒为小写）。大写能正常启动，但 `sessionIdExists` 查的是文件名 `<id>.jsonl`：macOS 大小写不敏感会"碰巧"命中，**Linux 上同一 id 的大小写变体会被判成两个会话**（该续接的变成新建）。若将来改用其它来源的 id（如从外部系统导入），需重新确认这一点。
3. ⏳ **`session_id` 与 `workdir` 配套**（对方回复未涉及）。会话文件按工作目录分桶存，同一 id 换 `--workdir` = 全新会话；网关按 session 落库、用户隔天回来续聊时，必须把任务路由回**同一台机器的同一个工作目录**，否则上下文静默丢失。

> 一致性保障：shim 的 `validateUuid` / `sessionIdExists` 与 ywcoder 自身校验**是同一个函数**，projectDir 也都由 `realpath(cwd)` 推导（shim 强制 `cwd == --workdir`），故不会出现「shim 判 create、ywcoder 却拒绝启动」的分叉。万一竞态撞上 `already in use`，`YwcoderSession.spawn` 会自动改用 `--resume` 重试一次。

```js
// 会话路由键 = task.create.session_id（任意字符串都能当 key）
if (!session_id) {                      // 入口二：管控台没给 → 我方 mint
  const uuid = mintUuid()
  spawn ywcoder --session-id <uuid>     // 保证 UUID
  回填 uuid 到 ack + 所有输出            // 管控台采纳
} else if (有存活子进程[session_id]) {
  send user message                      // 同会话续发
} else if (isUuid(session_id) && sessionIdExists(session_id)) {
  spawn ywcoder --resume <session_id>    // 子进程回收后续接
} else if (isUuid(session_id)) {
  spawn ywcoder --session-id <session_id> // 入口一：采纳管控台下发的 UUID（含 shim 重启后首见）
} else {
  spawn ywcoder                          // 防御：非 UUID（不该出现）→ 一次性，不续接
}
```

`--session-id` **已实测确认**（[main.tsx:995](../../../src/main.tsx#L995)）：传入 `--session-id <UUID>` 后 `system/init.session_id` 如实回显；已存在时 `--resume <UUID>` 正常续接。约束：**必须合法 UUID**（[main.tsx:1285](../../../src/main.tsx#L1285) 硬校验）；**id 本地不能已存在**（[main.tsx:1292](../../../src/main.tsx#L1292) `sessionIdExists` = 查 `<projectDir>/<id>.jsonl`，故存在时走 `--resume`）；**不与 `--resume`/`--continue` 混用**（[main.tsx:1276](../../../src/main.tsx#L1276)）。

> **无需持久化映射**：id 恒为 UUID（我方 mint 或管控台下发），会话状态由 ywcoder 自己按 `<projectDir>/<id>.jsonl` 落盘，shim 重启后凭 id 即可 `--resume`。但「管控台下发」这条入口把「保证 UUID」的责任交回了管控台侧——见上面的三条要求。

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
| ywcoder 子进程异常退出 / 启动失败 | 对**活动任务与该 session 队列里所有排队任务**逐个发 `event.error{recoverable:false}`（排队任务不会产生 result，不逐个上报则在管控台侧永久悬挂）；同时 `confirm_cancelled{reason:'agent_exited'}` 撤销待决确认 |
| shim 自身崩溃 / AgentClient 关闭 stdout | 捕获后**先 kill 所有 ywcoder 子进程再退出**——否则子进程成孤儿继续跑、继续烧 token（已实测：不处理时确实留下孤儿） |

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
| F. session_id 对齐与续接 | **网关生成、shim 原样采纳**（2026-08-11 最终确认，「shim 在 ack 回填」方案已明确不采纳）。网关 `session.create` 用 `randomUUID()` 生成并落库，浏览器每条 task 都带；shim 据本地是否已有该会话走 `--session-id`/`--resume`。见 §9.2 | ✅ 已定；⏳ 仅剩「同一 session 必须路由回同一机器同一 workdir」需对方确认 |
| G. agent_id / 能力标签 | `agent_id` 由 AgentClient 定(如 `ywcoder`;多机需带 hostname 防撞);`capabilities` 由我方给默认 `{type:"chat",name:"coding"}` | ✅ 已定 |
| H. 心跳/超时/取消 | 心跳全归 AgentClient(30s `system.heartbeat` + WS ping/pong,shim 不管)。**任务超时**:网关 `-task-timeout` 默认 5min **太短,协商调至 30~60min 固定值**(不做 task 级 timeout)。**⚠️ stdio 取消缺口必须修**:AgentClient 停止时补发 `task.cancel` 给 shim,shim 转 `interrupt`(见 §6.3),否则「停止」是假的。confirm 无人应答超时由 shim 自实现(§8.3) | ⚠️ 超时/取消待改 |
