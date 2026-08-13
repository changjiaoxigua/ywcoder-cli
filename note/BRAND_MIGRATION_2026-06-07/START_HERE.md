# START HERE · 品牌去标识 · 跨窗口交接入口

**项目**：把 ywcoder-cli 里用户可感知的 `Claude / Anthropic / OpenClaude / Claude Code` 全部去标识为 YwCoder。
**分支**：`feature/brand-replacement`（按约定：feature 分支先行 → CI 打包 → 内网测试 → 合并 main）。
**最后更新**：2026-06-12。**本文件是唯一入口**，其余文档按需点进。

---

## 一、当前状态（一句话，更新于 2026-06-12）
**D7 全部完成并默认开启**；活跃可感知面品牌干净；code-review 6 项修复已并入；版本号升至 **v1.2.0**；发布物料齐备。**剩：真机验证 + 内网发布（你的 ops 活）。**

- ✅ **D7 项目级 `.claude/`→`.ywcoder/` 完整落地**：copy-keep 迁移（保留 `.claude/` 备份）、路径中心化（projectConfigDir/projectConfigMigration）、启动接入 cli.tsx、settings/权限/HOME 级/全局 auth 全适配。dist 残留路径插值（共 ~19 处）已全部修复并提交。
- ✅ **flag 默认翻转为 ON**（[build.ts](../../scripts/build.ts)）：默认 `bun run build`（含 `npm pack` 的 prepack）即含迁移；`MIGRATE_PROJECT_CONFIG=false` 保留与官方 CC 纯共存退路。**注意是构建期 env，运行时零表面。**
- ✅ **code-review 6 项修复**（F2/F4/F6/F7/F8/F9，见 [temp/CODE_REVIEW_2026-06-12.md](archive/temp/CODE_REVIEW_2026-06-12.md)）+ 4 个新增回归测试；人工复核纠正了 3 处子代理误判（F1/F3 既有非回归、F5 误报）。
- ✅ **版本号 1.1.2 → 1.2.0**；发布物料见 `release/`（RELEASE_NOTES / USER_UPGRADE_NOTICE / FEATURE_VERIFICATION_GUIDE）。
- **B/C 禁用核实**（仍有效）：`mcp xaa` env 门控；bridge/ssh/daemon/teleport 编译期 flag=false DCE，不可达。

> 下方「已完成（2026-06-10 这轮）」「dist 残留待修」「下一步」等为 **2026-06-10 的历史记录**，所列待办均已在 2026-06-12 完成（详见 [REMAINING_WORK.md](REMAINING_WORK.md) 2026-06-12 更新）。
**已完成（2026-06-10 这轮）**：
- ✅ **Stage 1c**：`projectConfigDir.ts` 加 `feature('MIGRATE_PROJECT_CONFIG')` 门控（拆纯 resolver + 三元注入 flag，OFF 恒 `.claude` 且死分支 DCE）；`scripts/build.ts` featureFlags 加该 flag（默认 false）；单测覆盖 on/off。
- ✅ **Stage 1b-2**（[STAGE_1B2_PUNCHLIST.md](archive/STAGE_1B2_PUNCHLIST.md)）：补齐非-join `.claude` 硬编码。**P0 安全/核心**（settings 路径/沙箱 deny-write/DANGEROUS_DIRECTORIES/isClaudeSettingsPath/权限 pattern/isMemoryFilePath/cron 文件路径/Doctor/agents 目录）——path-of-record 走 getter、匹配/安全类**认两边**（flag 无关）；P0-11 ide.ts 经核实为 HOME 级归 Stage 3。**P1 prompt/显示串**按新增编译期常量 `ACTIVE_PROJECT_CONFIG_DIR_NAME` 插值（init/cron/team/agentMemory/向导/hooks/TrustDialog/SDK schema 等）。
- ✅ **Stage 2 模块 + 接启动 + 端到端验证**：`src/utils/projectConfigMigration.ts` + 单测，**copy-keep** 策略（复制 `.claude/`→`.ywcoder/`、跳 worktrees、同步 `.gitignore` 追加规则、幂等、优雅降级、安静 debug）。**已接进 [cli.tsx](../../src/entrypoints/cli.tsx)**：config 初始化块顶部、首次读项目 settings 前，`if(feature('MIGRATE_PROJECT_CONFIG')){ await migrateProjectConfig(getOriginalCwd()); if(migrated) resetSettingsCache() }`（OFF 整段 DCE）。**auto（每次启动幂等）**。**真实 ON 构建端到端验证通过**：含 `.claude/` 的项目启动后正确生成 `.ywcoder/`（settings/skills 递归复制）、跳 worktrees、保留 `.claude/`、同步 .gitignore。
- ✅ **MIGRATE 构建期 env 门控**（commit `f7796ab`）：`MIGRATE_PROJECT_CONFIG=true|1` 构建 env 开（默认 OFF）。**注意是构建时 env、运行时零表面**。
- ✅ **独立评审已消化**（temp/REVIEW_REPORT_D7_Stage1c-2_2026-06-10.md）：R1（updateConfig 技能 prompt 漏插值）+S1+S2 已修（`c4197fb`）；R2（fastMode 3 fail）= 评审方 shell 环境依赖、非回归，clean env 594→595 绿。
- ✅ **🔴 顺带修了仓库级 build-infra bug**（`7e27f51`）：`feature()`/`bun:bundle` 是 Bun 1.3.11 **原生 macro**，旧 `bun:bundle` shim **从未生效**→所有 flag 静默烤成 false（含 `docs/build-feature-flags-plan.md` 设 true 的 9 个、及它要修的 explore agent bug）。改用 `Bun.build({ features })` 后真正生效。8 个安全增量功能现已启用（待运行时冒烟）；`AUTO_THEME` 暂关（源 `systemThemeWatcher.js` 缺失）。详见该 doc 附录 B 勘误 + 记忆 [[build-feature-flags-mechanism]]。
- ✅ **Stage 3a**（commit `3017ac6`，**auth 敏感**）：`getGlobalClaudeFile`（env.ts，全局 auth 文件路径）改三分支——新目录 `.config.json` 存在→用它；存量 `~/.claude.json` 存在→续用（保 auth、读回退）；纯新装→落 `.ywcoder/.config.json`（去标识）。**仅影响纯新装**、存量登录不丢。+三分支单测。**⚠️ 待用户连真实登录流程验证。**
- ✅ **Stage 3b**（commit `6e9363c`）：HOME 级 `~/.claude` prompt/显示串按活跃 HOME 目录（新增 `envUtils.getConfigHomeDisplayPath()`）。改 TeamCreate/Delete prompt、statuslineSetup（const→函数，修了 agent 写错目录的实 bug）、ConfigTool 全局文件显示、main.tsx plugin 帮助。注释级 P2 + insights/ide.ts WSL（niche）暂留。
- ✅ **验证窗口补修（2026-06-10，⚠️ 未 commit）**：A/D/E 自动化全绿（**599 pass**）；dist scan 发现 skill prompt/UI 共 **14 处** `~/.claude` 硬编码遗漏，均改用模块级 `_configHome = getConfigHomeDisplayPath()` 插值——`updateConfig.ts`（3 处）、`keybindings.ts`（5 处）、`AddPermissionRules.tsx`、`MemoryStep.tsx`（2）、`LocationStep.tsx`、`SelectEventMode.tsx`、`SkillsMenu.tsx`（各 1）。**7 个文件改动未 commit**（下窗口第一件事：`git add -u` 指定这 7 文件后提交，勿带 `*.tgz`）。
- **⚠️ dist 残留 5 处待修**（下窗口代码修复，Phase D 前必清）：
  - 🔴 **P0** [`src/commands/statusline.tsx:12`](../../src/commands/statusline.tsx#L12)：`allowedTools` 里 `Edit(~/.claude/settings.json)` → 改为 `` `Edit(${getConfigHomeDisplayPath()}/settings.json)` ``（`~/.ywcoder` 用户 statusline-setup 写 settings 会弹确认框）
  - 🟡 **P1** [`src/utils/hooks/hooksSettings.ts:174`](../../src/utils/hooks/hooksSettings.ts#L174)：`'User settings (~/.claude/settings.json)'` → 插值
  - ⚪ **P2** [`src/entrypoints/sdk/coreSchemas.ts:1167`](../../src/entrypoints/sdk/coreSchemas.ts#L1167) + `:1195`：SDK schema 描述里的路径
  - ⚪ **P2** [`src/commands/onboard-github/onboard-github.tsx:163`](../../src/commands/onboard-github/onboard-github.tsx#L163)：错误信息
- 同时 `filesystem.ts:398/406` JSDoc 注释仍写 `/tmp/claude-{uid}/`（不进 bundle，低优可顺手改）。

**👉 下一步（2026-06-12 起，真机验证 + 发布，你的 ops 活）**：
1. **F2 auth 真机验证**（⚠️ auth 敏感）：存量登录态保留 + 纯新装落 `~/.ywcoder/.config.json`（步骤见 [release/RELEASE_NOTES_2026-06-12.md](release/RELEASE_NOTES_2026-06-12.md) §4.2）
2. **6 个 🔄 feature 内网验证**（见 [release/FEATURE_VERIFICATION_GUIDE_2026-06-12.md](release/FEATURE_VERIFICATION_GUIDE_2026-06-12.md)）→ 通过后更新该指引与发布说明 §2.5
3. **内网发布**：`bun run build`（默认即 ON）→ `npm pack`（prepack 自然产出 ON 包）→ 内网测试 → 合并 main
- ⚠️ **新发现待办**（`note/ISSUE/`，本 PR 不修、单独排期）：[settings 缓存切 CWD 未失效](ISSUE/2026-06-12-settings-cache-stale-on-cwd-switch.md)（既有）、~~[`CLAUDE_CODE_USE_OPENAI` fallback 不完整](ISSUE/2026-06-12-use-openai-flag-fallback-incomplete.md)~~（✅ **2026-06-17 已闭合**，随 GitHub 环境变量去标识一并修复）、[`--migrate-config` 对已迁移用户不幂等](ISSUE/2026-06-12-migrate-config-not-idempotent-on-copy-keep.md)、[全局去掉 getYwCoderEnv 旧名回退（只读新名）](ISSUE/2026-08-13-drop-claude-code-env-fallback.md)（**2026-08-13 已决策**：不保留旧名兼容；勿混入 ywmatrix-shim 分支）
- ✅ **GitHub/OpenAI/Gemini 环境变量去标识 + USE_OPENAI fallback 闭合（2026-06-17）**：provider 选择标志 `YWCODER_USE_*` 转正、`CLAUDE_CODE_USE_*` 降为静默回退；读取/写入/清除/team 透传全链路双名对称；用户可见文案（onboard/validation/显示标签）已无 claude。详见 [review_2026-06-14 第 5 项](review_2026-06-14_第一轮审查.md)。内网脚本可只用新名。
- 备查：HOME 配置目录迁移（`getYwCoderConfigHomeDir` 优先 `~/.ywcoder`、`ywcoder --migrate-config` 手动触发，copy-keep）。

**已完成提交（feature/brand-replacement，最近批次）**：
```
8f84e53 D7 Stage 2：项目级配置迁移模块 + 单测（copy-keep，尚未接入启动）
eef50f5 D7 Stage 1b-2 P1：prompt/显示串去标识（按活跃配置目录名插值，flag 门控）
1dfe89e D7 Stage 1b-2 P0：非-join .claude 硬编码补漏（安全/核心，认两边）
3a8c75d D7 Phase 1 Stage 1c：projectConfigDir 加 MIGRATE_PROJECT_CONFIG 编译期门控
de56312 D7 Phase 1 Stage 1b：35 站点切 active-dir/variants（开始改行为）
41266c7 D7 Phase 1 Stage 1a：读/写/匹配 helper + 单测
40ba06b D7 Phase 0：项目级 .claude 路径收敛到 getProjectConfigDir（零行为变更）
eb80f9a Step A 活跃命令名/prose 去标识 / 529190b 禁用在线更新
（更早：575e928 B2 收尾 / a399b5a B2 首遍 / 7e74ebf Tier3 / f97bf51 临时目录 / 081a343 D1-3·D6 等）
```
**基线绿**：`bun run build` / `bun test --max-concurrency=1`（**599 pass**，clean env）全绿。
**工作区**：7 个已跟踪文件有未 commit 改动（路径插值补修，见上方「验证窗口补修」条目）；`*.tgz`、`scripts/process_brand_worklist.ts` 两个未跟踪文件勿提交。

## 二、剩余工作（下一阶段）
按 [NEXT_STEPS.md](archive/NEXT_STEPS.md) 的 Phase B → C → D，执行细则见 [EXECUTION_TASKLIST.md](archive/EXECUTION_TASKLIST.md)。

| Phase/项 | 内容 | 状态（2026-06-09） |
|---|---|---|
| **B1** | `Claude Code`/`OpenClaude`/`CLAUDE.md→YWCODER` 文本 | ✅ 完成。dist 残留 `Claude Code`=32 全在**禁用功能/外部产品**延后桶 |
| **B2** | 裸大写 `Claude` 自指字符串 | ✅ 首遍+裁决（a399b5a/575e928）+ **Step A 收尾尾巴**（eb80f9a：hooks/agents/sandbox prose） |
| **B3** | 小写 `claude` 活跃命令名 | ✅ Step A 完成（eb80f9a）：`claude mcp/doctor/agents/auto-mode/plugin/--debug` → `ywcoder`。禁用功能内（chrome/teleport/install/bridge）残留按 Tier2 保留 |
| **B/C 禁用核实** | `mcp xaa`、bridge/ssh/daemon/teleport | ✅ 经核实本就禁用态（xaa env 门控、其余编译期 flag=false DCE），无需改动；已记 [DISABLED_FEATURES.md](DISABLED_FEATURES.md) |
| **C** | 扫 dist 验收 + 文件系统产物运行时核查 | ✅ 完成。dist 仅剩延后桶；FS：`~/.ywcoder` 命名正确，`~/.claude.json` 并入 D7 |
| **Tier2 残留** | dist 里已禁用功能/外部产品品牌串 | ⚪ 有意低优先保留（`Claude Code`×32 + bridge/chrome/install/teleport/xaa 残留），可将来连 D7 清 |
| **D7** | 项目级 `.claude/`→`.ywcoder/`（Option B 整搬）+ `~/.claude.json` | ✅ **完成·默认开启（2026-06-12）**：Phase 0/1a/1b/1c/1b-2/Stage 2/3a/3b + 路径插值 + code-review 6 项修复全部落地并提交；flag 默认翻 ON、版本 v1.2.0。**剩真机验证（F2 登录 + 6 feature）+ 发布**。详见 [REMAINING_WORK.md](REMAINING_WORK.md) 2026-06-12 更新 |
| **D** | CI 打包 → 内网测试 → 合并 main | ⏳ 你的 ops 活 |

## 三、核心原则（务必遵守）
1. **暴露面 = 字符串字面量**（进 dist + 发往 LLM 网关 + 可能进日志），**注释不进 bundle**（可缓）。验收以**扫 dist** 为准，不是扫源码。
2. **护栏（不改）**：`claude-*` 模型名、`ANTHROPIC_*` 环境变量、`anthropics/`、`claude.ai`、`code.claude.com`、`Claude-User` UA、`.claude/` 目录(D7暂缓)、`claudemd.ts`/`config.ts` 内的 `CLAUDE.md` 回退名、含 Anthropic 的功能性符号名（`AnthropicBedrock`/`isAnthropic*` 等）、provider 描述 "Anthropic native API"。
3. **判据**：句中能否把 Claude/Anthropic 换成"YwCoder/本工具"而语义正确？能→改；指 Anthropic 公司/模型/外部产品/provider 协议→留；不确定→记 [HUMAN_REVIEW_NEEDED.md](archive/HUMAN_REVIEW_NEEDED.md)，不猜。
4. **文件系统产物**（临时目录/文件名/缓存名）grep 易漏，需**运行时观察**（已修临时目录，见 TASKLIST §文件系统产物）。
5. 每步 `bun run build && bun test --max-concurrency=1` 保持绿；改动按你的偏好用**中文 commit、不加 Co-Authored-By**；只暂存已跟踪改动（`git add -u`），勿带 `*.tgz`/脚本。

## 四、文档地图（2026-06-12 整理后）
> **顶层只留 5 个核心 + `release/`**；过程文档已归 `archive/`，早期已过期文档归 `archive/legacy/`（文件名带 `_可删` 标注）。

**🟢 顶层·核心（读这些就懂全貌）**
- **本文件 START_HERE.md** — 当前状态 + 核心原则 + 入口
- [DECISIONS.md](DECISIONS.md) — D1–D7 决策与演进（**为什么这么做**）
- [REMAINING_WORK.md](REMAINING_WORK.md) — 全量扫描 + 文件级完成记录（**做了什么**）
- [DISABLED_FEATURES.md](DISABLED_FEATURES.md) — D5 禁用清单 + 重启用方式
- [D7_VERIFICATION_CHECKLIST.md](D7_VERIFICATION_CHECKLIST.md) — 真机验证逐项打勾（A 回归 / B 8 功能 / C 登录 / D 迁移 / E 综合 / F 延后；验完可归档）
- `release/` — 发布物料（RELEASE_NOTES / USER_UPGRADE_NOTICE / FEATURE_VERIFICATION_GUIDE）
- `../ISSUE/` — 遗留待办 3 份（单独排期）

**🗄️ `archive/`·过程文档（完成使命，回溯用，平时不看）**
- 导航见 [archive/README.md](archive/README.md)：STAGE_1B2_PUNCHLIST / HUMAN_REVIEW_NEEDED / EXECUTION_TASKLIST / AGENT_PROMPT_B1_TIER3 / B2_CLASSIFICATION / NEXT_STEPS / HANDOFF_SMALL_AGENT / agent_worklist.txt + `archive/temp/`（评审报告）
- `archive/legacy/` — 早期已过期文档（README / BRAND1-3，带 `_可删` 标注，确认无需回溯即可删）

## 五、下一窗口开场白（复制粘贴）

> **现状（2026-06-12）**：D7 全部完成并默认开启，code-review 6 项修复已并入，版本号 v1.2.0，发布物料齐备，代码均已提交。**剩：真机验证（F2 登录 + 6 个 feature 内网验证）+ 内网发布（构建/打包/测试/合并 main）。** 下方场景 A/B/C 为 2026-06-10 代码阶段的历史开场白；当前阶段主要走真机验证与发布，新 agent 窗口接力需求已降低。

**A. 若是来修代码 + commit（下窗口首选）**：
```
继续 ywcoder 品牌去标识收尾。先读 note/BRAND_MIGRATION_2026-06-07/START_HERE.md §一。

当前有 7 个文件路径插值改动未 commit（updateConfig.ts / keybindings.ts / AddPermissionRules.tsx /
MemoryStep.tsx / LocationStep.tsx / SelectEventMode.tsx / SkillsMenu.tsx）。

第一步：git add 这 7 个文件，commit（中文说明，不加 Co-Authored-By，勿带 *.tgz）。

第二步：修 dist 残留 5 处（详见 §一「dist 残留 5 处待修」）：
  🔴 P0 src/commands/statusline.tsx:12  allowedTools Edit 路径
  🟡 P1 src/utils/hooks/hooksSettings.ts:174  User settings 标签
  ⚪ P2 src/entrypoints/sdk/coreSchemas.ts:1167+1195  SDK schema 描述
  ⚪ P2 src/commands/onboard-github/onboard-github.tsx:163  错误信息
  全部用 getConfigHomeDisplayPath() 插值，模式同已修的 7 个文件。

每步改完：bun run build && env -u CLAUDE_CODE_USE_OPENAI bun test --max-concurrency=1 保 599 pass。
护栏见 §三；git add 指定文件（勿带 *.tgz 和 scripts/process_brand_worklist.ts）。
```

**B. 若是来做交互验证（代码已全修后）**：
```
继续 ywcoder 品牌去标识交互验证。先读 note/BRAND_MIGRATION_2026-06-07/START_HERE.md §一。
按 note/BRAND_MIGRATION_2026-06-07/D7_VERIFICATION_CHECKLIST.md 逐项打勾：
B 节 7 UX feature（bun run dev 手操，macOS 跳 POWERSHELL_AUTO_MODE）→
C 节 auth 纯新装（找无 ~/.claude.json 也无 ~/.ywcoder/.config.json 的环境登录一次，确认 token 落 ~/.ywcoder/.config.json）→
E 节 worktree 创建/进入 + 插件 enable/disable。
A/D/E 自动化已全绿（599 pass）。全部验过 → 交回走 Phase D。
```

**C. 若是来做 niche 延后项（F 节，不阻塞交付）**：
```
继续 ywcoder 品牌去标识 D7 niche 收尾。先读 note/BRAND_MIGRATION_2026-06-07/START_HERE.md §一。
剩余延后项（见 D7_VERIFICATION_CHECKLIST.md F 节）：
AUTO_THEME 源缺失（补 systemThemeWatcher.js 或长期关）、
ide.ts WSL .claude/ide 路径-of-record（WSL+IDE 才命中）、
P2 注释级 .claude（不进 bundle）、HOME 迁移自动触发/安装脚本。
按需挑做。每步 bun run build && env -u CLAUDE_CODE_USE_OPENAI bun test --max-concurrency=1 保 599 pass。
护栏见 §三；中文 commit，不加 Co-Authored-By，git add 指定文件。
```
