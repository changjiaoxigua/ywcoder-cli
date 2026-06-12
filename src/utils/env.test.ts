import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileSuffixForOauthConfig } from '../constants/oauth.js'
import { getGlobalClaudeFile } from './env.js'

// D7 Stage 3：全局配置文件（auth）路径解析的三分支。memoize 无 resolver，故每个场景前清缓存。
// 用 CLAUDE_CONFIG_DIR 指向临时目录——getYwCoderConfigHomeDir 在 env 设置时直接返回它，
// 故 newConfig=<tmp>/.config.json、legacyFile=<tmp>/.claude{suffix}.json。
describe('getGlobalClaudeFile · 全局 auth 文件路径（Stage 3 三分支）', () => {
  let tmp: string
  let prevClaude: string | undefined
  let prevYwcoder: string | undefined

  function clearCache(): void {
    ;(getGlobalClaudeFile as unknown as { cache: { clear(): void } }).cache.clear()
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ywcoder-globalcfg-'))
    prevClaude = process.env.CLAUDE_CONFIG_DIR
    prevYwcoder = process.env.YWCODER_CONFIG_DIR
    delete process.env.YWCODER_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmp
    clearCache()
  })

  afterEach(() => {
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevClaude
    if (prevYwcoder === undefined) delete process.env.YWCODER_CONFIG_DIR
    else process.env.YWCODER_CONFIG_DIR = prevYwcoder
    clearCache()
    rmSync(tmp, { recursive: true, force: true })
  })

  const newConfig = (): string => join(tmp, '.config.json')
  const legacyFile = (): string =>
    join(tmp, `.claude${fileSuffixForOauthConfig()}.json`)

  test('分支1：.config.json 已存在 → 用新目录配置', () => {
    writeFileSync(newConfig(), '{}')
    expect(getGlobalClaudeFile()).toBe(newConfig())
  })

  test('分支2：仅 legacy .claude.json 存在（未迁移）→ 回退用 legacy，保 auth', () => {
    writeFileSync(legacyFile(), '{}')
    expect(getGlobalClaudeFile()).toBe(legacyFile())
  })

  test('分支3：两者都无（纯新装）→ 落新目录 .config.json（不再生成 .claude.json）', () => {
    expect(getGlobalClaudeFile()).toBe(newConfig())
  })

  test('分支1 优先于分支2：两者都在 → 用新目录（已迁移用户）', () => {
    writeFileSync(newConfig(), '{}')
    writeFileSync(legacyFile(), '{}')
    expect(getGlobalClaudeFile()).toBe(newConfig())
  })
})

// F2：legacy 文件前缀必须跟随 YWCODER_CONFIG_DIR（与 getYwCoderConfigHomeDir 对齐），
// 否则只设 YWCODER_CONFIG_DIR 时，机器存量 ~/.claude.json（或 CLAUDE_CONFIG_DIR 下的）会被
// 误命中，抢走自定义目录的新装默认。
describe('getGlobalClaudeFile · legacy 前缀跟随 YWCODER_CONFIG_DIR（F2）', () => {
  let tmpY: string
  let tmpC: string
  let prevClaude: string | undefined
  let prevYwcoder: string | undefined

  function clearCache(): void {
    ;(getGlobalClaudeFile as unknown as { cache: { clear(): void } }).cache.clear()
  }

  beforeEach(() => {
    tmpY = mkdtempSync(join(tmpdir(), 'ywcoder-f2-y-'))
    tmpC = mkdtempSync(join(tmpdir(), 'ywcoder-f2-c-'))
    prevClaude = process.env.CLAUDE_CONFIG_DIR
    prevYwcoder = process.env.YWCODER_CONFIG_DIR
    process.env.YWCODER_CONFIG_DIR = tmpY
    process.env.CLAUDE_CONFIG_DIR = tmpC
    clearCache()
  })

  afterEach(() => {
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevClaude
    if (prevYwcoder === undefined) delete process.env.YWCODER_CONFIG_DIR
    else process.env.YWCODER_CONFIG_DIR = prevYwcoder
    clearCache()
    rmSync(tmpY, { recursive: true, force: true })
    rmSync(tmpC, { recursive: true, force: true })
  })

  test('legacy 仅在 CLAUDE_CONFIG_DIR 下存在 → 不抢走，落 YWCODER_CONFIG_DIR 新装默认', () => {
    // 旧逻辑 legacyFile 用 CLAUDE_CONFIG_DIR=tmpC，会命中此文件；修复后用 YWCODER_CONFIG_DIR=tmpY。
    writeFileSync(join(tmpC, `.claude${fileSuffixForOauthConfig()}.json`), '{}')
    expect(getGlobalClaudeFile()).toBe(join(tmpY, '.config.json'))
  })

  test('legacy 在 YWCODER_CONFIG_DIR 下存在 → 仍正确命中（保 auth）', () => {
    const legacy = join(tmpY, `.claude${fileSuffixForOauthConfig()}.json`)
    writeFileSync(legacy, '{}')
    expect(getGlobalClaudeFile()).toBe(legacy)
  })
})
