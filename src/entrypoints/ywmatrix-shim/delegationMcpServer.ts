/**
 * P5 —— 群管理者委派 MCP server（v3 §6.6 + 计划 §7.6）。
 *
 * 每个群会话内嵌一个 SDK MCP server（server name 固定 "ywmatrix"），经
 * ywcoderSession 的 control_request{subtype:"mcp_message"} 控制桥与子进程
 * （ywco​​der 侧的 SdkControlClientTransport + MCP Client）双向通信：
 * - 子进程 → shim：MCP initialize / tools/list / tools/call / 通知，
 *   由 handleMessage 转进内嵌 Server，响应包成 control_response.mcp_response 回给子进程；
 * - shim → 子进程：server 通知（notifications/tools/list_changed），
 *   经 sendToChild 走控制桥送达子进程 MCP Client。
 *
 * 安全约束（计划 §7.6「handler 内必须再次校验」+ 审查 10 条）：
 * 1. delegate 工具只对「受信管理者」可见：tools/list 按最新受信群状态动态返回；
 * 2. tools/call 每次都重新校验管理者身份（防列表刷新竞态中的旧身份调用）；
 * 3. target 必须在受信 members 名册内；
 * 4. 禁止委派给自己；
 * 5. parent_task_id 只取当前活动任务，不从模型入参接受；
 * 6. group_id 只取受信群状态，不从模型入参接受；
 * 7. 模型 metadata 中的受信路由字段一律剥离，不得覆盖受信值；
 * 8. 非管理者 tools/list 返回空（模型根本看不到委派工具）；
 * 9. 非 ywmatrix 的 mcp_message 由 ywcoderSession 显式回 error（见 session 侧）；
 * 10. 群状态变更（管理者/成员变化）→ notifications/tools/list_changed，
 *     不依赖重启子进程撤销旧管理者权限。
 *
 * 嵌套编排：网关对子任务再 invoke 回 -32006（深度硬限 1），shim 侧不做
 * task_id 形态启发式判断（契约：鉴权/防递归在网关完成）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import { isGroupManager } from './groupContext.js'
import type { GroupContext } from './protocol.js'
import { DelegationFailure, type DelegationBridge } from './delegationBridge.js'

export const YWMATRIX_MCP_SERVER_NAME = 'ywmatrix'
export const DELEGATE_TOOL_NAME = 'delegate'

/** 受信路由字段：模型 metadata 不得携带/覆盖（安全约束 7）。 */
const TRUSTED_ROUTING_KEYS = new Set([
  'parent_task_id',
  'group_id',
  'target_agent_id',
  'session_id',
])

/** 委派工具的 JSON Schema（对模型暴露的入参只有这三个，路由字段不在其列）。 */
const DELEGATE_TOOL = {
  name: DELEGATE_TOOL_NAME,
  description:
    '把子任务委派给群内其它成员 Agent 执行，并等待其最终结果。' +
    'target_agent_id 必须是群成员名册中的 agent_id（不能是自己）。',
  inputSchema: {
    type: 'object',
    properties: {
      target_agent_id: { type: 'string', description: '群成员名册中的 agent_id' },
      content: { type: 'string', description: '交给子任务执行的完整指令' },
      metadata: {
        type: 'object',
        description: '可选透传元数据（路由字段由系统填充，无需也不允许在此指定）',
        additionalProperties: true,
      },
    },
    required: ['target_agent_id', 'content'],
  },
} as const

/** 工具级错误结果（模型可见，区别于协议级 JSON-RPC error）。 */
function toolError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

/** subtask_result.chunks → MCP 工具内容：text 块原样保留，其余块 JSON 化。 */
function chunksToToolContent(chunks: unknown[]): Array<{ type: 'text'; text: string }> {
  const out: Array<{ type: 'text'; text: string }> = []
  for (const chunk of chunks) {
    if (
      chunk &&
      typeof chunk === 'object' &&
      (chunk as { type?: unknown }).type === 'text' &&
      typeof (chunk as { text?: unknown }).text === 'string'
    ) {
      out.push({ type: 'text', text: (chunk as { text: string }).text })
    } else {
      out.push({ type: 'text', text: JSON.stringify(chunk) })
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '（子任务完成，无文本结果）' }]
}

/**
 * 内嵌 MCP server 的传输桥（镜像 SdkControlServerTransport 模式，但闭环在
 * shim 内）：子进程消息经 dispatchFromChild 进 Server；Server 对请求的响应
 * 在 send() 里按 id 就地闭环返回给 dispatchFromChild 的调用方；Server 主动
 * 通知（tools/list_changed）则经 sendToChild 回调走控制桥发给子进程。
 */
export class ShimMcpTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private closed = false
  private readonly pendingResponses = new Map<
    string | number,
    { resolve: (msg: JSONRPCMessage) => void; reject: (err: Error) => void }
  >()

  constructor(
    private readonly sendToChild: (message: JSONRPCMessage) => Promise<void>,
  ) {}

  async start(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // 关闭时拒绝全部待决 dispatch（如子进程退出时 server 被回收）：
    // 静默清除会让 dispatchFromChild 的调用方永久悬挂。
    for (const [, pending] of this.pendingResponses) {
      pending.reject(new Error('MCP transport 已关闭'))
    }
    this.pendingResponses.clear()
    this.onclose?.()
  }

  /**
   * 子进程 → Server。请求（带 id + method）返回 Server 的响应消息；
   * 通知/响应类消息无需回包，返回 undefined。
   */
  async dispatchFromChild(message: JSONRPCMessage): Promise<JSONRPCMessage | undefined> {
    if (this.closed) throw new Error('MCP transport 已关闭')
    const isRequest =
      'method' in message && 'id' in message && message.id !== undefined
    if (!isRequest) {
      this.onmessage?.(message)
      return undefined
    }
    const id = (message as { id: string | number }).id
    return await new Promise<JSONRPCMessage>((resolve, reject) => {
      // 审查 P2（复审修正）：同 id 未决请求已存在时**拒绝新请求**，且不派发
      // onmessage——旧 handler 已在运行、不可取消；若反过来拒绝旧 Promise，
      // 旧 handler 的迟到响应会命中新 Promise（响应串线），随后的重复响应
      // 还会经 sendToChild 泄漏成意外的 server→child 消息。保留旧映射，
      // 旧 handler 返回后旧请求正常闭环。正常 MCP Client 保证 id 唯一，
      // 这是异常路径的失败关闭（新请求方收到 error，不会悬挂）。
      if (this.pendingResponses.has(id)) {
        reject(
          new Error(
            `MCP 请求 id 重复（已有同 id 未决请求，新请求失败关闭）: ${String(id)}`,
          ),
        )
        return
      }
      this.pendingResponses.set(id, { resolve, reject })
      try {
        this.onmessage?.(message)
      } catch (err) {
        this.pendingResponses.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('MCP transport 已关闭')
    // Server 对子进程请求的响应：无 method 带 id → 与待决 dispatch 闭环。
    if (!('method' in message) && 'id' in message && message.id !== undefined) {
      const pending = this.pendingResponses.get(message.id)
      if (pending) {
        this.pendingResponses.delete(message.id)
        pending.resolve(message)
        return
      }
    }
    // Server 主动通知（tools/list_changed 等）：经控制桥发给子进程。
    await this.sendToChild(message)
  }
}

/** DelegationMcpServer 需要的实时受信状态（由 shim 按 session 提供）。 */
export interface DelegationGroupState {
  /** 最新受信群上下文（最近一次 task.create 的 metadata.group，回落首任务绑定值）。 */
  group: GroupContext | undefined
  /** C3：lifecycle.initialize 下发的本 Agent 实例 ID。 */
  agentId: string | null
  /** 当前活动任务（parent_task_id 的唯一合法来源）。 */
  activeTaskId: string | null
}

export interface DelegationMcpServerDeps {
  bridge: DelegationBridge
  sessionId: string
  getState: () => DelegationGroupState
  /** server → 子进程的通知通道（ywcoderSession.sendMcpMessage）。 */
  sendToChild: (message: JSONRPCMessage) => Promise<void>
  log?: (msg: string) => void
}

export class DelegationMcpServer {
  private readonly server: Server
  private readonly transport: ShimMcpTransport
  private readonly log: (msg: string) => void
  /** 上次 tools/list 可见性指纹（管理者身份 + 成员名册），变化才发 list_changed。 */
  private visibilityFingerprint: string | null = null

  constructor(private readonly deps: DelegationMcpServerDeps) {
    this.log = deps.log ?? (() => {})
    this.transport = new ShimMcpTransport(deps.sendToChild)
    this.server = new Server(
      { name: YWMATRIX_MCP_SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    )
    // tools/list：按最新受信群状态动态返回——非管理者拿到空列表（约束 1/8）。
    this.server.setRequestHandler(ListToolsRequestSchema, () => {
      const tools = this.isTrustedManager() ? [DELEGATE_TOOL] : []
      this.visibilityFingerprint = this.computeFingerprint()
      return { tools }
    })
    // tools/call：每次都重新校验（约束 2/3/4/5/6/7），不依赖 tools/list 的旧结果。
    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      if (request.params.name !== DELEGATE_TOOL_NAME) {
        return toolError(`未知工具: ${request.params.name}`)
      }
      return await this.handleDelegate(request.params.arguments)
    })
  }

  /** 建立 server 与 transport 的连接（纯内存，无 IO）。 */
  async start(): Promise<void> {
    await this.server.connect(this.transport)
  }

  async close(): Promise<void> {
    await this.server.close()
  }

  /**
   * ywcoderSession 收到 control_request{subtype:"mcp_message"} 时调用。
   * 返回需回给子进程的 MCP 响应（通知类返回 undefined）。
   * server_name 校验在 session 侧完成（非 ywmatrix 显式回 error，约束 9）。
   */
  async handleMessage(message: unknown): Promise<JSONRPCMessage | undefined> {
    if (!message || typeof message !== 'object' || !('jsonrpc' in message)) {
      throw new Error('非法 MCP 消息（非 JSON-RPC 对象）')
    }
    return await this.transport.dispatchFromChild(message as JSONRPCMessage)
  }

  /**
   * 群状态变更（约束 10）：管理者身份或成员名册变化时向子进程发
   * notifications/tools/list_changed，子进程 MCP Client 据此重新 tools/list。
   * 工具 handler 仍每次重新校验，本通知只解决「模型视野」的新鲜度。
   */
  notifyGroupStateChanged(): void {
    const fp = this.computeFingerprint()
    if (fp === this.visibilityFingerprint) return
    this.visibilityFingerprint = fp
    this.server.sendToolListChanged().catch(err => {
      this.log(
        `发送 tools/list_changed 失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  private isTrustedManager(): boolean {
    const state = this.deps.getState()
    return state.group !== undefined && isGroupManager(state.group, state.agentId)
  }

  /** 可见性指纹：管理者身份 + 排序后的成员名册（任一变化即刷新工具列表）。 */
  private computeFingerprint(): string {
    const state = this.deps.getState()
    if (!state.group) return 'no-group'
    const members = state.group.members
      .map(m => m.agent_id)
      .sort()
      .join(',')
    return `${this.isTrustedManager() ? 'manager' : 'member'}|${members}`
  }

  /** delegate 工具执行：全部受信字段现场校验/现场取值，模型的只能是 content/metadata。 */
  private async handleDelegate(args: unknown) {
    const state = this.deps.getState()
    const group = state.group
    // 约束 2：每次调用重新校验管理者身份。
    if (!group || !isGroupManager(group, state.agentId)) {
      return toolError('当前会话不是本群管理者，委派工具不可用')
    }
    const params = (args ?? {}) as Record<string, unknown>
    const targetAgentId = params.target_agent_id
    const content = params.content
    if (typeof targetAgentId !== 'string' || !targetAgentId.trim()) {
      return toolError('缺少必填参数 target_agent_id')
    }
    if (typeof content !== 'string' || !content.trim()) {
      return toolError('缺少必填参数 content')
    }
    // 约束 4：禁止委派给自己。
    if (state.agentId !== null && targetAgentId === state.agentId) {
      return toolError('不能把任务委派给自己')
    }
    // 约束 3：目标必须在受信 members 名册内。
    if (!group.members.some(m => m.agent_id === targetAgentId)) {
      return toolError(`目标 ${targetAgentId} 不在本群成员名册内`)
    }
    // 约束 5：parent_task_id 只取当前活动任务。
    if (!state.activeTaskId) {
      return toolError('当前没有活动中的父任务，无法发起委派')
    }
    // 约束 7：剥离模型 metadata 中的受信路由字段，其余原样透传。
    const rawMetadata = params.metadata
    const metadata =
      rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
        ? Object.fromEntries(
            Object.entries(rawMetadata as Record<string, unknown>).filter(
              ([key]) => !TRUSTED_ROUTING_KEYS.has(key),
            ),
          )
        : undefined

    try {
      const chunks = await this.deps.bridge.delegate({
        sessionId: this.deps.sessionId,
        parentTaskId: state.activeTaskId,
        // 约束 6：group_id 只取受信群状态。
        groupId: group.group_id,
        targetAgentId,
        content,
        ...(metadata ? { metadata } : {}),
      })
      return { content: chunksToToolContent(chunks) }
    } catch (err) {
      if (err instanceof DelegationFailure) {
        return toolError(`委派失败（${err.code}）：${err.message}`)
      }
      return toolError(
        `委派失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
