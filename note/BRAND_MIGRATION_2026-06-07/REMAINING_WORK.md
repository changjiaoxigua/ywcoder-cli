> 📋 本文件 = **详细完成记录**（全量分类扫描 + 各批次文件级清单 + 逐项完成戳）。
> 快速状态看 [START_HERE.md](START_HERE.md)；决策的最终结论以 [DECISIONS.md](DECISIONS.md) 为准
> （下方"二~五节"是 2026-06-07 的**原始计划**，部分已被后续决策调整，相应处已加 ✅/⚠️ 标注）。

# YwCoder 品牌改造 · 剩余工作详细清单

**生成日期**: 2026-06-07
**目标**: 用户使用时完全感知不到 `claude / anthropic / openclaude / Open Claude / Claude Code` 等关键字
**范围口径（已与用户确认）**:
- 彻底版：连**代码注释、调试日志、proto 包名**也一并清理
- 保留项（`ANTHROPIC_*` / `claude-*` / `CLAUDE.md`）**尽量替换**，采用「新增 YwCoder 别名 + 回退原值」策略，**不破坏功能**
- guide agent 按功能区分：YwCoder 具备的能力 → 改写文案；Anthropic 专有功能 → 禁用或评估接入 YwCoder 服务

> README.md 声称「全面替换完成」，实测**核心身份（系统提示词、配置目录、包名、欢迎屏）确已完成**，但 UI/帮助文本/Agent 提示/命令描述存在**大量遗漏**，README 高估了完成度。本清单为遗漏部分。

---

## ✅ 完成进度（截至 2026-06-08）

> 决策记录见 [DECISIONS.md](DECISIONS.md)；禁用清单见 [DISABLED_FEATURES.md](DISABLED_FEATURES.md)；长尾文案交接见 [HANDOFF_SMALL_AGENT.md](archive/HANDOFF_SMALL_AGENT.md)。
> 截至 2026-06-08：已提交 **7 个 commit**（4c633e3→f97bf51，在 feature/brand-replacement）；`build` / `smoke` / `bun test`（**571 pass**）全绿；D4-b 经独立复核 + 专项测试。

| 模块 | 状态 | 说明 |
|------|------|------|
| 批次1 高频可见文案（38 文件） | ✅ 完成 | main.tsx 帮助文本、6 个内置 Agent 提示、commands/tools/UI 文案、权限提示、系统提示零散引用、OpenClaude 残留 |
| 批次1 长尾文案（B1 本工具串 + Tier3 注释） | 🔄 委托执行 agent 进行中 | spec=[AGENT_PROMPT_B1_TIER3.md](archive/AGENT_PROMPT_B1_TIER3.md)；裸 Claude 字符串(B2) 留人工 |
| **D4-a** 模型显示名 | ✅ 完成 | 不造 YwCoder 名；移除 `/model` payg3p 硬编码 Anthropic 兜底（[modelOptions.ts](../../src/utils/model/modelOptions.ts)）；`getAntModels()` 本就空 |
| **D4-b** CLAUDE.md→YWCODER.md | ✅ 功能完成 | 发现/写入/init/onboarding/选择器/FileWrite 已适配，仓库 CLAUDE.md 已改名；实测 YWCODER.md 优先生效；~90 处注释/提示文本并入长尾 |
| **D4-c** ANTHROPIC_* | ✅ 决策完成 | 结论=**保持不动**（按协议命名，同 OPENAI_*）；仅余少量身份化文案待软化 |
| **D5** 云/账号功能禁用 | ✅ 完成 | 见下方明细 |
| 批次2 guide agent | ✅ 完成（15b899e） | 最终做法=**整体禁用并移出打包产物**（非改写）；dist 中 claude-code-guide/Claude Agent SDK 归零。详见 DISABLED_FEATURES |
| **D1/D2/D3/D6** | ✅ 已执行 | D1 指标名→ywcoder.*；D2 官方市场 auto-install 禁用；D3 proto→ywcoder.v1；D6 ISSUES_EXPLAINER 中性化/originator/UA URL→ywcoder（Claude-User UA 保留） |
| **D7** 项目级 `.claude/` 目录 | ✅ 完成·默认开启（2026-06-12） | copy-keep 迁移 `.claude/`→`.ywcoder/`（保留 `.claude/` 备份），编译期 flag `MIGRATE_PROJECT_CONFIG` **默认 ON**（`=false` 可关）。路径中心化 + 启动接入 + settings/权限/HOME 级/auth 适配 + code-review 6 项修复。详见下方「2026-06-12 更新」 |
| **临时目录** `Temp\claude\`→`Temp\ywcoder\` | ✅ 已修（f97bf51） | 用户运行时发现的漏项；中心函数 `getClaudeTempDirName` + 硬编码 `tmpdir()/claude*`。易失无需回退。**提醒：文件系统产物需运行时观察，grep/dist 难全覆盖**（详见 EXECUTION_TASKLIST §文件系统产物） |

**D5 已禁用明细**（全部一行可逆：`isEnabled:()=>false` / `if(false)` 守卫 / `return false`）：
- Slash 命令：`/think-back`、`/feedback`·`/bug`、`/passes`、`/desktop`、`/chrome`、`/insights`
- CLI 子命令：`auth login`、`auth logout`、`install`、`mcp add-from-claude-desktop`（保留 `auth status`）
- UI：桌面端启动升级弹窗
- 模型：`/model` payg3p 硬编码 Anthropic 兜底
- 已核实本就关闭（无需改动）：ultraplan、ultrareview、stickers、remote-setup/upgrade/usage/install-slack-app/voice（availability gate）、TranscriptSharePrompt、Teleport/KAIROS/Bridge/Daemon/SSH-remote（feature flag）

**Review 遗留（低优先）**：
- [auth.ts:1977/2007](../../src/utils/auth.ts)、[bridgeEnabled.ts:73-79](../../src/bridge/bridgeEnabled.ts) 错误文案含 `claude auth login`（触发极窄，归长尾文案）
- `getOpus41Option`/`getHaikuOption` 死代码（注释回滚所需，有意保留）
- `cost` 订阅文案软化（仅订阅者可见，内网休眠）

---

## 🆕 2026-06-12 更新（D7 落地 + 发布准备 → v1.2.0）

> 本轮在 feature/brand-replacement 新增多个 commit；`bun run build`（默认 ON）/ `MIGRATE_PROJECT_CONFIG=false bun run build`（OFF）双构建均验证；受影响单测 **27 pass**（含 4 个新增回归测试）。

### D7 项目级迁移：从「暂缓」转为「完成·默认开启」
- **路径中心化**：新增 [projectConfigDir.ts](../../src/utils/projectConfigDir.ts)（解析/存在性择优/权限变体/活跃目录名常量）+ [projectConfigMigration.ts](../../src/utils/projectConfigMigration.ts)（copy-keep 迁移、跳过 `worktrees/`、同步 `.gitignore` 并行规则、幂等、优雅降级）
- **启动接入**：[cli.tsx](../../src/entrypoints/cli.tsx) Stage 2——settings 加载前跑一次迁移，迁移成功后 `resetSettingsCache()`
- **适配**：settings 相对路径（`getRelativeSettingsFilePathForSource` 走活跃目录）、权限 glob、HOME 级 `~/.claude`→`~/.ywcoder`（含 `ywcoder --migrate-config` 命令）、全局 auth 文件 Stage 3 三分支（`getGlobalClaudeFile`）
- **编译期 flag 默认翻转为 ON**（[build.ts](../../scripts/build.ts)）：默认构建即含迁移、`npm pack` 的 prepack 也自然产出 ON 包；`MIGRATE_PROJECT_CONFIG=false` 保留与官方 Claude Code 纯共存的退路（迁移分支 DCE）
- **feature flag 机制修复**：`feature()` 是 Bun 原生编译期 macro，须经 `Bun.build({ features })` 注入；修复前的 shim 失效曾让所有 flag 静默关闭

### code-review 6 项修复（[temp/CODE_REVIEW_2026-06-12.md](archive/temp/CODE_REVIEW_2026-06-12.md)）
F2 auth legacy 前缀对齐 `YWCODER_CONFIG_DIR` · F4 编译期常量取舍注释 · F6 tilde 路径分隔符守卫 · F7 更新提示路径 tilde 化 · F8 gitignore 词边界 · F9 CRLF 行尾。**人工复核纠正了 3 处子代理误判**（F1/F3 系既有问题非本次回归、F5 误报）。

### 发布准备
- **版本号 1.1.2 → 1.2.0**（semver minor，本次新增多个面向用户的功能 + 迁移机制）
- **发布物料**（`release/`）：[RELEASE_NOTES](release/RELEASE_NOTES_2026-06-12.md)、[USER_UPGRADE_NOTICE](release/USER_UPGRADE_NOTICE_2026-06-12.md)、[FEATURE_VERIFICATION_GUIDE](release/FEATURE_VERIFICATION_GUIDE_2026-06-12.md)（8 个启用 feature 的验证指引，2 已通过 ✅）

### 🔲 新发现待办（`note/ISSUE/`，本 PR 不修，单独排期）
- [settings 缓存切 CWD 未失效](ISSUE/2026-06-12-settings-cache-stale-on-cwd-switch.md)（bridge/worktree，**既有问题非本次回归**）
- [`CLAUDE_CODE_USE_OPENAI` 的 YWCODER_* fallback 不完整](ISSUE/2026-06-12-use-openai-flag-fallback-incomplete.md)（providerProfiles 直读旧名 → 内网脚本暂须保留旧名）
- [`--migrate-config` 对已迁移用户不幂等](ISSUE/2026-06-12-migrate-config-not-idempotent-on-copy-keep.md)（重复执行会回退配置 → 暂勿建议批量重跑）

### ⏳ 发布前待真机验证（无法在本机替代）
- **F2 auth 登录流程**（存量登录态保留 + 新装落 `.config.json`）
- 6 个 🔄 feature 内网验证 → 通过后更新 FEATURE_VERIFICATION_GUIDE 与发布说明 §2.5

---

## 一、全量扫描结论（src，*.ts/*.tsx）

| 类型 | 总行数 | 文件数 | 处置 |
|------|-------:|------:|------|
| **功能敏感** | | | |
| `ANTHROPIC_*` 环境变量 | 293 | 53 | 加 `YWCODER_*` 别名，回退原值（原值仍可用） |
| `@anthropic-ai/` 导入 | 171 | 133 | **保留**（SDK 依赖，用户不可见） |
| `claude-*` 模型 ID | 223 | 36 | wire 层 ID **保留**，仅改用户可见显示名/marketingName |
| `claude_code.*` OTel 指标名 | 21 | 7 | 需决策（改名会影响已有监控聚合） |
| `CLAUDE.md` 文件名 | 164 | 62 | 加 `YWCODER.md` 别名优先，回退 `CLAUDE.md` |
| `.claude` 路径 | 441 | 169 | 默认已是 `~/.ywcoder`，多数为旧目录 fallback，保留 |
| `anthropics/` GitHub org | 123 | 54 | 需决策（官方仓库/marketplace 链接，改了功能失效） |
| **URL 类** | | | |
| `claude.ai` | 212 | 79 | 移除 / 替换为内网或通用文案 |
| `code.claude.com` / `docs.claude` | 37 | 34 | 移除 / 待内网文档站替换 |
| **纯文本（→ YwCoder）** | | | |
| `Claude Code` 文案 | 317 | 165 | → YwCoder |
| `OpenClaude / openclaude` | 53 | 14 | → YwCoder / ywcoder |
| `Open Claude` | 3 | 3 | → YwCoder |
| 裸 `Anthropic` 文案 | 416 | 113 | 视上下文替换/移除（排除 SDK 导入与 `ANTHROPIC_` 后仍有大量） |

---

## 二、批次 1 — 纯文本替换（零功能风险）
> ✅ **1.1–1.7 高频项已完成**（commit 4c633e3 等）。1.8 注释 + 长尾本工具串由执行 agent 进行中（B1/Tier3）。下方文件级清单保留作"改了哪些"的细节索引。

### 1.1 🔴 CLI 帮助文本与运行时输出 — `src/main.tsx`（12 处 "Claude Code"）
`ywcoder --help` 与各子命令直接可见，**最高优先级**。
- L962 `program.name('claude').description('Claude Code - starts an interactive session…')` → `ywcoder` / YwCoder
- L1016 运行时 `console.warn('Tip: You can launch Claude Code with just \`claude\`')`
- L3879 `Start the Claude Code MCP server`
- L3930 `Import MCP servers from Claude Desktop`
- L3947 `Start a Claude Code session server`
- L4031 `Run Claude Code on a remote host over SSH…`
- L4044 `Connect to a Claude Code server`
- L4086 `Sign in to your Anthropic account` / `Use Anthropic Console…` / `Use Claude subscription`
- L4133 `Manage Claude Code plugins`
- L4156 `Manage Claude Code marketplaces`
- （main.tsx 内含 claude/anthropic 的行共 **212 行**，需逐行过一遍命令描述）

### 1.2 🔴 内置 Agent 系统提示 — `src/tools/AgentTool/built-in/`
模型会据此自报身份，**高泄漏风险**。
- `generalPurposeAgent.ts:3` `…an open-source fork of Claude Code` → YwCoder
- `exploreAgent.ts:24` `…for YwCoder, an open-source fork of Claude Code` → 去掉 fork 后缀
- `planAgent.ts:21` `…planning specialist for Claude Code` → YwCoder
- `statuslineSetup.ts:3,50,137` `for Claude Code` / `Claude Code app version` / `Claude Code status line`
- `claudeCodeGuideAgent.ts` → **见批次 2**（功能区分）

### 1.3 🔴 命令描述/提示文案 — `src/commands/`
- `install.tsx:230,235,299` `安装 Claude Code 原生构建版本` 等（8 处）
- `stickers/index.ts:6` `订购 Claude Code 贴纸`
- `passes/index.ts:13,15` `邀请好友免费试用 Claude Code 一周`
- `remote-setup/index.ts:9` `在网页端配置 Claude Code`
- `cost/cost.ts:12,15` `power your Claude Code usage`
- `ide/ide.tsx:439` `No IDEs with Claude Code extension detected.`
- `init.ts:6,28,217` 生成 CLAUDE.md 的提示词（文件名保留，文案改 YwCoder）
- `mcp/addCommand.ts:37`、`mcp/xaaIdpCommand.ts:35`
- `install-github-app/setupGitHubActions.ts:236` `Claude Code Review workflow`
- `ultraplan.tsx:275`、`thinkback/thinkback.tsx:384-386`、`review.ts:6`（依赖云端，结合批次 2 决策）

### 1.4 🟡 工具描述/提示 — `src/tools/`
- `FileReadTool/prompt.ts:40` `allows Claude Code to read images…`
- `WebFetchTool/utils.ts`、`RemoteTriggerTool/prompt.ts:4`、`shared/spawnMultiAgent.ts`
- `PowerShellTool/pathValidation.ts`、`BashTool/pathValidation.ts`

### 1.5 🟡 UI 组件文案 — `src/components/`
- `LogoV2/ChannelsNotice.tsx:138` `Restart Claude Code without…`
- `FeedbackSurvey/TranscriptSharePrompt.tsx:53` `Can Anthropic look at your session transcript…`
- `Feedback.tsx:36,458` 反馈链接（公网 GitHub）+ issue 标题 prompt（README 已列待办）
- `tasks/RemoteSessionDetailDialog.tsx`、`ResumeTask.tsx`、`mcp/MCPRemoteServerMenu.tsx`、`permissions/rules/PermissionRuleList.tsx` 各含数处

### 1.6 🟡 系统提示零散引用 — `src/constants/`
- `prompts.ts:437` 示例 `anthropics/claude-code#100`（系统提示内可见）
- `outputStyles.ts`、`memdir/findRelevantMemories.ts:18,20`（`useful to Claude Code`）

### 1.7 🟢 OpenClaude 残留
- `utils/http.ts:62` 反馈链接 `github.com/Gitlawb/openclaude`（**用户可见**）
- `tools/WebSearchTool/WebSearchTool.ts:434` `originator: 'openclaude'`（随请求外发）
- `utils/providerProfile.ts:693` `OPENCLAUDE_PROFILE_GOAL` env 名
- `grpc/server.ts:11,22,32` proto 包名 `openclaude.v1` + `src/proto/openclaude.proto`（彻底版需改名，**有兼容风险**，见决策）
- 注释/内部：`ink/terminal.ts:169`、`ink/termio/osc.ts:220`（临时文件名 `openclaude-clipboard`）、`bridge/sessionRunner.ts:33`、`utils/providerFlag.ts:8-11`、`utils/buildConfig.ts`、`cli/update.ts:34`、`components/StartupScreen.ts:2`

### 1.8 🟢 注释 / 调试日志（彻底版）
- `services/api/client.ts:82-89` `[Anthropic SDK ERROR/WARN/INFO/DEBUG]` 日志前缀
- 各文件中文/英文注释里的 `Claude Code` / `OpenClaude` / `官方 Claude Code`（如 `configMigration.ts` 多处注释）

---

## 三、批次 2 — guide agent 功能区分（`claudeCodeGuideAgent.ts`）
> ✅ **已完成（15b899e），但最终做法与本节计划不同**：评估后**整体禁用并移出打包产物**（注释 import + 注册，tree-shaking 掉），而非"功能区分改写"——因为它本质是 Claude Code/Anthropic API 文档助手，内网用不上。将来接内网文档时恢复注册即可。详见 [DISABLED_FEATURES.md](DISABLED_FEATURES.md)。下方为当初的改写计划，留作参考。

该 agent 当前满篇讲 Claude Code CLI / Claude Agent SDK / Anthropic API。按用户要求拆分：
- **YwCoder 具备的能力**（hooks、skills、MCP servers、快捷键、IDE 集成、settings、slash 命令）→ 改写成「YwCoder 使用指南」文案，保留对用户有用的提示
- **Anthropic 专有**（Claude Agent SDK 教学、Anthropic API/SDK 用法、`CLAUDE_CODE_DOCS_MAP_URL` 文档抓取）→ 禁用相关分支或评估替换为 YwCoder 自有文档/服务
- 同步改 `whenToUse`（L100）与 agent 注册名 `claude-code-guide`
- 涉及位置：`claudeCodeGuideAgent.ts:30,34,36,42,100` + 引用它的注册表

---

## 四、批次 3 — 功能敏感项「别名 + 回退」策略
> ⚠️ **本节为原始计划，已被 D4 决策调整——最终以 [DECISIONS.md](DECISIONS.md) 为准**：
> - 4.1 `ANTHROPIC_*` → **不做别名，保持不动**（D4-c：与 OPENAI_* 同类的协议命名）。
> - 4.2 `claude-*` 模型 → **不造 YwCoder 名**；改为移除 `/model` payg3p 硬编码兜底（D4-a）。
> - 4.3 `CLAUDE.md` → **已落地**：YWCODER.md 主 + CLAUDE.md 只读兜底，init 生成 YWCODER.md，仓库文件已改名（D4-b，commit 2372943/7ce89ac，含专项测试 6e5ed3a）。
> - 4.4 `.claude/` 目录 → 项目级迁移列为 **D7 暂缓**。

> 原则（原始计划）：**新增 YwCoder 入口并优先读取，原值保持可用**，wire/协议层一律不动。

### 4.1 `ANTHROPIC_*` 环境变量（293 行 / 53 文件）
- 新增读取 `YWCODER_API_KEY` / `YWCODER_BASE_URL` / `YWCODER_AUTH_TOKEN`，回退到 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
- **禁改**：发往 Anthropic API 的 `x-api-key`、`anthropic-version` 等 HTTP header（协议字段）
- 锚点：`utils/auth.ts`、`services/api/client.ts`、`services/api/claude.ts`、`utils/api.ts`、`hooks/useApiKeyVerification.ts`、`utils/proxy.ts`

### 4.2 `claude-*` 模型 ID（223 行 / 36 文件）
- **禁改**：传给 provider 的 model id（`claude-opus-4-*` 等，改了 API 报错）
- **可改**：用户可见的 marketingName / 模型选择列表显示名（`constants/prompts.ts:626,665` 的 "You are powered by the model named …" 已用 marketingName，确认显示名是否含 "Claude"）
- 锚点：`utils/model/`（13 文件）、模型选择 UI

### 4.3 `CLAUDE.md`（164 行 / 62 文件）
- 新增优先读取 `YWCODER.md`，不存在再回退 `CLAUDE.md`（保持对存量项目兼容）
- `init.ts` 生成时可写 `YWCODER.md` 或维持 `CLAUDE.md`（需决策，见下）
- 注意：本仓库自身 `CLAUDE.md` 含项目规则，改名前确认加载逻辑

### 4.4 `.claude` 目录（441 行 / 169 文件）
- 默认已 `~/.ywcoder`，绝大多数是旧目录 fallback / 迁移逻辑 → **保留**
- 仅清理面向用户的**提示文案**里出现的 `~/.claude` 字样

---

## 五、需你决策的项
> ✅ **全部已决策并落地**（2026-06-08）。本表是最初提出时的草稿；最终结论与执行见 [DECISIONS.md](DECISIONS.md)。速览：D1 指标名→ywcoder.*；D2 官方市场 auto-install 禁用；D3 proto→ywcoder.v1；D4 见上节四；D5 云功能整批禁用（见 DISABLED_FEATURES）；D6 ISSUES_EXPLAINER 中性化/originator·UA URL→ywcoder（Claude-User UA 保留）；新增 D7（项目级 `.claude/` 目录）暂缓。

| # | 事项 | 影响 | 建议 |
|---|------|------|------|
| D1 | `claude_code.*` OTel 指标名（21 行） | 改名会断开已有监控聚合 | 内网无监控则可改；有则保留 |
| D2 | `anthropics/` GitHub org（123 行：plugins marketplace、官方仓库） | 改了官方插件市场/仓库功能失效 | 保留功能性链接，仅改文案描述 |
| D3 | proto 包名 `openclaude.v1` → `ywcoder.v1` | gRPC 客户端需同步，跨版本兼容风险 | 内网自用且可同步客户端则改 |
| D4 | `CLAUDE.md` 是否改名为 `YWCODER.md` | 存量项目的 CLAUDE.md 需 fallback | 用别名+回退，新建写 YWCODER.md |
| D5 | Bridge / Teleport / ultraplan / thinkback / review 等**依赖 Anthropic 云**的功能 | 内网不可用 | 禁用入口或文案中性化 |
| D6 | 反馈系统链接（`Feedback.tsx`、`http.ts`）改内网地址 | 需提供内网 issue 入口 | 待内网地址确定 |

---

## 六、验证方式

每批次结束执行：
```bash
bun run build && bun run smoke
bun test --max-concurrency=1
```
另建议加一条**回归 grep 守卫**（CI 中跑），确保用户可见文案不再出现关键字：
```bash
# 仅扫面向用户的字符串/提示，排除已确认保留项
grep -rnE 'Claude Code|OpenClaude|Open Claude' src --include='*.ts' --include='*.tsx' \
  | grep -viE '@anthropic-ai|claude-[0-9a-z]|ANTHROPIC_|CLAUDE\.md|\.test\.'
```

---

## 七、建议执行顺序

1. **批次 1.1 / 1.2 / 1.3**（main.tsx 帮助文本、agent 提示、命令描述）— 用户最高频可见
2. **批次 2**（guide agent 功能区分）
3. **批次 1.4–1.8**（工具/UI/注释/OpenClaude 残留）
4. **批次 3**（功能敏感别名，需逐项测试）
5. 决策项 D1–D6 逐个落地
