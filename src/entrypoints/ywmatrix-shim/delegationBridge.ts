/**
 * P5 —— 管理者编排委派桥（v3 §6.6 + C6 定稿）。
 *
 * 职责：把 MCP 委派工具的一次调用桥接为「task.invoke 请求 → dispatch 应答 →
 * task.subtask_result 回推」的两阶段等待，并保证并发安全与无悬挂 Promise。
 *
 * 关联设计（不用「当前子任务」单值，一个父任务可并行多个委派）：
 * - 阶段一（dispatch）：外层 JSON-RPC request id → 未决委派；
 * - 阶段二（结果）：网关回执的子任务 task_id → 未决委派；
 * - 清理索引：parent_task_id / session_id → 未决委派集合（取消/退出批量收尾）。
 *
 * 防串话：subtask_result 除按 task_id 命中外，还必须与登记的
 * parent_task_id/group_id/target_agent_id 完全一致，否则视为迟到/错投，幂等忽略。
 *
 * 超时：整条委派（dispatch + 结果等待）共用一个与网关 task timeout 同级长超时
 * （默认 26h），绝不用 10s 级控制超时——MCP 工具调用层默认约 27.8h 才截断
 * （联调需确认部署的 MCP_TOOL_TIMEOUT 不小于网关 task timeout）。
 *
 * 取消契约（C6）：父任务取消时只 abort 本地等待（网关按 parent_task_id 级联
 * 取消远程子任务），shim 不主动发任何远程取消消息；已完成子任务不受影响；
 * 迟到/重复的 subtask_result 幂等忽略。
 */
import {
  buildTaskInvokeRequest,
  type OutgoingMessage,
  type SubtaskResultParams,
} from './protocol.js'

/**
 * 委派全程（dispatch + 子任务结果）的超时上限：与网关 task timeout 同级的长超时。
 * 取 26h：略低于 ywcoder MCP 工具调用层默认截断（约 27.8h），让工具以结构化
 * 错误收尾，而不是被客户端硬断。
 */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 26 * 60 * 60 * 1000

/** 委派失败的结构化原因（MCP 层据此组装 isError 工具结果）。 */
export class DelegationFailure extends Error {
  constructor(
    readonly code:
      | 'DISPATCH_ERROR'
      | 'INVALID_DISPATCH_RESULT'
      | 'SUBTASK_FAILED'
      | 'TIMEOUT'
      | 'PARENT_CANCELLED'
      | 'PARENT_FINISHED'
      | 'SESSION_EXITED'
      | 'SHUTDOWN',
    message: string,
  ) {
    super(message)
    this.name = 'DelegationFailure'
  }
}

export interface DelegateRequest {
  sessionId: string
  parentTaskId: string
  groupId: string
  targetAgentId: string
  content: string
  metadata?: Record<string, unknown>
}

interface PendingDelegation {
  localId: string
  sessionId: string
  parentTaskId: string
  groupId: string
  targetAgentId: string
  /** 阶段一关联键：task.invoke 的外层 JSON-RPC id。 */
  invokeId: string
  /** 阶段二关联键：dispatch 回执的远程子任务 id（未回执前为 null）。 */
  remoteTaskId: string | null
  timer: NodeJS.Timeout
  resolve: (chunks: unknown[]) => void
  reject: (err: DelegationFailure) => void
  settled: boolean
}

export interface DelegationBridgeDeps {
  out: (msg: OutgoingMessage) => void
  log?: (msg: string) => void
  /** 测试注入短超时；生产用 DEFAULT_DELEGATION_TIMEOUT_MS。 */
  timeoutMs?: number
}

export class DelegationBridge {
  private readonly out: (msg: OutgoingMessage) => void
  private readonly log: (msg: string) => void
  private readonly timeoutMs: number
  private counter = 0
  private readonly records = new Map<string, PendingDelegation>()
  private readonly localIdByInvokeId = new Map<string, string>()
  private readonly localIdByRemoteTaskId = new Map<string, string>()

  constructor(deps: DelegationBridgeDeps) {
    this.out = deps.out
    this.log = deps.log ?? (() => {})
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS
  }

  /** 测试探针：当前未决委派数。 */
  get pendingCount(): number {
    return this.records.size
  }

  /**
   * 发起委派：发 task.invoke 后先等 dispatch 回执（拿到远程子任务 id），
   * 再等 task.subtask_result。completed 时 resolve chunks；
   * failed/timeout/cancelled/各类清理时 reject DelegationFailure——Promise 必定落定。
   */
  delegate(req: DelegateRequest): Promise<unknown[]> {
    const seq = ++this.counter
    const localId = `dlg-${Date.now()}-${seq}`
    const invokeId = `inv-${Date.now()}-${seq}`
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(localId, () =>
          reject(
            new DelegationFailure(
              'TIMEOUT',
              `委派 ${req.targetAgentId} 超过 ${this.timeoutMs}ms 未收到子任务结果`,
            ),
          ),
        )
      }, this.timeoutMs)
      // 长超时不应拖住 shim 自身退出（退出路径另有 failAll 统一收尾）。
      timer.unref?.()
      const record: PendingDelegation = {
        localId,
        sessionId: req.sessionId,
        parentTaskId: req.parentTaskId,
        groupId: req.groupId,
        targetAgentId: req.targetAgentId,
        invokeId,
        remoteTaskId: null,
        timer,
        resolve,
        reject,
        settled: false,
      }
      this.records.set(localId, record)
      this.localIdByInvokeId.set(invokeId, localId)
      this.out(
        buildTaskInvokeRequest({
          id: invokeId,
          parent_task_id: req.parentTaskId,
          group_id: req.groupId,
          target_agent_id: req.targetAgentId,
          content: req.content,
          ...(req.metadata ? { metadata: req.metadata } : {}),
        }),
      )
    })
  }

  /**
   * AgentClient 对 task.invoke 的 JSON-RPC response（$response 入站）。
   * 返回 false 表示 id 未匹配（上层记日志忽略）。
   */
  handleResponse(
    id: string | number,
    result: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): boolean {
    const localId = this.localIdByInvokeId.get(String(id))
    if (!localId) return false
    const record = this.records.get(localId)
    if (!record) return false

    if (error) {
      // 网关错误原样透传（-32006 非管理者/嵌套编排、-32603 断线等，§6.6）。
      this.settle(localId, () =>
        record.reject(
          new DelegationFailure(
            'DISPATCH_ERROR',
            `task.invoke 被驳回 (${error.code}): ${error.message}`,
          ),
        ),
      )
      return true
    }
    const r = result as Record<string, unknown> | undefined
    const remoteTaskId = r && typeof r.task_id === 'string' ? r.task_id : ''
    if (!remoteTaskId || r?.status !== 'dispatched') {
      this.settle(localId, () =>
        record.reject(
          new DelegationFailure(
            'INVALID_DISPATCH_RESULT',
            `task.invoke 回执非法（缺 task_id 或 status≠dispatched）: ${JSON.stringify(result)}`,
          ),
        ),
      )
      return true
    }
    // 审查 P1-2：remote task id 已被其它未决委派占用时**失败关闭**——覆盖映射
    // 会让那条委派永远等不到结果（只能拖到超时），且本记录的 settle 还会把
    // 别人的索引一并摘掉。宁可本次委派报错，也不能污染别人的关联。
    const occupant = this.localIdByRemoteTaskId.get(remoteTaskId)
    if (occupant && occupant !== localId) {
      this.settle(localId, () =>
        record.reject(
          new DelegationFailure(
            'INVALID_DISPATCH_RESULT',
            `task.invoke 回执的子任务 id ${remoteTaskId} 与另一未决委派冲突，失败关闭`,
          ),
        ),
      )
      return true
    }
    // 审查 P1-2：DISPATCHING → WAITING_RESULT 转换时**摘除阶段一索引**——
    // 此后相同 invoke id 的重复回执返回 false 幂等忽略，不再可能覆盖
    // remoteTaskId 或留下陈旧索引。
    this.localIdByInvokeId.delete(record.invokeId)
    record.remoteTaskId = remoteTaskId
    this.localIdByRemoteTaskId.set(remoteTaskId, localId)
    return true
  }

  /**
   * task.subtask_result 入站：按远程子任务 id 命中后，还要核对
   * parent/group/target 与登记值一致（防串话）；不一致或未命中 →
   * 返回 false，上层记日志幂等忽略。
   */
  handleSubtaskResult(params: SubtaskResultParams): boolean {
    const localId = this.localIdByRemoteTaskId.get(params.task_id)
    if (!localId) return false
    const record = this.records.get(localId)
    if (!record) return false
    if (
      params.parent_task_id !== record.parentTaskId ||
      params.group_id !== record.groupId ||
      params.target_agent_id !== record.targetAgentId
    ) {
      this.log(
        `task.subtask_result 关联字段与登记不符（疑似串话/错投），幂等忽略: ` +
          `task_id=${params.task_id} 收到(parent=${params.parent_task_id},group=${params.group_id},target=${params.target_agent_id})`,
      )
      return false
    }
    if (params.status === 'completed') {
      this.settle(localId, () => record.resolve(params.chunks ?? []))
    } else {
      const detail =
        params.error === null || params.error === undefined
          ? ''
          : `: ${typeof params.error === 'string' ? params.error : JSON.stringify(params.error)}`
      this.settle(localId, () =>
        record.reject(
          new DelegationFailure(
            'SUBTASK_FAILED',
            `子任务 ${params.task_id} 终态=${params.status}${detail}`,
          ),
        ),
      )
    }
    return true
  }

  /** 父任务取消/终结：abort 该任务的全部本地委派等待（C6：不发远程取消）。 */
  cancelByParentTask(
    parentTaskId: string,
    code: 'PARENT_CANCELLED' | 'PARENT_FINISHED' = 'PARENT_CANCELLED',
  ): number {
    let n = 0
    for (const record of [...this.records.values()]) {
      if (record.parentTaskId !== parentTaskId) continue
      n++
      this.settle(record.localId, () =>
        record.reject(
          new DelegationFailure(
            code,
            code === 'PARENT_CANCELLED'
              ? '父任务已取消，本地委派等待中止（远程子任务由网关级联取消）'
              : '父任务已终结，未决委派清理',
          ),
        ),
      )
    }
    return n
  }

  /** ywcoder 子进程退出：该 session 的全部未决委派以失败收尾。 */
  cleanupSession(sessionId: string): number {
    let n = 0
    for (const record of [...this.records.values()]) {
      if (record.sessionId !== sessionId) continue
      n++
      this.settle(record.localId, () =>
        record.reject(
          new DelegationFailure('SESSION_EXITED', 'ywcoder 子进程已退出，委派中止'),
        ),
      )
    }
    return n
  }

  /** stdin EOF / 网关断线 / shim 关闭：所有未决委派以失败收尾，不留悬挂 Promise。 */
  failAll(message: string): number {
    let n = 0
    for (const record of [...this.records.values()]) {
      n++
      this.settle(record.localId, () =>
        record.reject(new DelegationFailure('SHUTDOWN', message)),
      )
    }
    return n
  }

  /** 幂等落定：清计时器与全部索引后才执行收尾动作，任何路径都只落地一次。 */
  private settle(localId: string, action: () => void): void {
    const record = this.records.get(localId)
    if (!record || record.settled) return
    record.settled = true
    clearTimeout(record.timer)
    this.records.delete(localId)
    this.localIdByInvokeId.delete(record.invokeId)
    if (record.remoteTaskId !== null) {
      // 防御：仅在映射仍指向本记录时摘除（冲突失败关闭路径未登记本记录，
      // 无条件 delete 会把占用方的索引一并摘掉）。
      if (this.localIdByRemoteTaskId.get(record.remoteTaskId) === localId) {
        this.localIdByRemoteTaskId.delete(record.remoteTaskId)
      }
    }
    action()
  }
}
