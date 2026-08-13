/**
 * M2/M3/M4/M5 测试用具：模拟 AgentClient，通过 stdin/stdout 驱动 shim 子进程，
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
 *   preview 简单档：读 md/csv/png → 验证 resource/image 内容块、Read 输出清洗（M5 §4.1）
 *   preview-big 简单档：读 3MB 文本 → 验证大内容不被内联、任务优雅收尾（M5 护栏）
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function usage(): never {
  process.stderr.write(
    '用法: mock-agentclient.ts <workdir> [--dev] [--scenario read|preview|preview-big|allow|deny|cancel|cancel-task|all]\n',
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
  /** 场景专属的工作目录初始化（M5 预览场景据此铺 md/csv/png/大文件）。 */
  setup?: (workdir: string) => void
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
  /** M5：result chunk 里收到的全部内容块（text/image/resource），供预览断言。 */
  resultBlocks: Array<Record<string, any>>
  /** M5：单行 stdout 的最大字节数，用于验证 2MB 护栏确实卡住了大内容。 */
  maxLineBytes: number
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

// --- M5 预览场景的固定装置（§4.1）---------------------------------------------

/** md 固定内容：含标题/空行/列表，便于逐字节核对清洗结果。 */
const PREVIEW_MD = '# 预览验收\n\n- 第一项\n- 第二项\n\n结尾行。\n'
const PREVIEW_CSV = 'name,qty\n甲,1\n乙,2\n'
/** 1x1 透明 PNG，最小可用图片装置。 */
const PREVIEW_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
/** 单块内联上限（protocol.ts 的 MAX_INLINE_BYTES，此处独立写死用于断言）。 */
const MAX_INLINE_BYTES = 2 * 1024 * 1024

/** 取 result chunk 里的 resource 块（按 uri 后缀过滤）。 */
function resourcesOf(ctx: ScenarioContext, suffix: string): Array<Record<string, any>> {
  return ctx.resultBlocks.filter(
    b => b.type === 'resource' && String(b.resource?.uri ?? '').endsWith(suffix),
  )
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
  {
    // M5：文件/图片预览（§4.1）。一轮里读 md/csv/png 三种，验证三类内容块与清洗。
    name: 'preview',
    permissionMode: 'acceptEdits',
    prompt:
      '请依次使用 Read 工具完整读取当前工作目录下的这三个文件：preview.md、preview.csv、preview.png，' +
      '读完后用一句话说明它们分别是什么。不要使用 Bash，不要写文件。',
    setup: workdir => {
      writeFileSync(join(workdir, 'preview.md'), PREVIEW_MD)
      writeFileSync(join(workdir, 'preview.csv'), PREVIEW_CSV)
      writeFileSync(join(workdir, 'preview.png'), Buffer.from(PREVIEW_PNG_BASE64, 'base64'))
    },
    expectConfirm: false,
    expectEnd: 'completed',
    timeoutMs: 180_000,
    verify: ctx => {
      const fails: string[] = []

      // 1) md → resource 块，mimeType=text/markdown，text 与磁盘原文逐字节一致
      //    （即行号前缀与 system-reminder 都已剥净）。
      const md = resourcesOf(ctx, 'preview.md')[0]
      if (!md) fails.push('未收到 preview.md 的 resource 块')
      else {
        if (md.resource.mimeType !== 'text/markdown') {
          fails.push(`preview.md mimeType 期望 text/markdown，实际 ${md.resource.mimeType}`)
        }
        const text = String(md.resource.text ?? '')
        if (text !== PREVIEW_MD) {
          fails.push(
            `preview.md resource.text 与原文不一致（清洗未生效）：${JSON.stringify(text)}`,
          )
        }
        if (/^\s*\d+[\t→]/m.test(text)) fails.push('preview.md 仍带行号前缀')
        if (text.includes('system-reminder')) fails.push('preview.md 仍含 system-reminder')
      }

      // 2) csv → resource 块，mimeType=text/csv。
      const csv = resourcesOf(ctx, 'preview.csv')[0]
      if (!csv) fails.push('未收到 preview.csv 的 resource 块')
      else {
        if (csv.resource.mimeType !== 'text/csv') {
          fails.push(`preview.csv mimeType 期望 text/csv，实际 ${csv.resource.mimeType}`)
        }
        if (String(csv.resource.text ?? '') !== PREVIEW_CSV) {
          fails.push(
            `preview.csv resource.text 与原文不一致：${JSON.stringify(csv.resource.text)}`,
          )
        }
      }

      // 3) png → image 块（base64 + mimeType），且不重复发 resource。
      const images = ctx.resultBlocks.filter(b => b.type === 'image')
      if (images.length === 0) fails.push('未收到 image 块')
      else {
        const img = images[0] as Record<string, any>
        if (typeof img.data !== 'string' || img.data.length === 0) {
          fails.push('image 块缺少 base64 data')
        }
        if (!String(img.mimeType ?? '').startsWith('image/')) {
          fails.push(`image 块 mimeType 异常：${img.mimeType}`)
        }
      }
      if (resourcesOf(ctx, 'preview.png').length > 0) {
        fails.push('图片重复发了 resource 块（应优先 image）')
      }

      // 4) agent 自己的回答仍是 text 块（M1~M3 行为不回归）。
      if (!ctx.sawText) fails.push('未收到 agent 回答的 text chunk')
      return fails
    },
  },
  {
    // M5 大小护栏（§4.1）：> 2MB 的文件。注意 ywcoder 的 Read 自身有 256KB 上限，
    // 会先一步以 is_error 的 tool_result 拒绝，shim 的 2MB 降级通常轮不到触发；
    // 本场景验证的是「端到端优雅降级」——不内联大内容、不崩、任务照常收尾。
    // 护栏本身的字节级行为由 protocol.test.ts 用合成的超限块覆盖。
    name: 'preview-big',
    permissionMode: 'acceptEdits',
    prompt:
      '请使用 Read 工具读取当前工作目录下的 big.txt，并告诉我读取结果（若读不了就直接说明原因）。不要使用 Bash。',
    setup: workdir => {
      // 3MB 文本，超过 shim 的 2MB 阈值。
      writeFileSync(join(workdir, 'big.txt'), `${'A'.repeat(3 * 1024 * 1024)}\n`)
    },
    expectConfirm: false,
    expectEnd: 'completed',
    timeoutMs: 180_000,
    verify: ctx => {
      const fails: string[] = []
      // 关键不变量：没有任何一条协议行把大内容原样内联出去。
      if (ctx.maxLineBytes > MAX_INLINE_BYTES + 64 * 1024) {
        fails.push(
          `出现超阈值的协议行（${ctx.maxLineBytes} 字节），大内容未被护栏拦住`,
        )
      }
      // 若确实走到了 shim 的降级分支，提示文案必须带三要素。
      const notice = ctx.resultBlocks.find(
        b => b.type === 'text' && String(b.text ?? '').includes('超阈值'),
      )
      if (notice) {
        const text = String(notice.text)
        for (const part of ['big.txt', 'MB', '超阈值 2MB']) {
          if (!text.includes(part)) fails.push(`降级提示缺少「${part}」：${text.slice(-200)}`)
        }
      } else {
        console.log(
          `[preview-big] 提示：未触发 shim 降级（ywcoder Read 的 256KB 上限先行拒绝），` +
            `护栏字节级行为见 protocol.test.ts`,
        )
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
    // 每个场景独立工作目录，文件断言互不污染。先删后建：复跑时清掉上轮产物
    // （如 confirm-allow.txt），避免残留文件让模型误判「文件已符合要求」而跳过 Write。
    const workdir = join(rootWorkdir, scenario.name)
    rmSync(workdir, { recursive: true, force: true })
    mkdirSync(workdir, { recursive: true })
    writeFileSync(join(workdir, 'test.txt'), 'hello from ywmatrix-shim mock-agentclient\n')
    scenario.setup?.(workdir)

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
      resultBlocks: [],
      maxLineBytes: 0,
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
      // 预览场景的内容块可能有 MB 级，整行打印会淹没终端：只打印首尾并标注原长。
      const bytes = Buffer.byteLength(line, 'utf8')
      ctx.maxLineBytes = Math.max(ctx.maxLineBytes, bytes)
      console.log(
        `[shim→mock] ${
          line.length > 1200
            ? `${line.slice(0, 900)}…（省略，共 ${bytes} 字节）…${line.slice(-200)}`
            : line
        }`,
      )
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
        if (p.type === 'result') {
          ctx.sawResult = true
          // M5：留存内容块供预览断言（§4.1）。
          const blocks = (p.content as Array<Record<string, any>> | undefined) ?? []
          ctx.resultBlocks.push(...blocks)
          console.log(
            `[${scenario.name}] result 内容块: ${
              blocks
                .map(b =>
                  b.type === 'resource'
                    ? `resource(${b.resource?.mimeType} ${b.resource?.uri})`
                    : b.type === 'image'
                      ? `image(${b.mimeType} ${String(b.data ?? '').length}B base64)`
                      : `text(${String(b.text ?? '').length} 字)`,
                )
                .join(', ') || '(空)'
            }`,
          )
        }
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
