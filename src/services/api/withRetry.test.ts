import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { getYwCoderEnv } from '../../utils/envUtils.js'

// Helper to build a mock APIError with specific headers
function makeError(headers: Record<string, string>): APIError {
  const headersObj = new Headers(headers)
  return {
    headers: headersObj,
    status: 429,
    message: 'rate limit exceeded',
    name: 'APIError',
    error: {},
  } as unknown as APIError
}

// Save/restore env vars between tests
const originalEnv = { ...process.env }

beforeEach(() => {
  mock.restore()
})

afterEach(() => {
  process.env = { ...originalEnv }
  mock.restore()
})

async function importFreshWithRetryModule() {
  mock.restore()
  return import(`./withRetry.js?ts=${Date.now()}-${Math.random()}`)
}

// Helper to setup provider environment
function setupProviderEnv(
  provider:
    | 'firstParty'
    | 'openai'
    | 'github'
    | 'bedrock'
    | 'vertex'
    | 'gemini'
    | 'codex'
    | 'foundry',
) {
  // Clear all provider flags first
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

  // Set the appropriate flag
  switch (provider) {
    case 'openai':
    case 'codex':
      process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
      break
    case 'github':
      process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = '1'
      break
    case 'gemini':
      process.env.YWCODER_USE_GEMINI = process.env.CLAUDE_CODE_USE_GEMINI = '1'
      break
    case 'bedrock':
      process.env.YWCODER_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      break
    case 'vertex':
      process.env.YWCODER_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX = '1'
      break
    case 'foundry':
      process.env.YWCODER_USE_FOUNDRY = process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
      break
    case 'firstParty':
    default:
      // No flags set = firstParty
      break
  }
}

// --- parseOpenAIDuration ---
describe('parseOpenAIDuration', () => {
  test('parses seconds: "1s" → 1000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('1s')).toBe(1000)
  })

  test('parses minutes+seconds: "6m0s" → 360000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('6m0s')).toBe(360000)
  })

  test('parses hours+minutes+seconds: "1h30m0s" → 5400000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('1h30m0s')).toBe(5400000)
  })

  test('parses milliseconds: "500ms" → 500', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('500ms')).toBe(500)
  })

  test('parses minutes only: "2m" → 120000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('2m')).toBe(120000)
  })

  test('returns null for empty string', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('')).toBeNull()
  })

  test('returns null for unrecognized format', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('invalid')).toBeNull()
  })
})

// --- getRateLimitResetDelayMs ---
describe('getRateLimitResetDelayMs - Anthropic (firstParty)', () => {
  test('reads anthropic-ratelimit-unified-reset Unix timestamp', async () => {
    setupProviderEnv('firstParty')
    const { getRateLimitResetDelayMs } = await importFreshWithRetryModule()
    const futureUnixSec = Math.floor(Date.now() / 1000) + 60
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(futureUnixSec),
    })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).not.toBeNull()
    expect(delay!).toBeGreaterThan(50_000)
    expect(delay!).toBeLessThanOrEqual(60_000)
  })

  test('returns null when header absent', async () => {
    setupProviderEnv('firstParty')
    const { getRateLimitResetDelayMs } = await importFreshWithRetryModule()
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('returns null when reset is in the past', async () => {
    setupProviderEnv('firstParty')
    const { getRateLimitResetDelayMs } = await importFreshWithRetryModule()
    const pastUnixSec = Math.floor(Date.now() / 1000) - 10
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(pastUnixSec),
    })
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })
})

describe('getRateLimitResetDelayMs - OpenAI provider', () => {
  test('reads x-ratelimit-reset-requests duration string', async () => {
    setupProviderEnv('openai')
    const { getRateLimitResetDelayMs } = await importFreshWithRetryModule()
    const error = makeError({ 'x-ratelimit-reset-requests': '30s' })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).toBe(30_000)
  })

  test('reads x-ratelimit-reset-tokens and picks the larger delay', async () => {
    setupProviderEnv('openai')
    const { getRateLimitResetDelayMs } = await importFreshWithRetryModule()
    const error = makeError({
      'x-ratelimit-reset-requests': '10s',
      'x-ratelimit-reset-tokens': '1m0s',
    })
    // Should use the larger of the two so we don't retry before both reset
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).toBe(60_000)
  })

  test('returns null when no openai rate limit headers present', async () => {
    setupProviderEnv('openai')
    const { getRateLimitResetDelayMs } = await importFreshWithRetryModule()
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('works for github provider too', async () => {
    setupProviderEnv('github')
    const { getRateLimitResetDelayMs } = await importFreshWithRetryModule()
    const error = makeError({ 'x-ratelimit-reset-requests': '5s' })
    expect(getRateLimitResetDelayMs(error)).toBe(5_000)
  })
})

describe('getRateLimitResetDelayMs - providers without reset headers', () => {
  test('returns null for bedrock', async () => {
    setupProviderEnv('bedrock')
    const { getRateLimitResetDelayMs } = await importFreshWithRetryModule()
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(
        Math.floor(Date.now() / 1000) + 60,
      ),
    })
    // Bedrock doesn't use this header — should still return null
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('returns null for vertex', async () => {
    setupProviderEnv('vertex')
    const { getRateLimitResetDelayMs } = await importFreshWithRetryModule()
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })
})
