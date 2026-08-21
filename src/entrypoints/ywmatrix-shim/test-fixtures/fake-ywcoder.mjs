#!/usr/bin/env node
/**
 * P6 测试装置：fake ywcoder 子进程（构建产物级回归用，非生产代码）。
 *
 * 由 mock-agentclient-delegation.mjs 以「cli.mjs」之名放进 shim 产物同目录，
 * 被 dist/ywmatrix-shim.mjs 当作 ywcoder CLI spawn（ywcoderSession.ts 的
 * CLI_ENTRY 契约：与 shim 产物同目录的 cli.mjs）。行为脚本由环境变量
 * YWMATRIX_FAKE_SCENARIO 驱动，确定性地模拟「群管理者发起 delegate」的
 * stream-json + 控制桥会话：不连真实模型、不需要任何凭据。
 *
 * 协议面（真 ywcoder 的最小一致子集）：
 * - control_request{initialize} → control_response{success, models/commands}；
 * - user 消息 → assistant tool_use(mcp__ywmatrix__delegate) → 经
 *   control_request{mcp_message} 完成 MCP initialize/initialized/tools/call
 *   → user tool_result 回传工具结果 → result 收尾本轮；
 * - control_request{interrupt} →（invoke-cancel）与工具错误结果汇合后
 *   以 result{error_during_execution} 收尾；
 * - shim→child 的 control_request{mcp_message}（server 通知）→ 立即回
 *   success 空载荷（SdkControlClientTransport 对每条消息都等一个应答）。
 *
 * 与真 ywcoder 同款约束：stdout 只写协议 JSONL，日志一律 stderr。
 */
import { createInterface } from 'node:readline'

const SCENARIO = process.env.YWMATRIX_FAKE_SCENARIO ?? 'invoke-success'
// 与 DelegationMcpServer 的 YWMATRIX_MCP_SERVER_NAME/DELEGATE_TOOL_NAME 对齐
// （装置侧独立写死，不 import 被测代码）。
const SERVER_NAME = 'ywmatrix'
const TOOL_NAME = 'delegate'
/** 委派目标与指令：mock 侧据此断言 task.invoke 的路由字段。 */
const TARGET_AGENT_ID = 'worker-a'
const SUBTASK_INSTRUCTION = '子任务指令：查一下数据'
const TOOL_USE_ID = 'toolu-delegate-1'

/** create 模式下 shim 会传 --session-id <uuid>，回显到 result 消息。 */
function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const SESSION_ID = argValue('--session-id') ?? 'unknown-session'

function log(msg) {
  process.stderr.write(`[fake-ywcoder] ${msg}\n`)
}
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

/** 本装置发出的 control_request 的待决表（request_id → settle）。 */
const pending = new Map()
let reqSeq = 0
function controlRequest(request) {
  const requestId = `fake-req-${++reqSeq}`
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    send({ type: 'control_request', request_id: requestId, request })
  })
}

/** 经控制桥发一条 MCP 消息并等 shim 侧 MCP server 的响应（通知也等空载荷 ack）。 */
async function mcpRequest(message) {
  const payload = await controlRequest({
    subtype: 'mcp_message',
    server_name: SERVER_NAME,
    message,
  })
  return payload?.mcp_response
}

let taskStarted = false
let interrupted = false
/** delegate 工具结果的落定值（成功/结构化错误统一走这里），null=未落定。 */
let toolSettled = null
let cancelFinished = false
/** 群探针场景的观测样本：握手注入的群身份与首任务内容（含群前缀）。 */
let initAppendPrompt = ''
let firstUserContent = ''

/**
 * group-manager / group-member：群身份与工具视野探针。
 * - tools/list 反映本 Agent 的委派能力（管理者见 delegate，成员为空）；
 * - appendSystemPrompt（稳定身份）与任务前缀（易变上下文）的角色标注；
 * - 成员额外做一次越权直调 delegate，必须被 NOT_MANAGER 拒绝（不进网关）。
 * 探针结论写进最终文本，由 mock 侧逐条断言。
 */
async function runGroupProbeTask() {
  const fail = err => {
    log(`群探针控制桥异常: ${err instanceof Error ? err.message : String(err)}`)
    send({
      type: 'result',
      subtype: 'error_during_execution',
      errors: [`控制桥异常: ${err instanceof Error ? err.message : String(err)}`],
      session_id: SESSION_ID,
    })
  }
  try {
    await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-ywcoder', version: '0.0.1' },
      },
    })
    await mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const listResp = await mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = Array.isArray(listResp?.result?.tools) ? listResp.result.tools : []
    const toolNames = tools.map(t => t?.name).filter(n => typeof n === 'string')
    let directCall = ''
    if (SCENARIO === 'group-member') {
      const resp = await mcpRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: TOOL_NAME, arguments: { target_agent_id: TARGET_AGENT_ID, content: '越权直调' } },
      })
      const r = resp?.result ?? {}
      directCall = (Array.isArray(r.content) ? r.content : [])
        .map(b => (b && b.type === 'text' ? b.text : JSON.stringify(b)))
        .join('')
      log(`成员越权直调结果: isError=${Boolean(r.isError)} ${directCall.slice(0, 120)}`)
      directCall = `被拒绝=${Boolean(r.isError) ? '是' : '否'}:${directCall}`
    }
    const yn = (s, sub) => (s.includes(sub) ? '是' : '否')
    const roleOf = (s, managerMark, memberMark) =>
      s.includes(managerMark) ? '管理者' : s.includes(memberMark) ? '成员' : '缺失'
    const summary = [
      `群探针：工具=[${toolNames.join(',')}]`,
      `系统提示含群身份=${yn(initAppendPrompt, '<group-context>')}`,
      `系统提示含群名=${yn(initAppendPrompt, '测试群')}`,
      `系统提示角色=${roleOf(initAppendPrompt, '你是本群的管理者', '你是本群的普通成员')}`,
      `任务前缀角色=${roleOf(firstUserContent, '你在本群的角色：管理者', '你在本群的角色：成员')}`,
      directCall ? `直调结果=${directCall}` : '',
    ]
      .filter(Boolean)
      .join(' ')
    send({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: summary }] },
      session_id: SESSION_ID,
    })
    send({
      type: 'result',
      subtype: 'success',
      result: summary,
      session_id: SESSION_ID,
      total_cost_usd: 0,
      usage: {},
      permission_denials: [],
    })
  } catch (err) {
    fail(err)
  }
}

/**
 * echo 流程（workdir/command 系列）：不回模型、不调工具，直接回显收到的任务
 * 内容与本进程 cwd——驱动器据此断言 workdir 绑定（cwd）与命令斜杠还原（内容）。
 */
async function runEchoTask() {
  const summary = `收到任务：${firstUserContent.slice(0, 80)}|cwd=${process.cwd()}`
  send({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: summary }] },
    session_id: SESSION_ID,
  })
  send({
    type: 'result',
    subtype: 'success',
    result: summary,
    session_id: SESSION_ID,
    total_cost_usd: 0,
    usage: {},
    permission_denials: [],
  })
}

/** 使用 echo 流程的场景（其余场景按各自编排运行）。 */
const ECHO_SCENARIOS = new Set([
  'workdir-default',
  'workdir-two-sessions',
  'workdir-realpath',
  'command-compact',
  'command-skill',
  'command-unsupported-local',
])

async function runTask() {
  // 1) 模拟模型决定调用委派工具（shim 据此产出 action chunk）。
  send({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: `mcp__${SERVER_NAME}__${TOOL_NAME}`,
          input: { target_agent_id: TARGET_AGENT_ID, content: SUBTASK_INSTRUCTION },
        },
      ],
    },
    session_id: SESSION_ID,
  })
  try {
    // 2) MCP 握手（真 MCP Client 同款时序：initialize → initialized → tools/call）。
    await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-ywcoder', version: '0.0.1' },
      },
    })
    await mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const callResp = await mcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: TOOL_NAME,
        arguments: { target_agent_id: TARGET_AGENT_ID, content: SUBTASK_INSTRUCTION },
      },
    })
    const result = callResp?.result ?? {}
    toolSettled = {
      content: Array.isArray(result.content) ? result.content : [],
      isError: Boolean(result.isError),
    }
  } catch (err) {
    // 控制桥级失败（正常路径不应发生）：按工具错误收尾，保证本轮有终态。
    toolSettled = {
      content: [
        { type: 'text', text: `控制桥异常: ${err instanceof Error ? err.message : String(err)}` },
      ],
      isError: true,
    }
  }
  log(
    `delegate 工具结果落定: isError=${toolSettled.isError} ` +
      `${JSON.stringify(toolSettled.content).slice(0, 160)}`,
  )

  if (SCENARIO === 'invoke-cancel') {
    // 与 interrupt 汇合后收尾（两者谁先到达不定）。
    maybeFinishCancel()
    return
  }
  finishTurn()
}

/**
 * invoke-parallel：同一轮内并行发起两个委派（worker-a/worker-b，两个 MCP
 * tools/call 并发在途）。两个工具结果按调用标签（A/B）汇总进最终文本——
 * shim/桥接层一旦把两条委派的结果关联串台，汇总文本立即失配，mock 侧据此判 FAIL。
 */
async function runParallelTask() {
  const CALLS = [
    { label: 'A', toolUseId: 'toolu-delegate-a', mcpId: 2, target: 'worker-a', instruction: '子任务指令A' },
    { label: 'B', toolUseId: 'toolu-delegate-b', mcpId: 3, target: 'worker-b', instruction: '子任务指令B' },
  ]
  // 1) 一条 assistant 消息带两个 tool_use（真 ywcoder 并行工具调用同款形态）。
  send({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: CALLS.map(c => ({
        type: 'tool_use',
        id: c.toolUseId,
        name: `mcp__${SERVER_NAME}__${TOOL_NAME}`,
        input: { target_agent_id: c.target, content: c.instruction },
      })),
    },
    session_id: SESSION_ID,
  })
  try {
    // 2) 同一条 MCP 连接握手一次，随后两个 tools/call 并发等待。
    await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-ywcoder', version: '0.0.1' },
      },
    })
    await mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await Promise.all(
      CALLS.map(async c => {
        const resp = await mcpRequest({
          jsonrpc: '2.0',
          id: c.mcpId,
          method: 'tools/call',
          params: { name: TOOL_NAME, arguments: { target_agent_id: c.target, content: c.instruction } },
        })
        const result = resp?.result ?? {}
        c.content = Array.isArray(result.content) ? result.content : []
        c.isError = Boolean(result.isError)
        c.text = c.content.map(b => (b && b.type === 'text' ? b.text : JSON.stringify(b))).join('\n')
        log(`并行委派 ${c.label}(${c.target}) 落定: isError=${c.isError} ${c.text.slice(0, 80)}`)
      }),
    )
  } catch (err) {
    log(`并行委派控制桥异常: ${err instanceof Error ? err.message : String(err)}`)
    send({
      type: 'result',
      subtype: 'error_during_execution',
      errors: [`控制桥异常: ${err instanceof Error ? err.message : String(err)}`],
      session_id: SESSION_ID,
    })
    return
  }
  // 3) 逐调用回传 tool_result，再按 A/B 标签汇总收尾（串台即文本失配）。
  for (const c of CALLS) sendToolResult(c.toolUseId, c.content, c.isError)
  const summary = `父任务汇总：A结果=${CALLS[0].text}|B结果=${CALLS[1].text}`
  send({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: summary }] },
    session_id: SESSION_ID,
  })
  send({
    type: 'result',
    subtype: 'success',
    result: summary,
    session_id: SESSION_ID,
    total_cost_usd: 0,
    usage: {},
    permission_denials: [],
  })
}

/** 回传 tool_result 并以 result{success} 收尾（invoke-success / invoke-rejected 共用）。 */
function finishTurn() {
  sendToolResult(TOOL_USE_ID, toolSettled.content, toolSettled.isError)
  const text = toolSettled.content
    .map(b => (b && b.type === 'text' ? b.text : JSON.stringify(b)))
    .join('\n')
  const summary = toolSettled.isError ? `委派未成功：${text}` : `父任务汇总：${text}`
  send({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: summary }] },
    session_id: SESSION_ID,
  })
  send({
    type: 'result',
    subtype: 'success',
    result: summary,
    session_id: SESSION_ID,
    total_cost_usd: 0,
    usage: {},
    permission_denials: [],
  })
}

/**
 * invoke-cancel：工具结果（PARENT_CANCELLED）与 interrupt 都到达后才收尾——
 * 若 shim 未按 C6 拒绝本地委派等待，本装置会卡住，由 mock 侧超时判 FAIL。
 */
function maybeFinishCancel() {
  if (cancelFinished || !interrupted || !toolSettled) return
  cancelFinished = true
  sendToolResult(TOOL_USE_ID, toolSettled.content, true)
  send({
    type: 'result',
    subtype: 'error_during_execution',
    errors: ['任务被管控台取消（interrupt）'],
    session_id: SESSION_ID,
  })
}

function sendToolResult(toolUseId, content, isError) {
  send({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
    session_id: SESSION_ID,
  })
}

function handleControlResponse(msg) {
  const resp = msg.response ?? {}
  const requestId = String(resp.request_id ?? '')
  const p = pending.get(requestId)
  if (!p) {
    log(`忽略未知 control_response: request_id=${requestId}`)
    return
  }
  pending.delete(requestId)
  if (resp.subtype === 'success') p.resolve(resp.response ?? {})
  else p.reject(new Error(String(resp.error ?? 'control error')))
}

function handleControlRequest(msg) {
  const request = msg.request ?? {}
  const requestId = msg.request_id
  if (request.subtype === 'initialize') {
    // 群探针场景：留样 appendSystemPrompt（P4 稳定群身份注入）供汇总断言。
    initAppendPrompt =
      typeof request.appendSystemPrompt === 'string' ? request.appendSystemPrompt : ''
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          models: [{ value: 'fake-model' }],
          // 命令/技能发现装置（P3）：compact=命令、review=技能，供
          // command-compact / command-skill 场景的会话级能力上报与斜杠还原。
          commands: [
            { name: 'compact', description: '压缩上下文', kind: 'command' },
            { name: 'review', description: '代码审查', kind: 'skill' },
          ],
        },
      },
    })
    return
  }
  if (request.subtype === 'interrupt') {
    log('收到 interrupt')
    interrupted = true
    maybeFinishCancel()
    // shim 的 interrupt() 不登记待决表（等的是 result 消息），无需回 control_response。
    return
  }
  if (request.subtype === 'mcp_message') {
    // shim→child 的 server 通知（tools/list_changed 等）：本装置不维护工具列表，立即 ack。
    send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    })
    return
  }
  if (request.subtype === 'set_permission_mode' || request.subtype === 'set_model') {
    send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    })
    return
  }
  send({
    type: 'control_response',
    response: {
      subtype: 'error',
      request_id: requestId,
      error: `fake-ywcoder 不支持的 control_request subtype: ${String(request.subtype)}`,
    },
  })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log(`无法解析 stdin 行（非 JSON）: ${line.slice(0, 200)}`)
    return
  }
  if (msg.type === 'control_response') {
    handleControlResponse(msg)
    return
  }
  if (msg.type === 'control_request') {
    handleControlRequest(msg)
    return
  }
  if (msg.type === 'user') {
    // echo 场景允许同会话多任务（workdir-realpath 第二任务走同一子进程）；
    // 其余场景仍是单任务装置，重复 user 消息说明 shim 行为异常。
    if (taskStarted && !ECHO_SCENARIOS.has(SCENARIO)) {
      log('忽略重复 user 消息（本装置单任务）')
      return
    }
    taskStarted = true
    // 群探针场景：留样首任务内容（含 P4 任务级群前缀）供汇总断言。
    firstUserContent =
      typeof msg.message?.content === 'string'
        ? msg.message.content
        : JSON.stringify(msg.message?.content ?? '')
    const run = ECHO_SCENARIOS.has(SCENARIO)
      ? runEchoTask
      : SCENARIO === 'invoke-parallel'
        ? runParallelTask
        : SCENARIO === 'group-manager' || SCENARIO === 'group-member'
          ? runGroupProbeTask
          : runTask
    run().catch(err => {
      log(`runTask 未捕获异常: ${err instanceof Error ? err.stack : String(err)}`)
      process.exit(1)
    })
    return
  }
  log(`忽略未知消息: ${String(msg.type)}`)
})
rl.on('close', () => process.exit(0))

log(`已启动 scenario=${SCENARIO} session=${SESSION_ID}`)
