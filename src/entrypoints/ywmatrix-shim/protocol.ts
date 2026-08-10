/**
 * M2 —— 上行协议层：shim↔AgentClient 的本地-agent 协议（JSON-RPC 2.0）编解码，
 * 以及 ywcoder SDKMessage → 管控台 stream.chunk 的字段级映射（§4/§5/§6/§7）。
 *
 * M4 完整档：含 can_use_tool ↔ confirm_required ↔ task.respond 控制面（§6.2）。
 */
import { hostname } from 'node:os'
import { z } from 'zod/v4'
import type {
  PermissionRespondDecision,
  YwcoderSessionEvent,
} from './ywcoderSession.js'

// 构建时通过 Bun.build 的 define 注入（见 scripts/build.ts 的 ywmatrix-shim 构建目标）。
declare const SHIM_VERSION: string
// 构建产物里 define 会把 SHIM_VERSION 替换为字面量；--dev 直接跑源码时无注入，
// typeof 守卫回退占位版本（typeof 对未声明标识符安全，且 false 分支不会求值 SHIM_VERSION）。
const shimVersion: string =
  typeof SHIM_VERSION !== 'undefined' ? SHIM_VERSION : '0.0.0-dev'

// ============================================================================
// JSON-RPC 信封与 AgentClient→shim 消息 schema（见 local-agent-interface.md §3/§5/§6）
// ============================================================================

const LifecycleInitializeParamsSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  clientInfo: z
    .object({ name: z.string(), version: z.string() })
    .optional(),
})

const PingParamsSchema = z.object({
  timestamp: z.string().optional(),
})

const TaskCreateParamsSchema = z.object({
  task_id: z.string(),
  // 首条 task.create 可不带 session_id：由 shim 生成 UUID 并回传，管控台后续沿用（§9.2）。
  session_id: z.string().optional(),
  context_id: z.string().optional(),
  type: z.enum(['chat', 'respond']),
  // type='respond' 时（§5）等价于 task.respond：confirm_id 指向待决的 can_use_tool，
  // content 即用户回复文本。
  confirm_id: z.string().optional(),
  content: z.string(),
  history: z.array(z.unknown()).optional(),
  reference_task_ids: z.array(z.string()).optional(),
  requester: z.string().optional(),
  timestamp: z.string().optional(),
  timeout: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const TaskCancelParamsSchema = z.object({
  task_id: z.string(),
  session_id: z.string().optional(),
})

/**
 * task.respond（local-agent-interface.md §6.2）：网页对 confirm_required 的回复。
 * `response` 契约上可以是字符串（「确认」等）或结构化对象，故不限定类型，
 * 由 normalizeConfirmResponse 统一归一（见其注释里的语义映射表）。
 */
const TaskRespondParamsSchema = z.object({
  // confirm_id 是唯一路由键；task_id/session_id 仅作校验与日志，故都可选。
  task_id: z.string().optional(),
  session_id: z.string().optional(),
  confirm_id: z.string(),
  response: z.unknown(),
})

const IncomingEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

export type TaskCreateParams = z.infer<typeof TaskCreateParamsSchema>
export type TaskCancelParams = z.infer<typeof TaskCancelParamsSchema>
export type TaskRespondParams = z.infer<typeof TaskRespondParamsSchema>
export type LifecycleInitializeParams = z.infer<
  typeof LifecycleInitializeParamsSchema
>

export type IncomingMessage =
  | {
      method: 'lifecycle.initialize'
      id: string | number
      params: LifecycleInitializeParams
    }
  | { method: 'lifecycle.initialized'; id: null }
  | { method: 'lifecycle.ping'; id: string | number; params: { timestamp?: string } }
  | { method: 'task.create'; id: string | number; params: TaskCreateParams }
  | { method: 'task.cancel'; id: string | number; params: TaskCancelParams }
  | {
      method: 'task.respond'
      id: string | number | null
      params: TaskRespondParams
    }

export type ParseResult =
  | { ok: true; message: IncomingMessage }
  | {
      ok: false
      id: string | number | null
      code: number
      message: string
    }

/** JSON-RPC 标准错误码（protocol.md §4 / local-agent-interface.md §10）。 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  TaskNotFound: -32000,
  CapabilityNotSupported: -32004,
} as const

/** 解析 AgentClient→shim 的一行 JSONL；未知/非法输入返回结构化错误供上层回 JSON-RPC error。 */
export function parseIncoming(line: string): ParseResult | null {
  if (!line.trim()) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, id: null, code: JsonRpcErrorCode.ParseError, message: 'Parse error' }
  }

  const envelope = IncomingEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    const id =
      raw && typeof raw === 'object' && 'id' in raw
        ? ((raw as { id: unknown }).id as string | number | null)
        : null
    return {
      ok: false,
      id,
      code: JsonRpcErrorCode.InvalidRequest,
      message: 'Invalid Request',
    }
  }
  const { method, params } = envelope.data
  const id = envelope.data.id ?? null

  switch (method) {
    case 'lifecycle.initialize': {
      const parsed = LifecycleInitializeParamsSchema.safeParse(params)
      if (!parsed.success || id === null) {
        return { ok: false, id, code: JsonRpcErrorCode.InvalidParams, message: 'Invalid params' }
      }
      return { ok: true, message: { method, id, params: parsed.data } }
    }
    case 'lifecycle.initialized':
      return { ok: true, message: { method, id: null } }
    case 'lifecycle.ping': {
      const parsed = PingParamsSchema.safeParse(params ?? {})
      if (!parsed.success || id === null) {
        return { ok: false, id, code: JsonRpcErrorCode.InvalidParams, message: 'Invalid params' }
      }
      return { ok: true, message: { method, id, params: parsed.data } }
    }
    case 'task.create': {
      const parsed = TaskCreateParamsSchema.safeParse(params)
      if (!parsed.success || id === null) {
        return { ok: false, id, code: JsonRpcErrorCode.InvalidParams, message: 'Invalid params' }
      }
      return { ok: true, message: { method, id, params: parsed.data } }
    }
    case 'task.cancel': {
      const parsed = TaskCancelParamsSchema.safeParse(params)
      if (!parsed.success || id === null) {
        return { ok: false, id, code: JsonRpcErrorCode.InvalidParams, message: 'Invalid params' }
      }
      return { ok: true, message: { method, id, params: parsed.data } }
    }
    case 'task.respond': {
      const parsed = TaskRespondParamsSchema.safeParse(params)
      if (!parsed.success) {
        return {
          ok: false,
          id,
          code: JsonRpcErrorCode.InvalidParams,
          message: 'Invalid params',
        }
      }
      // id 允许为 null：契约上 task.respond 带 id，但按通知发来也应照常执行。
      return { ok: true, message: { method, id, params: parsed.data } }
    }
    default:
      return {
        ok: false,
        id,
        code: JsonRpcErrorCode.MethodNotFound,
        message: 'Method not found',
      }
  }
}

// ============================================================================
// shim→AgentClient 消息构造
// ============================================================================

type TypedContent = { type: 'text'; text: string }

export interface OutgoingMessage {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

/** 写一条消息到 AgentClient（stdout 只允许协议 JSONL，整行原子写）。 */
export function writeMessage(msg: OutgoingMessage): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

export function buildResult(
  id: string | number,
  result: Record<string, unknown>,
): OutgoingMessage {
  return { jsonrpc: '2.0', id, result }
}

export function buildError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): OutgoingMessage {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

export function buildInitializeResult(id: string | number): OutgoingMessage {
  return buildResult(id, {
    protocolVersion: '1.0.0',
    capabilities: {
      chat: {},
      streaming: {},
      confirmations: {},
      prompts: {},
    },
    serverInfo: { name: 'ywcoder', version: shimVersion },
  })
}

export function buildPingResult(id: string | number, timestamp?: string): OutgoingMessage {
  return buildResult(id, { status: 'ok', timestamp: timestamp ?? new Date().toISOString() })
}

export function buildRegisterNotification(): OutgoingMessage {
  return {
    jsonrpc: '2.0',
    id: null,
    method: 'lifecycle.register',
    params: {
      agent_id: 'ywcoder',
      name: 'ywcoder',
      version: shimVersion,
      description: '编码助手，可读写文件、执行命令、分析代码',
      capabilities: [
        { type: 'chat', name: 'coding', description: '编码助手，可读写文件、执行命令、分析代码' },
      ],
      platform: {
        os: process.platform,
        arch: process.arch,
        hostname: safeHostname(),
      },
    },
  }
}

export type LifecycleStatus = 'idle' | 'busy' | 'error'

export function buildStatusNotification(
  status: LifecycleStatus,
  taskId: string | null,
  sessionId: string | null,
  message?: string,
): OutgoingMessage {
  return {
    jsonrpc: '2.0',
    id: null,
    method: 'lifecycle.status',
    params: {
      status,
      ...(taskId ? { task_id: taskId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(message ? { message } : {}),
    },
  }
}

export function buildTaskCreateAck(
  id: string | number,
  taskId: string,
  sessionId: string,
): OutgoingMessage {
  // 回填 session_id（首条任务时可能是 shim 新生成的 UUID），供管控台采纳并在后续 task 沿用（§9.2）。
  return buildResult(id, { task_id: taskId, session_id: sessionId, status: 'accepted' })
}

export function buildTaskCancelResult(id: string | number, taskId: string): OutgoingMessage {
  return buildResult(id, { task_id: taskId, status: 'cancelled' })
}

interface StreamChunkParams {
  task_id: string
  session_id: string
  type: 'text' | 'thinking' | 'action' | 'result' | 'confirm_required'
  content?: TypedContent[]
  name?: string
  arguments?: Record<string, unknown>
  is_error?: boolean
  done?: boolean
  /** confirm_required 专用：即 ywcoder can_use_tool 的 request_id（§6.2）。 */
  confirm_id?: string
  title?: string
  level?: ConfirmLevel
}

export function buildStreamChunk(params: StreamChunkParams): OutgoingMessage {
  return {
    jsonrpc: '2.0',
    id: null,
    method: 'stream.chunk',
    params: params as unknown as Record<string, unknown>,
  }
}

export function buildTaskCompleted(params: {
  task_id: string
  session_id: string
  summary: string
  metadata?: Record<string, unknown>
}): OutgoingMessage {
  return {
    jsonrpc: '2.0',
    id: null,
    method: 'task.completed',
    params: { ...params, status: 'completed' },
  }
}

export function buildEventError(params: {
  task_id: string | null
  code: string
  message: string
  recoverable: boolean
}): OutgoingMessage {
  return { jsonrpc: '2.0', id: null, method: 'event.error', params }
}

// ============================================================================
// §6.2 控制面：can_use_tool → confirm_required，task.respond → control_response
// ============================================================================

/** 确认危险级别（local-agent-interface.md §8.1）。 */
export type ConfirmLevel = 'info' | 'warning' | 'dangerous'

/** 写盘类工具：allow 即真实改动文件，至少是 warning。 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** 外发网络类工具。 */
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch'])
/**
 * 危险 Bash 特征：删除/覆盖写/提权/外发网络。仅用于给网页标危险级别，
 * **不是**安全策略——真正的权限判定在 ywcoder 侧（§8.3）。
 */
const DANGEROUS_BASH_PATTERN =
  /(^|[\s;&|`(])(sudo|rm|rmdir|dd|mkfs\S*|shutdown|reboot|chmod|chown|curl|wget|scp|ssh|nc)\s/

/** 依据工具与请求上下文推断确认危险级别（§8.1 权限触发规则）。 */
export function inferConfirmLevel(
  toolName: string,
  input: Record<string, unknown>,
  ctx: { blockedPath?: string; decisionReason?: string },
): ConfirmLevel {
  // blocked_path：目标落在授权目录之外，一律按最高级别呈现。
  if (ctx.blockedPath) return 'dangerous'
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return DANGEROUS_BASH_PATTERN.test(` ${command}`) ? 'dangerous' : 'warning'
  }
  if (WRITE_TOOLS.has(toolName)) return 'warning'
  if (NETWORK_TOOLS.has(toolName)) return 'warning'
  return 'info'
}

const SUMMARY_MAX = 1000

function truncate(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…（已截断）` : text
}

/**
 * 工具入参 → 网页确认正文。§8.3 要求「如实呈现命令与危险级别」，因此
 * 命令/路径原样给出，只做长度截断。
 */
export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const str = (key: string): string =>
    typeof input[key] === 'string' ? (input[key] as string) : ''
  switch (toolName) {
    case 'Bash': {
      const description = str('description')
      const command = str('command')
      return truncate(description ? `${command}\n\n用途：${description}` : command)
    }
    case 'Write':
      return truncate(`写入文件：${str('file_path')}\n\n${str('content')}`)
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return truncate(`编辑文件：${str('file_path')}`)
    default:
      return truncate(JSON.stringify(input))
  }
}

export function buildConfirmRequiredChunk(params: {
  task_id: string
  session_id: string
  confirm_id: string
  title: string
  level: ConfirmLevel
  text: string
}): OutgoingMessage {
  // 刻意不带 timeout 字段：confirm 不设 shim 短超时（§8.3 硬约束 2），人在回路
  // 就该等人；永久挂起由网关 task-timeout + task.cancel 兜底。
  return buildStreamChunk({
    task_id: params.task_id,
    session_id: params.session_id,
    type: 'confirm_required',
    confirm_id: params.confirm_id,
    title: params.title,
    level: params.level,
    content: [{ type: 'text', text: params.text }],
  })
}

/** 结构化回复里表示裁决的字段名（任取其一）。 */
const DECISION_KEYS = ['decision', 'action', 'behavior', 'result', 'choice']
const MESSAGE_KEYS = ['message', 'reason', 'text', 'comment']

const ALLOW_WORDS = new Set([
  '确认', '确定', '允许', '同意', '批准', '通过', '是', '好', '继续',
  'yes', 'y', 'ok', 'okay', 'allow', 'approve', 'approved', 'confirm',
  'confirmed', 'accept', 'accepted', 'true',
])
const DENY_WORDS = new Set([
  '拒绝', '不允许', '不同意', '否', '否决', '跳过', '算了',
  'no', 'n', 'deny', 'denied', 'reject', 'rejected', 'decline', 'skip',
  'false',
])
const ABORT_WORDS = new Set([
  '取消任务', '中止', '中止任务', '中断', '终止', '终止任务', '停止', '停止任务',
  'abort', 'abort_task', 'cancel_task', 'interrupt', 'stop', 'terminate',
])
/**
 * 裸「取消 / cancel」只在**自由文本**里有歧义（网页确认框的「取消」按钮通常只是
 * 「别做这个操作」），故按 deny 处理；结构化 `{decision:'cancel'}` 是明确的裁决值，
 * 按中止整个任务处理。
 */
const AMBIGUOUS_CANCEL_WORDS = new Set(['取消', 'cancel'])

/**
 * task.respond.response → 权限裁决（§6.2 三种语义）。
 *
 * | 回复（不分大小写/去空白） | 裁决 | 发给 ywcoder |
 * |---|---|---|
 * | 确认/允许/同意/yes/ok/allow… | allow | `{behavior:'allow',updatedInput:{}}` |
 * | 拒绝/否/取消/no/deny/skip… | deny | `{behavior:'deny',message}`（模型继续） |
 * | 取消任务/中止/停止/abort/interrupt… | cancel | `{behavior:'deny',message,interrupt:true}`（本轮中止） |
 * | 结构化 `{decision:'allow'\|'deny'\|'cancel',message?}` | 同上 | 同上 |
 * | 其它任意文本 | deny（原文作为拒绝理由） | `{behavior:'deny',message:<原文>}` |
 *
 * 两点约定（⚠️ 待与 AgentClient 最终确认，见 ywcoder-integration.md §6.2）：
 * 1. **裸「取消」= 只拒绝本次工具**，不中止任务——网页确认框上的「取消」按钮通常
 *    是「别做这个操作」；要中止整个任务请用「取消任务」或 task.cancel。
 * 2. **无法识别的回复一律按 deny 处理**（绝不因歧义放行），原文回传给模型当理由。
 */
export function normalizeConfirmResponse(
  response: unknown,
): PermissionRespondDecision {
  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>
    const rawDecision = DECISION_KEYS.map(k => obj[k]).find(
      v => typeof v === 'string',
    ) as string | undefined
    const message =
      (MESSAGE_KEYS.map(k => obj[k]).find(v => typeof v === 'string') as
        | string
        | undefined) ?? '用户在管控台拒绝'
    if (rawDecision !== undefined) {
      const word = rawDecision.trim().toLowerCase()
      // 结构化裁决值无歧义：cancel 即中止整个任务。
      if (AMBIGUOUS_CANCEL_WORDS.has(word)) return { kind: 'cancel', message }
      return fromWord(word, message)
    }
    return { kind: 'deny', message: truncate(JSON.stringify(obj)) }
  }
  const text = String(response ?? '').trim()
  return fromWord(text, text.length > 0 ? text : '用户在管控台拒绝')
}

function fromWord(raw: string, message: string): PermissionRespondDecision {
  const word = raw.trim().toLowerCase()
  if (ABORT_WORDS.has(word)) return { kind: 'cancel', message }
  if (ALLOW_WORDS.has(word)) return { kind: 'allow' }
  if (DENY_WORDS.has(word) || AMBIGUOUS_CANCEL_WORDS.has(word)) {
    return { kind: 'deny', message }
  }
  // 未知回复：安全默认为拒绝，原文作为拒绝理由回传给模型。
  return { kind: 'deny', message: truncate(message) }
}

// ============================================================================
// §4 映射：ywcoder 事件 → 管控台 stream.chunk / task.completed / event.error
// ============================================================================

/** tool_result.content 可能是字符串或 typed content 数组；MVP 只取文本块（§4 note）。 */
function normalizeResultContent(raw: unknown): TypedContent[] {
  if (typeof raw === 'string') return [{ type: 'text', text: raw }]
  if (Array.isArray(raw)) {
    const out: TypedContent[] = []
    for (const block of raw) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        out.push({ type: 'text', text: (block as Record<string, unknown>).text as string })
      }
    }
    return out
  }
  return []
}

/** 把一个规范化的 ywcoder 事件翻译为 0..N 条要发给 AgentClient 的消息。 */
export function translateYwcoderEvent(
  event: YwcoderSessionEvent,
  ctx: { taskId: string; sessionId: string },
): OutgoingMessage[] {
  switch (event.kind) {
    case 'text':
      return [
        buildStreamChunk({
          task_id: ctx.taskId,
          session_id: ctx.sessionId,
          type: 'text',
          content: [{ type: 'text', text: event.text }],
          done: false,
        }),
      ]
    case 'thinking':
      return [
        buildStreamChunk({
          task_id: ctx.taskId,
          session_id: ctx.sessionId,
          type: 'thinking',
          content: [{ type: 'text', text: event.text }],
        }),
      ]
    case 'action':
      return [
        buildStreamChunk({
          task_id: ctx.taskId,
          session_id: ctx.sessionId,
          type: 'action',
          name: event.name,
          arguments: event.input,
        }),
      ]
    case 'result':
      return [
        buildStreamChunk({
          task_id: ctx.taskId,
          session_id: ctx.sessionId,
          type: 'result',
          name: event.name,
          content: normalizeResultContent(event.content),
          is_error: event.isError,
        }),
      ]
    case 'completed':
      return [
        buildStreamChunk({
          task_id: ctx.taskId,
          session_id: ctx.sessionId,
          type: 'text',
          content: [],
          done: true,
        }),
        buildTaskCompleted({
          task_id: ctx.taskId,
          session_id: ctx.sessionId,
          summary: event.result,
          metadata: {
            usage: event.usage,
            total_cost_usd: event.totalCostUsd,
            permission_denials: event.permissionDenials,
          },
        }),
      ]
    case 'error':
      return [
        buildEventError({
          task_id: ctx.taskId,
          code: 'LOCAL_AGENT_ERROR',
          message: event.message,
          recoverable: false,
        }),
      ]
    case 'exit':
      return [
        buildEventError({
          task_id: ctx.taskId,
          code: 'LOCAL_AGENT_ERROR',
          message: `ywcoder 子进程异常退出 code=${event.code} signal=${event.signal}`,
          recoverable: false,
        }),
      ]
    case 'permission_required':
      return [
        buildConfirmRequiredChunk({
          task_id: ctx.taskId,
          session_id: ctx.sessionId,
          // confirm_id 直接用 ywcoder 的 request_id，回复时原样用于 control_response。
          confirm_id: event.requestId,
          title: event.title ?? `执行 ${event.toolName}`,
          level: inferConfirmLevel(event.toolName, event.input, {
            blockedPath: event.blockedPath,
            decisionReason: event.decisionReason,
          }),
          text: buildConfirmText(event),
        }),
      ]
    case 'permission_cancelled':
      // ywcoder 侧已撤销该权限请求；协议无对应消息，只在 shim 内清理映射。
      return []
  }
}

/** 确认正文：工具入参摘要 + ywcoder 给出的说明/拦截路径/判定原因。 */
function buildConfirmText(
  event: Extract<YwcoderSessionEvent, { kind: 'permission_required' }>,
): string {
  const parts = [summarizeToolInput(event.toolName, event.input)]
  if (event.description) parts.push(`说明：${event.description}`)
  if (event.blockedPath) parts.push(`受限路径：${event.blockedPath}`)
  if (event.decisionReason) parts.push(`判定原因：${event.decisionReason}`)
  return parts.join('\n\n')
}

function safeHostname(): string {
  try {
    return hostname()
  } catch {
    return 'unknown'
  }
}
