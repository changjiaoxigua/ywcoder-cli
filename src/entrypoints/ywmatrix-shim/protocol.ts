/**
 * M2 —— 上行协议层：shim↔AgentClient 的本地-agent 协议（JSON-RPC 2.0）编解码，
 * 以及 ywcoder SDKMessage → 管控台 stream.chunk 的字段级映射（§4/§5/§6/§7）。
 *
 * 简单档 MVP：不实现 can_use_tool ↔ confirm_required 控制面（M4 才做）。
 */
import { hostname } from 'node:os'
import { z } from 'zod/v4'
import type { YwcoderSessionEvent } from './ywcoderSession.js'

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

const IncomingEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

export type TaskCreateParams = z.infer<typeof TaskCreateParamsSchema>
export type TaskCancelParams = z.infer<typeof TaskCancelParamsSchema>
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
  | { method: 'task.respond'; id: string | number | null; params: unknown }

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
    case 'task.respond':
      // 简单档不实现控制面，收到也先透传给上层按「不支持」处理。
      return { ok: true, message: { method, id, params } }
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
  type: 'text' | 'thinking' | 'action' | 'result'
  content?: TypedContent[]
  name?: string
  arguments?: Record<string, unknown>
  is_error?: boolean
  done?: boolean
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
          metadata: { usage: event.usage, total_cost_usd: event.totalCostUsd },
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
  }
}

function safeHostname(): string {
  try {
    return hostname()
  } catch {
    return 'unknown'
  }
}
