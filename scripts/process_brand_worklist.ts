import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const WORKLIST_PATH = 'note/BRAND_MIGRATION_2026-06-07/agent_worklist.txt'
const REVIEW_PATH = 'note/BRAND_MIGRATION_2026-06-07/HUMAN_REVIEW_NEEDED.md'
const SRC_DIR = 'src'

// 硬性护栏 token（大小写不敏感匹配）
const HARD_GUARDRAIL_TOKENS = [
  '@anthropic-ai',
  'claude-3', 'claude-sonnet', 'claude-opus', 'claude-haiku',
  'ANTHROPIC_',
  'CLAUDE.md',
  '.claude/', '~/.claude', '.claude.json',
  'claude-plugins',
  'claude-code-action',
  'claude-code-jetbrains',
  'claudeCodeFirst',
  'claude-code-hint',
  'CLAUDECODE',
  'claudeai-proxy',
  'CLAUDE_CODE_',
  'anthropics/',
  'claude.ai',
  'code.claude.com',
]

// 外部 Anthropic 产品/功能 token
const EXTERNAL_PRODUCT_TOKENS = [
  'Desktop', 'web', 'subscription', 'account', 'OAuth', 'login', 'Console', 'upsell',
]

// 跳过目录
const SKIP_DIRS = ['DesktopUpsell', 'bridge/', 'constants/oauth.ts', 'constants/product.ts']

function shouldSkip(filePath: string, lineContent: string): { skip: boolean; reason: string } {
  // 检查跳过目录
  for (const dir of SKIP_DIRS) {
    if (filePath.includes(dir)) {
      return { skip: true, reason: `文件路径含跳过目录: ${dir}` }
    }
  }

  // 检查硬性护栏
  for (const token of HARD_GUARDRAIL_TOKENS) {
    if (lineContent.toLowerCase().includes(token.toLowerCase())) {
      return { skip: true, reason: `硬性护栏命中: ${token}` }
    }
  }

  // 检查外部产品 token（但仅限 "Claude Code" 在句中是指外部产品的情况）
  // 这里用启发式：如果行中含 Desktop/web/subscription/account/OAuth/login/Console/upsell 则跳过
  for (const token of EXTERNAL_PRODUCT_TOKENS) {
    if (lineContent.includes(token)) {
      return { skip: true, reason: `外部 Anthropic 产品 token: ${token}` }
    }
  }

  // 检查 "upstream Claude Code"
  if (lineContent.includes('upstream') && lineContent.includes('Claude Code')) {
    return { skip: true, reason: '指向上游官方 Claude Code' }
  }

  // 检查 keychain/secureStorage 中的硬编码服务名
  if (filePath.includes('secureStorage') || filePath.includes('keychain')) {
    // 如果行中含引号包裹的 "Claude Code" 或 keychain 服务名格式，跳过
    if (lineContent.includes('"Claude Code"') || lineContent.includes('"Claude Code-')) {
      return { skip: true, reason: 'keychain/secureStorage 硬编码服务名' }
    }
  }

  // 检查 deepLink 注册相关（MACOS_BUNDLE_ID、APP_NAME 等）
  if (filePath.includes('deepLink/registerProtocol')) {
    return { skip: true, reason: 'deepLink 协议注册标识（功能性）' }
  }

  // 检查已禁用的 tips（tipRegistry.ts 中已禁用的行）
  if (filePath.includes('tipRegistry.ts') && lineContent.includes("'Paste images")) {
    return { skip: true, reason: '已禁用的 tip 注释' }
  }

  // 检查 skills/bundled/scheduleRemoteAgents.ts（Anthropic 云服务）
  if (filePath.includes('scheduleRemoteAgents.ts') && lineContent.includes('remote')) {
    return { skip: true, reason: 'Remote Agent（Anthropic 云服务）' }
  }

  // 检查 rateLimitMessages 中的 /upgrade
  if (filePath.includes('rateLimitMessages.ts') && lineContent.includes('/upgrade')) {
    return { skip: true, reason: 'rate limit upsell（Anthropic 订阅）' }
  }

  // 检查 voiceStreamSTT 中的 OAuth
  if (filePath.includes('voiceStreamSTT.ts') && lineContent.includes('OAuth')) {
    return { skip: true, reason: 'OAuth 相关（功能性）' }
  }

  // 检查 telemetry/perfettoTracing.ts（Ant-only）
  if (filePath.includes('perfettoTracing.ts')) {
    return { skip: true, reason: 'perfettoTracing（Ant-only）' }
  }

  // 检查 review.ts 中描述已禁用功能的注释
  if (filePath.includes('review.ts') && lineContent.includes('on the web')) {
    return { skip: true, reason: '描述已禁用外部功能的注释' }
  }

  return { skip: false, reason: '' }
}

function processLine(filePath: string, lineNum: number, lineContent: string): { modified: boolean; newContent?: string; skipReason?: string } {
  const { skip, reason } = shouldSkip(filePath, lineContent)
  if (skip) {
    return { modified: false, skipReason: reason }
  }

  let newContent = lineContent

  // 按规则替换（保持大小写敏感，优先匹配完整词组）
  // 注意：替换时保持所有格形式（Claude Code's → YwCoder's）
  newContent = newContent.replace(/Claude Code's/g, "YwCoder's")
  newContent = newContent.replace(/Claude Code/g, 'YwCoder')
  newContent = newContent.replace(/OpenClaude/g, 'YwCoder')
  newContent = newContent.replace(/Open Claude/g, 'YwCoder')
  newContent = newContent.replace(/openclaude/g, 'ywcoder')

  if (newContent === lineContent) {
    return { modified: false, skipReason: '无匹配替换项' }
  }

  return { modified: true, newContent }
}

function main() {
  const worklistRaw = readFileSync(WORKLIST_PATH, 'utf-8')
  const lines = worklistRaw.split('\n').filter(l => l.trim())

  const skipRecords: string[] = []
  const modifiedFiles = new Set<string>()
  const fileCache = new Map<string, string[]>()

  for (const entry of lines) {
    // 格式: src/.../file.ts:123: 内容
    const firstColon = entry.indexOf(':')
    const secondColon = entry.indexOf(':', firstColon + 1)
    if (firstColon === -1 || secondColon === -1) continue

    const filePath = entry.slice(0, firstColon)
    const lineNum = parseInt(entry.slice(firstColon + 1, secondColon), 10)
    const lineContent = entry.slice(secondColon + 1)

    if (!existsSync(filePath)) {
      skipRecords.push(`- [文件不存在] ${entry}`)
      continue
    }

    const result = processLine(filePath, lineNum, lineContent)
    if (result.skipReason) {
      skipRecords.push(`- ${filePath}:${lineNum} — ${result.skipReason}\n  \`\`\`\n  ${lineContent.trim()}\n  \`\`\``)
      continue
    }

    if (result.modified && result.newContent) {
      if (!fileCache.has(filePath)) {
        const fileContent = readFileSync(filePath, 'utf-8')
        fileCache.set(filePath, fileContent.split('\n'))
      }
      const fileLines = fileCache.get(filePath)!
      // 行号从 1 开始
      if (fileLines[lineNum - 1] !== lineContent) {
        // 行内容不匹配，可能是因为之前已经改过或行号偏移
        // 尝试在当前行附近查找
        let found = false
        for (let i = Math.max(0, lineNum - 3); i < Math.min(fileLines.length, lineNum + 3); i++) {
          if (fileLines[i] === lineContent) {
            fileLines[i] = result.newContent
            found = true
            break
          }
        }
        if (!found) {
          skipRecords.push(`- ${filePath}:${lineNum} — 行内容不匹配（可能已改动）\n  期望: ${lineContent.trim()}\n  实际: ${fileLines[lineNum - 1]?.trim()}`)
          continue
        }
      } else {
        fileLines[lineNum - 1] = result.newContent
      }
      modifiedFiles.add(filePath)
    }
  }

  // 写回修改的文件
  for (const [filePath, fileLines] of fileCache) {
    writeFileSync(filePath, fileLines.join('\n'))
  }

  // 写入 HUMAN_REVIEW_NEEDED.md
  const reviewContent = `# 品牌替换人工复核项

**生成时间**: ${new Date().toISOString().split('T')[0]}
**总数**: ${skipRecords.length} 项

---

${skipRecords.join('\n\n')}
`
  writeFileSync(REVIEW_PATH, reviewContent)

  console.log(`处理完成: ${lines.length} 行`)
  console.log(`  - 修改文件: ${modifiedFiles.size} 个`)
  console.log(`  - 跳过: ${skipRecords.length} 行`)
  console.log(`  - 复核记录: ${REVIEW_PATH}`)
}

main()
