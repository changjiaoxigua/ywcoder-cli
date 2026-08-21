/**
 * P2 —— workdirPolicy 单测：workdir 校验/realpath 规范化、分桶存在性判断。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离配置目录：getProjectDir 推导的分桶落在 $YWCODER_CONFIG_HOME/projects 下，
// 不设置则会写真实 ~/.ywcoder/projects（沙箱环境下会被拒绝，也污染用户目录）。
// 必须在首次调用 getProjectDir 之前设置（envUtils 按该值 memoize）。
process.env.YWCODER_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'yw-config-'))

import { getProjectDir } from '../../utils/sessionStorage.js'
import { sessionIdExistsIn, validateWorkdir } from './workdirPolicy.js'

describe('validateWorkdir', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yw-workdir-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('相对路径/空串 → 拒绝', () => {
    expect(validateWorkdir('').ok).toBe(false)
    expect(validateWorkdir('relative/path').ok).toBe(false)
  })

  test('不存在的路径 → 拒绝', () => {
    const r = validateWorkdir(join(dir, 'no-such-dir'))
    expect(r.ok).toBe(false)
  })

  test('文件而不是目录 → 拒绝', () => {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'x')
    const r = validateWorkdir(f)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('不是目录')
  })

  test('合法目录 → 通过并 realpath 规范化', () => {
    const r = validateWorkdir(dir)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // macOS 上 /tmp 是 /private/tmp 的符号链接，返回值必须是 realpath 后的。
      expect(r.workdir.startsWith('/')).toBe(true)
    }
  })

  test('符号链接目录 → 规范化到真实路径', () => {
    const real = join(dir, 'real')
    mkdirSync(real)
    const link = join(dir, 'link')
    symlinkSync(real, link)
    const r1 = validateWorkdir(link)
    const r2 = validateWorkdir(real)
    expect(r1.ok && r2.ok).toBe(true)
    if (r1.ok && r2.ok) expect(r1.workdir).toBe(r2.workdir)
  })
})

describe('sessionIdExistsIn', () => {
  test('按给定 workdir 的分桶查找会话文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yw-bucket-'))
    const r = validateWorkdir(dir)
    if (!r.ok) throw new Error('workdir 校验失败')
    const projectDir = getProjectDir(r.workdir)
    try {
      const sid = '123e4567-e89b-42d3-a456-426614174000'
      expect(sessionIdExistsIn(sid, r.workdir)).toBe(false)
      // 在推导出的分桶里放一个会话文件 → 存在。
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, `${sid}.jsonl`), '')
      expect(sessionIdExistsIn(sid, r.workdir)).toBe(true)
      // 另一个 workdir 的分桶不受影响。
      const dir2 = mkdtempSync(join(tmpdir(), 'yw-bucket2-'))
      try {
        const r2 = validateWorkdir(dir2)
        if (!r2.ok) throw new Error('workdir2 校验失败')
        expect(sessionIdExistsIn(sid, r2.workdir)).toBe(false)
      } finally {
        rmSync(dir2, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
      // 清理写入 ywcoder projects 目录的测试分桶。
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
