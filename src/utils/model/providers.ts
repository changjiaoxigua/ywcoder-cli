import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { shouldUseCodexTransport } from '../../services/api/providerConfig.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'gemini'
  | 'github'
  | 'codex'

export function getAPIProvider(env: NodeJS.ProcessEnv = process.env): APIProvider {
  // 最高优先级：显式要求走 Anthropic（YWCODER_USE_ANTHROPIC 是 ywcoder 自创，无旧名回退）
  if (isEnvTruthy(env.YWCODER_USE_ANTHROPIC)) {
    return 'firstParty'
  }
  // 其余各 provider 标志：优先新名 YWCODER_USE_*，回退旧名 CLAUDE_CODE_USE_*
  return isEnvTruthy(env.YWCODER_USE_GEMINI ?? env.CLAUDE_CODE_USE_GEMINI)
    ? 'gemini'
    : isEnvTruthy(env.YWCODER_USE_GITHUB ?? env.CLAUDE_CODE_USE_GITHUB)
      ? 'github'
      : isEnvTruthy(env.YWCODER_USE_OPENAI ?? env.CLAUDE_CODE_USE_OPENAI)
        ? isCodexModel(env)
          ? 'codex'
          : 'openai'
        : isEnvTruthy(env.YWCODER_USE_BEDROCK ?? env.CLAUDE_CODE_USE_BEDROCK)
          ? 'bedrock'
          : isEnvTruthy(env.YWCODER_USE_VERTEX ?? env.CLAUDE_CODE_USE_VERTEX)
            ? 'vertex'
            : isEnvTruthy(env.YWCODER_USE_FOUNDRY ?? env.CLAUDE_CODE_USE_FOUNDRY)
              ? 'foundry'
              // 兜底：codex-aware，与显式设 USE_OPENAI 时行为一致
              : isCodexModel(env) ? 'codex' : 'openai'
}

export function usesAnthropicAccountFlow(): boolean {
  return getAPIProvider() === 'firstParty'
}

/** 是否使用 OpenAI 兼容协议（非 Anthropic 直连）。供各模块统一复用，避免散落正向 USE_OPENAI 检查 */
export function isOpenAICompatibleProvider(): boolean {
  return getAPIProvider() !== 'firstParty'
}

function isCodexModel(env: NodeJS.ProcessEnv = process.env): boolean {
  return shouldUseCodexTransport(
    env.OPENAI_MODEL || '',
    env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE,
  )
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
