import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getProjectConfigDirVariants,
  getProjectConfigDir,
  getProjectConfigWriteDir,
} from './projectConfigDir.js'

function withTempBase(fn: (base: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'ywcoder-projcfg-'))
  try {
    fn(base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

describe('projectConfigDir', () => {
  test('write 永远落 .ywcoder（即使两者都不存在，不回退建 .claude）', () => {
    withTempBase(base => {
      expect(getProjectConfigWriteDir(base)).toBe(join(base, '.ywcoder'))
    })
  })

  test('read：.ywcoder 存在 → 用 .ywcoder（即使 .claude 也在）', () => {
    withTempBase(base => {
      mkdirSync(join(base, '.ywcoder'))
      mkdirSync(join(base, '.claude'))
      expect(getProjectConfigDir(base)).toBe(join(base, '.ywcoder'))
    })
  })

  test('read：仅 .claude 存在（未迁移）→ 回退 .claude', () => {
    withTempBase(base => {
      mkdirSync(join(base, '.claude'))
      expect(getProjectConfigDir(base)).toBe(join(base, '.claude'))
    })
  })

  test('read：两者都不存在（全新项目）→ 默认 .ywcoder', () => {
    withTempBase(base => {
      expect(getProjectConfigDir(base)).toBe(join(base, '.ywcoder'))
    })
  })

  test('variants 返回两个变体，供权限/匹配认两边', () => {
    withTempBase(base => {
      expect(getProjectConfigDirVariants(base)).toEqual([
        join(base, '.ywcoder'),
        join(base, '.claude'),
      ])
    })
  })
})
