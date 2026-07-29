# 模型 API 排队机制实现方案

> **日期标签**：2026-04-27
> **版本**：v1.1
> **目标**：内网网关部署下，实现请求级排队机制——用户输入消息后先向网关占位排队，终端实时展示"前方还有 N 人"，排到队首后自动发送请求
> **依赖**：本方案建立在内网自定义模型配置改造方案（`internal-model-config-redesign-2026-04-27.md`）基础之上

---

## 一、背景与目标

### 1.1 问题背景

内网通过统一网关部署多套模型服务（如 `qwen2.5-72b`、`deepseek-r1`）。网关侧存在负载上限，当并发请求达到阈值时：
- 新请求可能被直接拒绝（503/429）
- 或进入网关排队，用户长时间无响应
- CLI 侧无感知，用户不知道"是网络卡了还是模型在排队"

### 1.2 设计目标

1. **占位排队**：用户输入消息后，CLI 先向网关"占位"，获得排队序号
2. **实时提示**：终端展示请求级排队状态（**前方还有 N 人**、预计等待多久）
3. **自动恢复**：排到队首后，无需用户操作，自动发送真实请求
4. **可取消**：排队期间用户可随时按 Escape / Ctrl+C 取消，并通知网关释放占位
5. **不影响现有公网用户**：仅在内网网关场景启用，公网 provider 零侵入

---

## 二、现有相关架构梳理

### 2.1 请求全链路

```
用户输入
  ↓
PromptInput → onSubmit
  ↓
messageQueueManager.enqueue()        ← 消息入统一队列
  ↓
useQueueProcessor (React Effect)
  ├─ QueryGuard: 是否有活跃查询？
  ├─ GatewayQueueGuard: 是否需要占位排队？ ← 新增检查点
  ↓
processQueueIfReady → executeQueuedInput
  ↓
handlePromptSubmit → executeUserInput
  ↓
queryEngine.query() → openaiShim._doOpenAIRequest()
  ↓
fetch(POST /chat/completions)  →  网关
```

### 2.2 关键现有组件

| 组件 | 文件 | 现有能力 | 改造点 |
|------|------|---------|--------|
| **消息队列** | `messageQueueManager.ts` | 统一 FIFO 队列，支持 enqueue/dequeue/peek | 无需改动，复用现有缓冲 |
| **队列处理器** | `useQueueProcessor.ts` | React Effect 监听队列变化，条件满足时触发消费 | 增加 `GatewayQueueGuard` 条件判断 |
| **队列消费** | `queueProcessor.ts` | `processQueueIfReady` 按优先级消费 | 无需改动 |
| **取消机制** | `useCancelRequest.ts` | Escape / Ctrl+C 触发 `handleCancel`，支持 abortSignal 和弹队 | 复用，新增取消占位逻辑 |
| **API 请求** | `openaiShim.ts` `_doOpenAIRequest` | 构建 body + fetch，仅 GitHub 有 429 重试 | 请求前已排完队，正常发请求 |
| **状态栏** | `StatusLine.tsx` | 底部状态展示（当前模型、模式等） | 新增排队状态展示 |
| **系统消息** | `SystemAPIErrorMessage.tsx` | 系统级提示（灰色/黄色） | 新增排队提示消息类型 |

### 2.3 现有取消机制细节

**Escape (chat:cancel)** 与 **Ctrl+C (app:interrupt)** 最终都走 `handleCancel`：

```typescript
// useCancelRequest.ts
function handleCancel() {
  if (abortSignal !== undefined && !abortSignal.aborted) {
    // 有活跃任务 → 触发 abortSignal
    onCancel()
    return
  }
  if (hasCommandsInQueue()) {
    // 无活跃任务但有排队 → 弹出队列
    popCommandFromQueue()
    return
  }
}
```

**排队期间的状态**：
- 占位/轮询阶段：`abortSignal` 已创建（用于中断轮询），走第一条分支
- 占位结束后、请求前：`abortSignal` 已释放，走第二条分支（弹队）

---

## 三、排队机制核心设计

### 3.1 设计原则

1. **请求级排队**：每个用户请求独立占位，"前方 N 人"是真实位置
2. **占位先行**：发真实请求前先向网关占位，获得 queueId
3. **阻塞式轮询**：不常驻后台心跳，只在占位后轮询自己的位置
4. **串行处理**：第 1 条消息占位排队结束后，才处理第 2 条
5. **优雅释放**：取消或完成后通知网关移除占位，避免僵尸队列

### 3.2 核心状态流转

```
┌─────────────┐    占位      ┌─────────────┐    轮询      ┌─────────────┐
│   idle      │ ───────────→ │  queuing    │ ───────────→ │ available   │
│  (未占位)    │              │  (排队中)    │              │  (排到队首)  │
└─────────────┘              └─────────────┘              └─────────────┘
                                    ↓                              ↓
                              用户取消/超时                    发真实请求
                                    ↓                              ↓
                              ┌─────────────┐              ┌─────────────┐
                              │  cancelled  │              │ processing  │
                              │  (已取消)    │              │  (处理中)    │
                              └─────────────┘              └─────────────┘
                                                                    ↓
                                                              请求完成/失败
                                                                    ↓
                                                              ┌─────────────┐
                                                              │    done     │
                                                              │  (释放占位)  │
                                                              └─────────────┘
```

### 3.3 新增核心组件

#### 3.3.1 GatewayQueueGuard

```typescript
// src/services/api/gatewayQueueGuard.ts（新建）

type QueueState =
  | { status: 'idle' }
  | { status: 'queuing'; queueId: string; position: number; estimatedWaitSec: number }
  | { status: 'available'; queueId: string }
  | { status: 'processing' }
  | { status: 'done' }
  | { status: 'cancelled' }

type QueueUpdateCallback = (state: QueueState) => void

class GatewayQueueGuard {
  private state: QueueState = { status: 'idle' }
  private abortController: AbortController | null = null

  getState(): QueueState {
    return this.state
  }

  /**
   * 向网关占位，然后阻塞轮询直到排到队首，或超时/取消
   */
  async enqueueAndWait(
    model: string,
    onUpdate: QueueUpdateCallback,
  ): Promise<{ queueId: string }> {
    const POLL_INTERVAL_MS = 5_000      // 每 5 秒查一次位置
    const MAX_WAIT_MS = 10 * 60_000     // 最多等 10 分钟

    this.abortController = new AbortController()

    // 1. 向网关占位
    const enqueueResult = await gatewayQueueApi.enqueue(model)
    const queueId = enqueueResult.queue_id

    this.state = {
      status: 'queuing',
      queueId,
      position: enqueueResult.position,
      estimatedWaitSec: enqueueResult.estimated_wait_sec,
    }
    onUpdate(this.state)

    const start = Date.now()

    // 2. 轮询自己的位置
    while (Date.now() - start < MAX_WAIT_MS) {
      if (this.abortController.signal.aborted) {
        // 用户取消 → 通知网关释放占位
        await gatewayQueueApi.cancel(queueId).catch(() => {})
        this.state = { status: 'cancelled' }
        onUpdate(this.state)
        throw new Error('Queue cancelled by user')
      }

      const status = await gatewayQueueApi.getStatus(queueId)

      if (status.state === 'available') {
        // 排到队首
        this.state = { status: 'available', queueId }
        onUpdate(this.state)
        return { queueId }
      }

      this.state = {
        status: 'queuing',
        queueId,
        position: status.position,
        estimatedWaitSec: status.estimated_wait_sec,
      }
      onUpdate(this.state)

      await sleep(POLL_INTERVAL_MS, this.abortController.signal)
    }

    // 超时 → 释放占位
    await gatewayQueueApi.cancel(queueId).catch(() => {})
    throw new Error(`等待模型 ${model} 超时（${MAX_WAIT_MS / 1000}秒）`)
  }

  /**
   * 请求完成后释放占位
   */
  async release(queueId: string): Promise<void> {
    await gatewayQueueApi.release(queueId).catch(() => {})
    this.state = { status: 'done' }
  }

  cancel(): void {
    this.abortController?.abort()
  }
}

// 单例
let guard: GatewayQueueGuard | null = null
export function getGatewayQueueGuard(): GatewayQueueGuard {
  if (!guard) guard = new GatewayQueueGuard()
  return guard
}
```

#### 3.3.2 网关排队 API 封装

```typescript
// src/services/api/gatewayQueueApi.ts（新建）

const GATEWAY_QUEUE_URL = process.env.YWCODER_GATEWAY_QUEUE_URL

function getHeaders(): Record<string, string> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.YWCODER_GATEWAY_API_KEY ?? ''
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

/**
 * 向网关占位入队
 */
export async function enqueue(model: string): Promise<{
  queue_id: string
  position: number
  estimated_wait_sec: number
}> {
  const url = `${GATEWAY_QUEUE_URL}/queue/enqueue`
  const res = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(5_000),
  })

  if (!res.ok) {
    throw new Error(`Gateway enqueue failed: ${res.status}`)
  }

  return res.json()
}

/**
 * 查询自己的排队位置
 */
export async function getStatus(queueId: string): Promise<{
  state: 'queuing' | 'available'
  position?: number
  estimated_wait_sec?: number
}> {
  const url = `${GATEWAY_QUEUE_URL}/queue/${encodeURIComponent(queueId)}/status`
  const res = await fetch(url, {
    headers: getHeaders(),
    signal: AbortSignal.timeout(3_000),
  })

  if (!res.ok) {
    throw new Error(`Gateway queue status failed: ${res.status}`)
  }

  return res.json()
}

/**
 * 取消占位
 */
export async function cancel(queueId: string): Promise<void> {
  const url = `${GATEWAY_QUEUE_URL}/queue/${encodeURIComponent(queueId)}/cancel`
  await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    signal: AbortSignal.timeout(3_000),
  })
}

/**
 * 请求完成后释放占位
 */
export async function release(queueId: string): Promise<void> {
  const url = `${GATEWAY_QUEUE_URL}/queue/${encodeURIComponent(queueId)}/release`
  await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    signal: AbortSignal.timeout(3_000),
  })
}

export function isGatewayQueueEnabled(): boolean {
  return Boolean(GATEWAY_QUEUE_URL)
}
```

### 3.4 插入点设计

#### 3.4.1 useQueueProcessor 增加排队条件

```typescript
// src/hooks/useQueueProcessor.ts（修改）

useEffect(() => {
  if (isQueryActive) return
  if (hasActiveLocalJsxUI) return
  if (queueSnapshot.length === 0) return

  // 新增：检查是否正在排队中
  const queueGuard = getGatewayQueueGuard()
  if (queueGuard.getState().status === 'queuing') return

  processQueueIfReady({ executeInput: executeQueuedInput })
}, [queueSnapshot, isQueryActive, hasActiveLocalJsxUI, queryGuard])
```

#### 3.4.2 executeUserInput 中拦截

```typescript
// src/utils/handlePromptSubmit.ts executeUserInput 内（修改）

onQuery: async (newMessages, abortController, shouldQuery, ...) => {
  const mainLoopModel = ... // 当前选中的模型
  let queueId: string | undefined

  // 新增：网关占位排队
  if (isGatewayQueueEnabled()) {
    const queueGuard = getGatewayQueueGuard()

    try {
      const result = await queueGuard.enqueueAndWait(mainLoopModel, (state) => {
        if (state.status === 'queuing') {
          setAppState(prev => ({
            ...prev,
            gatewayQueueStatus: {
              model: mainLoopModel,
              status: 'waiting',
              position: state.position,
              estimatedWaitSec: state.estimatedWaitSec,
            },
          }))
        }
      })

      queueId = result.queueId
    } finally {
      // 无论成功/失败/取消，清理展示状态
      setAppState(prev => ({
        ...prev,
        gatewayQueueStatus: null,
      }))
    }
  }

  try {
    // 排到队首，正常发请求
    await queryEngine.query(...)
  } finally {
    // 请求完成后释放占位
    if (queueId) {
      await getGatewayQueueGuard().release(queueId)
    }
  }
}
```

#### 3.4.3 取消机制联动

```typescript
// src/hooks/useCancelRequest.ts handleCancel（修改）

function handleCancel() {
  // Priority 0: 如果有排队中的占位，先取消它
  const queueGuard = getGatewayQueueGuard()
  if (queueGuard.getState().status === 'queuing') {
    queueGuard.cancel()  // 触发 abortSignal，enqueueAndWait 内部会调用 gatewayQueueApi.cancel
    return
  }

  if (abortSignal !== undefined && !abortSignal.aborted) {
    onCancel()
    return
  }

  if (hasCommandsInQueue()) {
    popCommandFromQueue()
    return
  }
}
```

### 3.5 UI 展示设计

#### 3.5.1 StatusLine 状态栏

```typescript
// src/components/StatusLine.tsx（修改）

const gatewayQueueStatus = useAppState(s => s.gatewayQueueStatus)

if (gatewayQueueStatus?.status === 'waiting') {
  const { position, estimatedWaitSec } = gatewayQueueStatus
  const waitText = estimatedWaitSec > 60
    ? `约 ${Math.ceil(estimatedWaitSec / 60)} 分钟`
    : `${estimatedWaitSec} 秒`

  return (
    <Text dimColor italic>
      ⏳ 模型排队中... 前方还有 {position} 人，预计等待 {waitText}
    </Text>
  )
}
```

#### 3.5.2 对话区系统消息（可选增强）

```typescript
// handlePromptSubmit.ts 中
function emitQueueSystemMessage(model: string, position: number, waitSec: number) {
  return {
    role: 'system',
    type: 'gateway_queue',
    message: {
      content: `模型 ${model} 当前排队中，前方还有 ${position} 人，预计等待 ${waitSec} 秒...`,
    },
  }
}
```

> **注意**：系统消息可选。如果 StatusLine 已足够清晰，可以不插入对话区，避免污染上下文。

### 3.6 完整时序图

```
用户输入"帮我写代码"
  ↓
PromptInput onSubmit
  ↓
messageQueueManager.enqueue({ value: "帮我写代码", mode: "prompt" })
  ↓
useQueueProcessor Effect 触发
  ├─ QueryGuard: 无活跃查询 ✅
  ├─ GatewayQueueGuard: 未在排队中 ✅
  ↓
processQueueIfReady → executeQueuedInput
  ↓
handlePromptSubmit → executeUserInput → onQuery
  ↓
GatewayQueueGuard.enqueueAndWait("deepseek-r1")
  ├─ POST /queue/enqueue { model: "deepseek-r1" }
  │   ← { queue_id: "q-abc123", position: 3, estimated_wait_sec: 120 }
  │
  ├─ StatusLine 显示 "⏳ 排队中... 前方还有 3 人，预计约 2 分钟"
  │
  ├─ 轮询 GET /queue/q-abc123/status
  │   ← { state: "queuing", position: 2, estimated_wait_sec: 80 }
  │   StatusLine 更新 "⏳ 排队中... 前方还有 2 人，预计约 1 分钟"
  │
  ├─ 轮询 GET /queue/q-abc123/status
  │   ← { state: "queuing", position: 1, estimated_wait_sec: 30 }
  │   StatusLine 更新 "⏳ 排队中... 前方还有 1 人，预计 30 秒"
  │
  ├─ 轮询 GET /queue/q-abc123/status
  │   ← { state: "available" }
  │   GatewayQueueGuard 解除阻塞，返回 { queueId: "q-abc123" }
  │
  ├─ StatusLine 恢复
  │   setAppState({ gatewayQueueStatus: null })
  │
  ↓
queryEngine.query() → openaiShim._doOpenAIRequest()
  ↓
fetch(POST /chat/completions) → 网关正常处理
  ↓
拿到回复
  ↓
finally: POST /queue/q-abc123/release  ← 释放占位
  ↓
REPL 继续
```

**取消场景时序**：

```
用户输入"帮我写代码"
  ↓
GatewayQueueGuard.enqueueAndWait("deepseek-r1")
  ├─ 占位成功，开始轮询
  │   StatusLine 显示 "⏳ 排队中... 前方还有 3 人"
  │
  ├─ 用户按 Ctrl+C
  │   → useCancelRequest.handleCancel()
  │   → GatewayQueueGuard.cancel() 触发 abortSignal
  │   → enqueueAndWait 捕获中断
  │   → POST /queue/q-abc123/cancel 通知网关释放占位
  │   → 抛出 "Queue cancelled by user"
  │
  ├─ StatusLine 恢复
  │   setAppState({ gatewayQueueStatus: null })
  │
  ↓
不执行 queryEngine.query()，消息从队列弹出，REPL 回到输入态
```

---

## 四、网关接口需求

### 4.1 接口规范

#### 4.1.1 占位入队

```http
POST /queue/enqueue
Authorization: Bearer {api_key}
Content-Type: application/json

{
  "model": "deepseek-r1"
}

Response 202 Accepted:
{
  "queue_id": "q-abc123",
  "position": 3,
  "estimated_wait_sec": 120
}

Response 409 Conflict（该模型已 offline 或该用户已有占位）:
{ "error": "Model offline" }

Response 401 Unauthorized:
{ "error": "Unauthorized" }
```

#### 4.1.2 查询排队位置

```http
GET /queue/{queueId}/status
Authorization: Bearer {api_key}

Response 200 OK:
{
  "state": "queuing",
  "position": 2,
  "estimated_wait_sec": 80
}

Response 200 OK（排到队首）:
{
  "state": "available"
}

Response 404 Not Found:
{ "error": "Queue not found" }
```

#### 4.1.3 取消占位

```http
POST /queue/{queueId}/cancel
Authorization: Bearer {api_key}

Response 204 No Content

Response 404 Not Found:
{ "error": "Queue not found" }
```

#### 4.1.4 释放占位（请求完成后）

```http
POST /queue/{queueId}/release
Authorization: Bearer {api_key}

Response 204 No Content

Response 404 Not Found:
{ "error": "Queue not found" }
```

### 4.2 网关实现建议

| 维度 | 建议 |
|------|------|
| **队列存储** | 内存 + 持久化（Redis / 数据库），避免单点故障导致排队丢失 |
| **队列策略** | 全局 FIFO，按 `enqueue` 时间排序；后续如需 VIP 可加 `priority` 字段 |
| **position 计算** | 该 model 队列中，排在当前 queueId 前面的元素个数 |
| **estimated_wait_sec** | `position * avg_request_duration_sec`（网关统计的平均处理时长） |
| **自动过期** | 占位超过 15 分钟未 release/cancel，自动移除 |
| **并发控制** | 每个 model 维护 `maxConcurrent`，当前运行数 `< maxConcurrent` 时，队首元素状态变为 `available` |
| **认证** | Bearer Token，复用 OpenAI API Key |
| **容错** | enqueue 接口 500/超时 → CLI 降级为直接发请求（不排队） |

### 4.3 网关内部状态机

```
┌─────────────┐    enqueue      ┌─────────────┐    排到队首      ┌─────────────┐
│   无占位     │ ─────────────→ │  queuing    │ ─────────────→ │  available  │
└─────────────┘                └─────────────┘                └─────────────┘
                                      ↓                               ↓
                                用户 cancel                    收到真实请求 / release
                                      ↓                               ↓
                               ┌─────────────┐               ┌─────────────┐
                               │  removed    │               │   done      │
                               └─────────────┘               └─────────────┘
```

---

## 五、AppState 扩展

```typescript
// src/state/AppStateStore.ts（修改）

export type AppState = {
  // ... 现有字段 ...

  gatewayQueueStatus: {
    model: string
    status: 'waiting'
    position: number
    estimatedWaitSec: number
  } | null
}

// 默认值
export const defaultAppState: AppState = {
  // ... 现有默认值 ...
  gatewayQueueStatus: null,
}
```

---

## 六、错误与超时处理

| 场景 | 行为 |
|------|------|
| enqueue 接口返回 500/超时 | 降级为直接发请求（不排队），避免阻塞 |
| enqueue 返回 409（模型 offline） | 提示用户：`模型 ${model} 当前不可用，请切换其他模型` |
| getStatus 接口 500/超时 | 继续轮询（下次心跳再试），不中断排队 |
| getStatus 返回 404（queueId 丢失） | 降级为直接发请求，视为已排到队首 |
| 排队超过 10 分钟 | 自动 cancel 占位，报错给用户：`模型 ${model} 排队超时，请切换其他模型` |
| 用户按 Escape / Ctrl+C | cancel 占位，弹出队列，消息丢弃 |
| 占位后、发请求前网络断开 | AbortSignal 触发，自动 cancel 占位，消息保留在队列（用户可再次提交） |
| 真实请求 500/失败 | finally 里仍执行 release，避免僵尸占位 |

---

## 七、风险与回退

| 风险 | 缓解措施 |
|------|---------|
| 网关排队接口不稳定导致 CLI 无法正常工作 | enqueue 失败即降级放行；getStatus 失败继续轮询 |
| 用户取消后网关未收到 cancel，占位残留 | 网关侧设置 15 分钟自动过期 |
| 请求完成后忘记 release，占位残留 | `finally` 保证执行 release；网关侧自动过期兜底 |
| 网关重启导致 queueId 丢失 | getStatus 404 时 CLI 降级放行 |
| 与现有 `withRetry.ts` 的 529 重试冲突 | 两者互补：排队拦截是请求前，529 重试是请求后；排到队首后仍可能遇到 529 |
| 多模型切换时排队状态残留 | `enqueueAndWait` 前确保 guard 状态为 idle，每次只处理一个排队 |

---

## 八、需要修改的文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/services/api/gatewayQueueGuard.ts` | 🆕 新建 | 排队状态守卫，占位 + 阻塞轮询 + abort + 释放 |
| `src/services/api/gatewayQueueApi.ts` | 🆕 新建 | 网关排队接口封装（enqueue / status / cancel / release） |
| `src/hooks/useQueueProcessor.ts` | ✏️ 修改 | 增加 GatewayQueueGuard 状态判断，queuing 时不消费队列 |
| `src/utils/handlePromptSubmit.ts` | ✏️ 修改 | `executeUserInput` 的 `onQuery` 前插入占位排队，finally 里释放 |
| `src/hooks/useCancelRequest.ts` | ✏️ 修改 | `handleCancel` 中增加取消 GatewayQueueGuard 占位 |
| `src/state/AppStateStore.ts` | ✏️ 修改 | 新增 `gatewayQueueStatus` 字段 |
| `src/components/StatusLine.tsx` | ✏️ 修改 | 新增排队状态展示 |

---

## 九、变更记录

| 日期 | 版本 | 变更摘要 |
|------|------|---------|
| 2026-04-27 | v1.0 | 初稿；模型级排队方案 |
| 2026-04-27 | v1.1 | **重大修订**：从模型级状态升级为请求级排队；新增占位（enqueue）/ 查询位置 / 取消 / 释放完整生命周期；更新网关接口为 RESTful 队列接口；重写时序图含取消场景 |

---

## 十、待确认事项（阻塞开发）

1. [ ] 网关团队确认 `/queue/enqueue`、`/queue/{id}/status`、`/queue/{id}/cancel`、`/queue/{id}/release` 接口开发排期
2. [ ] 网关团队确认队列存储方案（内存 / Redis / DB）及自动过期策略
3. [ ] 网关团队确认每个 model 的 `maxConcurrent` 阈值及 `estimated_wait_sec` 计算逻辑
4. [ ] 网关团队确认认证方式（Bearer Token 复用 API Key）
5. [ ] 确认排队接口独立域名 / 路径（`YWCODER_GATEWAY_QUEUE_URL` 环境变量值）
