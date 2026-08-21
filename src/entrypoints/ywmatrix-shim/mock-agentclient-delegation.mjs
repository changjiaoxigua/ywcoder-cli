#!/usr/bin/env node
/**
 * P6 —— ywmatrix-shim v3 的构建产物级回归（mock AgentClient）：
 * 覆盖 P5 管理者编排、P4 群身份注入、P2 会话级 workdir、P3 命令还原/本地执行。
 *
 * 用法：
 *   node src/entrypoints/ywmatrix-shim/mock-agentclient-delegation.mjs <workdir> [--scenario <name>]
 *   bun run src/entrypoints/ywmatrix-shim/mock-agentclient-delegation.mjs <workdir> [--scenario <name>]
 *
 * 前置：先 bun run build（产出 dist/ywmatrix-shim.mjs）。
 *
 * 与 mock-agentclient.ts 的区别：那个跑真模型（需 provider 凭据）；本装置不连
 * 真实网关、不需要任何凭据——ywcoder 子进程由 test-fixtures/fake-ywcoder.mjs
 * 扮演。原理：shim 产物的子进程入口固定为「同目录 cli.mjs」（ywcoderSession.ts
 * 的 CLI_ENTRY 契约）；驱动器把 shim 产物复制到临时目录、以 cli.mjs 之名放入
 * fake 子进程，不改动任何 shim 源码。
 *
 * 场景（每个场景各跑一个独立 shim 子进程与独立工作目录）：
 *   invoke-success   管理者群任务 → delegate → 捕获 task.invoke → 回 dispatched
 *                    → 发 task.subtask_result completed → 父任务拿到子任务文本结果
 *   invoke-rejected  task.invoke 回 JSON-RPC error -32006 → 委派工具结构化错误
 *                    收尾，任务正常完成，无悬挂 Promise
 *   invoke-cancel    dispatch 成功、结果未返回时发父任务 task.cancel → 本地委派
 *                    等待以 PARENT_CANCELLED 收尾；shim 不发任何远程取消消息
 *   invoke-parallel  同一父任务并行两条委派（worker-a/worker-b）→ 乱序回推
 *                    subtask_result → 按远程 task_id 精确关联，结果不串台
 *   invoke-subtask-failed  dispatched 后回推 subtask_result{failed} → 委派工具
 *                    以 SUBTASK_FAILED 结构化错误收尾
 *   invoke-timeout   dispatched 后回推 subtask_result{timeout}（网关侧超时）→
 *                    SUBTASK_FAILED 结构化错误收尾（shim 本地 26h 兜底见单测）
 *   group-manager    群管理者：appendSystemPrompt/任务前缀角色标注为管理者，
 *                    tools/list 可见 delegate（不发起委派）
 *   group-member     普通成员：角色标注为成员，tools/list 为空，越权直调
 *                    delegate 被 NOT_MANAGER 本地拒绝，不产生任何 task.invoke
 *   workdir-default  metadata 不带 workdir → 会话绑定 --workdir，子进程 cwd 一致
 *   workdir-two-sessions  两会话各绑不同 metadata.workdir，子进程 cwd 各自独立
 *   workdir-realpath 同会话先符号链接拼法、后真实路径拼法 → realpath 等价判定一致
 *   workdir-invalid  metadata.workdir 不存在 → task.create 直接 -32602
 *   command-model    /model 由 shim 本地执行（不走 LLM），text chunk + completed 收尾
 *   command-permission  /permission 本地执行，文案反映 acceptEdits → default
 *   command-compact  kind=command 命令还原为斜杠文本「/compact」喂子进程
 *   command-skill    kind=skill 命令同样还原为「/review」
 *   command-unsupported-local  能力列表外命令不还原，content 原样透传
 *   all              依次跑上面全部（默认）
 *
 * 公共不变量：shim stdout 全程纯 JSON-RPC JSONL（日志只在 stderr）、
 * task.create ack 回显网关 session_id、输出 session_id 一致、场景结束后
 * shim 随 stdin EOF 干净退出（无悬挂 Promise）。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_SHIM = join(__dirname, '..', '..', '..', 'dist', 'ywmatrix-shim.mjs')
const FAKE_CHILD = join(__dirname, 'test-fixtures', 'fake-ywcoder.mjs')

/** 固定的群装置：本 Agent（mock-agent-001）是管理者，worker-a 是委派目标。 */
const GROUP_ID = 'g1'
const AGENT_ID = 'mock-agent-001'
const TARGET_AGENT_ID = 'worker-a'
const SUB_TASK_ID = 'sub-1'
const SUBTASK_TEXT = '子任务文本结果'
const GROUP = {
  group_id: GROUP_ID,
  group_name: '测试群',
  manager_agent_id: AGENT_ID,
  members: [
    { agent_id: AGENT_ID, name: '我' },
    { agent_id: TARGET_AGENT_ID, name: '甲' },
    { agent_id: 'worker-b', name: '乙' },
  ],
  mentions: [],
}

/** 组装 task.subtask_result 回推（通知形式，与网关语义一致）。 */
function buildSubtaskResult(ctx, subTaskId, target, text, status = 'completed', error) {
  return {
    jsonrpc: '2.0',
    method: 'task.subtask_result',
    params: {
      task_id: subTaskId,
      parent_task_id: ctx.taskId,
      group_id: GROUP_ID,
      target_agent_id: target,
      status,
      ...(status === 'completed' ? { chunks: [{ type: 'text', text }] } : {}),
      ...(error !== undefined ? { error } : {}),
    },
  }
}

function usage() {
  process.stderr.write(
    '用法: mock-agentclient-delegation.mjs <workdir> [--scenario invoke-success|invoke-rejected|invoke-cancel|invoke-parallel|invoke-subtask-failed|invoke-timeout|group-manager|group-member|workdir-default|workdir-two-sessions|workdir-realpath|workdir-invalid|command-model|command-permission|command-compact|command-skill|command-unsupported-local|all]\n',
  )
  process.exit(1)
}

const argv = process.argv.slice(2)
let workdirArg
let scenarioArg = 'all'
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--scenario') scenarioArg = argv[++i] ?? 'all'
  else if (!arg.startsWith('--')) workdirArg ??= arg
}
if (!workdirArg) usage()
const rootWorkdir = resolve(workdirArg)

if (!existsSync(DIST_SHIM)) {
  process.stderr.write(`未找到构建产物 ${DIST_SHIM}，请先 bun run build\n`)
  process.exit(1)
}

/**
 * 场景定义：task.invoke 到达时的应答动作 + 结束判据 + 场景专属断言。
 * 公共断言（task.invoke 路由字段、stdout 洁净、session 一致、干净退出）在
 * runScenario 内统一执行。
 */
const SCENARIOS = [
  {
    name: 'invoke-success',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    onInvoke(ctx, msg, send) {
      // 阶段一：回 dispatch 回执（登记远程子任务 id）。
      send({ jsonrpc: '2.0', id: msg.id, result: { task_id: SUB_TASK_ID, status: 'dispatched' } })
      // 阶段二：稍后回推子任务结果（按 task_id 关联；通知形式，与网关语义一致）。
      ctx.timers.push(
        setTimeout(() => {
          send({
            jsonrpc: '2.0',
            method: 'task.subtask_result',
            params: {
              task_id: SUB_TASK_ID,
              parent_task_id: ctx.taskId,
              group_id: GROUP_ID,
              target_agent_id: TARGET_AGENT_ID,
              status: 'completed',
              chunks: [{ type: 'text', text: SUBTASK_TEXT }],
            },
          })
        }, 100),
      )
    },
    verify(ctx) {
      const fails = []
      if (!ctx.resultTexts.some(t => t.includes(SUBTASK_TEXT))) {
        fails.push(`父任务未收到子任务文本结果（期望含「${SUBTASK_TEXT}」）`)
      }
      return fails
    },
  },
  {
    name: 'invoke-rejected',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    onInvoke(ctx, msg, send) {
      // 网关驳回（§6.6：-32006 非群管理者或嵌套编排），原样透传为结构化工具错误。
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32006, message: '非群管理者或嵌套编排' },
      })
    },
    verify(ctx) {
      const fails = []
      const hit = ctx.resultChunks.find(
        c => c.isError && c.text.includes('DISPATCH_ERROR') && c.text.includes('-32006'),
      )
      if (!hit) {
        fails.push(
          '委派工具未以结构化错误收尾（期望 is_error 结果块含 DISPATCH_ERROR 与 -32006）',
        )
      }
      // expectEnd=completed：工具错误后任务仍正常完成，即委派等待无悬挂。
      return fails
    },
  },
  {
    name: 'invoke-cancel',
    expectEnd: 'error',
    timeoutMs: 45_000,
    onInvoke(ctx, msg, send) {
      // dispatch 成功但结果不出：稍后直接取消父任务（通知形式，§6.3）。
      send({ jsonrpc: '2.0', id: msg.id, result: { task_id: SUB_TASK_ID, status: 'dispatched' } })
      ctx.timers.push(
        setTimeout(() => {
          send({
            jsonrpc: '2.0',
            method: 'task.cancel',
            params: { task_id: ctx.taskId, session_id: ctx.adoptedSessionId ?? ctx.sessionId },
          })
        }, 100),
      )
    },
    verify(ctx) {
      const fails = []
      if (!ctx.resultChunks.some(c => c.text.includes('PARENT_CANCELLED'))) {
        fails.push('本地委派等待未以 PARENT_CANCELLED 收尾')
      }
      // C6：远程子任务由网关按 parent_task_id 级联取消，shim 不主动发任何
      // 远程取消消息——shim 发出的请求有且只有那一条 task.invoke。
      const others = ctx.outboundRequests.filter(m => m !== 'task.invoke')
      if (others.length > 0) {
        fails.push(`shim 发出了意外的远程请求（疑似远程取消）: ${others.join(', ')}`)
      }
      return fails
    },
  },
  {
    name: 'invoke-parallel',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    // 同一父任务并行两条委派：worker-a / worker-b。
    expectedTargets: [TARGET_AGENT_ID, 'worker-b'],
    onInvoke(ctx, msg, send) {
      // 按目标分别回 dispatch 回执（远程子任务 id 与目标一一对应）。
      const target = String(msg.params?.target_agent_id ?? '')
      send({ jsonrpc: '2.0', id: msg.id, result: { task_id: `sub-${target}`, status: 'dispatched' } })
      // 两条委派都 dispatch 后**乱序**回推结果（先 B 后 A），验证桥接层按
      // 远程 task_id 精确关联、互不串台（fake 子进程按 A/B 标签汇总结果文本）。
      if (ctx.invokeCount === 2) {
        ctx.timers.push(
          setTimeout(() => {
            send(buildSubtaskResult(ctx, 'sub-worker-b', 'worker-b', '子任务B结果'))
          }, 100),
        )
        ctx.timers.push(
          setTimeout(() => {
            send(buildSubtaskResult(ctx, 'sub-worker-a', 'worker-a', '子任务A结果'))
          }, 200),
        )
      }
    },
    verify(ctx) {
      const fails = []
      const ok = ctx.textChunks.some(
        t => t.includes('A结果=子任务A结果') && t.includes('B结果=子任务B结果'),
      )
      if (!ok) {
        fails.push(
          '并行委派结果串台或缺失（期望父任务汇总同时含「A结果=子任务A结果」与「B结果=子任务B结果」）',
        )
      }
      return fails
    },
  },
  {
    name: 'invoke-subtask-failed',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    onInvoke(ctx, msg, send) {
      send({ jsonrpc: '2.0', id: msg.id, result: { task_id: SUB_TASK_ID, status: 'dispatched' } })
      // 子任务执行失败：网关上送 failed 终态与错误详情。
      ctx.timers.push(
        setTimeout(() => {
          send(buildSubtaskResult(ctx, SUB_TASK_ID, TARGET_AGENT_ID, '', 'failed', '子任务执行爆炸'))
        }, 100),
      )
    },
    verify(ctx) {
      const fails = []
      const hit = ctx.resultChunks.find(
        c => c.isError && c.text.includes('SUBTASK_FAILED') && c.text.includes('failed') && c.text.includes('子任务执行爆炸'),
      )
      if (!hit) {
        fails.push('子任务失败未以结构化错误收尾（期望 is_error 结果块含 SUBTASK_FAILED/failed/错误详情）')
      }
      return fails
    },
  },
  {
    // 网关侧上报的子任务超时（subtask_result{status:'timeout'}）。
    // 注意：shim 本地 26h 长超时兜底（DelegationFailure TIMEOUT）在产物级无法
    // 有限时间触发，由 delegationBridge.test.ts 的 30ms 注入单测覆盖。
    name: 'invoke-timeout',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    onInvoke(ctx, msg, send) {
      send({ jsonrpc: '2.0', id: msg.id, result: { task_id: SUB_TASK_ID, status: 'dispatched' } })
      ctx.timers.push(
        setTimeout(() => {
          send(buildSubtaskResult(ctx, SUB_TASK_ID, TARGET_AGENT_ID, '', 'timeout', '子任务执行超时'))
        }, 100),
      )
    },
    verify(ctx) {
      const fails = []
      const hit = ctx.resultChunks.find(
        c => c.isError && c.text.includes('SUBTASK_FAILED') && c.text.includes('timeout') && c.text.includes('子任务执行超时'),
      )
      if (!hit) {
        fails.push('子任务超时未以结构化错误收尾（期望 is_error 结果块含 SUBTASK_FAILED/timeout/错误详情）')
      }
      return fails
    },
  },
  {
    // P4/P5：群管理者的身份注入与工具视野——appendSystemPrompt 含群身份且角色为
    // 管理者，任务前缀角色为管理者，tools/list 可见 delegate（本场景不发起委派）。
    name: 'group-manager',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    verify(ctx) {
      const t = ctx.textChunks.join('\n')
      const fails = []
      if (!t.includes('工具=[delegate]')) {
        fails.push('管理者 tools/list 未见 delegate 工具')
      }
      if (!t.includes('系统提示含群身份=是') || !t.includes('系统提示含群名=是')) {
        fails.push('管理者 appendSystemPrompt 群身份注入缺失')
      }
      if (!t.includes('系统提示角色=管理者')) fails.push('管理者系统提示角色标注错误')
      if (!t.includes('任务前缀角色=管理者')) fails.push('管理者任务前缀角色标注错误')
      return fails
    },
  },
  {
    // P4/P5：普通成员——manager_agent_id 是 worker-a 而非本 Agent。角色标注为
    // 成员，tools/list 为空；越权直调 delegate 必须被 NOT_MANAGER 本地拒绝，
    // 且不得产生任何 task.invoke（不打扰网关）。
    name: 'group-member',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    group: { ...GROUP, manager_agent_id: TARGET_AGENT_ID },
    verify(ctx) {
      const t = ctx.textChunks.join('\n')
      const fails = []
      if (!t.includes('工具=[]')) fails.push('成员 tools/list 应为空（无 delegate）')
      if (!t.includes('系统提示角色=成员')) fails.push('成员系统提示角色标注错误')
      if (!t.includes('任务前缀角色=成员')) fails.push('成员任务前缀角色标注错误')
      if (!t.includes('直调结果=被拒绝=是') || !t.includes('当前会话不是本群管理者')) {
        fails.push('成员越权直调 delegate 未被本地结构化拒绝（期望 isError + 非管理者文案）')
      }
      if (ctx.outboundRequests.length > 0) {
        fails.push(`成员直调不应产生任何网关请求，实际: [${ctx.outboundRequests.join(', ')}]`)
      }
      return fails
    },
  },
  {
    // P2：metadata 不带 workdir 时，会话绑定启动参数 --workdir（首任务绑定），
    // 子进程 cwd 与规范化后的绑定目录一致。
    name: 'workdir-default',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    group: null,
    verify(ctx) {
      const expected = `cwd=${realpathSync(ctx.workdir)}`
      return ctx.textChunks.join('\n').includes(expected)
        ? []
        : [`子进程 cwd 未绑定默认 workdir（期望含「${expected}」）`]
    },
  },
  {
    // P2：两个会话各自用 metadata.workdir 绑定不同目录，互不影响（各自 spawn
    // 独立子进程，cwd 各自落在自己的绑定目录）。
    name: 'workdir-two-sessions',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    completedTarget: 2,
    startTasks(ctx, { send, nextId }) {
      ctx.dirA = join(ctx.workdir, 'dir-a')
      ctx.dirB = join(ctx.workdir, 'dir-b')
      mkdirSync(ctx.dirA, { recursive: true })
      mkdirSync(ctx.dirB, { recursive: true })
      for (const [tag, dir] of [['a', ctx.dirA], ['b', ctx.dirB]]) {
        const sessionId = randomUUID()
        const id = nextId()
        ctx.pendingCreateIds.add(id)
        ctx.sessionIds.add(sessionId)
        send({
          jsonrpc: '2.0',
          id,
          method: 'task.create',
          params: {
            task_id: `${ctx.taskId}-${tag}`,
            session_id: sessionId,
            type: 'chat',
            content: '探针',
            metadata: { workdir: dir },
          },
        })
      }
    },
    verify(ctx) {
      const t = ctx.textChunks.join('\n')
      const fails = []
      for (const dir of [ctx.dirA, ctx.dirB]) {
        const expected = `cwd=${realpathSync(dir)}`
        if (!t.includes(expected)) fails.push(`会话子进程 cwd 未落在绑定目录（期望含「${expected}」）`)
      }
      return fails
    },
  },
  {
    // P2：realpath 等价——同一会话首任务用符号链接拼法绑定，第二任务用真实
    // 路径拼法，必须判定一致（不报错、不切换，cwd 落在规范化目录）。
    name: 'workdir-realpath',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    completedTarget: 2,
    startTasks(ctx, { send, nextId }) {
      ctx.realForm = join(ctx.workdir, 'real-dir')
      mkdirSync(ctx.realForm, { recursive: true })
      ctx.linkForm = join(ctx.workdir, 'link-dir')
      symlinkSync(ctx.realForm, ctx.linkForm, 'dir')
      ctx.sessionIds.add(ctx.sessionId)
      for (const [i, dir] of [ctx.linkForm, ctx.realForm].entries()) {
        const id = nextId()
        ctx.pendingCreateIds.add(id)
        send({
          jsonrpc: '2.0',
          id,
          method: 'task.create',
          params: {
            task_id: `${ctx.taskId}-${i}`,
            session_id: ctx.sessionId,
            type: 'chat',
            content: '探针',
            metadata: { workdir: dir },
          },
        })
      }
    },
    verify(ctx) {
      const fails = []
      const bound = realpathSync(ctx.realForm)
      // 装置前提：链接拼法确实经符号链接跳转（否则本场景无判别力）。
      if (realpathSync(ctx.linkForm) === ctx.linkForm) {
        fails.push('装置前提失败：链接拼法未发生符号链接跳转')
      }
      if (realpathSync(ctx.linkForm) !== bound) {
        fails.push('装置前提失败：符号链接 realpath 不等于目标目录')
      }
      const t = ctx.textChunks.join('\n')
      const hits = t.split(`cwd=${bound}`).length - 1
      if (hits < 2) {
        fails.push(`两个任务的子进程 cwd 未都落在绑定目录（期望 2 次「cwd=${bound}」，实际 ${hits} 次）`)
      }
      return fails
    },
  },
  {
    // P2：metadata.workdir 不存在 → task.create 直接 -32602，不产生 ack/会话。
    name: 'workdir-invalid',
    expectAck: false,
    expectEnd: 'errorResponse',
    expectedErrorCode: -32602,
    timeoutMs: 45_000,
    expectedTargets: [],
    group: null,
    workdir: join(rootWorkdir, 'workdir-invalid', '不存在的目录'),
    verify(ctx) {
      return ctx.errorResponses.some(e => e.code === -32602)
        ? []
        : ['未收到 -32602 workdir 校验错误应答']
    },
  },
  {
    // P3/契约确认 6：/model 由 shim 本地执行（不走 LLM、不产生 task.invoke），
    // 结果以 text chunk + task.completed 收尾；fake 子进程上报 fake-model 供可选校验。
    name: 'command-model',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    group: null,
    command: { name: 'model', args: { model: 'fake-model' } },
    content: '切换模型',
    verify(ctx) {
      const t = ctx.textChunks.join('\n')
      return t.includes('已切换模型') && t.includes('fake-model')
        ? []
        : [`未观测到模型切换结果（期望含「已切换模型」与「fake-model」）: ${t.slice(0, 200)}`]
    },
  },
  {
    // P3/契约确认 6：/permission 由 shim 本地执行（commit-after-confirm），
    // 启动档位 acceptEdits → default，文案如实反映前后档位。
    name: 'command-permission',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    group: null,
    command: { name: 'permission', args: { mode: 'default' } },
    content: '切换权限',
    verify(ctx) {
      const t = ctx.textChunks.join('\n')
      return t.includes('已切换权限模式：acceptEdits → default')
        ? []
        : [`未观测到权限切换结果（期望「已切换权限模式：acceptEdits → default」）: ${t.slice(0, 200)}`]
    },
  },
  {
    // P3/契约确认 8：可 headless 执行的命令（kind=command）还原为斜杠文本喂子进程。
    name: 'command-compact',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    group: null,
    command: { name: 'compact' },
    content: '压缩一下上下文',
    verify(ctx) {
      return ctx.textChunks.join('\n').includes('收到任务：/compact')
        ? []
        : [`命令未还原为斜杠文本（期望子进程收到「/compact」）: ${ctx.textChunks.join('\n').slice(0, 200)}`]
    },
  },
  {
    // P3/契约确认 8：kind=skill 的命令同样按斜杠还原（isSessionCommand 不区分 kind）。
    name: 'command-skill',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    group: null,
    command: { name: 'review' },
    content: '帮我审查代码',
    verify(ctx) {
      return ctx.textChunks.join('\n').includes('收到任务：/review')
        ? []
        : [`技能未还原为斜杠文本（期望子进程收到「/review」）: ${ctx.textChunks.join('\n').slice(0, 200)}`]
    },
  },
  {
    // P3/契约确认 8：会话能力列表之外的命令不做斜杠还原，content 原样喂给模型。
    name: 'command-unsupported-local',
    expectEnd: 'completed',
    timeoutMs: 45_000,
    expectedTargets: [],
    group: null,
    command: { name: 'nonexistent-cmd' },
    content: '随便聊聊',
    verify(ctx) {
      const t = ctx.textChunks.join('\n')
      const fails = []
      if (!t.includes('收到任务：随便聊聊')) {
        fails.push(`未识别命令的 content 未原样透传（期望「随便聊聊」）: ${t.slice(0, 200)}`)
      }
      if (t.includes('/nonexistent-cmd')) fails.push('未识别命令被错误地斜杠还原')
      return fails
    },
  },
]

/** 各场景共用的 task.invoke 路由字段断言（受信值全部来自 shim 状态）。 */
function verifyInvoke(ctx, scenario) {
  const fails = []
  const expectedTargets = [...(scenario.expectedTargets ?? [TARGET_AGENT_ID])].sort()
  if (ctx.invokeCount !== expectedTargets.length) {
    fails.push(`期望恰好 ${expectedTargets.length} 条 task.invoke，实际 ${ctx.invokeCount} 条`)
    return fails
  }
  for (const p of ctx.invokeParamsList) {
    if (p.parent_task_id !== ctx.taskId) {
      fails.push(`task.invoke parent_task_id 期望 ${ctx.taskId}，实际 ${String(p.parent_task_id)}`)
    }
    if (p.group_id !== GROUP_ID) {
      fails.push(`task.invoke group_id 期望 ${GROUP_ID}，实际 ${String(p.group_id)}`)
    }
    if (p.type !== 'chat') fails.push(`task.invoke type 期望 chat，实际 ${String(p.type)}`)
    if (typeof p.content !== 'string' || !p.content.trim()) {
      fails.push('task.invoke content 缺失或为空')
    }
  }
  const targets = ctx.invokeParamsList.map(p => String(p.target_agent_id)).sort()
  if (JSON.stringify(targets) !== JSON.stringify(expectedTargets)) {
    fails.push(`task.invoke target_agent_id 集合期望 [${expectedTargets}]，实际 [${targets}]`)
  }
  return fails
}

function runScenario(scenario) {
  return new Promise(resolvePromise => {
    const workdir = join(rootWorkdir, scenario.name)
    rmSync(workdir, { recursive: true, force: true })
    mkdirSync(workdir, { recursive: true })
    // shim 产物 + 同名 cli.mjs 的 fake 子进程放入独立临时目录（见文件头原理说明）。
    const binDir = mkdtempSync(join(tmpdir(), `ywmatrix-mock-${scenario.name}-`))
    copyFileSync(DIST_SHIM, join(binDir, 'ywmatrix-shim.mjs'))
    copyFileSync(FAKE_CHILD, join(binDir, 'cli.mjs'))
    // shim 产物并非完全自包含：@opentelemetry/*（与 sharp）按 external 处理，
    // 从所在目录向上解析 node_modules。在临时目录里软链回仓库的 node_modules。
    const repoNodeModules = join(__dirname, '..', '..', '..', 'node_modules')
    mkdirSync(join(binDir, 'node_modules'), { recursive: true })
    for (const pkg of ['@opentelemetry', 'sharp']) {
      const target = join(repoNodeModules, pkg)
      if (existsSync(target)) symlinkSync(target, join(binDir, 'node_modules', pkg), 'dir')
    }

    const ctx = {
      workdir,
      taskId: `task-${scenario.name}-${Date.now()}`,
      sessionId: randomUUID(),
      adoptedSessionId: null,
      /** 本场景预期出现的全部 session_id（多会话场景由 startTasks 重建）。 */
      sessionIds: new Set(),
      /** 已发出未应答的 task.create 请求 id。 */
      pendingCreateIds: new Set(),
      /** task.create ack 回传的 session_id 集合。 */
      ackedSessions: new Set(),
      sessionIdConsistent: true,
      sawNonJsonl: false,
      sawCompleted: false,
      sawErrorEvent: false,
      /** 全部 task.completed 的 {taskId, sessionId, summary}（多任务场景断言用）。 */
      completedList: [],
      /** 收到的 JSON-RPC error 应答 {id, code, message}。 */
      errorResponses: [],
      invokeCount: 0,
      invokeParamsList: [],
      /** shim→mock 方向的全部 JSON-RPC 请求方法名（带 id 的）。 */
      outboundRequests: [],
      /** stream.chunk type=result 的内容文本与 is_error 标记。 */
      resultChunks: [],
      resultTexts: [],
      /** stream.chunk type=text 的文本（父任务汇总断言用）。 */
      textChunks: [],
      timers: [],
    }
    // 注意：sessionIds 不在此预登记——defaultStartTasks / scenario.startTasks
    // 各自登记自己真正创建的会话，ack 断言只针对实际发出的 task.create。

    console.log(`\n=== [${scenario.name}] spawn: ${process.execPath} ${join(binDir, 'ywmatrix-shim.mjs')}`)
    const child = spawn(
      process.execPath,
      [join(binDir, 'ywmatrix-shim.mjs'), '--workdir', workdir, '--permission-mode', 'acceptEdits'],
      {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, YWMATRIX_FAKE_SCENARIO: scenario.name },
      },
    )

    let requestSeq = 0
    const nextId = () => `mock-${scenario.name}-${++requestSeq}`
    function send(obj) {
      const json = JSON.stringify(obj)
      console.log(`[mock→shim] ${json}`)
      child.stdin.write(`${json}\n`)
    }

    const initId = nextId()
    let finished = false

    /** 默认开局：注册后发一条 task.create（群/命令/workdir 由场景字段决定）。 */
    const defaultStartTasks = () => {
      const id = nextId()
      ctx.pendingCreateIds.add(id)
      ctx.sessionIds.add(ctx.sessionId)
      send({
        jsonrpc: '2.0',
        id,
        method: 'task.create',
        params: {
          task_id: ctx.taskId,
          session_id: ctx.sessionId,
          type: 'chat',
          content: scenario.content ?? '请把子任务委派给 worker-a 并汇总结果。',
          metadata: {
            // group 缺省为管理者群装置；显式 null 表示单聊（不带 metadata.group）。
            ...(scenario.group === null ? {} : { group: scenario.group ?? GROUP }),
            ...(scenario.command ? { command: scenario.command } : {}),
            // 显式 metadata.workdir（P2 首任务绑定）；缺省回落到启动参数 --workdir。
            ...(scenario.workdir !== undefined ? { workdir: scenario.workdir } : {}),
          },
        },
      })
    }

    function finish(hardFails) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const t of ctx.timers) clearTimeout(t)

      const fails = [...hardFails]
      if (ctx.sawNonJsonl) fails.push('stdout 出现非 JSONL 行（协议污染）')
      if (scenario.expectAck !== false) {
        const acked = [...ctx.ackedSessions]
        if (acked.length !== ctx.sessionIds.size || !acked.every(s => ctx.sessionIds.has(s))) {
          fails.push(
            `task.create ack 未回传预期 session_id（期望 ${ctx.sessionIds.size} 个，实际 [${acked.join(',')}]）`,
          )
        }
      }
      if (!ctx.sessionIdConsistent) fails.push('输出中的 session_id 超出预期集合')
      if (scenario.expectEnd === 'completed' && !ctx.sawCompleted) {
        fails.push('未收到 task.completed')
      }
      if (scenario.expectEnd === 'error' && !ctx.sawErrorEvent) {
        fails.push('未收到 event.error')
      }
      if (scenario.expectEnd === 'errorResponse' && ctx.errorResponses.length === 0) {
        fails.push('未收到 JSON-RPC error 应答')
      }
      fails.push(...verifyInvoke(ctx, scenario))
      fails.push(...scenario.verify(ctx))

      console.log(
        `[${scenario.name}] 观测: completed=${ctx.completedList.length} error=${ctx.sawErrorEvent} ` +
          `invoke=${ctx.invokeCount} result块=${ctx.resultChunks.length} ` +
          `stdout洁净=${!ctx.sawNonJsonl} 出站请求=[${ctx.outboundRequests.join(',')}]`,
      )
      for (const f of fails) console.error(`[${scenario.name}] FAIL: ${f}`)

      // 无悬挂判据：stdin EOF 后 shim 必须干净退出（shutdown 会收尾全部未决委派）。
      // 若 exit 已先于 finish 发生（提前退出路径），跳过等待直接收尾。
      let settled = false
      function settle() {
        if (settled) return
        settled = true
        clearTimeout(exitTimer)
        rmSync(binDir, { recursive: true, force: true })
        console.log(fails.length === 0 ? `[${scenario.name}] PASS` : `[${scenario.name}] FAIL`)
        resolvePromise(fails.length === 0)
      }
      const exitTimer = setTimeout(() => {
        fails.push('shim 未随 stdin EOF 退出（疑似悬挂 Promise）')
        child.kill('SIGKILL')
        settle()
      }, 5_000)
      if (child.exitCode !== null || child.signalCode !== null) {
        settle()
        return
      }
      child.stdin.end()
      child.on('exit', (code, signal) => {
        clearTimeout(exitTimer)
        if (code !== 0 && signal !== 'SIGTERM') {
          fails.push(`shim 退出码异常 code=${code} signal=${signal}`)
        }
        settle()
      })
    }

    const timer = setTimeout(() => {
      finish([`超时 ${scenario.timeoutMs}ms 内未结束`])
    }, scenario.timeoutMs)

    const stdoutRl = createInterface({ input: child.stdout })
    stdoutRl.on('line', line => {
      console.log(`[shim→mock] ${line.length > 1200 ? `${line.slice(0, 900)}…（省略）…${line.slice(-200)}` : line}`)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        ctx.sawNonJsonl = true
        return
      }

      // shim 发出的请求（带 id + method）：目前只应有 task.invoke。
      if (msg.method && msg.id !== undefined && msg.id !== null) {
        ctx.outboundRequests.push(msg.method)
      }

      if (msg.id === initId && msg.result) {
        send({ jsonrpc: '2.0', method: 'lifecycle.initialized' })
        return
      }

      if (msg.method === 'lifecycle.register') {
        // v3：session_id 由网关侧（mock）生成小写 UUID，随 task.create 携带。
        // 多任务/多会话场景由 scenario.startTasks 自行编排开局。
        if (scenario.startTasks) scenario.startTasks(ctx, { send, nextId })
        else defaultStartTasks()
        return
      }

      // task.create 的 ack：按请求 id 关联，登记回传的 session_id。
      if (msg.result && ctx.pendingCreateIds.has(msg.id)) {
        ctx.pendingCreateIds.delete(msg.id)
        const sid = typeof msg.result.session_id === 'string' ? msg.result.session_id : null
        ctx.adoptedSessionId = sid
        if (sid) ctx.ackedSessions.add(sid)
        return
      }

      if (msg.method === 'task.invoke') {
        ctx.invokeCount += 1
        ctx.invokeParamsList.push(msg.params ?? {})
        scenario.onInvoke?.(ctx, msg, send)
        return
      }

      if (msg.method === 'stream.chunk') {
        const p = msg.params ?? {}
        if (p.session_id && !ctx.sessionIds.has(p.session_id)) {
          ctx.sessionIdConsistent = false
        }
        if (p.type === 'result') {
          const text = JSON.stringify(p.content ?? '')
          ctx.resultChunks.push({ text, isError: Boolean(p.is_error) })
          ctx.resultTexts.push(text)
        }
        if (p.type === 'text') {
          const blocks = Array.isArray(p.content) ? p.content : []
          ctx.textChunks.push(blocks.map(b => String(b?.text ?? '')).join(''))
        }
        return
      }

      if (msg.method === 'task.completed') {
        const p = msg.params ?? {}
        if (p.session_id && !ctx.sessionIds.has(p.session_id)) {
          ctx.sessionIdConsistent = false
        }
        ctx.sawCompleted = true
        ctx.completedList.push({ taskId: p.task_id, sessionId: p.session_id, summary: p.summary })
        // 多任务场景（workdir-two-sessions / workdir-realpath）等全部任务完成再收尾。
        if (ctx.completedList.length < (scenario.completedTarget ?? 1)) return
        finish(
          scenario.expectEnd === 'completed'
            ? []
            : ['期望以 event.error/error 应答中止，却收到 task.completed'],
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

      // mock 侧发出的请求（task.create 等）收到 error 应答。
      if (msg.error) {
        ctx.errorResponses.push({ id: msg.id, code: msg.error.code, message: msg.error.message })
        if (scenario.expectEnd === 'errorResponse') {
          finish(
            msg.error.code === scenario.expectedErrorCode
              ? []
              : [
                  `error 应答 code 期望 ${String(scenario.expectedErrorCode)}，实际 ${String(msg.error.code)}: ${JSON.stringify(msg.error)}`,
                ],
          )
        } else {
          finish([`收到 JSON-RPC error: ${JSON.stringify(msg.error)}`])
        }
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
        clientInfo: { name: 'mock-agentclient-delegation', version: '0.0.1' },
        // v3 C3：网关认可的本 Agent 实例 ID（群管理者判定的受信依据）。
        agentInfo: { agent_id: AGENT_ID },
      },
    })
  })
}

const selected = scenarioArg === 'all' ? SCENARIOS : SCENARIOS.filter(s => s.name === scenarioArg)
if (selected.length === 0) usage()

const results = []
for (const scenario of selected) {
  results.push([scenario.name, await runScenario(scenario)])
}

console.log('\n=== 汇总 ===')
for (const [name, ok] of results) console.log(`${name}: ${ok ? 'PASS' : 'FAIL'}`)
const allOk = results.every(([, ok]) => ok)
console.log(allOk ? '[mock-delegation] PASS' : '[mock-delegation] FAIL')
process.exit(allOk ? 0 : 1)
