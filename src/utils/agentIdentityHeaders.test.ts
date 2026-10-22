import { afterEach, beforeEach, expect, test } from 'bun:test'
import { withAgentIdentityHeaders } from './agentIdentityHeaders.js'

const originalMacro = (globalThis as Record<string, unknown>).MACRO
const originalIntranet = process.env.YWCODER_INTRANET
const originalLegacyIntranet = process.env.CLAUDE_CODE_INTRANET

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '99.0.0',
    DISPLAY_VERSION: '1.3.2-local',
    PACKAGE_VERSION: '1.3.2',
  }
  delete process.env.YWCODER_INTRANET
  delete process.env.CLAUDE_CODE_INTRANET
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  if (originalIntranet === undefined) delete process.env.YWCODER_INTRANET
  else process.env.YWCODER_INTRANET = originalIntranet
  if (originalLegacyIntranet === undefined) delete process.env.CLAUDE_CODE_INTRANET
  else process.env.CLAUDE_CODE_INTRANET = originalLegacyIntranet
})

test('未启用内网模式时原样返回请求头', () => {
  const headers = { 'x-agent-version': 'custom', 'X-Other': 'value' }
  expect(withAgentIdentityHeaders(headers)).toBe(headers)

  process.env.YWCODER_INTRANET = '0'
  expect(withAgentIdentityHeaders(headers)).toBe(headers)
})

test.each(['1', 'true', 'yes', 'on'])('内网模式 %s 使用真实包版本和规范字段', value => {
  process.env.YWCODER_INTRANET = value
  const result = withAgentIdentityHeaders({
    'x-Agent-Name': 'custom',
    'X-AGENT-VERSION': 'old',
    'X-Other': 'value',
  })

  expect(result).toEqual({
    'X-Other': 'value',
    'X-Agent-Name': 'ywcoder',
    'X-Agent-Version': '1.3.2',
  })
  expect(Object.keys(result).filter(name => name.toLowerCase() === 'x-agent-version')).toHaveLength(1)
})

test('旧变量可回退，但新变量关闭时优先', () => {
  process.env.CLAUDE_CODE_INTRANET = '1'
  expect(withAgentIdentityHeaders({})['X-Agent-Name']).toBe('ywcoder')

  process.env.YWCODER_INTRANET = '0'
  expect(withAgentIdentityHeaders({})).toEqual({})
})
