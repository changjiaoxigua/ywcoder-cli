/**
 * 审查 P1-2 —— armSigkillEscalation 单测：
 * kill() 的 SIGTERM 不保证子进程退出，fail-closed 路径依赖 exit 事件统一收尾，
 * 因此必须有 SIGTERM → SIGKILL 升级看门狗。这里用假 isAlive/kill 验证：
 * 正常退出不升级、超时仍存活则升级、触发瞬间已退出不升级（事件乱序兜底）。
 */
import { describe, expect, test } from 'bun:test'
import { YwcoderSession, armSigkillEscalation } from './ywcoderSession.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('armSigkillEscalation（审查 P1-2）', () => {
  test('正常退出不升级：宽限期内取消后不得 SIGKILL', async () => {
    let killed = 0
    let alive = true
    const cancel = armSigkillEscalation({
      isAlive: () => alive,
      kill: () => {
        killed++
      },
      graceMs: 20,
    })
    // 子进程在宽限期内退出：exit 处理器调用取消函数。
    alive = false
    cancel()
    await sleep(60)
    expect(killed).toBe(0)
  })

  test('超时仍存活则升级为 SIGKILL', async () => {
    let killed = 0
    const cancel = armSigkillEscalation({
      isAlive: () => true,
      kill: () => {
        killed++
      },
      graceMs: 20,
    })
    await sleep(60)
    expect(killed).toBe(1)
    cancel()
  })

  test('计时器触发瞬间已退出（事件乱序）不升级', async () => {
    let killed = 0
    let alive = true
    const cancel = armSigkillEscalation({
      isAlive: () => alive,
      kill: () => {
        killed++
      },
      graceMs: 20,
    })
    // 退出发生但取消函数尚未被调用：触发时仍必须复查存活状态。
    alive = false
    await sleep(60)
    expect(killed).toBe(0)
    cancel()
  })
})

/**
 * 审查 P5 —— mcp_message 控制桥单测：server_name 只放行登记名单（非 ywmatrix
 * 显式回 error）、响应按 request_id 精确关联、通知类回空载荷 success、
 * handler 异常回 error。不经真子进程：Object.create 绕过私有构造函数，
 * 以假 stdin 捕获写出的 control_response。
 */
describe('mcp_message 控制桥（P5）', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function makeSession(opts: Record<string, unknown>) {
    const written: any[] = []
    const session = Object.create(YwcoderSession.prototype) as any
    session.opts = {
      workdir: '/tmp',
      permissionMode: 'default',
      sessionId: 's1',
      onEvent: () => {},
      ...opts,
    }
    session.sessionId = 's1'
    session.alive = true
    session.recentStderr = []
    session.child = {
      stdin: {
        destroyed: false,
        write: (s: string) => {
          written.push(JSON.parse(s))
          return true
        },
        on: () => {},
      },
    }
    return { session, written }
  }

  function mcpRequest(session: any, serverName: string, requestId = 'req-1') {
    session.handleControlRequest({
      request_id: requestId,
      request: {
        subtype: 'mcp_message',
        server_name: serverName,
        message: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      },
    })
  }

  test('未配置 sdkMcpServers（非群会话）→ 显式 error，不静默忽略', async () => {
    const { session, written } = makeSession({})
    mcpRequest(session, 'ywmatrix')
    await sleep(5)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'req-1' },
    })
    expect(written[0].response.error).toContain('未登记')
  })

  test('server_name 不在登记名单 → 显式 error', async () => {
    const { session, written } = makeSession({
      sdkMcpServers: ['ywmatrix'],
      onMcpMessage: async () => undefined,
    })
    mcpRequest(session, 'evil-server')
    await sleep(5)
    expect(written[0].response.subtype).toBe('error')
    expect(written[0].response.error).toContain('evil-server')
  })

  test('合法消息：handler 响应包成 success，mcp_response 与 request_id 精确关联', async () => {
    const mcpResp = { jsonrpc: '2.0', id: 1, result: { tools: [] } }
    const { session, written } = makeSession({
      sdkMcpServers: ['ywmatrix'],
      onMcpMessage: async (name: string) => {
        expect(name).toBe('ywmatrix')
        return mcpResp
      },
    })
    mcpRequest(session, 'ywmatrix', 'req-42')
    await sleep(5)
    expect(written[0]).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-42',
        response: { mcp_response: mcpResp },
      },
    })
  })

  test('通知类消息（handler 返回 undefined）→ 空载荷 success', async () => {
    const { session, written } = makeSession({
      sdkMcpServers: ['ywmatrix'],
      onMcpMessage: async () => undefined,
    })
    mcpRequest(session, 'ywmatrix')
    await sleep(5)
    expect(written[0].response).toEqual({
      subtype: 'success',
      request_id: 'req-1',
      response: {},
    })
  })

  test('handler 抛错 → error control_response，不让子进程悬挂', async () => {
    const { session, written } = makeSession({
      sdkMcpServers: ['ywmatrix'],
      onMcpMessage: async () => {
        throw new Error('非法 MCP 消息')
      },
    })
    mcpRequest(session, 'ywmatrix')
    await sleep(5)
    expect(written[0].response.subtype).toBe('error')
    expect(written[0].response.error).toContain('非法 MCP 消息')
  })
})
