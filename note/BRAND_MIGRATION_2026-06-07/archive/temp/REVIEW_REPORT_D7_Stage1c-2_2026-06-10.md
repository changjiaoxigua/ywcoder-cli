# feature/brand-replacement D7 Stage 1c / 1b-2 / Stage 2 独立评审报告

**复核日期**: 2026-06-10
**复核范围**: `3a8c75d` + `1dfe89e` + `eef50f5` + `8f84e53`（相对 `de56312`）
**基线**: `bun run build` 成功；`bun test --max-concurrency=1` 591 pass / 3 fail

---

## 一、总体评价

**架构设计正确**：编译期 flag `MIGRATE_PROJECT_CONFIG` 门控 + DCE 验证通过（flag 字符串在 dist 中消失、ACTIVE_PROJECT_CONFIG_DIR_NAME OFF 时解析为 `.claude`）。Stage 1c 的「纯解析器 + 公开 getter 三元注入」模式满足 `bun:bundle` 约束，单测覆盖策略合理（`resolve*` 测 ON/OFF、公开 getter 测 OFF）。

**P0 安全/核心补漏到位**：settings 路径走 getter、沙箱 denyWrite 认两边、DANGEROUS_DIRECTORIES / isClaudeSettingsPath / 权限 pattern 生成与匹配、isMemoryFilePath、cron 文件路径一致性均正确。

**主要欠账**：P1 prompt/显示串有**一处显著遗漏**（`updateConfig.ts` 的 `SETTINGS_EXAMPLES_DOCS` 常量内大量项目级 `.claude` 硬编码未插值），会进 dist 并发给 LLM，ON 构建下误导 agent。

---

## 二、🔴 阻断（必须修）

### R1. `updateConfig.ts` SETTINGS_EXAMPLES_DOCS 中项目级 `.claude` 硬编码未改

- **文件**: `src/skills/bundled/updateConfig.ts:22-24,34,303,372,392,438`
- **证据**: `SETTINGS_EXAMPLES_DOCS` 常量内多处硬编码 `.claude/settings.json`、`.claude/settings.local.json`、`Edit(.claude)`；`HOOK_VERIFICATION_FLOW` 内 `.claude/`；Example Workflows 内 `.claude/settings.json`。
- **理由**: 这些文本**直接进 dist 并发给 LLM**（技能 prompt）。ON 构建下，agent 会被指引去 `.claude/settings.json` 读写，而实际活跃目录是 `.ywcoder/`，导致**行为不一致 + 配置"丢失"观感**。P1 commit 只改了第 288 行一处 `.claude/settings.local.json`，遗漏了整个 SETTINGS_EXAMPLES_DOCS 块。
- **修法**: 用 `ACTIVE_PROJECT_CONFIG_DIR_NAME` 插值替换项目级 `.claude/` 引用；`~/.claude/settings.json`（全局）本轮不动（归 Stage 3）。`Edit(.claude)` 应改为 `Edit(${ACTIVE_PROJECT_CONFIG_DIR_NAME})` 或更精确的权限规则语法。

### R2. 测试基线 3 个 fastMode 失败

- **文件**: `src/utils/fastMode.test.ts:138-172`
- **证据**: 期望 `"Fast mode has been disabled by your organization"`，收到 `"Fast mode is not available on third-party providers"`。
- **根因**: 当前 shell 预存 `CLAUDE_CODE_USE_OPENAI=1` → `getAPIProvider() !== 'firstParty'`。该测试未 mock `getAPIProvider()`，**不是本轮改动引入**（main 分支同环境也会失败）。
- **建议**: 在测试中补 mock `src/utils/model/providers.js` 的 `getAPIProvider()` 返回 `'firstParty'`，消除环境依赖。或确认 CI clean env 是否通过。

---

## 三、🟡 建议（重要但可后续补）

### S1. `cronScheduler.ts` JSDoc 中 `.claude/scheduled_tasks.json` 未改

- **文件**: `src/utils/cronScheduler.ts:90`
- **证据**: `Directory containing .claude/scheduled_tasks.json.`
- **理由**: JSDoc 会出现在 IDE 类型提示和生成的 d.ts 中，维护者会困惑。应改为"活跃配置目录下的 `scheduled_tasks.json`"或插值。

### S2. `updateConfig.ts` 中 `claude --debug` 命令名未改

- **文件**: `src/skills/bundled/updateConfig.ts:443`
- **证据**: `Run \`claude --debug\` to see hook execution logs`
- **理由**: Step A 已把 CLI 子命令 `claude` → `ywcoder`，prompt 里仍写 `claude --debug` 会让用户敲错命令。应改为 `ywcoder --debug`。

### S3. `updateConfig.ts` 中 `~/.claude/bash-log.txt`（HOME 级提示）

- **文件**: `src/skills/bundled/updateConfig.ts:239`
- **证据**: `command: "jq -r '.tool_input.command' >> ~/.claude/bash-log.txt"`
- **理由**: HOME 级 `~/.claude` 归 Stage 3。本轮不动正确，但 Stage 3 时需改为 `~/.ywcoder/bash-log.txt`。先记一笔。

### S4. 注释级 `.claude` 残留（P2，不进 bundle，维护者易混淆）

- **文件**: `src/utils/settings/settings.ts:236`、`src/utils/settings/types.ts:215`、`src/services/plugins/pluginOperations.ts:120`、`src/utils/cronTasks.ts` JSDoc 等
- **理由**: 纯注释，低优先，可在 Stage 4 清理前顺手改。

---

## 四、Stage 2 迁移模块审查

### 4.1 处置策略（copy-keep）

| 检查项 | 结论 | 说明 |
|---|---|---|
| copy-keep 安全性 | 正确 | 复制不删除，`.claude/` 原样留作天然备份 + 读回退，可逆 |
| worktrees 跳过 | 正确 | `rel !== WORKTREES_SKYLIGHT && !rel.startsWith(WORKTREES_SKYLIGHT + sep)` 覆盖目录本身及子树 |
| .gitignore 同步 | 基本正确 | 追加并行规则、不删旧、跳 `.claude-plugin` 与 `worktrees`、幂等去重 |
| .gitignore 边界 | ⚠️ 有漏洞 | `trimmed.includes('.claude')` 会匹配 `.claude*` glob 规则，replaceAll 后成 `.ywcoder*`，语义改变（原本匹配 `.claude` 和 `.claude-plugin` 等，改后只匹配 `.ywcoder` 开头）。虽然罕见，但应加词边界或前缀检查 |
| 幂等 | 正确 | `.ywcoder/` 存在即跳过 |
| 优雅降级 | 正确 | cp 失败 → `failed` 不抛；gitignore 失败 catch 不抛 |
| 安静执行 | 正确 | 全程 `logForDebugging`，无 console 噪音 |

### 4.2 启动接入风险意见

**当前状态**: 模块 + 单测已落，**尚未接进启动流程**。

**接入点建议**:
- 应在 **settings 加载前**、**getOriginalCwd() 确定后**调用 `migrateProjectConfig(getOriginalCwd())`。
- 调用后应 **reset settings cache**（因 settings 缓存可能在迁移前已读 `.claude/settings.json`，迁移后需重新读 `.ywcoder/settings.json`）。
- 接入时应补集成测试：模拟 `.claude/` 存在 → 启动 → 验证 `.ywcoder/` 生成且 settings 读到新目录。

**处置策略倾向**:
- **copy-keep（当前选择）是安全的**。理由：①可逆，不破坏用户数据；②与官方 CC 的 interop 未完全切断（`.claude/` 仍在）；③失败回退简单。
- **反对改为 move+备份**：move 在跨文件系统/硬链接场景下更脆弱，且需要处理部分失败的原子性问题。copy-keep 的"浪费"只是多占一份磁盘空间，对配置目录（通常 < 1MB）可忽略。

---

## 五、核心约束核查详情

### 5.1 settings.ts getRelativeSettingsFilePathForSource（最高危）

- **改动**: `const dirName = basename(getProjectConfigDir(getOriginalCwd()))`
- **OFF 时**: `getProjectConfigDir` → `resolveProjectConfigDir(baseDir, false)` → `join(baseDir, '.claude')` → `basename` → `.claude`。返回 `.claude/settings.json`，**严格等同原版**。
- **ON 时**: `getProjectConfigDir` 按存在性择优 → `.ywcoder` 或 `.claude`（未迁移时）。返回对应路径，与其余子系统一致。
- **性能**: `getProjectConfigDir` 在 ON 时做 1-2 次 `existsSync`，但该函数只在 settings **初始化/缓存未命中**时调用（非每回合热路径），可接受。若担忧可改用 `ACTIVE_PROJECT_CONFIG_DIR_NAME`（但 ON 时未迁移项目会错返回 `.ywcoder/settings.json`，而实际目录仍是 `.claude`；故 `basename(getProjectConfigDir(...))` 是**必要的运行时择优**）。
- **结论**: 改对了，无副作用。

### 5.2 安全「认两边」无遗漏

| 检查项 | 文件 | 状态 |
|---|---|---|
| sandbox-adapter denyWrite settings/skills | `sandbox-adapter.ts:245-263` | 认两边 ✓ |
| DANGEROUS_DIRECTORIES | `filesystem.ts:78-86` | 含 `.ywcoder` ✓ |
| isClaudeSettingsPath | `filesystem.ts:219-245` | endsWith 认两边 ✓ |
| worktrees 天窗豁免 | `filesystem.ts:480-493` | `dir === '.claude' \|\| dir === '.ywcoder'` ✓ |
| 权限 pattern 生成 | `usePermissionHandler.ts:110-113` | `getProjectConfigFolderPermissionPattern` 按活跃目录生成 ✓ |
| 权限 pattern 匹配 | `filesystem.ts:1309-1313` | `validPrefixes` 含 `/.ywcoder/` 认两边 ✓ |
| isMemoryFilePath | `claudemd.ts:1493-1498` | includes 认 `.ywcoder/rules/` 和 `.claude/rules/` ✓ |
| cron 文件路径 | `cronTasks.ts:85-87`、 `cronTasksLock.ts:50-53` | 走 `getProjectConfigDir` 与 mkdir 一致 ✓ |
| Doctor agents 目录 | `Doctor.tsx:172` | 走 `getProjectConfigDir` ✓ |

### 5.3 DCE 验证

| 检查项 | dist 结果 | 结论 |
|---|---|---|
| `MIGRATE_PROJECT_CONFIG` 字符串 | 0 次 | 完全消除 ✓ |
| `ACTIVE_PROJECT_CONFIG_DIR_NAME` 值 | `= LEGACY_PROJECT_CONFIG_DIR` = `.claude` | OFF 时正确解析 ✓ |
| `resolveProjectConfigDir(baseDir, ?)` | 仅见 `resolveProjectConfigDir(baseDir, false)` | ON 分支 DCE ✓ |
| prompt 中活跃目录名 | 渲染为 `.claude`（如 `.claude/rules/`、`.claude/settings.json`） | OFF 时用户无感 ✓ |
| 游离 `.ywcoder` 引用 | 仅 HOME 级（`~/.ywcoder`、`.ywcoder-profile.json`）和常量定义，无项目级游离 | 干净 ✓ |

### 5.4 HOME 级 ~/.claude 是否被误动

- **本轮改动文件列表**: 无 `statusline`/`keybindings`/`team`/`insights`/`ide.ts` 等 HOME 级文件。
- `TeamCreateTool/prompt.ts`、`TeamDeleteTool/prompt.ts` 中的 `~/.claude/teams|tasks` 本轮未动，正确。
- `init.ts` 中 `~/.claude/<project-name>-instructions.md` 是 HOME 级，保留正确。
- **结论**: HOME 级全部留给 Stage 3，无越界。

### 5.5 护栏

- `claude-*` 模型名、 `ANTHROPIC_*` 环境变量、`anthropics/`、`claude.ai`、`.claude-plugin/`、`getManagedFilePath()/.claude`、`CLAUDE.md` 回退名 —— 本轮未触及，完好。

---

## 六、总结

| 类别 | 数量 | 内容 |
|---|---|---|
| 🔴 阻断 | 2 | R1 `updateConfig.ts` SETTINGS_EXAMPLES_DOCS 遗漏（项目级 `.claude` 硬编码未插值）；R2 fastMode 测试环境依赖（非本轮引入，但基线不达标） |
| 🟡 建议 | 4 | S1 cronScheduler JSDoc；S2 `claude --debug` 命令名；S3 `~/.claude/bash-log.txt` HOME 级备忘；S4 注释残留 |
| ⚪ 可选 | — | — |

**D7 整体进展**: Stage 1c flag 门控 + Stage 1b-2 P0 安全补漏 **正确且到位**；Stage 2 迁移模块 **设计安全**（copy-keep）；**最大欠账是 P1 prompt 遗漏**（updateConfig.ts 的 SETTINGS_EXAMPLES_DOCS）。

**下一步**: ① 修 R1（updateConfig.ts 插值）→ ② 确认 R2（clean env 或补 mock）→ ③ Stage 2 接入启动流程（settings 加载前 + cache reset）→ ④ Stage 3 HOME 级。
