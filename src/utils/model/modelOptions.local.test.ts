import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import { saveGlobalConfig } from '../config.js'
import { getYwCoderEnv } from '../../utils/envUtils.js'

async function importFreshModelOptionsModule() {
  mock.restore()
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./modelOptions.js?ts=${nonce}`)
}

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: getYwCoderEnv('USE_OPENAI'),
  CLAUDE_CODE_USE_CODEX: getYwCoderEnv('USE_CODEX'),
  CLAUDE_CODE_USE_GITHUB: getYwCoderEnv('USE_GITHUB'),
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  YWCODER_INTRANET: process.env.YWCODER_INTRANET,
}

beforeEach(() => {
  mock.restore()
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.YWCODER_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_CODEX
  delete process.env.YWCODER_USE_CODEX
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.YWCODER_USE_GITHUB
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.YWCODER_INTRANET
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = originalEnv.CLAUDE_CODE_USE_OPENAI
  process.env.YWCODER_USE_CODEX = process.env.CLAUDE_CODE_USE_CODEX = originalEnv.CLAUDE_CODE_USE_CODEX
  process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = originalEnv.CLAUDE_CODE_USE_GITHUB
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.YWCODER_INTRANET = originalEnv.YWCODER_INTRANET
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [],
    additionalModelOptionsCacheScope: undefined,
    openaiAdditionalModelOptionsCache: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
    providerProfiles: [],
    activeProviderProfileId: undefined,
  }))
  resetModelStringsForTestingOnly()
  mock.restore()
})

const CODEX_OPTION_VALUES = [
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'codexspark',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.4-mini',
]

test('local openai-compatible gateway hides Codex hardcoded options', async () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:8080/v1'
  process.env.OPENAI_MODEL = 'local-model'

  const { getModelOptions } = await importFreshModelOptionsModule()
  const options = getModelOptions(false)
  const values = options.map((option: { value: unknown }) => option.value)

  for (const codexValue of CODEX_OPTION_VALUES) {
    expect(values).not.toContain(codexValue)
  }
})

test('intranet openai-compatible gateway hides Codex hardcoded options', async () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://10.0.0.1:8080/v1'
  process.env.OPENAI_MODEL = 'intranet-model'

  const { getModelOptions } = await importFreshModelOptionsModule()
  const options = getModelOptions(false)
  const values = options.map((option: { value: unknown }) => option.value)

  for (const codexValue of CODEX_OPTION_VALUES) {
    expect(values).not.toContain(codexValue)
  }
})

test('non-local openai provider still shows Codex hardcoded options', async () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-4o'

  const { getModelOptions } = await importFreshModelOptionsModule()
  const options = getModelOptions(false)
  const values = options.map((option: { value: unknown }) => option.value)

  for (const codexValue of CODEX_OPTION_VALUES) {
    expect(values).toContain(codexValue)
  }
})

test('codex provider still shows Codex hardcoded options', async () => {
  process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/codex'
  process.env.OPENAI_MODEL = 'gpt-5.4'

  const { getModelOptions } = await importFreshModelOptionsModule()
  const options = getModelOptions(false)
  const values = options.map((option: { value: unknown }) => option.value)

  for (const codexValue of CODEX_OPTION_VALUES) {
    expect(values).toContain(codexValue)
  }
})
