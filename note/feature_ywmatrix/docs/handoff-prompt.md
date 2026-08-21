# 给其他 Agent 团队的接入提示词（ywmatrix 管控台接入）

> 用途：ywcoder 已完成 ywmatrix 管控台接入改造，本文件是发给其他 agent 团队、供其参考完成接入的提示词。发送时附 `architecture.md`、`local-agent-interface-v2.md`、`deployment.md` 三份文档。

---

你好，我们已完成了 ywcoder（编码类 CLI Agent）接入 ywmatrix 管控台的改造。改造方案是：**AgentClient 作为通用 Stdio JSONL 适配器 spawn 一个翻译 shim（随 ywcoder 打包，bin 名 `ywcoder-ywmatrix`），shim 对上对 AgentClient 说本地 Agent 协议、对下用 ywcoder 原生的 stream-json 模式与 ywcoder 子进程通信**。整个接入中 AgentClient 保持通用（只透传 `command/args/cwd`），全部翻译逻辑收敛在 agent 侧的 shim 里。你们的 agent 接入时也可以参考这个模式。

附件是三份核心文档，各自作用如下：

1. **`architecture.md` —— 系统总体架构设计**
   先读这份建立全局观：浏览器 ↔ 网关（gateway） ↔ 员工终端 AgentClient ↔ 本地 Agent 的三层 WebSocket/适配器架构、各组件职责、通信机制、消息路由流程、连接生命周期、并发模型与安全设计。回答的是"整个系统怎么转起来、消息怎么流"。

2. **`local-agent-interface-v2.md` —— 本地 Agent 接口标准（接入方的核心契约）**
   这是你们接入时**必须严格遵守**的协议规范，定义 AgentClient 与本地 Agent 之间的通信：JSON-RPC 2.0 信封、`lifecycle.*`（initialize 能力协商 / register 注册 / ping / status）、`task.*`（create / respond / cancel / completed）、`stream.chunk` 流式输出（text / thinking / action / result / confirm_required / prompt_required / confirm_cancelled 等）、`event.*`、错误码、session_id/task_id 会话模型。你们的 agent（或其 shim）最终要说的话都在这份里。

3. **`deployment.md` —— 部署指南**
   落地运维参考：跨平台构建（含麒麟 arm64/loong64、Win7）、网关部署（systemd/Nginx）、终端 AgentClient 部署（含 `-adapter stdio/http` 用法）、本地 Agent 部署形态、参数说明与常见问题排查。

**接入要点提醒（ywcoder 侧踩过的坑，供参考）：**

- 启动约定：AgentClient 通用透传 `command/args/cwd`，你们的 agent 入口自行解析参数（如 `--workdir`），AgentClient 不解释 args。
- `session_id` 由网关生成（小写 UUID），本地 agent 侧原样采纳做路由键；同一 `session_id` 的任务串行，不同 session 独立子进程。
- 权限确认走 `confirm_required ↔ task.respond`：`task.respond` 的 `response` 是结构化 `{decision: allow|deny|cancel}` 对象（v2 §6.2.1）；**确认框撤销必须补发 `confirm_cancelled`**，否则前端框会一直挂着。
- `task.cancel` 是通知（不带 id）：stdio 适配器已修复会显式转发取消，收到后必须真正中断被控进程并清理待决确认，否则"停止"是假的。
- 大内容（文件/图片预览）走 typed content（`resource`/`image` 块），单块超 2MB 需降级为提示文本。

如需我们侧的完整落地参考（ywcoder shim 的字段级映射、握手时序、权限控制面细节），另有 `ywcoder-integration.md` 可索取。

---

## 简洁版

你好，ywcoder 已完成 ywmatrix 管控台接入，改造思路是：**原 agent 零改动，新增一个随 agent 打包的独立翻译模块（shim）**——它对外对 AgentClient 说本地 Agent 协议，对内驱动 agent 子进程，只做两套协议的纯翻译。AgentClient 保持通用：把 shim 当普通子进程拉起，只透传 `command`（启动命令）/`args`（启动参数），不感知任何 agent 特有逻辑。你们的 agent 接入可参考此模式，随附三份文档：

1. **`architecture.md`** — 系统总览：浏览器 ↔ 网关 ↔ AgentClient ↔ 本地 Agent 的三层架构与消息流转。
2. **`local-agent-interface-v2.md`** — 接入契约（核心）：AgentClient 与本地 Agent 间的 JSON-RPC 2.0 协议规范（`lifecycle.*` / `task.*` / `stream.chunk` / `event.*`、错误码、会话模型），你们的 agent 按这份实现。
3. **`deployment.md`** — 部署运维：跨平台构建、网关与终端 AgentClient 部署、参数与排错。

几个关键约定：`session_id` 由网关生成、原样采纳做路由键；确认走 `confirm_required ↔ task.respond{decision:allow|deny|cancel}`，撤销需补发 `confirm_cancelled`；`task.cancel` 必须真正中断子进程；大内容走 typed content（resource/image 块，单块超 2MB 降级为提示）。另外说明：ywcoder 的 shim 能做得很薄，是因为 ywcoder 自带 `--output-format stream-json` 无头模式（结构化事件流 + 权限控制面），对内几乎纯映射；你们的 shim「对内怎么驱动 agent」取决于各自 agent 的可编程接口形态（无头模式 / API / 交互式 CLI），这部分需要各自设计，对外协议契约则完全一致。如需字段级落地参考，另有 `ywcoder-integration.md` 可索取。
