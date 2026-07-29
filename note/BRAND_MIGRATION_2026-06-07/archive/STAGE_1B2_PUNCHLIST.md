# D7 Stage 1b-2 补漏清单（非-join `.claude` 硬编码）

**来源**：独立评审报告（temp/REVIEW_REPORT_2026-06-09.md，R1–R5/S1/S2）+ 主线核实后**全量复扫**（发现评审遗漏的安全项与 Phase 0 grep 盲点）。
**性质**：Stage 1b 只改了 `join(base, '.claude', …)` 构造点；本清单是**其余形态的 `.claude` 硬编码**——`endsWith`/`includes`/`===`/数组字面量/pattern 常量/相对 `join('.claude',…)`/双引号 `".claude"`/prompt 串/显示串。
**时机**：仅在 `.ywcoder/` 生效时咬人（全新项目 / 内网 `MIGRATE_PROJECT_CONFIG` ON 构建）。dev（flag OFF）不受影响。**🔴 P0 安全项必须在内网 `.ywcoder` 构建上线前修齐。**
**修法总则**：
- 安全/匹配/路径类 → **认两边**（`.claude` 与 `.ywcoder` 都算配置目录；多认无害，flag OFF 时也只有 `.claude` 存在）。可复用 `getProjectConfigDirVariants` / 新增 `.ywcoder` 分支。
- prompt/显示类 → 按 active-dir 显示真实路径，或措辞认两边（"`.ywcoder/`（或旧 `.claude/`）"）。
- 注释 → 认两边描述，低优先。
- ⚠️ 与 flag 的关系：安全"认两边"可 flag-无关恒做；写/迁移目标仍受 `MIGRATE_PROJECT_CONFIG` 门控。

---

## ⚠️ Phase 0 grep 盲点（下一轮必须重扫，别只信本清单）
Phase 0 用的 `join\([^,]+, *'\.claude'` 漏了三类，导致以下"本该 Phase 0 收敛"的 join 站点至今没走 getter：
- **相对 `join('.claude', …)`**（`.claude` 是首参，无 base）：`settings.ts:303,305`、`cronTasks.ts:75`、`cronTasksLock.ts:23`
- **双引号 `".claude"`**：`Doctor.tsx:171`
- 重扫命令建议：`grep -rnE "\.claude" src/ | grep -v test`，逐条人工分类（别再用窄正则）。

---

## 🔴 P0 — 安全 / 核心配置（必修，认两边）

| # | 文件:行 | 内容 | 风险 |
|---|---|---|---|
| P0-1 | **settings.ts:303,305** | `getRelativeSettingsFilePathForSource` 返回 `join('.claude','settings.json'/'settings.local.json')` | **核心 settings 路径完全没走 getter**——`.ywcoder` 模式下 settings 仍读写 `.claude/`，去标识失效 + 与其余子系统不一致。**最重要一条。** |
| P0-2 | **sandbox-adapter.ts:243,244,252,254** | 沙箱 `denyWrite` 只 push `.claude/settings.json`/`.local.json`/`.claude/skills` | **沙箱安全**：`.ywcoder/settings.json`、`.ywcoder/skills` 不被 OS 级沙箱保护，可被写入绕过 |
| P0-3 | filesystem.ts:82 | `DANGEROUS_DIRECTORIES` 数组缺 `.ywcoder`（R1） | 危险目录自动编辑保护漏认 `.ywcoder/` |
| P0-4 | filesystem.ts:227,228 | `isClaudeSettingsPath` endsWith `.claude/settings.json`/`.local.json`（R2） | `.ywcoder/settings.json` 不被识别为受保护配置 |
| P0-5 | filesystem.ts:477 | `if (dir === '.claude')` worktree 豁免段判断 | 需兼顾 `.ywcoder`（注意 worktrees 天窗仍在 `.claude`，逻辑要想清） |
| P0-6 | FileEditTool/constants.ts:5（→ filesystem.ts:1302 用） | `CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'`（R3） | "允许 YwCoder 编辑自身配置（本会话）"的 session-allow 规则对 `.ywcoder/` 不生效 |
| P0-7 | claudemd.ts:1496 | `isMemoryFilePath` includes `.claude/rules/`（R4） | `.ywcoder/rules/*.md` 不被识别为记忆文件，diff/collapse 异常 |
| P0-8 | cronTasks.ts:75 + cronTasksLock.ts:23 | `CRON_FILE_REL`/`LOCK_FILE_REL = join('.claude','scheduled_tasks.*')` | scheduled tasks 文件/锁仍落 `.claude/`；且与 cronTasks.ts mkdir（已走 getter→`.ywcoder`）**自相矛盾** |
| P0-9 | Doctor.tsx:171 | `join(getOriginalCwd(), ".claude", "agents")`（双引号，Phase 0 漏） | doctor 扫错目录 |
| P0-10 | components/agents/types.ts:5 | `FOLDER_NAME: '.claude'` | agents 目录名常量，多处依赖 |
| P0-11 | ide.ts:477,502 | `.claude/ide` 路径（IDE 集成） | 验证 IDE 集成是否活跃；活跃则认两边 |

> 评审只列了 P0-3/4/6/7（R1–R4）+ R3；**P0-1/2/5/8/9/10/11 是复扫新增，含最关键的 settings.ts 与沙箱**。

## 🟡 P1 — prompt（发 LLM，影响 agent 行为）/ 显示串

| # | 文件:行 | 内容 |
|---|---|---|
| P1-1 | init.ts:46,54,169,171,207 | prompt 指引 agent 扫 `.claude/rules/`、`.claude/skills/`、在 `.claude/skills/<n>/SKILL.md` 建技能（S1） |
| P1-2 | TeamCreateTool/prompt.ts:20,34,77,90,95 + TeamDeleteTool/prompt.ts:8,9 | `.claude/agents/`、`~/.claude/teams/`、`~/.claude/tasks/`（验证 team 功能是否活跃） |
| P1-3 | ScheduleCronTool/prompt.ts:70,78,84,126,133 + CronCreateTool.ts:39,145 | tool 描述里 `.claude/scheduled_tasks.json`（与 P0-8 配套） |
| P1-4 | statuslineSetup.ts:114,116,124 | prompt 指引改 `~/.claude/statusline-command.sh`、`~/.claude/settings.json`（HOME 级，见下） |
| P1-5 | agentMemory.ts:130 | 显示串 `'Project (.claude/agent-memory/)'`，与实际 `.ywcoder/` 落盘不一致（S2） |
| P1-6 | REPL.tsx:1658 | 用户可见提示 `.claude/settings.json`（worktree sparsePaths 建议） |
| P1-7 | insights.ts:1402,1406 | `.claude/skills/...`、`.claude/settings.json`（insights 已禁用，低优先） |
| P1-8 | keybindings.ts:234 | `~/.claude/keybindings.json`（HOME 级） |

## 🟢 P2 — 注释（不进 bundle，维护者易混淆，统一认两边描述）
claudemd.ts（约 15 处 JSDoc，S3）、memoryFileDetection.ts:129,274（O1）、filesystem.ts:472-477/1587/1606（O2，部分是 worktree 天窗注释可留）、main.tsx 多处、BashTool/PowerShell pathValidation、bootstrap/state.ts、markdownConfigLoader、managedEnv、setup.ts、cronTasks.ts:1、agentMemory.ts JSDoc 等。

## ⚪ 不碰（护栏 / 天窗 / 故意）
- `EnterWorktreeTool/prompt.ts:21`、filesystem `.claude/worktrees` 逻辑 —— worktrees 天窗本就留 `.claude`。
- 符号/生态：main.tsx:667 `com.anthropic.claude-code-url-handler`、main.tsx:2417-2419 `claudeai.*`、ide.ts:894/944 `anthropic.claude-code`(VSCode 扩展 ID)、`claudePath`/`claudeChars`/`claude_helpfulness`/`claudeInChromeDefaultEnabled` 等标识符。
- envUtils.ts:63 —— YwCoder 提示串「正在使用历史配置目录 ~/.claude」是**故意**的，留。

## 📌 HOME 级 `~/.claude`（归 Stage 3 一起，别混进项目级）
Team/statusline/keybindings prompt + `statusline.tsx:12` `Edit(~/.claude/settings.json)` allowedTools + completionCache.ts:27 等引用 `~/.claude/...`。HOME 配置已迁 `~/.ywcoder`（getYwCoderConfigHomeDir），这些 HOME 引用是否与实际落盘一致**需在 Stage 3（`~/.claude.json` + HOME 级）一并核对**，不在项目级 Stage 1b-2 范围。

---

## 建议执行顺序（下一轮，flag 门控前提下）
1. 先 **Stage 1c**（helper 加 `MIGRATE_PROJECT_CONFIG` 门控）——已在 DECISIONS.md D7「执行分段」。
2. **Stage 1b-2 本清单**：先 🔴 P0（尤其 P0-1 settings.ts、P0-2 沙箱），认两边 + 补单测；再 🟡 P1 prompt/显示；🟢 P2 注释顺手。**重扫一遍**别漏（见 grep 盲点）。
3. 再 **Stage 2 迁移** / Stage 3 HOME / Stage 4 重测。
4. 每步 `bun run build && bun test --max-concurrency=1` 绿（基线 576，clean env）。
