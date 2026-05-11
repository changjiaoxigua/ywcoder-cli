import { afterEach, describe, expect, mock, test } from 'bun:test'

import { getMaxOutputTokensForModel } from '../services/api/claude.ts'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './context.ts'
import { getYwCoderEnv } from './envUtils.js'

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: getYwCoderEnv('USE_OPENAI'),
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: getYwCoderEnv('MAX_OUTPUT_TOKENS'),
  // 2026-04-30 内网网关 context_length 自报告测试新增
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
}

afterEach(() => {
  if (originalEnv.CLAUDE_CODE_USE_OPENAI === undefined) {
    delete process.env.YWCODER_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_OPENAI
  } else {
    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = originalEnv.CLAUDE_CODE_USE_OPENAI
  }
  if (originalEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS === undefined) {
    delete process.env.YWCODER_MAX_OUTPUT_TOKENS
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  } else {
    process.env.YWCODER_MAX_OUTPUT_TOKENS = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = originalEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  }
  // 2026-04-30 内网网关 context_length 自报告测试新增：恢复 MAX_CONTEXT_TOKENS
  if (originalEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS === undefined) {
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  } else {
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = originalEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  }
})

test('deepseek-chat uses provider-specific context and output caps', () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.YWCODER_MAX_OUTPUT_TOKENS; delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('deepseek-chat')).toBe(128_000)
  expect(getModelMaxOutputTokens('deepseek-chat')).toEqual({
    default: 8_192,
    upperLimit: 8_192,
  })
  expect(getMaxOutputTokensForModel('deepseek-chat')).toBe(8_192)
})

test('deepseek-chat clamps oversized max output overrides to the provider limit', () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.YWCODER_MAX_OUTPUT_TOKENS = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '32000'

  expect(getMaxOutputTokensForModel('deepseek-chat')).toBe(8_192)
})

test('gpt-4o uses provider-specific context and output caps', () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.YWCODER_MAX_OUTPUT_TOKENS; delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('gpt-4o')).toBe(128_000)
  expect(getModelMaxOutputTokens('gpt-4o')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
  expect(getMaxOutputTokensForModel('gpt-4o')).toBe(16_384)
})

test('gpt-4o clamps oversized max output overrides to the provider limit', () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.YWCODER_MAX_OUTPUT_TOKENS = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '32000'

  expect(getMaxOutputTokensForModel('gpt-4o')).toBe(16_384)
})

test('gpt-5.4 family uses provider-specific context and output caps', () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.YWCODER_MAX_OUTPUT_TOKENS; delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('gpt-5.4')).toBe(1_050_000)
  expect(getModelMaxOutputTokens('gpt-5.4')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-mini')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-mini')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-nano')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-nano')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })
})

test('gpt-5.4 family keeps large max output overrides within provider limits', () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.YWCODER_MAX_OUTPUT_TOKENS = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '200000'

  expect(getMaxOutputTokensForModel('gpt-5.4')).toBe(128_000)
  expect(getMaxOutputTokensForModel('gpt-5.4-mini')).toBe(128_000)
  expect(getMaxOutputTokensForModel('gpt-5.4-nano')).toBe(128_000)
})

// 2026-04-30 内网网关 context_length 自报告测试新增
// TC-09：环境变量优先于缓存和硬编码表
test('环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS 优先于缓存和硬编码表', () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '50000'

  expect(getContextWindowForModel('gpt-4o')).toBe(50_000)
})

describe('findCachedModelOption scope 守卫与缓存优先级', () => {
  afterEach(() => {
    mock.restore()
  })

  async function importFreshContext() {
    const nonce = `${Date.now()}-${Math.random()}`
    return import(`./context.ts?ts=${nonce}`)
  }

  // TC-10：缓存命中时优先于硬编码表
  test('缓存命中时优先于硬编码表', async () => {
    mock.module('./config.js', () => ({
      getGlobalConfig: () => ({
        additionalModelOptionsCacheScope: 'openai:http://gw.intra/v1',
        additionalModelOptionsCache: [
          { value: 'gpt-4o', label: 'gpt-4o', contextWindow: 64000 },
        ],
        clientDataCache: {},
      }),
    }))

    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'

    const { getContextWindowForModel } = await importFreshContext()
    expect(getContextWindowForModel('gpt-4o')).toBe(64_000)
  })

  // TC-11：openai scope 匹配时查缓存
  test('openai scope 匹配时查缓存', async () => {
    mock.module('./config.js', () => ({
      getGlobalConfig: () => ({
        additionalModelOptionsCacheScope: 'openai:http://gw.intra/v1',
        additionalModelOptionsCache: [
          { value: 'cached-model', label: 'cached-model', contextWindow: 32768 },
        ],
        clientDataCache: {},
      }),
    }))

    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'

    const { getContextWindowForModel } = await importFreshContext()
    expect(getContextWindowForModel('cached-model')).toBe(32_768)
  })

  // TC-12：非 openai scope 时不查缓存
  test('非 openai scope 时不查缓存', async () => {
    mock.module('./config.js', () => ({
      getGlobalConfig: () => ({
        additionalModelOptionsCacheScope: 'firstParty',
        additionalModelOptionsCache: [
          { value: 'cached-model', label: 'cached-model', contextWindow: 32768 },
        ],
        clientDataCache: {},
      }),
    }))

    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'

    const { getContextWindowForModel } = await importFreshContext()
    // cached-model 不在硬编码表中，scope 不匹配时 findCachedModelOption 返回 undefined
    // 后续 getOpenAIContextWindow 也返回 undefined，最终 fallback 到默认值 200K
    expect(getContextWindowForModel('cached-model')).toBe(200_000)
  })
})
