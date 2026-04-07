import { afterEach, expect, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import { parseUserSpecifiedModel } from './model.js'
import { getModelStrings } from './modelStrings.js'
import { getYwCoderEnv } from '../../utils/envUtils.js'

const originalEnv = {
  CLAUDE_CODE_USE_GITHUB: getYwCoderEnv('USE_GITHUB'),
  CLAUDE_CODE_USE_OPENAI: getYwCoderEnv('USE_OPENAI'),
  CLAUDE_CODE_USE_GEMINI: getYwCoderEnv('USE_GEMINI'),
  CLAUDE_CODE_USE_BEDROCK: getYwCoderEnv('USE_BEDROCK'),
  CLAUDE_CODE_USE_VERTEX: getYwCoderEnv('USE_VERTEX'),
  CLAUDE_CODE_USE_FOUNDRY: getYwCoderEnv('USE_FOUNDRY'),
}

function clearProviderFlags(): void {
  delete process.env.YWCODER_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.YWCODER_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.YWCODER_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.YWCODER_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.YWCODER_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.YWCODER_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
}

afterEach(() => {
  process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = originalEnv.CLAUDE_CODE_USE_GITHUB
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = originalEnv.CLAUDE_CODE_USE_OPENAI
  process.env.YWCODER_USE_GEMINI = process.env.CLAUDE_CODE_USE_GEMINI = originalEnv.CLAUDE_CODE_USE_GEMINI
  process.env.YWCODER_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK = originalEnv.CLAUDE_CODE_USE_BEDROCK
  process.env.YWCODER_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX = originalEnv.CLAUDE_CODE_USE_VERTEX
  process.env.YWCODER_USE_FOUNDRY = process.env.CLAUDE_CODE_USE_FOUNDRY = originalEnv.CLAUDE_CODE_USE_FOUNDRY
  resetModelStringsForTestingOnly()
})

test('GitHub provider model strings are concrete IDs', () => {
  clearProviderFlags()
  process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = '1'

  const modelStrings = getModelStrings()

  for (const value of Object.values(modelStrings)) {
    expect(typeof value).toBe('string')
    expect(value.trim().length).toBeGreaterThan(0)
  }
})

test('GitHub provider model strings are safe to parse', () => {
  clearProviderFlags()
  process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = '1'

  const modelStrings = getModelStrings()

  expect(() => parseUserSpecifiedModel(modelStrings.sonnet46 as any)).not.toThrow()
})
