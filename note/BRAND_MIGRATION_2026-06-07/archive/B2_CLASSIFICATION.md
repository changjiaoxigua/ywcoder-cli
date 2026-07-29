# B2 裸 `Claude` 字符串分类（首遍 agent 草拟 + 人工复审落地）

**日期**：2026-06-08　**分支**：feature/brand-replacement
**流程**：B2 首遍分类 agent（只读沙箱，仅产出分类）→ 人工逐条复审并落地高置信项。
**范围**：会进 dist 的**字符串字面量**里、单独的裸 `Claude`（非 `Claude Code`，非注释，非标识符）。
**基线/验收**：`bun run build` ✅；`bun test --max-concurrency=1` → **571 pass / 0 fail**；改后 dist 已无下列"自指"原文。

---

## ① 已改·助手自指（本批落地，21 文件 32 处）

判据：句中 `Claude` = 正在干活/对话的本工具，换成 YwCoder 语义正确。

**权限提示占位/标签（"tell Claude what to do…" / "allow Claude to…"）**
- src/components/permissions/PermissionPrompt.tsx:31,32（accept/reject 默认占位）
- src/components/permissions/PowerShellPermissionRequest/powershellToolUseOptions.tsx:30,79
- src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx:67,135
- src/components/permissions/FilePermissionDialog/permissionOptions.tsx:83,162（占位）+ 111（"allow Claude to edit its own settings"；`value:'yes-claude-folder'`/scope 符号**未动**）
- src/components/permissions/SandboxPermissionRequest.tsx:91
- src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx:264
- src/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx:104（占位）+ 214（"allow Claude to fetch this content?"）

**Plan mode / 工具 UI 自指**
- src/tools/EnterPlanModeTool/UI.tsx:22（"Claude is now exploring and designing…"）
- src/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx:52,59
- src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:603,630,647
  （:630 "Here is Claude's plan:" 系复审时补上，agent 原清单遗漏）
- src/tools/WebFetchTool/WebFetchTool.ts:88,90
- src/tools/WebSearchTool/WebSearchTool.ts:526

**状态 / 错误 / 运行时自指**
- src/screens/REPL.tsx:3944（"Claude is waiting for your input"）, 4135（"Claude has been suspended…"，同句已含 YwCoder）
- src/components/ResumeTask.tsx:260（"Sorry, Claude encountered an error"）
- src/components/Onboarding.tsx:74（"Claude can make mistakes"）
- src/components/LogSelector.tsx:1318（"Claude found these results:"）
- src/components/IdeOnboardingDialog.tsx:89（"Claude has context of…"）
- src/utils/Shell.ts:236（"Please restart Claude from an existing directory."）
- src/utils/config.ts:1219（"another Claude instance may be running"，debug 日志；**未碰**本文件的 CLAUDE.md 回退护栏）
- src/utils/bash/ShellSnapshot.ts:488（debug 日志 "Claude home:"，值已是 `getYwCoderConfigHomeDir()`）
- src/cli/update.ts:242（"Another Claude process is currently running"，运行中实例，与 config.ts:1219 同类）

---

## ② 保留·护栏 / 外部产品 / 模型 / 订阅 / 符号（未改）

- **符号名/标识符（dist 命中占绝大多数，约 90+ 处）**：`ClaudeAuthProvider`、`getGlobalClaudeFile`、`isPossibleClaudeBinary`、`createClaudeForChromeMcpServer`、`shouldDisableClaudeMd`、`getClaudeMds`、`loginWithClaudeAi`、`handleClaudeAIAuth`、`McpClaudeAIProxyServerConfigSchema`、`ClaudeError`、`totalClaudeChars`、`failedClaudeAiClients` 等 —— Claude 紧贴字母/`.`/`_` 的一律不动（改了会坏）。
- **模型 / API 事实**：`Claude API`/`Native Claude API`/`Claude model`/`Claude Opus`/"The most recent Claude model family is Claude 4…"/"only available on Claude Sonnet"/"Claude decides when and how much to think (Opus…)" —— 事实性，留。
- **订阅 / 账户**：`Claude Pro/Max/Team/Enterprise`、"Claude subscription required"、"Login with Claude account"、"Teleport requires a Claude account"、"Your Claude Pro/Max subscription…"、"billed…through your Console" —— Anthropic 订阅/账户，留。
- **外部产品 Claude Desktop**：所有 "Claude Desktop"/"Open in Claude Desktop"/"Import MCP Servers from Claude Desktop"/"Session transferred to Claude Desktop" —— 留。
- **Claude in Chrome / 浏览器扩展（已禁用功能）**：所有 "Claude in Chrome"/"Claude Chrome Extension"/"Claude browser extension"/"Claude Chrome Native Host" —— 留。
- **the Claude app（移动端外部产品）**：混合句里 YwCoder 已替、`Claude app` 留。
- **GitHub App / workflow（anthropics/claude-code-action）**：`Claude GitHub App`/`Claude workflow file`/`Claude PR Assistant workflow`/"mention @claude" —— 留。
- **Anthropic 数据计划**：`Help improve Claude`/"Turning ON the improve Claude setting…" —— 留。
- **Claude Slack** —— 留（外部集成）。

---

## ③ 不确定·待人工（未改，已记 [HUMAN_REVIEW_NEEDED.md](HUMAN_REVIEW_NEEDED.md)）

- **法务复核文案**：`AutoModeOptInDialog.tsx:10` `AUTO_MODE_DESCRIPTION`（6 处自指，但带 "legally reviewed — do not modify without Legal team approval" 注释）。
- **install/update/二进制名/配置展示名**（11 处一类）：`Shell.ts:131`、`localInstaller.ts:125`、`update.ts:137-175`、`nativeInstaller/installer.ts:870,886`、`config.ts:1495,1542` —— 自指 vs 二进制/包名歧义，多属已禁用 install 路径，建议统一裁决。

---

## 待办（交回主线后）

1. 你裁决 ③ 两类（法务文案、install/update 二进制名）。
2. Phase C：扫 dist 终审 + 文件系统产物运行时核查。
3. Phase D：CI 打包 → 内网测试 → 合并 main。
