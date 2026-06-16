import type { ZodIssueCode } from 'zod/v4'

// v4 ZodIssueCode is a value, not a type - use typeof to get the type
type ZodIssueCodeType = (typeof ZodIssueCode)[keyof typeof ZodIssueCode]

export type ValidationTip = {
  suggestion?: string
  docLink?: string
}

export type TipContext = {
  path: string
  code: ZodIssueCodeType | string
  expected?: string
  received?: unknown
  enumValues?: string[]
  message?: string
  value?: unknown
}

type TipMatcher = {
  matches: (context: TipContext) => boolean
  tip: ValidationTip
}

// const DOCUMENTATION_BASE = 'https://code.claude.com/docs/en'

const TIP_MATCHERS: TipMatcher[] = [
  {
    matches: (ctx): boolean =>
      ctx.path === 'permissions.defaultMode' && ctx.code === 'invalid_value',
    tip: {
      suggestion:
        '有效模式："acceptEdits"（文件修改前询问）、"plan"（仅分析）、"bypassPermissions"（自动接受全部）或 "default"（标准行为）',
      // docLink: `${DOCUMENTATION_BASE}/iam#permission-modes`,
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path === 'apiKeyHelper' && ctx.code === 'invalid_type',
    tip: {
      suggestion:
        'Provide a shell command that outputs your API key to stdout. The script should output only the API key. Example: "/bin/generate_temp_api_key.sh"',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path === 'cleanupPeriodDays' &&
      ctx.code === 'too_small' &&
      ctx.expected === '0',
    tip: {
      suggestion:
        'Must be 0 or greater. Set a positive number for days to retain transcripts (default is 30). Setting 0 disables session persistence entirely: no transcripts are written and existing transcripts are deleted at startup.',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path.startsWith('env.') && ctx.code === 'invalid_type',
    tip: {
      suggestion:
        '环境变量必须为字符串类型。数字和布尔值请加引号。示例："DEBUG": "true", "PORT": "3000"',
      // docLink: `${DOCUMENTATION_BASE}/settings#environment-variables`,
    },
  },
  {
    matches: (ctx): boolean =>
      (ctx.path === 'permissions.allow' || ctx.path === 'permissions.deny') &&
      ctx.code === 'invalid_type' &&
      ctx.expected === 'array',
    tip: {
      suggestion:
        'Permission rules must be in an array. Format: ["Tool(specifier)"]. Examples: ["Bash(npm run build)", "Edit(docs/**)", "Read(~/.zshrc)"]. Use * for wildcards.',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path.includes('hooks') && ctx.code === 'invalid_type',
    tip: {
      suggestion:
        // gh-31187 / CC-282: prior example showed {"matcher": {"tools": ["BashTool"]}}
        // — an object format that never existed in the schema (matcher is z.string(),
        // always has been). Users copied the tip's example and got the same validation
        // error again. See matchesPattern() in hooks.ts: matcher is exact-match,
        // pipe-separated ("Edit|Write"), or regex. Empty/"*" matches all.
        'Hooks use a matcher + hooks array. The matcher is a string: a tool name ("Bash"), pipe-separated list ("Edit|Write"), or empty to match all. Example: {"PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "echo Done"}]}]}',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.code === 'invalid_type' && ctx.expected === 'boolean',
    tip: {
      suggestion:
        'Use true or false without quotes. Example: "includeCoAuthoredBy": true',
    },
  },
  {
    matches: (ctx): boolean => ctx.code === 'unrecognized_keys',
    tip: {
      suggestion: '请检查是否存在拼写错误，或联系管理员查看有效配置项',
      // docLink: `${DOCUMENTATION_BASE}/settings`,
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.code === 'invalid_value' && ctx.enumValues !== undefined,
    tip: {
      suggestion: undefined,
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.code === 'invalid_type' &&
      ctx.expected === 'object' &&
      ctx.received === null &&
      ctx.path === '',
    tip: {
      suggestion:
        'Check for missing commas, unmatched brackets, or trailing commas. Use a JSON validator to identify the exact syntax error.',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path === 'permissions.additionalDirectories' &&
      ctx.code === 'invalid_type',
    tip: {
      suggestion:
        '必须为目录路径组成的数组。示例：["~/projects", "/tmp/workspace"]。也可以使用 --add-dir 参数或 /add-dir 命令',
      // docLink: `${DOCUMENTATION_BASE}/iam#working-directories`,
    },
  },
]

// const PATH_DOC_LINKS: Record<string, string> = {
//   permissions: `${DOCUMENTATION_BASE}/iam#configuring-permissions`,
//   env: `${DOCUMENTATION_BASE}/settings#environment-variables`,
//   hooks: `${DOCUMENTATION_BASE}/hooks`,
// }

export function getValidationTip(context: TipContext): ValidationTip | null {
  const matcher = TIP_MATCHERS.find(m => m.matches(context))

  if (!matcher) return null

  const tip: ValidationTip = { ...matcher.tip }

  if (
    context.code === 'invalid_value' &&
    context.enumValues &&
    !tip.suggestion
  ) {
    tip.suggestion = `可选值：${context.enumValues.map(v => `"${v}"`).join(', ')}`
  }

  // 品牌去标识：已注释 PATH_DOC_LINKS，不再根据路径前缀自动附加文档链接
  // if (!tip.docLink && context.path) {
  //   const pathPrefix = context.path.split('.')[0]
  //   if (pathPrefix) {
  //     tip.docLink = PATH_DOC_LINKS[pathPrefix]
  //   }
  // }

  return tip
}
