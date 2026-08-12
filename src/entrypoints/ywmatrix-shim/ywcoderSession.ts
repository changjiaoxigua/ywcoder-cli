/**
 * M1 —— 下行封装：spawn ywcoder 子进程（stream-json 模式），完成 initialize 握手，
 * 并把 ywcoder 的 SDKMessage 规范化为 shim 内部事件。
 *
 * 硬约束（见 note/feature_ywmatrix/docs/shim-build-plan.md §4）：
 * - 只观测 tool_use/tool_result，绝不代执行工具或注入 tool_result。
 * - stdout 只用于与 ywcoder 子进程通信，不与 AgentClient 侧的 stdout 混用。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionIdExists } from '../../utils/sessionStorage.js'
import { validateUuid } from '../../utils/uuid.js'
import type { ExternalPermissionMode } from '../../types/permissions.js'
import { StdoutMessageSchema } from '../sdk/controlSchemas.js'

/**
 * ywcoder 会话启动模式（§9.2）：
 * - 'create'：会话 id 是合法 UUID 且本地无该会话 → `--session-id`（首建，ywcoder 采用此 id）。
 * - 'resume'：会话 id 是合法 UUID 且本地已有 → `--resume`（续接）。
 * - 'ephemeral'：会话 id 非 UUID（如网关兜底 `{task_id}-session`）→ 不传 `--session-id`/`--resume`，
 *   ywcoder 自动生成内部 id，一次性任务、不续接。
 */
type LaunchMode = 'create' | 'resume' | 'ephemeral'

// 与本文件同 dist 目录下的 cli.mjs（构建产物随包分发，见 scripts/build.ts 的
// ywmatrix-shim 构建目标）。
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs')

/**
 * interrupt 后等 ywcoder 产出 result 收尾的上限，超时即强杀子进程解卡。
 *
 * 这**不违反**「审批不设超时」的硬约束（ywcoder-integration.md §8.3）：那条禁的是
 * confirm 级超时（人在回路，必须等人）；interrupt 是机器对机器的操作，实测都在秒级
 * 内返回 `result{error_during_execution}`。不设这个上限的话，ywcoder 万一不响应，
 * 该 session 的 activeTaskId 就永远挂着、后续任务全堵在队列里，且再发 task.cancel
 * 也无效——这是唯一会让 session 永久卡死的路径。
 *
 * 强杀是可恢复的：会话已按 `<projectDir>/<id>.jsonl` 落盘，下一条 task.create 会以
 * `--resume` 原样恢复上下文，最坏后果只是重启一个子进程。
 */
const INTERRUPT_GRACE_MS = 10_000
/** SIGTERM 后仍不退出则升级到 SIGKILL——否则「保证解卡」这个目的本身就不成立。 */
const SIGKILL_ESCALATION_MS = 5_000

export type YwcoderSessionEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'action'
      toolUseId: string
      name: string
      input: Record<string, unknown>
    }
  | {
      kind: 'result'
      toolUseId: string
      name: string
      content: unknown
      isError: boolean
      /**
       * M5：对应 tool_use 的 `arguments.file_path`（若有）。文件读取类结果据此
       * 推断 mimeType 并包成 resource 块（§4.1）。
       */
      filePath?: string
      /** M5：对应 tool_use 带了 offset/limit，结果只是文件片段而非全文。 */
      partialRead?: boolean
    }
  | {
      kind: 'completed'
      result: string
      usage: unknown
      totalCostUsd: number
      /** 本轮被拒绝的工具调用（result.permission_denials），完整档下用于回执确认结果。 */
      permissionDenials: unknown[]
      sessionId: string
    }
  | { kind: 'error'; message: string; sessionId: string | null }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  /**
   * M4 完整档：ywcoder 发来 `control_request{can_use_tool}`，等待权限裁决（§6.2）。
   * 注意：这里刻意**不透传** `permission_suggestions`——它是「永久加白名单」建议，
   * 回传即被 ywcoder 持久化落盘（§6.2 硬约束 2），shim 一律丢弃。
   */
  | {
      kind: 'permission_required'
      requestId: string
      toolName: string
      toolUseId: string
      input: Record<string, unknown>
      blockedPath?: string
      decisionReason?: string
      title?: string
      description?: string
    }
  /** ywcoder 侧撤销了一条待决权限请求（如 interrupt 触发 abort），shim 只需清理映射。 */
  | { kind: 'permission_cancelled'; requestId: string }

/** 权限裁决（管控台 task.respond → §6.2 的三种 control_response 语义）。 */
export type PermissionRespondDecision =
  /** 允许本次工具：回 `{behavior:'allow', updatedInput:{}}`。 */
  | { kind: 'allow' }
  /** 仅拒绝本次工具，模型继续对话。 */
  | { kind: 'deny'; message: string }
  /** 拒绝并中断整个任务（deny + interrupt:true）。 */
  | { kind: 'cancel'; message: string }

export interface YwcoderSessionOptions {
  /** 工作目录：ywcoder 子进程的 cwd 与 --add-dir 均取此值。 */
  workdir: string
  permissionMode: ExternalPermissionMode
  /**
   * 会话 id（见 §9.2）：正常是 shim 生成或管控台沿用的 UUID（走 --session-id/--resume）；
   * 若为非 UUID（网关兜底 `{task_id}-session`），则按 ephemeral 一次性处理。
   */
  sessionId: string
  model?: string
  fallbackModel?: string
  onEvent: (event: YwcoderSessionEvent) => void
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

export class YwcoderSession {
  readonly sessionId: string
  private opts: YwcoderSessionOptions
  private child!: ChildProcessWithoutNullStreams
  /** tool_use_id → 工具名与文件读取上下文，供 tool_result 回填（M5，§4.1）。 */
  private toolInfoByUseId = new Map<
    string,
    { name: string; filePath?: string; partialRead?: boolean }
  >()
  private initRequestId!: string
  private readyResolve!: () => void
  private readyReject!: (err: Error) => void
  private readySettled = false
  private recentStderr: string[] = []
  /** 子进程是否仍可写 stdin（退出后写会 EPIPE）。 */
  private alive = false
  /** interrupt 看门狗与 SIGKILL 升级计时器（见 INTERRUPT_GRACE_MS）。 */
  private interruptTimer: NodeJS.Timeout | null = null
  private killTimer: NodeJS.Timeout | null = null

  private constructor(opts: YwcoderSessionOptions) {
    this.opts = opts
    this.sessionId = opts.sessionId
  }

  static async spawn(opts: YwcoderSessionOptions): Promise<YwcoderSession> {
    const session = new YwcoderSession(opts)
    const mode = session.resolveLaunchMode()
    try {
      await session.launch(mode)
    } catch (err) {
      // §9.2 兜底：create 模式下 --session-id 竞态被抢先创建，回退为 --resume 重试一次。
      if (mode === 'create' && isAlreadyInUseError(err)) {
        session.log('--session-id 冲突（可能存在竞态），回退为 --resume 重试')
        await session.launch('resume')
      } else {
        throw err
      }
    }
    return session
  }

  /** 依据 session_id 格式与本地是否已有会话，决定启动模式（§9.2）。 */
  private resolveLaunchMode(): LaunchMode {
    if (!validateUuid(this.sessionId)) return 'ephemeral' // 非 UUID（兜底 *-session）→ 一次性
    return sessionIdExists(this.sessionId) ? 'resume' : 'create'
  }

  private buildArgs(mode: LaunchMode): string[] {
    const args = [
      CLI_ENTRY,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      this.opts.permissionMode,
      '--add-dir',
      this.opts.workdir,
    ]
    // 完整档（§2/§8.2）：default 档必须补 --permission-prompt-tool stdio，这是让工具
    // 权限走 can_use_tool 控制面的**必要条件**——不加则由本地按 permission-mode 判定，
    // 需批准的工具直接返回 is_error 的 tool_result，网页永远收不到确认。
    // acceptEdits/bypassPermissions 是简单档，不接控制面。
    if (this.opts.permissionMode === 'default') {
      args.push('--permission-prompt-tool', 'stdio')
    }
    // ephemeral：不传 --session-id/--resume，由 ywcoder 自动生成内部 id。
    if (mode === 'resume') args.push('--resume', this.opts.sessionId)
    else if (mode === 'create') args.push('--session-id', this.opts.sessionId)
    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.fallbackModel) {
      args.push('--fallback-model', this.opts.fallbackModel)
    }
    return args
  }

  private launch(mode: LaunchMode): Promise<void> {
    this.initRequestId = `init-${Date.now()}-${shortId()}`
    this.readySettled = false
    this.recentStderr = []

    const args = this.buildArgs(mode)
    this.log(`spawn(${mode}): node ${args.join(' ')}`)
    this.child = spawn(process.execPath, args, {
      cwd: this.opts.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.alive = true

    // stdin 的 'error'（子进程已退出时写入的 EPIPE）若无监听者，Node 会抛成未捕获
    // 异常，把整个 shim 连同其它 session 一起带走。这里吞掉并记日志：真正的收尾
    // 由下面的 'exit' 事件统一上报。
    this.child.stdin.on('error', err => {
      this.log(`写 ywcoder stdin 失败(子进程可能已退出): ${err.message}`)
    })

    const stdoutRl = createInterface({ input: this.child.stdout })
    stdoutRl.on('line', line => this.handleLine(line))

    const stderrRl = createInterface({ input: this.child.stderr })
    stderrRl.on('line', line => {
      if (this.recentStderr.length >= 20) this.recentStderr.shift()
      this.recentStderr.push(line)
      this.log(`[ywcoder stderr] ${line}`)
    })

    this.child.on('error', err => {
      this.settleReadyError(new Error(`ywcoder 子进程启动失败: ${err.message}`))
    })

    this.child.on('exit', (code, signal) => {
      this.alive = false
      this.clearWatchdogs()
      if (!this.readySettled) {
        this.settleReadyError(
          new Error(
            `ywcoder 子进程在握手完成前退出 code=${code} signal=${signal}: ${this.recentStderr.join('\n')}`,
          ),
        )
      }
      this.opts.onEvent({ kind: 'exit', code, signal })
    })

    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    this.send({
      type: 'control_request',
      request_id: this.initRequestId,
      request: { subtype: 'initialize' },
    })

    return ready
  }

  private settleReadyError(err: Error): void {
    if (this.readySettled) return
    this.readySettled = true
    this.readyReject(err)
  }

  private settleReadyOk(): void {
    if (this.readySettled) return
    this.readySettled = true
    this.readyResolve()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.log(`无法解析 ywcoder stdout 行(非 JSON): ${line}`)
      return
    }

    // 字段按 ywcoder-integration.md §4/§6 用 ywcoder 自带 zod schema 做诊断性校验。
    // 实测发现 ywcoder 输出与其自带 schema 存在漂移（如 system/init.apiKeySource
    // 会给 "none"，不在 ApiKeySourceSchema 的枚举内），校验失败只记警告、不丢弃
    // 消息——否则会把真实协议消息静默吞掉（system/init 的 session_id 回显就因此
    // 被吃掉过）。
    if (!StdoutMessageSchema().safeParse(parsed).success) {
      this.log(`ywcoder stdout 行未通过 schema 校验(仍按原始 JSON 处理): ${line}`)
    }
    if (!parsed || typeof parsed !== 'object') return
    const msg = parsed as Record<string, unknown>

    switch (msg.type) {
      case 'control_response': {
        const response = msg.response as Record<string, unknown>
        if (response.request_id !== this.initRequestId) return
        if (response.subtype === 'success') {
          // initialize 握手完成，即可开始 sendUser（见下方 system/init 时序说明）。
          this.settleReadyOk()
          return
        }
        this.settleReadyError(
          new Error(`ywcoder initialize 失败: ${String(response.error)}`),
        )
        return
      }
      case 'control_request': {
        this.handleControlRequest(msg)
        return
      }
      case 'control_cancel_request': {
        // ywcoder 侧撤销了一条待决 control_request（如 interrupt 触发 abort，
        // 见 structuredIO.ts sendRequest 的 aborted 分支）。此后再回 control_response
        // 已无意义，交给上层清理 confirm_id 映射。
        this.opts.onEvent({
          kind: 'permission_cancelled',
          requestId: String(msg.request_id ?? ''),
        })
        return
      }
      case 'system': {
        if (msg.subtype !== 'init') return
        // 实测（非文档描述的时序）：system/init 并非紧跟 control_response 之后
        // 主动推送，而是延迟到 query engine 处理第一条用户消息时才产出（见
        // QueryEngine.ts buildSystemInitMessage 调用点）。因此 ready 不能等它，
        // 只用于校验 session_id 回显是否与我们传入的 --session-id/--resume 一致。
        const sid = msg.session_id as string
        // ephemeral（非 UUID）模式下 ywcoder 用自生成 id，与传入的 session_id 本就不同，跳过校验。
        if (validateUuid(this.sessionId) && sid !== this.sessionId) {
          this.log(
            `警告: system/init 回显 session_id=${sid} 与预期 ${this.sessionId} 不一致`,
          )
        }
        return
      }
      case 'assistant': {
        this.handleAssistantMessage(msg)
        return
      }
      case 'user': {
        this.handleUserMessage(msg)
        return
      }
      case 'result': {
        this.handleResultMessage(msg)
        return
      }
      default:
        // stream_event（partial）等其他消息类型：MVP 不开 partial，忽略（§11）。
        return
    }
  }

  /**
   * ywcoder → shim 的 control_request（§6.2）。只支持 can_use_tool；其余 subtype
   * （hook_callback/mcp_message 等）必须显式回 error——ywcoder 的 pendingRequests
   * 没有自超时，静默不理会让它一直挂着。
   */
  private handleControlRequest(msg: Record<string, unknown>): void {
    const requestId = String(msg.request_id ?? '')
    const request = (msg.request as Record<string, unknown> | undefined) ?? {}
    if (request.subtype !== 'can_use_tool') {
      this.log(
        `不支持的 control_request subtype=${String(request.subtype)}，回 error 避免 ywcoder 挂起`,
      )
      this.send({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: `ywmatrix-shim 不支持的 control_request subtype: ${String(request.subtype)}`,
        },
      })
      return
    }
    // permission_suggestions 在此被刻意丢弃（§6.2 硬约束 2），不进入事件、不回传。
    this.opts.onEvent({
      kind: 'permission_required',
      requestId,
      toolName: (request.tool_name as string) ?? 'Tool',
      toolUseId: (request.tool_use_id as string) ?? '',
      input: (request.input as Record<string, unknown>) ?? {},
      blockedPath:
        typeof request.blocked_path === 'string' ? request.blocked_path : undefined,
      decisionReason:
        typeof request.decision_reason === 'string'
          ? request.decision_reason
          : undefined,
      title: typeof request.title === 'string' ? request.title : undefined,
      description:
        typeof request.description === 'string' ? request.description : undefined,
    })
  }

  private handleAssistantMessage(msg: Record<string, unknown>): void {
    const message = msg.message as Record<string, unknown> | undefined
    const content = message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') {
        this.opts.onEvent({ kind: 'text', text: b.text })
      } else if (b.type === 'tool_use') {
        const toolUseId = b.id as string
        const name = (b.name as string) ?? 'Tool'
        const input = (b.input as Record<string, unknown>) ?? {}
        // 工具由 ywcoder 自己执行，这里只记录 id→{name,file_path} 供 tool_result 回填、
        // 只做展示翻译。
        this.toolInfoByUseId.set(toolUseId, {
          name,
          filePath: typeof input.file_path === 'string' ? input.file_path : undefined,
          // 带 offset/limit 的读只取了文件一段，不能当整文件预览（见 protocol.ts）。
          partialRead: input.offset !== undefined || input.limit !== undefined,
        })
        this.opts.onEvent({ kind: 'action', toolUseId, name, input })
      }
    }
  }

  private handleUserMessage(msg: Record<string, unknown>): void {
    // ywcoder 自己产出的 tool_result 观测输出（见 sessionRunner.ts:483 参考实现），
    // 只读、绝不注入 tool_result 或代执行工具。
    const message = msg.message as Record<string, unknown> | undefined
    const content = message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_result') continue
      const toolUseId = b.tool_use_id as string
      const info = this.toolInfoByUseId.get(toolUseId)
      this.opts.onEvent({
        kind: 'result',
        toolUseId,
        name: info?.name ?? 'unknown',
        content: b.content,
        isError: Boolean(b.is_error),
        filePath: info?.filePath,
        partialRead: info?.partialRead,
      })
    }
  }

  private handleResultMessage(msg: Record<string, unknown>): void {
    // 本轮已收尾（含 interrupt 导致的 error_during_execution）→ 撤销看门狗。
    this.clearWatchdogs()
    const subtype = msg.subtype as string
    const sessionId = (msg.session_id as string) ?? null
    if (subtype === 'success') {
      this.opts.onEvent({
        kind: 'completed',
        result: (msg.result as string) ?? '',
        usage: msg.usage,
        totalCostUsd: (msg.total_cost_usd as number) ?? 0,
        permissionDenials: (msg.permission_denials as unknown[] | undefined) ?? [],
        sessionId: sessionId ?? this.sessionId,
      })
      return
    }
    const errors = (msg.errors as string[] | undefined) ?? [String(subtype)]
    this.opts.onEvent({
      kind: 'error',
      message: errors.join('; '),
      sessionId,
    })
  }

  /** 写一条多轮用户消息到 ywcoder stdin（管控台 task.create.content → §5）。 */
  sendUser(content: string): void {
    this.send({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    })
  }

  /**
   * 管控台 task.respond → 回一条 control_response 给待决的 can_use_tool（§6.2）。
   *
   * 硬约束（ywcoder-integration.md §6.2/§8.3）：
   * - allow 的 `updatedInput` 必填；一律回空对象 `{}` 表示「用原始入参」
   *   （见 PermissionPromptToolResultSchema.ts 的 updatedInput 空对象回退逻辑）。
   * - 绝不回传 `updatedPermissions`：那会被 ywcoder 持久化落盘，让「本次允许」
   *   静默变成「永久允许」。
   */
  respondPermission(requestId: string, decision: PermissionRespondDecision): void {
    const response =
      decision.kind === 'allow'
        ? { behavior: 'allow', updatedInput: {} }
        : decision.kind === 'deny'
          ? { behavior: 'deny', message: decision.message }
          : { behavior: 'deny', message: decision.message, interrupt: true }
    this.log(`权限裁决 request_id=${requestId} → ${decision.kind}`)
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    })
  }

  /** 管控台 task.cancel → 转 interrupt（§6.3），并启动收尾看门狗。 */
  interrupt(): void {
    this.send({
      type: 'control_request',
      request_id: `interrupt-${Date.now()}-${shortId()}`,
      request: { subtype: 'interrupt' },
    })
    this.armInterruptWatchdog()
  }

  /**
   * interrupt 发出后若迟迟收不到 result，强杀子进程解卡（SIGTERM → SIGKILL 升级）。
   * 子进程退出会触发既有收尾：活动任务与排队任务各发 event.error、待决确认按
   * agent_exited 撤销、session 移除；下一条 task.create 以 --resume 恢复上下文。
   */
  private armInterruptWatchdog(): void {
    if (this.interruptTimer) return // 已在监视中，不重复计时
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null
      if (!this.alive) return
      this.log(
        `interrupt 后 ${INTERRUPT_GRACE_MS}ms 仍无 result，强杀子进程解卡（会话已落盘，后续任务将 --resume 恢复）`,
      )
      this.child.kill('SIGTERM')
      this.killTimer = setTimeout(() => {
        this.killTimer = null
        if (!this.alive) return
        this.log('SIGTERM 后仍未退出，升级为 SIGKILL')
        this.child.kill('SIGKILL')
      }, SIGKILL_ESCALATION_MS)
    }, INTERRUPT_GRACE_MS)
  }

  private clearWatchdogs(): void {
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer)
      this.interruptTimer = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
  }

  kill(): void {
    this.clearWatchdogs()
    if (!this.child.killed) this.child.kill('SIGTERM')
  }

  private send(obj: unknown): void {
    if (!this.alive || this.child.stdin.destroyed) {
      // 子进程已退出：丢弃这条写入。对应任务的收尾由 'exit' 事件负责上报，
      // 这里不再抛错，避免拖垮 shim 内其它 session。
      this.log('子进程已退出，丢弃待发送消息')
      return
    }
    this.child.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  private log(msg: string): void {
    process.stderr.write(`[ywcoderSession:${this.sessionId}] ${msg}\n`)
  }
}

function isAlreadyInUseError(err: unknown): boolean {
  return err instanceof Error && /already in use/i.test(err.message)
}
