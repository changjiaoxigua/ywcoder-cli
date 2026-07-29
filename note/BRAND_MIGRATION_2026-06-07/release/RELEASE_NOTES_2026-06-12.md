# YwCoder 发布说明 · 品牌去标识 + D7 路径迁移

**版本**：v1.2.0（feature/brand-replacement）
**日期**：2026-06-12
**面向**：内网测试环境用户 / 部署人员

---

## 📧 邮件简版（可直接复制）

> **主题：YwCoder v1.2.0 升级通知**
>
> 各位：
>
> YwCoder v1.2.0 已发布。本次为**品牌去标识 + 配置路径迁移**，功能不变，绝大部分配置**自动兼容**。升级须知三点：
>
> 1. **配置目录**：先看家目录有无 `~/.ywcoder`——**有则无需操作**；没有才运行 `ywcoder --migrate-config`（**切勿重复运行**，已迁移用户重复跑会回退配置）。
> 2. **记忆文件**：现有 `CLAUDE.md` 照常生效，无需改名或迁移（**勿建空 `YWCODER.md`**，会屏蔽 `CLAUDE.md`）。
> 3. **环境变量脚本**：现有配置脚本**无需修改**，请勿删除 `CLAUDE_CODE_USE_OPENAI`。（⚠️ 2026-06-17 已解除此限制，见 §4 item 1：新名可独立使用）
>
> 另含 6 项代码评审修复，以及终端内体验增强（如**终端粘贴截图**、**上下文压缩提示**，已通过内网验证；详见完整发布说明）。
> 完整说明 / 升级须知见附件。

---

## 一、本次范围

将用户可见的 Claude / Anthropic / OpenClaude 文案与配置路径去标识为 **YwCoder**，**不改变功能**，并确保与官方 Claude Code 在同一台机器上**可安全共存**。

护栏（未改动）：`claude-*` 模型名、`ANTHROPIC_*` 环境变量、`claude.ai` URL、provider 描述 "Anthropic native API" 等功能性符号。

---

## 二、用户须知（重要）

### 2.1 环境变量：旧名全部兼容，无需立即改动

读取机制：`YWCODER_X ?? CLAUDE_CODE_X`（新名优先，旧名兜底）。**所有历史 `CLAUDE_CODE_*` / `CLAUDE_CONFIG_DIR` 变量继续有效。**

| 变量 | 新名 | 兼容性 | 说明 |
|------|------|--------|------|
| `CLAUDE_CODE_USE_OPENAI` | `YWCODER_USE_OPENAI` | ✅ **完整**（2026-06-17） | 见 §4 item 1：新名可独立使用，旧名可删 |
| `CLAUDE_CODE_INTRANET` | `YWCODER_INTRANET` | ✅ 完整 | 非 RFC1918 内网网关显式声明 |
| `CLAUDE_CONFIG_DIR` | `YWCODER_CONFIG_DIR` | ✅ 完整 | 自定义配置目录 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — | **不改名** | OpenAI provider 标准变量，非品牌范围，永久保持 |

### 2.2 配置目录迁移

**HOME 级**（`~/.claude` → `~/.ywcoder`）：
- **自动**：启动时优先用 `~/.ywcoder`；若不存在则继续用 `~/.claude` 并在终端提示一次。
- **手动**：运行 `ywcoder --migrate-config`，非破坏性（copy-keep）：
  - `~/.claude/` 复制到 `~/.ywcoder/`，原目录保留
  - `~/.claude.json` → `~/.ywcoder/.config.json`（仅在目标不存在时）
  - 历史残留 `~/.ywcoder` 自动重命名为带时间戳的 `.bak` 备份
  - 任一步失败均不抛出、不中止

**项目级**（仓库内 `.claude/` → `.ywcoder/`）：
- **默认启用**（v1.2.0 起翻转为默认 ON）：任意 `bun run build`（含 `npm pack` 的 prepack 钩子）产物即含迁移，无需额外 flag。启动早期自动 copy-keep 迁移：跳过 `worktrees/`、同步 `.gitignore`、幂等、优雅降级、用户无感。
- copy-keep 下 `.claude/` **始终保留**作备份；副作用仅为生成 `.ywcoder/` 目录 + 往 `.gitignore` **追加**并行规则（不删原 `.claude/` 规则）。
- **关闭退路**：如需与官方 Claude Code 纯共用 `.claude/`（不生成 `.ywcoder/`、不动 `.gitignore`），用 `MIGRATE_PROJECT_CONFIG=false bun run build` 构建，迁移分支经 DCE 删除。

### 2.3 全局登录态（auth）
- 已登录用户升级后**登录态保留**：优先读 `~/.ywcoder/.config.json`，无则回退既有 `~/.claude.json`（不丢 token）。
- 纯新装登录写入 `<配置目录>/.config.json`（不再生成 `~/.claude.json`）。

### 2.4 记忆文件（`YWCODER.md` / `CLAUDE.md`）：不改名、存量永久兼容

**记忆文件与配置目录不同——没有任何重命名 / 迁移动作。** 存量 `CLAUDE.md` 原样保留、照常生效，用户**无需任何操作**。

- **读取回退**：优先读 `YWCODER.md`（及 `YWCODER.local.md`），不存在时回退读旧的 `CLAUDE.md`（及 `CLAUDE.local.md`），永久兼容存量项目与生态。
- **优先判据按「文件是否存在」**：只要 `YWCODER.md` 存在（**哪怕为空**）就以它为准，不再回退 `CLAUDE.md`——与写入路径判据一致，避免「读 `CLAUDE.md`、写 `YWCODER.md`」的分歧。
- **新建用新名**：`/init` 生成 `YWCODER.md`。
- **覆盖各层级**：项目根 `YWCODER.md`、`<配置目录>/YWCODER.md`、用户级 `~/.../YWCODER.md`、managed `/etc/.../YWCODER.md`，均同此回退规则。

> ⚠️ **用户提醒**：不要在已有 `CLAUDE.md` 的目录里手动新建一个**空** `YWCODER.md`——按「存在即以它为准」规则，空 `YWCODER.md` 会屏蔽掉有内容的 `CLAUDE.md`。如需切换，请把内容**写入** `YWCODER.md`（而非建空文件），或保持现状继续用 `CLAUDE.md`。

### 2.5 新增功能（用户可感知的体验增强）

本次构建启用了一批终端内体验增强 feature。下表为用户可直接感知的项及当前内网验证状态：

| 功能 | 怎么触发 | 你会看到 | 收益 | 状态 |
|------|---------|---------|------|------|
| **终端内粘贴图片**<br>(`NATIVE_CLIPBOARD_IMAGE`) | 在终端按 `Cmd+V`（mac）/ `Ctrl+V`（win/linux）粘贴剪贴板图片 | 输入框出现图片占位符或上传提示，模型能识别图片内容 | 直接粘贴截图到对话，无需先存成文件 | ✅ **已验证可用** |
| **上下文压缩提示**<br>(`COMPACTION_REMINDERS`) | 持续对话直到上下文接近压缩阈值 | 屏幕底部出现"正在压缩上下文以节省 token…"等提示 | 明确知道正在压缩，避免对"丢上下文"感到困惑 | ✅ **已验证可用** |
| **MCP 富文本输出**<br>(`MCP_RICH_OUTPUT`) | 使用任意 MCP 工具（如文件读取、代码搜索） | 工具结果带格式高亮、表格、折叠块等富文本样式，而非纯文本 | MCP 结果更易读，代码块带语法高亮 | 🔄 内测中 |

> 其余已启用但属后台/交互细节的 feature（`BUILTIN_EXPLORE_PLAN_AGENTS`、`QUICK_SEARCH`、`HISTORY_PICKER`、`POWERSHELL_AUTO_MODE`、`HOOK_PROMPTS` 等）持续内网验证中，验证通过后追加。

---

## 三、内网网关配置脚本说明

**结论：现有 PowerShell / Linux 配置脚本可直接使用，无需修改。**

逐项核对：

| 脚本变量 | 处置 | 原因 |
|----------|------|------|
| `CLAUDE_CODE_USE_OPENAI=1` | **可只用新名 `YWCODER_USE_OPENAI=1`**（2026-06-17 起）| fallback 已完整，旧名可删（见 §4 item 1）|
| `OPENAI_API_KEY` | 保持 | provider 标准变量 |
| `OPENAI_BASE_URL` | 保持 | provider 标准变量 |
| `OPENAI_MODEL` | 保持 | provider 标准变量 |
| `YWCODER_INTRANET=1` | ✅ 已正确 | 已使用新名 |

**可选增强**：如需为内网统一配置目录，可新增 `YWCODER_CONFIG_DIR=<路径>`（非必须）。

---

## 四、已知限制 / 待办

1. **`CLAUDE_CODE_USE_OPENAI` 的新名 fallback 不完整** ~~（2026-06-12）~~
   `src/utils/providerProfiles.ts` 有 6+ 处直读 `CLAUDE_CODE_USE_OPENAI`（`hasProviderSelectionFlags`、`isProcessEnvAlignedWithProfile`、`hasConflictingProviderFlagsForProfile`），未走 `getYwCoderEnv` fallback。
   **影响**：只设 `YWCODER_USE_OPENAI` 而不设旧名时，provider 选择/对齐判断可能失效。

   > **✅ 2026-06-17 已解决**：provider profile 子系统（`hasProviderSelectionFlags` / `isProcessEnvAlignedWithProfile` / `hasConflictingProviderFlagsForProfile` / `hasExplicitProviderSelection`）、`providerValidation`、`provider.tsx` 显示读已全部改为 `YWCODER_USE_* ?? CLAUDE_CODE_USE_*` 双读，写入/清除站点同步双名对称。内网脚本现**可只用新名**（`YWCODER_USE_OPENAI` / `YWCODER_USE_GITHUB`），无需再保留 `CLAUDE_CODE_USE_*`。详见 `review_2026-06-14_第一轮审查.md` 第 5 项。

2. **F2 全局 auth 路径修复需真机登录验证**
   `getGlobalClaudeFile` 的 legacy 前缀已改为跟随 `YWCODER_CONFIG_DIR`；需真机跑通登录流程确认存量登录态保留 + 新装落 `.config.json`。

3. **F1 / F3 既有 settings 缓存问题**（非本次引入）
   bridge / worktree 切换 CWD 后 settings 缓存未失效，详见 `note/ISSUE/2026-06-12-settings-cache-stale-on-cwd-switch.md`。

---

## 五、本次代码评审修复（6 项）

| 编号 | 文件 | 修复 |
|------|------|------|
| F2 | env.ts | 全局 auth legacy 路径跟随 `YWCODER_CONFIG_DIR` |
| F6 | envUtils.ts | tilde 显示路径加分隔符守卫 |
| F7 | update.ts / AutoUpdater.tsx | 更新提示用 tilde 路径而非绝对路径 |
| F8 | projectConfigMigration.ts | `.gitignore` 同步按路径段匹配，不误伤 `.claude.json` |
| F9 | projectConfigMigration.ts | `.gitignore` 写入兼容 CRLF |
| F4 | projectConfigDir.ts | 补注释记录迁移失败降级路径的文案取舍 |

详见 `note/BRAND_MIGRATION_2026-06-07/temp/CODE_REVIEW_2026-06-12.md`。

---

## 六、验证状态

- 受影响单元测试：**27 pass / 0 fail**（含 4 个新增回归测试）
- 构建：**`bun run build` 成功**（评审/修复阶段产物为 v1.1.2；已将 `package.json` 版本号升至 **1.2.0**，发布前需重新 `bun run build` 产出 v1.2.0 发布物）
- 类型检查：改动文件无新增错误（既有 `MACRO` 构建注入常量报错不影响打包）
- ⏳ 待补：F2 真机登录流程验证、内网 OpenAI 网关连通性冒烟

---

## 七、回滚

- 环境变量：旧 `CLAUDE_CODE_*` 全程兼容，回滚无需改用户脚本。
- 配置目录：copy-keep 策略下原 `.claude/` 与 `~/.claude.json` 始终保留，回退旧版可直接读回。
