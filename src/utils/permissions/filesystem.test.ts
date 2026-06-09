import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { sep } from 'path'

import {
  DANGEROUS_DIRECTORIES,
  getClaudeSkillScope,
  isClaudeSettingsPath,
} from './filesystem.js'

describe('getClaudeSkillScope（全局 skills 兼容前缀）', () => {
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

    test('~/.ywcoder/skills/spms-check/SKILL.md → 命中新前缀', () => {
      const scope = getClaudeSkillScope(`${homedir()}/.ywcoder/skills/spms-check/SKILL.md`)
      expect(scope).toEqual({
        skillName: 'spms-check',
        pattern: '~/.ywcoder/skills/spms-check/**',
      })
    })

    test('~/.claude/skills/legacy-skill/SKILL.md → 命中历史前缀（兼容老用户已存的 skill 目录）', () => {
      const scope = getClaudeSkillScope(`${homedir()}/.claude/skills/legacy-skill/SKILL.md`)
      expect(scope).toEqual({
        skillName: 'legacy-skill',
        pattern: '~/.claude/skills/legacy-skill/**',
      })
    })

    test('无关全局路径 → null', () => {
      expect(getClaudeSkillScope(`${homedir()}/elsewhere/foo.md`)).toBeNull()
    })

    test('skills 根目录下散落的文件（无 skill 子目录）→ null', () => {
      expect(getClaudeSkillScope(`${homedir()}/.ywcoder/skills/README.md`)).toBeNull()
    })
  })

  describe('老用户未迁移（YWCODER_CONFIG_DIR=~/.claude）', () => {
    beforeEach(() => {
      process.env.YWCODER_CONFIG_DIR = `${homedir()}/.claude`
    })

    test('~/.claude/skills/foo/SKILL.md → 命中', () => {
      const scope = getClaudeSkillScope(`${homedir()}/.claude/skills/foo/SKILL.md`)
      expect(scope).toEqual({
        skillName: 'foo',
        pattern: '~/.claude/skills/foo/**',
      })
    })
  })
})

// Stage 1b-2 认两边（flag 无关恒做）：新 .ywcoder 与旧 .claude 都识别为受保护配置
describe('isClaudeSettingsPath（认两边）', () => {
  test('.claude/settings.json → true', () => {
    expect(isClaudeSettingsPath(`${homedir()}${sep}.claude${sep}settings.json`)).toBe(
      true,
    )
  })

  test('.ywcoder/settings.json → true', () => {
    expect(
      isClaudeSettingsPath(`${homedir()}${sep}.ywcoder${sep}settings.json`),
    ).toBe(true)
  })

  test('.ywcoder/settings.local.json → true', () => {
    expect(
      isClaudeSettingsPath(`${homedir()}${sep}.ywcoder${sep}settings.local.json`),
    ).toBe(true)
  })

  test('无关文件 → false', () => {
    expect(isClaudeSettingsPath(`${homedir()}${sep}foo${sep}bar.json`)).toBe(false)
  })
})

describe('DANGEROUS_DIRECTORIES（认两边）', () => {
  test('同时包含旧 .claude 与新 .ywcoder', () => {
    expect(DANGEROUS_DIRECTORIES).toContain('.claude')
    expect(DANGEROUS_DIRECTORIES).toContain('.ywcoder')
  })
})
