# kimi模型 Agent 执行说明 · 批次 1 剩余低风险文案

**任务**: 把剩余 159 处 `Claude Code` / `OpenClaude` / `Open Claude` 纯文案/注释替换为 YwCoder。
**worklist**: `note/BRAND_MIGRATION_2026-06-07/agent_worklist.txt`（`文件:行号:内容`，100 个文件，多数每文件 1–2 处）。
**前置**: 已有 38 个文件被人工改过（高频可见面），本任务只做长尾。**只改文案/注释，禁止改逻辑。**

---

## 一、替换规则（逐字，大小写敏感）

| 原文                                         | 替换为    |
| -------------------------------------------- | --------- |
| `Claude Code`                                | `YwCoder` |
| `OpenClaude`                                 | `YwCoder` |
| `Open Claude`                                | `YwCoder` |
| `openclaude`（小写，命令/标识，非 URL/包名） | `ywcoder` |

替换后保持原句通顺（如 `Claude Code's` → `YwCoder's`，`Claude Code session` → `YwCoder session`）。

---

## 二、🚫 硬性护栏：一行命中以下任意 token，**整行跳过，不要改**

这些是功能性/生态依赖，改了会破坏运行：

```
@anthropic-ai        claude-3 / claude-sonnet / claude-opus / claude-haiku / claude-<任意版本号>
ANTHROPIC_<大写>     .claude/  ~/.claude   .claude.json
claude-plugins       claude-code-action   claude-code-jetbrains
claudeCodeFirst...   claude-code-hint     CLAUDECODE           claudeai-proxy
CLAUDE_CODE_<大写>   anthropics/          claude.ai            code.claude.com
```

> 规则：worklist 里如果某行同时含 `Claude Code` 和上面任一 token，**跳过该行**（worklist 已预过滤大部分，但你仍要逐行复核）。

### 二之补：`CLAUDE.md` / `CLAUDE.local.md`（D4-b 已决定迁移，不再整行跳过）
- **改**：注释、系统提示、UI 文本里的 `CLAUDE.md` → `YWCODER.md`，`CLAUDE.local.md` → `YWCODER.local.md`。
- **不改（保留为兼容旧文件的 fallback 名）**：仅限 `src/utils/claudemd.ts` 与 `src/utils/config.ts` 两文件内的 `CLAUDE.md`/`CLAUDE.local.md` 字面量——那是读取回退逻辑，动了会破坏兼容。
- `.claude/` 目录路径、`CLAUDE_CODE_*` 环境变量**仍按上表跳过**（与文件名无关）。

---

## 三、🟡 需判断：命中是"外部 Anthropic 产品/功能名"时跳过并记录

如果 `Claude Code` 在句中指的是**别的东西**而非"本 CLI 工具"，不要替换，记到 `note/.../HUMAN_REVIEW_NEEDED.md`：

- 指 **Anthropic 桌面/网页/订阅/账号**：句中含 `Desktop`、`web`、`subscription`、`account`、`OAuth`、`login`、`Console`、`upsell` → 跳过
- 指 **上游官方 Claude Code**（如"下载上游 Claude Code 二进制""migrate from Claude Code"）→ 跳过
- 文件路径含 `DesktopUpsell` / `bridge/` / `constants/oauth.ts` / `constants/product.ts` → 先跳过，交人工

判断口诀：**"这里的 Claude Code 能不能换成『本工具』而句子依然正确？" 能 → 换 YwCoder；不能 → 跳过记录。**

---

## 四、典型该改的例子（来自 worklist）

- `src/utils/settings/types.ts`: `.describe('... when Claude Code needs access')` → `... when YwCoder needs access`（配置 schema 描述，用户可见）
- `src/utils/permissions/filesystem.ts`: `// Always ask when Claude Code tries to edit its own config files` → `// ... when YwCoder tries ...`（注释）
- `src/entrypoints/cli.tsx`: `// OpenClaude: polyfill globalThis.File for Node < 20.` → `// YwCoder: polyfill ...`（注释）
- `src/services/tips/tipRegistry.ts` / `lsp/manager.ts` / `terminalPanel.ts` 等：注释与提示文案

---

## 五、收尾验证（必须全绿）

```bash
bun run build          # 期望: ✓ Built ywcoder ...
bun run smoke          # 期望: x.y.z (YwCoder, ...)
bun test --max-concurrency=1   # 期望: 0 fail（基线 562 pass）
```

再跑回归守卫确认无遗漏（应只剩护栏/决策项）：

```bash
grep -rnE 'Claude Code|OpenClaude|Open Claude' src --include='*.ts' --include='*.tsx' \
  | grep -viE '@anthropic-ai|claude-[0-9a-z]|ANTHROPIC_|CLAUDE\.md|claude-plugins|claude-code-action|CLAUDECODE|claudeai-proxy|\.claude[/".]'
```

**任何一步红 → 回滚最近一次编辑，不要硬改测试。**
