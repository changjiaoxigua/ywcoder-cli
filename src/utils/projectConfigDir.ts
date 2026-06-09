import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 项目级配置目录（仓库内的 `.claude/` → `.ywcoder/`）的中心解析点。
 *
 * D7 迁移策略（DECISIONS.md，Option B「整目录搬」）：
 * - 启动早期一次性把项目 `.claude/` 搬到 `.ywcoder/`（跳过 `worktrees/`，同步 gitignore，
 *   备份、幂等、优雅降级，见 projectConfigMigration）。
 * - 之后**写**恒落 `.ywcoder/`；**读** `.ywcoder/` 优先、回退 `.claude/`（未迁/迁失败时）。
 *   因迁移把整个目录搬走，读用**目录级择优**即可，无需逐文件合并。
 *
 * 适用范围：**仅项目级**（cwd / 项目根 / git 根 等 baseDir 下的配置目录）。不覆盖：
 * HOME `~/.ywcoder`（getYwCoderConfigHomeDir）、全局配置文件 `~/.claude.json`
 * （getGlobalClaudeFile，Phase 3）、插件清单约定 `.claude-plugin/`（生态硬约定，永久保留）、
 * 记忆文件名 `CLAUDE.md`/`YWCODER.md`、managed 系统级 `getManagedFilePath()/.claude`。
 */

const PROJECT_CONFIG_DIR = '.ywcoder'
const LEGACY_PROJECT_CONFIG_DIR = '.claude'

/**
 * 写 / mkdir：新建内容恒落 `.ywcoder/`。
 * 不做存在性回退——否则全新项目（两者都不存在）会回退建出 `.claude/`，违背去标识。
 */
export function getProjectConfigWriteDir(baseDir: string): string {
  return join(baseDir, PROJECT_CONFIG_DIR)
}

/**
 * 当前生效的项目配置目录（**读和写都用它**）：`.ywcoder/` 存在则用；否则回退已存在的
 * `.claude/`（未迁移/迁移失败/只读仓库）；两者都无则默认 `.ywcoder/`（全新项目）。
 *
 * 用于写也安全：全新项目走"默认 `.ywcoder/`"分支，**不会**回退去建 `.claude/`；
 * 迁移在启动早期把 `.claude/` 整体搬到 `.ywcoder/`，故运行时正常项目此函数恒返回 `.ywcoder/`，
 * 读写一致（避免"读旧写新"的分裂）。强制新目录（迁移目标）用 getProjectConfigWriteDir。
 */
export function getProjectConfigDir(baseDir: string): string {
  const newDir = join(baseDir, PROJECT_CONFIG_DIR)
  if (existsSync(newDir)) return newDir
  const legacyDir = join(baseDir, LEGACY_PROJECT_CONFIG_DIR)
  if (existsSync(legacyDir)) return legacyDir
  return newDir
}

/**
 * 匹配：返回 baseDir 下两个变体目录 `[.ywcoder, .claude]`，供权限/比较场景同时识别。
 * 过渡期旧 `.claude/` 路径也要被认作内部配置目录（否则旧路径会被权限拒/漏匹配）。
 */
export function getProjectConfigDirVariants(baseDir: string): [string, string] {
  return [
    join(baseDir, PROJECT_CONFIG_DIR),
    join(baseDir, LEGACY_PROJECT_CONFIG_DIR),
  ]
}
