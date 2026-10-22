import { getYwCoderEnv, isEnvTruthy } from './envUtils.js'

declare const MACRO: { PACKAGE_VERSION: string }

const RESERVED_AGENT_HEADERS = new Set(['x-agent-name', 'x-agent-version'])

/** 内网网关模式下统一写入客户端身份，避免自定义请求头覆盖规范值。 */
export function withAgentIdentityHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  if (!isEnvTruthy(getYwCoderEnv('INTRANET'))) return headers

  const result = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !RESERVED_AGENT_HEADERS.has(name.toLowerCase()),
    ),
  )

  return {
    ...result,
    'X-Agent-Name': 'ywcoder',
    'X-Agent-Version': MACRO.PACKAGE_VERSION,
  }
}
