/**
 * M3 —— 组装：拼接上下行（ywcoderSession.ts + protocol.ts），按 session_id
 * 路由/管理多个 ywcoder 子进程，stdout 只写协议 JSONL（日志一律走 stderr）。
 *
 * 启动方式（见 shim-build-plan.md §2）：
 *   ywcoder-ywmatrix --workdir <dir> --permission-mode <default|acceptEdits|bypassPermissions|...>
 *
 * 档位由 --permission-mode 决定（§8.2）：`default` 走完整档（ywcoderSession 自动补
 * --permission-prompt-tool stdio，权限经 can_use_tool ↔ confirm_required ↔
 * task.respond 到网页确认）；acceptEdits/bypassPermissions 走简单档，无控制面。
 */
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
} from '../../types/permissions.js'
import { YwcoderSession, type YwcoderSessionEvent } from './ywcoderSession.js'
import {
  JsonRpcErrorCode,
  buildConfirmCancelledChunk,
  buildError,
  buildEventError,
  buildInitializeResult,
  buildPingResult,
  buildRegisterNotification,
  buildResult,
  buildStatusNotification,
  buildTaskCancelResult,
  buildTaskCreateAck,
  normalizeConfirmResponse,
  parseIncoming,
  translateYwcoderEvent,
  writeMessage,
  type ConfirmCancelReason,
  type TaskCancelParams,
  type TaskCreateParams,
  type TaskRespondParams,
} from './protocol.js'

function log(msg: string): void {
  process.stderr.write(`[ywmatrix-shim] ${msg}\n`)
}

interface CliArgs {
  workdir: string
  permissionMode: ExternalPermissionMode
}

function parseArgs(argv: string[]): CliArgs {
  let workdir: string | undefined
  let permissionMode: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workdir') workdir = argv[++i]
    else if (argv[i] === '--permission-mode') permissionMode = argv[++i]
  }
  if (!workdir) {
    process.stderr.write('缺少必填参数 --workdir\n')
    process.exit(1)
  }
  if (!permissionMode) {
    process.stderr.write('缺少必填参数 --permission-mode\n')
    process.exit(1)
  }
  if (!(EXTERNAL_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    process.stderr.write(
      `非法 --permission-mode: ${permissionMode}（合法值：${EXTERNAL_PERMISSION_MODES.join(', ')}）\n`,
    )
    process.exit(1)
  }
  if (permissionMode === 'default') {
    // 完整档：ywcoderSession 会自动补 --permission-prompt-tool stdio，需确认的工具
    // 走 can_use_tool 控制面到网页（见 ywcoder-integration.md §6.2/§8.2）。
    log('完整档已启用: --permission-mode default，工具权限走网页确认（can_use_tool 控制面）')
  } else {
    log(
      `简单档: --permission-mode ${permissionMode}，不启用 can_use_tool 控制面（不会弹网页确认）`,
    )
  }
  return {
    workdir: resolve(workdir),
    permissionMode: permissionMode as ExternalPermissionMode,
  }
}

interface SessionEntry {
  session: YwcoderSession | null
  queue: Array<{ taskId: string; content: string }>
  activeTaskId: string | null
}

/** 待网页裁决的权限请求（confirm_id 即 ywcoder can_use_tool 的 request_id）。 */
interface PendingConfirm {
  sessionId: string
  taskId: string
}

class Shim {
  private sessions = new Map<string, SessionEntry>()
  private taskToSession = new Map<string, string>()
  // confirm_id → 所属 session/task，供 task.respond 路由回对应 ywcoder 子进程（§6.2）。
  // 刻意不带超时定时器：confirm 不设 shim 短超时（§8.3 硬约束 2）。
  private pendingConfirms = new Map<string, PendingConfirm>()
  private shuttingDown = false

  constructor(private args: CliArgs) {}

  start(): void {
    const rl = createInterface({ input: process.stdin })
    rl.on('line', line => this.handleLine(line))
    rl.on('close', () => this.shutdown())
    process.on('SIGTERM', () => this.shutdown())
    process.on('SIGINT', () => this.shutdown())
    // AgentClient 先关掉 stdout 的场景：写入会 EPIPE。无监听者时 Node 抛未捕获异常，
    // shim 猝死 → ywcoder 子进程变孤儿继续跑、继续烧 token。
    process.stdout.on('error', () => this.shutdown(0))
    // 同理兜底任何未预期异常：宁可退出，也不能留下没人管的 ywcoder 子进程。
    process.on('uncaughtException', err => {
      log(`未捕获异常，回收子进程后退出: ${err instanceof Error ? err.stack : String(err)}`)
      this.shutdown(1)
    })
  }

  private handleLine(line: string): void {
    const result = parseIncoming(line)
    if (result === null) return
    if (!result.ok) {
      writeMessage(buildError(result.id, result.code, result.message))
      return
    }
    const msg = result.message
    switch (msg.method) {
      case 'lifecycle.initialize':
        writeMessage(buildInitializeResult(msg.id))
        return
      case 'lifecycle.initialized':
        // 协商完成，随即注册（local-agent-interface.md §5.2）。
        writeMessage(buildRegisterNotification())
        return
      case 'lifecycle.ping':
        writeMessage(buildPingResult(msg.id, msg.params.timestamp))
        return
      case 'task.create':
        this.handleTaskCreate(msg.id, msg.params)
        return
      case 'task.cancel':
        this.handleTaskCancel(msg.id, msg.params)
        return
      case 'task.respond':
        this.handleTaskRespond(msg.id, msg.params)
        return
    }
  }

  private handleTaskCreate(id: string | number, params: TaskCreateParams): void {
    if (params.type === 'respond') {
      // §5：type=respond 等价于 task.respond，走控制面而非新起一轮对话。
      if (!params.confirm_id) {
        writeMessage(
          buildError(
            id,
            JsonRpcErrorCode.InvalidParams,
            'type=respond 必须带 confirm_id',
          ),
        )
        return
      }
      this.handleTaskRespond(id, {
        task_id: params.task_id,
        session_id: params.session_id,
        confirm_id: params.confirm_id,
        response: params.content,
      })
      return
    }

    // 会话 id 由网关生成（`session.create` 时 randomUUID，落库后浏览器每条 task 都带），
    // shim **原样采纳**，不自行生成（§9.2）。下面的 mint 只是防御性兜底：按约定
    // session_id 必到，缺失说明上游链路有问题，故告警——且 AgentClient 不消费 ack 里的
    // session_id，mint 出来的 id 它并不知道，只能保证本进程内路由自洽。
    let sessionId = params.session_id ?? ''
    if (sessionId.length === 0) {
      sessionId = randomUUID()
      log(
        `警告: task.create(task_id=${params.task_id}) 未带 session_id（与管控台约定不符），临时 mint ${sessionId}`,
      )
    }

    // 立即确认收到（local-agent-interface.md §6.1），并回传 session_id；结果随后经 stream.chunk 流式返回。
    writeMessage(buildTaskCreateAck(id, params.task_id, sessionId))
    this.taskToSession.set(params.task_id, sessionId)

    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { session: null, queue: [], activeTaskId: null }
      this.sessions.set(sessionId, entry)
      this.spawnSession(sessionId, entry)
    }
    entry.queue.push({ taskId: params.task_id, content: params.content })
    this.pump(sessionId)
  }

  private spawnSession(sessionId: string, entry: SessionEntry): void {
    YwcoderSession.spawn({
      workdir: this.args.workdir,
      permissionMode: this.args.permissionMode,
      sessionId,
      onEvent: event => this.handleSessionEvent(sessionId, event),
    })
      .then(session => {
        entry.session = session
        this.pump(sessionId)
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        log(`session_id=${sessionId} 启动失败: ${message}`)
        // 启动失败时 activeTaskId 必为 null（pump 还没跑过），若只按它上报，
        // 触发这次启动的任务反而没人告诉管控台——必须逐个 task 上报。
        this.failPendingTasks(entry, message)
        this.sessions.delete(sessionId)
      })
  }

  /**
   * 把该 session 里「已接收但永远不会有结果」的任务逐个上报为 event.error：
   * 排队中尚未喂给 ywcoder 的任务不会产生 result 事件，不上报则管控台侧永久悬挂。
   */
  private failPendingTasks(entry: SessionEntry, message: string): void {
    const doomed = entry.queue.splice(0)
    if (entry.activeTaskId) {
      doomed.unshift({ taskId: entry.activeTaskId, content: '' })
      entry.activeTaskId = null
    }
    if (doomed.length === 0) {
      // 连一个任务都没有（如握手期崩溃）：仍需让管控台知道 agent 出事了。
      writeMessage(
        buildEventError({
          task_id: null,
          code: 'LOCAL_AGENT_ERROR',
          message,
          recoverable: false,
        }),
      )
      return
    }
    for (const task of doomed) {
      writeMessage(
        buildEventError({
          task_id: task.taskId,
          code: 'LOCAL_AGENT_ERROR',
          message,
          recoverable: false,
        }),
      )
      this.taskToSession.delete(task.taskId)
    }
  }

  /** 同一 session 内多个 task 串行（§9.1）：当前无活动任务时才把队首任务喂给 ywcoder。 */
  private pump(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || !entry.session || entry.activeTaskId) return
    const next = entry.queue.shift()
    if (!next) return
    entry.activeTaskId = next.taskId
    writeMessage(buildStatusNotification('busy', next.taskId, sessionId))
    entry.session.sendUser(next.content)
  }

  /** 管控台对 confirm_required 的回复 → 路由回对应 ywcoder 子进程（§6.2）。 */
  private handleTaskRespond(
    id: string | number | null,
    params: TaskRespondParams,
  ): void {
    const pending = this.pendingConfirms.get(params.confirm_id)
    const entry = pending ? this.sessions.get(pending.sessionId) : undefined
    if (!pending || !entry?.session) {
      // 已被撤销（ywcoder control_cancel_request）、已回复过，或 id 不存在（§10）。
      log(`task.respond 未找到待决确认 confirm_id=${params.confirm_id}`)
      if (id !== null) {
        writeMessage(
          buildError(id, JsonRpcErrorCode.TaskNotFound, 'Confirm not found'),
        )
      }
      return
    }

    const decision = normalizeConfirmResponse(params.response)
    this.pendingConfirms.delete(params.confirm_id)
    entry.session.respondPermission(params.confirm_id, decision)
    if (id !== null) {
      writeMessage(
        buildResult(id, {
          // 回请求方自己带的 task_id（type='respond' 时可能与发起确认的任务不同），
          // 便于调用方对账；缺省才回落到待决确认所属的任务。
          task_id: params.task_id ?? pending.taskId,
          session_id: pending.sessionId,
          confirm_id: params.confirm_id,
          status: 'accepted',
          decision: decision.kind,
        }),
      )
    }
  }

  /**
   * 撤销一个待决确认：摘除映射并通知网页关框（§8.1.1）。
   *
   * 「只有映射确实还在时才发通知」天然去重——task.cancel 会先主动摘除，随后
   * ywcoder 那条迟到的 control_cancel_request 就不会让同一个框收到两条撤销。
   */
  private cancelConfirm(confirmId: string, reason: ConfirmCancelReason): void {
    const pending = this.pendingConfirms.get(confirmId)
    if (!pending) return
    this.pendingConfirms.delete(confirmId)
    writeMessage(
      buildConfirmCancelledChunk({
        task_id: pending.taskId,
        session_id: pending.sessionId,
        confirm_id: confirmId,
        reason,
      }),
    )
  }

  /** 撤销某 session（可限定 task）下所有待决确认，避免网页留下悬挂的确认框。 */
  private clearPendingConfirms(
    sessionId: string,
    taskId: string | undefined,
    reason: ConfirmCancelReason,
  ): void {
    for (const [confirmId, pending] of this.pendingConfirms) {
      if (pending.sessionId !== sessionId) continue
      if (taskId && pending.taskId !== taskId) continue
      this.cancelConfirm(confirmId, reason)
    }
  }

  private handleSessionEvent(sessionId: string, event: YwcoderSessionEvent): void {
    const entry = this.sessions.get(sessionId)
    const taskId = entry?.activeTaskId ?? null

    if (!taskId) {
      if (event.kind === 'permission_required') {
        // 没有活动任务却收到权限请求（本轮已收尾但工具请求迟到等）：**必须回一条裁决**。
        // ywcoder 的 pendingRequests 没有自超时，静默丢弃会让子进程永久阻塞、该 session
        // 后续任务全部卡死。无任务上下文可推给网页确认，只能安全地拒绝。
        log(`session_id=${sessionId} 无活动任务时收到权限请求，自动拒绝 request_id=${event.requestId}`)
        entry?.session?.respondPermission(event.requestId, {
          kind: 'deny',
          message: '该任务已结束，权限请求无法送达管控台确认',
        })
        return
      }
      // 没有活动任务时的 exit/error（如子进程握手期间崩溃）仍需上报；队列里
      // 排队的任务也随之作废，逐个上报（failPendingTasks 在无任务时会退化为
      // 一条 task_id:null 的 event.error）。
      if (event.kind === 'exit' || event.kind === 'error') {
        const message =
          event.kind === 'error'
            ? event.message
            : `ywcoder 子进程异常退出 code=${event.code} signal=${event.signal}`
        if (entry) this.failPendingTasks(entry, message)
        else {
          writeMessage(
            buildEventError({
              task_id: null,
              code: 'LOCAL_AGENT_ERROR',
              message,
              recoverable: false,
            }),
          )
        }
      }
      if (event.kind === 'exit') {
        this.clearPendingConfirms(sessionId, undefined, 'agent_exited')
        this.sessions.delete(sessionId)
      }
      return
    }

    // 权限请求的映射登记必须先于 confirm_required 发出，否则网页秒回时会找不到。
    if (event.kind === 'permission_required') {
      this.pendingConfirms.set(event.requestId, { sessionId, taskId })
    } else if (event.kind === 'permission_cancelled') {
      // ywcoder 主动放弃了这条权限请求（同轮其它操作触发中止）。
      this.cancelConfirm(event.requestId, 'interrupted')
    }

    for (const msg of translateYwcoderEvent(event, { taskId, sessionId })) {
      writeMessage(msg)
    }

    if (event.kind === 'completed' || event.kind === 'error') {
      // 本轮结束：残留的待决确认（如 deny+interrupt 中止时）不再可回复，通知网页关框。
      this.clearPendingConfirms(sessionId, taskId, 'interrupted')
      writeMessage(
        buildStatusNotification(
          event.kind === 'completed' ? 'idle' : 'error',
          taskId,
          sessionId,
        ),
      )
      this.taskToSession.delete(taskId)
      if (entry) {
        entry.activeTaskId = null
        this.pump(sessionId)
      }
    }

    if (event.kind === 'exit') {
      this.clearPendingConfirms(sessionId, undefined, 'agent_exited')
      this.taskToSession.delete(taskId)
      if (entry && entry.queue.length > 0) {
        // 活动任务已由上面的 translate 上报为 event.error；这里补上还在排队、
        // 永远等不到子进程的那些任务（activeTaskId 先清空，避免重复上报）。
        entry.activeTaskId = null
        this.failPendingTasks(
          entry,
          `ywcoder 子进程异常退出 code=${event.code} signal=${event.signal}`,
        )
      }
      this.sessions.delete(sessionId)
    }
  }

  /**
   * 管控台「停止」（§6.3）。按 v2 是通知类（不带 id），此时一律不回 result/error；
   * 兼容带 id 的请求形式时才回。
   */
  private handleTaskCancel(
    id: string | number | null,
    params: TaskCancelParams,
  ): void {
    const notFound = (): void => {
      log(`task.cancel 未找到任务 task_id=${params.task_id}`)
      if (id !== null) {
        writeMessage(buildError(id, JsonRpcErrorCode.TaskNotFound, 'Task not found'))
      }
    }

    const sessionId = params.session_id ?? this.taskToSession.get(params.task_id)
    const entry = sessionId ? this.sessions.get(sessionId) : undefined
    if (!entry || !sessionId) {
      notFound()
      return
    }

    if (entry.activeTaskId === params.task_id) {
      // 当前正在跑的任务：转 interrupt（§6.3）。与控制面并存——先撤掉待决确认框
      // （网页据此关框），再中断 ywcoder；它随后那条 control_cancel_request 因映射
      // 已摘除而不会重复发通知。
      this.clearPendingConfirms(sessionId, params.task_id, 'task_cancelled')
      entry.session?.interrupt()
    } else {
      // 还在队列里排队、尚未喂给 ywcoder：直接摘除，不影响正在跑的其它任务。
      const idx = entry.queue.findIndex(t => t.taskId === params.task_id)
      if (idx === -1) {
        notFound()
        return
      }
      entry.queue.splice(idx, 1)
      // 队列任务没进过 ywcoder，不会有 result 事件给它收尾。通知形式的 cancel 又不回
      // result，若这里不出声，管控台侧这个 task_id 会一直悬着（只能等兜底超时）。
      // 与「活动任务被 interrupt 后以 event.error 收尾」保持一致。
      writeMessage(
        buildEventError({
          task_id: params.task_id,
          code: 'TASK_CANCELLED',
          message: '任务在排队中被取消',
          recoverable: false,
        }),
      )
    }
    this.taskToSession.delete(params.task_id)
    if (id !== null) writeMessage(buildTaskCancelResult(id, params.task_id))
  }

  private shutdown(code = 0): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    for (const entry of this.sessions.values()) entry.session?.kill()
    process.exit(code)
  }
}

const args = parseArgs(process.argv.slice(2))

// §9.2 硬约束：sessionIdExists 内部用 process.cwd() 判定；shim 进程 cwd 必须
// == --workdir，否则 --session-id/--resume 分支会判断错误。AgentClient 按约定
// 以 workdir 为 cwd 拉起 shim（见 §2），这里失配就直接快速失败而非静默纠正。
// 比较用真实路径（realpath）：macOS 上 /tmp 等是符号链接，process.cwd() 会被解析为
// /private/tmp，若只做 resolve 不解链接会误判为不一致。
function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
if (canonicalPath(process.cwd()) !== canonicalPath(args.workdir)) {
  log(
    `致命: shim 进程 cwd(${process.cwd()}) 与 --workdir(${args.workdir}) 不一致，拒绝启动`,
  )
  process.exit(1)
}

new Shim(args).start()
