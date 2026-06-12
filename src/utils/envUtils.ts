import { existsSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join, sep } from 'path'

/**
 * Get environment variable with fallback from new YWCODER_* name to old CLAUDE_CODE_* name.
 * This allows users to migrate to the new YWCODER_* variables while maintaining backward compatibility.
 *
 * @param newName - The new YWCODER_* environment variable name
 * @param oldName - The old CLAUDE_CODE_* environment variable name
 * @returns The value of the environment variable, or undefined if neither is set
 */
export function getEnvWithFallback(newName: string, oldName: string): string | undefined {
  return process.env[newName] ?? process.env[oldName]
}

/**
 * Get environment variable with fallback from YWCODER_* to CLAUDE_CODE_*.
 * Automatically prefixes the provided suffix with YWCODER_ and CLAUDE_CODE_.
 *
 * @param suffix - The variable name suffix (e.g., 'USE_OPENAI' for YWCODER_USE_OPENAI)
 * @returns The value of the environment variable, or undefined if neither is set
 */
export function getYwCoderEnv(suffix: string): string | undefined {
  return process.env[`YWCODER_${suffix}`] ?? process.env[`CLAUDE_CODE_${suffix}`]
}

// Track if we've shown the migration hint to avoid duplicate messages
let migrationHintShown = false

// Memoized: 150+ callers, many on hot paths. Keyed off CLAUDE_CONFIG_DIR/YWCODER_CONFIG_DIR so
// tests that change the env var get a fresh value without explicit cache.clear.
export const getYwCoderConfigHomeDir = memoize(
  (): string => {
    // Check YWCODER_CONFIG_DIR first, then fall back to CLAUDE_CONFIG_DIR
    const configDir = process.env.YWCODER_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
    if (configDir) {
      return configDir.normalize('NFC')
    }

    const newDefault = join(homedir(), '.ywcoder')
    const legacyClaudePath = join(homedir(), '.claude')

    // Multi-level fallback for backward compatibility:
    // 1. ~/.ywcoder (new default)
    // 2. ~/.claude (legacy)
    //
    // Migration logic:
    // - New installs (none exist): use ~/.ywcoder
    // - If ~/.ywcoder exists: use it (already migrated)
    // - If only ~/.claude exists: use ~/.claude and show migration hint

    if (existsSync(newDefault)) {
      return newDefault.normalize('NFC')
    }

    if (existsSync(legacyClaudePath)) {
      // 仅提示一次，避免重复打扰
      if (!migrationHintShown && process.stderr.isTTY) {
        migrationHintShown = true
        process.stderr.write(
          '\n\x1b[33m[YwCoder] 提示：当前正在使用历史配置目录 ~/.claude\x1b[0m\n' +
          '\x1b[33m         请在 shell 中运行 `ywcoder --migrate-config` 迁移至 ~/.ywcoder\x1b[0m\n\n'
        )
      }
      return legacyClaudePath.normalize('NFC')
    }

    // New install - use the new default
    return newDefault.normalize('NFC')
  },
  () => process.env.YWCODER_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR,
)

export function getTeamsDir(): string {
  return join(getYwCoderConfigHomeDir(), 'teams')
}

/**
 * 显示 / prompt 用：活跃 HOME 配置目录的 `~/...` 形式（getYwCoderConfigHomeDir 优先
 * `~/.ywcoder`、回退 `~/.claude` 或 CLAUDE_CONFIG_DIR）。用于把发往 LLM 的 prompt 与用户
 * 可见文案里硬编码的 `~/.claude/...` 对齐到真实活跃目录——路径-of-record 本就由
 * getYwCoderConfigHomeDir 决定（如 teams/tasks/keybindings/userSettings 均落此），文案此前
 * 仍写 `~/.claude` 会与真实落盘不一致（甚至误导 agent 写错目录）。
 */
export function getConfigHomeDisplayPath(): string {
  const dir = getYwCoderConfigHomeDir()
  const home = homedir()
  if (dir === home) return '~'
  // 必须带分隔符，否则 home=/home/user 会误匹配 /home/user2/... 产出 ~/2/...。
  if (dir.startsWith(home + sep)) return `~${dir.slice(home.length)}`
  return dir
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / YWCODER_SIMPLE / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ANTHROPIC_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets YWCODER_SIMPLE/CLAUDE_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(getYwCoderEnv('SIMPLE')) ||
    process.argv.includes('--bare')
  )
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if YWCODER_BASH_MAINTAIN_PROJECT_WORKING_DIR or CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.YWCODER_BASH_MAINTAIN_PROJECT_WORKING_DIR ?? process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether YwCoder is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
