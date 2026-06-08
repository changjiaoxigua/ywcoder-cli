// D4-b 专项测试：项目记忆文件 YWCODER.md 优先 + CLAUDE.md 只读兜底。
// 锁住两个核心不变量：
//   1. getMemoryPath（经 resolveMemoryFilePath）用「文件是否存在」解析路径，
//      优先已存在的 YWCODER.md > 已存在的旧 CLAUDE.md > 新建 YWCODER.md。
//      这是读/写/同步取同一文件的关键，也是复核中修掉的「读 A 写 B」分歧来源。
//   2. isMemoryFilePath 同时识别 YWCODER.md / YWCODER.local.md 及旧的
//      CLAUDE.md / CLAUDE.local.md。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { getOriginalCwd, setOriginalCwd } from '../bootstrap/state.js'
import { isMemoryFilePath } from './claudemd.js'
import { getMemoryPath } from './config.js'

describe('getMemoryPath 记忆文件解析（YWCODER.md 优先 / CLAUDE.md 兑底）', () => {
  let tempDir: string
  let savedCwd: string

  beforeEach(async () => {
    savedCwd = getOriginalCwd()
    tempDir = await mkdtemp(join(tmpdir(), 'memfile-'))
    setOriginalCwd(tempDir)
  })

  afterEach(async () => {
    setOriginalCwd(savedCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  test('都不存在（新项目）→ 落到 YWCODER.md', () => {
    expect(getMemoryPath('Project')).toBe(join(tempDir, 'YWCODER.md'))
    expect(getMemoryPath('Local')).toBe(join(tempDir, 'YWCODER.local.md'))
  })

  test('仅旧 CLAUDE.md 存在 → 回退命中 CLAUDE.md（兼容存量项目）', async () => {
    await writeFile(join(tempDir, 'CLAUDE.md'), '# legacy')
    await writeFile(join(tempDir, 'CLAUDE.local.md'), '# legacy local')
    expect(getMemoryPath('Project')).toBe(join(tempDir, 'CLAUDE.md'))
    expect(getMemoryPath('Local')).toBe(join(tempDir, 'CLAUDE.local.md'))
  })

  test('仅 YWCODER.md 存在 → 命中 YWCODER.md', async () => {
    await writeFile(join(tempDir, 'YWCODER.md'), '# yw')
    await writeFile(join(tempDir, 'YWCODER.local.md'), '# yw local')
    expect(getMemoryPath('Project')).toBe(join(tempDir, 'YWCODER.md'))
    expect(getMemoryPath('Local')).toBe(join(tempDir, 'YWCODER.local.md'))
  })

  test('两者并存 → 优先 YWCODER.md（不取旧 CLAUDE.md）', async () => {
    await writeFile(join(tempDir, 'YWCODER.md'), '# yw')
    await writeFile(join(tempDir, 'CLAUDE.md'), '# legacy')
    expect(getMemoryPath('Project')).toBe(join(tempDir, 'YWCODER.md'))
  })

  test('空的 YWCODER.md 也算命中（存在即用，与写入路径一致，避免读写分歧）', async () => {
    await writeFile(join(tempDir, 'YWCODER.md'), '') // 空文件
    await writeFile(join(tempDir, 'CLAUDE.md'), '# legacy 有内容')
    // 即便 YWCODER.md 为空，也以它为准——与读路径 processMemoryFileWithFallback
    // 的「存在即命中」判据一致，不会出现读 CLAUDE.md 却写 YWCODER.md 的分歧。
    expect(getMemoryPath('Project')).toBe(join(tempDir, 'YWCODER.md'))
  })
})

describe('isMemoryFilePath 识别 YWCODER.md 与旧 CLAUDE.md', () => {
  test('识别 YWCODER.md / YWCODER.local.md', () => {
    expect(isMemoryFilePath(join('any', 'dir', 'YWCODER.md'))).toBe(true)
    expect(isMemoryFilePath(join('any', 'dir', 'YWCODER.local.md'))).toBe(true)
  })

  test('仍识别旧 CLAUDE.md / CLAUDE.local.md（兼容）', () => {
    expect(isMemoryFilePath(join('any', 'dir', 'CLAUDE.md'))).toBe(true)
    expect(isMemoryFilePath(join('any', 'dir', 'CLAUDE.local.md'))).toBe(true)
  })

  test('识别 .claude/rules 下的 .md', () => {
    expect(
      isMemoryFilePath(`${sep}proj${sep}.claude${sep}rules${sep}foo.md`),
    ).toBe(true)
  })

  test('不误判普通文件', () => {
    expect(isMemoryFilePath(join('any', 'README.md'))).toBe(false)
    expect(isMemoryFilePath(join('any', 'ywcoder.md'))).toBe(false) // 大小写敏感
    expect(isMemoryFilePath(join('any', 'index.ts'))).toBe(false)
  })
})
