/**
 * M2/M3/M4 测试用具：模拟 AgentClient，通过 stdin/stdout 驱动 shim 子进程，
 * 端到端跑通 mock → shim → ywcoder → shim → mock，并断言协议行为。
 *
 * 用法：
 *   bun run src/entrypoints/ywmatrix-shim/mock-agentclient.ts <workdir> [--dev] [--scenario <name>]
 *
 * --dev：直接用 bun 跑 index.ts 源码（快速迭代，无需先 build）；
 * 默认跑构建产物 dist/ywmatrix-shim.mjs（验收用，需先 bun run build）。
 *
 * --scenario：
 *   read   简单档（acceptEdits）：读文件，验证 text/action/result/completed 全链路（M1~M3）
 *   allow  完整档（default）：写文件触发 confirm_required → 回「确认」→ 文件真实创建、任务成功
 *   deny   完整档：写文件触发 confirm_required → 回「拒绝」→ 文件未创建、模型继续、
 *          task.completed.metadata.permission_denials 有记录
 *   cancel 完整档：写文件触发 confirm_required → 回 {decision:'cancel'} → deny+interrupt，
 *          本轮以 event.error（error_during_execution）中止
 *   cancel-task 完整档：确认待决期间发通知形式 task.cancel → 收到一条
 *          confirm_cancelled{reason:'task_cancelled'} → 本轮中止（取消与控制面并存）
 *   all    依次跑上面全部（默认）
 *
 * 每个场景各跑一个独立 shim 子进程与独立工作子目录，互不干扰。需 provider 凭证（真调模型）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function usage(): never {
  process.stderr.write(
    '用法: mock-agentclient.ts <workdir> [--dev] [--scenario read|allow|deny|cancel|cancel-task|all]\n',
  )
  process.exit(1)
}

const argv = process.argv.slice(2)
const devMode = argv.includes('--dev')
// 逐个扫描而非 find(非 flag)：`--scenario deny <workdir>` 里的 `deny` 是选项值，
// 不能被当成 workdir（否则会在 <cwd>/deny 下真跑模型）。
let workdirArg: string | undefined
let scenarioArg = 'all'
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] as string
  if (arg === '--scenario') scenarioArg = argv[++i] ?? 'all'
  else if (arg === '--dev') continue
  else if (!arg.startsWith('--')) workdirArg ??= arg
}
if (!workdirArg) usage()
const rootWorkdir = resolve(workdirArg)

/** 场景定义：一条 task.create + 对 confirm_required 的固定回复 + 结束判据。 */
interface Scenario {
  name: string
  permissionMode: 'acceptEdits' | 'default'
  prompt: string
  /** 是否期望至少收到一次 confirm_required。 */
  expectConfirm: boolean
  /** 对每条 confirm_required 的回复（task.respond.response）。 */
  confirmResponse?: unknown
  /**
   * 收到 confirm_required 时的动作：默认 respond（回 task.respond）；
   * cancelTask 则改发 task.cancel，验证取消路径与控制面并存（§6.3）。
   */
  confirmAction?: 'respond' | 'cancelTask'
  /** 期望的结束方式：任务完成，还是以 event.error 中止。 */
  expectEnd: 'completed' | 'error'
  timeoutMs: number
  /** 结束后的额外断言，返回失败原因（空数组=通过）。 */
  verify: (ctx: ScenarioContext) => string[]
}

interface ScenarioContext {
  workdir: string
  sawText: boolean
  sawAction: boolean
  sawResult: boolean
  sawCompleted: boolean
  sawErrorEvent: boolean
  sawNonJsonl: boolean
  sawAckSession: boolean
  sessionIdConsistent: boolean
  confirmCount: number
  confirmLevels: string[]
  /** 收到的 confirm_cancelled 的 reason 列表（§8.1.1）。 */
  cancelledConfirms: string[]
  permissionDenials: unknown[]
}

const TARGET_TEXT = 'hello-ywmatrix'

function writePrompt(file: string): string {
  return `请使用 Write 工具在当前工作目录创建文件 ${file}，内容为 ${TARGET_TEXT}。不要使用 Bash。`
}

/** 目标文件已创建且内容正确。 */
function fileWritten(ctx: ScenarioContext, file: string): boolean {
  const path = join(ctx.workdir, file)
  return existsSync(path) && readFileSync(path, 'utf8').includes(TARGET_TEXT)
}

const SCENARIOS: Scenario[] = [
  {
    name: 'read',
    permissionMode: 'acceptEdits',
    prompt: '请读取 test.txt 文件并告诉我它的内容。',
    expectConfirm: false,
    expectEnd: 'completed',
    timeoutMs: 60_000,
    verify: ctx => {
      const fails: string[] = []
      if (!ctx.sawText) fails.push('未收到 text chunk')
      if (!ctx.sawAction) fails.push('未收到 action chunk')
      if (!ctx.sawResult) fails.push('未收到 result chunk')
      if (ctx.confirmCount > 0) fails.push('简单档不应出现 confirm_required')
      return fails
    },
  },
  {
    name: 'allow',
    permissionMode: 'default',
    prompt: writePrompt('confirm-allow.txt'),
    expectConfirm: true,
    confirmResponse: '确认',
    expectEnd: 'completed',
    timeoutMs: 180_000,
    verify: ctx =>
      fileWritten(ctx, 'confirm-allow.txt')
        ? []
        : ['allow 后目标文件未被真实创建（或内容不符）'],
  },
  {
    name: 'deny',
    permissionMode: 'default',
    prompt: writePrompt('confirm-deny.txt'),
    expectConfirm: true,
    confirmResponse: '拒绝',
    // 仅拒绝本次工具：模型继续对话，本轮仍以 result{success} 收尾。
    expectEnd: 'completed',
    timeoutMs: 180_000,
    verify: ctx => {
      const fails: string[] = []
      if (fileWritten(ctx, 'confirm-deny.txt')) fails.push('deny 后文件仍被创建')
      if (ctx.permissionDenials.length === 0) {
        fails.push('task.completed.metadata.permission_denials 为空')
      }
      return fails
    },
  },
  {
    name: 'cancel',
    permissionMode: 'default',
    prompt: writePrompt('confirm-cancel.txt'),
    expectConfirm: true,
    // 结构化回复：等价于 deny + interrupt:true，中止整个任务。
    confirmResponse: { decision: 'cancel', message: '用户在管控台取消任务' },
    expectEnd: 'error',
    timeoutMs: 180_000,
    verify: ctx =>
      fileWritten(ctx, 'confirm-cancel.txt')
        ? ['deny+interrupt 后文件仍被创建']
        : [],
  },
  {
    name: 'cancel-task',
    permissionMode: 'default',
    prompt: writePrompt('confirm-cancel-task.txt'),
    expectConfirm: true,
    // 确认待决期间直接发 task.cancel → shim 转 interrupt，验证取消与控制面并存（§6.3）。
    confirmAction: 'cancelTask',
    expectEnd: 'error',
    timeoutMs: 180_000,
    verify: ctx => {
      const fails: string[] = []
      if (fileWritten(ctx, 'confirm-cancel-task.txt')) {
        fails.push('task.cancel 后文件仍被创建')
      }
      // §8.1.1：待决确认框必须被撤销，且只撤销一次（不因 ywcoder 迟到的
      // control_cancel_request 重复发）。
      if (ctx.cancelledConfirms.length !== 1) {
        fails.push(
          `期望恰好 1 条 confirm_cancelled，实际 ${ctx.cancelledConfirms.length} 条`,
        )
      } else if (ctx.cancelledConfirms[0] !== 'task_cancelled') {
        fails.push(`confirm_cancelled.reason 期望 task_cancelled，实际 ${ctx.cancelledConfirms[0]}`)
      }
      return fails
    },
  },
]

function shimCommand(workdir: string, permissionMode: string): [string, string[]] {
  return devMode
    ? [
        'bun',
        [
          'run',
          join(__dirname, 'index.ts'),
          '--workdir',
          workdir,
          '--permission-mode',
          permissionMode,
        ],
      ]
    : [
        process.execPath,
        [
          join(__dirname, '..', '..', '..', 'dist', 'ywmatrix-shim.mjs'),
          '--workdir',
          workdir,
          '--permission-mode',
          permissionMode,
        ],
      ]
}

function runScenario(scenario: Scenario): Promise<boolean> {
  return new Promise(resolvePromise => {
    // 每个场景独立工作目录，文件断言互不污染。
    const workdir = join(rootWorkdir, scenario.name)
    mkdirSync(workdir, { recursive: true })
    writeFileSync(join(workdir, 'test.txt'), 'hello from ywmatrix-shim mock-agentclient\n')

    const ctx: ScenarioContext = {
      workdir,
      sawText: false,
      sawAction: false,
      sawResult: false,
      sawCompleted: false,
      sawErrorEvent: false,
      sawNonJsonl: false,
      sawAckSession: false,
      sessionIdConsistent: true,
      confirmCount: 0,
      confirmLevels: [],
      cancelledConfirms: [],
      permissionDenials: [],
    }

    const [cmd, cmdArgs] = shimCommand(workdir, scenario.permissionMode)
    console.log(`\n=== [${scenario.name}] spawn: ${cmd} ${cmdArgs.join(' ')}`)
    const child = spawn(cmd, cmdArgs, { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'] })

    let requestSeq = 0
    const nextId = (): string => `mock-${scenario.name}-${++requestSeq}`
    function send(obj: unknown): void {
      const json = JSON.stringify(obj)
      console.log(`[mock→shim] ${json}`)
      child.stdin.write(`${json}\n`)
    }

    const taskId = `task-${scenario.name}-${Date.now()}`
    const initId = nextId()
    let taskCreateId: string | null = null
    let adoptedSessionId: string | null = null
    let finished = false

    function finish(hardFails: string[]): void {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const fails = [...hardFails]
      if (ctx.sawNonJsonl) fails.push('stdout 出现非 JSONL 行（协议污染）')
      if (!ctx.sawAckSession) fails.push('task.create ack 未回传 session_id')
      if (!ctx.sessionIdConsistent) fails.push('输出中的 session_id 与 ack 不一致')
      if (scenario.expectConfirm && ctx.confirmCount === 0) {
        fails.push('未收到 confirm_required')
      }
      if (!scenario.expectConfirm && ctx.confirmCount > 0) {
        fails.push('意外收到 confirm_required')
      }
      fails.push(...scenario.verify(ctx))

      console.log(
        `[${scenario.name}] 观测: text=${ctx.sawText} action=${ctx.sawAction} result=${ctx.sawResult} ` +
          `completed=${ctx.sawCompleted} error=${ctx.sawErrorEvent} confirm=${ctx.confirmCount}` +
          `${ctx.confirmLevels.length ? `(level=${ctx.confirmLevels.join(',')})` : ''} ` +
          `撤销=${ctx.cancelledConfirms.length}${ctx.cancelledConfirms.length ? `(${ctx.cancelledConfirms.join(',')})` : ''} ` +
          `denials=${ctx.permissionDenials.length} stdout洁净=${!ctx.sawNonJsonl}`,
      )
      for (const f of fails) console.error(`[${scenario.name}] FAIL: ${f}`)
      console.log(fails.length === 0 ? `[${scenario.name}] PASS` : `[${scenario.name}] FAIL`)
      child.stdin.end()
      child.kill()
      resolvePromise(fails.length === 0)
    }

    const timer = setTimeout(() => {
      finish([`超时 ${scenario.timeoutMs}ms 内未结束`])
    }, scenario.timeoutMs)

    const stdoutRl = createInterface({ input: child.stdout })
    stdoutRl.on('line', line => {
      console.log(`[shim→mock] ${line}`)
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        ctx.sawNonJsonl = true
        return
      }

      if (msg.id === initId && msg.result) {
        send({ jsonrpc: '2.0', method: 'lifecycle.initialized' })
        return
      }

      if (msg.method === 'lifecycle.register') {
        // §9.2：首条 task.create 不带 session_id，由 shim 生成 UUID 回传。
        taskCreateId = nextId()
        send({
          jsonrpc: '2.0',
          id: taskCreateId,
          method: 'task.create',
          params: { task_id: taskId, type: 'chat', content: scenario.prompt },
        })
        return
      }

      if (msg.id === taskCreateId && msg.result) {
        const r = msg.result as Record<string, unknown>
        adoptedSessionId = typeof r.session_id === 'string' ? r.session_id : null
        ctx.sawAckSession = Boolean(adoptedSessionId)
        return
      }

      if (msg.method === 'stream.chunk') {
        const p = msg.params as Record<string, unknown>
        if (adoptedSessionId && p.session_id !== adoptedSessionId) {
          ctx.sessionIdConsistent = false
        }
        if (p.type === 'text') ctx.sawText = true
        if (p.type === 'action') ctx.sawAction = true
        if (p.type === 'result') ctx.sawResult = true
        if (p.type === 'confirm_cancelled') {
          ctx.cancelledConfirms.push(String(p.reason))
          console.log(
            `[${scenario.name}] 收到 confirm_cancelled confirm_id=${p.confirm_id} reason=${p.reason}`,
          )
        }
        if (p.type === 'confirm_required') {
          ctx.confirmCount += 1
          ctx.confirmLevels.push(String(p.level))
          if (scenario.confirmAction === 'cancelTask') {
            console.log(
              `[${scenario.name}] 收到 confirm_required confirm_id=${p.confirm_id}，改发 task.cancel（§6.3）`,
            )
            // 按 v2 §6.3 发通知形式（不带 id），shim 不应回 result/error。
            send({
              jsonrpc: '2.0',
              method: 'task.cancel',
              params: { task_id: taskId, session_id: adoptedSessionId },
            })
            return
          }
          console.log(
            `[${scenario.name}] 收到 confirm_required confirm_id=${p.confirm_id} ` +
              `title=${p.title} level=${p.level}，回复: ${JSON.stringify(scenario.confirmResponse)}`,
          )
          send({
            jsonrpc: '2.0',
            id: nextId(),
            method: 'task.respond',
            params: {
              task_id: taskId,
              session_id: adoptedSessionId,
              confirm_id: p.confirm_id,
              response: scenario.confirmResponse,
            },
          })
        }
        return
      }

      if (msg.method === 'task.completed') {
        const p = msg.params as Record<string, unknown>
        if (adoptedSessionId && p.session_id !== adoptedSessionId) {
          ctx.sessionIdConsistent = false
        }
        const metadata = (p.metadata as Record<string, unknown> | undefined) ?? {}
        ctx.permissionDenials = (metadata.permission_denials as unknown[]) ?? []
        ctx.sawCompleted = true
        finish(
          scenario.expectEnd === 'completed'
            ? []
            : ['期望以 event.error 中止，却收到 task.completed'],
        )
        return
      }

      if (msg.method === 'event.error') {
        ctx.sawErrorEvent = true
        console.error(`[${scenario.name}] event.error: ${JSON.stringify(msg.params)}`)
        finish(
          scenario.expectEnd === 'error'
            ? []
            : [`意外的 event.error: ${JSON.stringify(msg.params)}`],
        )
        return
      }

      if (msg.error) {
        finish([`收到 JSON-RPC error: ${JSON.stringify(msg.error)}`])
      }
    })

    const stderrRl = createInterface({ input: child.stderr })
    stderrRl.on('line', line => console.error(`[shim stderr] ${line}`))

    child.on('exit', (code, signal) => {
      if (!finished) finish([`shim 子进程提前退出 code=${code} signal=${signal}`])
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
  })
}

const selected =
  scenarioArg === 'all'
    ? SCENARIOS
    : SCENARIOS.filter(s => s.name === scenarioArg)
if (selected.length === 0) usage()

const results: Array<[string, boolean]> = []
for (const scenario of selected) {
  results.push([scenario.name, await runScenario(scenario)])
}

console.log('\n=== 汇总 ===')
for (const [name, ok] of results) console.log(`${name}: ${ok ? 'PASS' : 'FAIL'}`)
const allOk = results.every(([, ok]) => ok)
console.log(allOk ? '[mock] PASS' : '[mock] FAIL')
process.exit(allOk ? 0 : 1)
