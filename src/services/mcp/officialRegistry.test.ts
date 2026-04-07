import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'
import { getYwCoderEnv } from '../../utils/envUtils.js'

const originalEnv = { ...process.env }

async function importFreshModule() {
  mock.restore()
  return import(`./officialRegistry.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  mock.restore()
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
  mock.restore()
})

describe('prefetchOfficialMcpUrls', () => {
  test('does not fetch registry when using OpenAI mode', async () => {
    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const getSpy = mock(() => Promise.resolve({ data: { servers: [] } }))
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).not.toHaveBeenCalled()
  })

  test('does not fetch registry when using Gemini mode', async () => {
    process.env.YWCODER_USE_GEMINI = process.env.CLAUDE_CODE_USE_GEMINI = '1'
    const getSpy = mock(() => Promise.resolve({ data: { servers: [] } }))
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).not.toHaveBeenCalled()
  })

  test('fetches registry in first-party mode', async () => {
    delete process.env.YWCODER_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.YWCODER_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.YWCODER_USE_GITHUB
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const getSpy = mock(() =>
      Promise.resolve({
        data: {
          servers: [{ server: { remotes: [{ url: 'https://example.com/mcp' }] } }],
        },
      }),
    )
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls, isOfficialMcpUrl } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(isOfficialMcpUrl('https://example.com/mcp')).toBe(true)
  })
})
