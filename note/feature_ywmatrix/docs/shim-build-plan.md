# ywmatrix-shim 构建计划（交执行 agent）

> 配套设计与字段映射见 [ywcoder-integration.md](ywcoder-integration.md)。本文只讲「怎么建、建到哪、怎么验收」。
> **状态（2026-08）**：**M1~M3 简单档 + M4 完整档（权限控制面）+ M5 文件/图片预览均已实现并端到端验证通过**（mock 真调模型 PASS）。
> M1~M3 执行结果见 §7，M4 见 §8，M5 见 §9。**M6 上行上传：后续（M6a 文本可先做，M6b 图片待 vision）；M7 预览保真（旁路）：下一阶段，见 §3 M7。**

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
  - [x] session_id：管控台下发 UUID → 原样采用，create/resume/ephemeral 四分支已实测（见 [§9.2](ywcoder-integration.md) 分支表）
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

### M5 — 文件/图片预览（typed content 转发）✅
字段与约定以 [ywcoder-integration.md §4.1](ywcoder-integration.md) 为准（已与管控台对齐，见 m5-preview-reply.md）。要点：
- **放开 `normalizeResultContent`**（现在只留 text 块），`stream.chunk` content 类型扩到 **text/image/resource**。
- **文件读取（文本类）走 `resource` 块**（带 `uri`+`mimeType`+清洗后 `text`），**不发裸 text**；mimeType 按扩展名推（`.md/.csv/.json/.log/.txt`…），file_path 取自对应 `tool_use.arguments.file_path`（新增维护 `tool_use_id → file_path`）。
- **⚠️ 必须清洗 Read 输出**：剥掉每行 `N\t` 行号前缀 + 去尾部 `<system-reminder>`，否则管控台按 md/csv 渲染会错乱（§4.1 有实测样例）。
- **图片走 `image` 块**（base64+mimeType）；若同时有 image 与 resource，**优先 image**。
- **大小护栏 = 2MB**：单块 > 2MB 不内联，降级为 `text` 提示，文案带**文件名+实际大小+阈值**；对 text/image/resource 都生效；文本可截断+标注，图片/二进制发提示。
- **范围**：纯预览——**不做下载、不做上传**（上传见 M6）。
- **格式无关**：docx/xlsx 靠 agent 侧提取工具抽成文本再走本管道，**不改 shim**。
- **验收（mock 场景，须端到端看渲染，不只验"发了 resource 块"）**——实测见 §9：
  - [x] Read 一个 md → 收到 `resource` 块，mimeType=`text/markdown`，`text` **无行号前缀、无 system-reminder**（清洗生效，与原文逐字节一致）；
  - [x] Read 一个 csv → `resource` 块 mimeType=`text/csv`；
  - [x] Read 一张图片 → `image` 块（base64+mimeType），不重复发 resource；
  - [x] Read 一个 > 2MB 文件 → 不内联大内容、任务优雅收尾；**但 ywcoder 的 Read 有 256KB 自限，真实读文件够不着 2MB 护栏**，护栏字节级行为改由 `protocol.test.ts` 合成超限块验证（见 §9 偏差 1）；
  - [x] agent 普通回答仍是 `text` 块（不受影响）。
- **依赖**：管控台按 mimeType 渲染 resource + image（已实现；csv 表格化本期在做）。

### M6 — 上行上传（后续，拆两档）
上行管道管控台已通（用户传的文件/图片以 **URL** 到达 agent，非 base64 内联）。
- **M6a — 上传文本类（csv/json/log 等）**：shim 拉 URL → 抽取文本 → 作为 task 上下文喂模型。**不需要 vision**，可先做。
- **M6b — 上传图片**：shim fetch URL → base64 → `image` content block → 喂 **vision 模型**。**阻塞在模型能力**（取决于 provider），待 vision 联调。

### M7 — 预览保真：让预览脱离「模型的阅读管道」（下一阶段，待排期）

> 结论来自 M5 实现 + 代码审查后的复盘。**本阶段不做，先记录**；M5 已就地止血（见下方"当前止血"），不阻塞联调。

**根因**：现在预览内容必须寄生在**模型的阅读行为**上（§4.1 前置："要预览生成的文件，需 agent 把它 `Read` 回来"）。但 Read 这条管道是为**模型消费**设计的，于是每个"为模型优化"的设计都变成一处预览损伤：

| 模型侧的设计 | 对模型合理 | 对预览的损伤 |
|---|---|---|
| 256KB 文件上限 / 25000 token 上限 | 保护上下文预算与成本 | 大文件进不了预览（M5 的 2MB 护栏因此够不着，见 §9 偏差 1） |
| `offset/limit` 分片读 | 模型只读需要的那段 | 用户想看文件，拿到的是模型挑的片段 |
| 图片按 token 预算压缩 | 省 vision token | **预览到的是降质图**（实测：261KB 原图 → 收到 116KB，33.3%，尺寸被 resize） |
| 行号前缀 / system-reminder / 桩文本 | 让模型能引用行、下指令、省 token | 必须逐层拆包装才能还原原文——**§9 那 5 个缺陷全部源于此** |

**关键认识**：M5 的"清洗"本质是**从模型的阅读输出里逆向重建人类要看的原文**，天然脆弱。§9 那 5 个缺陷全发生在**几 KB 的小文件**上，与 256KB 无关；且无法保证枚举完整——上游改一次 Read 输出格式，清洗就会**静默失效**（渲染出错但无任何报错）。

**触发这些损伤的真实场景**（已确认存在，故本议题成立）：
- **模型跑 Bash 脚本产出的文件**（`python analyze.py > report.csv`）——不受模型输出 token 限制，可任意大；
- **agent 读用户已有的文件**（日志、数据 csv、导出报表）——可任意大；
- **agent 生成的图表**——降质会让坐标轴标签/图例糊掉，而这正是预览最典型的用例之一。
- （对照：模型**直接 Write** 产出的文件受单次输出上限约束——32K/64K token ≈ 96~256KB——**几乎不可能超 256KB**，这一类不构成需求。）

**方案**：shim 拿着已维护的 `file_path` **直接从磁盘读原文**发 resource/image，不经模型上下文。上表四类损伤一次性消失。注意一个反转：**2MB 护栏在当前架构下够不着，在旁路架构下才变成真正的把关者**——它是为这个阶段预先写好的另一半。

**安全折中（关键）**：shim **只对「模型确实 Read 过的那个 `file_path`」**去磁盘取原文。触发权仍握在模型的阅读行为手里（权限语义完全不变，仍受 `can_use_tool` 约束），只是**内容改走无损通道**——去掉全部保真损伤，不扩大任何权限边界。

**代价与待解**：
1. 突破 shim 现有定位（§4 硬约束 1/3：只做展示翻译、不碰磁盘），需重新拍板；
2. **时序**：文件可能在 Read 之后被改动，shim 读盘拿到的是"现在"、模型读的是"当时"——实现上应在收到 tool_result 时**立刻读盘快照**；
3. **一致性**：模型看到截断/压缩版，用户看到原文（我方认为这是对的，但管控台需知情）。

**建议的落地顺序**（性价比从高到低）：
1. **图片旁路**（范围最小、收益确定）：图片无清洗逻辑，且上游本就把图片当特例（已绕开 256KB 上限），安全边界最好论证；
2. **清洗契约测试**：锁住"Read 输出格式一旦变化即测试失败"，防止静默错渲——**成本很低，可先于旁路做**；
3. **文本类全量旁路**：待 Bash 产出 / 读大文件的用例明确后再上。

**当前止血（M5 已做，不阻塞联调）**：分片读（带 `offset/limit`）**不包 resource、按裸 text 发**，绝不谎称是全文。更好的解是 `resource.uri` 带 fragment（`app.log#L5000-5199`）同时保住 mimeType 渲染与准确性，但那是**新的协议语义、需与管控台对齐**，且旁路落地后该问题自然消失，故不单独引入。

## 4. 给执行 agent 的硬约束（务必遵守）

1. **ywcoder 运行时零改动**：只在 `src/entrypoints/ywmatrix-shim/` 目录内工作（另加 scripts/build.ts 一个构建目标 + package.json 一个 bin），不碰 `cli.mjs`/`main.tsx` 运行时。
2. **stdout 洁净**：shim 对 AgentClient 的 stdout 只允许协议 JSONL，所有日志走 stderr。
3. **不代执行工具**：收 `tool_use` 只翻译成 `action`，工具由 ywcoder 自己跑。
4. **档位由 `--permission-mode` 决定**：`acceptEdits`/`bypassPermissions` = 简单档，不接控制面；`default` = 完整档，shim 自动补 `--permission-prompt-tool stdio` 并处理 `can_use_tool`（M4，见 §8）。
5. **字段以 [ywcoder-integration.md](ywcoder-integration.md) §4/§5/§6 为准**，schema 用 ywcoder 的 zod（`src/entrypoints/sdk/*Schemas.ts`）校验。
6. 复用 `ywmatrix-verify/verify*.mjs` 的骨架，别重造 spawn/读写轮子。

## 5. 对齐状态（详见 [ywcoder-integration.md §17](ywcoder-integration.md)）

**已与 AgentClient 团队谈定**：启动约定（command/args:`--workdir`+`--permission-mode`/cwd）、凭证走 ywcoder 本地配置、并发路由（一个 shim + `session_id`→子进程）、命令安全策略（管控台不做黑白名单）、**session_id 由网关生成、shim 原样采纳**（网关 `session.create` 时 `randomUUID()` 落库，浏览器每条 task 都带；「shim 在 ack 回填」方案已明确不采纳，见 [§9.2](ywcoder-integration.md)）、agent_id 由 AgentClient 定。

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

## 9. 执行结果与偏差（M5 文件/图片预览实测）

**交付**（均在既有文件上增量改，ywcoder 运行时仍零改动）：
- `ywcoderSession.ts`：`toolNameByUseId` 升级为 `toolInfoByUseId`（`tool_use_id → {name, file_path}`），`result` 事件带上 `filePath`。
- `protocol.ts`：`TypedContent` 从「仅 text」扩到 **text/image/resource**；`normalizeResultContent` 重写——文件读取类工具的文本结果清洗后包 `resource`（uri=file_path、mimeType 按扩展名推）、图片转 `image`（兼容 Anthropic `source.data/media_type` 与 MCP `data/mimeType` 两种形状）、image 与 resource 并存时只留 image；新增 `cleanReadOutput`（剥行号前缀 + 尾部 `<system-reminder>`）与 2MB 大小护栏 `applySizeGuard`。
- `protocol.test.ts`：新增 13 例纯函数单测（清洗逐字节核对、mimeType 推断、图片形状、去重、护栏三要素与截断边界）。
- `mock-agentclient.ts`：新增 `--scenario preview | preview-big`，`Scenario.setup` 铺装置文件；留存 result 内容块用于断言；超长协议行改为省略打印（预览块可达 MB 级）。

**验证**：`bun run build`、`bun run smoke`、`bun test src/entrypoints/ywmatrix-shim/`（21 例）通过；mock 真调模型端到端 **PASS**：

| 场景 | 实测结果 |
|---|---|
| `preview` | Read md → `resource{mimeType:text/markdown}`，`text` 与磁盘原文**逐字节一致**（无行号前缀、无 system-reminder）；Read csv → `resource{mimeType:text/csv}` 同样逐字节一致；Read png → `image{data,mimeType:image/png}`，**未重复发 resource**；agent 回答仍是 `text` 块 |
| `preview-big` | 3MB 文本：**ywcoder 的 Read 自身先拒**（见下方偏差 1），shim 原样转发其 `is_error` 文本，无大内容内联、任务照常 `completed` |
| `read`/`allow`/`deny`/`cancel`/`cancel-task` | M1~M4 全部不回归 |

**实现中发现的偏差与决定（均只在 shim 侧处理）**：
1. **⚠️ 2MB 护栏在当前 ywcoder 上「够不着」**：ywcoder 的 Read 有自己的 **256KB 文件大小上限**（[limits.ts](../../../src/tools/FileReadTool/limits.ts) `maxSizeBytes`，超限直接抛错）、图片按 25000 token 预算压缩（[FileReadTool.ts](../../../src/tools/FileReadTool/FileReadTool.ts) `readImageWithTokenBudget`）。因此**读文件这条路产不出 >2MB 的内容块**，`preview-big` 观测到的是 ywcoder 自己的 `is_error` 提示（优雅降级、任务照常）。护栏仍按定稿实现并保留——它是给未来 MCP 工具/agent 侧提取能力（docx/xlsx 抽文本）兜底的。**其字节级行为改由 `protocol.test.ts` 用合成的超限块验证**（截断保留开头 + 三要素文案 + 降级后块本身不超阈值）。
2. **`is_error` 的结果不包 resource**：Read 失败时 tool_result 文本是错误信息而非文件内容，包成 resource 会让管控台把报错当 md 渲。
3. **清洗顺序有讲究**：必须**先剥行号前缀、再剥尾部 `<system-reminder>`**。反过来做，剥 reminder 时前置的 `\s*` 会吃掉最后一行空行的 `N\t`，留下一个孤零零的行号数字。
4. **两种行号格式都要剥**：`addLineNumbers` 有紧凑（`N\t`，当前默认）与宽（`     N→`）两种格式，均已覆盖。
5. **未知扩展名回落 `text/plain` 而非 `application/octet-stream`**：走到该分支的内容已经是文本（源码、无扩展名配置），标成二进制流会让管控台连文件卡片里的文本预览都放弃。
6. **降级文案的阈值写作 `2MB` 而非 `2.0MB`**：对齐 §4.1 的文案样例。

**代码审查（`a8b2dc4` 后）发现并修复的 5 个真实缺陷**——均为「Read 输出的其它真实形态」，全部已复现、修复并加回归单测：

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| 1 | 尾部 `<system-reminder>` 用正则从左找起点 | 正文含**未闭合**的 `<system-reminder>`（讲 hook/prompt 的文档就这么写）时，从正文中间一路剥到文件末尾，**静默截断正文** | 改为从末尾倒着认（`lastIndexOf` + 配对校验），见 `stripTrailingSystemReminders` |
| 2 | 去重逻辑是「只要有 image 就丢掉全部 resource」 | Read 含图输出的 `.ipynb` 时（`mapNotebookCellsToToolResult` 返回 text+image 混合块），**源码全丢只剩一张图** | 去重判据限定在 **`image/*` 的 resource** 上 |
| 3 | 同一次 Read 的多个 text 块各自生成 resource | 管控台收到多张 uri 相同、各只有一段的卡片 | 合并成**一个** resource |
| 4 | 桩文本被当文件正文包进 resource | `FILE_UNCHANGED_STUB`（重复读未改动文件）、`PDF file read: …` 被当成文件正文渲染 | 以「**是否有行号前缀**」判定是否文件正文（`looksLikeFileBody`），比硬编码桩文本鲁棒 |
| 5 | 只剥尾部 reminder，未处理**前置**的 | 读 memdir 记忆文件（>1 天）时 `resource.text` 首行残留 `<system-reminder>This memory is N days old…</system-reminder>` | 新增 `stripLeadingSystemReminders`，并调整清洗顺序 |

**另一处按保守方案处理**：Read 带 `offset/limit` 的**分片读**结果只是文件片段（行号还被剥掉），旧实现会让管控台把 200 行片段当成整个 `app.log` 展示。现改为**分片读不包 resource、按裸 text 发**（绝不谎称是全文）。更好的解是 `resource.uri` 带 fragment（如 `app.log#L5000-5199`）同时保住 mimeType 渲染与准确性，但那是**新的协议语义、需与管控台对齐**，故未自行引入。

**遗留**：真实 AgentClient 联调待其交付；管控台侧 csv 表格化渲染本期在做（不阻塞 shim）；`toolInfoByUseId` 只增不删（改动前的 `toolNameByUseId` 亦然，属既有问题，未一并处理）。

**转入下一阶段**：预览保真问题（清洗脆弱、图片降质、大文件够不着、分片读语义）根因同一，已归并为 **§3 M7「让预览脱离模型的阅读管道」**，本期不做、已就地止血。
