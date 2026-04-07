import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const originalEnv = { ...process.env }

// Helper to dynamically import modules to avoid mock pollution
async function importProviderProfiles() {
  const [{ saveGlobalConfig }, { getAPIProvider }] = await Promise.all([
    import('./config.js'),
    import('./model/providers.js'),
  ])
  const {
    applyActiveProviderProfileFromConfig,
    applyProviderProfileToProcessEnv,
    deleteProviderProfile,
    getProviderProfiles,
    getProviderPresetDefaults,
    persistActiveProviderProfileModel,
  } = await import('./providerProfiles.js')
  return {
    saveGlobalConfig,
    getAPIProvider,
    applyActiveProviderProfileFromConfig,
    applyProviderProfileToProcessEnv,
    deleteProviderProfile,
    getProviderProfiles,
    getProviderPresetDefaults,
    persistActiveProviderProfileModel,
  }
}

// Import type separately
import type { ProviderProfile } from './config.js'
import { getYwCoderEnv } from '../utils/envUtils.js'

beforeEach(() => {
  mock.restore()
})

const RESTORED_KEYS = [
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
] as const

afterEach(async () => {
  for (const key of RESTORED_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }

  const { saveGlobalConfig } = await import('./config.js')
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [],
    activeProviderProfileId: undefined,
    openaiAdditionalModelOptionsCache: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
  }))
})

function buildProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider_test',
    name: 'Test Provider',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    ...overrides,
  }
}

describe('applyProviderProfileToProcessEnv', () => {
  test('openai profile clears competing gemini/github flags', async () => {
    const { applyProviderProfileToProcessEnv, getAPIProvider } = await importProviderProfiles()
    process.env.YWCODER_USE_GEMINI = process.env.CLAUDE_CODE_USE_GEMINI = '1'
    process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = '1'

    applyProviderProfileToProcessEnv(buildProfile())

    expect(getYwCoderEnv('USE_GEMINI')).toBeUndefined()
    expect(getYwCoderEnv('USE_GITHUB')).toBeUndefined()
    expect(getYwCoderEnv('USE_OPENAI')).toBe('1')
    expect(getYwCoderEnv('PROVIDER_PROFILE_ENV_APPLIED_ID')).toBe(
      'provider_test',
    )
    expect(await getAPIProvider()).toBe('openai')
  })

  test('anthropic profile clears competing gemini/github flags', async () => {
    const { applyProviderProfileToProcessEnv, getAPIProvider } = await importProviderProfiles()
    process.env.YWCODER_USE_GEMINI = process.env.CLAUDE_CODE_USE_GEMINI = '1'
    process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = '1'

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
      }),
    )

    expect(getYwCoderEnv('USE_GEMINI')).toBeUndefined()
    expect(getYwCoderEnv('USE_GITHUB')).toBeUndefined()
    expect(getYwCoderEnv('USE_OPENAI')).toBeUndefined()
    expect(await getAPIProvider()).toBe('firstParty')
  })
})

describe('applyActiveProviderProfileFromConfig', () => {
  test('does not override explicit startup provider selection', async () => {
    const { applyActiveProviderProfileFromConfig } = await importProviderProfiles()
    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'qwen2.5:3b'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_MODEL).toBe('qwen2.5:3b')
  })

  test('does not override explicit startup selection when profile marker is stale', async () => {
    const { applyActiveProviderProfileFromConfig } = await importProviderProfiles()
    process.env.YWCODER_PROVIDER_PROFILE_ENV_APPLIED = process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'qwen2.5:3b'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(getYwCoderEnv('USE_OPENAI')).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_MODEL).toBe('qwen2.5:3b')
  })

  test('re-applies active profile when profile-managed env drifts', async () => {
    const { applyProviderProfileToProcessEnv, applyActiveProviderProfileFromConfig } = await importProviderProfiles()
    applyProviderProfileToProcessEnv(
      buildProfile({
        id: 'saved_openai',
        baseUrl: 'http://192.168.33.108:11434/v1',
        model: 'kimi-k2.5:cloud',
      }),
    )

    // Simulate settings/env merge clobbering the model while profile flags remain.
    process.env.OPENAI_MODEL = 'github:copilot'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'http://192.168.33.108:11434/v1',
          model: 'kimi-k2.5:cloud',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied?.id).toBe('saved_openai')
    expect(process.env.OPENAI_MODEL).toBe('kimi-k2.5:cloud')
    expect(process.env.OPENAI_BASE_URL).toBe('http://192.168.33.108:11434/v1')
  })

  test('does not re-apply active profile when flags conflict with current provider', async () => {
    const { applyProviderProfileToProcessEnv, applyActiveProviderProfileFromConfig } = await importProviderProfiles()
    applyProviderProfileToProcessEnv(
      buildProfile({
        id: 'saved_openai',
        baseUrl: 'http://192.168.33.108:11434/v1',
        model: 'kimi-k2.5:cloud',
      }),
    )

    process.env.YWCODER_USE_GITHUB = process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_MODEL = 'github:copilot'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'http://192.168.33.108:11434/v1',
          model: 'kimi-k2.5:cloud',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(getYwCoderEnv('USE_GITHUB')).toBe('1')
    expect(process.env.OPENAI_MODEL).toBe('github:copilot')
  })

  test('applies active profile when no explicit provider is selected', async () => {
    const { applyActiveProviderProfileFromConfig } = await importProviderProfiles()
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

    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'qwen2.5:3b'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied?.id).toBe('saved_openai')
    expect(getYwCoderEnv('USE_OPENAI')).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
  })
})

describe('persistActiveProviderProfileModel', () => {
  test('updates active profile model and current env for profile-managed sessions', async () => {
    const { saveGlobalConfig, applyProviderProfileToProcessEnv, persistActiveProviderProfileModel, getProviderProfiles } = await importProviderProfiles()
    const activeProfile = buildProfile({
      id: 'saved_openai',
      baseUrl: 'http://192.168.33.108:11434/v1',
      model: 'kimi-k2.5:cloud',
    })

    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    }))
    applyProviderProfileToProcessEnv(activeProfile)

    const updated = persistActiveProviderProfileModel('minimax-m2.5:cloud')

    expect(updated?.id).toBe(activeProfile.id)
    expect(updated?.model).toBe('minimax-m2.5:cloud')
    expect(process.env.OPENAI_MODEL).toBe('minimax-m2.5:cloud')
    expect(getYwCoderEnv('PROVIDER_PROFILE_ENV_APPLIED_ID')).toBe(
      activeProfile.id,
    )

    const saved = getProviderProfiles().find(
      profile => profile.id === activeProfile.id,
    )
    expect(saved?.model).toBe('minimax-m2.5:cloud')
  })

  test('does not mutate process env when session is not profile-managed', async () => {
    const { saveGlobalConfig, persistActiveProviderProfileModel, getProviderProfiles } = await importProviderProfiles()
    const activeProfile = buildProfile({
      id: 'saved_openai',
      model: 'kimi-k2.5:cloud',
    })

    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    }))

    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_MODEL = 'cli-model'
    delete process.env.YWCODER_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.YWCODER_PROVIDER_PROFILE_ENV_APPLIED_ID
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID

    persistActiveProviderProfileModel('minimax-m2.5:cloud')

    expect(process.env.OPENAI_MODEL).toBe('cli-model')
    const saved = getProviderProfiles().find(
      profile => profile.id === activeProfile.id,
    )
    expect(saved?.model).toBe('minimax-m2.5:cloud')
  })
})

describe('getProviderPresetDefaults', () => {
  test('ollama preset defaults to a local Ollama model', async () => {
    const { getProviderPresetDefaults } = await importProviderProfiles()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('ollama')

    expect(defaults.baseUrl).toBe('http://localhost:11434/v1')
    expect(defaults.model).toBe('llama3.1:8b')
  })
})

describe('deleteProviderProfile', () => {
  test('deleting final profile clears provider env when active profile applied it', async () => {
    const { applyProviderProfileToProcessEnv, saveGlobalConfig, deleteProviderProfile } = await importProviderProfiles()
    applyProviderProfileToProcessEnv(
      buildProfile({
        id: 'only_profile',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-test',
      }),
    )

    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'only_profile' })],
      activeProviderProfileId: 'only_profile',
    }))

    const result = deleteProviderProfile('only_profile')

    expect(result.removed).toBe(true)
    expect(result.activeProfileId).toBeUndefined()

    expect(getYwCoderEnv('PROVIDER_PROFILE_ENV_APPLIED')).toBeUndefined()

    expect(getYwCoderEnv('USE_OPENAI')).toBeUndefined()
    expect(getYwCoderEnv('USE_GEMINI')).toBeUndefined()
    expect(getYwCoderEnv('USE_GITHUB')).toBeUndefined()
    expect(getYwCoderEnv('USE_BEDROCK')).toBeUndefined()
    expect(getYwCoderEnv('USE_VERTEX')).toBeUndefined()
    expect(getYwCoderEnv('USE_FOUNDRY')).toBeUndefined()

    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_API_BASE).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()

    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('deleting final profile preserves explicit startup provider env', async () => {
    const { saveGlobalConfig, deleteProviderProfile } = await importProviderProfiles()
    process.env.YWCODER_USE_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'qwen2.5:3b'

    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'only_profile' })],
      activeProviderProfileId: 'only_profile',
    }))

    const result = deleteProviderProfile('only_profile')

    expect(result.removed).toBe(true)
    expect(result.activeProfileId).toBeUndefined()

    expect(getYwCoderEnv('PROVIDER_PROFILE_ENV_APPLIED')).toBeUndefined()
    expect(getYwCoderEnv('USE_OPENAI')).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_MODEL).toBe('qwen2.5:3b')
  })
})
