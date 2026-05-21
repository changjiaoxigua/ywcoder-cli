import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'

import {
  getGlobalConfigCompatPrefixes,
  getGlobalConfigDirCandidates,
  getGlobalConfigPermissionPattern,
} from './globalConfigPattern.js'

// getYwCoderConfigHomeDir 是 memoized 的，key = YWCODER_CONFIG_DIR ?? CLAUDE_CONFIG_DIR。
// 测试时通过显式 env 切换 key，让 helper 返回受控值，避免依赖文件系统。
describe('globalConfigPattern', () => {
  let originalYwcoder: string | undefined
  let originalClaude: string | undefined

  beforeEach(() => {
    originalYwcoder = process.env.YWCODER_CONFIG_DIR
    originalClaude = process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(() => {
    if (originalYwcoder === undefined) delete process.env.YWCODER_CONFIG_DIR
    else process.env.YWCODER_CONFIG_DIR = originalYwcoder
    if (originalClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaude
  })

  describe('getGlobalConfigPermissionPattern', () => {
    test('YWCODER_CONFIG_DIR 指向 home 内子目录 → 返回 ~/... 形式', () => {
      process.env.YWCODER_CONFIG_DIR = `${homedir()}/.ywcoder`
      expect(getGlobalConfigPermissionPattern()).toBe('~/.ywcoder/**')
    })

    test('YWCODER_CONFIG_DIR 指向 home 外目录 → 返回绝对路径形式', () => {
      process.env.YWCODER_CONFIG_DIR = '/tmp/ywcoder-test-xyz'
      expect(getGlobalConfigPermissionPattern()).toBe('/tmp/ywcoder-test-xyz/**')
    })

    test('YWCODER_CONFIG_DIR 指向 ~/.claude（老用户场景）→ 返回 ~/.claude/**', () => {
      process.env.YWCODER_CONFIG_DIR = `${homedir()}/.claude`
      expect(getGlobalConfigPermissionPattern()).toBe('~/.claude/**')
    })
  })

  describe('getGlobalConfigCompatPrefixes', () => {
    test('已迁移用户：当前 ~/.ywcoder + 历史 ~/.claude 两个前缀', () => {
      process.env.YWCODER_CONFIG_DIR = `${homedir()}/.ywcoder`
      const prefixes = getGlobalConfigCompatPrefixes()
      expect(prefixes).toContain('~/.ywcoder/')
      expect(prefixes).toContain('~/.claude/')
      expect(prefixes).toHaveLength(2)
    })

    test('老用户未迁移：当前与历史相同 → 去重后只有一个前缀', () => {
      process.env.YWCODER_CONFIG_DIR = `${homedir()}/.claude`
      expect(getGlobalConfigCompatPrefixes()).toEqual(['~/.claude/'])
    })

    test('自定义 CONFIG_DIR 在 home 外：绝对路径前缀 + 历史 ~/.claude', () => {
      process.env.YWCODER_CONFIG_DIR = '/tmp/ywcoder-custom'
      const prefixes = getGlobalConfigCompatPrefixes()
      expect(prefixes).toContain('/tmp/ywcoder-custom/')
      expect(prefixes).toContain('~/.claude/')
    })
  })

  describe('getGlobalConfigDirCandidates', () => {
    test('已迁移用户：返回 [absolute(.ywcoder), absolute(.claude)] 两个绝对路径', () => {
      process.env.YWCODER_CONFIG_DIR = `${homedir()}/.ywcoder`
      const dirs = getGlobalConfigDirCandidates()
      expect(dirs).toContain(`${homedir()}/.ywcoder`)
      expect(dirs).toContain(`${homedir()}/.claude`)
      expect(dirs).toHaveLength(2)
    })

    test('老用户未迁移：去重后只剩 ~/.claude 绝对路径', () => {
      process.env.YWCODER_CONFIG_DIR = `${homedir()}/.claude`
      expect(getGlobalConfigDirCandidates()).toEqual([`${homedir()}/.claude`])
    })
  })
})
