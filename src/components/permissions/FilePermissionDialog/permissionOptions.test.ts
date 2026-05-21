import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'

import { isInClaudeFolder, isInGlobalClaudeFolder } from './permissionOptions.js'

describe('isInGlobalClaudeFolder', () => {
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

  describe('已迁移用户（YWCODER_CONFIG_DIR=~/.ywcoder）', () => {
    beforeEach(() => {
      process.env.YWCODER_CONFIG_DIR = `${homedir()}/.ywcoder`
    })

    test('~/.ywcoder/settings.json → true（当前目录）', () => {
      expect(isInGlobalClaudeFolder(`${homedir()}/.ywcoder/settings.json`)).toBe(true)
    })

    test('~/.claude/settings.json → true（历史兼容）', () => {
      expect(isInGlobalClaudeFolder(`${homedir()}/.claude/settings.json`)).toBe(true)
    })

    test('~/elsewhere/foo → false', () => {
      expect(isInGlobalClaudeFolder(`${homedir()}/elsewhere/foo`)).toBe(false)
    })

    test('home 下其它无关目录 → false', () => {
      expect(isInGlobalClaudeFolder(`${homedir()}/.ywcoder-fake/foo`)).toBe(false)
    })
  })

  describe('老用户未迁移（YWCODER_CONFIG_DIR=~/.claude）', () => {
    beforeEach(() => {
      process.env.YWCODER_CONFIG_DIR = `${homedir()}/.claude`
    })

    test('~/.claude/settings.json → true', () => {
      expect(isInGlobalClaudeFolder(`${homedir()}/.claude/settings.json`)).toBe(true)
    })

    test('~/.ywcoder/settings.json → false（未迁移用户不应认 .ywcoder）', () => {
      // 此时 candidates 去重后只有 ~/.claude，所以 .ywcoder 路径不命中。
      expect(isInGlobalClaudeFolder(`${homedir()}/.ywcoder/settings.json`)).toBe(false)
    })
  })
})

describe('isInClaudeFolder（项目级，不受全局迁移影响）', () => {
  test('返回值类型正确（具体路径需依赖 getOriginalCwd，此处只做存在性 smoke）', () => {
    expect(typeof isInClaudeFolder('/tmp/foo')).toBe('boolean')
  })
})
