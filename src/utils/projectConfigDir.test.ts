import { describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getProjectConfigDirVariants,
  getProjectConfigDir,
  getProjectConfigWriteDir,
  resolveProjectConfigDir,
  resolveProjectConfigWriteDir,
} from './projectConfigDir.js'

function withTempBase(fn: (base: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'ywcoder-projcfg-'))
  try {
    fn(base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

// `bun test` 下 bun:bundle 的 feature() 恒返回 false（flag OFF），无法直接测 ON 分支。
// 故 ON 行为用纯解析器 resolve*（显式 migrate 参数）覆盖；公开 getter 仅能验证 OFF。
describe('projectConfigDir · 纯解析器 resolve*（覆盖 flag on/off 两种）', () => {
  describe('migrate=true（flag ON → .ywcoder active-dir）', () => {
    test('write 永远落 .ywcoder（即使两者都不存在，不回退建 .claude）', () => {
      withTempBase(base => {
        expect(resolveProjectConfigWriteDir(base, true)).toBe(
          join(base, '.ywcoder'),
        )
      })
    })

    test('read：.ywcoder 存在 → 用 .ywcoder（即使 .claude 也在）', () => {
      withTempBase(base => {
        mkdirSync(join(base, '.ywcoder'))
        mkdirSync(join(base, '.claude'))
        expect(resolveProjectConfigDir(base, true)).toBe(join(base, '.ywcoder'))
      })
    })

    test('read：仅 .claude 存在（未迁移）→ 回退 .claude', () => {
      withTempBase(base => {
        mkdirSync(join(base, '.claude'))
        expect(resolveProjectConfigDir(base, true)).toBe(join(base, '.claude'))
      })
    })

    test('read：两者都不存在（全新项目）→ 默认 .ywcoder', () => {
      withTempBase(base => {
        expect(resolveProjectConfigDir(base, true)).toBe(join(base, '.ywcoder'))
      })
    })
  })

  describe('migrate=false（flag OFF → 恒用旧 .claude，原版行为）', () => {
    test('write 恒落 .claude', () => {
      withTempBase(base => {
        expect(resolveProjectConfigWriteDir(base, false)).toBe(
          join(base, '.claude'),
        )
      })
    })

    test('read 恒返回 .claude（即使 .ywcoder 存在也不用）', () => {
      withTempBase(base => {
        mkdirSync(join(base, '.ywcoder'))
        expect(resolveProjectConfigDir(base, false)).toBe(join(base, '.claude'))
      })
    })

    test('read 恒返回 .claude（全新项目，两者都不存在）', () => {
      withTempBase(base => {
        expect(resolveProjectConfigDir(base, false)).toBe(join(base, '.claude'))
      })
    })
  })
})

describe('projectConfigDir · 公开 getter（受编译期 flag 门控）', () => {
  // 断言测试环境确实是 flag OFF；若将来在 ON 构建下跑测试，下方期望需相应调整。
  test('测试环境 feature(MIGRATE_PROJECT_CONFIG) = OFF', () => {
    let on = false
    if (feature('MIGRATE_PROJECT_CONFIG')) on = true
    expect(on).toBe(false)
  })

  test('flag OFF：getProjectConfigWriteDir 落 .claude', () => {
    withTempBase(base => {
      expect(getProjectConfigWriteDir(base)).toBe(join(base, '.claude'))
    })
  })

  test('flag OFF：getProjectConfigDir 恒 .claude（即使 .ywcoder 存在）', () => {
    withTempBase(base => {
      mkdirSync(join(base, '.ywcoder'))
      expect(getProjectConfigDir(base)).toBe(join(base, '.claude'))
    })
  })
})

describe('projectConfigDir · variants（不受 flag 影响，恒认两边）', () => {
  test('variants 返回两个变体，供权限/匹配认两边', () => {
    withTempBase(base => {
      expect(getProjectConfigDirVariants(base)).toEqual([
        join(base, '.ywcoder'),
        join(base, '.claude'),
      ])
    })
  })
})
