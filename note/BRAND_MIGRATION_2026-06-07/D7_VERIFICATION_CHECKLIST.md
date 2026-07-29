# D7 验证 / Stage 4 重测清单（可逐项打勾跟踪）

**用途**：D7 代码主体已完成，本清单是交付前的**验证/重测**项。单独窗口按此逐条验，打勾记录。
**前置**：先读 [START_HERE.md](START_HERE.md) §一 看整体状态。**最近基线**：`bun run build` + `bun test --max-concurrency=1` = **599 pass**（clean env，注意别让 shell 预存 `CLAUDE_CODE_USE_OPENAI`，否则 3 个 fastMode 测试会因环境依赖失败，非回归）。
**本清单状态（2026-06-10 验证窗口后）**：A/D/E 自动化全绿；B 节 dist 折叠已验、交互待人工；C 节代码/单测已验、纯新装流程待人工；已发现并修 14 处路径插值漏洞（7 文件未 commit）；dist 残留 5 处待下窗口修（见 START_HERE.md §一）。
**关键背景**：项目级迁移受**构建期 env** `MIGRATE_PROJECT_CONFIG=true` 门控（默认关）；feature flag 经 `Bun.build({features})` 生效（见 [build-feature-flags-plan.md](build-feature-flags-plan.md) 附录 B）。

---

## A. 自动化回归（先跑，确认基线绿）
- [x] `bun run build` 成功
- [x] `bun run smoke`（`node dist/cli.mjs --version` 正常）
- [x] `env -u CLAUDE_CODE_USE_OPENAI bun test --max-concurrency=1` = **599 pass / 0 fail** ✅
- [x] `bun run security:pr-scan -- --base origin/main`（按 CLAUDE.md CI 清单）
- [x] `bun run test:provider` / `test:provider-recommendation`（139 + 46 = 185 pass）

## B. 8 个新启用 feature 功能运行时冒烟（机制修复后首次真生效）
> **dist 折叠已验 ✅**（build 脚本确认 8 个 flag 全 true，AUTO_THEME 按设计关）；交互 UX 确认**延至内网测试**。
- [x] dist 折叠确认：8 个 flag 全 true，AUTO_THEME 按设计关 ✅
- [ ] ⏭️ **BUILTIN_EXPLORE_PLAN_AGENTS**：**延至内网测试**
- [ ] ⏭️ **NATIVE_CLIPBOARD_IMAGE**：**延至内网测试**
- [ ] ⏭️ **QUICK_SEARCH**：**延至内网测试**
- [ ] ⏭️ **HISTORY_PICKER**：**延至内网测试**
- [ ] ⏭️ **MCP_RICH_OUTPUT**：**延至内网测试**
- [ ] ⏭️ **COMPACTION_REMINDERS**：**延至内网测试**
- [ ] ⏭️ **POWERSHELL_AUTO_MODE**：（Windows 专项）**延至内网测试**
- [ ] ⏭️ **HOOK_PROMPTS**：**延至内网测试**
- [ ] 注：**AUTO_THEME 不在范围**（源 `systemThemeWatcher.js` 缺失、当前关）

## C. Stage 3a — 全局 auth 文件（⚠️ auth 敏感，必验）
> commit `3017ac6`。getGlobalClaudeFile 三分支：新装落 `.ywcoder/.config.json`、存量 `~/.claude.json` 续用。
> **已验（代码/单测）**：三分支逻辑正确，单测 4 pass；开发机为存量用户（`~/.claude.json` 存在）→ branch 2 路径已确认 ✅。
> **⏭️ 纯新装/已迁移场景延至内网测试补验**（需干净登录环境）。
- [x] **存量已登录用户**：代码验 branch 2 正确，开发机实测 `~/.claude.json` 读回退 ✅
- [ ] ⏭️ **纯新装**（无 `~/.ywcoder/.config.json` 且无 `~/.claude.json`）：**延至内网测试**——需干净环境登录一次，确认 token 落 `~/.ywcoder/.config.json`、重启仍在线、**不生成** `~/.claude.json`
- [ ] ⏭️ **已迁移用户**（`~/.ywcoder/.config.json` 存在）：**延至内网测试**——用新文件、登录态正常

## D. 项目级迁移（Stage 2，仅 `MIGRATE_PROJECT_CONFIG=true` 构建下）
> dev 默认构建此项为关、不触发。需要时：`MIGRATE_PROJECT_CONFIG=true bun run build` 再于含 `.claude/` 的项目启动。
> **已验（代码/单测/DCE）**：迁移模块单测 8 pass，configDir 单测 11 pass；ON 构建迁移代码内联 34 处 ✅，OFF 构建 DCE 完全 0 处 ✅；START_HERE.md 记录此前已做过真实端到端验证通过。
- [x] ON 构建包含迁移代码，OFF 构建 DCE 完全 ✅
- [x] 迁移模块单测全绿（8 pass）✅
- [ ] （可选重验）含 `.claude/` 的项目启动 → 生成 `.ywcoder/`（settings/skills 等递归复制）
- [ ] （可选重验）`.claude/worktrees/` **未**被搬进 `.ywcoder/`；原 `.claude/` 保留；`.gitignore` 追加规则；幂等

## E. Stage 4 综合重测（D7 触及的子系统，默认 OFF 构建下应与原版等价）
> **已验（单测）**：permissions/memory/configDir/migration/env + updateConfig skill 共 53 pass ✅。
> **⏭️ 交互项延至内网测试补验**。
- [x] settings/permissions/memory/configDir 子系统单测全绿 ✅
- [ ] ⏭️ worktree 创建/进入（**延至内网测试**）
- [ ] ⏭️ 登录/认证（**延至内网测试**，连 C 项一起）
- [ ] ⏭️ 插件 enable/disable（**延至内网测试**）
- [ ] ⏭️ agent-memory user/project/local 三 scope 落盘与显示（**延至内网测试**）
- [ ] ⏭️ scheduled tasks cron 文件路径（**延至内网测试**）

## F. 已知延后项（不阻塞交付，记录在案）
- [ ] `AUTO_THEME` 源缺失：补 `systemThemeWatcher.js` 或长期关
- [ ] `ide.ts` WSL `.claude/ide` 路径-of-record（WSL+IDE 才命中）
- [ ] P2 注释级 `~/.claude` / `.claude`（不进 bundle）
- [ ] HOME 迁移 `migrateConfig()` 仍仅 `ywcoder --migrate-config` 手动触发（按计划，安装脚本最后做）
- [ ] **settings watcher 不监视空目录**：`changeDetector.ts` `getWatchTargets()` 只把"启动时已有 settings 文件"的目录加入监视集；若项目首次配置 hooks（settings.json 不存在）→ watcher 不触发 → `updateHooksConfigSnapshot()` 不调用 → 需重启或手动开 `/hooks` 才生效。修法：把"settings 文件存在"判断改为"父目录存在"。与 D7 无关，独立 bug。
- [ ] **dev 构建无法直接测试 `.ywcoder/` 项目级 settings**：`MIGRATE_PROJECT_CONFIG=false`（默认）时项目 settings 恒用 `.claude/`，开发者无法在 `bun run dev` 下验证 `.ywcoder/` 路径行为，需 `MIGRATE_PROJECT_CONFIG=true bun run dev` 重新构建。可考虑增加运行时 env 覆盖（类似 `YWCODER_CONFIG_DIR`）来降低测试摩擦，但会引入运行时表面，需重新评估 D7 设计。

## G. 代码残留修复（Phase D 前必清，下窗口处理）
> 本节是验证窗口 dist scan 新发现的漏洞，不在原 D7 范围内，但 Phase D 前需修。
- [ ] 🔴 **P0** `src/commands/statusline.tsx:12`：`allowedTools` 里 `Edit(~/.claude/settings.json)` → `` `Edit(${getConfigHomeDisplayPath()}/settings.json)` ``
- [ ] 🟡 **P1** `src/utils/hooks/hooksSettings.ts:174`：`'User settings (~/.claude/settings.json)'` → 插值
- [ ] ⚪ **P2** `src/entrypoints/sdk/coreSchemas.ts:1167+1195`：SDK schema 描述插值
- [ ] ⚪ **P2** `src/commands/onboard-github/onboard-github.tsx:163`：错误信息插值
- [ ] （低优）`src/utils/permissions/filesystem.ts:398/406`：JSDoc 注释 `/tmp/claude-{uid}/` → 更新为 ywcoder
- [ ] **commit** 上窗口 7 文件路径插值改动（`updateConfig.ts` / `keybindings.ts` / 5 个 UI 组件）

---

**全绿 + B/C/E 交互验过 + G 节代码修完 → 交回，由人走 Phase D（CI 打包 → 内网测试 → 合并 main）。**
异常项把现象记下来，回主线决定修/关。
