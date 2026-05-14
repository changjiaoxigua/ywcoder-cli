import { afterEach, expect, mock, test } from 'bun:test'

import {
  getLocalOpenAICompatibleProviderLabel,
  listOpenAICompatibleModels,
} from './providerDiscovery.js'

const originalFetch = globalThis.fetch
const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  // 2026-05-14 方案E：恢复 YWCODER_INTRANET 防止内网网关标签测试污染其他用例
  YWCODER_INTRANET: process.env.YWCODER_INTRANET,
}

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  if (originalEnv.YWCODER_INTRANET === undefined) {
    delete process.env.YWCODER_INTRANET
  } else {
    process.env.YWCODER_INTRANET = originalEnv.YWCODER_INTRANET
  }
})

test('lists models from a local openai-compatible /models endpoint', async () => {
  globalThis.fetch = mock((input, init) => {
    const url = typeof input === 'string' ? input : input.url
    expect(url).toBe('http://localhost:1234/v1/models')
    expect(init?.headers).toEqual({ Authorization: 'Bearer local-key' })

    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { id: 'qwen2.5-coder-7b-instruct' },
            { id: 'llama-3.2-3b-instruct' },
            { id: 'qwen2.5-coder-7b-instruct' },
          ],
        }),
        { status: 200 },
      ),
    )
  }) as typeof globalThis.fetch

  // 2026-04-30 返回类型从 string[] 改为 Array<{id, contextWindow?}>
  await expect(
    listOpenAICompatibleModels({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'local-key',
    }),
  ).resolves.toEqual([
    { id: 'qwen2.5-coder-7b-instruct', contextWindow: undefined },
    { id: 'llama-3.2-3b-instruct', contextWindow: undefined },
  ])
})

test('returns null when a local openai-compatible /models request fails', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response('not available', { status: 503 })),
  ) as typeof globalThis.fetch

  await expect(
    listOpenAICompatibleModels({ baseUrl: 'http://localhost:1234/v1' }),
  ).resolves.toBeNull()
})

// 2026-04-30 内网网关 context_length 自报告特性新增测试
test('解析网关返回的 context_length 字段', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { id: 'gateway-model-32k', context_length: 32768 },
            { id: 'gateway-model-128k', context_length: 131072 },
          ],
        }),
        { status: 200 },
      ),
    ),
  ) as typeof globalThis.fetch

  await expect(
    listOpenAICompatibleModels({ baseUrl: 'http://gateway.local/v1' }),
  ).resolves.toEqual([
    { id: 'gateway-model-32k', contextWindow: 32768 },
    { id: 'gateway-model-128k', contextWindow: 131072 },
  ])
})

test('过滤无效的 context_length（0 或负数）', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { id: 'model-zero', context_length: 0 },
            { id: 'model-neg', context_length: -1 },
          ],
        }),
        { status: 200 },
      ),
    ),
  ) as typeof globalThis.fetch

  await expect(
    listOpenAICompatibleModels({ baseUrl: 'http://gateway.local/v1' }),
  ).resolves.toEqual([
    { id: 'model-zero', contextWindow: undefined },
    { id: 'model-neg', contextWindow: undefined },
  ])
})

test('context_length 字段缺失时 contextWindow 为 undefined', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ id: 'model-no-ctx' }],
        }),
        { status: 200 },
      ),
    ),
  ) as typeof globalThis.fetch

  await expect(
    listOpenAICompatibleModels({ baseUrl: 'http://gateway.local/v1' }),
  ).resolves.toEqual([{ id: 'model-no-ctx', contextWindow: undefined }])
})

test('detects LM Studio from the default localhost port', () => {
  expect(getLocalOpenAICompatibleProviderLabel('http://localhost:1234/v1')).toBe(
    'LM Studio',
  )
})

test('detects common local openai-compatible providers by hostname', () => {
  expect(
    getLocalOpenAICompatibleProviderLabel('http://localai.local:8080/v1'),
  ).toBe('LocalAI')
  expect(
    getLocalOpenAICompatibleProviderLabel('http://vllm.local:8000/v1'),
  ).toBe('vLLM')
})

test('falls back to a generic local openai-compatible label', () => {
  expect(
    getLocalOpenAICompatibleProviderLabel('http://127.0.0.1:8080/v1'),
  ).toBe('Local OpenAI-compatible')
})

// 2026-05-14 方案E：显式声明企业内网网关时返回 YwCoder 专属标签
test('显式声明 YWCODER_INTRANET=1 时返回 YwCoder-OpenAI协议网关标签', () => {
  process.env.YWCODER_INTRANET = '1'
  // 非 RFC1918 IP（76.x）走原 fallback 会得到 'Local OpenAI-compatible'
  expect(
    getLocalOpenAICompatibleProviderLabel('http://76.123.45.67:8080/v1'),
  ).toBe('YwCoder-OpenAI协议网关')
  // INTRANET 优先级高于关键字匹配：即使 URL 含 'vllm' 也返回内网网关标签
  expect(
    getLocalOpenAICompatibleProviderLabel('http://76.123.45.67/vllm/v1'),
  ).toBe('YwCoder-OpenAI协议网关')
})

// 2026-04-30 内网网关 context_length 自报告测试新增：TC-04 重复模型 ID 去重保留最后一个
test('重复模型 ID 去重保留最后一个 context_length', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { id: 'qwen2.5', context_length: 131072 },
            { id: 'qwen2.5', context_length: 65536 },
          ],
        }),
        { status: 200 },
      ),
    ),
  ) as typeof globalThis.fetch

  await expect(
    listOpenAICompatibleModels({ baseUrl: 'http://gateway.local/v1' }),
  ).resolves.toEqual([{ id: 'qwen2.5', contextWindow: 65536 }])
})