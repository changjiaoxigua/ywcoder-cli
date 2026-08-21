# ywmatrix-shim 适配 local-agent-interface v3 —— 设计方案

> 背景：AgentClient 侧 2026-08-19 发布 [local-agent-interface-0819-v3.md](local-agent-interface-0819-v3.md)（下称 v3，对应旧版 local-agent-interface-v2.md）。
> 本文给出 shim（`src/entrypoints/ywmatrix-shim/`）的适配设计，不动 ywcoder 运行时（沿用 §4 硬约束）。
> 前置阅读：[ywcoder-integration.md](ywcoder-integration.md)、[shim-build-plan.md](shim-build-plan.md)。

## 0. v3 改动结论回顾

**已符合、无需改动**（v3 只是把我们已谈定的约定写进协议）：

| v3 条目 | shim 现状 |
|---|---|
| §6.1 session_id 网关生成、Agent 不回填 | ✅ §9.2 已按此实现（mint 仅为防御兜底并告警） |
| §6.2.1 `cancel`=中止整个任务、「×」映射 `deny` | ✅ M4 已实现（方案 A） |
| §6.3 任务超时默认 30min | ✅ 正是 §17-H 争取的值，client 侧已落 |
| §8.1 confirm `timeout` shim 不发送、前端不得自设 | ✅ shim 从未发送 |

**需要适配**（本文主体）：

| 优先级 | v3 条目 | 适配点 |
|---|---|---|
| P0 | §6.1.2 `metadata.workdir` 会话级工作目录 | 路由与 spawn 按会话携带 workdir |
| P1 | §6.5.1 `/model`、`/permission` 会话内切换 | command 声明 + 控制面 `set_model`/`set_permission_mode` |
| P2 | §6.5 通用斜杠命令 | 受限于 stream-json 能力，只声明可本地执行者 |
| P3 | §6.1.1 `metadata.group` / §6.6 `task.invoke` 编排 | 本期透传忽略，单独立项 |

## 1. P0 —— `metadata.workdir` 会话级工作目录

### 1.1 现状与问题

- shim 启动时 `process.chdir(--workdir)`（index.ts:494），全实例一个工作目录；
- `YwcoderSession.spawn` 的 `workdir` 已是 per-session 参数（cwd 与 `--add-dir`），**但** `resolveLaunchMode` 里的 `sessionIdExists(sessionId)`（sessionStorage.ts:401）按 **shim 进程 cwd** 推导分桶——多 workdir 下会判错 create/resume 分支；
- v3 要求：workdir 绑定在**会话**上，每条 `task.create.metadata.workdir` 注入，同一 shim 实例的不同会话可在不同目录干活。

### 1.2 设计

**取值优先级**：`task.create.metadata.workdir` > 启动参数 `--workdir`（实例默认）。v3 §6.1.2 明确"优先级由 Agent 自行决定"，取此顺序：页面显式设置优先于实例默认。

**会话表扩展**：`SessionEntry` 增加 `workdir` 字段；路由键仍是 `session_id`（管控台侧 workdir 绑定在会话上，同一会话正常不会频繁换目录）。

**workdir 变更语义**：同一 `session_id` 的 workdir 发生变化 = 换会话分桶（ywcoder 会话文件按工作目录分桶，§9.2 分支表第三行）。处理：
1. 新 task 携带的 workdir 与 entry 不符时，**先重拉子进程**（kill 旧的，按新 workdir spawn）；
2. 新分桶下该 session_id 的存在性独立判断：存在 → `--resume`，不存在 → `--session-id` 新建（与原分支逻辑一致，只是分桶变了）；
3. 排队中的 task 各自记录到达时的 workdir，`pump` 时与 entry 比对，不一致先重拉再喂。

**sessionIdExists 参数化（关键实现点）**：不再依赖 `process.chdir`。shim 侧自行计算分桶并查文件：

```ts
import { getProjectDir } from '../../utils/sessionStorage.js'
// 与 ywcoder 完全一致的分桶推导：realpath + sanitizePath（getProjectDir 内部），
// 只是 cwd 从「进程当前目录」换成「本 session 的 workdir」。
function sessionIdExistsIn(sessionId: string, workdir: string): boolean {
  const projectDir = getProjectDir(realpathSync(workdir))
  return existsSync(join(projectDir, `${sessionId}.jsonl`))
}
```

- `getProjectDir` 是按入参 memoize 的纯函数，多 workdir 并存无串扰；
- `realpathSync` 沿用 M1~M3 已修过的 macOS `/tmp` 符号链接坑（shim-build-plan §7 偏差 4）；
- 保留启动时的 `process.chdir(--workdir)` 不动（实例默认目录，兜底字段仍正确），但存在性判断一律走 `sessionIdExistsIn`。**ywcoder 源码零改动**。

**`YwcoderSession` 改动**：`resolveLaunchMode` 改用 `sessionIdExistsIn(this.sessionId, this.opts.workdir)`；其余不动（cwd/`--add-dir` 本就吃 opts.workdir）。

### 1.3 边界情况

| 场景 | 行为 |
|---|---|
| task 不带 `metadata.workdir` | 回落实例 `--workdir`（现状不变，v3：未绑定会话没有该字段） |
| workdir 不存在/不可读 | spawn 失败 → 走既有 `failPendingTasks` 逐个 `event.error` |
| 同 session 连续两个 task 不同 workdir | 第二个 task 触发重拉；第一个任务上下文留在旧分桶（协议语义如此：换目录即换上下文） |
| workdir 变化时有待决确认 | 重拉前按既有 `clearPendingConfirms(reason:'agent_exited')` 撤框 |

## 2. P1 —— `/model` 与 `/permission` 会话内切换（v3 §6.5.1）

### 2.1 命令声明（capabilities）

`lifecycle.register` 的 capabilities 扩到三类（全量替换语义，变化时推 `lifecycle.capabilities_updated`）：

```json
[
  { "type": "chat", "name": "coding", "description": "编码助手，可读写文件、执行命令、分析代码" },
  { "type": "command", "name": "model", "description": "切换模型",
    "metadata": { "current": "<当前模型>", "args": [
      { "name": "model", "type": "enum", "options": ["<initialize 返回的 models>"], "required": true } ] } },
  { "type": "command", "name": "permission", "description": "切换权限模式",
    "metadata": { "current": "<当前模式>", "args": [
      { "name": "mode", "type": "enum", "options": ["default", "acceptEdits", "bypassPermissions"], "required": true } ] } }
]
```

- **模型 options 来源**：ywcoder initialize 握手 `control_response{success}.response.models`（print.ts:4470 `modelInfos`）。`YwcoderSession` 握手时缓存该列表（新增事件或挂到 session 对象上），shim 取**首个就绪 session** 的列表填充；列表为空时退化为不声明 `model` 命令。
- **权限 options 用词**：v3 示例是 `default/auto/full_auto`，但那只是示例——options 由 Agent 声明、页面照单渲染，**词表是我们的自由**。直接声明 ywcoder 真实值 `default/acceptEdits/bypassPermissions`，杜绝一层映射表和歧义。⚠️ 需与管控台确认页面无硬编码词表（开放问题 §6-1）。
- `metadata.current` 是唯一事实来源（v3）：shim 在 `SessionEntry` 记 `model`/`permissionMode`，切换成功后才更新并推 `capabilities_updated`。

### 2.2 命令接收（`metadata.command` 双通道）

`TaskCreateParamsSchema` 的 `metadata` 已是 `z.record` 透传，无需改 schema；在 `handleTaskCreate` 增加解析：

```ts
// 优先 metadata.command（结构化，免解析）；不存在退化解析 content 的 '/' 前缀（v3 §6.5）
const cmd = parseCommand(params.metadata?.command) ?? parseSlashPrefix(params.content)
// parseCommand: { name: 'model', args: { model: 'kimi-k2' } } → { name:'model', value:'kimi-k2' }
// 自由文本参数约定走 args.text（v3）
```

未识别的命令：**不报错**，按普通 `content` 喂给 ywcoder（v3：未声明的 `/xxx` 文本也原样送达，Agent 自行决定识别与否——模型看到 `/xxx` 文本通常会合理回应，优于静默失败）。

### 2.3 命令执行（本地、不走 LLM）

命令作为普通 task 进入该 session 的**串行队列**（天然满足 v3「busy 时切换命令排队」），`pump` 到队首时由 shim 本地执行，**不喂给 ywcoder**：

**`/model <m>`**：
1. 校验 `<m>` 在握手缓存的 models 列表内（不在 → 回一条错误 text chunk + `task.completed`，不改动状态）；
2. 更新 `SessionEntry.model`；若子进程存活，发 `control_request{set_model}`（controlSchemas.ts:137，ywcoder 运行时支持，print.ts:2934）；
3. 回确认 text chunk（「已切换模型：A → B」）+ `task.completed` + `capabilities_updated`（新 current）。

**`/permission <mode>`**：
1. 校验 `<mode>` ∈ 声明的 options；
2. 更新 `SessionEntry.permissionMode`；若子进程存活，发 `control_request{set_permission_mode}`（controlSchemas.ts:124，print.ts:2919）；
3. 回确认 chunk + `task.completed` + `capabilities_updated`。

**重拉一致性（容易漏的点）**：子进程会因 interrupt 看门狗强杀、崩溃、workdir 变更而重拉——spawn 参数必须取 `SessionEntry` 里**当前的** model/permissionMode，而非启动 CLI 参数，否则用户切过的状态被静默还原。即 `spawnSession` 的入参从 `this.args.*` 改为 `entry.*`（首建时用 `this.args.*` 初始化 entry）。

### 2.4 ⚠️ 开放验证项：权限档位与控制面的组合

现状：仅 `default` 档启动时补 `--permission-prompt-tool stdio`（ywcoderSession.ts:193）。运行时用 `set_permission_mode` **切入** `default` 后，需批准的工具能否走 `can_use_tool` 控制面，取决于 stdio permission-prompt-tool 是否在启动时装配——若启动时是 `bypassPermissions` 而没装，切入 default 后工具可能本地直接 `is_error` 失败、网页收不到确认。

两个候选方案：
- **方案 A（优选）**：启动时**无条件**带 `--permission-prompt-tool stdio`，权限档位完全交给运行时的 mode。需实测验证：`acceptEdits`/`bypassPermissions` 档下工具仍自动放行、**不触发** `can_use_tool`（预期如此：bypass 短路在权限判定层，prompt-tool 只在"需要批准"时被咨询）。
- **方案 B（兜底）**：切入/切出 `default` 时按 v3 建议"同 session-id 重拉子进程"（transcript 落盘，上下文不丢），切换耗时数秒。

**验证方式**：mock 场景 `perm-switch`——bypass 启动 → `/permission default` → 触发 Write → 断言收到 `confirm_required`。方案 A 验证通过则采用，否则落 B。

### 2.5 明确不做

- 切到宽权限模式时的二次确认弹框：v3 明确"这是前端选择，不进协议"，shim 不做；
- 页面下拉框 busy 置灰：前端行为，shim 只需保证串行队列正确。

## 3. P2 —— 通用斜杠命令（受限支持）

**关键事实（已核实）**：stream-json 模式**没有命令执行通路**——控制面无 `run_command` subtype，print.ts 的用户消息路径也不解析 `/` 前缀。ywcoder initialize 返回的 `commands` 列表（/compact、技能等）在 stream-json 下**无法被 shim 触发执行**。

因此：
- shim **只声明能本地执行的命令**（本期的 `model`、`permission`）。声明了执行不了 = 页面上能点但点了没效果，比不声明更糟；
- initialize 返回的 `commands` 列表**暂不**翻译成 capabilities 上报；
- 用户手输的其它 `/xxx` 文本按 §2.2 兜底喂给模型；
- 后续若 ywcoder 上游增加命令执行控制请求（或 shim 找到安全的执行通路），再扩声明列表——届时技能类标 `metadata.kind:"skill"` 分组展示。

## 4. P3 —— 群聊与编排（本期不实现）

- **`metadata.group`（§6.1.1）**：v3 明确"不识别该字段的 Agent 行为不变"。本期透传忽略（schema 已透传 metadata，无需任何改动）。后续若支持，是把群上下文注入模型可见 prompt 的纯 shim 侧工作。
- **`task.invoke` / `task.subtask_result`（§6.6）**：shim 作为 agent 侧是**发起方**而非接收方——不实现即不发起，无兼容负担。群聊多 Agent 编排是独立场景，建议单独立项，不阻塞当前联调。

## 5. 影响文件清单

| 文件 | 改动 |
|---|---|
| `protocol.ts` | `buildRegisterNotification` 改动态 capabilities（接收命令声明列表）；新增 `buildCapabilitiesUpdatedNotification`、`parseCommand`/`parseSlashPrefix`；`StreamChunkParams` 复用（确认 chunk 走既有 text） |
| `ywcoderSession.ts` | `resolveLaunchMode` 改用 `sessionIdExistsIn`；握手缓存 `models` 列表并暴露；新增 `setModel(model)`、`setPermissionMode(mode)` 两个控制请求方法 |
| `index.ts` | `SessionEntry` 加 `workdir/model/permissionMode`；task 队列项带 workdir；workdir 不符时重拉逻辑；`handleTaskCreate` 命令分流；命令本地执行 + 确认 chunk + `capabilities_updated`；spawn 参数改取 entry 当前值 |
| `protocol.test.ts` | 新增纯函数单测：`parseCommand`/`parseSlashPrefix` 双通道与优先级、命令校验失败路径、capabilities 全量替换构造 |
| `mock-agentclient.ts` | 新场景：`workdir`（两目录切换 + 续接正确性）、`model-switch`、`perm-switch`（即 §2.4 的验证场景） |

ywcoder 运行时零改动；`scripts/build.ts`、`package.json` 不动。

## 6. 开放问题（需与管控台对齐）

1. **权限 options 词表**：shim 拟直接声明 ywcoder 真实值 `default/acceptEdits/bypassPermissions`（而非 v3 示例的 `default/auto/full_auto`）。确认页面按 Agent 声明渲染、无硬编码词表；如页面希望中文显示名，`metadata.args[].options` 是否需要扩成 `{value,label}` 结构（v3 目前只有字符串数组）。
2. **模型 options 的来源与稳定性**：initialize 返回的 `models` 列表按 provider 配置而变；shim 以首个就绪 session 的列表为准。若管控台要求"会话级可选模型集合一致"，需要网关侧约定。
3. **workdir 切换中的 task**：v3 未规定"会话已有存活子进程时改绑 workdir"的语义，本文按「换目录=换分桶，重拉子进程」实现（与 ywcoder 会话存储模型一致）。报备管控台知悉即可，无需其改动。

## 7. 实施顺序与验收

1. **P0 workdir**（~1d）：单测 + mock `workdir` 场景 PASS（两目录各自建会话、换回旧目录正确 `--resume`）。
2. **P1 命令**（~1.5d）：先跑 §2.4 验证场景定 A/B 方案 → 单测 + mock `model-switch`/`perm-switch` PASS（确认 chunk、current 更新、重拉后状态保持）。
3. **回归**：M1~M5 既有 mock 场景（read/allow/deny/cancel/cancel-task/preview）全量不回归；`bun run build && bun run smoke && bun test src/entrypoints/ywmatrix-shim/`。
4. P2/P3 按 §3/§4 结论归档，不在本期实施。
