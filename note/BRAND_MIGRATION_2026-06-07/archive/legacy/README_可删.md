# YwCoder 品牌改造总结

**整理日期**: 2026-06-07  
**原项目**: OpenClaude / Claude Code  
**新品牌**: YwCoder  
**包名**: `@dcywzc/ywcoder`

---

## 一、改造总览

本次品牌替换历经多个阶段，核心目标是将 `OpenClaude/Claude Code` 全面替换为 `YwCoder`，并确保 `ywcoder` 命令成为唯一用户入口。共修改 250+ 文件，核心功能测试全部通过。

| 阶段 | 内容 | 文件数 | 状态 |
|------|------|--------|------|
| 阶段1 | 内部品牌标识替换 | 142+ | 完成 |
| 阶段2 | 环境变量 Fallback 机制 | 250+ | 完成 |
| 阶段3 | 配置目录迁移优化 | 新增模块 | 完成 |
| 阶段4 | npm 包名与版本更新 | package.json | 完成 |
| 阶段5 | UI 层二次扫描修复 | 8+ | 完成 |
| 阶段6 | 项目本地 Profile 文件名改造 | 14 | 完成 |
| 阶段7 | 硬编码字符串遗漏修复 | 6 | 完成 |

---

## 二、核心改造内容

### 1. 内部品牌标识替换

- **UI 显示文本**: `Claude Code` / `OpenClaude` → `YwCoder`
- **函数/变量名**:
  - `getClaudeConfigHomeDir()` → `getYwCoderConfigHomeDir()`
  - `getClaudeCodeMcpConfigs()` → `getYwCoderMcpConfigs()`
  - `getClaudeCodeUserAgent()` → `getYwCoderUserAgent()`
- **常量名**: `CLAUDE_IN_CHROME_MCP_SERVER_NAME` 等 → `YWCODER_IN_CHROME_*`

**明确保留项**（功能/生态依赖）:
- `CLAUDE.md` 文件名
- `ANTHROPIC_*` API 密钥变量
- `@anthropic-ai/sdk` SDK 导入
- `claude-*` 模型名称
- GitHub 上 `anthropics/claude-code` 链接
- OTel 指标名 `claude_code.*`

### 2. 环境变量 Fallback 机制

新增 46+ 个 `YWCODER_*` 变量，优先读取，同时兼容旧 `CLAUDE_CODE_*` 变量：

```bash
# Provider 切换
YWCODER_USE_OPENAI=1    # 替代 CLAUDE_CODE_USE_OPENAI
YWCODER_USE_GEMINI=1    # 替代 CLAUDE_CODE_USE_GEMINI
YWCODER_USE_GITHUB=1    # 替代 CLAUDE_CODE_USE_GITHUB

# 配置
YWCODER_CONFIG_DIR      # 替代 CLAUDE_CONFIG_DIR
YWCODER_SIMPLE=1        # 替代 CLAUDE_CODE_SIMPLE
YWCODER_OAUTH_TOKEN     # 替代 CLAUDE_CODE_OAUTH_TOKEN
# ...
```

读取优先级: `YWCODER_*` > `CLAUDE_CODE_*` > `undefined`

第三方服务变量（`ANTHROPIC_*`、`OPENAI_*`、`GEMINI_*`、`GITHUB_TOKEN` 等）保持不变，确保与服务商文档一致。

### 3. 配置目录迁移

最终方案：

```
优先级: YWCODER_CONFIG_DIR > CLAUDE_CONFIG_DIR > ~/.ywcoder(存在) > ~/.claude(存在) > ~/.ywcoder(默认)
```

- 新用户默认使用 `~/.ywcoder`
- 已存在 `~/.claude` 的用户静默 fallback，启动时 TTY 提示迁移
- 提供 `ywcoder --migrate-config` 命令复制配置

### 4. npm 包信息

```json
{
  "name": "@dcywzc/ywcoder",        // 从 @gitlawb/openclaude
  "version": "1.0.0",               // 从 0.1.8
  "description": "YwCoder - AI coding agent CLI...",
  "bin": {
    "ywcoder": "./bin/ywcoder"      // 仅保留 ywcoder，删除 claude
  }
}
```

`bin/claude` 已删除，避免与官方 Claude Code 产生全局命令冲突。

---

## 三、UI 层遗漏修复

### Sprint 1 — P0 高优先级

| 文件 | 修改内容 |
|------|---------|
| `src/utils/completionCache.ts` | Shell 补全文本（写入 `.bashrc`/`.zshrc`） |
| `src/screens/REPL.tsx` | Ctrl+Z 挂起/恢复提示 |
| `src/setup.ts` | Node.js 版本不足错误 |
| `src/utils/windowsPaths.ts` | Windows 路径错误 |
| `src/commands/model/index.ts` | 命令描述 |
| `src/tools/ConfigTool/prompt.ts` | 工具描述 |
| `src/coordinator/coordinatorMode.ts` | Coordinator 系统 Prompt |
| `src/utils/messages.ts` | 权限拒绝提示 |
| `src/services/api/errors.ts` | 速率限制 `claude.ai` 链接移除 |

### 禁用 Anthropic 专有功能组件

| 文件 | 修改 |
|------|------|
| `src/services/tips/tipRegistry.ts` | 4 条 Tips `isRelevant: () => false`（desktop-app、desktop-shortcut、web-app、mobile-app） |
| `src/commands/stickers/index.ts` | `/stickers` 命令 `isEnabled: () => false` |

### Sprint 2 — 文档链接

因内网暂无文档站点，约 20+ 处 `code.claude.com` 链接统一移除或替换为通用提示文本：
- `src/components/TrustDialog/TrustDialog.tsx`
- `src/utils/settings/validationTips.ts`
- `src/components/mcp/MCPListPanel.tsx`、`MCPSettings.tsx`
- `src/commands/model/model.tsx`、`chrome/chrome.tsx`、`fast/fast.tsx`、`memory/memory.tsx`
- `src/keybindings/template.ts`、`src/components/sandbox/SandboxSettings.tsx`

### Sprint 3 — P1 低频场景

- `src/tools/BashTool/pathValidation.ts`：路径安全校验权限请求文本
- `src/commands/insights.ts`：`/insights` 命令 LLM 分析 prompt
- `src/cli/handlers/autoMode.ts`：auto mode reviewer 系统 prompt
- Bridge / Teleport 错误消息（因依赖 Anthropic 云服务且内网不可用，未处理）
- `ultraplan.tsx`、`thinkback.tsx`、deepLink Bundle ID（经评估无需修改）

---

## 四、完整执行记录

### 阶段1：文档品牌替换（5 文件）
- README.md、docs/quick-start-*.md、.github/ISSUE_TEMPLATE/*.md
- `npm install -g @gitlawb/openclaude` → `npm install -g @dcywzc/ywcoder`

### 阶段2：关键 UI 文本替换（6 文件）
- `gracefulShutdown.ts`: `openclaude --resume` → `ywcoder --resume`
- `provider.tsx`: Provider 提示
- `Feedback.tsx`: GitHub 链接

### 阶段3：VS Code 扩展最小修改（1 文件）
- `vscode-extension/openclaude-vscode/package.json` 默认值改为 `ywcoder`

### 阶段4：附加 UI 文本替换（3 文件）
- `WebSearchTool.ts`: `OpenClaude web search tool` → `YwCoder web search tool`
- `attribution.ts`: `Generated with [OpenClaude]` → `Generated with [YwCoder]`，`openclaude.dev` → `ywcoder.dev`

### 阶段5：Scripts 构建输出修复（5 文件）
- `scripts/build.ts`: `Built openclaude v...` → `Built ywcoder v...`
- `scripts/provider-recommend.ts`、`start-grpc.ts`、`render-coverage-heatmap.ts`

### 阶段6：项目本地 Profile 文件名改造（14 文件，2026-04-23）
- `.openclaude-profile.json` → `.ywcoder-profile.json`
- 保留旧文件 fallback 读取逻辑
- 涉及 `providerProfile.ts`、VS Code 扩展、测试、文档、`.gitignore`

### 阶段7：硬编码字符串遗漏修复（2026-05-14）
修复 6 处 `"Open Claude"` 硬编码：
- `src/screens/REPL.tsx`: 终端窗口标题 → `'ywcoder'`
- `src/services/mcp/client.ts`: MCP 客户端 title/name/description
- `src/utils/logoV2Utils.ts`: 欢迎消息 → `'Welcome to YwCoder'`
- `src/components/LogoV2/feedConfigs.tsx`: 分享提示
- `src/commands/buddy/index.ts`: 命令描述

---

## 五、测试验证

| 指标 | 数值 |
|------|------|
| 测试总数 | 463 |
| 通过 | 455 (98.3%) |
| 失败 | 8（基线 mock 污染问题，与品牌替换无关） |
| 构建 | 通过 |
| 冒烟测试 | 通过 |

**分项结果**:
- Provider 可用性: 38/38 ✅
- 环境变量 Fallback: 100% ✅
- 命令行工具: 8/8 ✅
- MCP/Skills: 39/39 ✅

---

## 六、后续待办

| 优先级 | 事项 | 位置 | 说明 |
|--------|------|------|------|
| 🔴 高 | 反馈系统链接改为内网地址 | `src/components/Feedback.tsx:36` | 当前指向公网 GitHub issues，内网用户无法访问 |
| 🟡 中 | `code.claude.com` 文档链接替换 | 约 20+ 处 | 等待内网文档站点建立后统一替换 |

---

## 七、原始文档

本目录包含三份原始改造文档：

- `BRAND1_MIGRATION_SUMMARY.md` — 阶段1-7 总体改造总结
- `BRAND2_AUDIT_AND_FIXPLAN.md` — 全量扫描审查报告与修复计划
- `BRAND3_MIGRATION_EXECUTION_LOG.md` — 完整执行记录与测试结果

---

**最后更新**: 2026-06-07
