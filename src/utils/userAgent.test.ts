import { afterEach, expect, test } from 'bun:test'
import { getMCPUserAgent, getWebFetchUserAgent } from './http.js'
import { getYwCoderUserAgent } from './userAgent.js'

const originalMacro = (globalThis as Record<string, unknown>).MACRO

afterEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
})

test('使用真实包版本生成 YwCoder User-Agent', () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '99.0.0',
    DISPLAY_VERSION: '1.3.1-beta',
    PACKAGE_VERSION: '1.3.1',
  }

  expect(getYwCoderUserAgent()).toBe('ywcoder/1.3.1')
})

test('兼容未注入包版本宏的开发环境', () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '99.0.0',
    DISPLAY_VERSION: '1.3.1-local',
  }

  expect(getYwCoderUserAgent()).toBe('ywcoder/1.3.1-local')
})

test('MCP 和 WebFetch 不再上送 Claude 客户端标识', () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '99.0.0',
    DISPLAY_VERSION: '1.3.1-local',
    PACKAGE_VERSION: '1.3.1',
  }

  expect(getMCPUserAgent()).toStartWith('ywcoder/1.3.1')
  expect(getMCPUserAgent()).not.toContain('claude')
  expect(getWebFetchUserAgent()).toStartWith('ywcoder/1.3.1')
  expect(getWebFetchUserAgent()).not.toContain('Claude-User')
})
