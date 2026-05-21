/**
 * 全局配置目录的 glob/前缀工具
 *
 * 由于配置目录从 ~/.claude 迁移至 ~/.ywcoder，新生成的规则必须跟随
 * getYwCoderConfigHomeDir() 当前选定的目录走（"写新"），而匹配存量规则
 * 字面量时仍需兼容历史 ~/.claude（"读旧"）。
 *
 * 单独成文件是为了避免 FileEditTool/constants.ts 引入 path/os
 * 造成的循环依赖（参见该文件顶部注释）。
 */

import { homedir } from 'os'
import { getYwCoderConfigHomeDir } from '../envUtils.js'

/**
 * 当前全局配置目录的 glob 模式（用于生成新权限规则）
 * 例：`~/.ywcoder/**` 或 `~/.claude/**`（仅老用户未迁移时）
 */
export function getGlobalConfigPermissionPattern(): string {
  return `${displayPath(getYwCoderConfigHomeDir())}/**`
}

/**
 * 读规则用：兼容前缀列表（当前 + 历史，去重）
 * 用于检查存量规则字面量是否落在"全局配置文件夹"作用域内。
 * 老用户已存有 `~/.claude/**` 规则的，迁移后仍能匹配。
 */
export function getGlobalConfigCompatPrefixes(): string[] {
  const current = `${displayPath(getYwCoderConfigHomeDir())}/`
  const legacy = '~/.claude/'
  return current === legacy ? [current] : [current, legacy]
}

/**
 * 绝对路径前缀列表（filesystem 层做路径归属判断时用）
 * 含当前 helper 选定目录与历史 `~/.claude`，去重。
 */
export function getGlobalConfigDirCandidates(): string[] {
  const list = [getYwCoderConfigHomeDir(), `${homedir()}/.claude`]
  return list.filter((p, i, a) => a.indexOf(p) === i)
}

/**
 * 把绝对路径转回 `~` 开头的显示形式（仅当确实在 home 下）
 * 用于权限规则字符串的可读性；位于 home 外的自定义 CONFIG_DIR
 * 直接返回绝对路径。
 */
function displayPath(abs: string): string {
  const home = homedir()
  return abs === home || abs.startsWith(home + '/') || abs.startsWith(home + '\\')
    ? '~' + abs.slice(home.length)
    : abs
}
