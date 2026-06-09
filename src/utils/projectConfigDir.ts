import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { feature } from 'bun:bundle'

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
 *
 * ⚠️ Stage 1c：整个 `.ywcoder` 行为受**编译期 flag `MIGRATE_PROJECT_CONFIG`** 门控
 * （DECISIONS.md D7「双场景 + 编译期开关」）：
 * - **OFF（默认 / dev 构建）**：读/写恒落旧 `.claude/`，行为=原版，与官方 Claude Code 完全共用，
 *   零干扰（开发者同一项目并用 CC + ywcoder 的场景）。`.ywcoder` 分支经 DCE 删除。
 * - **ON（内网发布构建，build.ts featureFlags 设 true）**：走下方 active-dir / `.ywcoder` 逻辑 + 迁移。
 * 公开 getter 用三元注入 flag（满足 `bun:bundle` 的「feature() 仅限 if/三元条件」约束，且 OFF 时
 * 死分支可 DCE）；纯解析器 `resolve*` 取显式 `migrate` 参数，供单测覆盖 on/off 两种路径
 * （`bun test` 下 feature() 恒 false，无法直接测 ON 分支）。
 * 注：`getProjectConfigDirVariants` 不受 flag 影响——恒返回两边（认两边无害，OFF 时也只有 `.claude` 存在）。
 */

const PROJECT_CONFIG_DIR = '.ywcoder'
const LEGACY_PROJECT_CONFIG_DIR = '.claude'

/**
 * 显示 / prompt 用的当前生效项目配置目录**名字**（编译期常量，受 flag 门控、可 DCE）：
 * ON→`.ywcoder`、OFF→`.claude`。用于把"在 X 目录下建技能/读规则/写 settings"等指引
 * 与发往 LLM 的 prompt 文案对齐到真实落盘目录（区别于 getProjectConfigDir 的运行时存在性择优）。
 * 取写目标名即可——Stage 2 迁移在启动期已把 .claude/ 搬到 .ywcoder/，故 prompt 指向 .ywcoder 正确。
 */
export const ACTIVE_PROJECT_CONFIG_DIR_NAME = feature('MIGRATE_PROJECT_CONFIG')
  ? PROJECT_CONFIG_DIR
  : LEGACY_PROJECT_CONFIG_DIR

/**
 * 写 / mkdir 的纯解析器：`migrate=true` → 恒落 `.ywcoder/`（不做存在性回退，否则全新项目会回退
 * 建出 `.claude/`，违背去标识）；`migrate=false` → 恒落旧 `.claude/`（原版行为）。
 */
export function resolveProjectConfigWriteDir(
  baseDir: string,
  migrate: boolean,
): string {
  return join(baseDir, migrate ? PROJECT_CONFIG_DIR : LEGACY_PROJECT_CONFIG_DIR)
}

/**
 * 当前生效配置目录的纯解析器：
 * - `migrate=false`（flag OFF）→ 恒返回旧 `.claude/`（原版行为）。
 * - `migrate=true`（flag ON）→ `.ywcoder/` 存在则用；否则回退已存在的 `.claude/`
 *   （未迁移/迁移失败/只读仓库）；两者都无则默认 `.ywcoder/`（全新项目）。
 */
export function resolveProjectConfigDir(
  baseDir: string,
  migrate: boolean,
): string {
  if (!migrate) return join(baseDir, LEGACY_PROJECT_CONFIG_DIR)
  const newDir = join(baseDir, PROJECT_CONFIG_DIR)
  if (existsSync(newDir)) return newDir
  const legacyDir = join(baseDir, LEGACY_PROJECT_CONFIG_DIR)
  if (existsSync(legacyDir)) return legacyDir
  return newDir
}

/**
 * 写 / mkdir：新建内容落当前生效目录（flag ON→`.ywcoder/`，OFF→`.claude/`）。
 */
export function getProjectConfigWriteDir(baseDir: string): string {
  return feature('MIGRATE_PROJECT_CONFIG')
    ? resolveProjectConfigWriteDir(baseDir, true)
    : resolveProjectConfigWriteDir(baseDir, false)
}

/**
 * 当前生效的项目配置目录（**读和写都用它**）。flag ON 时 `.ywcoder/` 优先回退 `.claude/`、
 * 都无默认 `.ywcoder/`；OFF 时恒 `.claude/`（原版）。
 *
 * 用于写也安全：flag ON 全新项目走"默认 `.ywcoder/`"分支，**不会**回退去建 `.claude/`；
 * 迁移在启动早期把 `.claude/` 整体搬到 `.ywcoder/`，故运行时正常项目此函数恒返回 `.ywcoder/`，
 * 读写一致（避免"读旧写新"的分裂）。强制新目录（迁移目标）用 getProjectConfigWriteDir。
 */
export function getProjectConfigDir(baseDir: string): string {
  return feature('MIGRATE_PROJECT_CONFIG')
    ? resolveProjectConfigDir(baseDir, true)
    : resolveProjectConfigDir(baseDir, false)
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
 * **生成**会话级"允许 YwCoder 编辑自身配置目录"权限规则用的 glob（项目相对，前导 `/`）。
 * 取当前生效目录名（受 flag 门控：ON→`.ywcoder`、OFF→`.claude`），保证新建规则能命中
 * 用户实际正在编辑的活跃目录下文件。**匹配存量规则**请认两边（见 filesystem 的 validPrefixes）。
 */
export function getProjectConfigFolderPermissionPattern(baseDir: string): string {
  return `/${basename(getProjectConfigDir(baseDir))}/**`
}
