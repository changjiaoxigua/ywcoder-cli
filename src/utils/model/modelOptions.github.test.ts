import { afterEach, expect, test } from 'bun:test'

import { getModelOptions } from './modelOptions.js'
import { getYwCoderEnv } from '../../utils/envUtils.js'

const originalEnv = {
  CLAUDE_CODE_USE_GITHUB: getYwCoderEnv('USE_GITHUB'),
  CLAUDE_CODE_USE_OPENAI: getYwCoderEnv('USE_OPENAI'),
  CLAUDE_CODE_USE_GEMINI: getYwCoderEnv('USE_GEMINI'),
  CLAUDE_CODE_USE_BEDROCK: getYwCoderEnv('USE_BEDROCK'),
  CLAUDE_CODE_USE_VERTEX: getYwCoderEnv('USE_VERTEX'),
  CLAUDE_CODE_USE_FOUNDRY: getYwCoderEnv('USE_FOUNDRY'),
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  ANTHROPIC_CUSTOM_MODEL_OPTION: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
}

afterEach(() => {
  process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = originalEnv.CLAUDE_CODE_USE_GITHUB
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = originalEnv.CLAUDE_CODE_USE_OPENAI
  process.env.YWCODER_USE_GEMINI = process.env.CLAUDE_CODE_USE_GEMINI = originalEnv.CLAUDE_CODE_USE_GEMINI
  process.env.YWCODER_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK = originalEnv.CLAUDE_CODE_USE_BEDROCK
  process.env.YWCODER_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX = originalEnv.CLAUDE_CODE_USE_VERTEX
  process.env.YWCODER_USE_FOUNDRY = process.env.CLAUDE_CODE_USE_FOUNDRY = originalEnv.CLAUDE_CODE_USE_FOUNDRY
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION =
    originalEnv.ANTHROPIC_CUSTOM_MODEL_OPTION
})

test('GitHub provider exposes only default + GitHub model in /model options', () => {
  process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = '1'
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

  process.env.OPENAI_MODEL = 'github:copilot'
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION

  const options = getModelOptions(false)
  const nonDefault = options.filter(option => option.value !== null)

  expect(nonDefault.length).toBe(1)
  expect(nonDefault[0]?.value).toBe('github:copilot')
})
