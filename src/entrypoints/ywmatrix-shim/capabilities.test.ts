/**
 * P3 —— capabilities 构造与过滤单测（两级快照、bypass 准入、命令白名单）。
 */
import { describe, expect, test } from 'bun:test'
import {
  buildGlobalCapabilities,
  buildSessionCapabilities,
  capabilitiesFingerprint,
  isSessionCommand,
} from './capabilities.js'

describe('buildGlobalCapabilities', () => {
  test('默认含 chat 与 /permission；无模型列表时不声明 /model（C7）', () => {
    const caps = buildGlobalCapabilities({
      permissionMode: 'default',
      allowBypassPermissions: false,
    })
    expect(caps.map(c => c.name)).toEqual(['coding', 'permission'])
  })

  test('bypassPermissions 未显式允许时不出现在 options（契约确认 3）', () => {
    const caps = buildGlobalCapabilities({
      permissionMode: 'default',
      allowBypassPermissions: false,
    })
    const perm = caps.find(c => c.name === 'permission')
    expect(perm?.metadata?.args?.[0]?.options).toEqual(['default', 'acceptEdits'])

    const caps2 = buildGlobalCapabilities({
      permissionMode: 'bypassPermissions',
      allowBypassPermissions: true,
    })
    const perm2 = caps2.find(c => c.name === 'permission')
    expect(perm2?.metadata?.args?.[0]?.options).toContain('bypassPermissions')
  })

  test('metadata.current 回写权限模式；模型有 current 才带（契约确认 2/6）', () => {
    const caps = buildGlobalCapabilities({
      permissionMode: 'acceptEdits',
      allowBypassPermissions: false,
      modelOptions: ['k2', 'k1'],
    })
    expect(caps.find(c => c.name === 'permission')?.metadata?.current).toBe('acceptEdits')
    const model = caps.find(c => c.name === 'model')
    expect(model?.metadata?.args?.[0]?.options).toEqual(['k2', 'k1'])
    expect(model?.metadata?.current).toBeUndefined()

    const caps2 = buildGlobalCapabilities({
      permissionMode: 'default',
      allowBypassPermissions: false,
      modelOptions: ['k2'],
      currentModel: 'k2',
    })
    expect(caps2.find(c => c.name === 'model')?.metadata?.current).toBe('k2')
  })

  test('空模型列表视为未知，不声明 /model', () => {
    const caps = buildGlobalCapabilities({
      permissionMode: 'default',
      allowBypassPermissions: false,
      modelOptions: [],
    })
    expect(caps.find(c => c.name === 'model')).toBeUndefined()
  })
})

describe('buildSessionCapabilities（C7：initialize 返回的命令上游已过滤，全量上报）', () => {
  test('普通命令与技能均上报；技能按 v3 约定 type:command + metadata.kind:skill', () => {
    const caps = buildSessionCapabilities([
      { name: 'compact', description: '压缩上下文', kind: 'command' },
      { name: 'review', description: '代码审查', kind: 'skill' },
      { name: 'init' },
    ])
    expect(caps).toEqual([
      { type: 'command', name: 'compact', description: '压缩上下文' },
      {
        type: 'command',
        name: 'review',
        description: '代码审查',
        metadata: { kind: 'skill' },
      },
      { type: 'command', name: 'init' },
    ])
  })

  test('isSessionCommand：按 initialize 返回列表判定可执行性', () => {
    const cmds = [{ name: 'compact' }, { name: 'review' }]
    expect(isSessionCommand(cmds, 'compact')).toBe(true)
    expect(isSessionCommand(cmds, 'nonexistent')).toBe(false)
  })
})

describe('capabilitiesFingerprint', () => {
  test('同内容同序指纹一致，内容变化指纹变化', () => {
    const a = buildGlobalCapabilities({ permissionMode: 'default', allowBypassPermissions: false })
    const b = buildGlobalCapabilities({ permissionMode: 'default', allowBypassPermissions: false })
    const c = buildGlobalCapabilities({ permissionMode: 'acceptEdits', allowBypassPermissions: false })
    expect(capabilitiesFingerprint(a)).toBe(capabilitiesFingerprint(b))
    expect(capabilitiesFingerprint(a)).not.toBe(capabilitiesFingerprint(c))
  })
})
