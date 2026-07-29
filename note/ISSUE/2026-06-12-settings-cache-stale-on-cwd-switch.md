# [未完成] 切换 originalCwd 后 settings 缓存未失效（既有问题）

> **状态**：🔲 未完成 · 待单独研究
> **标签**：`#待研究` `#既有问题` `#settings-cache` `#权限边界` `#非品牌替换范围`
> **发现日期**：2026-06-12
> **来源**：feature/brand-replacement 分支 code-review 的人工复核（初版误判为本次 PR 回归，复核后确认为 main 既有问题）
> **优先级**：中（潜在权限边界问题，但触发需多项目/worktree 切换场景）

---

## 问题概述

进程内切换 `originalCwd`（项目根目录）后，settings 的 **per-source 缓存未被清空**，导致后续读取可能返回**上一个项目/工作区**的设置（包括 `permissions.allow` 等安全相关字段）。

## 根因

1. `src/utils/settings/settingsCache.ts`：`perSourceCache = new Map<SettingSource, ...>()` —— 缓存**以 `SettingSource` 名（如 `'projectSettings'`）为 key，不含路径/CWD 信息**。
2. `src/utils/settings/settings.ts:getSettingsForSource` 命中 `getCachedSettingsForSource(source)` 即直接返回，不重新解析路径。
3. 切换 CWD 的调用点**不触发** `resetSettingsCache()`：
   - `src/bridge/bridgeMain.ts:2081`、`2821` —— `setOriginalCwd(dir)` 后无 `resetSettingsCache()`
   - `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:96` —— `setOriginalCwd(getCwd())` 后仅 `clearMemoryFileCaches()`，无 `resetSettingsCache()`

## 为何确认是「既有问题」而非本次 PR 回归

- git 比对 main 分支：上述 `bridgeMain.ts` 两处、`EnterWorktreeTool.ts` 行为**完全一致**（main 中 EnterWorktreeTool 的 `resetSettingsCache` 出现 0 次），本次 diff 未触及这些文件。
- 本次 PR 仅把 `getRelativeSettingsFilePathForSource` 从静态串改为 `getProjectConfigDir(getOriginalCwd())`，但**缓存命中路径根本不会调到该函数**（命中 `getCachedSettingsForSource` 即返回），故对本 stale 行为**零因果贡献**。

## 影响场景

- **bridge 多项目模式**：请求 A（项目 `/work/proj-a`，宽松权限）→ 请求 B（项目 `/work/proj-b`，严格权限）。B 的会话可能命中 A 缓存的 `projectSettings`，用 A 的 `permissions.allow` 运行 —— 潜在权限边界突破。
- **worktree 切换**：主仓库读过 settings 后进入 worktree，worktree 的 `.claude/settings.json`（可能有不同权限规则）被主仓库缓存覆盖。

## 候选修复方向（待评估）

1. **最小**：在所有 `setOriginalCwd()` 调用点之后统一调用 `resetSettingsCache()`（bridge ×2 + EnterWorktreeTool；并排查是否有其他 `setOriginalCwd` 调用点）。
2. **更深**：把 settings 缓存 key 纳入 root 路径（`Map<root|source, ...>`），从机制上消除「切 CWD 不清缓存」类问题，无需在每个调用点手动清。
3. 补回归测试：模拟 setOriginalCwd 切换后断言 settings 重新解析。

## 待办清单

- [ ] 全量排查 `setOriginalCwd` 的所有调用点
- [ ] 评估方向 1（手动清）vs 方向 2（key 纳入路径）的取舍
- [ ] 确认 bridge 多项目模式是否真实复用同一进程缓存（影响严重性定级）
- [ ] 补回归测试覆盖切换后缓存失效
- [ ] **谨慎**：改 bridge/worktree 行为需独立 PR + 充分验证，不混入品牌替换分支

## 关联

- 关联 code-review：`note/BRAND_MIGRATION_2026-06-07/temp/CODE_REVIEW_2026-06-12.md`（F1 / F3）
- 上游注释线索：`config.ts` 中 `wouldLoseAuthState` 的 "See GH #3117"（auth 缓存防丢失，与本问题同属缓存一致性家族）
