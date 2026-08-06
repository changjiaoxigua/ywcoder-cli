/**
 * M2/M3 测试用具：模拟 AgentClient，通过 stdin/stdout 驱动 shim 子进程，
 * 端到端跑通 mock → shim → ywcoder → shim → mock，并断言协议行为。
 *
 * 用法：
 *   bun run src/entrypoints/ywmatrix-shim/mock-agentclient.ts <workdir> [--dev]
 *
 * --dev：直接用 bun 跑 index.ts 源码（快速迭代，无需先 build）；
 * 默认跑构建产物 dist/ywmatrix-shim.mjs（验收用，需先 bun run build）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function usage(): never {
  process.stderr.write('用法: mock-agentclient.ts <workdir> [--dev]\n')
  process.exit(1)
}

const argv = process.argv.slice(2)
const workdirArg = argv.find(a => !a.startsWith('--'))
const devMode = argv.includes('--dev')
if (!workdirArg) usage()
const workdir = resolve(workdirArg)

// 工作目录不存在则创建（shim spawn 时以 workdir 为 cwd，且下方 writeFileSync 需要它存在）。
mkdirSync(workdir, { recursive: true })
writeFileSync(join(workdir, 'test.txt'), 'hello from ywmatrix-shim mock-agentclient\n')

const [cmd, cmdArgs] = devMode
  ? [
      'bun',
      [
        'run',
        join(__dirname, 'index.ts'),
        '--workdir',
        workdir,
        '--permission-mode',
        'acceptEdits',
      ],
    ]
  : [
      process.execPath,
      [
        join(__dirname, '..', '..', '..', 'dist', 'ywmatrix-shim.mjs'),
        '--workdir',
        workdir,
        '--permission-mode',
        'acceptEdits',
      ],
    ]

console.log(`[mock] spawn: ${cmd} ${cmdArgs.join(' ')}`)
const child = spawn(cmd, cmdArgs, { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'] })

let requestSeq = 0
function nextId(): string {
  requestSeq += 1
  return `mock-${requestSeq}`
}

function send(obj: unknown): void {
  const json = JSON.stringify(obj)
  console.log(`[mock→shim] ${json}`)
  child.stdin.write(`${json}\n`)
}

const taskId = `task-${Date.now()}`
const initId = nextId()
// 新模型（§9.2）：首条 task.create 不带 session_id，由 shim 生成 UUID 回传；mock 采纳后校验一致性。
let taskCreateId: string | null = null
let adoptedSessionId: string | null = null

let sawText = false
let sawAction = false
let sawResult = false
let sawCompleted = false
let sawNonJsonl = false
let sawAckSession = false
let sessionIdConsistent = true
let finished = false

function finish(exitCode: number): void {
  if (finished) return
  finished = true
  const ok =
    exitCode === 0 &&
    sawText &&
    sawAction &&
    sawResult &&
    sawCompleted &&
    !sawNonJsonl &&
    sawAckSession &&
    sessionIdConsistent
  console.log(
    `\n[mock] 结果: text=${sawText} action=${sawAction} result=${sawResult} completed=${sawCompleted} ` +
      `stdout洁净=${!sawNonJsonl} ack回传session=${sawAckSession} session一致=${sessionIdConsistent}`,
  )
  console.log(ok ? '[mock] PASS' : '[mock] FAIL')
  child.stdin.end()
  child.kill()
  process.exit(ok ? 0 : 1)
}

const stdoutRl = createInterface({ input: child.stdout })
stdoutRl.on('line', line => {
  console.log(`[shim→mock] ${line}`)
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch {
    sawNonJsonl = true
    console.error(`[mock] FAIL: stdout 出现非 JSONL 行(协议污染): ${line}`)
    return
  }

  if (msg.id === initId && msg.result) {
    console.log('[mock] 收到 lifecycle.initialize result，发送 lifecycle.initialized')
    send({ jsonrpc: '2.0', method: 'lifecycle.initialized' })
    return
  }

  if (msg.method === 'lifecycle.register') {
    console.log('[mock] 收到 lifecycle.register，发送 task.create（不带 session_id，验证 shim 生成并回传）')
    taskCreateId = nextId()
    send({
      jsonrpc: '2.0',
      id: taskCreateId,
      method: 'task.create',
      params: {
        // 故意不带 session_id：新模型下由 shim 生成 UUID 回传（§9.2）。
        task_id: taskId,
        type: 'chat',
        content: '请读取 test.txt 文件并告诉我它的内容。',
      },
    })
    return
  }

  // task.create ack：应回传 shim 生成的 session_id，mock 采纳并用于后续一致性校验。
  if (msg.id === taskCreateId && msg.result) {
    const r = msg.result as Record<string, unknown>
    adoptedSessionId = typeof r.session_id === 'string' ? r.session_id : null
    sawAckSession = Boolean(adoptedSessionId)
    console.log(`[mock] task.create ack 回传 session_id=${adoptedSessionId}`)
    return
  }

  if (msg.method === 'stream.chunk') {
    const p = msg.params as Record<string, unknown>
    if (adoptedSessionId && p.session_id !== adoptedSessionId) sessionIdConsistent = false
    if (p.type === 'text') sawText = true
    if (p.type === 'action') sawAction = true
    if (p.type === 'result') sawResult = true
    return
  }

  if (msg.method === 'task.completed') {
    const p = msg.params as Record<string, unknown>
    if (adoptedSessionId && p.session_id !== adoptedSessionId) sessionIdConsistent = false
    sawCompleted = true
    finish(0)
    return
  }

  if (msg.method === 'event.error') {
    console.error(`[mock] FAIL: 收到 event.error: ${JSON.stringify(msg.params)}`)
    finish(1)
    return
  }

  if (msg.error) {
    console.error(`[mock] FAIL: 收到 JSON-RPC error: ${JSON.stringify(msg.error)}`)
    finish(1)
    return
  }
})

const stderrRl = createInterface({ input: child.stderr })
stderrRl.on('line', line => console.error(`[shim stderr] ${line}`))

child.on('exit', (code, signal) => {
  if (!finished) {
    console.error(`[mock] FAIL: shim 子进程提前退出 code=${code} signal=${signal}`)
    finish(1)
  }
})

send({
  jsonrpc: '2.0',
  id: initId,
  method: 'lifecycle.initialize',
  params: {
    protocolVersion: '1.0.0',
    capabilities: { chat: {}, streaming: {}, confirmations: {}, prompts: {} },
    clientInfo: { name: 'mock-agentclient', version: '0.0.1' },
  },
})

setTimeout(() => {
  if (!finished) {
    console.error('[mock] TIMEOUT: 60s 内未收到 task.completed')
    finish(1)
  }
}, 60000)
