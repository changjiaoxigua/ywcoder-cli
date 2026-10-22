import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getAnthropicClient } from './client.js'
import { getYwCoderEnv } from '../../utils/envUtils.js'

type FetchType = typeof globalThis.fetch

type ShimClient = {
  beta: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  }
}

const originalFetch = globalThis.fetch
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const originalEnv = {
  CLAUDE_CODE_USE_GEMINI: getYwCoderEnv('USE_GEMINI'),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  YWCODER_INTRANET: process.env.YWCODER_INTRANET,
  CLAUDE_CODE_INTRANET: process.env.CLAUDE_CODE_INTRANET,
  ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: 'compat-version',
    DISPLAY_VERSION: 'display-version',
    PACKAGE_VERSION: 'test-version',
  }
  process.env.YWCODER_USE_GEMINI = process.env.CLAUDE_CODE_USE_GEMINI = '1'
  process.env.GEMINI_API_KEY = 'gemini-test-key'
  process.env.GEMINI_MODEL = 'gemini-2.0-flash'
  process.env.GEMINI_BASE_URL = 'https://gemini.example/v1beta/openai'

  delete process.env.GOOGLE_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  process.env.YWCODER_INTRANET = '0'
  delete process.env.CLAUDE_CODE_INTRANET
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  process.env.YWCODER_USE_GEMINI = process.env.CLAUDE_CODE_USE_GEMINI = originalEnv.CLAUDE_CODE_USE_GEMINI
  process.env.GEMINI_API_KEY = originalEnv.GEMINI_API_KEY
  process.env.GEMINI_MODEL = originalEnv.GEMINI_MODEL
  process.env.GEMINI_BASE_URL = originalEnv.GEMINI_BASE_URL
  process.env.GOOGLE_API_KEY = originalEnv.GOOGLE_API_KEY
  process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_AUTH_TOKEN = originalEnv.ANTHROPIC_AUTH_TOKEN
  if (originalEnv.YWCODER_INTRANET === undefined) delete process.env.YWCODER_INTRANET
  else process.env.YWCODER_INTRANET = originalEnv.YWCODER_INTRANET
  if (originalEnv.CLAUDE_CODE_INTRANET === undefined) delete process.env.CLAUDE_CODE_INTRANET
  else process.env.CLAUDE_CODE_INTRANET = originalEnv.CLAUDE_CODE_INTRANET
  if (originalEnv.ANTHROPIC_CUSTOM_HEADERS === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS
  else process.env.ANTHROPIC_CUSTOM_HEADERS = originalEnv.ANTHROPIC_CUSTOM_HEADERS
  globalThis.fetch = originalFetch
})

test('routes Gemini provider requests through the OpenAI-compatible shim', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-gemini',
        model: 'gemini-2.0-flash',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'gemini ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gemini-2.0-flash',
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'gemini-2.0-flash',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://gemini.example/v1beta/openai/chat/completions')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer gemini-test-key')
  expect(capturedHeaders?.get('user-agent')).toStartWith('ywcoder/test-version ')
  expect(capturedHeaders?.get('user-agent')).not.toContain('claude')
  expect(capturedHeaders?.get('x-ywcoder-session-id')).toBeTruthy()
  expect(capturedHeaders?.get('x-claude-code-session-id')).toBeNull()
  expect(capturedHeaders?.get('x-agent-name')).toBeNull()
  expect(capturedHeaders?.get('x-agent-version')).toBeNull()
  expect(capturedBody?.model).toBe('gemini-2.0-flash')
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'gemini-2.0-flash',
  })
})

test('内网模式的 Gemini 请求使用客户端规范身份头', async () => {
  process.env.YWCODER_INTRANET = '1'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-agent-name: custom\nx-Agent-Version: 99.0.0'
  let capturedHeaders: Headers | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)
    return new Response(JSON.stringify({
      id: 'chatcmpl-identity',
      model: 'gemini-2.0-flash',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const client = (await getAnthropicClient({ maxRetries: 0 })) as unknown as ShimClient
  await client.beta.messages.create({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 8,
    stream: false,
  })

  expect(capturedHeaders?.get('x-agent-name')).toBe('ywcoder')
  expect(capturedHeaders?.get('x-agent-version')).toBe('test-version')
})
