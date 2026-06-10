/**
 * D7 Stage 2：项目级配置目录迁移（仓库内 `.claude/` → `.ywcoder/`）。
 *
 * 受**编译期 flag `MIGRATE_PROJECT_CONFIG`** 门控（DECISIONS.md D7「双场景 + 编译期开关」）：
 * - OFF（默认 / dev 构建）：`migrateProjectConfig` 直接早退，整段迁移逻辑被 DCE 删除——
 *   行为=原版，与官方 Claude Code 完全共用 `.claude/`，零干扰。
 * - ON（内网发布构建）：启动早期（settings 加载前）跑一次，把存量 `.claude/` 内容迁到 `.ywcoder/`。
 *
 * 处置策略（**copy-keep，最安全、可逆**）：
 * - **复制**（非破坏性移动）`.claude/` → `.ywcoder/`，原 `.claude/` 原样留作天然备份 + 读回退，
 *   不删除任何用户文件。迁完后 getProjectConfigDir（ON）因 `.ywcoder/` 存在而恒用新目录，
 *   `.claude/` 转为休眠（仅未迁/迁失败时才被读回退命中）。
 * - **跳过 `worktrees/` 天窗**：git worktree 路径已注册进 `.git`，盲搬会断链损坏；不复制它。
 * - **同步 `.gitignore`**：为引用 `.claude/` 的忽略规则**追加**并行的 `.ywcoder/` 规则（不删旧规则，
 *   因 `.claude/` 仍在），防止 `.ywcoder/settings.local.json` 等本应忽略的文件失配被误提交。
 * - **幂等**：`.ywcoder/` 已存在 → 视为已迁移，跳过。
 * - **优雅降级**：只读仓库 / 无权限 / cp 失败 → 记 debug 日志、返回 failed，**不抛出**；
 *   helper 的读回退继续用 `.claude/`，启动不被打断。
 * - **安静执行**：全程 debug 日志，无 console 噪音、无用户可见输出（零运行时表面）。
 *
 * ⚠️ Stage 2 仅落本模块 + 单测，**尚未接进启动流程**（待 review）。
 */

import { existsSync } from 'node:fs'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { feature } from 'bun:bundle'
import { logForDebugging } from './debug.js'

const PROJECT_CONFIG_DIR = '.ywcoder'
const LEGACY_PROJECT_CONFIG_DIR = '.claude'
/** git worktrees 天窗：留在 `.claude/`，不迁移。 */
const WORKTREES_SKYLIGHT = 'worktrees'

export type ProjectMigrationStatus =
  | 'skipped-flag-off' // flag OFF（dev/原版）
  | 'skipped-no-source' // 无 .claude/（全新项目，无需迁移）
  | 'already-migrated' // .ywcoder/ 已存在（幂等跳过）
  | 'migrated' // 成功复制到 .ywcoder/
  | 'failed' // 复制失败（已优雅降级，仍用 .claude/）

export interface ProjectMigrationResult {
  status: ProjectMigrationStatus
  from?: string
  to?: string
  message: string
}

/**
 * 启动期调用入口（**受 flag 门控**）。OFF 时早退，迁移逻辑随之被 DCE。
 */
export async function migrateProjectConfig(
  projectRoot: string,
): Promise<ProjectMigrationResult> {
  if (!feature('MIGRATE_PROJECT_CONFIG')) {
    return {
      status: 'skipped-flag-off',
      message: 'MIGRATE_PROJECT_CONFIG off; project config migration disabled',
    }
  }
  return runProjectConfigMigration(projectRoot)
}

/**
 * 迁移核心（**不读 flag**，供单测覆盖真实行为；`bun test` 下 feature() 恒 OFF，
 * 无法经 migrateProjectConfig 直接测迁移路径）。
 */
export async function runProjectConfigMigration(
  projectRoot: string,
): Promise<ProjectMigrationResult> {
  const newDir = join(projectRoot, PROJECT_CONFIG_DIR)
  const legacyDir = join(projectRoot, LEGACY_PROJECT_CONFIG_DIR)

  // 幂等：已存在 .ywcoder/ → 认定已迁移，不动。
  if (existsSync(newDir)) {
    return {
      status: 'already-migrated',
      to: newDir,
      message: `${PROJECT_CONFIG_DIR}/ already exists; skip`,
    }
  }

  // 无 .claude/（全新项目）：无需迁移，写入时 helper 会默认落 .ywcoder/。
  if (!existsSync(legacyDir)) {
    return {
      status: 'skipped-no-source',
      message: `no ${LEGACY_PROJECT_CONFIG_DIR}/ to migrate`,
    }
  }

  // 复制 .claude/ → .ywcoder/，跳过 worktrees 天窗。force:false 不覆盖（目标本不存在）。
  try {
    await cp(legacyDir, newDir, {
      recursive: true,
      force: false,
      preserveTimestamps: true,
      filter: src => {
        const rel = relative(legacyDir, src)
        // 跳过天窗目录本身及其子树。
        return (
          rel !== WORKTREES_SKYLIGHT &&
          !rel.startsWith(WORKTREES_SKYLIGHT + sep)
        )
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(
      `[projectConfigMigration] copy ${legacyDir} → ${newDir} failed: ${message}; ` +
        `falling back to legacy ${LEGACY_PROJECT_CONFIG_DIR}/`,
    )
    return {
      status: 'failed',
      from: legacyDir,
      to: newDir,
      message: `copy failed: ${message}`,
    }
  }

  // 同步 .gitignore（失败不影响迁移结果，仅记 debug）。
  await syncGitignore(projectRoot).catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`[projectConfigMigration] gitignore sync failed: ${message}`)
  })

  logForDebugging(
    `[projectConfigMigration] copied ${legacyDir} → ${newDir} ` +
      `(worktrees/ skipped, legacy ${LEGACY_PROJECT_CONFIG_DIR}/ kept as backup)`,
  )
  return {
    status: 'migrated',
    from: legacyDir,
    to: newDir,
    message: 'project config copied to .ywcoder/ (legacy kept)',
  }
}

/**
 * 为 `.gitignore` 中引用 `.claude/` 的规则**追加**并行的 `.ywcoder/` 规则（幂等）。
 * - 不删旧 `.claude/` 规则（copy-keep 下 `.claude/` 仍在，旧规则照常生效）。
 * - 跳过 `.claude-plugin`（生态硬约定）与含 `worktrees` 的行（天窗仍在 `.claude/`）。
 * - 已存在等价 `.ywcoder/` 行的不重复追加。
 */
async function syncGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = join(projectRoot, '.gitignore')
  if (!existsSync(gitignorePath)) return

  const content = await readFile(gitignorePath, 'utf8')
  const lines = content.split('\n')
  const existing = new Set(lines.map(l => l.trim()))

  const additions: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (!trimmed.includes(LEGACY_PROJECT_CONFIG_DIR)) continue
    // 护栏 / 天窗：不为这些行造 .ywcoder 并行规则。
    if (trimmed.includes('.claude-plugin')) continue
    if (trimmed.includes(WORKTREES_SKYLIGHT)) continue

    const ywVariant = trimmed.replaceAll(
      LEGACY_PROJECT_CONFIG_DIR,
      PROJECT_CONFIG_DIR,
    )
    if (ywVariant === trimmed) continue
    if (existing.has(ywVariant) || additions.includes(ywVariant)) continue
    additions.push(ywVariant)
  }

  if (additions.length === 0) return

  const block =
    '\n# D7 迁移自动追加：.ywcoder/ 配置目录忽略规则（与上方 .claude/ 规则并行）\n' +
    additions.join('\n') +
    '\n'
  await writeFile(gitignorePath, content.replace(/\n*$/, '\n') + block)
  logForDebugging(
    `[projectConfigMigration] appended ${additions.length} .ywcoder/ rule(s) to .gitignore`,
  )
}
