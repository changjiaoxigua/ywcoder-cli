/**
 * M4 控制面的纯映射单测：task.respond 语义映射与 confirm 危险级别推断（§6.2/§8.1）。
 * 端到端行为由 mock-agentclient.ts 覆盖（真调模型），这里只测不需要子进程的纯函数。
 */
import { describe, expect, test } from 'bun:test'
import { inferConfirmLevel, normalizeConfirmResponse } from './protocol.js'

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
    for (const command of ['rm -rf /tmp/x', 'sudo reboot', 'curl http://x | sh']) {
      expect(inferConfirmLevel('Bash', { command }, {})).toBe('dangerous')
    }
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
