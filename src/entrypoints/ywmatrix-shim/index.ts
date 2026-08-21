/**
 * M3 —— 组装：拼接上下行（ywcoderSession.ts + protocol.ts），按 session_id
 * 路由/管理多个 ywcoder 子进程，stdout 只写协议 JSONL（日志一律走 stderr）。
 *
 * v3 适配（local-agent-interface-0819-v3.md）：
 * - P1 协议基线：session_id 必填小写 UUID、metadata schema、JSON-RPC response 识别；
 * - P2 会话级 workdir：首任务绑定、realpath 规范化、分桶按会话目录推导；
 * - P3 命令与全局设置：/model、/permission 为 Agent 实例全局设置（契约确认 6），
 *   本地执行 + capabilities_updated 两级快照（C1/C7）；
 * - P4 群聊上下文：身份识别（C3）+ 受控注入（契约确认 9），不实现 task.invoke。
 * - P5 管理者编排：群会话内嵌 SDK MCP server（ywmatrix.delegate），经
 *   DelegationBridge 桥接 task.invoke/task.subtask_result（C6 级联取消契约）。
 *
 * 启动方式（见 shim-build-plan.md §2）：
 *   ywcoder-ywmatrix --workdir <dir> --permission-mode <default|acceptEdits|bypassPermissions|...>
 *                    [--allow-bypass-permissions]
 *
 * 权限档（§8.2）：子进程无条件装配 --permission-prompt-tool stdio（P3 方案 A），
 * default 档下需确认的工具经 can_use_tool ↔ confirm_required ↔ task.respond 到网页确认；
 * acceptEdits/bypassPermissions 在权限判定层短路，不触发网页确认。
 * bypassPermissions 只有在启动级显式允许（--allow-bypass-permissions 或以该档启动）
 * 时才出现在 /permission 的 options 里（契约确认 3）。
 */
import { createInterface } from 'node:readline'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
} from '../../types/permissions.js'
import { YwcoderSession, type YwcoderSessionEvent, type YwcoderSessionOptions } from './ywcoderSession.js'
import { DelegationBridge } from './delegationBridge.js'
import {
  DelegationMcpServer,
  YWMATRIX_MCP_SERVER_NAME,
} from './delegationMcpServer.js'
import { validateWorkdir } from './workdirPolicy.js'
import { buildGroupSystemPrompt, buildGroupTaskPrefix } from './groupContext.js'
import {
  buildGlobalCapabilities,
  buildSessionCapabilities,
  capabilitiesFingerprint,
  isSessionCommand,
} from './capabilities.js'
import {
  JsonRpcErrorCode,
  buildCapabilitiesUpdatedNotification,
  buildConfirmCancelledChunk,
  buildError,
  buildEventError,
  buildInitializeResult,
  buildPingResult,
  buildRegisterNotification,
  buildResult,
  buildStatusNotification,
  buildStreamChunk,
  buildTaskCancelResult,
  buildTaskCompleted,
  buildTaskCreateAck,
  normalizeConfirmResponse,
  parseCommandInput,
  parseIncoming,
  translateYwcoderEvent,
  writeMessage,
  type CapabilityEntry,
  type ConfirmCancelReason,
  type GroupContext,
  type OutgoingMessage,
  type ParsedCommand,
  type TaskCancelParams,
  type TaskCreateParams,
  type TaskMetadata,
  type TaskRespondParams,
} from './protocol.js'

function log(msg: string): void {
  process.stderr.write(`[ywmatrix-shim] ${msg}\n`)
}

export interface CliArgs {
  workdir: string
  permissionMode: ExternalPermissionMode
  /**
   * 契约确认 3：bypassPermissions 必须启动级显式允许才会被上报和接受。
   * 以 bypassPermissions 启动本身即视为显式允许。
   */
  allowBypassPermissions: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let workdir: string | undefined
  let permissionMode: string | undefined
  let allowBypassPermissions = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workdir') workdir = argv[++i]
    else if (argv[i] === '--permission-mode') permissionMode = argv[++i]
    else if (argv[i] === '--allow-bypass-permissions') allowBypassPermissions = true
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
  // 以 bypassPermissions 启动 = 启动级显式允许（契约确认 3）。
  if (permissionMode === 'bypassPermissions') allowBypassPermissions = true
  const validated = validateWorkdir(workdir)
  if (!validated.ok) {
    process.stderr.write(`非法 --workdir: ${validated.reason}\n`)
    process.exit(1)
  }
  if (permissionMode === 'default') {
    log('--permission-mode default：需确认的工具走网页确认（can_use_tool 控制面）')
  } else {
    // P3 起子进程无条件装配 stdio prompt-tool，运行中可经 /permission 切入 default。
    log(
      `--permission-mode ${permissionMode}：该档在权限判定层短路，不弹网页确认`,
    )
  }
  return {
    workdir: validated.workdir,
    permissionMode: permissionMode as ExternalPermissionMode,
    allowBypassPermissions,
  }
}

/** 队列中的任务：content 之外携带 metadata（workdir 已于入队前校验/绑定）。 */
interface QueuedTask {
  taskId: string
  content: string
  metadata?: TaskMetadata
}

interface SessionEntry {
  session: YwcoderSession | null
  queue: QueuedTask[]
  activeTaskId: string | null
  /**
   * 活动任务是否已把 prompt 发给 ywcoder（审查 R3 取消竞态）：
   * true → cancel 需 interrupt 子进程；false（锁后等待/设置命令在途）→ 子进程
   * 无事可中断，由锁回调/命令收尾时看到取消标记后以取消终态统一收尾。
   */
  activeDispatched: boolean
  /** 首任务绑定的会话工作目录（v3 §6.1.2 + 契约确认 5：之后不可变）。 */
  workdir: string
  /** 该 session 子进程当前实际应用的模型/权限（契约确认 6：下一任务前与全局同步）。 */
  appliedModel: string | undefined
  appliedPermissionMode: ExternalPermissionMode
  /** 会话级能力快照指纹（推送前去重）。 */
  capsFingerprint: string
  /** P4：首任务携带的群上下文（稳定身份随 spawn 的 appendSystemPrompt 注入）。 */
  group?: GroupContext
  /** P5：最新受信群状态（最近一次 task.create 的 metadata.group，回落首任务绑定值）。 */
  latestGroup?: GroupContext
  /** P5：群会话内嵌的委派 MCP server（仅首任务携带群上下文时创建）。 */
  mcpServer?: DelegationMcpServer
}

/**
 * 全局设置（模型/权限）的一次性快照（审查 R2-2/R2-3）：
 * 临界区入口或 spawn 启动点取一次，之后的 await 全程只瞄准/记账这组值——
 * await 后重新读全局值，会把并发切换刚提交的新值错记/错配到本流程上。
 */
interface SettingsSnapshot {
  model: string | undefined
  permissionMode: ExternalPermissionMode
}

/** 待网页裁决的权限请求（confirm_id 即 ywcoder can_use_tool 的 request_id）。 */
interface PendingConfirm {
  sessionId: string
  taskId: string
}

/**
 * 可注入依赖（审查 R2-5：控制流测试用可控 Promise 的 mock session 驱动竞态场景）。
 * 默认即生产实现；测试替换 spawn/out，无需真起 ywcoder 子进程、无需经 stdio。
 */
export interface ShimDeps {
  spawn?: (opts: YwcoderSessionOptions) => Promise<YwcoderSession>
  out?: (msg: OutgoingMessage) => void
}

export class Shim {
  private sessions = new Map<string, SessionEntry>()
  private taskToSession = new Map<string, string>()
  // confirm_id → 所属 session/task，供 task.respond 路由回对应 ywcoder 子进程（§6.2）。
  // 刻意不带超时定时器：confirm 不设 shim 短超时（§8.3 硬约束 2）。
  private pendingConfirms = new Map<string, PendingConfirm>()
  private shuttingDown = false
  /** C3：lifecycle.initialize 下发的、网关认可的本 Agent 实例 ID（P4 群管理者判定用）。 */
  private agentId: string | null = null
  /** 契约确认 6：模型与权限是 Agent 实例全局设置，不按 session 隔离。 */
  private globalPermissionMode: ExternalPermissionMode
  private globalModel: string | undefined
  /** 首个就绪子进程 initialize 返回的模型 options（C7：之前不声明 /model）。 */
  private modelOptions: string[] | undefined
  /** 全局能力快照指纹（推送前去重）。 */
  private globalCapsFingerprint = ''
  /** 全局设置切换互斥锁（审查问题 2）：/model、/permission 的本地执行跨 session 串行。 */
  private settingsLock: Promise<void> = Promise.resolve()
  /**
   * 已取消但锁回调可能尚未执行/执行中的活动任务（审查 R3 取消竞态）：
   * 锁后的同步/设置回调与在途的设置命令，收尾前必须查这个集合——
   * cancel 只 interrupt 空闲子进程挡不住锁释放后的回调继续跑。
   */
  private cancelledTasks = new Set<string>()
  private readonly spawnFn: (opts: YwcoderSessionOptions) => Promise<YwcoderSession>
  private readonly out: (msg: OutgoingMessage) => void
  /** P5：管理者编排委派桥（task.invoke/subtask_result 两阶段关联与统一清理）。 */
  private readonly delegationBridge: DelegationBridge

  constructor(
    private args: CliArgs,
    deps: ShimDeps = {},
  ) {
    this.globalPermissionMode = args.permissionMode
    this.spawnFn = deps.spawn ?? (opts => YwcoderSession.spawn(opts))
    this.out = deps.out ?? writeMessage
    this.delegationBridge = new DelegationBridge({
      out: msg => this.out(msg),
      log,
    })
  }

  /** 测试探针：等待设置锁链上已排队的切换/同步全部落地。 */
  drain(): Promise<void> {
    return this.settingsLock
  }

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

  /** 处理一行入站 JSONL。public：测试不经 stdin，直接逐行喂入驱动状态机。 */
  handleLine(line: string): void {
    const result = parseIncoming(line)
    if (result === null) return
    if (!result.ok) {
      this.out(buildError(result.id, result.code, result.message))
      return
    }
    const msg = result.message
    switch (msg.method) {
      case 'lifecycle.initialize':
        // C3：登记网关认可的本 Agent 实例 ID（P4 群管理者判定的受信依据）。
        this.agentId = msg.params.agentInfo?.agent_id ?? null
        this.out(buildInitializeResult(msg.id))
        return
      case 'lifecycle.initialized': {
        // 协商完成，随即注册（local-agent-interface.md §5.2）。
        // C7：register 只报稳定全局能力；模型列表待首个子进程 initialize 后补报。
        const caps = this.currentGlobalCapabilities()
        this.globalCapsFingerprint = capabilitiesFingerprint(caps)
        this.out(buildRegisterNotification(caps))
        return
      }
      case 'lifecycle.ping':
        this.out(buildPingResult(msg.id, msg.params.timestamp))
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
      case 'task.subtask_result': {
        // P5：子任务结果回推 → DelegationBridge 按 task_id 关联（含防串话校验）；
        // 未命中（迟到/重复/未知/字段不符）幂等忽略，只记 stderr。
        const handled = this.delegationBridge.handleSubtaskResult(msg.params)
        if (!handled) {
          log(`忽略未匹配的 task.subtask_result: task_id=${msg.params.task_id} parent=${msg.params.parent_task_id}`)
        }
        if (msg.id !== null) {
          this.out(buildResult(msg.id, { status: handled ? 'received' : 'ignored' }))
        }
        return
      }
      case '$response':
        // P5：task.invoke 的应答 → DelegationBridge 按外层 request id 关联。
        if (!this.delegationBridge.handleResponse(msg.id, msg.result, msg.error)) {
          log(`忽略未匹配的 JSON-RPC response: id=${msg.id}`)
        }
        return
      case '$unknown':
        // 未知请求回 -32601；未知通知只记 stderr（对通知回 error 自身即非法）。
        if (msg.id !== null) {
          this.out(buildError(msg.id, JsonRpcErrorCode.MethodNotFound, 'Method not found'))
        } else {
          log(`忽略未知通知: method=${msg.methodName}`)
        }
        return
    }
  }

  /** 当前全局能力快照（模型/权限为 Agent 实例全局设置，契约确认 6）。 */
  private currentGlobalCapabilities(): CapabilityEntry[] {
    return buildGlobalCapabilities({
      permissionMode: this.globalPermissionMode,
      allowBypassPermissions: this.args.allowBypassPermissions,
      modelOptions: this.modelOptions,
      currentModel: this.globalModel,
    })
  }

  /** 推送全局能力快照（指纹去重；current 变化即全量替换，C1）。 */
  private pushGlobalCapabilities(): void {
    const caps = this.currentGlobalCapabilities()
    const fp = capabilitiesFingerprint(caps)
    if (fp === this.globalCapsFingerprint) return
    this.globalCapsFingerprint = fp
    this.out(buildCapabilitiesUpdatedNotification(caps))
  }

  /**
   * 推送会话级能力快照（契约确认 7/C7：该 workdir 可 headless 执行的命令/技能，
   * 子进程 initialize 后上报；指纹去重）。
   */
  private pushSessionCapabilities(sessionId: string, entry: SessionEntry): void {
    if (!entry.session) return
    // initialize 返回的 commands 上游已按 headless 可执行性过滤，全量上报。
    const caps = buildSessionCapabilities(entry.session.commands)
    const fp = capabilitiesFingerprint(caps)
    if (fp === entry.capsFingerprint) return
    entry.capsFingerprint = fp
    this.out(buildCapabilitiesUpdatedNotification(caps, sessionId))
  }

  private handleTaskCreate(id: string | number, params: TaskCreateParams): void {
    if (params.type === 'respond') {
      // §5：type=respond 等价于 task.respond，走控制面而非新起一轮对话。
      if (!params.confirm_id) {
        this.out(
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

    // v3 契约确认 1：session_id 必填且为小写 UUID（schema 已强制），shim 不 mint。
    const sessionId = params.session_id

    // v3 §6.1.2 + 契约确认 5：会话级 workdir。metadata.workdir 优先于实例默认
    // --workdir；校验失败/与首任务绑定不一致 → -32602，不静默切换上下文。
    const workdir = this.resolveTaskWorkdir(sessionId, params.metadata)
    if (!workdir.ok) {
      this.out(buildError(id, JsonRpcErrorCode.InvalidParams, workdir.reason))
      return
    }

    // P5 审查 P1-1：群绑定一致性（ack 之前校验）。group_id 是会话稳定信息，
    // 无条件覆盖 latestGroup 会让在途任务组合出「parent 在 g1、group_id 用 g2」
    // 的跨群委派（成员/管理者权限也错取自 g2）。
    const groupCheck = this.checkGroupBinding(sessionId, params.metadata)
    if (!groupCheck.ok) {
      this.out(buildError(id, JsonRpcErrorCode.InvalidParams, groupCheck.reason))
      return
    }

    // 立即确认收到（local-agent-interface.md §6.1）；结果随后经 stream.chunk 流式返回。
    this.out(buildTaskCreateAck(id, params.task_id, sessionId))
    this.taskToSession.set(params.task_id, sessionId)

    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = {
        session: null,
        queue: [],
        activeTaskId: null,
        activeDispatched: false,
        workdir: workdir.workdir,
        appliedModel: this.globalModel,
        appliedPermissionMode: this.globalPermissionMode,
        capsFingerprint: '',
        // P4：首任务携带的群上下文绑定到会话（稳定身份随 spawn 注入系统提示）。
        ...(params.metadata?.group
          ? { group: params.metadata.group, latestGroup: params.metadata.group }
          : {}),
      }
      this.sessions.set(sessionId, entry)
      this.spawnSession(sessionId, entry)
    }
    // P5：跟踪最新受信群状态（委派授权判定以其为准）；manager/成员变化时
    // 由 MCP server 发 tools/list_changed 刷新模型的工具视野（不依赖子进程重启）。
    if (params.metadata?.group) {
      entry.latestGroup = params.metadata.group
      entry.mcpServer?.notifyGroupStateChanged()
    }
    entry.queue.push({ taskId: params.task_id, content: params.content, metadata: params.metadata })
    this.pump(sessionId)
  }

  /**
   * 解析本任务的会话 workdir：首任务绑定（metadata.workdir > --workdir，
   * 均 realpath 规范化）；会话已绑定后必须一致，否则拒绝（契约确认 5/C4）。
   */
  private resolveTaskWorkdir(
    sessionId: string,
    metadata: TaskMetadata | undefined,
  ): { ok: true; workdir: string } | { ok: false; reason: string } {
    const raw = metadata?.workdir ?? this.args.workdir
    const validated = validateWorkdir(raw)
    if (!validated.ok) return { ok: false, reason: validated.reason }
    const entry = this.sessions.get(sessionId)
    if (entry && entry.workdir !== validated.workdir) {
      return {
        ok: false,
        reason: `会话 ${sessionId} 已绑定 workdir=${entry.workdir}，不可变更为 ${validated.workdir}（请新建会话）`,
      }
    }
    return validated
  }

  /**
   * P5 审查 P1-1：群绑定一致性校验（首任务绑定，之后不可变）。
   * - 单聊会话后续任务不得携带 metadata.group（单聊→群聊拒绝）；
   * - 群聊会话后续任务必须携带 metadata.group（群聊→单聊拒绝）；
   * - group_id 必须与首任务一致（跨群拒绝）；
   * - 同 group_id 下允许更新 manager_agent_id/members/group_name/mentions
   *   （latestGroup 跟踪，授权判定以最新受信群状态为准）。
   */
  private checkGroupBinding(
    sessionId: string,
    metadata: TaskMetadata | undefined,
  ): { ok: true } | { ok: false; reason: string } {
    const entry = this.sessions.get(sessionId)
    if (!entry) return { ok: true }
    if (!entry.group && metadata?.group) {
      return {
        ok: false,
        reason: `会话 ${sessionId} 是单聊会话，不可变更为群聊会话（请新建会话）`,
      }
    }
    if (entry.group && !metadata?.group) {
      return {
        ok: false,
        reason: `会话 ${sessionId} 已绑定群 ${entry.group.group_id}，后续任务必须携带 metadata.group`,
      }
    }
    if (entry.group && metadata?.group && metadata.group.group_id !== entry.group.group_id) {
      return {
        ok: false,
        reason: `会话 ${sessionId} 已绑定群 ${entry.group.group_id}，不可变更为 ${metadata.group.group_id}（请新建会话）`,
      }
    }
    return { ok: true }
  }

  private spawnSession(sessionId: string, entry: SessionEntry): void {
    // 启动参数快照（审查 R2-3）：spawn 是异步的，完成回调执行时全局值可能已被
    // 设置命令提交新值；spawn 入参与 applied* 记账都必须用启动时实际传入的这组值。
    const launch: SettingsSnapshot = {
      model: this.globalModel,
      permissionMode: this.globalPermissionMode,
    }
    // P5：群会话内嵌委派 MCP server（计划 §7.6）。授权所需的群状态/活动任务
    // 经 getState 现场读取（永远是最新受信值）；server→子进程的通知在子进程
    // 就绪前静默丢弃（MCP Client 连接成功后会自行 tools/list）。
    let mcpServer: DelegationMcpServer | undefined
    if (entry.group) {
      const boundGroup = entry.group
      mcpServer = new DelegationMcpServer({
        bridge: this.delegationBridge,
        sessionId,
        getState: () => ({
          group: entry.latestGroup ?? boundGroup,
          agentId: this.agentId,
          activeTaskId: entry.activeTaskId,
        }),
        sendToChild: async message => {
          if (!entry.session) return
          await entry.session.sendMcpMessage(YWMATRIX_MCP_SERVER_NAME, message)
        },
        log,
      })
      entry.mcpServer = mcpServer
      mcpServer.start().catch(err => {
        log(
          `session_id=${sessionId} 内嵌 MCP server 启动失败: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
    this.spawnFn({
      workdir: entry.workdir,
      // 契约确认 6：模型/权限取 Agent 全局当前值，重拉/新建会话自动继承。
      permissionMode: launch.permissionMode,
      model: launch.model,
      sessionId,
      // P4：群身份等稳定上下文随握手注入（appendSystemPrompt，契约确认 9）。
      ...(entry.group
        ? { appendSystemPrompt: buildGroupSystemPrompt(entry.group, this.agentId) }
        : {}),
      // P5：群会话登记内嵌 SDK MCP server，并把 mcp_message 控制桥路由给它
      // （server_name 白名单校验在 ywcoderSession 侧，非 ywmatrix 显式回 error）。
      ...(mcpServer
        ? {
            sdkMcpServers: [YWMATRIX_MCP_SERVER_NAME],
            onMcpMessage: (_serverName: string, message: unknown) =>
              mcpServer.handleMessage(message),
          }
        : {}),
      onEvent: event => this.handleSessionEvent(sessionId, event),
    })
      .then(session => {
        entry.session = session
        // applied* 记账对齐启动快照（审查 R2-3），不能读此刻的全局值。
        entry.appliedModel = launch.model
        entry.appliedPermissionMode = launch.permissionMode
        // C7：首个就绪子进程带回模型列表后，补报全局 /model 能力。
        if (!this.modelOptions && session.models.length > 0) {
          this.modelOptions = session.models
          this.pushGlobalCapabilities()
        }
        // 契约确认 7：上报该 workdir 可 headless 执行的命令/技能（会话级快照）。
        this.pushSessionCapabilities(sessionId, entry)
        this.pump(sessionId)
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        log(`session_id=${sessionId} 启动失败: ${message}`)
        mcpServer?.close().catch(() => {})
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
      this.out(
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
      this.out(
        buildEventError({
          task_id: task.taskId,
          code: 'LOCAL_AGENT_ERROR',
          message,
          recoverable: false,
        }),
      )
      this.taskToSession.delete(task.taskId)
      this.cancelledTasks.delete(task.taskId)
    }
  }

  /** 同一 session 内多个 task 串行（§9.1）：当前无活动任务时才把队首任务喂给 ywcoder。 */
  private pump(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || !entry.session || entry.activeTaskId) return
    const next = entry.queue.shift()
    if (!next) return
    entry.activeTaskId = next.taskId
    entry.activeDispatched = false
    this.out(buildStatusNotification('busy', next.taskId, sessionId))

    // v3 §6.5：命令在队首由 shim 本地处理（串行队列天然满足「busy 时切换命令排队」）。
    const cmd = parseCommandInput({ content: next.content, metadata: next.metadata })
    if (cmd && (cmd.name === 'model' || cmd.name === 'permission')) {
      // 设置切换跨 session 并发时必须串行（审查问题 2）：否则两个 session 同时切换会
      // 让全局值、各子进程实际档位与 applied* 三者互相错位。promise 链做全局互斥。
      this.settingsLock = this.settingsLock.then(
        () => this.executeSettingCommand(sessionId, entry, next.taskId, cmd),
        () => this.executeSettingCommand(sessionId, entry, next.taskId, cmd),
      )
      return
    }

    // 契约确认 8：结构化通道送达的、可 headless 执行的命令（如 /compact），
    // 还原为斜杠文本经 sendUser 走 QueryEngine 执行；未识别命令按普通 content
    // 原样喂给模型（v3：Agent 自行决定识别与否，优于静默失败）。
    let content = next.content
    if (next.metadata?.command && !content.startsWith('/')) {
      if (cmd && isSessionCommand(entry.session.commands, cmd.name)) {
        content = `/${cmd.name}${cmd.text ? ` ${cmd.text}` : ''}`
      }
    }
    // P4：易变群上下文（mentions 等）作为受控上下文块随任务注入（契约确认 9）。
    // 斜杠命令不加前缀：QueryEngine 只认行首 '/'，前缀会把 /compact 等变成普通
    // prompt。命令任务的群身份已由 spawn 的 appendSystemPrompt 覆盖。
    if (next.metadata?.group && !content.startsWith('/')) {
      content = buildGroupTaskPrefix(next.metadata.group, this.agentId) + content
    }

    // 契约确认 6：模型/权限是全局设置，其它 session 在各自下一任务前同步到最新值。
    // 与设置命令共用同一把锁（审查 R2-2）：同步与切换互为临界区，要么看到切换前
    // 的旧值、要么看到提交后的新值，绝不看到中间态。
    this.settingsLock = this.settingsLock.then(
      () => this.syncSessionSettingsThenSend(sessionId, entry, next.taskId, content),
      () => this.syncSessionSettingsThenSend(sessionId, entry, next.taskId, content),
    )
  }

  /**
   * 异步延续有效性（审查 R4 异步终态竞态）：await 之后 session 可能已因子进程
   * exit 被收尾（exit 事件同步先于 Promise 连续体执行，见 ywcoderSession 退出
   * 处理器）。此时继续执行会向已死子进程发请求、或产出第二个终态——必须静默放弃。
   */
  private isActiveTask(sessionId: string, entry: SessionEntry, taskId: string): boolean {
    return this.sessions.get(sessionId) === entry && entry.activeTaskId === taskId
  }

  /**
   * 活动任务在锁后等待期间被取消（审查 R3）：锁回调不得再发 prompt/控制请求，
   * 以与队列取消同口径的 TASK_CANCELLED 终态收尾并推进队列。
   */
  private finishCancelledTask(sessionId: string, entry: SessionEntry, taskId: string): void {
    this.cancelledTasks.delete(taskId)
    this.out(
      buildEventError({
        task_id: taskId,
        code: 'TASK_CANCELLED',
        message: '任务已取消',
        recoverable: false,
      }),
    )
    this.out(buildStatusNotification('idle', taskId, sessionId))
    this.taskToSession.delete(taskId)
    entry.activeTaskId = null
    this.pump(sessionId)
  }

  /**
   * 把落后于全局的模型/权限先同步进子进程，再喂任务。
   *
   * 目标快照（审查 R2-2）：进入临界区时取一次全局值，整个同步过程只瞄准这组
   * 快照记账——await 之后重新读全局值，会把别人刚提交的新值错记到本 session 头上。
   *
   * 失败关闭（审查 R1-1，权限安全）：同步失败的子进程绝不允许按旧设置执行
   * 任务——否则页面显示已切到 default、实际却还在 bypassPermissions 下跑。
   * 此时杀掉子进程，走既有 exit 收尾（活动/排队任务逐个 event.error、entry 删除）；
   * 管控台重试时会以当前全局值重新 spawn（transcript 已落盘，--resume 恢复上下文）。
   */
  private async syncSessionSettingsThenSend(
    sessionId: string,
    entry: SessionEntry,
    taskId: string,
    content: string,
  ): Promise<void> {
    // 防线 0（审查 R4）：锁后等待期间 session 已退出 → exit 路径已产出终态，静默放弃。
    if (!this.isActiveTask(sessionId, entry, taskId)) return
    // 防线 1（审查 R3）：锁后等待期间被取消 → 不同步、不喂任务，直接取消终态。
    if (this.cancelledTasks.delete(taskId)) {
      this.finishCancelledTask(sessionId, entry, taskId)
      return
    }
    const session = entry.session
    if (!session) return
    const target: SettingsSnapshot = {
      model: this.globalModel,
      permissionMode: this.globalPermissionMode,
    }
    try {
      if (entry.appliedPermissionMode !== target.permissionMode) {
        await session.setPermissionMode(target.permissionMode)
        entry.appliedPermissionMode = target.permissionMode
        log(`session_id=${sessionId} 权限模式已同步为全局值 ${target.permissionMode}`)
      }
      if (entry.appliedModel !== target.model && target.model) {
        await session.setModel(target.model)
        entry.appliedModel = target.model
        log(`session_id=${sessionId} 模型已同步为全局值 ${target.model}`)
      }
    } catch (err) {
      // 审查 R4：失败原因若是子进程已退出，exit 路径（同步先于本连续体）已产出
      // 终态并删除 entry——不得再杀一次、再记一笔。
      if (!this.isActiveTask(sessionId, entry, taskId)) return
      log(
        `session_id=${sessionId} 全局设置同步失败，为安全起见终止子进程（任务按失败上报，重试时以全局设置重拉）: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      session.kill()
      return
    }
    // 防线 2（审查 R3/R4）：同步在途被取消 → 不把 prompt 喂给子进程（已生效的
    // applied* 记账保留，如实反映子进程档位）；session 已退出 → exit 已收尾，静默放弃。
    if (!this.isActiveTask(sessionId, entry, taskId)) {
      this.cancelledTasks.delete(taskId)
      return
    }
    if (this.cancelledTasks.delete(taskId)) {
      this.finishCancelledTask(sessionId, entry, taskId)
      return
    }
    entry.activeDispatched = true
    session.sendUser(content)
  }

  /**
   * 本地执行 /model、/permission（契约确认 6：全局设置，不走 LLM）。
   * 结果以确认 text chunk + task.completed 收尾，并推送全局 capabilities_updated。
   */
  private async executeSettingCommand(
    sessionId: string,
    entry: SessionEntry,
    taskId: string,
    cmd: ParsedCommand,
  ): Promise<void> {
    const finish = (text: string): void => {
      // 与正常任务 completed 路径一致：终态 text chunk 带 done:true（审查问题 6）。
      this.out(
        buildStreamChunk({
          task_id: taskId,
          session_id: sessionId,
          type: 'text',
          content: [{ type: 'text', text }],
          done: true,
        }),
      )
      this.out(buildTaskCompleted({ task_id: taskId, session_id: sessionId, summary: text }))
      this.pushGlobalCapabilities()
      this.out(buildStatusNotification('idle', taskId, sessionId))
      this.taskToSession.delete(taskId)
      entry.activeTaskId = null
      this.pump(sessionId)
    }

    // 防线 0（审查 R4）：锁后等待期间 session 已退出 → exit 路径已产出终态，静默放弃。
    if (!this.isActiveTask(sessionId, entry, taskId)) return
    // 防线 1（审查 R3）：锁后等待期间被取消 → 不发控制请求、不改全局值。
    if (this.cancelledTasks.delete(taskId)) {
      this.finishCancelledTask(sessionId, entry, taskId)
      return
    }

    const value = cmd.value ?? cmd.text
    if (!value) {
      finish(`命令 /${cmd.name} 缺少参数`)
      return
    }

    if (cmd.name === 'permission') {
      const options = this.args.allowBypassPermissions
        ? ['default', 'acceptEdits', 'bypassPermissions']
        : ['default', 'acceptEdits']
      if (!options.includes(value)) {
        finish(`未切换：非法权限模式 ${value}（可选：${options.join(' / ')}）`)
        return
      }
      const prev = this.globalPermissionMode
      // commit-after-confirm（审查 R2-1）：发起子进程确认成功前不提交全局值——
      // 提交前的窗口里其它 session 的同步看到的仍是旧值，失败无需回滚，
      // 「全局状态=实际生效」天然成立。
      try {
        if (entry.session) await entry.session.setPermissionMode(value)
      } catch (err) {
        // 审查 R4：session 已退出 → exit 路径已产出唯一终态，静默放弃。
        if (!this.isActiveTask(sessionId, entry, taskId)) {
          this.cancelledTasks.delete(taskId)
          return
        }
        // 防线 2（审查 R3）：在途取消 + 请求失败 → 全局未变，任务按取消终态收尾。
        if (this.cancelledTasks.delete(taskId)) {
          this.finishCancelledTask(sessionId, entry, taskId)
          return
        }
        finish(`未切换：set_permission_mode 失败（${err instanceof Error ? err.message : String(err)}）`)
        return
      }
      // 审查 R4：session 在请求成功后、本连续体运行前退出 → 改动随子进程消失，
      // 不得提交全局值（exit 路径已产出唯一终态）。
      if (!this.isActiveTask(sessionId, entry, taskId)) {
        this.cancelledTasks.delete(taskId)
        return
      }
      // 防线 3（审查 R4，权限语义）：确认成功前被取消 = 升级不发生。子进程已被
      // 切到 value，必须回滚到 prev；回滚失败则子进程停留在新档位而全局未提交
      // （页面旧值/实际新值，正是 R1-1 隐患）→ 失败关闭杀 session，终态由 exit
      // 路径产出。回滚成功：全局未动，无需推送 capabilities。
      if (this.cancelledTasks.delete(taskId)) {
        try {
          if (entry.session) await entry.session.setPermissionMode(prev)
        } catch (rollbackErr) {
          if (!this.isActiveTask(sessionId, entry, taskId)) return
          log(
            `session_id=${sessionId} 已取消的权限切换（${prev} → ${value}）回滚失败，` +
              `为安全起见终止子进程: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          )
          entry.session?.kill()
          return
        }
        if (!this.isActiveTask(sessionId, entry, taskId)) return
        // 回滚成功：子进程真实档位 = 回滚目标 prev，显式记账（审查 R5-P2）——
        // 不能假设 applied 本来就是 prev：延迟同步的 session 可能仍记录更早的
        // 旧档位（如全局早已切走、本 session 尚未跑任务同步），不修正会让下一
        // 任务误判落后、重复同步一次（不越权，但记账不准）。
        entry.appliedPermissionMode = prev
        this.finishCancelledTask(sessionId, entry, taskId)
        return
      }
      this.globalPermissionMode = value as ExternalPermissionMode
      entry.appliedPermissionMode = this.globalPermissionMode
      finish(`已切换权限模式：${prev} → ${value}（对全部会话生效）`)
      return
    }

    // cmd.name === 'model'
    if (this.modelOptions && !this.modelOptions.includes(value)) {
      finish(`未切换：未知模型 ${value}（可选：${this.modelOptions.join(' / ')}）`)
      return
    }
    const prev = this.globalModel
    try {
      if (entry.session) await entry.session.setModel(value)
    } catch (err) {
      // 审查 R4：session 已退出 → exit 路径已产出唯一终态，静默放弃。
      if (!this.isActiveTask(sessionId, entry, taskId)) {
        this.cancelledTasks.delete(taskId)
        return
      }
      if (this.cancelledTasks.delete(taskId)) {
        this.finishCancelledTask(sessionId, entry, taskId)
        return
      }
      finish(`未切换：set_model 失败（${err instanceof Error ? err.message : String(err)}）`)
      return
    }
    // 审查 R4：session 在请求成功后退出 → 改动随子进程消失，不提交。
    if (!this.isActiveTask(sessionId, entry, taskId)) {
      this.cancelledTasks.delete(taskId)
      return
    }
    // 防线 3（审查 P1-1，与权限同口径）：确认成功前被取消 = 切换不发生——
    // 否则「显示已取消、模型切换却生效」的混合语义。回滚目标取请求前子进程
    // 实际档位 entry.appliedModel（commit-after-confirm 期间记账未动）；无可
    // 回滚目标（旧模型未知）或回滚失败 → 失败关闭杀 session，不提交
    // globalModel，终态由 exit 路径产出。回滚成功：全局未动，任务按取消终态收尾。
    if (this.cancelledTasks.delete(taskId)) {
      const rollbackTo = entry.appliedModel
      if (!rollbackTo) {
        log(
          `session_id=${sessionId} 已取消的模型切换（→ ${value}）无可回滚目标（旧模型未知），` +
            `为安全起见终止子进程`,
        )
        entry.session?.kill()
        return
      }
      try {
        if (entry.session) await entry.session.setModel(rollbackTo)
      } catch (rollbackErr) {
        if (!this.isActiveTask(sessionId, entry, taskId)) return
        log(
          `session_id=${sessionId} 已取消的模型切换（${rollbackTo} → ${value}）回滚失败，` +
            `为安全起见终止子进程: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        )
        entry.session?.kill()
        return
      }
      if (!this.isActiveTask(sessionId, entry, taskId)) return
      this.finishCancelledTask(sessionId, entry, taskId)
      return
    }
    this.globalModel = value
    entry.appliedModel = value
    finish(`已切换模型：${prev ?? '(默认)'} → ${value}（对全部会话生效）`)
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
        this.out(
          buildError(id, JsonRpcErrorCode.TaskNotFound, 'Confirm not found'),
        )
      }
      return
    }

    const decision = normalizeConfirmResponse(params.response)
    this.pendingConfirms.delete(params.confirm_id)
    entry.session.respondPermission(params.confirm_id, decision)
    if (id !== null) {
      this.out(
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
    this.out(
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

    // P3：system/init 带回子进程实际生效的模型名。initialize 的 models 列表没有
    // current 标记，/model 的 metadata.current 以此为准回填（只设置一次；
    // 用户切换后 globalModel 已有值，以全局设置为准）。
    if (event.kind === 'init') {
      if (!this.globalModel && event.model) {
        this.globalModel = event.model
        entry && (entry.appliedModel = event.model)
        this.pushGlobalCapabilities()
      }
      return
    }

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
          this.out(
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
        // P5：子进程退出 → 该 session 的全部未决委派以失败收尾，不留悬挂 Promise。
        this.delegationBridge.cleanupSession(sessionId)
        entry?.mcpServer?.close().catch(() => {})
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
      this.out(msg)
    }

    if (event.kind === 'completed' || event.kind === 'error') {
      // 本轮结束：残留的待决确认（如 deny+interrupt 中止时）不再可回复，通知网页关框。
      this.clearPendingConfirms(sessionId, taskId, 'interrupted')
      // P5：父任务终结，兜底清理异常残留的未决委派（正常路径下工具调用
      // 先于任务终态落定，这里只处理子进程行为异常导致的残留）。
      this.delegationBridge.cancelByParentTask(taskId, 'PARENT_FINISHED')
      this.cancelledTasks.delete(taskId)
      this.out(
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
      // P5：子进程退出 → 该 session 的全部未决委派以失败收尾。
      this.delegationBridge.cleanupSession(sessionId)
      entry?.mcpServer?.close().catch(() => {})
      this.taskToSession.delete(taskId)
      this.cancelledTasks.delete(taskId)
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
        this.out(buildError(id, JsonRpcErrorCode.TaskNotFound, 'Task not found'))
      }
    }

    const sessionId = params.session_id ?? this.taskToSession.get(params.task_id)
    const entry = sessionId ? this.sessions.get(sessionId) : undefined
    if (!entry || !sessionId) {
      notFound()
      return
    }

    if (entry.activeTaskId === params.task_id) {
      // 审查 R3 取消竞态：活动任务可能处于三种状态——
      //  a. 锁后等待（同步/设置回调未执行）：子进程无事可中断，打取消标记，
      //     锁回调入口看到标记后以 TASK_CANCELLED 终态收尾；
      //  b. 设置命令在途（控制请求已发出未回）：同样只打标记，请求落定后按
      //     「生效则提交 + 取消终态」收尾（executeSettingCommand 防线 2/3）；
      //  c. prompt 已发给 ywcoder（activeDispatched）：interrupt 走既有收尾。
      // 先撤掉待决确认框（网页据此关框），再按状态决定是否 interrupt。
      this.cancelledTasks.add(params.task_id)
      this.clearPendingConfirms(sessionId, params.task_id, 'task_cancelled')
      // P5/C6：父任务取消 → abort 该任务的全部本地委派等待（远程子任务由网关
      // 按 parent_task_id 级联取消，shim 不主动发任何远程取消消息）。
      this.delegationBridge.cancelByParentTask(params.task_id)
      if (entry.activeDispatched) {
        entry.session?.interrupt()
      }
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
      this.out(
        buildEventError({
          task_id: params.task_id,
          code: 'TASK_CANCELLED',
          message: '任务在排队中被取消',
          recoverable: false,
        }),
      )
    }
    this.taskToSession.delete(params.task_id)
    if (id !== null) this.out(buildTaskCancelResult(id, params.task_id))
  }

  private shutdown(code = 0): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    // P5：stdin EOF / 信号退出 → 所有未决委派以失败收尾（C6：网关断线期间
    // 未决 task.invoke 由 AgentClient 回 -32603，这里兜底本地等待）。
    this.delegationBridge.failAll('shim 正在关闭，委派中止')
    for (const entry of this.sessions.values()) entry.session?.kill()
    process.exit(code)
  }
}

/**
 * 是否作为主模块直接运行（审查 R2-5）：Shim 被测试 import 时不得自启。
 * 产物以 Node 跑（shebang #!/usr/bin/env node），不能用 Bun 专有的 import.meta.main；
 * 用 argv[1] 的 realpath 与自身模块 URL 比对（兼容 npm bin 符号链接）。
 */
function isMainModule(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2))

  // v3 P2 起会话分桶按各 session 的 workdir 推导（sessionIdExistsIn），不再依赖进程
  // cwd；这里仍把 shim 进程 chdir 到实例默认目录，保证其它可能读 process.cwd() 的
  // 兜底路径行为与启动参数一致。ywcoder 子进程本就显式带 cwd: workdir，不受影响。
  process.chdir(args.workdir)

  new Shim(args).start()
}
