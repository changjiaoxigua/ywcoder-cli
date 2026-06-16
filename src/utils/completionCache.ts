import chalk from 'chalk'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { color } from '../components/design-system/color.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { logForDebugging } from './debug.js'
import { getYwCoderConfigHomeDir } from './envUtils.js'
import { isENOENT } from './errors.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'
import type { ThemeName } from './theme.js'

const EOL = '\n'

type ShellInfo = {
  name: string
  rcFile: string
  cacheFile: string
  completionLine: string
  shellFlag: string
}

function detectShell(): ShellInfo | null {
  const shell = process.env.SHELL || ''
  const home = homedir()
  // 补全缓存落统一配置目录（已迁移→~/.ywcoder，未迁移→~/.claude），不再硬编码 ~/.claude。
  // home 仍保留：用于 rcFile（.zshrc/.bashrc）与 fish 的 XDG 回退。
  const claudeDir = getYwCoderConfigHomeDir()

  if (shell.endsWith('/zsh') || shell.endsWith('/zsh.exe')) {
    const cacheFile = join(claudeDir, 'completion.zsh')
    return {
      name: 'zsh',
      rcFile: join(home, '.zshrc'),
      cacheFile,
      completionLine: `[[ -f "${cacheFile}" ]] && source "${cacheFile}"`,
      shellFlag: 'zsh',
    }
  }
  if (shell.endsWith('/bash') || shell.endsWith('/bash.exe')) {
    const cacheFile = join(claudeDir, 'completion.bash')
    return {
      name: 'bash',
      rcFile: join(home, '.bashrc'),
      cacheFile,
      completionLine: `[ -f "${cacheFile}" ] && source "${cacheFile}"`,
      shellFlag: 'bash',
    }
  }
  if (shell.endsWith('/fish') || shell.endsWith('/fish.exe')) {
    const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config')
    const cacheFile = join(claudeDir, 'completion.fish')
    return {
      name: 'fish',
      rcFile: join(xdg, 'fish', 'config.fish'),
      cacheFile,
      completionLine: `[ -f "${cacheFile}" ] && source "${cacheFile}"`,
      shellFlag: 'fish',
    }
  }
  return null
}

/**
 * 迁移辅助：判断用户此前是否在 legacy 目录（如 ~/.claude）配置过当前 shell 的补全脚本
 * （即 <legacyDir>/completion.<shell> 是否存在）。
 *
 * 用途：补全缓存目录已随品牌迁移挪到新配置目录，但用户 rc 文件里的 `source` 行仍指向
 * legacy 路径，需重跑 /terminal-setup 才会刷新。migrate-config 据此决定是否提示用户。
 */
export function hasLegacyShellCompletion(legacyDir: string): boolean {
  const shell = detectShell()
  if (!shell) return false
  // cacheFile 现已解析到新目录，但其文件名（completion.<shell>）与目录无关，
  // 故用 basename 拼回 legacy 目录即得旧补全文件路径。
  return existsSync(join(legacyDir, basename(shell.cacheFile)))
}

function formatPathLink(filePath: string): string {
  if (!supportsHyperlinks()) {
    return filePath
  }
  const fileUrl = pathToFileURL(filePath).href
  return `\x1b]8;;${fileUrl}\x07${filePath}\x1b]8;;\x07`
}

/**
 * Generate and cache the completion script, then add a source line to the
 * shell's rc file. Returns a user-facing status message.
 */
export async function setupShellCompletion(theme: ThemeName): Promise<string> {
  const shell = detectShell()
  if (!shell) {
    return ''
  }

  // Ensure the cache directory exists
  try {
    await mkdir(dirname(shell.cacheFile), { recursive: true })
  } catch (e: unknown) {
    logError(e)
    return `${EOL}${color('warning', theme)(`Could not write ${shell.name} completion cache`)}${EOL}${chalk.dim(`Run manually: ywcoder completion ${shell.shellFlag} > ${shell.cacheFile}`)}${EOL}`
  }

  // Generate the completion script by writing directly to the cache file.
  // Using --output avoids piping through stdout where process.exit() can
  // truncate output before the pipe buffer drains.
  const claudeBin = process.argv[1] || 'ywcoder'
  const result = await execFileNoThrow(claudeBin, [
    'completion',
    shell.shellFlag,
    '--output',
    shell.cacheFile,
  ])
  if (result.code !== 0) {
    return `${EOL}${color('warning', theme)(`Could not generate ${shell.name} shell completions`)}${EOL}${chalk.dim(`Run manually: ywcoder completion ${shell.shellFlag} > ${shell.cacheFile}`)}${EOL}`
  }

  // Check if rc file already sources completions
  let existing = ''
  try {
    existing = await readFile(shell.rcFile, { encoding: 'utf-8' })
    if (
      existing.includes('ywcoder completion') ||
      existing.includes('claude completion') ||
      existing.includes(shell.cacheFile)
    ) {
      return `${EOL}${color('success', theme)(`Shell completions updated for ${shell.name}`)}${EOL}${chalk.dim(`See ${formatPathLink(shell.rcFile)}`)}${EOL}`
    }
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      logError(e)
      return `${EOL}${color('warning', theme)(`Could not install ${shell.name} shell completions`)}${EOL}${chalk.dim(`Add this to ${formatPathLink(shell.rcFile)}:`)}${EOL}${chalk.dim(shell.completionLine)}${EOL}`
    }
  }

  // Append source line to rc file
  try {
    const configDir = dirname(shell.rcFile)
    await mkdir(configDir, { recursive: true })

    const separator = existing && !existing.endsWith('\n') ? '\n' : ''
    const content = `${existing}${separator}\n# YwCoder shell completions\n${shell.completionLine}\n`
    await writeFile(shell.rcFile, content, { encoding: 'utf-8' })

    return `${EOL}${color('success', theme)(`Installed ${shell.name} shell completions`)}${EOL}${chalk.dim(`Added to ${formatPathLink(shell.rcFile)}`)}${EOL}${chalk.dim(`Run: source ${shell.rcFile}`)}${EOL}`
  } catch (error) {
    logError(error)
    return `${EOL}${color('warning', theme)(`Could not install ${shell.name} shell completions`)}${EOL}${chalk.dim(`Add this to ${formatPathLink(shell.rcFile)}:`)}${EOL}${chalk.dim(shell.completionLine)}${EOL}`
  }
}

/**
 * Regenerate cached shell completion scripts in the active config dir
 * (getYwCoderConfigHomeDir()). Called after `ywcoder update` so completions
 * stay in sync with the new binary.
 */
export async function regenerateCompletionCache(): Promise<void> {
  const shell = detectShell()
  if (!shell) {
    return
  }

  logForDebugging(`update: Regenerating ${shell.name} completion cache`)

  const claudeBin = process.argv[1] || 'ywcoder'
  const result = await execFileNoThrow(claudeBin, [
    'completion',
    shell.shellFlag,
    '--output',
    shell.cacheFile,
  ])

  if (result.code !== 0) {
    logForDebugging(
      `update: Failed to regenerate ${shell.name} completion cache`,
    )
    return
  }

  logForDebugging(
    `update: Regenerated ${shell.name} completion cache at ${shell.cacheFile}`,
  )
}
