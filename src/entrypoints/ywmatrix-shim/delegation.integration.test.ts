/**
 * P5 —— 管理者编排 Shim 级集成测试（mock session + 可控 Promise）：
 * 群会话 sdkMcpServers 注入、task.invoke 出站、$response/subtask_result 入站
 * 关联、父任务取消/子进程退出清理、manager 变更 tools/list_changed、
 * 迟到/重复消息幂等忽略。stdout 始终保持纯协议 JSONL（out 只收 OutgoingMessage）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Shim, type ShimDeps } from './index.js'
import type { YwcoderSession, YwcoderSessionOptions } from './ywcoderSession.js'
import type { GroupContext, OutgoingMessage } from './protocol.js'

const SESSION_S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const GROUP: GroupContext = {
  group_id: 'g1',
  group_name: '编排测试群',
  manager_agent_id: 'me',
  members: [
    { agent_id: 'me', name: '管理者' },
    { agent_id: 'worker-a', name: '甲' },
    { agent_id: 'worker-b', name: '乙' },
  ],
  mentions: [],
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeMockSession() {
  const calls: string[] = []
  return {
    models: [] as string[],
    commands: [] as { name: string }[],
    calls,
    setPermissionMode: async (mode: string) => {
      calls.push(`setPermissionMode:${mode}`)
    },
    setModel: async (model: string) => {
      calls.push(`setModel:${model}`)
    },
    sendUser: (content: string) => {
      calls.push(`sendUser:${content}`)
    },
    kill: () => {
      calls.push('kill')
    },
    interrupt: () => {
      calls.push('interrupt')
    },
    respondPermission: () => {},
    sendMcpMessage: async (serverName: string, message: unknown) => {
      calls.push(`sendMcpMessage:${serverName}:${JSON.stringify(message)}`)
    },
  }
}

type MockSession = ReturnType<typeof makeMockSession>

function makeRig(workdir: string) {
  const out: OutgoingMessage[] = []
  const spawnCalls: YwcoderSessionOptions[] = []
  const spawnGates = new Map<string, ReturnType<typeof deferred<YwcoderSession>>>()
  const deps: ShimDeps = {
    out: msg => out.push(msg),
    spawn: opts => {
      spawnCalls.push(opts)
      const gate = deferred<YwcoderSession>()
      spawnGates.set(opts.sessionId, gate)
      return gate.promise
    },
  }
  const shim = new Shim(
    { workdir, permissionMode: 'default', allowBypassPermissions: true },
    deps,
  )
  return { shim, out, spawnCalls, spawnGates }
}

const flush = () => new Promise(r => setTimeout(r, 0))

function initializeLine(id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'lifecycle.initialize',
    params: { protocolVersion: '3', agentInfo: { agent_id: 'me' } },
  })
}

function taskCreateLine(
  id: number,
  taskId: string,
  content: string,
  group?: GroupContext,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'task.create',
    params: {
      task_id: taskId,
      session_id: SESSION_S,
      type: 'chat',
      content,
      ...(group ? { metadata: { group } } : {}),
    },
  })
}

async function settleSpawn(
  rig: ReturnType<typeof makeRig>,
  session: MockSession,
): Promise<void> {
  rig.spawnGates.get(SESSION_S)!.resolve(session as unknown as YwcoderSession)
  await flush()
}

/** 通过捕获的 onMcpMessage 驱动一条 MCP 请求。 */
function mcp(
  rig: ReturnType<typeof makeRig>,
  message: Record<string, unknown>,
): Promise<unknown> {
  const handler = rig.spawnCalls[0].onMcpMessage
  if (!handler) throw new Error('该会话未注册 onMcpMessage')
  return handler('ywmatrix', message)
}

async function mcpHandshake(rig: ReturnType<typeof makeRig>): Promise<void> {
  const resp = (await mcp(rig, {
    jsonrpc: '2.0',
    id: 'mcp-1',
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  })) as { result: { serverInfo: { name: string } } }
  expect(resp.result.serverInfo.name).toBe('ywmatrix')
  expect(
    await mcp(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }),
  ).toBeUndefined()
}

async function mcpListTools(rig: ReturnType<typeof makeRig>, id = 'mcp-2') {
  const resp = (await mcp(rig, {
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {},
  })) as { result: { tools: Array<{ name: string }> } }
  return resp.result.tools.map(t => t.name)
}

function mcpCallDelegate(
  rig: ReturnType<typeof makeRig>,
  args: Record<string, unknown>,
  id = 'mcp-3',
): Promise<{ result: { content: Array<{ type: string; text: string }>; isError?: boolean } }> {
  return mcp(rig, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'delegate', arguments: args },
  }) as Promise<{ result: { content: Array<{ type: string; text: string }>; isError?: boolean } }>
}

function responseLine(id: string, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function subtaskResultLine(params: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    method: 'task.subtask_result',
    params,
  })
}

/** 出站消息中的 task.invoke（method + params）。 */
function findInvoke(out: OutgoingMessage[]) {
  const msg = out.find(m => m.method === 'task.invoke')
  if (!msg) return undefined
  return { id: msg.id as string, params: msg.params as Record<string, unknown> }
}

describe('P5 集成：群会话 MCP 装配', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yw-shim-p5-'))
  })
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  test('单聊会话不注册 sdkMcpServers/onMcpMessage（回归：无委派工具）', async () => {
    const rig = makeRig(workdir)
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-1', '你好'))
    await settleSpawn(rig, makeMockSession())
    expect(rig.spawnCalls[0].sdkMcpServers).toBeUndefined()
    expect(rig.spawnCalls[0].onMcpMessage).toBeUndefined()
  })

  test('群会话注册 sdkMcpServers=[ywmatrix] 且携 onMcpMessage；管理者可见 delegate，非管理者为空', async () => {
    const rig = makeRig(workdir)
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-1', '大家好', GROUP))
    await settleSpawn(rig, makeMockSession())
    expect(rig.spawnCalls[0].sdkMcpServers).toEqual(['ywmatrix'])
    expect(typeof rig.spawnCalls[0].onMcpMessage).toBe('function')
    await mcpHandshake(rig)
    expect(await mcpListTools(rig)).toEqual(['delegate'])
  })

  test('非管理者群成员：tools/list 为空，tools/call 直接 isError', async () => {
    const rig = makeRig(workdir)
    rig.shim.handleLine(initializeLine())
    const memberGroup = { ...GROUP, manager_agent_id: 'someone-else' }
    rig.shim.handleLine(taskCreateLine(2, 'task-1', '收到', memberGroup))
    await settleSpawn(rig, makeMockSession())
    await mcpHandshake(rig)
    expect(await mcpListTools(rig)).toEqual([])
    const result = await mcpCallDelegate(rig, { target_agent_id: 'worker-a', content: 'x' })
    expect(result.result.isError).toBe(true)
    expect(findInvoke(rig.out)).toBeUndefined()
  })
})

describe('P5 集成：task.invoke 全链路', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yw-shim-p5-'))
  })
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  async function setupManagerTask(rig: ReturnType<typeof makeRig>) {
    const session = makeMockSession()
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-1', '帮我汇总', GROUP))
    await settleSpawn(rig, session)
    await mcpHandshake(rig)
    return session
  }

  test('tools/call → task.invoke（受信路由字段）→ dispatched → subtask_result → 文本结果', async () => {
    const rig = makeRig(workdir)
    await setupManagerTask(rig)
    const callPromise = mcpCallDelegate(rig, {
      target_agent_id: 'worker-a',
      content: '查一下数据',
      metadata: { note: '透传', group_id: 'forged', parent_task_id: 'forged' },
    })
    await flush()
    const invoke = findInvoke(rig.out)
    expect(invoke).toBeDefined()
    expect(invoke!.params).toMatchObject({
      parent_task_id: 'task-1',
      group_id: 'g1',
      target_agent_id: 'worker-a',
      type: 'chat',
      content: '查一下数据',
      metadata: { note: '透传' },
    })

    rig.shim.handleLine(responseLine(invoke!.id, { task_id: 'sub-1', status: 'dispatched' }))
    rig.shim.handleLine(
      subtaskResultLine({
        task_id: 'sub-1',
        parent_task_id: 'task-1',
        group_id: 'g1',
        target_agent_id: 'worker-a',
        status: 'completed',
        chunks: [{ type: 'text', text: '调研结果' }],
        error: null,
      }),
    )
    const result = await callPromise
    expect(result.result.isError).toBeUndefined()
    expect(result.result.content).toEqual([{ type: 'text', text: '调研结果' }])
  })

  test('迟到/未知 subtask_result 幂等忽略：不影响在途委派，不产生非法出站', async () => {
    const rig = makeRig(workdir)
    await setupManagerTask(rig)
    const callPromise = mcpCallDelegate(rig, { target_agent_id: 'worker-a', content: '查' })
    await flush()
    const invoke = findInvoke(rig.out)!
    const outCountBefore = rig.out.length
    rig.shim.handleLine(
      subtaskResultLine({
        task_id: 'ghost',
        parent_task_id: 'task-1',
        group_id: 'g1',
        target_agent_id: 'worker-a',
        status: 'completed',
        chunks: [],
      }),
    )
    expect(rig.out.length).toBe(outCountBefore) // 通知无 id：不回任何消息
    rig.shim.handleLine(responseLine(invoke.id, { task_id: 'sub-1', status: 'dispatched' }))
    rig.shim.handleLine(
      subtaskResultLine({
        task_id: 'sub-1',
        parent_task_id: 'task-1',
        group_id: 'g1',
        target_agent_id: 'worker-a',
        status: 'failed',
        error: '子任务炸了',
      }),
    )
    const result = await callPromise
    expect(result.result.isError).toBe(true)
    expect(result.result.content[0].text).toContain('SUBTASK_FAILED')
  })

  test('dispatch 被网关驳回（-32006 嵌套编排）→ 工具 isError 透传', async () => {
    const rig = makeRig(workdir)
    await setupManagerTask(rig)
    const callPromise = mcpCallDelegate(rig, { target_agent_id: 'worker-a', content: '查' })
    await flush()
    const invoke = findInvoke(rig.out)!
    rig.shim.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: invoke.id,
        error: { code: -32006, message: '非群管理者或嵌套编排' },
      }),
    )
    const result = await callPromise
    expect(result.result.isError).toBe(true)
    expect(result.result.content[0].text).toContain('-32006')
  })
})

describe('P5 集成：群绑定一致性（审查 P1-1）', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yw-shim-p5-'))
  })
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  /** 出站中指定 id 的 error 与 result。 */
  const errorFor = (out: OutgoingMessage[], id: number) =>
    out.find(m => m.id === id && m.error) as { error: { code: number; message: string } } | undefined
  const resultFor = (out: OutgoingMessage[], id: number) =>
    out.find(m => m.id === id && m.result)

  test('单聊会话后续携带 metadata.group → -32602，任务不入队', () => {
    const rig = makeRig(workdir)
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-1', '单聊任务'))
    expect(resultFor(rig.out, 2)).toBeDefined()
    rig.shim.handleLine(taskCreateLine(3, 'task-2', '带群任务', GROUP))
    const err = errorFor(rig.out, 3)
    expect(err?.error.code).toBe(-32602)
    expect(err?.error.message).toContain('单聊会话')
    expect(resultFor(rig.out, 3)).toBeUndefined()
    // 出站不得出现 task-2 的 busy 状态（任务未入队）。
    expect(
      rig.out.some(m => m.method === 'lifecycle.status' && JSON.stringify(m).includes('task-2')),
    ).toBe(false)
  })

  test('群聊会话后续缺失 metadata.group → -32602', () => {
    const rig = makeRig(workdir)
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-1', '群任务', GROUP))
    expect(resultFor(rig.out, 2)).toBeDefined()
    rig.shim.handleLine(taskCreateLine(3, 'task-2', '缺群上下文的任务'))
    const err = errorFor(rig.out, 3)
    expect(err?.error.code).toBe(-32602)
    expect(err?.error.message).toContain('必须携带 metadata.group')
    expect(resultFor(rig.out, 3)).toBeUndefined()
  })

  test('群聊会话后续 group_id 变更（g1→g2）→ -32602，latestGroup 不被覆盖', async () => {
    const rig = makeRig(workdir)
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-1', '群任务', GROUP))
    await settleSpawn(rig, makeMockSession())
    await mcpHandshake(rig)
    rig.shim.handleLine(
      taskCreateLine(3, 'task-2', '跨群任务', { ...GROUP, group_id: 'g2' }),
    )
    const err = errorFor(rig.out, 3)
    expect(err?.error.code).toBe(-32602)
    expect(err?.error.message).toContain('不可变更为 g2')
    // 授权仍按 g1 群状态：manager 未变，delegate 工具仍可见。
    expect(await mcpListTools(rig)).toEqual(['delegate'])
  })

  test('同 group_id 允许更新 manager/members：任务受理且触发 tools/list_changed', async () => {
    const rig = makeRig(workdir)
    const session = makeMockSession()
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-1', '群任务', GROUP))
    await settleSpawn(rig, session)
    await mcpHandshake(rig)
    rig.shim.handleLine(
      taskCreateLine(3, 'task-2', '同群新任务', { ...GROUP, manager_agent_id: 'worker-a' }),
    )
    expect(resultFor(rig.out, 3)).toBeDefined()
    await flush()
    expect(
      session.calls.some(c => c.startsWith('sendMcpMessage:ywmatrix:') && c.includes('tools/list_changed')),
    ).toBe(true)
    expect(await mcpListTools(rig, 'mcp-9')).toEqual([])
  })
})

describe('P5 集成：取消/退出/变更清理', () => {  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yw-shim-p5-'))
  })
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  async function setupDispatched(rig: ReturnType<typeof makeRig>) {
    const session = makeMockSession()
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-1', '帮我汇总', GROUP))
    await settleSpawn(rig, session)
    await mcpHandshake(rig)
    const callPromise = mcpCallDelegate(rig, { target_agent_id: 'worker-a', content: '查' })
    await flush()
    const invoke = findInvoke(rig.out)!
    rig.shim.handleLine(responseLine(invoke.id, { task_id: 'sub-1', status: 'dispatched' }))
    return { session, callPromise, invoke }
  }

  test('父任务 task.cancel：本地委派等待以 PARENT_CANCELLED 收尾，shim 不发远程取消', async () => {
    const rig = makeRig(workdir)
    const { session, callPromise } = await setupDispatched(rig)
    rig.shim.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'task.cancel',
        params: { task_id: 'task-1', session_id: SESSION_S },
      }),
    )
    const result = await callPromise
    expect(result.result.isError).toBe(true)
    expect(result.result.content[0].text).toContain('PARENT_CANCELLED')
    // 出站只有一条 task.invoke，没有任何远程取消消息（C6：级联取消在网关）。
    expect(rig.out.filter(m => m.method === 'task.invoke')).toHaveLength(1)
    expect(session.calls).toContain('interrupt')
  })

  test('子进程退出：未决委派收尾、MCP transport 关闭，无悬挂 Promise', async () => {
    const rig = makeRig(workdir)
    const { callPromise } = await setupDispatched(rig)
    const spawnCall = rig.spawnCalls[0]
    spawnCall.onEvent({ kind: 'exit', code: 1, signal: null })
    // 子进程已死，工具结果无处送达：transport 关闭使在途 tools/call 以拒绝收尾
    // （委派本身的 SESSION_EXITED 结构化收尾见 delegationBridge.test 的 cleanupSession 用例）。
    await expect(callPromise).rejects.toThrow('MCP transport 已关闭')
  })

  test('manager 变更：后续 task.create 的群状态触发 tools/list_changed，新列表立即为空', async () => {
    const rig = makeRig(workdir)
    const { session } = await setupDispatched(rig)
    expect(await mcpListTools(rig)).toEqual(['delegate'])
    // 同一群、manager 换成别人（随新任务下发的最新受信群状态）。
    rig.shim.handleLine(
      taskCreateLine(3, 'task-2', '新任务', { ...GROUP, manager_agent_id: 'worker-a' }),
    )
    await flush()
    const listChanged = session.calls.find(c =>
      c.startsWith('sendMcpMessage:ywmatrix:') && c.includes('tools/list_changed'),
    )
    expect(listChanged).toBeDefined()
    expect(await mcpListTools(rig, 'mcp-9')).toEqual([])
  })
})
