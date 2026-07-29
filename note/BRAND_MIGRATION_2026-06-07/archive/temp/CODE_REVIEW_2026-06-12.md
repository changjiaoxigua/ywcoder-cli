# Code Review 报告 — feature/brand-replacement
日期：2026-06-12（含 Opus 复核更正）
范围：`git diff main...HEAD`（D7 路径迁移层 + 品牌替换修复）
方法：7 角度 finder × 并行 Agent → 1-vote 验证器（召回偏向）→ **人工逐条复核（读代码 + git 比对）**

---

## ⚠️ 复核更正摘要（2026-06-12 Opus）

初版 9 条由子代理验证器判定（7 CONFIRMED + 2 PLAUSIBLE）。人工逐条复核（亲自读源码 + 与 main 分支 git 比对）后，**纠正 3 处错误归因**：

| 编号 | 初版判定 | 复核结论 | 关键依据 |
|------|---------|----------|---------|
| **F1** bridge 缓存污染 | 🔴 CONFIRMED | **既有问题，非本次回归** | `perSourceCache` 以 source 名为 key、`bridgeMain` 调 `setOriginalCwd` 不清缓存——**main 分支完全一致**，本次 diff 未触及这两行 |
| **F3** worktree 缓存 | 🔴 CONFIRMED | **既有问题，非本次回归** | main 分支 `EnterWorktreeTool.ts` 中 `resetSettingsCache` 出现 **0 次**，本次 diff 未触及该文件 |
| **F5** worktree 复制路径 | 🟡 CONFIRMED | **误报（REFUTED）** | source/dest 同用 `getProjectConfigDir(repoRoot)` 决定的目录名，逻辑自洽；copy-keep 迁移保证 source 存在；flag OFF 与旧代码零差异 |

**根因分析**：F1/F3 的「切换 CWD 后 settings 缓存 stale」现象**真实存在**，但与本次 PR **无因果关系**——设置读取命中 `getCachedSettingsForSource(source)`（以 source 名为 key），**根本不会再调到**被本次 PR 改动的 `getRelativeSettingsFilePathForSource`。无论该函数返回静态串还是动态值，缓存命中逻辑完全一致。这是 main 分支既有的 bridge/worktree 跨目录缓存缺陷，超出品牌替换 PR 的范围。

**教训**：子代理验证器确认了「现象存在」，但未验证「是否本次 PR 引入」。涉及回归归因时，必须人工 git 比对 main 分支基线。

---

## 发现汇总（按复核后状态）

### ✅ 已修复（6 条，真正属于本次 PR）

---

**[F2] getGlobalClaudeFile 的 legacy 路径忽略 YWCODER_CONFIG_DIR**
- 文件：`src/utils/env.ts`，第 33 行
- 复核：✅ **CONFIRMED，本次引入（中危·auth）**
- 修复：方案 A——legacy 前缀改为 `YWCODER_CONFIG_DIR ?? CLAUDE_CONFIG_DIR ?? homedir()`，与 `getYwCoderConfigHomeDir` 对齐。

**失败场景：** 用户只设 `YWCODER_CONFIG_DIR=/custom`（未设 `CLAUDE_CONFIG_DIR`）：`newConfig=/custom/.config.json`，但旧 `legacyFile=~/.claude.json`。若机器存量 `~/.claude.json`（官方 CC）存在，branch 2 命中，返回错误 auth 文件，用户用旧账号鉴权。

> ⚠️ **auth 敏感**：env.ts:24 注释要求改动后连真实登录/认证流程验证（存量登录态保留 + 新装登录落 `.config.json`）。已加单测覆盖路径选择逻辑，但真机验证不可替代。

---

**[F6] getConfigHomeDisplayPath 缺 path separator 守卫**
- 文件：`src/utils/envUtils.ts`，第 91 行
- 复核：✅ **CONFIRMED，本次引入（极低危）**
- 修复：`dir.startsWith(home)` → `dir.startsWith(home + sep)`（新增 `sep` import）。

**失败场景：** `home='/home/user'`、`dir='/home/user2/.ywcoder'` 时 `startsWith(home)` 为 true，输出乱码 `~/2/.ywcoder`。

---

**[F7] update.ts / AutoUpdater.tsx 显示绝对路径而非 tilde**
- 文件：`src/cli/update.ts`（×2）、`src/components/AutoUpdater.tsx`（×1）
- 复核：✅ **CONFIRMED，本次引入（UX 回退）**
- 修复：`getLocalInstallDir()` → `${getConfigHomeDisplayPath()}/local`，import 改自 envUtils。

**失败场景：** 用户看到 `cd /Users/foo/.ywcoder/local && npm update ...` 而非 `~/.ywcoder/local`，泄露完整 home 路径、与产品其他路径提示风格不一致。

---

**[F8] syncGitignore 的 replaceAll 无词边界守卫**
- 文件：`src/utils/projectConfigMigration.ts`，第 160 行
- 复核：✅ **PLAUSIBLE→CONFIRMED，本次引入（低危）**
- 修复：纯 `replaceAll('.claude','.ywcoder')` → 路径段正则 `/(^|[/*!])\.claude(?=\/|$)/g`。

**失败场景：** 项目 `.gitignore` 含 `.claude.json` 或 `.clauderc` 时，会误造 `.ywcoder.json`、`.ywcoderrc` 等无意义规则。

---

**[F9] syncGitignore 的 /\n*$/ 在 CRLF 文件产生混合行尾**
- 文件：`src/utils/projectConfigMigration.ts`，第 175 行
- 复核：✅ **PLAUSIBLE→CONFIRMED，本次引入（低危）**
- 修复：`/\n*$/` → `/[\r\n]+$/`。

**失败场景：** CRLF 的 `.gitignore`（`\r\n` 结尾）处理后末尾残留 `\r` 形成 `\r\n\n` 混合行尾，Linux 克隆后显示 `^M`。

---

**[F4] ACTIVE_PROJECT_CONFIG_DIR_NAME 与运行时实际目录可不一致**
- 文件：`src/utils/projectConfigDir.ts`，第 38-41 行（30+ callsite 引用）
- 复核：✅ **CONFIRMED，本次引入（低危·仅文案）**
- 处置：**方案 B——保持设计取舍 + 补注释**。不改 30+ callsite。

**失败场景：** flag ON 但迁移失败（只读仓库 / cp 失败，`status=failed`）时 `.ywcoder/` 不存在、`getProjectConfigDir` 回退 `.claude/`，而编译期常量仍为 `.ywcoder`，文案目录名滞后于真实落盘。

**为何不全量改运行时（方案 A 被否）：** 30+ callsite 多为「在 X 目录建技能/写 settings」的指引文案，全改会失去 DCE、到处引入 baseDir 依赖，违反「简洁优先/精准修改」；触发条件（flag ON + 迁移失败）极罕见，且设计者已在 projectConfigDir.ts:34-37 注释知情记录。已补注释明确这条降级路径的限制。

---

### ⚠️ 既有问题（非本次 PR 回归，本 PR 不修）

---

**[F1] bridge 模式跨项目 settings 缓存污染**
- 文件：`src/bridge/bridgeMain.ts`，第 2081、2821 行
- 复核：⚠️ **既有问题**——main 分支行为完全一致，本次 diff 未触及
- 现象：`setOriginalCwd(dir)` 切换项目时未调 `resetSettingsCache()`；`perSourceCache` 以 source 名为 key，导致项目 A 的权限设置可能被项目 B 会话命中。属潜在权限边界问题，但**先于本 PR 存在**。
- 建议：作为独立 backlog 项处理（需谨慎改 bridge 行为），不混入品牌替换 PR。

---

**[F3] EnterWorktreeTool 切换 worktree 后 settings 缓存未清**
- 文件：`src/tools/EnterWorktreeTool/EnterWorktreeTool.ts`，第 96 行
- 复核：⚠️ **既有问题**——main 分支同样不调 `resetSettingsCache`
- 现象：同 F1 根因（缓存以 source 名为 key + 切 CWD 不清缓存）。worktree 的 `.claude/settings.json` 权限规则可能被主仓库缓存覆盖。
- 建议：与 F1 合并为同一 backlog 项（「setOriginalCwd 后统一清 settings 缓存」）。

---

### ❌ 误报（撤销）

---

**[F5] performPostCreationSetup 复制到错误目录**
- 文件：`src/utils/worktree.ts`，第 518 行
- 复核：❌ **REFUTED**
- 撤销理由：source（`repoRoot + 相对路径`）与 dest（`worktreePath + 相对路径`）使用**同一个**由 `getProjectConfigDir(repoRoot)` 决定的目录名，逻辑自洽。copy-keep 迁移保证 `.ywcoder/` 与 source 一致；worktree 为新建目录、dest 用活跃目录名正确。flag OFF 时恒 `.claude`，与旧代码零差异。子代理构造的失败场景忽略了上述前提。

---

## 修复执行记录

| 编号 | 文件 | 状态 |
|------|------|------|
| F2 | env.ts:33 | ✅ 已修（方案 A）|
| F6 | envUtils.ts:91 + import | ✅ 已修 |
| F7 | update.ts ×2 / AutoUpdater.tsx ×1 + import | ✅ 已修 |
| F8 | projectConfigMigration.ts:160 | ✅ 已修 |
| F9 | projectConfigMigration.ts:175 | ✅ 已修 |
| F4 | projectConfigDir.ts:38 注释 | ✅ 已处置（方案 B）|
| F1 | bridgeMain.ts | ⏸️ 既有问题，转 backlog |
| F3 | EnterWorktreeTool.ts | ⏸️ 既有问题，转 backlog |
| F5 | worktree.ts | ❌ 误报，撤销 |

**新增回归测试（4 个，每个均能区分修复前后）：**
- `env.test.ts`：F2 的 YWCODER_CONFIG_DIR 优先 ×2（legacy 不被抢走 / legacy 在新目录仍命中）
- `projectConfigMigration.test.ts`：F8 词边界、F9 CRLF

**验证结果：**
- 受影响单测：**27 pass / 0 fail**（原 23 + 新增 4）
- 类型检查：改动文件**无新增错误**（报错全为既有 `MACRO` build 注入常量 + 未触及文件历史问题）
- 构建：**`bun run build` 成功**（ywcoder v1.1.2）

**遗留待办：**
1. ⚠️ F2 auth 修改需**真机登录流程验证**（存量登录态保留 + 新装落 `.config.json`）。
2. F1/F3 既有缓存问题建议合并为独立 backlog 项处理。

---

*审查方法：Phase 0 提取 diff → Phase 1 七角度 finder（A 逐行/B 删除行为/C 跨文件/D 复用/E 简化/F 效率/G 深度）→ Phase 2 单票验证器 → **Phase 3 人工逐条复核（读源码 + git 比对 main 基线，纠正回归归因）**。*
