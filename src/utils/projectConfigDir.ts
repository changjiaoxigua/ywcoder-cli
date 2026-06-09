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
 * 读：`.ywcoder/` 存在则用；否则回退已存在的 `.claude/`（未迁移/迁移失败的项目）；
 * 两者都无则默认指向 `.ywcoder/`（全新项目，让"该在哪"指向新名）。
 */
export function getProjectConfigReadDir(baseDir: string): string {
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

/**
 * @deprecated D7 Phase 0 的过渡 getter（恒返回 `.claude`）。Phase 1 起按读/写/匹配
 * 改用 getProjectConfig{Write,Read}Dir / getProjectConfigDirVariants；本函数仅供尚未
 * 切换的调用点临时兜底，切换完成后移除。
 */
export function getProjectClaudeDir(baseDir: string): string {
  return join(baseDir, LEGACY_PROJECT_CONFIG_DIR)
}
