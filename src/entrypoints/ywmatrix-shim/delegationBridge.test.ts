/**
 * P5 —— DelegationBridge 单测：两阶段关联（request id → dispatch 回执 →
 * subtask_result）、并发乱序、防串话、取消/退出/EOF/超时清理均无悬挂 Promise。
 */
import { describe, expect, test } from 'bun:test'
import { DelegationBridge, DelegationFailure } from './delegationBridge.js'
import type { OutgoingMessage, SubtaskResultParams } from './protocol.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function makeBridge(timeoutMs = 5_000) {
  const sent: OutgoingMessage[] = []
  const logs: string[] = []
  const bridge = new DelegationBridge({
    out: m => sent.push(m),
    log: m => logs.push(m),
    timeoutMs,
  })
  return { bridge, sent, logs }
}

const REQ = {
  sessionId: 's1',
  parentTaskId: 'p1',
  groupId: 'g1',
  targetAgentId: 'worker-a',
  content: '查一下数据',
}

function invokeMsg(sent: OutgoingMessage[], i: number) {
  const msg = sent[i]
  return { id: msg.id as string, params: msg.params as Record<string, unknown> }
}

function subResult(taskId: string, over: Partial<SubtaskResultParams> = {}): SubtaskResultParams {
  return {
    task_id: taskId,
    parent_task_id: 'p1',
    group_id: 'g1',
    target_agent_id: 'worker-a',
    status: 'completed',
    chunks: [{ type: 'text', text: '结果' }],
    ...over,
  }
}

/** 取 Promise 的落定结果（resolve 值或 reject 的 DelegationFailure）。 */
async function settled(p: Promise<unknown[]>): Promise<{ ok: boolean; value?: unknown[]; err?: DelegationFailure }> {
  try {
    return { ok: true, value: await p }
  } catch (err) {
    return { ok: false, err: err as DelegationFailure }
  }
}

describe('DelegationBridge 两阶段关联', () => {
  test('dispatch → subtask_result 全链路：completed 时 resolve chunks', async () => {
    const { bridge, sent } = makeBridge()
    const p = bridge.delegate(REQ)
    expect(sent).toHaveLength(1)
    const { id, params } = invokeMsg(sent, 0)
    expect(sent[0].method).toBe('task.invoke')
    expect(params).toMatchObject({
      parent_task_id: 'p1', group_id: 'g1', target_agent_id: 'worker-a',
      type: 'chat', content: '查一下数据',
    })

    expect(bridge.handleResponse(id, { task_id: 'sub-1', status: 'dispatched' })).toBe(true)
    expect(bridge.handleSubtaskResult(subResult('sub-1'))).toBe(true)
    const r = await settled(p)
    expect(r.ok).toBe(true)
    expect(r.value).toEqual([{ type: 'text', text: '结果' }])
    expect(bridge.pendingCount).toBe(0)
  })

  test('并行委派乱序回执：按 request id 精确关联，互不串台', async () => {
    const { bridge, sent } = makeBridge()
    const p1 = bridge.delegate(REQ)
    const p2 = bridge.delegate({ ...REQ, targetAgentId: 'worker-b', content: '另一个任务' })
    const id1 = invokeMsg(sent, 0).id
    const id2 = invokeMsg(sent, 1).id
    // 乱序：第二个先回执、先出结果。
    expect(bridge.handleResponse(id2, { task_id: 'sub-2', status: 'dispatched' })).toBe(true)
    expect(bridge.handleSubtaskResult(subResult('sub-2', { target_agent_id: 'worker-b', chunks: [{ type: 'text', text: 'B' }] }))).toBe(true)
    expect((await settled(p2)).value).toEqual([{ type: 'text', text: 'B' }])
    // 第一个仍在等。
    expect(bridge.pendingCount).toBe(1)
    expect(bridge.handleResponse(id1, { task_id: 'sub-1', status: 'dispatched' })).toBe(true)
    expect(bridge.handleSubtaskResult(subResult('sub-1', { chunks: [{ type: 'text', text: 'A' }] }))).toBe(true)
    expect((await settled(p1)).value).toEqual([{ type: 'text', text: 'A' }])
  })

  test('同一子任务的 subtask_result 乱序先于 dispatch 回执到达：未命中幂等忽略，回执后可重新关联', async () => {
    const { bridge, sent } = makeBridge()
    const p = bridge.delegate(REQ)
    const { id } = invokeMsg(sent, 0)
    // 回执未到，结果先来：remoteTaskId 尚未登记，必须忽略（网关正常时序不会如此，防御乱投）。
    expect(bridge.handleSubtaskResult(subResult('sub-1'))).toBe(false)
    expect(bridge.handleResponse(id, { task_id: 'sub-1', status: 'dispatched' })).toBe(true)
    expect(bridge.handleSubtaskResult(subResult('sub-1'))).toBe(true)
    expect((await settled(p)).ok).toBe(true)
  })
})

describe('DelegationBridge 失败形态', () => {
  test('dispatch 收到 JSON-RPC error（如 -32006 非管理者）→ 原样透传', async () => {
    const { bridge, sent } = makeBridge()
    const p = bridge.delegate(REQ)
    const { id } = invokeMsg(sent, 0)
    expect(bridge.handleResponse(id, undefined, { code: -32006, message: '非群管理者或嵌套编排' })).toBe(true)
    const r = await settled(p)
    expect(r.err?.code).toBe('DISPATCH_ERROR')
    expect(r.err?.message).toContain('-32006')
    expect(bridge.pendingCount).toBe(0)
  })

  test('dispatch 回执非法（缺 task_id / status≠dispatched）→ INVALID_DISPATCH_RESULT', async () => {
    const { bridge, sent } = makeBridge()
    const p1 = bridge.delegate(REQ)
    expect(bridge.handleResponse(invokeMsg(sent, 0).id, { status: 'dispatched' })).toBe(true)
    expect((await settled(p1)).err?.code).toBe('INVALID_DISPATCH_RESULT')

    const p2 = bridge.delegate(REQ)
    expect(bridge.handleResponse(invokeMsg(sent, 1).id, { task_id: 'sub-2', status: 'queued' })).toBe(true)
    expect((await settled(p2)).err?.code).toBe('INVALID_DISPATCH_RESULT')
  })

  test('子任务 failed/timeout/cancelled → SUBTASK_FAILED 结构化错误', async () => {
    for (const status of ['failed', 'timeout', 'cancelled'] as const) {
      const { bridge, sent } = makeBridge()
      const p = bridge.delegate(REQ)
      bridge.handleResponse(invokeMsg(sent, 0).id, { task_id: 'sub-1', status: 'dispatched' })
      expect(bridge.handleSubtaskResult(subResult('sub-1', { status, error: 'boom' }))).toBe(true)
      const r = await settled(p)
      expect(r.err?.code).toBe('SUBTASK_FAILED')
      expect(r.err?.message).toContain(status)
      expect(r.err?.message).toContain('boom')
    }
  })

  test('parent/group/target 与登记不符 → 不 settle、不串话、记日志', async () => {
    const { bridge, sent, logs } = makeBridge()
    const p = bridge.delegate(REQ)
    bridge.handleResponse(invokeMsg(sent, 0).id, { task_id: 'sub-1', status: 'dispatched' })
    expect(bridge.handleSubtaskResult(subResult('sub-1', { parent_task_id: 'other-parent' }))).toBe(false)
    expect(bridge.handleSubtaskResult(subResult('sub-1', { group_id: 'other-group' }))).toBe(false)
    expect(bridge.handleSubtaskResult(subResult('sub-1', { target_agent_id: 'other-agent' }))).toBe(false)
    expect(logs.some(l => l.includes('关联字段与登记不符'))).toBe(true)
    expect(bridge.pendingCount).toBe(1)
    // 正确字段仍可正常收尾。
    expect(bridge.handleSubtaskResult(subResult('sub-1'))).toBe(true)
    expect((await settled(p)).ok).toBe(true)
  })

  test('未知 task_id / 重复 / 迟到的 subtask_result 与未知 $response 均幂等忽略', async () => {
    const { bridge, sent } = makeBridge()
    const p = bridge.delegate(REQ)
    const { id } = invokeMsg(sent, 0)
    expect(bridge.handleSubtaskResult(subResult('ghost'))).toBe(false)
    expect(bridge.handleResponse('inv-ghost', { task_id: 'x', status: 'dispatched' })).toBe(false)
    bridge.handleResponse(id, { task_id: 'sub-1', status: 'dispatched' })
    expect(bridge.handleSubtaskResult(subResult('sub-1'))).toBe(true)
    // 重复回执与重复结果：已 settle，全部忽略。
    expect(bridge.handleResponse(id, { task_id: 'sub-1', status: 'dispatched' })).toBe(false)
    expect(bridge.handleSubtaskResult(subResult('sub-1'))).toBe(false)
    expect((await settled(p)).ok).toBe(true)
    expect(bridge.pendingCount).toBe(0)
  })

  test('审查 P1-2：进入 WAITING_RESULT 后重复 dispatch 回执被忽略，不覆盖 remoteTaskId', async () => {
    const { bridge, sent } = makeBridge()
    const p = bridge.delegate(REQ)
    const { id } = invokeMsg(sent, 0)
    expect(bridge.handleResponse(id, { task_id: 'sub-1', status: 'dispatched' })).toBe(true)
    // 阶段一索引已摘除：同 id 第二次回执（带不同 task_id）必须返回 false。
    expect(bridge.handleResponse(id, { task_id: 'sub-2', status: 'dispatched' })).toBe(false)
    // 原关联不受影响：sub-1 落定，sub-2 未登记。
    expect(bridge.handleSubtaskResult(subResult('sub-2'))).toBe(false)
    expect(bridge.handleSubtaskResult(subResult('sub-1'))).toBe(true)
    expect((await settled(p)).ok).toBe(true)
    expect(bridge.pendingCount).toBe(0)
  })

  test('审查 P1-2：remote task id 与其它未决委派冲突 → 失败关闭，不覆盖既有映射', async () => {
    const { bridge, sent } = makeBridge()
    const p1 = bridge.delegate(REQ)
    const p2 = bridge.delegate({ ...REQ, targetAgentId: 'worker-b', content: '另一个' })
    expect(bridge.handleResponse(invokeMsg(sent, 0).id, { task_id: 'sub-x', status: 'dispatched' })).toBe(true)
    // 第二条委派回执了相同的远程 task_id：失败关闭，且不污染第一条的映射。
    expect(bridge.handleResponse(invokeMsg(sent, 1).id, { task_id: 'sub-x', status: 'dispatched' })).toBe(true)
    const r2 = await settled(p2)
    expect(r2.err?.code).toBe('INVALID_DISPATCH_RESULT')
    expect(r2.err?.message).toContain('冲突')
    // 第一条委派仍可经 sub-x 正常落定。
    expect(bridge.handleSubtaskResult(subResult('sub-x'))).toBe(true)
    expect((await settled(p1)).ok).toBe(true)
    expect(bridge.pendingCount).toBe(0)
  })
})

describe('DelegationBridge 清理与超时（无悬挂 Promise）', () => {
  test('cancelByParentTask：dispatch 在途与结果在途都被中止', async () => {
    const { bridge, sent } = makeBridge()
    const p1 = bridge.delegate(REQ) // 停在 dispatch 阶段
    const p2 = bridge.delegate({ ...REQ, content: '第二个' })
    bridge.handleResponse(invokeMsg(sent, 1).id, { task_id: 'sub-2', status: 'dispatched' }) // 停在结果阶段
    const pOther = bridge.delegate({ ...REQ, parentTaskId: 'p-other' })
    expect(bridge.cancelByParentTask('p1')).toBe(2)
    expect((await settled(p1)).err?.code).toBe('PARENT_CANCELLED')
    expect((await settled(p2)).err?.code).toBe('PARENT_CANCELLED')
    expect(bridge.pendingCount).toBe(1) // 其它父任务不受影响
    bridge.cancelByParentTask('p-other')
    await settled(pOther)
  })

  test('cleanupSession：只清理该 session 的委派', async () => {
    const { bridge } = makeBridge()
    const p1 = bridge.delegate(REQ)
    const p2 = bridge.delegate({ ...REQ, sessionId: 's2' })
    expect(bridge.cleanupSession('s1')).toBe(1)
    expect((await settled(p1)).err?.code).toBe('SESSION_EXITED')
    expect(bridge.pendingCount).toBe(1)
    bridge.cleanupSession('s2')
    await settled(p2)
  })

  test('failAll：stdin EOF / 网关断线时全部未决以 SHUTDOWN 收尾', async () => {
    const { bridge } = makeBridge()
    const p1 = bridge.delegate(REQ)
    const p2 = bridge.delegate({ ...REQ, content: '另一个' })
    expect(bridge.failAll('AgentClient 连接已关闭')).toBe(2)
    for (const p of [p1, p2]) {
      const r = await settled(p)
      expect(r.err?.code).toBe('SHUTDOWN')
      expect(r.err?.message).toContain('连接已关闭')
    }
    expect(bridge.pendingCount).toBe(0)
  })

  test('长超时兜底：到点未回执则以 TIMEOUT 收尾', async () => {
    const { bridge } = makeBridge(30)
    const p = bridge.delegate(REQ)
    const r = await settled(p)
    expect(r.err?.code).toBe('TIMEOUT')
    expect(bridge.pendingCount).toBe(0)
    // 超时后的迟到回执/结果：幂等忽略。
    await sleep(5)
    expect(bridge.handleResponse('inv-anything', undefined, { code: -1, message: 'x' })).toBe(false)
  })
})
