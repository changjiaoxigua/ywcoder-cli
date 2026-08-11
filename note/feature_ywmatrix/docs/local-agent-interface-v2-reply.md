# 回复：`local-agent-interface-v2.md` 评审反馈

> 日期：2026-08-11　·　回复方：ywmatrix 管控台
> 谢谢评审，4 个问题已全部处理，按优先级逐条回复。

## ① `decision: "cancel"` 语义（P0）— **采纳方案 A**

我们的实现恰好就是 A：

- 前端「停止当前任务」按钮（`static/index.html` stopBtn）发的是独立的 `task.cancel` 方法（§6.3 路径），不走 `task.respond`
- 弹窗「拒绝」按钮发 `decision: "deny"`，不发 `cancel`
- 协议里 `RESPOND_DECISION_CANCEL` 实际是预留位，前端目前不发——只有 shim 侧把它映射成 `{behavior:"deny", interrupt:true}` 才会出现

**已做改动**：

- §6.2.1 改为：`cancel` 中止整个任务，效果等同 §6.3 `task.cancel`，只是入口在确认框上
- 加了「前端约定」段：弹窗「×」/「关闭」按钮映射为 `deny`（只拦这一步、对话继续），明确的「终止任务」按钮才发 `cancel`

这与你们 shim 实际行为完全一致，零改动。

## ② `confirm_required` 示例的 `timeout: 60`（P1）— **已删**

§8.1 示例里的 `"timeout": 60` 已删除。同时加了注：

> `timeout` 字段在 schema 中可选，但 **shim 不发送**，缺省表示无限等待审批；**前端不得自行设置默认超时或倒计时自动关闭确认框**。用户从手机点进来需要十几分钟是正常情况。

## ③ §6.3 默认 5 分钟（P1）— **已修复，回信同步**

你们评审的应该是 v2 旧版本，文档和代码当前都是 30 分钟：

- `docs/local-agent-interface.md` §6.3：已写「默认 30 分钟」
- `src/gateway.ts` 默认 `task-timeout` = `1_800_000` ms（30m）
- `src/client.ts` 默认同步
- `README.md` / `docs/deployment.md` 已同步

刚在最近一次提交（`2f6ee12 feat: 30m task timeout, sendBtn state fix, browser notifications, HTTP cancel`）里完成。

## ④ `session_id` 由谁产生（P1）— **已确认现状：网关定，shim 透传**

经过重新核对，当前实现与我们最初设想的「shim 在 ack 回填」不同，实际链路是 **AgentClient（网关）定，Agent 透传**：

1. 用户在前端「新会话」时，浏览器调 `session.create` RPC
2. 网关用 `crypto.randomUUID()` 生成合法 UUID，写入 MySQL，返回
3. 浏览器存进 `state.sessions`，后续 `task.create` 始终携带这个 id
4. 网关透传给 client → adapter → shim → ywcoder `--resume <uuid>`

你们担心的「非 UUID 下发到 shim」实际不存在：
- 浏览器永远携带网关生成的 UUID
- `gateway.ts:1094` 的 `${task_id}-session` 兜底是死代码，永远不会触发

**关键约束**：到达 ywcoder 的 `session_id` 必须是合法 UUID（满足）。我们已经在 §6.1 / §12 文档化这个模式。

**明确不采纳「shim 在 ack 里回填」的方案**：AgentClient 不消费 ack 里的 `session_id`，shim 若自行回填只会造成「真相分裂」（AgentClient 一套 id、子进程一套 id）。请你们在 shim 里直接采纳网关下发的 `session_id`，不要再自行生成。

---

---

## 我们已采纳 / 无异议的部分

- §6.2.1 结构化 `{decision, message}` 回复格式（含 boolean / 自由字符串的旧版兼容）
- §6.2.2 `task.respond` 返回值形状、通知形式不回 result、`confirm_id` 失效返回 `-32000` 且不算前端错误
- §8.1 多确认框并存、按 `confirm_id` 路由、不维护「当前 confirm」全局态
- §8.1.1 `confirm_cancelled` 报文格式与 `reason` 三值枚举、幂等约定、前端在 `task.completed`/`event.error` 时兜底清框
- §6.3 stdio 适配器必须显式转发 `task.cancel`，以及子进程收到后的三步动作

暂不实现、不影响联调的可选项：`type:"code"` chunk（§7.5）、`stream.artifact`（§7.6）、`lifecycle.capabilities_updated`（§5.5）、错误码 `-32005`。

## 你们待办里需要对接的事项

1. **`confirm_cancelled` 补发**：我们已经能正确收 `confirm_cancelled` chunk（含 `reason: task_cancelled/interrupted/agent_exited` 三个值），可以放心补发。
2. **兼容通知形式的 `task.cancel`**：我们网关发的 `task.cancel` 是通知形式（不带 `id` 或 `id:null`），你们正在修的解析器修完后即可联调。
3. **`cancel` 语义**：按 ① 结论（方案 A），无需你们改动。

---

## 下一步

- 文档改动已落到 `docs/local-agent-interface.md`，我们这边单独提交。
- ④ 经核对当前实现已符合约定，无需代码改动。
- 这边主动跑：`npm test` 全过（51/51），不影响现有联调路径。

