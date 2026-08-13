import { spawnSync } from 'node:child_process'

export type FindingSeverity = 'high' | 'medium'

export type DiffLine = {
  file: string
  line: number
  content: string
}

export type Finding = {
  severity: FindingSeverity
  code: string
  file: string
  line: number
  detail: string
  excerpt: string
}

type CliOptions = {
  baseRef: string
  json: boolean
  failOn: FindingSeverity
}

const SELF_EXCLUDED_FILES = new Set([
  'scripts/pr-intent-scan.ts',
  'scripts/pr-intent-scan.test.ts',
])

const SHORTENER_DOMAINS = [
  'bit.ly',
  'tinyurl.com',
  'goo.gl',
  't.co',
  'is.gd',
  'rb.gy',
  'cutt.ly',
]

const SUSPICIOUS_DOWNLOAD_DOMAINS = [
  'dropbox.com',
  'dl.dropboxusercontent.com',
  'drive.google.com',
  'docs.google.com',
  'mega.nz',
  'mediafire.com',
  'transfer.sh',
  'anonfiles.com',
  'catbox.moe',
]

const URL_REGEX = /\bhttps?:\/\/[^\s)>"']+/gi
const LONG_BASE64_REGEX = /\b(?:[A-Za-z0-9+/]{80,}={0,2}|[A-Za-z0-9_-]{80,})\b/
const EXECUTABLE_PATH_REGEX =
  /\.(?:sh|bash|zsh|ps1|exe|msi|pkg|deb|rpm|zip|tar|tgz|gz|xz|dmg|appimage)(?:$|[?#])/i
const SENSITIVE_PATH_REGEX =
  /^(?:\.github\/workflows\/|scripts\/|bin\/|install(?:\/|\.|$)|.*(?:Dockerfile|docker-compose|compose\.ya?ml)$)/i

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseRef: 'origin/main',
    json: false,
    failOn: 'high',
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--base') {
      const next = argv[index + 1]
      if (next && !next.startsWith('--')) {
        options.baseRef = next
        index++
      }
      continue
    }
    if (arg === '--fail-on') {
      const next = argv[index + 1]
      if (next === 'high' || next === 'medium') {
        options.failOn = next
        index++
      }
    }
  }

  return options
}

function trimExcerpt(content: string): string {
  const compact = content.trim().replace(/\s+/g, ' ')
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact
}

function uniqueFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter(finding => {
    const key = `${finding.code}:${finding.file}:${finding.line}:${finding.detail}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function parseAddedLines(diffText: string): DiffLine[] {
  const lines = diffText.split('\n')
  const added: DiffLine[] = []
  let currentFile: string | null = null
  let currentLine = 0

  for (const rawLine of lines) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice('+++ b/'.length)
      continue
    }

    if (rawLine.startsWith('@@')) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(rawLine)
      if (match) {
        currentLine = Number(match[1])
      }
      continue
    }

    if (!currentFile) {
      continue
    }

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      added.push({
        file: currentFile,
        line: currentLine,
        content: rawLine.slice(1),
      })
      currentLine += 1
      continue
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      continue
    }

    if (!rawLine.startsWith('\\')) {
      currentLine += 1
    }
  }

  return added
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function hasSuspiciousDownloadIndicators(url: URL): boolean {
  const combined = `${url.pathname}${url.search}`.toLowerCase()
  return (
    combined.includes('dl=1') ||
    combined.includes('raw=1') ||
    combined.includes('export=download') ||
    combined.includes('/download') ||
    combined.includes('/uc?export=download')
  )
}

function findUrlFindings(line: DiffLine): Finding[] {
  const findings: Finding[] = []
  const matches = line.content.match(URL_REGEX) ?? []

  for (const match of matches) {
    const parsed = tryParseUrl(match)
    if (!parsed) continue

    const hostname = parsed.hostname.toLowerCase()

    for (const domain of SHORTENER_DOMAINS) {
      if (hostMatches(hostname, domain)) {
        findings.push({
          severity: 'medium',
          code: 'shortened-url',
          file: line.file,
          line: line.line,
          detail: `Added shortened URL: ${hostname}`,
          excerpt: trimExcerpt(line.content),
        })
      }
    }

    const isSuspiciousHost = SUSPICIOUS_DOWNLOAD_DOMAINS.some(domain =>
      hostMatches(hostname, domain),
    )
    const isExecutableDownload = EXECUTABLE_PATH_REGEX.test(
      `${parsed.pathname}${parsed.search}`,
    )

    if (isSuspiciousHost) {
      findings.push({
        severity:
          hasSuspiciousDownloadIndicators(parsed) || isExecutableDownload
            ? 'high'
            : 'medium',
        code: 'suspicious-download-link',
        file: line.file,
        line: line.line,
        detail: `Added external file-hosting link: ${hostname}`,
        excerpt: trimExcerpt(line.content),
      })
    } else if (isExecutableDownload) {
      findings.push({
        severity: 'high',
        code: 'executable-download-link',
        file: line.file,
        line: line.line,
        detail: `Added direct link to executable or archive payload: ${hostname}`,
        excerpt: trimExcerpt(line.content),
      })
    }
  }

  return findings
}

function findSensitivePathFindings(line: DiffLine): Finding[] {
  if (!SENSITIVE_PATH_REGEX.test(line.file)) {
    return []
  }

  const lower = line.content.toLowerCase()

  if (
    /\b(curl|wget|invoke-webrequest|iwr|powershell|bash|sh|chmod\s+\+x)\b/i.test(
      line.content,
    ) ||
    URL_REGEX.test(line.content) ||
    lower.includes('download')
  ) {
    return [
      {
        severity: 'medium',
        code: 'sensitive-automation-change',
        file: line.file,
        line: line.line,
        detail:
          'Added network, execution, or download-related content in a sensitive automation file',
        excerpt: trimExcerpt(line.content),
      },
    ]
  }

  return []
}

function findCommandFindings(line: DiffLine): Finding[] {
  const findings: Finding[] = []
  const lower = line.content.toLowerCase()

  const highPatterns: Array<[string, RegExp, string]> = [
    [
      'download-exec-chain',
      /\b(curl|wget|invoke-webrequest|iwr)\b.*(\|\s*(sh|bash|zsh)|;\s*chmod\s+\+x|&&\s*\.\.?\/|>\s*\/tmp\/)/i,
      'Added remote download followed by execution or staging',
    ],
    [
      'powershell-encoded',
      /\bpowershell(?:\.exe)?\b.*(?:-enc|-encodedcommand)\b/i,
      'Added encoded PowerShell invocation',
    ],
    [
      'shell-eval-remote',
      /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/i,
      'Added shell pipe from remote content into interpreter',
    ],
    [
      'binary-lolbin',
      /\b(mshta|rundll32|regsvr32|certutil)\b/i,
      'Added living-off-the-land binary often used for payload staging',
    ],
    [
      'invoke-expression',
      /\b(iex|invoke-expression)\b/i,
      'Added PowerShell expression execution',
    ],
  ]

  const mediumPatterns: Array<[string, RegExp, string]> = [
    [
      'download-command',
      /\b(curl|wget|invoke-webrequest|iwr)\b.*https?:\/\//i,
      'Added command that downloads remote content',
    ],
    [
      'archive-extract-exec',
      /\b(unzip|tar|7z)\b.*(&&|;).*\b(chmod|node|python|bash|sh)\b/i,
      'Added archive extraction followed by execution',
    ],
    [
      'base64-decode',
      /\b(base64\s+-d|openssl\s+base64\s+-d|python .*b64decode)\b/i,
      'Added explicit payload decode step',
    ],
  ]

  for (const [code, pattern, detail] of highPatterns) {
    if (pattern.test(line.content)) {
      findings.push({
        severity: 'high',
        code,
        file: line.file,
        line: line.line,
        detail,
        excerpt: trimExcerpt(line.content),
      })
    }
  }

  for (const [code, pattern, detail] of mediumPatterns) {
    if (code === 'download-command' && !SENSITIVE_PATH_REGEX.test(line.file)) {
      continue
    }
    if (pattern.test(line.content)) {
      findings.push({
        severity: 'medium',
        code,
        file: line.file,
        line: line.line,
        detail,
        excerpt: trimExcerpt(line.content),
      })
    }
  }

  if (LONG_BASE64_REGEX.test(line.content) && !lower.includes('sha256') && !lower.includes('sha512')) {
    findings.push({
      severity: 'medium',
      code: 'long-encoded-payload',
      file: line.file,
      line: line.line,
      detail: 'Added long encoded blob or token-like payload',
      excerpt: trimExcerpt(line.content),
    })
  }

  return findings
}

/**
 * 行级豁免：在误报行尾标注 `pr-scan:ignore`（豁免本行全部规则）或
 * `pr-scan:ignore <code1,code2>`（只豁免指定规则码）。比文件级排除精确，
 * 且豁免点随 diff 进入评审视野，可审计。
 */
const SUPPRESS_WITH_CODES_REGEX =
  /\bpr-scan:ignore\s+([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)/i
const SUPPRESS_ALL_REGEX = /\bpr-scan:ignore\b/

function lineSuppressions(content: string): Set<string> | 'all' | null {
  const withCodes = content.match(SUPPRESS_WITH_CODES_REGEX)
  if (withCodes) {
    return new Set(withCodes[1].split(',').map(code => code.trim().toLowerCase()))
  }
  return SUPPRESS_ALL_REGEX.test(content) ? 'all' : null
}

export function scanAddedLines(lines: DiffLine[]): Finding[] {
  const findings = lines
    .filter(line => !SELF_EXCLUDED_FILES.has(line.file))
    .flatMap(line => {
      const suppressed = lineSuppressions(line.content)
      if (suppressed === 'all') return []
      const lineFindings = [
        ...findUrlFindings(line),
        ...findCommandFindings(line),
        ...findSensitivePathFindings(line),
      ]
      return suppressed
        ? lineFindings.filter(f => !suppressed.has(f.code))
        : lineFindings
    })
  return uniqueFindings(findings)
}

export function getGitDiff(baseRef: string): string {
  // 大分支 diff 可达数 MB（实测 ywmatrix-shim 分支 ~2.6MB），spawnSync 默认
  // maxBuffer 仅 1MB，超限会以 ENOBUFS 静默失败，故显式放宽。
  const maxBuffer = 64 * 1024 * 1024
  const mergeBase = spawnSync('git', ['merge-base', baseRef, 'HEAD'], {
    encoding: 'utf8',
    maxBuffer,
  })

  if (mergeBase.status !== 0) {
    throw new Error(
      `Could not determine merge-base with ${baseRef}: ${mergeBase.stderr.trim() || mergeBase.stdout.trim()}`,
    )
  }

  const base = mergeBase.stdout.trim()
  const diff = spawnSync(
    'git',
    ['diff', '--unified=0', '--no-ext-diff', `${base}...HEAD`],
    { encoding: 'utf8', maxBuffer },
  )

  if (diff.status !== 0) {
    // stderr 为空时兜底截断 stdout——失败时 stdout 可能是数 MB 的半截 diff，
    // 整体带进错误信息会淹没真正的原因。
    throw new Error(
      `git diff failed: ${diff.stderr.trim() || diff.stdout.trim().slice(0, 500)}`,
    )
  }

  return diff.stdout
}

function shouldFail(findings: Finding[], failOn: FindingSeverity): boolean {
  if (failOn === 'medium') {
    return findings.length > 0
  }
  return findings.some(finding => finding.severity === 'high')
}

function renderText(findings: Finding[]): string {
  if (findings.length === 0) {
    return 'PR intent scan: no suspicious additions found.'
  }

  const high = findings.filter(f => f.severity === 'high')
  const medium = findings.filter(f => f.severity === 'medium')
  const lines = [
    `PR intent scan: ${findings.length} finding(s)`,
    `- high: ${high.length}`,
    `- medium: ${medium.length}`,
    '',
  ]

  for (const finding of findings) {
    lines.push(
      `[${finding.severity.toUpperCase()}] ${finding.file}:${finding.line} ${finding.detail}`,
    )
    lines.push(`  ${finding.excerpt}`)
  }

  return lines.join('\n')
}

export function run(options: CliOptions): number {
  const diff = getGitDiff(options.baseRef)
  const addedLines = parseAddedLines(diff)
  const findings = scanAddedLines(addedLines)

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          baseRef: options.baseRef,
          addedLines: addedLines.length,
          findings,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(`${renderText(findings)}\n`)
  }

  return shouldFail(findings, options.failOn) ? 1 : 0
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2))
  process.exitCode = run(options)
}
