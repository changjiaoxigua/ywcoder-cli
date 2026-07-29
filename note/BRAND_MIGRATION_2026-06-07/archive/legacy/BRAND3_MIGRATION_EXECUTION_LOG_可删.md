# YwCoder 品牌替换完整执行记录

**执行时间**: 2026-04-12  
**执行者**: Claude Code with OMC  
**执行目标**: 将用户可见的 OpenClaude 品牌替换为 YwCoder，确保用户固定使用 `ywcoder` 命令

---

## 执行摘要

| 阶段 | 内容 | 文件数 | 状态 | 执行日期 |
|------|------|--------|------|---------|
| 阶段1 | 文档品牌替换 | 5 | ✅ 通过 | 2026-04-12 |
| 阶段2 | 关键UI文本替换 | 6 | ✅ 通过 | 2026-04-12 |
| 阶段3 | VS Code扩展最小修改 | 1 | ✅ 通过 | 2026-04-12 |
| 阶段4 | 附加UI文本替换 | 3 | ✅ 通过 | 2026-04-12 |
| 阶段5 | Scripts构建输出修复 | 5 | ✅ 通过 | 2026-04-12 |
| 阶段6 | 项目本地 Profile 文件名改造（`.openclaude-profile.json` → `.ywcoder-profile.json`） | 14 | ✅ 通过 | 2026-04-23 |
| **总计** | | **34** | **✅ 全部通过** | |

---

## 阶段1：文档品牌替换

### 修改文件
- README.md
- docs/quick-start-mac-linux.md
- docs/quick-start-windows.md
- .github/ISSUE_TEMPLATE/config.yml
- .github/ISSUE_TEMPLATE/bug_report.md
- .github/ISSUE_TEMPLATE/feature_request.md

### 关键修改
- `npm install -g @gitlawb/openclaude` → `npm install -g @dcywzc/ywcoder`
- `openclaude` → `ywcoder`
- `Gitlawb/openclaude` → `dcywzc/ywcoder`

---

## 阶段2：关键UI文本替换

### 修改文件

| 文件 | 修改 | 行号 |
|------|------|------|
| src/utils/gracefulShutdown.ts | resume命令提示 | 181 |
| src/commands/provider/provider.tsx | Provider提示(3处) | 338,355,976 |
| src/components/Feedback.tsx | GitHub链接 | 36 |

### 修改详情
```typescript
// gracefulShutdown.ts:181
`openclaude --resume` → `ywcoder --resume`
```

---

## 阶段3：VS Code扩展

### 修改文件
- vscode-extension/openclaude-vscode/package.json:89

### 修改内容
```json
"default": "openclaude" → "default": "ywcoder"
```

---

## 阶段4：附加UI文本替换

### 修改文件

| 文件 | 修改 | 行号 |
|------|------|------|
| WebSearchTool.ts | AI系统提示 | 310 |
| attribution.ts | Git提交信息(3处) | 78,334,380 |
| attribution.ts | domain | 80 |
| githubModelsCredentials.ts | 注释 | 4 |

### 关键修改
- `You are the OpenClaude web search tool` → `YwCoder web search tool`
- `Generated with [OpenClaude]` → `Generated with [YwCoder]`
- `openclaude.dev` → `ywcoder.dev`

---

## 阶段5：Scripts构建输出

### 修改文件

| 文件 | 修改 | 行号 |
|------|------|------|
| scripts/build.ts | 构建输出 | 498 |
| scripts/provider-recommend.ts | 提示文本 | 116 |
| scripts/start-grpc.ts | 启动日志 | 14 |
| scripts/render-coverage-heatmap.ts | 报告标题 | 230 |
| src/commands/provider/provider.tsx | 提示描述 | 487 |

### 关键修改
```typescript
// build.ts:498
`Built openclaude v${version}` → `Built ywcoder v${version}`
```

---

## 应保留项

| 项 | 位置 | 原因 |
|----|------|------|
| ~~.openclaude-profile.json~~ | ~~多处~~ | ~~配置文件名，用户已有~~ → 已在 2026-04-23 改造，见下方"阶段6" |
| OPENCLAUDE_PROFILE_GOAL | env变量 | 环境变量兼容性 |
| openclaude.v1 | proto | gRPC协议定义 |
| Gitlawb/openclaude | 链接 | 原仓库未迁移 |

---

## 测试结果

```bash
✅ bun run build - 成功
✅ bun run smoke - 通过，版本 v1.0.0 (YwCoder)
✅ grep "Built ywcoder" dist/cli.mjs - 正确
✅ grep "ywcoder --resume" dist/cli.mjs - 正确
✅ grep "Restart YwCoder" dist/cli.mjs - 正确
✅ grep "Generated with [YwCoder]" dist/cli.mjs - 正确
```

---

## 故意保留未修改的项（5%）

以下引用**故意未修改**，因为它们不是用户直接可见的内容，或有功能依赖：

### 1. 代码注释中的命令示例

| 文件 | 内容 | 原因 |
|------|------|------|
| `src/utils/providerFlag.ts:8-11` | `openclaude --provider...` 注释示例 | 开发者阅读，非用户可见 |

```typescript
// providerFlag.ts 中的注释示例（未修改）
// Usage:
//   openclaude --provider openai --model gpt-4o
//   openclaude --provider gemini --model gemini-2.0-flash
```

### 2. 临时文件名

| 文件 | 内容 | 原因 |
|------|------|------|
| `src/ink/termio/osc.ts:220` | `openclaude-clipboard` 临时文件前缀 | 临时文件，用户不可见 |

```typescript
const tempPath = generateTempFilePath('openclaude-clipboard', '.txt')
```

### 3. HTTP 请求头标识

| 文件 | 内容 | 原因 |
|------|------|------|
| `src/services/api/codexShim.ts:550` | `originator: 'openclaude'` | API追踪标识，非用户可见 |
| `src/services/api/codexUsage.ts:423` | `originator: 'openclaude'` | API追踪标识，非用户可见 |
| `scripts/system-check.ts:312` | `headers.originator = 'openclaude'` | API追踪标识，非用户可见 |

### 4. 代码溯源注释

| 文件 | 内容 | 原因 |
|------|------|------|
| `src/components/StartupScreen.ts:2` | `// OpenClaude startup screen` | 代码溯源标记 |
| `src/entrypoints/cli.tsx:12,40,51` | `// OpenClaude: polyfill...` | 代码溯源标记 |
| `src/entrypoints/mcp.ts:1` | `// OpenClaude: disable...` | 代码溯源标记 |
| `src/bridge/sessionRunner.ts:33` | `// OpenClaude session...` | 代码溯源标记 |
| `src/utils/buildConfig.ts:2,5,10` | 注释中的 `OpenClaude` | 说明性注释 |
| `scripts/no-telemetry-plugin.ts:2` | `No-Telemetry Build Plugin for OpenClaude` | 说明性注释 |
| `scripts/build.ts:2` | `OpenClaude build script` | 说明性注释 |

### 5. GitHub 链接（原仓库未迁移）

| 文件 | 内容 | 原因 |
|------|------|------|
| `src/utils/http.ts:62` | `github.com/Gitlawb/openclaude` | 原仓库地址 |

**说明**: 代码库已从 `Gitlawb/openclaude` 迁移到 `dcywzc/ywcoder`，但某些引用保留原地址作为代码溯源。

---

## 后续待办事项 (TODO)

### 🔴 高优先级 - 内网部署前必须修改

| 项目 | 当前值 | 需要改为 | 位置 | 说明 |
|------|--------|---------|------|------|
| **反馈系统链接** | `https://github.com/dcywzc/ywcoder/issues` | 内网GitLab/GitHub地址 | `src/components/Feedback.tsx:36` | 用户提交反馈时跳转的地址 |

**详细说明**:
- 当前配置的 `GITHUB_ISSUES_REPO_URL` 指向公网 GitHub
- 内网部署后，用户无法访问公网，需要改为内网代码仓库地址
- 修改后，用户运行 `/feedback` 命令时才能正确提交问题

**修改示例**:
```typescript
// src/components/Feedback.tsx:36
// 当前:
const GITHUB_ISSUES_REPO_URL = 'https://github.com/dcywzc/ywcoder/issues';

// 改为内网地址（示例）:
const GITHUB_ISSUES_REPO_URL = 'https://git.yourcompany.com/ywcoder/issues';
// 或
const GITHUB_ISSUES_REPO_URL = 'https://gitlab.internal.company/ywcoder/-/issues';
```

**注意事项**:
1. 需要确保内网Git系统支持通过URL预填充issue内容（title、body参数）
2. 如果不支持预填充，需要修改 `createGitHubIssueUrl` 函数的逻辑
3. 同时需要检查反馈提交API（`submitFeedback`函数）是否也需要改为内网接口

---

---

## 阶段6：项目本地 Profile 文件名改造（2026-04-23）

**背景**：`ywcoder /provider save` 生成的项目本地配置文件沿用了旧品牌名 `.openclaude-profile.json`，本次改为 `.ywcoder-profile.json`，并保留向后兼容的 fallback 读取逻辑。

### 改动汇总

| 文件 | 改动内容 |
|------|---------|
| `src/utils/providerProfile.ts` | `PROFILE_FILE_NAME` 改为 `.ywcoder-profile.json`；新增 `LEGACY_PROFILE_FILE_NAME = '.openclaude-profile.json'`；`resolveProfileFilePath()` 加入 fallback：新文件不存在且旧文件存在时读取旧文件 |
| `src/commands/provider/provider.tsx:487` | UI 描述文本中的文件名 |
| `scripts/provider-recommend.ts:116` | console.log 输出文本 |
| `vscode-extension/openclaude-vscode/src/extension.js` | `PROFILE_FILE_NAME` 改名；新增 `LEGACY_PROFILE_FILE_NAME`；路径解析加 fallback；新增 `legacyProfileWatcher` 监听旧文件变化 |
| `.gitignore` | 新增 `.ywcoder-profile.json` 忽略规则，保留旧规则（防止旧文件被误提交） |
| `src/commands/provider/provider.test.tsx` | 测试路径字符串（3处）|
| `vscode-extension/openclaude-vscode/src/extension.test.js` | 测试路径字符串（2处）|
| `vscode-extension/openclaude-vscode/src/presentation.test.js` | 测试路径字符串（6处）|
| `README.md`、`package/README.md` | 文档文件名引用 |
| `PLAYBOOK.md` | 文档文件名引用（2处）|
| `docs/advanced-setup.md` | 文档文件名引用 |
| `vscode-extension/openclaude-vscode/README.md` | 文档文件名引用（2处）|

### 向后兼容策略

读取时：若 `.ywcoder-profile.json` 不存在但 `.openclaude-profile.json` 存在，自动使用旧文件（静默兼容，无提示）。

写入时：始终写入 `resolveProfileFilePath()` 返回的路径。已有旧文件的项目，在 `/provider save` 前将继续读旧文件；执行一次保存后，写入旧文件路径（fallback 返回旧路径）；用户手动删除旧文件后，后续写入新文件名。

故意保留的旧名引用（正常，为兼容逻辑）：
- `src/utils/providerProfile.ts:19` — `const LEGACY_PROFILE_FILE_NAME = '.openclaude-profile.json'`
- `vscode-extension/openclaude-vscode/src/extension.js:19` — `const LEGACY_PROFILE_FILE_NAME = '.openclaude-profile.json'`

### 未变更的相关规划文档

- `note/PROFILE_FILE_RENAME_PLAN.md` — 本次改造的原始计划文档，已执行

---

## 阶段7：硬编码字符串遗漏修复（2026-05-14）

**背景**：品牌替换阶段 1-6 完成后，PowerShell 终端标题仍显示 `"Open Claude"`，经排查发现代码中存在 6 处硬编码的 `"Open Claude"` 字符串未被替换。

### 修改文件

| 文件 | 修改 | 行号 |
|------|------|------|
| `src/screens/REPL.tsx` | 终端窗口标题默认值 | 1133 |
| `src/services/mcp/client.ts` | MCP 客户端 title（2 处） | 1002, 3298 |
| `src/services/mcp/client.ts` | MCP 客户端 name（2 处） | 1001, 3297 |
| `src/services/mcp/client.ts` | MCP 客户端 description（2 处） | 1004, 3300 |
| `src/utils/logoV2Utils.ts` | 欢迎消息 | 99 |
| `src/components/LogoV2/feedConfigs.tsx` | 分享提示 | 76 |
| `src/commands/buddy/index.ts` | 命令描述 | 6 |

### 修改详情

```typescript
// REPL.tsx:1133
const terminalTitle = sessionTitle ?? agentTitle ?? haikuTitle ?? 'ywcoder';

// mcp/client.ts:1001-1004
title: 'ywcoder'
name: 'ywcoder'
description: "YwCoder's agentic coding tool"

// logoV2Utils.ts:99
return 'Welcome to YwCoder'

// feedConfigs.tsx:76
const subtitle = reward ? `Share YwCoder and earn ${formatCreditAmount(reward)} of extra usage` : 'Share YwCoder with friends';

// buddy/index.ts:6
description: 'Hatch, pet, and manage your YwCoder companion',
```

### 命名策略决策

- **程序/协议层面**（终端标题、MCP title/name）：使用小写 `ywcoder`，与命令行工具名保持一致
- **用户文案层面**（欢迎语、分享语、命令描述）：使用 `YwCoder`，作为产品名展示

---

## 后续待办事项 (TODO)

### 🔴 高优先级 - 内网部署前必须修改

| 项目 | 当前值 | 需要改为 | 位置 | 说明 |
|------|--------|---------|------|------|
| **反馈系统链接** | `https://github.com/dcywzc/ywcoder/issues` | 内网GitLab/GitHub地址 | `src/components/Feedback.tsx:36` | 用户提交反馈时跳转的地址 |

**详细说明**:
- 当前配置的 `GITHUB_ISSUES_REPO_URL` 指向公网 GitHub
- 内网部署后，用户无法访问公网，需要改为内网代码仓库地址
- 修改后，用户运行 `/feedback` 命令时才能正确提交问题

**修改示例**:
```typescript
// src/components/Feedback.tsx:36
// 当前:
const GITHUB_ISSUES_REPO_URL = 'https://github.com/dcywzc/ywcoder/issues';

// 改为内网地址（示例）:
const GITHUB_ISSUES_REPO_URL = 'https://git.yourcompany.com/ywcoder/issues';
// 或
const GITHUB_ISSUES_REPO_URL = 'https://gitlab.internal.company/ywcoder/-/issues';
```

**注意事项**:
1. 需要确保内网Git系统支持通过URL预填充issue内容（title、body参数）
2. 如果不支持预填充，需要修改 `createGitHubIssueUrl` 函数的逻辑
3. 同时需要检查反馈提交API（`submitFeedback`函数）是否也需要改为内网接口

### 🟡 中优先级 - 待实施

| 项目 | 说明 | 参考文档 |
|------|------|---------|
| **Phase 3：`~/.ywcoder` 配置目录迁移** | 将 `getYwCoderConfigHomeDir()` 默认目录从 `~/.claude` 改为 `~/.ywcoder`，新增 `configMigration.ts` 和 `--migrate-config` 命令 | `note/STAGE3_MIGRATION_RISKS.md`（风险分析已完成，各项风险已有决策） |

---

**状态**: ✅ 全部完成（公网版本）+ ✅ 阶段6 profile 文件名改造 + ✅ 阶段7 硬编码字符串遗漏修复  
**待办**: 🔴 内网部署前必须修改反馈链接 | 🟡 Phase 3 配置目录迁移（待实施）  
**最后更新**: 2026-05-14
