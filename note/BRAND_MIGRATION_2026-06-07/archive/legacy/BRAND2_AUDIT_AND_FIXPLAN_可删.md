# YwCoder 品牌化改造审查报告 & 修复计划

**审查日期**: 2026-04-09
**审查范围**: src/ 目录全量扫描
**审查依据**: BRAND_MIGRATION_SUMMARY.md

---

## 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 核心身份（启动屏、系统 prompt、版本号） | 95/100 | 几乎完整 |
| 环境变量 fallback | 90/100 | 全面，少数边缘变量缺 YWCODER 版本 |
| 配置目录 | 95/100 | 阶段6还原后逻辑清晰 |
| UI 文本替换 | 45/100 | 大量遗漏，186 个文件仍含 "Claude Code" |
| 文档链接 | 20/100 | ~20+ 处 `code.claude.com` 对内网不可达 |
| 生态兼容性 | 95/100 | CLAUDE.md、MCP、Skills 完整保留，无破坏 |

**综合评分：68/100**

---

## 一、UI 层遗留问题

### P0 — 用户直接可见（高优先级）

#### 1.1 终端输出 / 错误消息类

| 文件:行号 | 字符串内容 | 触发场景 |
|-----------|-----------|---------|
| `src/screens/REPL.tsx:4135` | `"Claude Code has been suspended. Run \`fg\` to bring Claude Code back.\nNote: ctrl + z now suspends Claude Code..."` | 用户按 Ctrl+Z 挂起时终端直接输出（3处） |
| `src/setup.ts:75` | `"Error: Claude Code requires Node.js version 18 or higher."` | Node.js 版本不足时启动报错 |
| `src/utils/windowsPaths.ts:106` | `"Claude Code was unable to find CLAUDE_CODE_GIT_BASH_PATH path..."` | Windows 用户路径缺失错误 |
| `src/utils/windowsPaths.ts:122` | `"Claude Code on Windows requires git-bash..."` | Windows 缺少 git-bash 时的错误 |
| `src/utils/messages.ts:240` | `"...Claude Code is running in don't ask mode."` | 权限拒绝时的提示 |
| `src/services/api/errors.ts:548` | `"enable extra usage at claude.ai/settings/usage"` | 速率限制错误消息，含 claude.ai 链接 |
| `src/bridge/bridgeMain.ts:2255` | `"...from Claude Code on Web or your Mobile app. Learn more here: https://code.claude.com/docs/en/remote-control"` | Remote Control 启动时终端输出 |
| `src/bridge/bridgeEnabled.ts:169` | `"Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control."` | 版本过旧错误消息 |
| `src/bridge/envLessBridgeConfig.ts:150` | `"Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control."` | 同上（另一处） |
| `src/utils/teleport.tsx:441` | `"Claude Code web sessions require authentication with a Claude.ai account..."` | teleport 认证错误 |
| `src/utils/teleport.tsx:611` | `"Run /status in Claude Code to check your account."` | teleport 错误消息 |

#### 1.2 命令描述 / 工具提示类（`/help` 和 typeahead 可见）

| 文件:行号 | 字符串内容 | 触发场景 |
|-----------|-----------|---------|
| `src/commands/model/index.ts:9` | `"Set the AI model for Claude Code (currently ...)"` | `/help` 和命令 typeahead |
| `src/commands/thinkback/index.ts:7` | `"Your 2025 Claude Code Year in Review"` | `/thinkback` 命令描述 |
| `src/tools/ConfigTool/prompt.ts:9` | `"Get or set Claude Code configuration settings."` | `/config` 命令描述 |
| `src/tools/ConfigTool/prompt.ts:50` | `"View or change Claude Code settings."` | ConfigTool 工具描述 |
| `src/tools/ConfigTool/prompt.ts:52` | `"Claude Code settings"` | 工具描述片段 |
| `src/tools/ConfigTool/ConfigTool.ts:69` | `"get or set Claude Code settings (theme, model)"` | 工具搜索提示 |
| `src/commands/Doctor.tsx:225` | `"Claude Code diagnostics dismissed"` | `/doctor` 命令完成提示 |

#### 1.3 系统 Prompt（影响 AI 自我表达）

| 文件:行号 | 字符串内容 | 触发场景 |
|-----------|-----------|---------|
| `src/coordinator/coordinatorMode.ts:117` | `"You are Claude Code, an AI assistant..."` | Coordinator 模式下 LLM 自我介绍，用户可间接感知 |

#### 1.4 Shell 补全（写入用户系统文件）

| 文件:行号 | 字符串内容 | 风险 |
|-----------|-----------|------|
| `src/utils/completionCache.ts:92,148` | `process.argv[1] \|\| 'claude'` | fallback 值使用 `'claude'`，应为 `'ywcoder'` |
| `src/utils/completionCache.ts:100,108` | `"claude completion ${shell.shellFlag}"` | 提示文本对用户可见 |
| `src/utils/completionCache.ts:126` | `"# Claude Code shell completions"` | **写入用户 `.bashrc`/`.zshrc`**，用户编辑 shell 配置时可见 |

#### 1.5 UI 组件

| 文件:行号 | 字符串内容 | 触发场景 |
|-----------|-----------|---------|
| `src/commands/thinkback/thinkback.tsx:375` | `"Think Back on 2025 with Claude Code"` (标题) | `/thinkback` 命令 UI |
| `src/commands/thinkback/thinkback.tsx:384-386` | `"Claude Code year in review animation"` (3处) | `/thinkback` 命令 prompt |
| `src/commands/ultraplan.tsx:118,187,190,275,464` | 多处 `"Claude Code on the web"` | `/ultraplan` 命令用户可见文本 |
| `src/utils/deepLink/registerProtocol.ts:34-36` | `"Claude Code URL Handler"` | macOS 协议注册 App 名称，Finder 中可见 |

### P0 — `code.claude.com` 文档链接（内网不可达）

> 内网用户点击后无法访问，约 20+ 处，以下为高频场景：

| 文件 | URL | 触发场景 |
|------|-----|---------|
| `src/components/TrustDialog/TrustDialog.tsx:220` | `.../security` | TrustDialog "Security guide" 链接，首次进入目录时出现 |
| `src/components/mcp/MCPListPanel.tsx:434` | `.../mcp` | MCP 列表帮助链接 |
| `src/components/mcp/MCPSettings.tsx:150` | `.../mcp` | MCP 设置帮助链接 |
| `src/components/sandbox/SandboxSettings.tsx:280` | `.../sandboxing` | 沙箱设置文档链接 |
| `src/commands/model/model.tsx:159,165` | `.../model-config#extended-context-with-1m` | 模型配置提示 |
| `src/commands/chrome/chrome.tsx:237` | `.../chrome` | Chrome 集成文档链接 |
| `src/commands/fast/fast.tsx:194` | `.../fast-mode` | Fast mode 文档链接 |
| `src/commands/memory/memory.tsx:77` | `.../memory` | `/memory` 命令 Learn more 链接 |
| `src/keybindings/template.ts:47` | `.../keybindings` | keybindings 模板文档链接 |
| `src/utils/settings/validationTips.ts:26` | `https://code.claude.com/docs/en` | 设置验证提示基础 URL（影响所有设置验证提示） |

### P1 — 低频但可见

| 文件 | 内容 | 触发场景 |
|------|------|---------|
| `src/tools/BashTool/pathValidation.ts`（5处） | `"For security, Claude Code cannot automatically..."` | 路径安全校验权限请求 |
| `src/commands/insights.ts`（29处） | `"Claude Code session"` / `"Claude Code usage data"` | `/insights` 分析报告，影响 LLM 生成文本 |
| `src/cli/handlers/autoMode.ts:50-52` | `"auto mode classifier rules for Claude Code"` | auto mode reviewer prompt |
| `src/services/tips/tipRegistry.ts`（4处已禁用） | 仍含 "Claude Code" 的 tip 内容 | 当前已通过 `isRelevant: () => false` 禁用，若后续误启用会暴露 |
| `src/constants/github-app.ts`（10处） | PR title/body 中的 `"Claude Code"` | GitHub App 工作流模板生成的 PR |

### P2 — 内部代码/注释（不影响用户感知，不建议专项处理）

| 分类 | 数量 |
|------|------|
| 代码注释中的 "Claude Code" | ~80 处 |
| OTel 指标名 `claude_code.*` | ~5 处（**不应改**，会破坏监控兼容性）|
| `@anthropic-ai/sdk` import | ~30 处（**不应改**，SDK 包名）|
| `ANTHROPIC_*` 环境变量 | ~60 处（**不应改**，API 服务商变量）|
| `api.anthropic.com` API 端点 | ~20 处（**不应改**，功能依赖）|

---

## 二、功能可用性审查

| 项目 | 结论 | 说明 |
|------|------|------|
| `envUtils.ts` 配置目录逻辑 | ✅ 正常 | 阶段6还原后逻辑清晰 |
| `constants/oauth.ts` OAuth 配置 | ✅ 正常（预期） | 仍指向 Anthropic 服务，属预期行为，不应修改 |
| `entrypoints/cli.tsx` | ✅ 正常 | 版本号、品牌名均已替换 |
| API 调用链 / User-Agent | ✅ 正常 | `userAgent.ts` 已正确返回 `ywcoder/版本号` |
| MCP 功能 | ✅ 正常 | `getYwCoderMcpConfigs()` 已正确重命名 |
| `completionCache.ts:92,148` | ⚠️ 有风险 | `process.argv[1] \|\| 'claude'` fallback 值应为 `'ywcoder'` |
| `coordinator/coordinatorMode.ts:117` | ⚠️ 有影响 | Coordinator 系统 prompt 含 `"You are Claude Code"`，影响 AI 自我表达 |

---

## 三、生态兼容性审查

| 项目 | 结论 | 说明 |
|------|------|------|
| `CLAUDE.md` 文件名和解析逻辑 | ✅ 正确保留 | 50+ 处引用，OMC/Cursor 等工具依赖此文件名 |
| `init.ts` CLAUDE.md 文件头 | ✅ 正确保留 | 生态标准格式，不应改动 |
| Skills / Hooks 系统 | ✅ 正常 | 不依赖品牌字符串 |
| MCP connector 名称（`claude.ai Slack` 等）| ✅ 正确保留 | 服务端返回的协议层标识，不应修改 |
| GitHub App 模板（`anthropics/claude-code-action@v1`）| ✅ 正确保留 | GitHub Action 引用，改名会导致 Action 找不到 |
| `process.argv` 品牌检查 | ✅ 正常 | `--claude-in-chrome-mcp` 是协议约定 flag，不影响功能 |
| Deep Link (`claude://`) | ✅ 已知，不影响 | 已在 BRAND_MIGRATION_SUMMARY 中评估，内网场景未启用 |
| OTel 指标名 `claude_code.*` | ✅ 正确保留 | 改名会破坏监控仪表盘兼容性 |

---

## 四、修复计划

### 原则

- **改**: 用户可见的 UI 文本、终端输出、命令描述、系统 prompt
- **不改**: CLAUDE.md 文件头、GitHub Action 模板、MCP connector 名称、OTel 指标名、`ANTHROPIC_*` 变量、`api.anthropic.com` URL
- **文档链接处理策略**: 内网暂无文档站时，替换为移除链接或改为通用提示文本

---

### Sprint 1 — P0 高优先级（建议尽快完成）

#### Task 1.1：Shell 补全文本（写入用户系统文件，最高优先）

- **文件**: `src/utils/completionCache.ts`
- **改动**:
  - `process.argv[1] || 'claude'` → `process.argv[1] || 'ywcoder'`（2处，第92、148行）
  - `"claude completion ..."` → `"ywcoder completion ..."`（2处，第100、108行）
  - `"# Claude Code shell completions"` → `"# YwCoder shell completions"`（第126行）

#### Task 1.2：REPL 挂起/恢复提示

- **文件**: `src/screens/REPL.tsx:4135`
- **改动**: 3处 `"Claude Code"` → `"YwCoder"`

#### Task 1.3：启动错误消息

- **文件**: `src/setup.ts:75`
- **改动**: `"Claude Code requires Node.js"` → `"YwCoder requires Node.js"`

#### Task 1.4：Windows 错误消息

- **文件**: `src/utils/windowsPaths.ts:106,122`
- **改动**: 2处 `"Claude Code"` → `"YwCoder"`

#### Task 1.5：命令/工具描述

- **文件**:
  - `src/commands/model/index.ts:9`
  - `src/tools/ConfigTool/prompt.ts:9,50,52`
  - `src/tools/ConfigTool/ConfigTool.ts:69`
  - `src/screens/Doctor.tsx:225`
  - `src/commands/thinkback/index.ts:7`
- **改动**: 相关 `"Claude Code"` → `"YwCoder"`

#### Task 1.6：Coordinator 系统 Prompt

- **文件**: `src/coordinator/coordinatorMode.ts:117`
- **改动**: `"You are Claude Code, an AI assistant..."` → `"You are YwCoder, an AI assistant..."`

#### Task 1.7：权限拒绝提示

- **文件**: `src/utils/messages.ts:240`
- **改动**: `"Claude Code is running in don't ask mode"` → `"YwCoder is running in don't ask mode"`

#### Task 1.8：速率限制错误（claude.ai 链接）

- **文件**: `src/services/api/errors.ts:548`
- **改动**: 移除 `claude.ai/settings/usage` 链接，或替换为通用提示

---

### Sprint 2 — P0 文档链接（建议近期完成）

> 目前内网无文档站，统一策略：**移除链接或替换为"请联系管理员"等通用文本**。
> 若后续建立内网文档站，可统一替换为内网 URL。

#### Task 2.1：TrustDialog 安全指南链接

- **文件**: `src/components/TrustDialog/TrustDialog.tsx:220`
- **改动**: 移除 `<Link url="https://code.claude.com/docs/en/security">Security guide</Link>` 或替换为静态文本

#### Task 2.2：设置验证基础 URL（影响所有设置验证提示）

- **文件**: `src/utils/settings/validationTips.ts:26`
- **改动**: 将 `code.claude.com/docs/en` 基础 URL 移除或替换为空字符串

#### Task 2.3：MCP 帮助链接

- **文件**: `src/components/mcp/MCPListPanel.tsx:434`、`src/components/mcp/MCPSettings.tsx:150`
- **改动**: 移除或替换 MCP 文档链接

#### Task 2.4：其余文档链接（批量处理）

- **文件**: `src/commands/model/model.tsx`、`src/commands/chrome/chrome.tsx`、`src/commands/fast/fast.tsx`、`src/commands/memory/memory.tsx`、`src/keybindings/template.ts`、`src/components/sandbox/SandboxSettings.tsx`
- **改动**: 统一移除 `code.claude.com` 链接或替换为通用文本

---

### Sprint 3 — P1 低频场景（按需处理）

#### Task 3.1：路径安全校验提示

- **文件**: `src/tools/BashTool/pathValidation.ts`（5处）
- **改动**: `"Claude Code cannot automatically..."` → `"YwCoder cannot automatically..."`

#### Task 3.2：insights 分析 Prompt

- **文件**: `src/commands/insights.ts`（29处）
- **改动**: `"Claude Code session"` → `"YwCoder session"`
- **注意**: 这影响 LLM 生成报告的用词，非用户直接输入，可按需处理

#### Task 3.3：Bridge / Teleport 错误消息

- **文件**: `src/bridge/bridgeMain.ts:2255`、`src/bridge/bridgeEnabled.ts:169`、`src/bridge/envLessBridgeConfig.ts:150`、`src/utils/teleport.tsx:441,611`
- **改动**: 相关 `"Claude Code"` → `"YwCoder"`，`code.claude.com` 链接移除

#### Task 3.4：ultraplan 命令文本

- **文件**: `src/commands/ultraplan.tsx`（5处）
- **改动**: `"Claude Code on the web"` → `"YwCoder"`

#### Task 3.5：thinkback 命令 UI 文本

- **文件**: `src/commands/thinkback/thinkback.tsx:375,384-386`
- **改动**: 标题和 prompt 中的 `"Claude Code"` → `"YwCoder"`

#### Task 3.6：autoMode reviewer prompt

- **文件**: `src/cli/handlers/autoMode.ts:50-52`
- **改动**: `"Claude Code"` → `"YwCoder"`

#### Task 3.7：Deep Link 注册名称

- **文件**: `src/utils/deepLink/registerProtocol.ts:34-36`
- **改动**: `"Claude Code URL Handler"` → `"YwCoder URL Handler"`（仅在 macOS Finder 中可见）

---

### 不修改项（明确保留）

| 内容 | 原因 |
|------|------|
| `src/commands/init.ts` CLAUDE.md 文件头 | 生态标准格式，OMC/Cursor 依赖 |
| `src/constants/github-app.ts` GitHub Action 引用 | 改名会导致 Action 找不到 |
| MCP connector 名称（`claude.ai Slack` 等）| 服务端协议层标识 |
| OTel 指标名 `claude_code.*` | 监控兼容性 |
| `ANTHROPIC_*` 环境变量 | API 服务商约定 |
| `api.anthropic.com` API 端点 | 功能依赖 |
| `@anthropic-ai/sdk` import | SDK 包名 |
| 代码注释中的品牌引用（~80处）| 不影响用户，不建议批量改动 |

---

## 五、工作量估算

| Sprint | Task 数 | 预计改动文件数 | 预计改动行数 | 风险 |
|--------|---------|--------------|------------|------|
| Sprint 1 | 8 | ~15 | ~50 | 低 |
| Sprint 2 | 4 | ~10 | ~20 | 低 |
| Sprint 3 | 7 | ~10 | ~60 | 低 |

---

**文档生成时间**: 2026-04-09
**生成依据**: 架构师全量代码扫描（186 文件，373 处 "Claude Code" 引用）

---

## 修复执行记录

### 已完成

**Sprint 1 — P0 高优先级（2026-04-09 完成）**
- ✅ Task 1.1: completionCache.ts（shell 补全文本 5 处）
- ✅ Task 1.2: REPL.tsx（Ctrl+Z 挂起提示 3 处）
- ✅ Task 1.3: setup.ts（Node.js 版本错误）
- ✅ Task 1.4: windowsPaths.ts（Windows 错误消息 2 处）
- ✅ Task 1.5: 命令/工具描述（model、ConfigTool、Doctor、thinkback 共 6 处）
- ✅ Task 1.6: coordinatorMode.ts（Coordinator 系统 prompt）
- ✅ Task 1.7: messages.ts（权限拒绝提示）
- ✅ Task 1.8: errors.ts（速率限制链接移除）

**Git 提交**: `df8beef` - fix: complete UI layer brand replacement for Sprint 1 and Sprint 3

**Sprint 3 — P1 低频场景（部分完成，2026-04-09）**

已完成（建议改的 3 个 Task）：
- ✅ Task 3.1: pathValidation.ts — 路径安全校验权限请求文本（5 处），用户在权限弹框中直接可见
- ✅ Task 3.2: insights.ts — `/insights` 命令 LLM 分析 prompt 及生成报告模板（29 处）
- ✅ Task 3.6: autoMode.ts — auto mode reviewer 系统 prompt（2 处）

跳过（经分析无需修改）：
- ⏭️ Task 3.3: bridge/teleport 错误消息 — Remote Control / teleport 依赖 Anthropic 云服务，内网环境不可用，用户触发概率极低
- ⏭️ Task 3.4: ultraplan.tsx — `isEnabled: () => "external" === 'ant'` 永远为 false，命令在内网构建中已禁用
- ⏭️ Task 3.5: thinkback/thinkback.tsx — 受 Statsig feature gate `tengu_thinkback` 控制，内网 Statsig 不可达，默认关闭
- ⏭️ Task 3.7: deepLink/registerProtocol.ts — `MACOS_BUNDLE_ID` 是系统注册标识符，改名会与已注册条目冲突；`claude://` 深链接功能在内网未启用

### 待处理

**Sprint 2 — P0 文档链接（约 20 处）**
- ⏳ 状态：**阻塞中，等待内网文档站点建立**
- 阻塞原因：目前无可替换的内网文档 URL，临时移除链接会导致用户点击后无反馈
- 处理方式（建立文档站后）：将所有 `code.claude.com/docs/en/*` 替换为对应内网文档 URL
- 重点文件（优先处理）：
  - `src/components/TrustDialog/TrustDialog.tsx:220`（首次进入目录时展示）
  - `src/utils/settings/validationTips.ts:26`（影响所有设置验证提示）
  - `src/components/mcp/MCPListPanel.tsx:434`（MCP 帮助链接）

### 不修改项（明确保留，生态兼容性）

| 内容 | 原因 |
|------|------|
| `src/commands/init.ts` CLAUDE.md 文件头 `"guidance to Claude Code (claude.ai/code)"` | 生态标准格式，OMC/Cursor 等工具依赖此标识 |
| `src/constants/github-app.ts` GitHub Action 引用 `anthropics/claude-code-action@v1` | 改名会导致 Action 找不到 |
| MCP connector 名称（`claude.ai Slack` 等） | 服务端返回的协议层标识 |
| OTel 指标名 `claude_code.*` | 改名会破坏监控仪表盘兼容性 |
| `ANTHROPIC_*` 环境变量、`api.anthropic.com` URL | API 服务商约定，功能依赖 |
| Task 3.7 deepLink Bundle ID `com.anthropic.claude-code-url-handler` | macOS 系统注册标识，改名引入冲突 |
