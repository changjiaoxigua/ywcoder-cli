# 通信协议规范

## 1. 设计原则

本协议用于**用户页面、网关、终端 AgentClient、本地 Agent** 四方之间的实时通信。设计时参考了以下业界成熟方案：

| 参考协议 | 借鉴点 |
|---------|--------|
| **JSON-RPC 2.0** | 请求/响应信封、`id` 关联、标准错误对象 |
| **LSP (Language Server Protocol)** | 流式进度通知（`$/progress`）、部分结果（partial results） |
| **MCP (Model Context Protocol)** | JSON-RPC 2.0 信封、能力协商、typed content |
| **A2A (Agent2Agent)** | Agent 身份标识、任务（task）语义、多轮协作 |
| **STOMP / MQTT** | 基于主题的发布订阅思想（用于 agent_list 广播） |

注意：本协议不照搬 MCP 的工具调用模型。本地 Agent 自己就是 AI，工具调用、确认、提示等由 Agent 自行决定并通过流式消息输出；`capabilities` 仅作为描述性标签供页面展示。

设计原则：
- **基于 JSON-RPC 2.0**：信封简单、成熟、易于调试
- **统一信封**：所有消息用同一格式，便于统一日志和审计
- **请求可追踪**：每个请求有唯一 `id`，响应和流式 chunk 都能对应
- **能力协商**：连接建立时交换能力，避免硬编码
- **用户隔离**：每个 Agent 属于一个用户，用户只能管理自己的 Agent
- **流式原生支持**：不依赖 HTTP SSE，WebSocket 内原生支持进度通知
- **错误标准化**：错误码、错误消息、扩展数据分离

## 2. 消息信封

所有 WebSocket 消息都是 JSON，必须符合 JSON-RPC 2.0 基本结构。

### 2.1 请求/通知

```json
{
  "jsonrpc": "2.0",
  "id": "req-uuid-or-null",
  "method": "agent.chat",
  "params": { ... }
}
```

- `jsonrpc`: 固定为 `"2.0"`
- `id`: 请求唯一标识，字符串或数字；通知（不需要响应）为 `null` 或省略
- `method`: 方法名，点分命名空间，如 `agent.chat`、`system.heartbeat`
- `params`: 方法参数，对象或数组，推荐对象

### 2.2 成功响应

```json
{
  "jsonrpc": "2.0",
  "id": "req-uuid",
  "result": { ... }
}
```

### 2.3 错误响应

```json
{
  "jsonrpc": "2.0",
  "id": "req-uuid",
  "error": {
    "code": -32600,
    "message": "Invalid Request",
    "data": {
      "detail": "missing required field 'agent_id'"
    }
  }
}
```

## 3. 认证与授权

### 3.1 Token 格式

WebSocket 连接通过 URL Query 参数传递 Token：

```
/ws/agent?token=user:zhangsan
/ws/admin?token=user:zhangsan
```

Token 格式：

| 前缀 | 角色 | 权限 |
|------|------|------|
| `user:<user_id>` | 用户 | 只能看到和管理自己拥有的 Agent |

无 Token 或格式错误，网关返回 `401 Unauthorized`。

### 3.2 Agent 所有权

AgentClient 连接时必须使用 `user:<user_id>` Token。网关从 Token 中提取 `owner_id`，Agent 注册时携带的 `owner_id` 会被忽略（防止伪造）。

用户页面连接时只显示 `owner_id` 与自己 `user_id` 相同的 Agent。

### 3.3 操作授权

用户发送 `task.create` 时，网关会检查是否有权操作目标 Agent：
- 只允许操作 `owner_id` 与自己 `user_id` 相同的 Agent
- 越权操作返回 `-32004 Unauthorized`

## 4. 标准错误码

| 错误码 | 名称 | 说明 |
|--------|------|------|
| `-32700` | Parse error | JSON 解析失败 |
| `-32600` | Invalid Request | 请求格式非法 |
| `-32601` | Method not found | 方法不存在 |
| `-32602` | Invalid params | 参数错误 |
| `-32603` | Internal error | 内部错误 |
| `-32000` | Agent not found | 目标 Agent 不在线 |
| `-32001` | Agent timeout | Agent 响应超时 |
| `-32002` | Task cancelled | 任务被取消 |
| `-32003` | Local agent error | 本地 Agent 执行出错 |
| `-32004` | Unauthorized | 未授权操作 |

## 5. 命名空间与方法

方法名采用 `namespace.action` 格式：

| 命名空间 | 用途 |
|---------|------|
| `system.*` | 系统级消息（心跳、注册、状态） |
| `agent.*` | Agent 相关（AgentClient 与网关之间） |
| `admin.*` | 用户页面相关（页面与网关之间，命名空间保留 `admin`） |
| `task.*` | 任务相关（创建、取消、进度） |

## 6. 生命周期消息

### 6.1 Agent 注册（AgentClient → Gateway）

```json
{
  "jsonrpc": "2.0",
  "id": "reg-001",
  "method": "system.register",
  "params": {
    "agent_id": "demo-mac",
    "name": "张三的 MacBook",
    "version": "1.0.0",
    "capabilities": [
      {
        "type": "chat",
        "name": "coding",
        "description": "编码助手，可读写文件、执行命令、分析代码"
      }
    ],
    "platform": {
      "os": "darwin",
      "arch": "arm64",
      "hostname": "zhangsan-mac"
    }
  }
}
```

网关响应：

```json
{
  "jsonrpc": "2.0",
  "id": "reg-001",
  "result": {
    "status": "ok",
    "server_time": "2026-07-07T12:00:00Z"
  }
}
```

### 6.2 心跳（双向通知）

AgentClient 定期发送：

```json
{
  "jsonrpc": "2.0",
  "method": "system.heartbeat",
  "params": {
    "agent_id": "demo-mac",
    "timestamp": "2026-07-07T12:00:30Z"
  }
}
```

网关可选回复：

```json
{
  "jsonrpc": "2.0",
  "method": "system.heartbeat",
  "params": {
    "timestamp": "2026-07-07T12:00:30Z"
  }
}
```

### 6.3 Agent 状态更新（AgentClient → Gateway）

```json
{
  "jsonrpc": "2.0",
  "method": "system.status",
  "params": {
    "agent_id": "demo-mac",
    "status": "busy",
    "task_id": "task-001",
    "message": "正在执行命令"
  }
}
```

## 7. 用户与 Agent 交互

### 7.1 用户创建任务（User → Gateway）

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "method": "task.create",
  "params": {
    "agent_id": "demo-mac",
    "task_id": "task-001",
    "type": "chat",
    "content": "帮我执行一个任务"
  }
}
```

### 7.2 网关转发任务给 AgentClient（Gateway → AgentClient）

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "method": "agent.chat",
  "params": {
    "task_id": "task-001",
    "session_id": "session-001",
    "content": "帮我执行一个任务",
    "metadata": {
      "requester": "user-zhangsan",
      "timestamp": "2026-07-07T12:00:00Z"
    }
  }
}
```

### 7.3 AgentClient 立即响应已接收

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": {
    "status": "accepted",
    "task_id": "task-001"
  }
}
```

### 7.4 AgentClient 上报进度（流式）

参考 LSP 的 `$/progress`，AgentClient 发送进度通知。`value.content` 推荐采用 typed content 数组，与本地 Agent 的 `stream.chunk` 保持一致：

```json
{
  "jsonrpc": "2.0",
  "method": "$/progress",
  "params": {
    "token": "task-001",
    "value": {
      "kind": "report",
      "agent_id": "demo-mac",
      "session_id": "session-001",
      "content": [{"type": "text", "text": "正在分析"}],
      "percentage": 10
    }
  }
}
```

最终完成时：

```json
{
  "jsonrpc": "2.0",
  "method": "$/progress",
  "params": {
    "token": "task-001",
    "value": {
      "kind": "end",
      "agent_id": "demo-mac",
      "session_id": "session-001",
      "content": [{"type": "text", "text": "任务执行完成"}],
      "done": true
    }
  }
}
```

### 7.5 网关转发给用户页面（Gateway → User page）

网关把 `$/progress` 转发给用户页面，`content` 保持 typed content 数组：

```json
{
  "jsonrpc": "2.0",
  "method": "admin.task.progress",
  "params": {
    "task_id": "task-001",
    "agent_id": "demo-mac",
    "session_id": "session-001",
    "content": [{"type": "text", "text": "正在分析"}],
    "percentage": 10,
    "done": false
  }
}
```

### 7.6 任务完成响应

如果任务最终需要返回结构化结果：

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": {
    "task_id": "task-001",
    "status": "completed",
    "summary": "任务执行完成"
  }
}
```

### 7.7 用户回复确认或输入（User → Gateway）

当本地 Agent 返回 `confirm_required` 或 `prompt_required` 时，页面让用户回复：

```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "method": "task.respond",
  "params": {
    "agent_id": "demo-mac",
    "task_id": "task-001",
    "session_id": "session-001",
    "confirm_id": "c-001",
    "response": "确认"
  }
}
```

网关转发给 AgentClient：

```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "method": "agent.respond",
  "params": {
    "task_id": "task-001",
    "session_id": "session-001",
    "confirm_id": "c-001",
    "response": "确认"
  }
}
```

AgentClient 通过适配器把回复交给本地 Agent，本地 Agent 继续执行。

## 8. 任务取消

### 8.1 用户取消任务（User → Gateway）

```json
{
  "jsonrpc": "2.0",
  "id": "req-002",
  "method": "task.cancel",
  "params": {
    "task_id": "task-001"
  }
}
```

### 8.2 网关转发取消（Gateway → AgentClient）

```json
{
  "jsonrpc": "2.0",
  "id": "req-002",
  "method": "agent.cancel",
  "params": {
    "task_id": "task-001"
  }
}
```

### 8.3 取消完成

```json
{
  "jsonrpc": "2.0",
  "id": "req-002",
  "result": {
    "task_id": "task-001",
    "status": "cancelled"
  }
}
```

## 9. Agent 列表广播

### 9.1 网关广播在线 Agent（Gateway → User page）

```json
{
  "jsonrpc": "2.0",
  "method": "admin.agentList",
  "params": {
    "agents": [
      {
        "id": "demo-mac",
        "name": "张三的 MacBook",
        "status": "online",
        "capabilities": [
          {"type": "chat", "name": "coding", "description": "编码助手"}
        ],
        "platform": {"os": "darwin", "arch": "arm64"}
      }
    ]
  }
}
```

### 9.2 Agent 事件通知

```json
{
  "jsonrpc": "2.0",
  "method": "admin.agent.event",
  "params": {
    "event": "offline",
    "agent_id": "demo-mac",
    "timestamp": "2026-07-07T12:05:00Z"
  }
}
```

事件类型：`online`、`offline`、`status_changed`、`capability_changed`

## 10. AgentClient 与本地 Agent 的接口

> 完整本地 Agent 接口标准见 [docs/local-agent-interface.md](local-agent-interface.md)。本文只列出最小可用子集。

AgentClient 通过**适配器**与本地 Agent 通信。适配器屏蔽了本地 Agent 的具体形态，上层网关协议保持一致。

### 10.1 通用消息格式

AgentClient 发给本地 Agent 的请求（`task.create` 的 `params`）：

```json
{
  "task_id": "task-001",
  "session_id": "session-001",
  "type": "chat",
  "content": "帮我执行一个任务"
}
```

`type` 为 `chat` 表示新消息，`respond` 表示用户对确认/反问的回复。

本地 Agent 返回的流式 chunk（JSON-RPC 通知）：

```json
{"jsonrpc": "2.0", "method": "stream.chunk", "params": {"task_id": "task-001", "type": "text", "content": [{"type": "text", "text": "收到指令"}]}}
{"jsonrpc": "2.0", "method": "stream.chunk", "params": {"task_id": "task-001", "type": "confirm_required", "confirm_id": "c-001", "content": [{"type": "text", "text": "确认执行 rm -rf /tmp ?"}]}}
{"jsonrpc": "2.0", "method": "stream.chunk", "params": {"task_id": "task-001", "type": "prompt_required", "prompt_id": "p-001", "content": [{"type": "text", "text": "选择文件"}], "options": ["a.txt", "b.txt"]}}
{"jsonrpc": "2.0", "method": "stream.chunk", "params": {"task_id": "task-001", "type": "text", "content": [{"type": "text", "text": "完成"}], "done": true}}
```

chunk `type` 说明：

| type | 含义 |
|------|------|
| `text` | 普通文本输出 |
| `thinking` | 思考过程 |
| `action` | Agent 内部动作记录（原 `tool_use`） |
| `result` | 动作结果（原 `tool_result`） |
| `confirm_required` | 需要用户确认 |
| `prompt_required` | 需要用户输入/选择 |
| `block_required` | 需要用户填写表单/复杂交互 |

### 10.2 HTTP 适配器

本地 Agent 暴露 HTTP 接口：

```http
GET /capabilities

HTTP/1.1 200 OK
Content-Type: application/json

{
  "capabilities": [
    {"type": "chat", "name": "coding", "description": "编码助手"}
  ]
}
```

```http
POST /tasks
Content-Type: application/json

{
  "task_id": "task-001",
  "session_id": "session-001",
  "type": "chat",
  "content": "帮我执行一个任务"
}
```

返回 SSE（每个 `data:` 行是一条 JSON-RPC 通知）：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"jsonrpc": "2.0", "method": "stream.chunk", "params": {"task_id": "task-001", "type": "text", "content": [{"type": "text", "text": "收到指令"}], "done": false}}

data: {"jsonrpc": "2.0", "method": "stream.chunk", "params": {"task_id": "task-001", "type": "text", "content": [{"type": "text", "text": "完成"}], "done": true}}
```

### 10.3 Stdio 适配器

本地 Agent 作为子进程启动，AgentClient 通过 stdin/stdout JSON lines 通信。

AgentClient 向 stdin 写入：

```text
{"type":"chat","task_id":"task-001","session_id":"session-001","content":"帮我执行一个任务"}
```

本地 Agent 向 stdout 写入 JSON-RPC 通知：

```text
{"jsonrpc":"2.0","method":"stream.chunk","params":{"task_id":"task-001","type":"text","content":[{"type":"text","text":"收到指令"}]}}
{"jsonrpc":"2.0","method":"stream.chunk","params":{"task_id":"task-001","type":"confirm_required","confirm_id":"c-001","content":[{"type":"text","text":"确认执行吗？"}]}}
```

当本地 Agent 返回 `confirm_required` 或 `prompt_required` 时，本次请求读取暂停，等待用户通过 `task.respond` 回复后继续。

## 11. 消息时序图

### 11.1 用户发送聊天消息

```text
User           Gateway          AgentClient       LocalAgent
 │               │                  │                 │
 │─task.create──▶│                  │                 │
 │               │──agent.chat─────▶│                 │
 │               │◀─result:accepted─│                 │
 │               │                  │────请求─────────▶│
 │               │                  │◀────流式输出─────│
 │               │◀──$/progress─────│                 │
 │◀─admin.task.─────────────────────│                 │
 │    progress                     │                  │
 │               │                  │◀──confirm_required
 │               │◀──$/progress:confirm_required       │
 │◀─admin.task.─────────────────────│                 │
 │   progress:confirm_required     │                  │
 │─task.respond─▶│                  │                 │
 │               │──agent.respond──▶│                 │
 │               │                  │────回复─────────▶│
 │               │                  │◀────继续输出─────│
 │               │◀──$/progress─────│                 │
 │◀─admin.task.─────────────────────│                 │
 │    progress:done                │                  │
```

## 12. 与业界方案对比

### 12.1 为什么不用纯 MCP？

MCP 主要解决**外部 AI 调用本地工具/资源**的问题，重点是工具发现、schema 定义和外部编排。本系统中**本地 Agent 自己就是 AI**，工具调用、确认、提示等由 Agent 自行决定；远程页面只负责聊天和展示。因此本协议借鉴 MCP 的 JSON-RPC 信封和 typed content，但不使用其工具调用模型。

### 12.2 为什么不用纯 JSON-RPC？

JSON-RPC 2.0 本身不支持流式。本系统借鉴 LSP 的 `$/progress` 通知，在 JSON-RPC 基础上扩展了原生流式能力。

### 12.3 为什么不用 A2A？

A2A 还处于早期，且偏向 Agent 之间的协作。本系统当前主要是**人与 Agent 的交互**，未来 Agent 互操作时再引入 A2A 更合适。

## 13. 扩展建议

- **消息压缩**：大消息可启用 per-message deflate
- **二进制数据**：文件传输建议用独立 HTTP 接口，不在 WebSocket 里传大文件
- **鉴权字段**：在 `system.register` 和每个请求中增加 `auth.token`
- **端到端加密**：敏感内容可在 AgentClient 与管理页面之间加密，网关只透传密文
- **批处理**：未来可支持 JSON-RPC batch，一次发送多个请求
