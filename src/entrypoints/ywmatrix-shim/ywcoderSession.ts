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
    }
  | {
      kind: 'completed'
      result: string
      usage: unknown
      totalCostUsd: number
      sessionId: string
    }
  | { kind: 'error'; message: string; sessionId: string | null }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }

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
  private toolNameByUseId = new Map<string, string>()
  private initRequestId!: string
  private readyResolve!: () => void
  private readyReject!: (err: Error) => void
  private readySettled = false
  private recentStderr: string[] = []

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
        // 工具由 ywcoder 自己执行，这里只记录 id→name 供 tool_result 回填、只做展示翻译。
        this.toolNameByUseId.set(toolUseId, name)
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
      const name = this.toolNameByUseId.get(toolUseId) ?? 'unknown'
      this.opts.onEvent({
        kind: 'result',
        toolUseId,
        name,
        content: b.content,
        isError: Boolean(b.is_error),
      })
    }
  }

  private handleResultMessage(msg: Record<string, unknown>): void {
    const subtype = msg.subtype as string
    const sessionId = (msg.session_id as string) ?? null
    if (subtype === 'success') {
      this.opts.onEvent({
        kind: 'completed',
        result: (msg.result as string) ?? '',
        usage: msg.usage,
        totalCostUsd: (msg.total_cost_usd as number) ?? 0,
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

  /** 管控台 task.cancel → 转 interrupt（§6.3）。 */
  interrupt(): void {
    this.send({
      type: 'control_request',
      request_id: `interrupt-${Date.now()}-${shortId()}`,
      request: { subtype: 'interrupt' },
    })
  }

  kill(): void {
    if (!this.child.killed) this.child.kill('SIGTERM')
  }

  private send(obj: unknown): void {
    this.child.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  private log(msg: string): void {
    process.stderr.write(`[ywcoderSession:${this.sessionId}] ${msg}\n`)
  }
}

function isAlreadyInUseError(err: unknown): boolean {
  return err instanceof Error && /already in use/i.test(err.message)
}
