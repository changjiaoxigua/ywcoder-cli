# 品牌去标识工程评审报告

**分支**：`feature/brand-replacement`
**日期**：2026-06-12
**评审范围**：D7 路径逻辑、双场景安全性、文案替换、测试覆盖
**验收基线**：`bun test --max-concurrency=1` = **599 pass ✅**

---

## 1. D7 路径逻辑正确性

**无发现（逻辑正确）**

- `resolveProjectConfigDir` ON/OFF 两条路径：OFF 恒 `.claude`，ON 存在性三择（`.ywcoder` → `.claude` → 默认 `.ywcoder`），边界清晰。
- 迁移模块 copy-keep 策略：
  - worktrees 过滤：`rel !== WORKTREES_SKYLIGHT && !rel.startsWith(WORKTREES_SKYLIGHT + sep)` 覆盖目录本身和子树，`worktrees-extra` 等同前缀但不同名的目录不会被误过滤 ✓
  - 幂等：`.ywcoder/` 存在即跳 ✓；`.gitignore` 追加前做 `existing` Set 查重 ✓；护栏（`.claude-plugin`）和天窗（`worktrees`）均跳过 ✓
- `getSettingsFilePathForSource('projectSettings')`：走 `getRelativeSettingsFilePathForSource` → `basename(getProjectConfigDir(getOriginalCwd()))` + `settings.json`，flag OFF 恒 `.claude/settings.json`，ON 时随 active-dir 切换 ✓
- Stage 3a `getGlobalClaudeFile` 三分支：新目录 `.config.json` → 存量 `~/.claude.json` → 新装默认 `.config.json`，覆盖完整 ✓

### ⚪ 可选：过期注释

`src/utils/projectConfigMigration.ts:21` 写着：

> "Stage 2 仅落本模块 + 单测，**尚未接进启动流程**（待 review）"

但 `src/entrypoints/cli.tsx:125-138` 已接入。注释应删除或改为"已接入 cli.tsx"。

---

## 2. 双场景安全性

**无发现（flag OFF 零泄漏）**

- `getProjectConfigWriteDir`、`getProjectConfigDir`：flag OFF 时 `resolveProjectConfigWriteDir(base, false)` 和 `resolveProjectConfigDir(base, false)` 均硬返回 `.claude`，无任何条件分支可导致 `.ywcoder` 被写入 ✓
- `getProjectConfigDirVariants`：不受 flag 影响，恒认两边——OFF 时 `.ywcoder` 目录不存在，权限/匹配系统识别它无副作用 ✓
- `MIGRATE_PROJECT_CONFIG` 在 `cli.tsx` 中用 `if (feature(...))` 包裹整个动态 import，OFF 时 DCE 连动态 import 一并消除 ✓

---

## 3. 文案替换越界 / 遗漏

### 护栏完整

`claude-*` 模型名、`ANTHROPIC_*` 环境变量（含 `ANTHROPIC_LOG`/`ANTHROPIC_BEDROCK_BASE_URL` 等）、`Anthropic native API`（dist:256372）、`claude.ai` URL、`AnthropicBedrock`/`isAnthropic*` 符号名均未误改 ✓

已正确禁用的"Claude Code"串（不计入遗漏）：

| 字符串位置 | 禁用方式 |
|-----------|---------|
| DesktopUpsell（"Try Claude Code Desktop"） | `shouldShowDesktopUpsellStartup() = false` |
| Tips（"Continue your session in Claude Code Desktop"） | `isRelevant: () => false` |
| Chrome NativeHost 路径（`Claude Code/ChromeNativeHost`） | `CHICAGO_MCP = false` |
| GitHub Actions workflow 模板 | 外部产品名护栏，不应改 |

### 活跃路径遗漏（用户可见）

#### 🟡 `src/utils/update.ts:403,418`

更新失败提示仍写 `~/.claude/local`：

```ts
`  cd ~/.claude/local && npm update ${MACRO.PACKAGE_URL}\n`
```

`getLocalInstallDir()` 已正确改为 `join(getYwCoderConfigHomeDir(), 'local')`（即 `~/.ywcoder/local`），但错误消息未跟进。用户按此执行会找不到目录。

**修法**：替换为 `\`  cd \${getLocalInstallDir()} && npm update \${MACRO.PACKAGE_URL}\\n\``（需 import `getLocalInstallDir`），或硬写 `~/.ywcoder/local`。

#### 🟡 `src/components/AutoUpdater.tsx:193`

同上 UI 版本：

```tsx
{hasLocalInstall ? `cd ~/.claude/local && npm update ${MACRO.PACKAGE_URL}` : ...}
```

**修法**：同 update.ts 方式统一。

#### 🟡 `src/utils/doctorDiagnostic.ts:473,479`

doctor 诊断建议双重错误（路径和命令名都错）：

```ts
fix: `... Update alias: alias claude="~/.claude/local/claude"`
fix: 'Create alias: alias claude="~/.claude/local/claude"'
```

`getLocalClaudePath()` 已指向 `~/.ywcoder/local/claude`，但 doctor 建议未更新。此外命令名应为 `ywcoder` 而非 `claude`（第 464 行 `which('claude')` 检测是否在 PATH 中也值得同步审查）。

这是面向用户的可操作指令，错误路径会让用户无法修复安装问题。

**修法**：

```ts
fix: `... Update alias: alias ywcoder="${getLocalClaudePath()}"`,
fix: `Create alias: alias ywcoder="${getLocalClaudePath()}"`,
```

#### 🟡 `src/utils/sessionStart.ts:105`

插件加载失败时的权限错误消息：

```ts
'This appears to be a permissions issue. Check file permissions on ~/.claude/plugins/'
```

`~/.ywcoder` 用户会去错误路径排查。

**修法**：

```ts
`This appears to be a permissions issue. Check file permissions on ${getConfigHomeDisplayPath()}/plugins/`
```

（需 import `getConfigHomeDisplayPath` from `envUtils.js`）

#### 🟡 `src/commands/install.tsx:230,235,246,257`

`claude install` 命令 UI 串未换品牌：

```
'Claude Code installation completed successfully'
'Claude Code installation failed'
'Installing Claude Code native build {state.version}...'
'Claude Code successfully installed!'
```

该命令描述（line 299）已改为中文"安装 Claude Code 原生构建版本"，内部字符串与描述不一致。该命令无 feature flag 门控，处于活跃状态。

**修法**：将 `Claude Code` 替换为 `YwCoder`。

### ⚪ 可选：schema 描述串

`src/utils/settings/types.ts:851,970`（Zod `.describe()`，仅在 JSON Schema 导出时可见）：

```ts
'If not set, defaults to ~/.claude/plans/'
'...defaults to ~/.claude/projects/<sanitized-cwd>/memory/.'
'...Ignored if set in projectSettings (checked-in .claude/settings.json) for security.'
```

---

## 4. 测试覆盖

**核心路径覆盖充分**：

| 测试文件 | 覆盖内容 |
|---------|---------|
| `src/utils/projectConfigDir.test.ts` | resolve* ON/OFF 两种路径（全新/已迁移/仅旧）、公开 getter flag OFF 验证、variants 两边 |
| `src/utils/projectConfigMigration.test.ts` | 全新项目、幂等、复制、worktrees 跳过、.gitignore 同步、降级不抛出、集成端到端（迁后 active-dir 指向 `.ywcoder` 且内容可读） |
| `src/utils/env.test.ts` | Stage 3a `getGlobalClaudeFile` 三分支 + 优先顺序（分支1 > 分支2） |

**无发现（测试通过，覆盖充分）**

⚪ `getYwCoderConfigHomeDir` 多级回退（`~/.ywcoder` / `~/.claude` / 新装）无专项单测（由 env.test.ts 通过 `CLAUDE_CONFIG_DIR` 间接覆盖）。

⚪ `getProjectConfigFolderPermissionPattern` 无专项单测（逻辑简单，直接调 `getProjectConfigDir`）。

---

## 汇总

| 优先级 | 数量 | 涉及文件 |
|--------|------|---------|
| 🔴 必修 | 0 | — |
| 🟡 建议修 | 5 | `update.ts`（×2处）、`AutoUpdater.tsx`、`doctorDiagnostic.ts`（最高优先）、`sessionStart.ts`、`install.tsx` UI 串 |
| ⚪ 可选 | 3 | `projectConfigMigration.ts` 过期注释、`settings/types.ts` schema 描述串、`envUtils` 单测补充 |

**最高优先**：`doctorDiagnostic.ts` 的 alias 建议——路径和命令名双重错误，用户按它执行会产生错误操作。其次是 `update.ts`/`AutoUpdater.tsx` 的更新路径（运行时用户可见，执行失败）。
