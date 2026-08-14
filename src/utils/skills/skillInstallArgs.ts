/**
 * /skill-install 参数解析。
 *
 * 纯函数、零依赖，便于独立单测。规则见
 * note/feature_intranet_skill_install/design-option1-lite.md §2.1。
 *
 * 命令面：
 *   /skill-install                          列出内网 skill（list，user 视角）
 *   /skill-install --project                列出内网 skill（list，project 视角）
 *   /skill-install <id> [--project] [--force]   安装 / 更新
 *   /skill-install --remove <id> [--project]    卸载
 */

/** 清单 id 合法性格式（§3.1）：同时是目录名与 slash 命令名 */
export const SKILL_ID_REGEX = /^[a-z0-9][a-z0-9._-]*$/i
export const SKILL_ID_MAX_LENGTH = 64

export type SkillInstallArgs =
  // 列表形态带 project：/skill-install --project 以项目级视角列出并安装（§2）
  | { kind: 'list'; project: boolean }
  | { kind: 'install'; id: string; project: boolean; force: boolean }
  | { kind: 'remove'; id: string; project: boolean }

export type ParseSkillInstallArgsResult =
  | { ok: true; args: SkillInstallArgs }
  | { ok: false; error: string }

/** 校验 id 合法性，合法返回 null，非法返回错误文案 */
export function validateSkillId(id: string): string | null {
  if (id.length === 0 || id.length > SKILL_ID_MAX_LENGTH) {
    return `id 长度须为 1-${SKILL_ID_MAX_LENGTH} 个字符：${id}`
  }
  if (!SKILL_ID_REGEX.test(id)) {
    return `id 只能包含字母、数字、点、下划线、连字符，且须以字母或数字开头：${id}`
  }
  return null
}

export function parseSkillInstallArgs(
  raw: string,
): ParseSkillInstallArgsResult {
  const tokens = raw.split(/\s+/).filter(Boolean)

  let project = false
  let force = false
  let removeId: string | null = null
  const positionals: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--project') {
      if (project) return { ok: false, error: '重复 flag：--project' }
      project = true
    } else if (token === '--force') {
      if (force) return { ok: false, error: '重复 flag：--force' }
      force = true
    } else if (token === '--remove') {
      if (removeId !== null) return { ok: false, error: '重复 flag：--remove' }
      const next = tokens[i + 1]
      if (next === undefined || next.startsWith('-')) {
        return { ok: false, error: '--remove 缺少参数（要卸载的 skill id）' }
      }
      removeId = next
      i++
    } else if (token.startsWith('-')) {
      return { ok: false, error: `未知 flag：${token}` }
    } else {
      positionals.push(token)
    }
  }

  if (removeId !== null) {
    if (positionals.length > 0) {
      return {
        ok: false,
        error: `不能同时出现安装 id 与 --remove：${positionals.join(' ')}`,
      }
    }
    if (force) {
      return { ok: false, error: '--force 不能与 --remove 同时使用' }
    }
    const idError = validateSkillId(removeId)
    if (idError) return { ok: false, error: idError }
    return { ok: true, args: { kind: 'remove', id: removeId, project } }
  }

  if (positionals.length === 0) {
    if (force) {
      return { ok: false, error: '--force 需要配合安装 id 使用' }
    }
    return { ok: true, args: { kind: 'list', project } }
  }
  if (positionals.length > 1) {
    return {
      ok: false,
      error: `多余的位置参数：${positionals.slice(1).join(' ')}`,
    }
  }

  const id = positionals[0]
  const idError = validateSkillId(id)
  if (idError) return { ok: false, error: idError }
  return { ok: true, args: { kind: 'install', id, project, force } }
}
