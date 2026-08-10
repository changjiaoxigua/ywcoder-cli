# ywmatrix-shim 构建计划（交执行 agent）

> 配套设计与字段映射见 [ywcoder-integration.md](ywcoder-integration.md)。本文只讲「怎么建、建到哪、怎么验收」。
> **状态（2026-08）**：**M1~M3 简单档 + M4 完整档（权限控制面）均已实现并端到端验证通过**（mock 真调模型 PASS）。
> M1~M3 执行结果见 §7，M4 见 §8。

## 0. 前置设定（已定）

- **架构（已定）**：管控台 **AgentClient = 通用 Stdio JSONL 适配器**（负责外连网关/心跳/重连/spawn 托管本地 agent）；shim 是 AgentClient spawn 的「本地 agent」，内部再 `spawn` ywcoder 子进程做翻译。连接/心跳/重连**不归我们**。
- **形态**：shim 是被 AgentClient spawn 的独立进程，说本地-agent 协议（`lifecycle.*/task.*/stream.chunk`）；ywcoder 产物**运行时零改动**。
- **归属/打包（已定）**：shim **随 ywcoder-cli 打包交付**——开发代码放 `src/entrypoints/ywmatrix-shim/`，Bun 构建为 `dist/ywmatrix-shim.mjs`，bin `ywcoder-ywmatrix`（详见 §2）。不碰 `cli.mjs`/`main.tsx` 运行时。用户装：ywcoder（含 shim）+ AgentClient，两件。
- **首个里程碑**：简单档（`--permission-mode acceptEdits`，不实现 `can_use_tool` 控制面）。
- **上行联调**：真实 AgentClient 交付状态**待确认**（见 §5）；MVP 先对 **mock AgentClient** 跑通。契约已确认 == protocol.md。
- **可复用资产**：`/Users/sijia/code/2026/test/ywmatrix-verify/verify*.mjs` 已验证的 spawn + JSONL 读写 + 握手骨架——shim 用 TS 重写，**复用其逻辑而非直接引用这些 .mjs 文件**（那是独立测试脚本）。

## 1. 现状与缺口

- **下行（shim↔ywcoder）**：协议行为已全部实测（握手、字段映射、权限、续接），已封装为 `ywcoderSession.ts`。
- **上行（shim↔AgentClient，管控台 JSON-RPC）**：无真实对端；用 `mock-agentclient.ts` 顶上，已端到端跑通（真实 AgentClient 联调待其交付）。

## 2. 代码位置与交付物

- **开发目录**：`src/entrypoints/ywmatrix-shim/`（与 cli.tsx/mcp.ts 并列的入口）。
- **构建产物**：`dist/ywmatrix-shim.mjs` —— 在 [scripts/build.ts](../../../scripts/build.ts) 加一个构建目标，**沿用与 cli 相同的 `Bun.build({features})`**（否则 import 的 `sessionStorage`/`*Schemas` 透传 `feature()` macro 会构建失败）。
- **bin 注册**：`package.json` 加 `"ywcoder-ywmatrix": "dist/ywmatrix-shim.mjs"`。
- **note/feature_ywmatrix/** 只留设计文档 + 验证脚本，不放 shim 代码。
- **零改动边界**：ywcoder 运行时（cli.mjs/main.tsx 行为）不变；仅打包层新增一个独立 entry + bin + 构建目标。

| 文件（`src/entrypoints/ywmatrix-shim/`） | 职责 |
|---|---|
| `ywcoderSession.ts` | 下行：spawn ywcoder（会话 id 三态 create/resume/ephemeral，复用 `sessionIdExists`+`validateUuid`）、initialize 握手、`sendUser(content)`、SDKMessage 规范化 |
| `protocol.ts` | 上行：管控台 JSON-RPC 编解码（`lifecycle.* / task.* / stream.chunk`）+ §4/§6 映射 |
| `index.ts` | 入口：组装上下行，按 `session_id` 路由/管理多子进程，stdout 原子写 |
| `mock-agentclient.ts` | 测试：模拟 AgentClient，通过 stdin/stdout 驱动 shim 并断言 |
| shim 自解析 ywcoder | spawn `node <__dirname>/cli.mjs`（同 dist 目录） |

## 3. 里程碑与验收

### M1 — 下行封装成库（`ywcoderSession.ts`）✅
- spawn `ywcoder -p --input-format stream-json --output-format stream-json --verbose --permission-mode <mode> --add-dir <workdir>` + 会话 id 分支（create/resume/ephemeral，见 §7 与 [§9.2](ywcoder-integration.md)）
- 实现：先发 `control_request{initialize}` → **收 `control_response{success}` 即 ready**（**不等 system/init**，它要处理第一条用户消息才产出，见 [§3](ywcoder-integration.md)）
- `sendUser(content)` 写 stdin user message；把 stdout 的 SDKMessage 规范化为事件：`text` / `action(tool_use)` / `result(tool_result)` / `completed(result.success)` / `error(result.error_*)`
- **约束**：只观测 `tool_result`，绝不注入/代执行工具（[ywcoder-integration.md §4](ywcoder-integration.md)）
- **验收**：mock 发「读取 test.txt」→ 依次拿到 `action(Read)`→`result`→`completed` ✅

### M2 — 上行协议层 + mock（`protocol.ts` + `mock-agentclient.ts`）✅
- shim 侧实现：`lifecycle.initialize`(回能力集)、`lifecycle.register`(主动发)、`lifecycle.ping`、`task.create`、`task.cancel`、输出 `stream.chunk`/`task.completed`/`event.error`
- 字段严格按 [ywcoder-integration.md §4/§5/§7](ywcoder-integration.md) + [protocol.md](protocol.md)
- `mock-agentclient.ts`：起 shim 子进程 → 发 `lifecycle.initialize` → 收 `register` → 发 **不带 session_id** 的 `task.create` → 校验 ack 回传 session_id → 收流式 `stream.chunk` → 断言
- **验收**：端到端（mock→shim→ywcoder→shim→mock）收到 text+action+result+completed，`stdout` 无非协议污染 ✅

### M3 — 组装 + 冒烟（`index.ts`）✅
- 组装 M1+M2，按 `session_id` 路由多子进程、同 session 串行、`task_id ↔ 活动会话` 关联
- **验收清单**（mock PASS 覆盖）：
  - [x] 握手时序正确（shim 先发 initialize，**收 control_response 即 ready**）
  - [x] session_id：首条 task 无 id → shim mint UUID 并回传 ack；后续消息 id 一致（**非** 来自 system/init）
  - [x] `tool_use`→`action`、`tool_result`→`result` 映射正确、不重复
  - [x] `result{success}`→`task.completed`，usage 进 metadata
  - [x] stdout 洁净；异常/子进程退出→`event.error`
  - [ ] 多轮上下文保持（同 session 二轮，mock 单轮已过；建议补测）

### M4 — 完整档（权限控制面）✅
- `--permission-mode default` 时 shim 自动追加 `--permission-prompt-tool stdio`（`ywcoderSession.buildArgs`）
- 实现 `can_use_tool`↔`confirm_required`↔`task.respond`（allow/deny/deny+interrupt，[§6.2](ywcoder-integration.md)）
- **硬约束**：allow 回 `updatedInput:{}`、**绝不回传 updatedPermissions**、confirm **不设 shim 短超时**（靠网关 task-timeout + 取消兜底）、Bash 独立命令策略（[§8.3](ywcoder-integration.md)）
- mock 扩展：`--scenario read|allow|deny|cancel|cancel-task|all`
- **验收**（mock 真调模型全 PASS，见 §8）

## 4. 给执行 agent 的硬约束（务必遵守）

1. **ywcoder 运行时零改动**：只在 `src/entrypoints/ywmatrix-shim/` 目录内工作（另加 scripts/build.ts 一个构建目标 + package.json 一个 bin），不碰 `cli.mjs`/`main.tsx` 运行时。
2. **stdout 洁净**：shim 对 AgentClient 的 stdout 只允许协议 JSONL，所有日志走 stderr。
3. **不代执行工具**：收 `tool_use` 只翻译成 `action`，工具由 ywcoder 自己跑。
4. **档位由 `--permission-mode` 决定**：`acceptEdits`/`bypassPermissions` = 简单档，不接控制面；`default` = 完整档，shim 自动补 `--permission-prompt-tool stdio` 并处理 `can_use_tool`（M4，见 §8）。
5. **字段以 [ywcoder-integration.md](ywcoder-integration.md) §4/§5/§6 为准**，schema 用 ywcoder 的 zod（`src/entrypoints/sdk/*Schemas.ts`）校验。
6. 复用 `ywmatrix-verify/verify*.mjs` 的骨架，别重造 spawn/读写轮子。

## 5. 对齐状态（详见 [ywcoder-integration.md §17](ywcoder-integration.md)）

**已与 AgentClient 团队谈定**：启动约定（command/args:`--workdir`+`--permission-mode`/cwd）、凭证走 ywcoder 本地配置、并发路由（一个 shim + `session_id`→子进程）、命令安全策略（管控台不做黑白名单）、**session_id 由 ywcoder 侧产、管控台采纳**（首条 task 不带 session_id → shim mint UUID 回传，见 [§9.2](ywcoder-integration.md)）、agent_id 由 AgentClient 定。

**仍需处理/确认**：
1. **任务超时**：网关 `-task-timeout` 默认 5min 太短，已协商调至 **30~60min 固定值**（不做 task 级 timeout）——落实到网关+client 配置。
2. **⚠️ stdio 取消缺口（AgentClient 侧修）**：停止时 AgentClient 需补发 `task.cancel` 给 shim，shim 转 `interrupt`（[§6.3](ywcoder-integration.md)）。否则「停止」是假的，任务继续烧成本。
3. **真环境联调**：AgentClient 可用后把 mock 换成真实对端跑一遍。

## 6. 估时（简单档 M1~M3）

约 2~3 天：M1 ~1d、M2 ~1d、M3 ~0.5d + 冒烟。M4 完整档另计 +3~4 天。

## 7. 执行结果与偏差（M1~M3 实测）

**交付**：`src/entrypoints/ywmatrix-shim/{ywcoderSession,protocol,index,mock-agentclient}.ts` + `scripts/build.ts` 第二构建目标 + `package.json` bin `ywcoder-ywmatrix`。ywcoder 运行时零改动。

**验证**：`bun run build` 通过（产出 `dist/ywmatrix-shim.mjs`）；mock 真调模型端到端 **PASS**——首条 task.create 不带 session_id → ack 回传 mint 的 UUID → shim 以 `--session-id <uuid>` 启动 ywcoder → action(Read)/result/text/completed 全链路、session_id 一致、stdout 洁净。

**实现中发现并修正的偏差（均只在 shim 侧处理，未碰 ywcoder 源码）**：
1. **system/init 时序**：原计划「等 system/init 才 ready」会死锁——它是处理第一条用户消息时才产出（[QueryEngine.ts:541](../../../src/QueryEngine.ts#L541)）。改为 `control_response{success}` 即 ready，system/init 仅回显校验（已同步 [§3](ywcoder-integration.md)）。
2. **session_id 归属**：由「管控台强加 id、shim 对齐」改为「ywcoder 侧产 id、管控台采纳」（stdio 模式首条 task 不带 id）。shim 首条 mint UUID + `--session-id` + ack 回传；三态启动 create/resume/ephemeral（非 UUID 走一次性）。已同步 [§9.2](ywcoder-integration.md)。
3. **schema 漂移**：`SDKSystemMessageSchema.apiKeySource` 枚举缺 `none`（运行时会给 `none`），strict parse 会吞掉 system/init。改为校验失败只告警、不丢消息。
4. **cwd 符号链接**：cwd 一致性守卫原用 `resolve` 比较，macOS `/tmp`→`/private/tmp` 符号链接会误判。改用 `realpathSync` 比较。
5. **`--dev` 模式 SHIM_VERSION**：构建 define 注入的 `SHIM_VERSION` 在 `--dev` 跑源码时未定义。改用 `typeof` 守卫回退 `0.0.0-dev`（构建产物仍取注入值）。

**mock 用法**：`bun run src/entrypoints/ywmatrix-shim/mock-agentclient.ts <workdir> [--scenario read|allow|deny|cancel|cancel-task|all]`（默认 `all`，跑构建产物，需先 `bun run build`）；加 `--dev` 改跑源码。需 provider 凭证（真调模型）。

**遗留**：同 session 多轮上下文建议补一条 mock 断言；真实 AgentClient 联调待其交付。

## 8. 执行结果与偏差（M4 完整档实测）

**交付**（均在既有文件上增量改，未新建协议层，ywcoder 运行时仍零改动）：
- `ywcoderSession.ts`：`default` 档自动补 `--permission-prompt-tool stdio`；`control_request{can_use_tool}` → 事件 `permission_required`；`control_cancel_request` → `permission_cancelled`；新增 `respondPermission(requestId, decision)` 写 `control_response`；`completed` 事件带上 `permission_denials`。
- `protocol.ts`：`confirm_required` chunk 构造 + `level` 推断 + 入参摘要；`task.respond` 参数校验；`normalizeConfirmResponse`（回复语义归一，见 [§6.2](ywcoder-integration.md)）。
- `index.ts`：`confirm_id → {sessionId, taskId}` 映射（无超时定时器）；`task.respond` / `task.create{type:'respond'}` 路由到对应子进程；任务结束/取消/子进程退出时清理映射。
- `mock-agentclient.ts`：场景化改造，`--scenario read|allow|deny|cancel|cancel-task|all`，每场景独立子目录 + 独立 shim 进程。
- `protocol.test.ts`：回复语义映射表与 `level` 推断的纯函数单测（8 例）。

**验证**：`bun run build`、`bun run smoke`、`bun test src/entrypoints/ywmatrix-shim/protocol.test.ts` 通过；mock 真调模型 5 场景全 **PASS**，全程 stdout 洁净：

| 场景 | 触发 | 回复 | 实测结果 |
|---|---|---|---|
| `read` | 简单档 acceptEdits 读文件 | — | 无 confirm，text/action/result/completed 正常（M1~M3 回归） |
| `allow` | Write 触发 `confirm_required`(level=warning) | `确认` | 文件真实创建、`result{success}` → `task.completed` |
| `deny` | 同上 | `拒绝` | 文件未创建，模型继续对话并完成，`metadata.permission_denials` 有 1 条记录 |
| `cancel` | 同上 | `{decision:'cancel'}` | deny+interrupt → `result{error_during_execution}` → `event.error`，文件未创建 |
| `cancel-task` | 确认待决期间发 `task.cancel` | — | shim 转 `interrupt` → 待决 `can_use_tool` 被 abort（tool_result 为 `AbortError`）→ `event.error`，文件未创建（[§6.3](ywcoder-integration.md) 取消与控制面并存） |

**实现中发现并修正的偏差**：
1. **裸 `cancel` 的歧义**：初版把自由文本与结构化回复用同一张词表，导致 `{decision:'cancel'}` 被当成「只拒绝本次工具」。改为分开处理——自由文本的裸「取消/cancel」按 deny（网页「取消」按钮多半只是不做这个操作），结构化 `decision:'cancel'` 才是中止任务。语义表已落 [§6.2](ywcoder-integration.md)，**待与 AgentClient 确认按钮实际回传的字面值**。
2. **其它 control_request subtype 必须显式回 error**：ywcoder 的 `pendingRequests` 没有自超时，静默忽略 `hook_callback`/`mcp_message` 会让它一直挂着。
3. **`control_cancel_request` 需要处理**：ywcoder abort 待决权限请求后会发这条，shim 不清理映射会泄漏（且后续 `task.respond` 回的 control_response 无人认领）。

**遗留/待确认**：网页侧「确认/取消」按钮的实际回传值；权限请求被 ywcoder 撤销后，管控台如何收回已展示的确认框（协议无对应消息）。
