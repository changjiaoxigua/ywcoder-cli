# ywmatrix-shim × AgentClient 真实环境联测清单

> 日期：2026-08-13 · 维护方：ywcoder / ywmatrix-shim
> 对应：[ywcoder-integration.md](ywcoder-integration.md)（技术方案与字段映射）、[local-agent-interface-v2.md](local-agent-interface-v2.md)（接口约定）
> 基线：`feature/ywmatrix-shim` 分支，ywcoder v1.2.5。本清单所有功能项已用 mock-agentclient 全量预演通过（真调模型），联测 = 把 mock 换成真实 AgentClient 原样复跑。

---

## 0. 联测前环境核对（双方先打勾，再开测）

| # | 核对项 | 责任方 | 说明 |
|---|---|---|---|
| 0.1 | 网关 `-task-timeout` 已调至 **30~60min** | 管控台 | 默认 5min 会让长任务全部误杀（§17-H 已协商） |
| 0.2 | AgentClient 以**正确用户身份**启动 shim，env 整体继承 | 管控台 | `HOME/USER/PATH` 必须对，ywcoder 要读本地配置/凭证（§17-B） |
| 0.3 | 启动命令：`ywcoder-ywmatrix --workdir <dir> --permission-mode default` | 管控台 | **cwd 无需设置**（早期版本要求 cwd==workdir，现 shim 启动后自行 `chdir(--workdir)`，见 §2） |
| 0.4 | provider 凭证在目标机器可用（`ywcoder` 本地能跑通一次问答） | 双方 | 先排掉凭证问题再进联测 |
| 0.5 | shim stderr 日志可采集 | 管控台 | 所有诊断信息在 stderr；stdout 只有协议 JSONL |

---

## P0 基本链路（通不了则后续免谈）

### 1. 启动与握手
- **步骤**：按 0.3 拉起 shim → 发 `lifecycle.initialize`
- **预期**：回 `result`（protocolVersion/capabilities/serverInfo）→ shim 随后发 `lifecycle.register`
- **对照**：integration §6.1 / §7

### 2. 单轮问答
- **步骤**：`task.create`（带网关生成的 UUID，`type:"chat"`，简单问题如"当前目录有哪些文件"）
- **预期**：收到 ack（`status:"accepted"`，session_id 回显一致）→ `lifecycle.status busy` → 若干 `stream.chunk`（text/action/result）→ `task.completed` → `lifecycle.status idle`

### 3. 多轮上下文
- **步骤**：同一 `session_id` 连发两条 task，第二条引用第一条的内容（如先让 agent 记住一个数字，再问它）
- **预期**：第二条路由到**同一存活子进程**，能答出第一条的上下文
- **排错**：若"失忆"，看 shim stderr 是否有「未带 session_id」告警——说明网关链路没带 id（§9.2：shim 兜底 mint 的 id 管控台不消费，多轮必断）

---

## P1 控制面（M4，本次交付核心）

前置：shim 以 `--permission-mode default`（完整档）启动。

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| 4 | **allow** | 让 agent 写文件（如"创建 hello.txt 内容为 hi"）→ 前端弹确认 → 点**确认** | `confirm_required`（level=warning）→ 回 `task.respond` → 文件真实落盘 → `task.completed` |
| 5 | **deny** | 同上，点**拒绝** | 文件**未**创建；模型收到拒绝理由后继续对话；任务仍是 `completed`（**不是** error） |
| 6 | **弹窗内取消** | 同上，点终止类按钮（结构化 `{decision:"cancel"}`） | deny + interrupt，本轮中止；后续该 session 仍可发新 task |
| 7 | **⚠️ 待决期间 task.cancel** | 确认框**还挂着**时点"停止" | 收到 `confirm_cancelled` + 任务中止。**v2 评审确认的 stdio 取消缺口，首次实测，优先验** |
| 8 | **confirm_id 失效** | 任务结束后，对已过期的 confirm_id 补回 `task.respond` | 返回 `-32000`，不算前端错误（§6.2.2 已确认） |

对照：mock 场景 `allow / deny / cancel / cancel-task`（mock-agentclient.ts），预期行为以 mock 输出为基准。

---

## P1 会话管理（§9.2 四分支）

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| 9 | **回收后续接** | 同 session 闲置至子进程被回收 → 再发 task | 走 `--resume <uuid>` 重建子进程，**历史上下文仍在** |
| 10 | **多 session 并发** | 两个不同 session_id 同时各发 task | 各自独立子进程，chunk 按 session_id 正确归属，互不串话 |
| 11 | **同 session 串行** | 同一 session_id 快速连发两条 task | 第二条排队，第一条完成后才执行（不会并发打进同一子进程） |
| 12 | **⚠️ 遗留确认项** | 部署层面确认 | **同一 session_id 必须始终路由回同一台机器的同一 workdir**（会话文件按机器+目录分桶落盘）。单机单目录部署暂不触发；多 agent 调度则必须网关保证绑定，否则静默丢上下文。reply-ack 已提出，需书面闭环 |

---

## P2 文件/图片预览（M5）

| # | 场景 | 预期 |
|---|---|---|
| 13 | agent Read 一个 .md / .csv | result chunk 带 `resource` 块：`mimeType` 正确（text/markdown、text/csv），`text` 干净——**无行号前缀、无尾部 `<system-reminder>`** |
| 14 | agent Read 一个 .png | 收到 `image` 块（base64 + image/png），**不重复**发对应 resource 块 |
| 15 | agent Read 大文件（>256KB） | 见附 A.2：当前先被 ywcoder Read 的 256KB 自限拦截（`is_error` 提示），shim 的 2MB 护栏本期兜底、不会触发 |

对照：mock 场景 `preview / preview-big`。

---

## 附 A. 文件能力边界（管控台须知）

### A.1 本期未实现的能力（请按此设预期，勿报为缺陷）

| 能力 | 状态 | 去向 |
|---|---|---|
| **文件回传/下载**（agent 生成的文件 → 管控台/用户） | ❌ 未实现 | §4.1 定稿即明确「纯预览、无下载」；生成物只在终端磁盘，想看内容只能让 agent Read 回来走预览管道（受 A.2 的大小/保真限制） |
| **文件上传**（用户/管控台给文件 → agent） | ❌ 未实现 | 路线图 **M6**（M6a 文本可先做、M6b 图片待 vision 能力）；`task.create` 目前只有 `content` 纯文本 |
| **大文件原文查看** | ❌ 本期不支持 | 归 **M7** 议题（让预览脱离模型阅读管道，详见 shim-build-plan.md §3 M7） |

本期**没有独立的文件下载/上传通道**——所有预览内容都寄生在 `stream.chunk` 协议流里，随 JSONL 走 WS。

### A.2 预览管道的大小关卡与保真边界

三道大小关卡，从里到外：

| 关卡 | 阈值 | 超限行为 | 联测可见现象 |
|---|---|---|---|
| **ywcoder Read 自限** | **256KB** | 直接返回 `is_error` 提示，不产内容块 | agent"读不了"大文件，管控台收到错误 result——**这是当前最先触发的关卡** |
| **shim 单块护栏**（§4.1，已定稿） | **2MB** | 优雅降级为 text 提示，文案带「文件名 + 实际大小 + 阈值」三要素：文本类截断保留前 ~2MB + 标注；图片/二进制只发提示（base64 截半无意义） | 本期**实际不会触发**（256KB 先拦截），是给未来 MCP 工具 / docx、xlsx 文本提取能力兜底的安全网，行为由 shim 单测字节级覆盖 |
| **网关落库上限** | 16MB（`messages.content` MEDIUMTEXT） | — | 2MB 护栏远低于此，协议层面安全 |

要点：

- **降级 ≠ 报错**：护栏触发时任务照常完成，原文件始终在终端磁盘上，管控台只是看不到内联内容；
- **图片有降质**：图片按模型 token 预算压缩（实测 261KB 原图 → 116KB、尺寸被 resize），图表坐标轴/图例可能糊——M7 已知边界，**非 bug**。

---

## P2 异常路径

| # | 场景 | 预期 |
|---|---|---|
| 16 | kill 掉某个 ywcoder 子进程 | 管控台收到 `event.error`；**其它 session 不受影响**；该 session 下条 task 自动 `--resume` 重建 |
| 17 | 重启 shim 进程后用原 session_id 发 task | 会话文件在磁盘，正常 `--resume` 恢复（shim 无需持久化任何映射） |

---

## 联测通过判据

- P0、P1 全部通过；P2 中 13/14 通过（15/16/17 可视环境条件安排）；
- 项 12 得到管控台书面确认（哪怕是"单机单目录暂不涉及"）；
- shim stderr 无未预期告警（「未带 session_id」告警出现即说明上游链路有 bug，需停下来查）。

## 问题反馈格式

发现问题时请附上：① `task_id` + `session_id`；② shim stderr 日志片段；③ 管控台侧收发的协议 JSONL。三者齐了我们这边能直接定位到分支。
