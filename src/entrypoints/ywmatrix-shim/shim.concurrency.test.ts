/**
 * 审查 R2-5 —— Shim 控制流竞态测试（可控 Promise / mock session）：
 *  1. 设置命令确认失败（不提交全局值）时，另一 session 的同步正排在锁后——
 *     它必须仍按旧全局值同步，且不受失败牵连。
 *  2. spawn 在途期间全局设置被切换——applied* 必须按启动快照记账，
 *     子进程就绪后先把新全局值同步进去再喂任务（否则任务按错误权限档位执行）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Shim, type ShimDeps } from './index.js'
import type { YwcoderSession, YwcoderSessionOptions } from './ywcoderSession.js'
import type { OutgoingMessage } from './protocol.js'

const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 记录调用序列的 mock session；set* 的实际行为可按用例覆盖。 */
function makeMockSession(overrides: {
  setPermissionMode?: (mode: string) => Promise<void>
  setModel?: (model: string) => Promise<void>
} = {}) {
  const calls: string[] = []
  const session = {
    models: [] as string[],
    commands: [] as { name: string }[],
    calls,
    setPermissionMode: async (mode: string) => {
      calls.push(`setPermissionMode:${mode}`)
      await overrides.setPermissionMode?.(mode)
    },
    setModel: async (model: string) => {
      calls.push(`setModel:${model}`)
      await overrides.setModel?.(model)
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
  }
  return session
}

type MockSession = ReturnType<typeof makeMockSession>

/** 测试床：收集全部出站消息，spawn 按 sessionId 挂可控 Promise。 */
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
    params: { protocolVersion: '3', agentInfo: { agent_id: 'agent-1' } },
  })
}

function taskCreateLine(id: number, taskId: string, sessionId: string, content: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'task.create',
    params: { task_id: taskId, session_id: sessionId, type: 'chat', content },
  })
}

function taskCancelLine(id: number, taskId: string, sessionId: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'task.cancel',
    params: { task_id: taskId, session_id: sessionId },
  })
}

/** 出站消息中含指定 task_id 的 TASK_CANCELLED event.error。 */
function hasTaskCancelled(out: OutgoingMessage[], taskId: string): boolean {
  return out.some(
    m =>
      (m as { method?: string }).method === 'event.error' &&
      JSON.stringify(m).includes(taskId) &&
      JSON.stringify(m).includes('TASK_CANCELLED'),
  )
}

/** 让指定 session 的 mock 子进程就绪。 */
async function settleSpawn(
  rig: ReturnType<typeof makeRig>,
  sessionId: string,
  session: MockSession,
): Promise<void> {
  rig.spawnGates.get(sessionId)!.resolve(session as unknown as YwcoderSession)
  await flush()
}

function completedEvent(sessionId: string) {
  return {
    kind: 'completed' as const,
    result: 'ok',
    usage: {},
    totalCostUsd: 0,
    permissionDenials: [],
    sessionId,
  }
}

describe('Shim 设置并发（审查 R2-5）', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yw-shim-test-'))
  })
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  test('设置命令确认失败不提交全局值；排队等锁的另一 session 仍按旧值同步并正常执行', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    const sessionB = makeMockSession()
    // A 的 setPermissionMode 挂起，由测试手动裁决。
    const setGate = deferred<void>()
    sessionA.setPermissionMode = async (mode: string) => {
      sessionA.calls.push(`setPermissionMode:${mode}`)
      await setGate.promise
    }

    rig.shim.handleLine(initializeLine())
    // session A 跑完一个普通任务（建立 applied* = default 的基线）。
    rig.shim.handleLine(taskCreateLine(2, 'task-a1', SESSION_A, 'hi'))
    await settleSpawn(rig, SESSION_A, sessionA)
    expect(sessionA.calls).toEqual(['sendUser:hi'])
    rig.spawnCalls[0]!.onEvent(completedEvent(SESSION_A))

    // A 发起 /permission bypassPermissions：确认请求挂起，全局值尚未提交。
    rig.shim.handleLine(taskCreateLine(3, 'task-a2', SESSION_A, '/permission bypassPermissions'))
    await flush()
    expect(sessionA.calls).toContain('setPermissionMode:bypassPermissions')

    // B 的普通任务到来：spawn 就绪后，同步排在设置锁之后等待。
    rig.shim.handleLine(taskCreateLine(4, 'task-b1', SESSION_B, 'hello B'))
    await settleSpawn(rig, SESSION_B, sessionB)
    await flush()
    // 锁被 A 占着，B 还什么都没做。
    expect(sessionB.calls).toEqual([])

    // A 的切换失败：不提交全局值（commit-after-confirm），无需回滚。
    setGate.reject(new Error('control timeout'))
    await rig.shim.drain()
    await flush()

    // A 收到失败回执；全局值未被污染——B 的同步看到旧值 default，
    // 与其 applied 相同 → 零 set 调用直接执行任务。
    const texts = rig.out
      .filter(m => (m as { method?: string }).method === 'stream.chunk')
      .map(m => JSON.stringify(m))
    expect(texts.some(t => t.includes('task-a2') && t.includes('未切换'))).toBe(true)
    expect(sessionB.calls).toEqual(['sendUser:hello B'])
    // 失败不波及无辜：B 的子进程没有被杀。
    expect(sessionB.calls).not.toContain('kill')

    // 全局值未被失败切换污染的强观测：随后一次成功切换的回执显示 prev 是 default
    // （若失败时错误提交了 bypassPermissions，这里会显示 bypassPermissions → acceptEdits）。
    sessionA.setPermissionMode = async (mode: string) => {
      sessionA.calls.push(`setPermissionMode:${mode}`)
    }
    rig.shim.handleLine(taskCreateLine(5, 'task-a3', SESSION_A, '/permission acceptEdits'))
    await rig.shim.drain()
    await flush()
    const texts2 = rig.out
      .filter(m => (m as { method?: string }).method === 'stream.chunk')
      .map(m => JSON.stringify(m))
    expect(
      texts2.some(t => t.includes('task-a3') && t.includes('default → acceptEdits')),
    ).toBe(true)
  })

  test('spawn 在途期间全局设置被切换：applied* 按启动快照记账，就绪后先同步再喂任务', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    const sessionB = makeMockSession()

    rig.shim.handleLine(initializeLine())
    // B 先就绪并跑完一个任务，获得执行设置命令的资格。
    rig.shim.handleLine(taskCreateLine(2, 'task-b1', SESSION_B, 'hi'))
    await settleSpawn(rig, SESSION_B, sessionB)
    rig.spawnCalls[0]!.onEvent(completedEvent(SESSION_B))

    // A 的首任务触发 spawn，但子进程迟迟不就绪（spawn 在途）。
    rig.shim.handleLine(taskCreateLine(3, 'task-a1', SESSION_A, 'hi A'))
    await flush()
    const spawnA = rig.spawnCalls.find(c => c.sessionId === SESSION_A)!
    // 启动参数快照：spawn 入参取的是发起时的全局值 default。
    expect(spawnA.permissionMode).toBe('default')

    // 在途期间，B 执行 /permission bypassPermissions 并确认成功 → 全局值提交。
    rig.shim.handleLine(taskCreateLine(4, 'task-b2', SESSION_B, '/permission bypassPermissions'))
    await rig.shim.drain()
    await flush()
    expect(sessionB.calls).toContain('setPermissionMode:bypassPermissions')

    // A 就绪：applied* 必须按启动快照（default）记账，而非此刻的全局值；
    // 因此同步发现落后，先把新全局值同步进子进程，再喂任务。
    await settleSpawn(rig, SESSION_A, sessionA)
    await rig.shim.drain()
    await flush()
    expect(sessionA.calls).toEqual(['setPermissionMode:bypassPermissions', 'sendUser:hi A'])
  })
})

/** A 先就绪跑完基线任务，再发起挂起的 /permission bypassPermissions 占住设置锁。 */
async function holdLockByA(rig: ReturnType<typeof makeRig>, sessionA: MockSession) {
  const setGate = deferred<void>()
  sessionA.setPermissionMode = async (mode: string) => {
    sessionA.calls.push(`setPermissionMode:${mode}`)
    await setGate.promise
  }
  rig.shim.handleLine(taskCreateLine(92, 'task-a1', SESSION_A, 'hi'))
  await settleSpawn(rig, SESSION_A, sessionA)
  rig.spawnCalls.find(c => c.sessionId === SESSION_A)!.onEvent(completedEvent(SESSION_A))
  rig.shim.handleLine(taskCreateLine(93, 'task-a2', SESSION_A, '/permission bypassPermissions'))
  await flush()
  return setGate
}

function exitEvent(code = 1) {
  return { kind: 'exit' as const, code, signal: null }
}

function fireExit(rig: ReturnType<typeof makeRig>, sessionId: string): void {
  rig.spawnCalls.find(c => c.sessionId === sessionId)!.onEvent(exitEvent())
}

/** 指定 task 的终态消息（event.error / task.completed / stream.chunk）。 */
function terminalsFor(out: OutgoingMessage[], taskId: string): OutgoingMessage[] {
  return out.filter(m => {
    const method = (m as { method?: string }).method
    return (
      (method === 'event.error' || method === 'task.completed' || method === 'stream.chunk') &&
      JSON.stringify(m).includes(taskId)
    )
  })
}

describe('Shim 取消竞态（审查 R3）', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yw-shim-test-'))
  })
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  test('普通任务等待设置锁时被取消：释放锁后不得 sendUser，按 TASK_CANCELLED 收尾', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    const sessionB = makeMockSession()
    rig.shim.handleLine(initializeLine())
    const setGate = await holdLockByA(rig, sessionA)

    // B 的普通任务：spawn 就绪后同步排在锁后等待。
    rig.shim.handleLine(taskCreateLine(4, 'task-b1', SESSION_B, 'hello B'))
    await settleSpawn(rig, SESSION_B, sessionB)
    await flush()
    expect(sessionB.calls).toEqual([])

    // 锁后等待期间取消 B 的任务；随后 A 的锁释放。
    rig.shim.handleLine(taskCancelLine(5, 'task-b1', SESSION_B))
    setGate.resolve()
    await rig.shim.drain()
    await flush()

    // 释放锁后回调不得再喂 prompt；B 以取消终态收尾，子进程不受牵连。
    expect(sessionB.calls).toEqual([])
    expect(hasTaskCancelled(rig.out, 'task-b1')).toBe(true)
    // A 的设置命令不受影响，照常提交。
    const texts = rig.out.map(m => JSON.stringify(m))
    expect(texts.some(t => t.includes('task-a2') && t.includes('已切换权限模式'))).toBe(true)
  })

  test('设置任务等待锁时被取消：释放锁后不得发控制请求，全局值保持不变', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    const sessionB = makeMockSession()

    // B 的基线任务必须在锁被占之前跑完（否则它自己也排在锁后）。
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-b1', SESSION_B, 'hi'))
    await settleSpawn(rig, SESSION_B, sessionB)
    rig.spawnCalls[0]!.onEvent(completedEvent(SESSION_B))

    // A 占锁（基线 + 挂起的 /permission bypassPermissions）。
    const setGate = await holdLockByA(rig, sessionA)

    // B 发起 /permission acceptEdits 排在锁后。
    rig.shim.handleLine(taskCreateLine(5, 'task-b2', SESSION_B, '/permission acceptEdits'))
    await flush()

    // 锁后等待期间取消 B 的设置命令；A 的锁释放。
    rig.shim.handleLine(taskCancelLine(6, 'task-b2', SESSION_B))
    setGate.resolve()
    await rig.shim.drain()
    await flush()

    // B 不得发出控制请求；任务按取消终态收尾。
    expect(sessionB.calls).toEqual(['sendUser:hi'])
    expect(hasTaskCancelled(rig.out, 'task-b2')).toBe(true)

    // 全局值只被 A 提交为 bypassPermissions：B 随后一次成功切换的回执 prev 可证。
    sessionB.setPermissionMode = async (mode: string) => {
      sessionB.calls.push(`setPermissionMode:${mode}`)
    }
    rig.shim.handleLine(taskCreateLine(7, 'task-b3', SESSION_B, '/permission default'))
    await rig.shim.drain()
    await flush()
    const texts = rig.out.map(m => JSON.stringify(m))
    expect(texts.some(t => t.includes('task-b3') && t.includes('bypassPermissions → default'))).toBe(
      true,
    )
  })

  test('设置控制请求在途时取消（请求失败）：全局不变、任务取消终态', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    rig.shim.handleLine(initializeLine())
    const setGate = await holdLockByA(rig, sessionA)

    rig.shim.handleLine(taskCancelLine(4, 'task-a2', SESSION_A))
    setGate.reject(new Error('control timeout'))
    await rig.shim.drain()
    await flush()

    expect(hasTaskCancelled(rig.out, 'task-a2')).toBe(true)
    // 全局未被失败请求污染：随后成功切换的回执 prev 仍是 default。
    sessionA.setPermissionMode = async (mode: string) => {
      sessionA.calls.push(`setPermissionMode:${mode}`)
    }
    rig.shim.handleLine(taskCreateLine(5, 'task-a3', SESSION_A, '/permission acceptEdits'))
    await rig.shim.drain()
    await flush()
    const texts = rig.out.map(m => JSON.stringify(m))
    expect(texts.some(t => t.includes('task-a3') && t.includes('default → acceptEdits'))).toBe(true)
  })

  test('同步在途（同步控制请求已发出）时取消：不得 sendUser，按 TASK_CANCELLED 收尾', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    const sessionB = makeMockSession()

    // B 的基线任务在锁被占之前跑完（applied=default）。
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-b1', SESSION_B, 'hi'))
    await settleSpawn(rig, SESSION_B, sessionB)
    rig.spawnCalls.find(c => c.sessionId === SESSION_B)!.onEvent(completedEvent(SESSION_B))

    // A 占锁；B 的下一任务排在锁后。
    const setGate = await holdLockByA(rig, sessionA)
    const syncGate = deferred<void>()
    sessionB.setPermissionMode = async (mode: string) => {
      sessionB.calls.push(`setPermissionMode:${mode}`)
      await syncGate.promise
    }
    rig.shim.handleLine(taskCreateLine(5, 'task-b2', SESSION_B, 'should not send'))
    // A 的锁释放 → 全局变为 bypassPermissions → B 的同步发出挂起的控制请求。
    setGate.resolve()
    await flush()
    // B 的同步控制请求已在途。
    expect(sessionB.calls).toEqual(['sendUser:hi', 'setPermissionMode:bypassPermissions'])

    // 同步在途取消；同步请求落定后不得再喂 prompt。
    rig.shim.handleLine(taskCancelLine(6, 'task-b2', SESSION_B))
    syncGate.resolve()
    await rig.shim.drain()
    await flush()
    expect(sessionB.calls).toEqual(['sendUser:hi', 'setPermissionMode:bypassPermissions'])
    expect(hasTaskCancelled(rig.out, 'task-b2')).toBe(true)
  })
})

describe('Shim 权限回滚与异步终态（审查 R4）', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yw-shim-test-'))
  })
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  test('/permission bypassPermissions 确认成功前取消：回滚到原权限，全局不提交', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    rig.shim.handleLine(initializeLine())
    const setGate = await holdLockByA(rig, sessionA)

    // 控制请求在途（挂起）时取消：子进程无 prompt 在跑，不得 interrupt。
    rig.shim.handleLine(taskCancelLine(4, 'task-a2', SESSION_A))
    expect(sessionA.calls).not.toContain('interrupt')
    // 请求随后「成功」：子进程已被切到 bypassPermissions → 必须回滚到 default。
    setGate.resolve()
    await rig.shim.drain()
    await flush()

    // 回滚调用序：先 bypass（原请求）再 default（回滚）。
    expect(sessionA.calls).toEqual([
      'sendUser:hi',
      'setPermissionMode:bypassPermissions',
      'setPermissionMode:default',
    ])
    // 任务终态 = TASK_CANCELLED；无成功回执、无 task.completed、session 不被杀。
    expect(hasTaskCancelled(rig.out, 'task-a2')).toBe(true)
    const terms = terminalsFor(rig.out, 'task-a2')
    expect(terms.length).toBe(1)
    expect(sessionA.calls).not.toContain('kill')
    // 全局未提交：不得推送 current=bypassPermissions 的 capabilities。
    const caps = rig.out
      .filter(m => (m as { method?: string }).method === 'lifecycle.capabilities_updated')
      .map(m => JSON.stringify(m))
    expect(caps.some(c => c.includes('"current":"bypassPermissions"'))).toBe(false)
    // 后续成功切换的回执 prev=default，直接证明全局从未被污染。
    sessionA.setPermissionMode = async (mode: string) => {
      sessionA.calls.push(`setPermissionMode:${mode}`)
    }
    rig.shim.handleLine(taskCreateLine(5, 'task-a3', SESSION_A, '/permission acceptEdits'))
    await rig.shim.drain()
    await flush()
    const texts = rig.out.map(m => JSON.stringify(m))
    expect(texts.some(t => t.includes('task-a3') && t.includes('default → acceptEdits'))).toBe(true)
  })

  test('回滚成功后 applied 显式记为 prev：延迟同步的旧档位不残留（审查 R5-P2）', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    const sessionB = makeMockSession()
    rig.shim.handleLine(initializeLine())

    // A 基线后切到 acceptEdits（A.applied=acceptEdits，全局=acceptEdits）。
    rig.shim.handleLine(taskCreateLine(2, 'task-a1', SESSION_A, 'hi'))
    await settleSpawn(rig, SESSION_A, sessionA)
    rig.spawnCalls.find(c => c.sessionId === SESSION_A)!.onEvent(completedEvent(SESSION_A))
    rig.shim.handleLine(taskCreateLine(3, 'task-a2', SESSION_A, '/permission acceptEdits'))
    await rig.shim.drain()
    await flush()

    // B 把全局切回 default：A 未跑任务，applied 停留在 acceptEdits（延迟同步）。
    rig.shim.handleLine(taskCreateLine(4, 'task-b1', SESSION_B, 'hi'))
    await settleSpawn(rig, SESSION_B, sessionB)
    rig.spawnCalls.find(c => c.sessionId === SESSION_B)!.onEvent(completedEvent(SESSION_B))
    rig.shim.handleLine(taskCreateLine(5, 'task-b2', SESSION_B, '/permission default'))
    await rig.shim.drain()
    await flush()

    // A 发起 /permission bypassPermissions（prev=全局=default）并在途取消：
    // 请求成功后回滚到 default。注意 A 的 applied 此时还是 acceptEdits。
    const setGate = deferred<void>()
    sessionA.setPermissionMode = async (mode: string) => {
      sessionA.calls.push(`setPermissionMode:${mode}`)
      await setGate.promise
    }
    rig.shim.handleLine(taskCreateLine(6, 'task-a3', SESSION_A, '/permission bypassPermissions'))
    await flush()
    rig.shim.handleLine(taskCancelLine(7, 'task-a3', SESSION_A))
    setGate.resolve()
    await rig.shim.drain()
    await flush()
    expect(sessionA.calls).toContain('setPermissionMode:default')

    // 关键断言：回滚已把 applied 修正为 default（= 全局），A 的下一任务同步
    // 应为零调用直接执行；若记账残留 acceptEdits，这里会多一次冗余的同步调用。
    sessionA.setPermissionMode = async (mode: string) => {
      sessionA.calls.push(`setPermissionMode:${mode}`)
    }
    rig.shim.handleLine(taskCreateLine(8, 'task-a4', SESSION_A, 'next'))
    await rig.shim.drain()
    await flush()
    expect(sessionA.calls).toEqual([
      'sendUser:hi',
      'setPermissionMode:acceptEdits',
      'setPermissionMode:bypassPermissions',
      'setPermissionMode:default',
      'sendUser:next',
    ])
  })

  test('回滚失败：终止 session，不全局提交，终态唯一', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    rig.shim.handleLine(initializeLine())
    const setGate = await holdLockByA(rig, sessionA)
    rig.shim.handleLine(taskCancelLine(4, 'task-a2', SESSION_A))
    // 原请求的 Promise 由旧实现创建（仍等 setGate）；回滚是新的调用——
    // 先把实现换成「挂起在 rollbackGate」，再放行原请求，回滚即被卡住。
    const rollbackGate = deferred<void>()
    sessionA.setPermissionMode = async (mode: string) => {
      sessionA.calls.push(`setPermissionMode:${mode}`)
      await rollbackGate.promise
    }
    setGate.resolve()
    await flush()
    // 回滚（setPermissionMode:default）已在途。
    expect(sessionA.calls).toContain('setPermissionMode:default')
    rollbackGate.reject(new Error('control timeout'))
    await rig.shim.drain()
    await flush()

    // 失败关闭：杀 session；全局不提交。
    expect(sessionA.calls).toContain('kill')
    // 模拟子进程退出 → exit 路径产出唯一终态（LOCAL_AGENT_ERROR）。
    fireExit(rig, SESSION_A)
    await flush()
    const terms = terminalsFor(rig.out, 'task-a2')
    expect(terms.length).toBe(1)
    expect(JSON.stringify(terms[0])).toContain('event.error')
    // 全局未被污染：新会话 spawn 入参仍是 default。
    const sessionC = makeMockSession()
    rig.shim.handleLine(
      taskCreateLine(6, 'task-c1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'hi C'),
    )
    await flush()
    expect(
      rig.spawnCalls.find(c => c.sessionId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')!
        .permissionMode,
    ).toBe('default')
    await settleSpawn(rig, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionC)
  })

  test('设置控制请求在途时子进程 exit：只有一个 event.error，不得有 task.completed', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    rig.shim.handleLine(initializeLine())
    const setGate = await holdLockByA(rig, sessionA)

    // 子进程在控制请求在途时退出：exit 事件同步收尾（event.error + entry 删除），
    // 随后控制请求 Promise 才 reject（与 ywcoderSession 退出处理器的真实顺序一致）。
    fireExit(rig, SESSION_A)
    setGate.reject(new Error('ywcoder 子进程已退出'))
    await rig.shim.drain()
    await flush()

    const terms = terminalsFor(rig.out, 'task-a2')
    expect(terms.length).toBe(1)
    expect((terms[0] as { method?: string }).method).toBe('event.error')
  })

  test('普通同步等待锁时 session 退出：锁回调不得 sendUser，不产生第二个终态', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    const sessionB = makeMockSession()
    rig.shim.handleLine(initializeLine())
    const setGate = await holdLockByA(rig, sessionA)

    // B 的任务：spawn 就绪后同步排在锁后等待。
    rig.shim.handleLine(taskCreateLine(4, 'task-b1', SESSION_B, 'hello B'))
    await settleSpawn(rig, SESSION_B, sessionB)
    await flush()

    // 等待期间 B 的子进程退出 → exit 路径产出唯一终态。
    fireExit(rig, SESSION_B)
    // A 的锁释放 → B 的锁回调运行：必须静默放弃。
    setGate.resolve()
    await rig.shim.drain()
    await flush()

    expect(sessionB.calls).toEqual([])
    const terms = terminalsFor(rig.out, 'task-b1')
    expect(terms.length).toBe(1)
    expect((terms[0] as { method?: string }).method).toBe('event.error')
  })

  test('普通同步在途时 session 退出：不得 sendUser，不产生第二个终态', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    const sessionB = makeMockSession()

    // B 必须在全局切换前跑完基线（applied=default），否则它启动即继承新全局值。
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-b1', SESSION_B, 'hi'))
    await settleSpawn(rig, SESSION_B, sessionB)
    rig.spawnCalls.find(c => c.sessionId === SESSION_B)!.onEvent(completedEvent(SESSION_B))

    // A 把全局切到 bypassPermissions（基线 + 立即成功的切换）。
    rig.shim.handleLine(taskCreateLine(3, 'task-a1', SESSION_A, 'hi'))
    await settleSpawn(rig, SESSION_A, sessionA)
    rig.spawnCalls.find(c => c.sessionId === SESSION_A)!.onEvent(completedEvent(SESSION_A))
    rig.shim.handleLine(taskCreateLine(4, 'task-a2', SESSION_A, '/permission bypassPermissions'))
    await rig.shim.drain()
    await flush()

    // B 发起任务：同步需要切到 bypass，让控制请求挂起。
    const syncGate = deferred<void>()
    sessionB.setPermissionMode = async (mode: string) => {
      sessionB.calls.push(`setPermissionMode:${mode}`)
      await syncGate.promise
    }
    rig.shim.handleLine(taskCreateLine(5, 'task-b2', SESSION_B, 'should not send'))
    await flush()
    expect(sessionB.calls).toEqual(['sendUser:hi', 'setPermissionMode:bypassPermissions'])

    // 同步在途时 B 退出 → exit 同步收尾；随后同步 Promise reject → 静默放弃。
    fireExit(rig, SESSION_B)
    syncGate.reject(new Error('ywcoder 子进程已退出'))
    await rig.shim.drain()
    await flush()

    expect(sessionB.calls).toEqual(['sendUser:hi', 'setPermissionMode:bypassPermissions'])
    expect(sessionB.calls).not.toContain('kill')
    const terms = terminalsFor(rig.out, 'task-b2')
    expect(terms.length).toBe(1)
    expect((terms[0] as { method?: string }).method).toBe('event.error')
  })
})

describe('Shim 模型回滚（审查 P1-1）', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yw-shim-test-'))
  })
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  /** A 就绪：models=['k1','k2']，init 回填当前模型 k1（applied=global=k1），跑完基线。 */
  async function setupModelSession(rig: ReturnType<typeof makeRig>, sessionA: MockSession) {
    sessionA.models = ['k1', 'k2']
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-a1', SESSION_A, 'hi'))
    await settleSpawn(rig, SESSION_A, sessionA)
    const onEventA = rig.spawnCalls.find(c => c.sessionId === SESSION_A)!.onEvent
    onEventA({ kind: 'init', model: 'k1' })
    onEventA(completedEvent(SESSION_A))
  }

  test('/model 在途取消（请求成功）：回滚到旧模型，全局不提交，任务取消终态', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    await setupModelSession(rig, sessionA)

    const setGate = deferred<void>()
    sessionA.setModel = async (model: string) => {
      sessionA.calls.push(`setModel:${model}`)
      await setGate.promise
    }
    rig.shim.handleLine(taskCreateLine(3, 'task-a2', SESSION_A, '/model k2'))
    await flush()
    rig.shim.handleLine(taskCancelLine(4, 'task-a2', SESSION_A))
    expect(sessionA.calls).not.toContain('interrupt')
    setGate.resolve()
    await rig.shim.drain()
    await flush()

    // 回滚调用序：先 k2（原请求）再 k1（回滚）；终态唯一且为取消；不杀 session。
    expect(sessionA.calls).toEqual(['sendUser:hi', 'setModel:k2', 'setModel:k1'])
    expect(hasTaskCancelled(rig.out, 'task-a2')).toBe(true)
    expect(terminalsFor(rig.out, 'task-a2').length).toBe(1)
    expect(sessionA.calls).not.toContain('kill')
    // 全局未提交 k2：capabilities 不得出现 current:k2。
    const caps = rig.out
      .filter(m => (m as { method?: string }).method === 'lifecycle.capabilities_updated')
      .map(m => JSON.stringify(m))
    expect(caps.some(c => c.includes('"current":"k2"'))).toBe(false)
    // 后续成功切换的回执 prev=k1，直接证明全局从未被污染。
    sessionA.setModel = async (model: string) => {
      sessionA.calls.push(`setModel:${model}`)
    }
    rig.shim.handleLine(taskCreateLine(5, 'task-a3', SESSION_A, '/model k2'))
    await rig.shim.drain()
    await flush()
    const texts = rig.out.map(m => JSON.stringify(m))
    expect(texts.some(t => t.includes('task-a3') && t.includes('k1 → k2'))).toBe(true)
  })

  test('/model 在途取消且无可回滚目标（旧模型未知）：终止 session，不提交全局模型', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    // 不发 init、启动未指定模型：appliedModel 未知。
    sessionA.models = ['k1', 'k2']
    rig.shim.handleLine(initializeLine())
    rig.shim.handleLine(taskCreateLine(2, 'task-a1', SESSION_A, 'hi'))
    await settleSpawn(rig, SESSION_A, sessionA)
    rig.spawnCalls.find(c => c.sessionId === SESSION_A)!.onEvent(completedEvent(SESSION_A))

    const setGate = deferred<void>()
    sessionA.setModel = async (model: string) => {
      sessionA.calls.push(`setModel:${model}`)
      await setGate.promise
    }
    rig.shim.handleLine(taskCreateLine(3, 'task-a2', SESSION_A, '/model k2'))
    await flush()
    rig.shim.handleLine(taskCancelLine(4, 'task-a2', SESSION_A))
    setGate.resolve()
    await rig.shim.drain()
    await flush()

    // 失败关闭：杀 session；exit 路径产出唯一终态。
    expect(sessionA.calls).toContain('kill')
    fireExit(rig, SESSION_A)
    await flush()
    const terms = terminalsFor(rig.out, 'task-a2')
    expect(terms.length).toBe(1)
    expect((terms[0] as { method?: string }).method).toBe('event.error')
    // 全局模型未被提交：新会话 spawn 不携带 model。
    const sessionC = makeMockSession()
    rig.shim.handleLine(
      taskCreateLine(5, 'task-c1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'hi C'),
    )
    await flush()
    expect(
      rig.spawnCalls.find(c => c.sessionId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')!.model,
    ).toBeUndefined()
    await settleSpawn(rig, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionC)
  })

  test('/model 在途取消且回滚失败：终止 session，不提交全局模型，终态唯一', async () => {
    const rig = makeRig(workdir)
    const sessionA = makeMockSession()
    await setupModelSession(rig, sessionA)

    const setGate = deferred<void>()
    sessionA.setModel = async (model: string) => {
      sessionA.calls.push(`setModel:${model}`)
      await setGate.promise
    }
    rig.shim.handleLine(taskCreateLine(3, 'task-a2', SESSION_A, '/model k2'))
    await flush()
    rig.shim.handleLine(taskCancelLine(4, 'task-a2', SESSION_A))
    // 回滚是新调用：先换实现（挂 rollbackGate）再放行原请求。
    const rollbackGate = deferred<void>()
    sessionA.setModel = async (model: string) => {
      sessionA.calls.push(`setModel:${model}`)
      await rollbackGate.promise
    }
    setGate.resolve()
    await flush()
    expect(sessionA.calls).toContain('setModel:k1')
    rollbackGate.reject(new Error('control timeout'))
    await rig.shim.drain()
    await flush()

    expect(sessionA.calls).toContain('kill')
    fireExit(rig, SESSION_A)
    await flush()
    const terms = terminalsFor(rig.out, 'task-a2')
    expect(terms.length).toBe(1)
    expect((terms[0] as { method?: string }).method).toBe('event.error')
    // 全局模型未被污染：新会话 spawn 仍携带 k1。
    const sessionC = makeMockSession()
    rig.shim.handleLine(
      taskCreateLine(5, 'task-c1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'hi C'),
    )
    await flush()
    expect(
      rig.spawnCalls.find(c => c.sessionId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')!.model,
    ).toBe('k1')
    await settleSpawn(rig, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionC)
  })
})
