import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getMainLoopModelOverride, setMainLoopModelOverride } from '../../bootstrap/state.js'
import { WebSearchTool } from './WebSearchTool.js'

const originalFetch = globalThis.fetch
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const originalModelOverride = getMainLoopModelOverride()
const envNames = [
  'YWCODER_INTRANET', 'CLAUDE_CODE_INTRANET', 'YWCODER_USE_OPENAI',
  'CLAUDE_CODE_USE_OPENAI', 'YWCODER_USE_GEMINI', 'CLAUDE_CODE_USE_GEMINI',
  'YWCODER_USE_ANTHROPIC', 'OPENAI_MODEL', 'OPENAI_BASE_URL',
  'CODEX_API_KEY', 'CHATGPT_ACCOUNT_ID', 'FIRECRAWL_API_KEY',
] as const
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '99.0.0',
    PACKAGE_VERSION: '1.3.2',
  }
  for (const name of envNames) delete process.env[name]
  process.env.YWCODER_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = 'gpt-4o'
  setMainLoopModelOverride('codexplan')
  process.env.CODEX_API_KEY = 'test-key'
  process.env.CHATGPT_ACCOUNT_ID = 'test-account'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setMainLoopModelOverride(originalModelOverride)
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  for (const name of envNames) {
    const value = originalEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test.each([
  ['1', 'ywcoder', '1.3.2'],
  ['0', null, null],
])('Codex WebSearch 直连请求在内网模式 %s 时上送身份头', async (intranet, agentName, agentVersion) => {
  process.env.YWCODER_INTRANET = intranet
  let capturedHeaders: Headers | undefined
  let capturedUrl: string | undefined
  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input)
    capturedHeaders = new Headers(init?.headers)
    return new Response(
      'event: response.completed\ndata: {"response":{"output":[]}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }) as typeof fetch

  await WebSearchTool.call(
    { query: 'test query' },
    { abortController: new AbortController() } as Parameters<typeof WebSearchTool.call>[1],
    undefined as never,
    undefined as never,
    undefined as never,
  )

  expect(capturedUrl).toBe('https://chatgpt.com/backend-api/codex/responses')
  expect(capturedHeaders?.get('x-agent-name')).toBe(agentName)
  expect(capturedHeaders?.get('x-agent-version')).toBe(agentVersion)
  expect(capturedHeaders?.get('authorization')).toBe('Bearer test-key')
})
