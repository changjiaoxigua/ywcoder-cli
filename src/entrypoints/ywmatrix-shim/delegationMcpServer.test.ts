/**
 * P5 —— DelegationMcpServer 单测：MCP 握手、tools/list 管理者门控、
 * tools/call 逐次重新校验（非管理者/非成员/自身/无活动任务）、受信路由
 * 字段防伪造、manager 变更 tools/list_changed。
 */
import { describe, expect, test } from 'bun:test'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  DELEGATE_TOOL_NAME,
  DelegationMcpServer,
  YWMATRIX_MCP_SERVER_NAME,
  type DelegationGroupState,
} from './delegationMcpServer.js'
import { DelegationFailure } from './delegationBridge.js'
import type { GroupContext } from './protocol.js'

const GROUP: GroupContext = {
  group_id: 'g1',
  group_name: '测试群',
  manager_agent_id: 'me',
  members: [
    { agent_id: 'me', name: '我' },
    { agent_id: 'worker-a', name: '甲' },
    { agent_id: 'worker-b', name: '乙' },
  ],
  mentions: [],
}

interface DelegateCall {
  sessionId: string
  parentTaskId: string
  groupId: string
  targetAgentId: string
  content: string
  metadata?: Record<string, unknown>
}

function makeRig(state: DelegationGroupState) {
  const delegateCalls: DelegateCall[] = []
  const toChild: JSONRPCMessage[] = []
  let delegateImpl: (req: DelegateCall) => Promise<unknown[]> = async () => [
    { type: 'text', text: '子任务结果' },
  ]
  // 只实现 DelegationMcpServer 用到的 delegate 方法。
  const fakeBridge = {
    delegate: (req: DelegateCall) => {
      delegateCalls.push(req)
      return delegateImpl(req)
    },
  }
  const server = new DelegationMcpServer({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge: fakeBridge as any,
    sessionId: 's1',
    getState: () => state,
    sendToChild: async msg => {
      toChild.push(msg)
    },
  })
  return {
    server,
    delegateCalls,
    toChild,
    setDelegateImpl: (fn: (req: DelegateCall) => Promise<unknown[]>) => {
      delegateImpl = fn
    },
  }
}

async function mcpHandshake(server: DelegationMcpServer) {
  const initResp = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  })
  // initialized 通知：无需回包。
  const ack = await server.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })
  return { initResp, ack }
}

async function listTools(server: DelegationMcpServer, id = 2) {
  const resp = (await server.handleMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {},
  })) as unknown as { result: { tools: Array<{ name: string }> } }
  return resp.result.tools.map(t => t.name)
}

async function callDelegate(
  server: DelegationMcpServer,
  args: Record<string, unknown>,
  id = 3,
) {
  const resp = (await server.handleMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: DELEGATE_TOOL_NAME, arguments: args },
  })) as unknown as {
    result: { content: Array<{ type: string; text: string }>; isError?: boolean }
  }
  return resp.result
}

const MANAGER_STATE: DelegationGroupState = {
  group: GROUP,
  agentId: 'me',
  activeTaskId: 'p1',
}

describe('DelegationMcpServer 握手与工具可见性', () => {
  test('initialize 返回 tools 能力；initialized 通知无需回包', async () => {
    const { server } = makeRig(MANAGER_STATE)
    await server.start()
    const { initResp, ack } = await mcpHandshake(server)
    const result = (initResp as { result: Record<string, unknown> }).result
    expect(result.serverInfo).toMatchObject({ name: YWMATRIX_MCP_SERVER_NAME })
    expect(result.capabilities).toMatchObject({ tools: { listChanged: true } })
    expect(ack).toBeUndefined()
    await server.close()
  })

  test('管理者 tools/list 可见 delegate 工具', async () => {
    const { server } = makeRig(MANAGER_STATE)
    await server.start()
    await mcpHandshake(server)
    expect(await listTools(server)).toEqual([DELEGATE_TOOL_NAME])
    await server.close()
  })

  test('非管理者 tools/list 返回空（模型看不到委派工具）', async () => {
    const { server } = makeRig({
      ...MANAGER_STATE,
      group: { ...GROUP, manager_agent_id: 'someone-else' },
    })
    await server.start()
    await mcpHandshake(server)
    expect(await listTools(server)).toEqual([])
    await server.close()
  })

  test('agentId 缺失（旧 client 未下发）一律按非管理者：tools/list 为空', async () => {
    const { server } = makeRig({ ...MANAGER_STATE, agentId: null })
    await server.start()
    await mcpHandshake(server)
    expect(await listTools(server)).toEqual([])
    await server.close()
  })
})

describe('DelegationMcpServer tools/call 逐次校验', () => {
  test('成功委派：受信路由字段取自群状态与活动任务，chunks 转为文本内容', async () => {
    const { server, delegateCalls } = makeRig(MANAGER_STATE)
    await server.start()
    await mcpHandshake(server)
    const result = await callDelegate(server, {
      target_agent_id: 'worker-a',
      content: '查一下数据',
    })
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: '子任务结果' }])
    expect(delegateCalls).toEqual([
      {
        sessionId: 's1',
        parentTaskId: 'p1',
        groupId: 'g1',
        targetAgentId: 'worker-a',
        content: '查一下数据',
      },
    ])
    await server.close()
  })

  test('非管理者调用（列表刷新竞态中的旧身份）→ isError，且不进 bridge', async () => {
    const { server, delegateCalls } = makeRig({
      ...MANAGER_STATE,
      group: { ...GROUP, manager_agent_id: 'someone-else' },
    })
    await server.start()
    await mcpHandshake(server)
    const result = await callDelegate(server, {
      target_agent_id: 'worker-a',
      content: 'x',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('不是本群管理者')
    expect(delegateCalls).toHaveLength(0)
    await server.close()
  })

  test('目标非群成员 / 目标是自己 → isError，不进 bridge', async () => {
    const { server, delegateCalls } = makeRig(MANAGER_STATE)
    await server.start()
    await mcpHandshake(server)
    const outsider = await callDelegate(server, {
      target_agent_id: 'ghost',
      content: 'x',
    })
    expect(outsider.isError).toBe(true)
    expect(outsider.content[0].text).toContain('不在本群成员名册内')
    const self = await callDelegate(server, {
      target_agent_id: 'me',
      content: 'x',
    })
    expect(self.isError).toBe(true)
    expect(self.content[0].text).toContain('委派给自己')
    expect(delegateCalls).toHaveLength(0)
    await server.close()
  })

  test('模型伪造 metadata 路由键被剥离；parent_task_id/group_id 不受入参影响', async () => {
    const { server, delegateCalls } = makeRig(MANAGER_STATE)
    await server.start()
    await mcpHandshake(server)
    const result = await callDelegate(server, {
      target_agent_id: 'worker-b',
      content: '干活',
      metadata: {
        note: '透传我',
        parent_task_id: 'forged-parent',
        group_id: 'forged-group',
        target_agent_id: 'forged-target',
        session_id: 'forged-session',
      },
    })
    expect(result.isError).toBeUndefined()
    expect(delegateCalls).toHaveLength(1)
    expect(delegateCalls[0].parentTaskId).toBe('p1')
    expect(delegateCalls[0].groupId).toBe('g1')
    expect(delegateCalls[0].targetAgentId).toBe('worker-b')
    expect(delegateCalls[0].metadata).toEqual({ note: '透传我' })
    await server.close()
  })

  test('无活动父任务 → isError，不进 bridge', async () => {
    const { server, delegateCalls } = makeRig({ ...MANAGER_STATE, activeTaskId: null })
    await server.start()
    await mcpHandshake(server)
    const result = await callDelegate(server, {
      target_agent_id: 'worker-a',
      content: 'x',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('没有活动中的父任务')
    expect(delegateCalls).toHaveLength(0)
    await server.close()
  })

  test('bridge 失败（子任务 failed/父任务取消等）→ isError 含结构化 code', async () => {
    const { server, setDelegateImpl } = makeRig(MANAGER_STATE)
    setDelegateImpl(async () => {
      throw new DelegationFailure('PARENT_CANCELLED', '父任务已取消')
    })
    await server.start()
    await mcpHandshake(server)
    const result = await callDelegate(server, {
      target_agent_id: 'worker-a',
      content: 'x',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('PARENT_CANCELLED')
    await server.close()
  })
})

describe('DelegationMcpServer 传输健壮性', () => {
  test('审查 P2（复审修正）：子进程复用未完成的请求 id → 新请求失败关闭，旧请求保持并正常闭环', async () => {
    const { server, delegateCalls, toChild, setDelegateImpl } = makeRig(MANAGER_STATE)
    let release!: (chunks: unknown[]) => void
    setDelegateImpl(
      () =>
        new Promise<unknown[]>(res => {
          release = res
        }),
    )
    await server.start()
    await mcpHandshake(server)
    // 第一条请求进入 handler 后挂起（dispatchFromChild 同步登记 id，无需等待）。
    const first = callDelegate(server, { target_agent_id: 'worker-a', content: '一' }, 77)
    // 同 id 第二条：立即失败关闭，不进 handler、不覆盖旧映射。
    const second = callDelegate(server, { target_agent_id: 'worker-a', content: '二' }, 77)
    await expect(second).rejects.toThrow('id 重复')
    expect(delegateCalls).toHaveLength(1)
    expect(delegateCalls[0].content).toBe('一')
    // 释放旧 handler：旧请求拿到自己的结果，无串线。
    release([{ type: 'text', text: '一的结果' }])
    const result = await first
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: '一的结果' }])
    // 旧 handler 落定后不产生额外的 server→child 消息。
    expect(toChild).toHaveLength(0)
    await server.close()
  })
})

describe('DelegationMcpServer 管理者变更（约束 10）', () => {  test('manager 变更 → tools/list_changed 通知，且新 tools/list 立即为空', async () => {
    const state: DelegationGroupState = { ...MANAGER_STATE }
    const { server, toChild } = makeRig(state)
    await server.start()
    await mcpHandshake(server)
    expect(await listTools(server)).toEqual([DELEGATE_TOOL_NAME])
    expect(toChild).toHaveLength(0)

    // 群状态变更：manager 换成别人（同一群、同一名册）。
    state.group = { ...GROUP, manager_agent_id: 'worker-a' }
    server.notifyGroupStateChanged()
    // list_changed 经 sendToChild 发出（异步通知，等一拍）。
    await new Promise(r => setTimeout(r, 10))
    const notif = toChild.find(
      m => 'method' in m && m.method === 'notifications/tools/list_changed',
    )
    expect(notif).toBeDefined()
    expect(await listTools(server, 4)).toEqual([])
    await server.close()
  })

  test('群状态未变化 → 不重复发 tools/list_changed', async () => {
    const state: DelegationGroupState = { ...MANAGER_STATE }
    const { server, toChild } = makeRig(state)
    await server.start()
    await mcpHandshake(server)
    await listTools(server)
    server.notifyGroupStateChanged()
    await new Promise(r => setTimeout(r, 10))
    expect(toChild).toHaveLength(0)
    await server.close()
  })
})
