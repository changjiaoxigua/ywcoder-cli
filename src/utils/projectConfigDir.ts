import { join } from 'node:path'

/**
 * 项目级配置目录（仓库内的 `.claude/`）的中心解析点。
 *
 * 这是 `.claude/` → `.ywcoder/` 迁移（DECISIONS.md D7）的单一改动点：
 * - **Phase 0（当前）**：行为保持不变——仍返回 `.claude`。本阶段只把散落各处的
 *   `join(base, '.claude', …)` 收敛到此函数，零行为变更（build/test 应完全等价）。
 * - **Phase 1（后续）**：改为 `.ywcoder/` 优先 + `.claude/` 读回退（写策略 Option B：
 *   写 `.ywcoder/`，`.claude/` 仅读回退 + 一次性迁移存量）。届时只改这里（及拆分
 *   读/写 helper），不必再动各调用点。
 *
 * 适用范围：**仅项目级**（cwd / 项目根 / git 根 / worktree 等 baseDir 下的 `.claude/`）。
 * 不覆盖、调用方也不要经此处理：
 * - HOME 配置目录 `~/.ywcoder`（见 getYwCoderConfigHomeDir）
 * - 全局配置文件 `~/.claude.json`（见 getGlobalClaudeFile，Phase 3 单独处理）
 * - 插件清单约定 `.claude-plugin/`（生态硬约定，永久保留）
 * - 记忆文件 `CLAUDE.md` / `YWCODER.md`
 *
 * @param baseDir 项目级基准目录（如 getCwd()、git 根、遍历到的目录）
 * @returns 该基准目录下的项目配置目录路径
 */
export function getProjectClaudeDir(baseDir: string): string {
  return join(baseDir, '.claude')
}
