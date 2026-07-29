# feature/brand-replacement 端到端复核报告

**复核日期**: 2026-06-09
**复核分支**: `feature/brand-replacement` 相对 `main`
**复核人**: 独立评审者（非作者）
**基线**: `bun run build` 成功；`bun test --max-concurrency=1` 573 pass / 3 fail

---

## 一、基线状态

| 项 | 结果 |
|---|---|
| `bun run build` | 成功（`dist/cli.mjs`） |
| `bun test --max-concurrency=1` | **573 pass / 3 fail**（期望 576/0） |
| dist 扫 `Claude Code`/`OpenClaude` | 无残留（tree-shaking + D5 禁用已清掉禁用功能字符串） |
| dist 扫 `Claude` 功能性保留 | 742 处均为模型名、`claude.ai` 门控功能符号、禁用功能残留、事件名等，在护栏清单内 |

---

## 二、必修（安全/回归/基线）

### R1. `DANGEROUS_DIRECTORIES` 未同步 `.ywcoder`

- **文件**: `src/utils/permissions/filesystem.ts:78-83`
- **证据**: `export const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea', '.claude'] as const`，**缺少 `.ywcoder`**。
- **理由**: D7 后新项目配置落在 `.ywcoder/`，但该目录下的 `settings.json`、`hooks/`、`commands/` 等敏感路径不会被 `isDangerousFilePathToAutoEdit` 识别为危险目录，**可能绕过安全限制**。

### R2. `isClaudeSettingsPath` 只认 `.claude/`

- **文件**: `src/utils/permissions/filesystem.ts:216-238`
- **证据**: 第 226-229 行只 `endsWith(`${sep}.claude${sep}settings.json`)`，**没有 `.ywcoder/settings.json` 分支**。
- **理由**: 新项目（`.ywcoder/` 存在）的 `settings.json` 不会被识别为需要保护的配置路径，文件编辑安全提示会漏掉它。

### R3. `CLAUDE_FOLDER_PERMISSION_PATTERN` 只覆盖 `/.claude/**`

- **文件**: `src/tools/FileEditTool/constants.ts:5` -> 被 `filesystem.ts:1302` 使用
- **证据**: `export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'`
- **理由**: 用户点击"允许 YwCoder 编辑自身配置（本次会话）"时，系统会生成 `/.claude/**` 的 session allow 规则。若项目已迁 `.ywcoder/`，该规则 scope check 不会认可 `/.ywcoder/**`，导致**权限弹窗的快捷允许选项不工作**。

### R4. `isMemoryFilePath` 漏认 `.ywcoder/rules/`

- **文件**: `src/utils/claudemd.ts:1493-1497`
- **证据**: 第 1496 行 `filePath.includes(`${sep}.claude${sep}rules${sep}`)`，**没有 `.ywcoder/rules/` 分支**。
- **理由**: `getAllMemoryFilePaths` 依赖此函数识别 readFileState 缓存中的记忆文件。用户通过 Read 读取 `.ywcoder/rules/*.md` 后，这些路径不会被识别为记忆文件，**diff/collapse 等后续逻辑可能表现异常**。

### R5. `claudeMdExcludes` 设置示例只写 `.claude/rules/`

- **文件**: `src/utils/settings/types.ts:1081`
- **证据**: 示例字符串 `Examples: ... "**/some-dir/.claude/rules/**"`
- **理由**: 用户按示例写 exclude glob 时，`.ywcoder/rules/` 下的文件不会被排除，导致**排除规则对新项目失效**。

### R6. 测试基线 3 个失败（fastMode）

- **文件**: `src/utils/fastMode.test.ts:138-172`
- **证据**:
  ```
  Expected: "Fast mode has been disabled by your organization"
  Received: "Fast mode is not available on third-party providers"
  ```
- **根因**: 当前 shell 环境预存了 `CLAUDE_CODE_USE_OPENAI=1`，导致 `getAPIProvider()` 返回非 `firstParty`，测试未 mock 该依赖。**不是品牌改动直接引起**，但基线不达标。建议在测试里补 mock `getAPIProvider`，或确认 main 分支同环境是否也失败。

---

## 三、建议（语义/用户体验）

### S1. `init.ts` prompt 仍指引 agent 找 `.claude/` 路径

- **文件**: `src/commands/init.ts:46,54,133,150,169,171`
- **证据**:
  - 第 46 行：`existing YWCODER.md, .claude/rules/, AGENTS.md...`
  - 第 54 行：`Existing .claude/skills/ and .claude/rules/ directories`
  - 第 133 行：`suggest organizing instructions into \`.claude/rules/\``
  - 第 150 行：`~/.claude/<project-name>-instructions.md`
  - 第 169、171 行：`If \`.claude/skills/\` already exists... Create each skill at \`.claude/skills/<skill-name>/SKILL.md\``
- **理由**: 这些 prompt 文本**进 bundle 并发给 LLM**。新项目实际目录是 `.ywcoder/`，agent 按 prompt 只会扫描 `.claude/rules/` 和 `.claude/skills/`，**可能漏掉已存在的 `.ywcoder/` 配置**，并错误地建议用户在旧路径下创建文件。同时 `~/.claude/...` 与已迁移的 `~/.ywcoder` HOME 目录不一致。

### S2. `agentMemory.ts` 显示字符串仍写 `.claude/`

- **文件**: `src/tools/AgentTool/agentMemory.ts:130`
- **证据**: `return 'Project (.claude/agent-memory/)'`
- **理由**: 用户可见的 scope 显示，实际路径现在可能是 `.ywcoder/agent-memory/`（`getAgentMemoryDir` 用 `getProjectConfigDir` 读择优）。显示与落盘不一致。

### S3. `claudemd.ts` 大量 JSDoc/注释仍写 `.claude/rules/`

- **文件**: `src/utils/claudemd.ts:6,16,720,845,868,894 等`
- **证据**: 约 15 处注释描述仍写 `.claude/rules/*.md`。
- **理由**: 注释不进 bundle，但维护者阅读代码时会与实际 `.ywcoder/rules/` 路径产生混淆，建议统一改为认两边的描述。

---

## 四、可选

### O1. `memoryFileDetection.ts` 注释中 `.claude/rules/` 残留

- **文件**: `src/utils/memoryFileDetection.ts:129,274`
- **理由**: 纯注释，不进 bundle。

### O2. `filesystem.ts` 注释中 `.claude/` 残留

- **文件**: `src/utils/permissions/filesystem.ts:472-475,1587,1606`
- **理由**: 注释描述的是 `.claude/worktrees/` 特殊豁免逻辑，与 `.ywcoder` 新增无关，可保留。

---

## 五、D7 核心逻辑审查结论

| 文件 | 审查结论 |
|---|---|
| `src/utils/projectConfigDir.ts` | **逻辑正确**。`getProjectConfigWriteDir` 强制 `.ywcoder/`；`getProjectConfigDir` 读择优（`.ywcoder` > `.claude` > 默认 `.ywcoder`）；`getProjectConfigDirVariants` 供权限认两边。 |
| `src/utils/permissions/filesystem.ts` | `getClaudeSkillScope` 认两边正确（`.ywcoder/skills/` + `.claude/skills/` + 全局），但 `DANGEROUS_DIRECTORIES` / `isClaudeSettingsPath` / `CLAUDE_FOLDER_PERMISSION_PATTERN` 相关调用未同步 `.ywcoder`，存在安全漏认（R1-R3）。 |
| `src/tools/AgentTool/agentMemory.ts` | `isAgentMemoryPath` 认两边正确（`getProjectConfigDirVariants`），但 `getMemoryScopeDisplay` 显示串未更新（S2）。 |
| `src/main.tsx` 在线更新禁用 | 正确。`update` 改打印中性提示 + 移除动态 import，tree-shake 清掉了 `update.ts`。 |
| `src/utils/config.ts` autoUpdater | 正确。`getAutoUpdaterDisabledReason()` 默认返回 `{type:'ywcoder'}`，各 updater 早退。 |

---

## 六、总结

- **必须修复 6 项**，其中 **R1-R3 是安全/权限敏感**（`.ywcoder/` 路径未被危险目录/配置保护/权限规则认可），**R4 是功能回归**（`.ywcoder/rules/` 记忆文件漏识别），**R5 是配置体验**，**R6 是基线**。
- **无语义误改**（把 Anthropic 外部产品/provider 误改成 YwCoder 的情况未发现）。
- **无护栏误伤**（模型名、`ANTHROPIC_*`、`.claude-plugin/`、`claude-*` 符号、provider 描述等保留完好）。
- **D7 Stage 1b 的 35 站点切换整体正确**，但权限/匹配场景的配套常量和判据有遗漏，需补齐。
