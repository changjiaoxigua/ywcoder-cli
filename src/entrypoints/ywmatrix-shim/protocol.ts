/**
 * M2 —— 上行协议层：shim↔AgentClient 的本地-agent 协议（JSON-RPC 2.0）编解码，
 * 以及 ywcoder SDKMessage → 管控台 stream.chunk 的字段级映射（§4/§5/§6/§7）。
 *
 * M4 完整档：含 can_use_tool ↔ confirm_required ↔ task.respond 控制面（§6.2）。
 * v3 适配（local-agent-interface-0819-v3.md）：session_id 必填小写 UUID、
 * metadata.workdir/group/command schema、JSON-RPC response 与 task.subtask_result
 * 入站识别、agentInfo 实例身份、两级 capabilities。
 */
import { hostname } from 'node:os'
import { z } from 'zod/v4'
import { validateUuid } from '../../utils/uuid.js'
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
  // v3 C3：AgentClient 下发网关认可的本 Agent 实例 ID（群管理者判定的受信依据）。
  agentInfo: z.object({ agent_id: z.string() }).optional(),
})

const PingParamsSchema = z.object({
  timestamp: z.string().optional(),
})

// --- v3 metadata（§6.1.1 群聊 / §6.1.2 工作目录 / §6.5 结构化命令）-----------------

/** 群成员（v3 §6.1.1）。 */
const GroupMemberSchema = z.object({
  agent_id: z.string(),
  name: z.string(),
})

/** 群聊上下文（v3 §6.1.1）：单 Agent 会话没有该字段。 */
const GroupContextSchema = z.object({
  group_id: z.string(),
  group_name: z.string(),
  manager_agent_id: z.string(),
  members: z.array(GroupMemberSchema),
  mentions: z.array(z.string()),
})

/** 结构化命令（v3 §6.5）：免字符串解析；自由文本参数约定放 args.text。 */
const CommandInvocationSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
})

/**
 * task.create 的 metadata（v3）。已知字段严格校验，未知字段透传（loose），
 * 不阻断后续协议扩展。
 */
const TaskMetadataSchema = z.looseObject({
  // 会话工作目录（v3 §6.1.2）：用户在页面设置、网关逐条注入。校验与绑定语义见 workdirPolicy.ts。
  workdir: z.string().optional(),
  group: GroupContextSchema.optional(),
  command: CommandInvocationSchema.optional(),
})

export type GroupContext = z.infer<typeof GroupContextSchema>
export type CommandInvocation = z.infer<typeof CommandInvocationSchema>
export type TaskMetadata = z.infer<typeof TaskMetadataSchema>

/**
 * v3 契约确认 1：session_id 必填，且必须是小写 UUID（网关 randomUUID 恒小写）。
 * validateUuid 本身不区分大小写，须显式再查小写——macOS 大小写不敏感会碰巧命中，
 * Linux 上同一 id 的大小写变体会被判成两个会话（§9.2 对管控台的三条要求之 2）。
 */
const SessionIdSchema = z
  .string()
  .refine(v => validateUuid(v) !== null && v === v.toLowerCase(), {
    message: 'session_id 必须是小写 UUID',
  })

const TaskCreateParamsSchema = z.object({
  task_id: z.string(),
  // v3：必填，由网关在 session.create 时生成；shim 不再自行 mint（契约确认 1）。
  session_id: SessionIdSchema,
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
  metadata: TaskMetadataSchema.optional(),
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

/**
 * 入站信封（v3 §6.3 双层 JSON-RPC 关联）：除 request/notification 外，
 * 还要能识别 AgentClient 对 shim 出站请求（task.invoke 等）回的的 response
 * （无 method、带 result/error + id）。
 */
const IncomingEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
})

/**
 * task.subtask_result（v3 §6.6）：子任务终态回推。关键关联字段
 * （task_id/parent_task_id/group_id/target_agent_id/status）全部必填——
 * DelegationBridge 依赖它们做防串话校验，缺失必须显式判负而不是静默漏配。
 */
const SubtaskResultParamsSchema = z.looseObject({
  task_id: z.string(),
  parent_task_id: z.string(),
  group_id: z.string(),
  target_agent_id: z.string(),
  status: z.enum(['completed', 'failed', 'timeout', 'cancelled']),
  chunks: z.array(z.looseObject({ type: z.string() })).optional(),
  error: z.unknown().optional(),
})

export type SubtaskResultParams = z.infer<typeof SubtaskResultParamsSchema>

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
  // task.cancel 按 v2 §6.3 是通知类（不带 id），但也兼容带 id 的请求形式。
  | {
      method: 'task.cancel'
      id: string | number | null
      params: TaskCancelParams
    }
  | {
      method: 'task.respond'
      id: string | number | null
      params: TaskRespondParams
    }
  // v3 §6.6：子任务结果回推，交由 DelegationBridge 按 task_id 关联；
  // 未匹配（迟到/重复/未知）由上层幂等忽略。
  | {
      method: 'task.subtask_result'
      id: string | number | null
      params: SubtaskResultParams
    }
  // AgentClient 对 shim 出站请求（task.invoke）的 JSON-RPC response，
  // 交由 DelegationBridge 按 id 关联；未匹配只记日志。
  | {
      method: '$response'
      id: string | number
      result?: unknown
      error?: { code: number; message: string; data?: unknown }
    }
  // 未知 method：请求由上层回 -32601，通知只记 stderr（不产生非法 response）。
  | { method: '$unknown'; id: string | number | null; methodName: string }

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

  // 无 method = JSON-RPC response（对 shim 出站请求的回应，v3 §6.3 双层关联）。
  if (method === undefined) {
    if (id === null) {
      return {
        ok: false,
        id: null,
        code: JsonRpcErrorCode.InvalidRequest,
        message: 'Invalid Request',
      }
    }
    return {
      ok: true,
      message: {
        method: '$response',
        id,
        result: envelope.data.result,
        error: envelope.data.error,
      },
    }
  }

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
      if (!parsed.success) {
        return { ok: false, id, code: JsonRpcErrorCode.InvalidParams, message: 'Invalid params' }
      }
      // id 允许为 null：AgentClient 的「停止」按通知发（v2 §6.3），此时不回 result。
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
    case 'task.subtask_result': {
      // v3 §6.6：子任务结果回推。关键关联字段全部必填（见 schema 注释），
      // 缺字段即判负；合法消息由上层路由给 DelegationBridge，未匹配幂等忽略。
      const parsed = SubtaskResultParamsSchema.safeParse(params)
      if (!parsed.success) {
        return { ok: false, id, code: JsonRpcErrorCode.InvalidParams, message: 'Invalid params' }
      }
      return { ok: true, message: { method, id, params: parsed.data } }
    }
    default:
      // 未知 method 不在这里直接判负：请求（带 id）应由上层回 -32601，
      // 通知（id 为 null）只记 stderr——对通知回 error 自身就是非法 JSON-RPC。
      return { ok: true, message: { method: '$unknown', id, methodName: method } }
  }
}

// ============================================================================
// v3 §6.5 命令解析：结构化 metadata.command 优先，退化解 content 的 '/' 前缀
// ============================================================================

/**
 * 归一化后的命令调用。
 * - `value`：单值主参数（/model 的模型名、/permission 的档位）；
 * - `text`：整段自由文本参数（/compact 的说明、未识别命令原样透传用）。
 */
export interface ParsedCommand {
  name: string
  value?: string
  text?: string
}

/**
 * 结构化通道（v3 §6.5 推荐）：`{name:'model', args:{model:'kimi-k2'}}` → `{name:'model', value:'kimi-k2'}`。
 * 自由文本参数约定走 `args.text`；其余情况取首个字符串参数值作 value。
 */
export function commandFromMetadata(
  command: CommandInvocation | undefined,
): ParsedCommand | null {
  if (!command || !command.name.trim()) return null
  const name = command.name.trim()
  const args = command.args ?? {}
  const text = typeof args.text === 'string' && args.text.trim() ? args.text : undefined
  for (const [k, v] of Object.entries(args)) {
    // args.text 是约定的自由文本槽位，不再充当单值参数。
    if (k !== 'text' && typeof v === 'string' && v.trim()) {
      return { name, value: v.trim(), ...(text ? { text } : {}) }
    }
  }
  return { name, ...(text ? { text } : {}) }
}

/**
 * 退化通道：content 以 '/' 开头时按「/name arg...」解析。
 * value 取首个空白分隔的 token，text 取完整剩余段（供自由文本参数）。
 */
export function commandFromSlashPrefix(content: string): ParsedCommand | null {
  if (!content.startsWith('/')) return null
  const body = content.slice(1).trim()
  if (!body) return null
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body)
  if (!m) return null
  const text = m[2]?.trim() || undefined
  const value = text && !/\s/.test(text) ? text : undefined
  return { name: m[1], ...(value ? { value } : {}), ...(text ? { text } : {}) }
}

/**
 * 双通道入口：优先 metadata.command（结构化，免解析），
 * 不存在时退化解析 content 的 '/' 前缀（v3 §6.5）。
 */
export function parseCommandInput(params: {
  content: string
  metadata?: TaskMetadata
}): ParsedCommand | null {
  return commandFromMetadata(params.metadata?.command) ?? commandFromSlashPrefix(params.content)
}

// ============================================================================
// shim→AgentClient 消息构造
// ============================================================================

/**
 * stream.chunk.content 的内容块（§4.1）。M5 起从「仅 text」扩到 text/image/resource：
 * - `text`：agent 自己的回答/思考，管控台按 markdown 渲染；
 * - `image`：图片，base64 + mimeType，管控台内联 `<img>`；
 * - `resource`：文件（文本类），带 uri + mimeType，管控台按 mimeType 路由渲染。
 */
type TypedContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: ResourceBody }

/** resource 块载体：文本类给 `text`，二进制类（MCP 工具可能给）给 `blob`。 */
interface ResourceBody {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

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

/**
 * 能力条目（v3 §6.4/§6.5）。`type` 取值：
 * - `chat`：对话能力；
 * - `command`：斜杠命令（页面渲染 args[].options 下拉，勿硬编码词表）；
 *   技能也是 command，以 `metadata.kind:"skill"` 区分（v3 §6.5 页面分组约定）。
 * `metadata.current` 是枚举类命令当前值的唯一事实来源（v3 §6.5.1）。
 */
export interface CapabilityEntry {
  type: 'chat' | 'command'
  name: string
  description?: string
  metadata?: {
    current?: string
    args?: Array<{
      name: string
      type: 'enum' | 'text'
      options?: string[]
      required?: boolean
    }>
    kind?: string
  }
}

export function buildRegisterNotification(
  capabilities: CapabilityEntry[],
): OutgoingMessage {
  return {
    jsonrpc: '2.0',
    id: null,
    method: 'lifecycle.register',
    params: {
      agent_id: 'ywcoder',
      name: 'ywcoder',
      version: shimVersion,
      description: '编码助手，可读写文件、执行命令、分析代码',
      capabilities: capabilities as unknown as Record<string, unknown>[],
      platform: {
        os: process.platform,
        arch: process.arch,
        hostname: safeHostname(),
      },
    },
  }
}

/**
 * 能力快照更新（v3 §6.4 + C1 两级作用域）：
 * - 不带 `sessionId`：Agent 全局能力的全量快照（模型/权限的 current、全局命令）；
 * - 带 `sessionId`：指定 session/workdir 的命令和技能全量快照。
 * 全量替换只作用于本次消息对应的层级；同 type/name 由 session 层优先（页面侧合并）。
 */
export function buildCapabilitiesUpdatedNotification(
  capabilities: CapabilityEntry[],
  sessionId?: string,
): OutgoingMessage {
  return {
    jsonrpc: '2.0',
    id: null,
    method: 'lifecycle.capabilities_updated',
    params: {
      ...(sessionId ? { session_id: sessionId } : {}),
      capabilities: capabilities as unknown as Record<string, unknown>[],
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
  // session_id 回显给管控台核对（v3：一律由网关在 session.create 时生成，shim 不 mint）。
  return buildResult(id, { task_id: taskId, session_id: sessionId, status: 'accepted' })
}

export function buildTaskCancelResult(id: string | number, taskId: string): OutgoingMessage {
  return buildResult(id, { task_id: taskId, status: 'cancelled' })
}

/**
 * task.invoke（v3 §6.6）：群管理者委派子任务的出站请求（shim → AgentClient）。
 * 路由字段（parent_task_id/group_id/target_agent_id）只接受受信来源
 * （当前活动任务 + 最新受信群状态），禁止从模型入参带入——调用方
 * （DelegationMcpServer）负责在组装前剥离模型 metadata 中的同名字段。
 */
export function buildTaskInvokeRequest(params: {
  id: string | number
  parent_task_id: string
  group_id: string
  target_agent_id: string
  content: string
  metadata?: Record<string, unknown>
}): OutgoingMessage {
  return {
    jsonrpc: '2.0',
    id: params.id,
    method: 'task.invoke',
    params: {
      parent_task_id: params.parent_task_id,
      group_id: params.group_id,
      target_agent_id: params.target_agent_id,
      type: 'chat',
      content: params.content,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    },
  }
}

interface StreamChunkParams {
  task_id: string
  session_id: string
  type:
    | 'text'
    | 'thinking'
    | 'action'
    | 'result'
    | 'confirm_required'
    | 'confirm_cancelled'
  content?: TypedContent[]
  name?: string
  arguments?: Record<string, unknown>
  is_error?: boolean
  done?: boolean
  /** confirm_* 专用：即 ywcoder can_use_tool 的 request_id（§6.2）。 */
  confirm_id?: string
  title?: string
  level?: ConfirmLevel
  reason?: ConfirmCancelReason
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
 * 危险 Bash 特征：删除/提权/外发网络（前半段），以及覆盖写重定向（后半段，
 * 要求 `>` 前有空白，从而放过 `2>&1` 这类描述符重定向）。
 * 仅用于给网页标危险级别，**不是**安全策略——真正的权限判定在 ywcoder 侧（§8.3）。
 */
const DANGEROUS_BASH_PATTERN =
  /(^|[\s;&|`(])(sudo|rm|rmdir|dd|mkfs\S*|shutdown|reboot|chmod|chown|curl|wget|scp|ssh|nc)\b|\s>>?\s*[^\s&]/

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

/**
 * 确认框被撤销的原因（local-agent-interface-v2.md §8.1.1）：
 * - `task_cancelled`：用户点了停止（管控台发来 task.cancel）
 * - `interrupted`：同轮其它操作触发中止（ywcoder 主动 abort 该权限请求）
 * - `agent_exited`：ywcoder 子进程异常退出，来不及通知，由 shim 兜底补发
 */
export type ConfirmCancelReason = 'task_cancelled' | 'interrupted' | 'agent_exited'

/**
 * 撤销一个已推送到网页的确认框。协议里没有「撤销」的请求/响应往返，
 * 这是通知（`id:null`），网页收到即关框、幂等处理。
 */
export function buildConfirmCancelledChunk(params: {
  task_id: string
  session_id: string
  confirm_id: string
  reason: ConfirmCancelReason
}): OutgoingMessage {
  return buildStreamChunk({
    task_id: params.task_id,
    session_id: params.session_id,
    type: 'confirm_cancelled',
    confirm_id: params.confirm_id,
    reason: params.reason,
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
 * 结构化 `{decision:'cancel'}` = 中止整个任务（已与 AgentClient 确认，等同 §6.3 的
 * `task.cancel`，只是入口在确认框上；前端「×/关闭」按钮约定映射为 `deny`）。
 *
 * 但**自由文本**里的裸「取消 / cancel」仍按 deny 处理：那是 v2 §6.2.1 的旧版兼容
 * 路径，来自尚未遵循上述前端约定的客户端，其「取消」多半就是「别做这个操作」。
 * 宁可少拦一步，也不因一个模糊字符串杀掉整轮任务。
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
 * 两点约定（已与 AgentClient 确认，见 ywcoder-integration.md §6.2）：
 * 1. **结构化 `cancel` = 中止整轮任务**（等同 task.cancel）；前端「×/关闭」按钮发
 *    `deny`，只有明确的「终止任务」按钮才发 `cancel`。**自由文本**里的裸「取消」
 *    仍按 deny 处理（旧版兼容路径，见 AMBIGUOUS_CANCEL_WORDS 的说明）。
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

// ----------------------------------------------------------------------------
// §4.1 文件/图片预览：tool_result 内容块 → typed content（text/image/resource）
// ----------------------------------------------------------------------------

/** 文件读取类工具：其文本结果包成 resource 块，不发裸 text（§4.1 走 B）。 */
const FILE_READ_TOOLS = new Set(['Read'])

/** 扩展名 → mimeType（§4.1）。管控台按 mimeType 路由渲染（md→HTML、csv→表格…）。 */
const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

/**
 * 按扩展名推 mimeType。未知扩展名回落 `text/plain` 而非 `application/octet-stream`：
 * 走到这里的一定是**已读成文本**的内容（源码、无扩展名配置等），标成二进制流会让
 * 管控台连文件卡片里的文本预览都放弃。
 */
function inferMimeType(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (dot <= slash + 1) return 'text/plain' // 无扩展名（含 `.bashrc` 这类纯点开头）
  return MIME_BY_EXT[filePath.slice(dot).toLowerCase()] ?? 'text/plain'
}

function basename(filePath: string): string {
  return filePath.slice(
    Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1,
  )
}

/**
 * 行号前缀：`N\t`（紧凑格式，当前默认）或 `     N→`（宽格式）。
 * 两种格式对应 src/utils/file.ts 的 `addLineNumbers`；此处刻意不 import 那边的
 * `stripLineNumberPrefix`——shim 是独立打包的入口，为一个正则拖进主程序的
 * feature flag 依赖链不划算。格式若变更，两处同步。
 */
const LINE_NUMBER_PREFIX = /^ *\d+[→\t]/

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

/**
 * 剥前置 <system-reminder> 块：读 memdir 记忆文件时 Read 会在正文**前面**插一条
 * 时效提示（`memoryAge.ts` 的 `memoryFreshnessNote`，>1 天才有）。
 */
function stripLeadingSystemReminders(text: string): string {
  let out = text
  while (out.startsWith(REMINDER_OPEN)) {
    const end = out.indexOf(REMINDER_CLOSE)
    if (end === -1) return out
    out = out.slice(end + REMINDER_CLOSE.length).replace(/^\n/, '')
  }
  return out
}

/**
 * 剥尾部 <system-reminder> 块（Read 追加的 CYBER_RISK_MITIGATION_REMINDER 等）。
 *
 * 必须从**末尾倒着认**（lastIndexOf），不能用正则从左往右找起点：正文里若有一个
 * **未闭合**的 `<system-reminder>`（讲 hook/prompt 的文档就会这么写），非贪婪或
 * tempered 匹配都会从正文中间那个开标签一路剥到文件末尾，把正文静默吃掉。
 */
function stripTrailingSystemReminders(text: string): string {
  let out = text
  for (;;) {
    const trimmed = out.replace(/[ \t\n]+$/, '')
    if (!trimmed.endsWith(REMINDER_CLOSE)) return out
    const open = trimmed.lastIndexOf(REMINDER_OPEN)
    if (open === -1) return out
    // 这一对标签之间不能再夹一个闭合标签，否则说明它们并不配对。
    const inner = trimmed.slice(
      open + REMINDER_OPEN.length,
      trimmed.length - REMINDER_CLOSE.length,
    )
    if (inner.includes(REMINDER_CLOSE)) return out
    // 连同 Read 追加这一块时加的换行一起剥掉（多余的换行属于文件内容，保留）。
    out = trimmed.slice(0, open).replace(/\n{1,2}$/, '')
  }
}

/**
 * 是否是「真的文件正文」：Read 输出的文件内容**每行必带行号前缀**（addLineNumbers）。
 * 没有前缀的是桩文本而非文件内容——`FILE_UNCHANGED_STUB`（同一会话重复读未改动的
 * 文件）、`PDF file read: …`、空文件告警等。这些包成 resource 会让管控台把提示语
 * 当文件正文渲染出来，故一律按裸 text 发。
 */
function looksLikeFileBody(text: string): boolean {
  return LINE_NUMBER_PREFIX.test(stripLeadingSystemReminders(text))
}

/**
 * 清洗 ywcoder Read 的 tool_result 文本，还原干净文件内容（§4.1 实现坑）。
 *
 * Read 给出的**不是**原文：正文前后可能各有 <system-reminder> 块，每行带行号前缀。
 * 不清洗就包成 resource 交管控台按 md/csv 渲染会错乱。
 *
 * 顺序有讲究：先剥前置 reminder 与行号，最后剥尾部 reminder。若先剥尾部，
 * 末行（空行）的 `N\t` 前缀会被剩成一个孤零零的行号数字。
 */
function cleanReadOutput(text: string): string {
  const withoutLineNumbers = stripLeadingSystemReminders(text)
    .split('\n')
    .map(line => line.replace(LINE_NUMBER_PREFIX, ''))
    .join('\n')
  return stripTrailingSystemReminders(withoutLineNumbers)
}

/**
 * 单个内容块的内联上限：**2MB**（§4.1，已与管控台定）。
 * 天花板是网关 `messages.content` 的 MEDIUMTEXT（16MB），2MB 远低于此。
 */
const MAX_INLINE_BYTES = 2 * 1024 * 1024
/** 文本截断预览留给标注文案的余量，保证降级后的块仍不超过阈值。 */
const TRUNCATE_RESERVE_BYTES = 1024

/** 一位小数、整数不留 `.0`（对齐 §4.1 的文案样例 `2.4MB 超阈值 2MB`）。 */
function formatSize(bytes: number): string {
  const scaled = (unit: number, suffix: string): string =>
    `${(bytes / unit).toFixed(1).replace(/\.0$/, '')}${suffix}`
  if (bytes >= 1024 * 1024) return scaled(1024 * 1024, 'MB')
  if (bytes >= 1024) return scaled(1024, 'KB')
  return `${bytes}B`
}

/** 块的传输字节数：文本按 utf8，图片/blob 按 base64 字符串本身（即真正上线的负载）。 */
function blockByteSize(block: TypedContent): number {
  switch (block.type) {
    case 'text':
      return Buffer.byteLength(block.text, 'utf8')
    case 'image':
      return Buffer.byteLength(block.data, 'utf8')
    case 'resource':
      return Buffer.byteLength(
        block.resource.text ?? block.resource.blob ?? '',
        'utf8',
      )
  }
}

/** 按字节截断，并抹掉结尾被切碎的多字节字符（解码后的 U+FFFD）。 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '')
}

/**
 * 大小护栏（§4.1）：单块 > 2MB 就**不内联**，降级为一条 text 块提示，
 * 文案带「文件名 + 实际大小 + 阈值」三要素。
 * - 文本类（text/resource.text）：截断保留开头 + 标注，用户仍能看前半截；
 * - 图片/二进制（image/resource.blob）：base64 截半无意义，只发提示。
 *
 * 这是**优雅降级**，不是报错：任务照常，原文件仍在员工终端磁盘上。
 */
function applySizeGuard(block: TypedContent, name: string): TypedContent {
  const size = blockByteSize(block)
  if (size <= MAX_INLINE_BYTES) return block

  const limit = formatSize(MAX_INLINE_BYTES)
  const actual = formatSize(size)
  const body =
    block.type === 'text'
      ? block.text
      : block.type === 'resource'
        ? block.resource.text
        : undefined
  if (body === undefined) {
    const kind = block.type === 'image' ? '图片' : '文件'
    return {
      type: 'text',
      text: `[${kind} ${name} ${actual} 超阈值 ${limit}，未内联预览，原文件在终端]`,
    }
  }
  const kept = truncateUtf8(body, MAX_INLINE_BYTES - TRUNCATE_RESERVE_BYTES)
  return {
    type: 'text',
    text: `${kept}\n\n[文件 ${name} ${actual} 超阈值 ${limit}，已截断预览，原文件在终端]`,
  }
}

/** 从 Anthropic（source.data/media_type）或 MCP（data/mimeType）两种形状取图片。 */
function toImageBlock(b: Record<string, unknown>): TypedContent | null {
  const source = b.source as Record<string, unknown> | undefined
  const data =
    typeof b.data === 'string'
      ? b.data
      : typeof source?.data === 'string'
        ? source.data
        : null
  if (data === null) return null
  const mimeType =
    (typeof b.mimeType === 'string' ? b.mimeType : undefined) ??
    (typeof source?.media_type === 'string' ? source.media_type : undefined) ??
    'image/png'
  return { type: 'image', data, mimeType }
}

/**
 * tool_result.content（字符串或内容块数组）→ 管控台 typed content（§4/§4.1）。
 *
 * - 文件读取类工具的**文本**结果 → `resource` 块（清洗 + 按扩展名推 mimeType），
 *   不发裸 text，否则管控台没有类型上下文只能当 markdown 渲；
 * - 图片 → `image` 块；同一结果里若既有 image 又有 resource，**优先 image**，
 *   避免同一张图 base64 与 uri 重复传；
 * - 其余（agent 回答、非文件工具输出、报错文本）→ 原样 `text` 块。
 */
function normalizeResultContent(
  raw: unknown,
  ctx: {
    toolName: string
    filePath?: string
    isError: boolean
    /** Read 带了 offset/limit，结果只是文件片段。 */
    partialRead?: boolean
  },
): TypedContent[] {
  const blocks: unknown[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : []
  // 只有「完整读取某个文件、且成功」的结果才当文件正文：
  // - is_error 的文本是错误信息，不是文件内容；
  // - 带 offset/limit 的分片读只是片段，包成 resource 会让管控台把 200 行片段
  //   当成整个 app.log 展示（行号还被剥掉了，用户看不出是片段）。
  const asFile =
    !ctx.isError &&
    !ctx.partialRead &&
    ctx.filePath !== undefined &&
    FILE_READ_TOOLS.has(ctx.toolName)

  const out: TypedContent[] = []
  /** 待合并成**一个** resource 的文件正文片段（notebook 的多个 cell 会给多块）。 */
  const fileBodies: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    switch (b.type) {
      case 'text': {
        if (typeof b.text !== 'string') continue
        if (asFile && looksLikeFileBody(b.text)) {
          fileBodies.push(cleanReadOutput(b.text))
          break
        }
        out.push({ type: 'text', text: b.text })
        break
      }
      case 'image': {
        const image = toImageBlock(b)
        if (image) out.push(image)
        break
      }
      case 'resource': {
        const res = b.resource as Record<string, unknown> | undefined
        if (!res || typeof res.uri !== 'string') break
        out.push({
          type: 'resource',
          resource: {
            uri: res.uri,
            ...(typeof res.mimeType === 'string' ? { mimeType: res.mimeType } : {}),
            ...(typeof res.text === 'string' ? { text: res.text } : {}),
            ...(typeof res.blob === 'string' ? { blob: res.blob } : {}),
          },
        })
        break
      }
      default:
        // 未知块类型（如 document）：管控台无渲染分支，丢弃而非乱发。
        break
    }
  }

  // 同一次 Read 的多个正文块合成**一个** resource：否则管控台会收到多张 uri 相同、
  // 各自只有一段内容的卡片（notebook 每个 cell 一块）。放最前，图片输出跟在后面。
  if (fileBodies.length > 0) {
    const filePath = ctx.filePath as string
    out.unshift({
      type: 'resource',
      resource: {
        uri: filePath,
        mimeType: inferMimeType(filePath),
        text: fileBodies.join('\n'),
      },
    })
  }

  // §4.1：同一张图若两条渠道都给了（image 块 + 指向它的 resource 块，MCP 工具可能
  // 如此），只留 image。判据**限定在 image/\* 的 resource** 上——我们自己从文件正文
  // 合成的 resource（text/\*、application/\*）不能被图片挤掉，否则 Read 一个含图输出
  // 的 notebook 会把源码全丢掉，只剩一张图。
  const deduped = out.some(b => b.type === 'image')
    ? out.filter(
        b =>
          b.type !== 'resource' ||
          !String(b.resource.mimeType ?? '').startsWith('image/'),
      )
    : out

  const displayName = ctx.filePath ? basename(ctx.filePath) : ctx.toolName
  return deduped.map(b =>
    applySizeGuard(
      b,
      b.type === 'resource' ? basename(b.resource.uri) : displayName,
    ),
  )
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
          content: normalizeResultContent(event.content, {
            toolName: event.name,
            filePath: event.filePath,
            isError: event.isError,
            partialRead: event.partialRead,
          }),
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
    case 'init':
      // system/init 只用于 shim 内部回填模型 current（P3），不上行给管控台。
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
