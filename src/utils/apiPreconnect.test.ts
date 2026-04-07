import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { getYwCoderEnv } from '../utils/envUtils.js'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

async function importFreshModule() {
  mock.restore()
  return import(`./apiPreconnect.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  mock.restore()
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('preconnectAnthropicApi', () => {
  test('does not fetch when OpenAI mode is enabled', async () => {
    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
    // Clear proxy env vars to ensure we test the right code path
    delete process.env.HTTPS_PROXY
    delete process.env.https_proxy
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy

    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not fetch when Gemini mode is enabled', async () => {
    process.env.YWCODER_USE_GEMINI = process.env.CLAUDE_CODE_USE_GEMINI = '1'
    // Clear proxy env vars to ensure we test the right code path
    delete process.env.HTTPS_PROXY
    delete process.env.https_proxy
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy

    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not fetch when GitHub mode is enabled', async () => {
    process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = '1'
    // Clear proxy env vars to ensure we test the right code path
    delete process.env.HTTPS_PROXY
    delete process.env.https_proxy
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy

    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('fetches in first-party mode', async () => {
    // Ensure no provider flags are set
    delete process.env.YWCODER_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.YWCODER_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.YWCODER_USE_GITHUB
    delete process.env.CLAUDE_CODE_USE_GITHUB
    delete process.env.YWCODER_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.YWCODER_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.YWCODER_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    // Clear proxy env vars that would cause preconnect to skip
    delete process.env.HTTPS_PROXY
    delete process.env.https_proxy
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy

    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
