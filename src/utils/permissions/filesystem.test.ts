import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'

import { getClaudeSkillScope } from './filesystem.js'

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
