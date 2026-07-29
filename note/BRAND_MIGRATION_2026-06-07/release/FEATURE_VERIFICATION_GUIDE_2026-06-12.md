# Feature 验证指引（内网逐项验证用）

> 日期：2026-06-12 · 版本：v1.2.0
> 用途：本次构建启用的用户可感知 feature 的「操作→预期」验证清单，内网逐项打勾。
> 状态图例：✅ 已验证通过 · 🔄 内测中（待验）

---

## 已验证通过 ✅

### 1. 终端内粘贴图片（`NATIVE_CLIPBOARD_IMAGE`）✅
- **操作**：先截图到系统剪贴板，在 YwCoder 输入框按 `Cmd+V`（mac）/ `Ctrl+V`（win/linux）
- **预期**：输入框出现图片占位符或上传提示；发送后模型能识别并描述图片内容
- **收益**：直接粘贴截图到对话，无需先存成文件

### 2. 上下文压缩提示（`COMPACTION_REMINDERS`）✅
- **操作**：持续长对话，直到上下文接近压缩阈值
- **预期**：屏幕底部出现"正在压缩上下文以节省 token…"等提示文案
- **收益**：明确知道正在压缩，避免对"丢上下文"感到困惑

---

## 内测中 🔄（待验证）

### 3. MCP 富文本输出（`MCP_RICH_OUTPUT`）🔄
- **操作**：配置并调用任意 MCP 工具（如文件读取、代码搜索）
- **预期**：工具返回结果带格式高亮、表格、折叠块等富文本样式，而非纯文本
- **收益**：MCP 结果更易读，代码块带语法高亮

### 4. 内置 Explore / Plan 子代理（`BUILTIN_EXPLORE_PLAN_AGENTS`）🔄
- **操作**：让模型派生子代理（Task / Agent 工具），或查看可用 agent 类型列表
- **预期**：除 `general-purpose` 外，出现 **Explore**（只读搜索代理）与 **Plan**（架构规划代理）两个内置 agent 可被调用
- **收益**：复杂检索/规划任务可路由到专用只读代理

### 5. 快速打开 / 全局搜索（`QUICK_SEARCH`）🔄
- **操作**：
  - Quick Open：`Ctrl+Shift+P`（win/linux）/ `Cmd+Shift+P`（mac）
  - Global Search：`Ctrl+Shift+F`（win/linux）/ `Cmd+Shift+F`（mac）
- **预期**：分别弹出「快速打开」面板 / 「全局搜索」面板
- **收益**：快速跳转、跨内容检索
- **注**：键位可在 `/keybindings` 查看或自定义

### 6. 历史命令选择器（`HISTORY_PICKER`）🔄
- **操作**：在输入框按 `Ctrl+R`
- **预期**：弹出历史命令选择器，可输入关键字过滤、`Ctrl+R` 继续向前、`Tab`/`Esc` 接受、`Enter` 执行
- **收益**：快速复用历史输入（类似 shell 的反向搜索）

### 7. PowerShell 自动模式引导（`POWERSHELL_AUTO_MODE`）🔄 *Windows 专项*
- **操作**：Windows 环境 + 开启自动模式（auto mode），让模型执行 PowerShell 命令，包含一条危险命令（如递归删除 `Remove-Item -Recurse`）
- **预期**：自动模式的权限分类对危险 PowerShell 命令给出拦截/需确认引导，安全命令正常放行
- **收益**：Windows 自动模式下对 PowerShell 命令的安全判断更准确
- **注**：此为权限分类系统提示层的增强，验证偏技术向，需在自动模式下观察危险命令的处置

### 8. Hook 交互式 prompt（`HOOK_PROMPTS`）🔄
- **操作**：配置一个会向用户请求输入的 hook（prompt 类型），触发它
- **预期**：hook 执行过程中弹出交互式输入框，用户响应后流程继续
- **收益**：hook 可在执行中与用户交互、按需收集输入
- **注**：需先在 settings 配置对应 hook，验证偏技术向

---

## 验证进度跟踪

| # | Feature | 状态 |
|---|---------|------|
| 1 | NATIVE_CLIPBOARD_IMAGE | ✅ 已验证通过 |
| 2 | COMPACTION_REMINDERS | ✅ 已验证通过 |
| 3 | MCP_RICH_OUTPUT | 🔄 内测中 |
| 4 | BUILTIN_EXPLORE_PLAN_AGENTS | 🔄 内测中 |
| 5 | QUICK_SEARCH | 🔄 内测中 |
| 6 | HISTORY_PICKER | 🔄 内测中 |
| 7 | POWERSHELL_AUTO_MODE（Windows）| 🔄 内测中 |
| 8 | HOOK_PROMPTS | 🔄 内测中 |

> 验证通过后把对应行改为 ✅，并同步发布说明 §2.5。
> 注：`AUTO_THEME` 因源文件 `systemThemeWatcher.js` 缺失，当前关闭、不在验证范围。
