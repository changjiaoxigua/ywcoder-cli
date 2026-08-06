/**
 * M3 —— 组装：拼接上下行（ywcoderSession.ts + protocol.ts），按 session_id
 * 路由/管理多个 ywcoder 子进程，stdout 只写协议 JSONL（日志一律走 stderr）。
 *
 * 启动方式（见 shim-build-plan.md §2）：
 *   ywcoder-ywmatrix --workdir <dir> --permission-mode <default|acceptEdits|bypassPermissions|...>
 *
 * 简单档 MVP：不接 can_use_tool 控制面（M4 才做），--permission-mode 建议用
 * acceptEdits/bypassPermissions。
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
  buildError,
  buildEventError,
  buildInitializeResult,
  buildPingResult,
  buildRegisterNotification,
  buildStatusNotification,
  buildTaskCancelResult,
  buildTaskCreateAck,
  parseIncoming,
  translateYwcoderEvent,
  writeMessage,
  type TaskCancelParams,
  type TaskCreateParams,
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
    // M4（can_use_tool 控制面）尚未实现：default 模式下需要确认的工具会直接
    // 收到 is_error 的 tool_result，而不会弹出网页确认（见 ywcoder-integration.md §8.2/§8.3）。
    log(
      '警告: --permission-mode default 但简单档未实现 can_use_tool 控制面，危险操作将直接失败而非弹确认，建议 acceptEdits/bypassPermissions',
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

class Shim {
  private sessions = new Map<string, SessionEntry>()
  private taskToSession = new Map<string, string>()

  constructor(private args: CliArgs) {}

  start(): void {
    const rl = createInterface({ input: process.stdin })
    rl.on('line', line => this.handleLine(line))
    rl.on('close', () => this.shutdown())
    process.on('SIGTERM', () => this.shutdown())
    process.on('SIGINT', () => this.shutdown())
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
        // 简单档不实现控制面，没有待确认项可回复。
        if (msg.id !== null) {
          writeMessage(
            buildError(
              msg.id,
              JsonRpcErrorCode.CapabilityNotSupported,
              '简单档不支持 task.respond（未启用 can_use_tool 控制面）',
            ),
          )
        }
        return
    }
  }

  private handleTaskCreate(id: string | number, params: TaskCreateParams): void {
    if (params.type === 'respond') {
      writeMessage(
        buildError(
          id,
          JsonRpcErrorCode.CapabilityNotSupported,
          '简单档不支持 type=respond（未启用 can_use_tool 控制面）',
        ),
      )
      return
    }

    // 会话 id 由 ywcoder 侧拥有、管控台采纳（§9.2）：首条 task.create 不带 session_id
    // 时，shim 生成一个 UUID 作为会话 id，并在 ack 回传供管控台后续沿用。
    const sessionId =
      params.session_id && params.session_id.length > 0
        ? params.session_id
        : randomUUID()

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
        writeMessage(
          buildEventError({
            task_id: entry.activeTaskId,
            code: 'LOCAL_AGENT_ERROR',
            message,
            recoverable: false,
          }),
        )
        this.sessions.delete(sessionId)
      })
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

  private handleSessionEvent(sessionId: string, event: YwcoderSessionEvent): void {
    const entry = this.sessions.get(sessionId)
    const taskId = entry?.activeTaskId ?? null

    if (!taskId) {
      // 没有活动任务时的 exit/error（如子进程握手期间崩溃）仍需上报。
      if (event.kind === 'exit' || event.kind === 'error') {
        writeMessage(
          buildEventError({
            task_id: null,
            code: 'LOCAL_AGENT_ERROR',
            message:
              event.kind === 'error'
                ? event.message
                : `ywcoder 子进程异常退出 code=${event.code} signal=${event.signal}`,
            recoverable: false,
          }),
        )
      }
      if (event.kind === 'exit') this.sessions.delete(sessionId)
      return
    }

    for (const msg of translateYwcoderEvent(event, { taskId, sessionId })) {
      writeMessage(msg)
    }

    if (event.kind === 'completed' || event.kind === 'error') {
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
      this.sessions.delete(sessionId)
    }
  }

  private handleTaskCancel(id: string | number, params: TaskCancelParams): void {
    const sessionId = params.session_id ?? this.taskToSession.get(params.task_id)
    const entry = sessionId ? this.sessions.get(sessionId) : undefined
    if (!entry) {
      writeMessage(buildError(id, JsonRpcErrorCode.TaskNotFound, 'Task not found'))
      return
    }

    if (entry.activeTaskId === params.task_id) {
      // 当前正在跑的任务：转 interrupt（§6.3）。
      entry.session?.interrupt()
    } else {
      // 还在队列里排队、尚未喂给 ywcoder：直接摘除，不影响正在跑的其它任务。
      const idx = entry.queue.findIndex(t => t.taskId === params.task_id)
      if (idx === -1) {
        writeMessage(buildError(id, JsonRpcErrorCode.TaskNotFound, 'Task not found'))
        return
      }
      entry.queue.splice(idx, 1)
    }
    this.taskToSession.delete(params.task_id)
    writeMessage(buildTaskCancelResult(id, params.task_id))
  }

  private shutdown(): void {
    for (const entry of this.sessions.values()) entry.session?.kill()
    process.exit(0)
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
